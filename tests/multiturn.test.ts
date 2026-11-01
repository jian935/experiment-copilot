import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyze } from '../src/lib/decide.ts';
import { generateDataset } from '../src/lib/simulate.ts';
import { answerQuestion, resolveFollowUp, systemPrompt } from '../src/lib/agent/answer.ts';
import { askWithLlm } from '../src/app/lib/llm.ts';
import type { AgentCtx, AgentTurn } from '../src/lib/agent/types.ts';

const ds = generateDataset(20261031);
const analyses = new Map(ds.experiments.map((e) => [e.id, analyze(e, ds.daily)]));

function ctxOf(id: string): AgentCtx {
  const exp = ds.experiments.find((e) => e.id === id)!;
  return { dataset: ds, analyses, exp, analysis: analyses.get(id)! };
}

const ctx = ctxOf('E001');

/** 造一段历史：用户问过 q1，助手按某意图回答过 */
function hist(q1: string, intent: string): AgentTurn[] {
  return [
    { role: 'user', text: q1 },
    { role: 'assistant', text: '（上一轮的回答）', intent },
  ];
}

describe('多轮补全 · 只在真正省略时才动手', () => {
  it('没有历史时原样返回，不做任何猜测', () => {
    expect(resolveFollowUp('那新用户呢')).toEqual({ effective: '那新用户呢', rewritten: false });
    expect(resolveFollowUp('那新用户呢', [])).toEqual({ effective: '那新用户呢', rewritten: false });
  });

  it('完整句子一律不改写（「主指标显著吗」不会被塞进别的主题）', () => {
    const h = hist('护栏有没有恶化', 'guardrail');
    expect(resolveFollowUp('主指标显著吗', h).rewritten).toBe(false);
    expect(resolveFollowUp('新老用户有差异吗', h).rewritten).toBe(false);
  });

  it('「那新用户呢」补成按新老分层，并说明依据', () => {
    const h = hist('主指标显著吗', 'test');
    const r = resolveFollowUp('那新用户呢', h);
    expect(r.rewritten).toBe(true);
    expect(r.effective).toContain('分层');
    expect(r.why).toContain('新老');
    expect(r.from).toBe('test');
  });

  it('「那 iOS 呢」原文已能命中分层，直接按设备维度查（不需要补全）', () => {
    const h = hist('主指标显著吗', 'test');
    expect(resolveFollowUp('那 iOS 呢', h).rewritten).toBe(false);
    const a = answerQuestion('那 iOS 呢', ctx, h);
    expect(a.intent).toBe('segment');
    const seg = a.calls.find((c) => c.tool === 'segment_breakdown')!;
    expect(seg.args.dimension).toBe('device');
  });

  it('原文已经能命中意图时不动手（避免把「那退款率呢」错改成主指标）', () => {
    const r = resolveFollowUp('那退款率呢', hist('主指标显著吗', 'test'));
    expect(r.rewritten).toBe(false);
  });

  it('「还有呢」按主题环切到下一个，而不是重复上一轮', () => {
    const r = resolveFollowUp('还有呢', hist('主指标显著吗', 'test'));
    expect(r.rewritten).toBe(true);
    // test → rules（主题环的下一项）
    expect(r.effective).toContain('为什么');
    expect(r.why).toContain('切到');
  });

  it('纯指代「那它呢」沿用上一轮主题', () => {
    const r = resolveFollowUp('那它呢', hist('护栏有没有恶化', 'guardrail'));
    expect(r.rewritten).toBe(true);
    expect(r.effective).toContain('护栏');
    expect(r.why).toContain('沿用');
  });

  it('上一轮没有意图记录（例如上一轮是模型答的）时，不去猜', () => {
    const r = resolveFollowUp('那它呢', [{ role: 'user', text: '随便问问' }]);
    expect(r.rewritten).toBe(false);
  });
});

describe('多轮回答 · 规则模式', () => {
  it('追问「那新用户呢」命中分层意图，并把补全结果写进 reply.context', () => {
    const h = hist('主指标显著吗', 'test');
    const r = answerQuestion('那新用户呢', ctx, h);
    expect(r.intent).toBe('segment');
    expect(r.context).toBeDefined();
    expect(r.context!.effective).toContain('分层');
    expect(r.violations).toEqual([]);
  });

  it('不承接上文时 reply.context 为空（不留假痕迹）', () => {
    const r = answerQuestion('主指标显著吗', ctx, hist('护栏有没有恶化', 'guardrail'));
    expect(r.context).toBeUndefined();
    expect(r.intent).toBe('test');
  });

  it('多轮之后每一轮的数字仍然全部可溯源', () => {
    const h = hist('为什么是这个结论', 'rules');
    for (const q of ['那新用户呢', '还有呢', '那它呢', '还要跑几天']) {
      const r = answerQuestion(q, ctx, h);
      expect(r.audit.suspicious, `${q} 出现无法溯源的数字：${r.audit.suspicious.join('、')}`).toEqual([]);
    }
  });

  it('「还要跑几天」命中 forecast 意图并调用第 11 个工具', () => {
    const r = answerQuestion('还要跑几天才能出结论', ctx);
    expect(r.intent).toBe('forecast');
    expect(r.calls.map((c) => c.tool)).toContain('forecast_days');
    expect(r.violations).toEqual([]);
  });
});

interface Call {
  role: string;
  content: string | null;
  tool_calls?: unknown[];
}

function mockAnswer(content: string) {
  const bodies: { messages: Call[] }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }),
        text: async () => '',
      } as unknown as Response;
    }),
  );
  return bodies;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('多轮上下文 · 智能模式', () => {
  it('历史按「旧→新」插在 system 与当前问题之间', async () => {
    const bodies = mockAnswer('按新老分层看，新用户更强 [E2]。');
    const history: AgentTurn[] = [
      { role: 'user', text: '主指标显著吗' },
      { role: 'assistant', text: '显著为正 [E2]。' },
    ];
    await askWithLlm('那新用户呢', { ...ctx, history }, { apiKey: 'sk-test' });

    const msgs = bodies[0].messages;
    expect(msgs[0].role).toBe('system');
    expect(msgs.at(-1)!.role).toBe('user');
    expect(msgs.at(-1)!.content).toBe('那新用户呢');
    expect(msgs.slice(1, -1).map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1].content).toBe('主指标显著吗');
  });

  it('历史最多带 6 条，避免把半年前的对话塞进上下文', async () => {
    const bodies = mockAnswer('好 [E2]。');
    const history: AgentTurn[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: `第 ${i + 1} 轮`,
    }));
    await askWithLlm('继续', { ...ctx, history }, { apiKey: 'sk-test' });
    const msgs = bodies[0].messages;
    expect(msgs.length).toBe(1 + 6 + 1); // system + 6 条历史 + 当前问题
    expect(msgs[1].content).toBe('第 15 轮');
  });

  it('历史里的数字不能当证据：复述上一轮的数字会被审计抓住', async () => {
    mockAnswer('上一轮提到 p=0.037，这次也一样 [E2]。');
    const history: AgentTurn[] = [
      { role: 'user', text: '主指标显著吗' },
      { role: 'assistant', text: 'p=0.037，显著 [E2]。' },
    ];
    const r = await askWithLlm('再说一次', { ...ctx, history }, { apiKey: 'sk-test' });
    // 本轮没调工具 → 白名单里没有 0.037 → 必须报出来
    expect(r.audit.suspicious.join()).toContain('0.037');
    expect(r.violations?.join()).toMatch(/无法溯源/);
  });

  it('system prompt 里写明了「历史不能当证据」这条铁律', () => {
    const p = systemPrompt(ctx);
    expect(p).toContain('多轮对话');
    expect(p).toContain('重新调用工具确认');
  });
});
