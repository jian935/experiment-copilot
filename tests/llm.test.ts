import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyze } from '../src/lib/decide.ts';
import { generateDataset } from '../src/lib/simulate.ts';
import { askWithLlm } from '../src/app/lib/llm.ts';
import type { AgentCtx } from '../src/lib/agent/types.ts';

const ds = generateDataset(20261031);
const analyses = new Map(ds.experiments.map((e) => [e.id, analyze(e, ds.daily)]));
const exp = ds.experiments.find((e) => e.id === 'E001')!;
const ctx: AgentCtx = { dataset: ds, analyses, exp, analysis: analyses.get('E001')! };

interface Call {
  role: string;
  content: string | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/** 造一个假的 OpenAI 兼容响应，并记录每次请求体 */
function mockServer(rounds: { toolCalls?: { name: string; args?: string }[]; content?: string }[]) {
  const bodies: { messages: Call[]; tools?: unknown[] }[] = [];
  let i = 0;
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const r = rounds[Math.min(i, rounds.length - 1)];
    i += 1;
    const message = r.toolCalls
      ? {
          role: 'assistant',
          content: null,
          tool_calls: r.toolCalls.map((t, k) => ({
            id: `call_${i}_${k}`,
            type: 'function',
            function: { name: t.name, arguments: t.args ?? '{}' },
          })),
        }
      : { role: 'assistant', content: r.content ?? '' };
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message }] }),
      text: async () => '',
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { bodies, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('智能模式的工具循环（M4）', () => {
  it('模型先要工具，再把工具结果喂回去，最终给出带引用的回答', async () => {
    const { bodies } = mockServer([
      { toolCalls: [{ name: 'get_overview' }] },
      { content: '结论是 no-ship，因为退款率恶化 [E6]。' },
    ]);

    const r = await askWithLlm('为什么不能上线', ctx, { apiKey: 'sk-test' });

    expect(r.by).toBe('llm');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].tool).toBe('get_overview');
    expect(r.text).toContain('[E6]');
    expect(r.violations).toEqual([]);

    // 第一次请求带全部工具（14 个），第二次请求带上了 tool 角色的回填
    expect((bodies[0].tools as unknown[]).length).toBe(14);
    const roles = bodies[1].messages.map((m) => m.role);
    expect(roles).toContain('assistant');
    expect(roles).toContain('tool');
    const toolMsg = bodies[1].messages.find((m) => m.role === 'tool')!;
    expect(toolMsg.content).toContain('no-ship');
  });

  it('模型编造数字会被数字审计抓出来', async () => {
    mockServer([{ content: '这个实验提升了 42.42pp，非常显著 [E2]。' }]);
    const r = await askWithLlm('效果如何', ctx, { apiKey: 'sk-test' });
    expect(r.audit.suspicious).toContain('42.42');
    expect(r.violations?.join()).toMatch(/无法溯源/);
  });

  it('回答没有引用会被判违规（铁律 2）', async () => {
    mockServer([
      { toolCalls: [{ name: 'run_test' }] },
      { content: '主指标显著为正，建议上线。' },
    ]);
    const r = await askWithLlm('效果如何', ctx, { apiKey: 'sk-test' });
    expect(r.violations?.join()).toMatch(/证据引用/);
  });

  it('模型调用不存在的工具时，把错误回填给它而不是崩掉', async () => {
    const { bodies } = mockServer([
      { toolCalls: [{ name: 'drop_database' }] },
      { content: '我不该调用那个工具 [E2]。' },
    ]);
    const r = await askWithLlm('随便问问', ctx, { apiKey: 'sk-test' });
    expect(r.calls).toHaveLength(0);
    const toolMsg = bodies[1].messages.find((m) => m.role === 'tool')!;
    expect(toolMsg.content).toContain('不存在工具');
    expect(r.text).toContain('[E2]');
  });

  it('工具参数坏掉（不是合法 JSON）时按空参数执行，不抛异常', async () => {
    mockServer([
      { toolCalls: [{ name: 'compute_mde', args: '{bad json' }] },
      { content: '样本量足够 [E2]。' },
    ]);
    const r = await askWithLlm('样本够吗', ctx, { apiKey: 'sk-test' });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].tool).toBe('compute_mde');
  });

  it('连续 3 轮都在调工具就停下来，并说明原因', async () => {
    mockServer([{ toolCalls: [{ name: 'run_test' }] }]);
    const r = await askWithLlm('一直调工具', ctx, { apiKey: 'sk-test' });
    expect(r.note).toMatch(/超过最大工具轮次/);
    expect(r.calls).toHaveLength(3);
  });

  it('接口报错时抛出带状态码的可读错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => '{"error":"invalid api key"}',
    } as unknown as Response)));
    await expect(askWithLlm('hi', ctx, { apiKey: 'bad' })).rejects.toThrow(/401/);
  });

  it('网络不通时给出可读错误，而不是 Failed to fetch 原文', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    await expect(askWithLlm('hi', ctx, { apiKey: 'k' })).rejects.toThrow(/无法连接模型服务/);
  });
});
