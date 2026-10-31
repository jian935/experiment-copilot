import { describe, expect, it } from 'vitest';
import { analyze } from '../src/lib/decide.ts';
import { generateDataset } from '../src/lib/simulate.ts';
import { answerQuestion, replyFromLlm, systemPrompt } from '../src/lib/agent/answer.ts';
import { TOOL_NAMES, runTool } from '../src/lib/agent/tools.ts';
import { auditNumbers, buildWhitelist } from '../src/lib/agent/audit.ts';
import { mdeTwoProportion } from '../src/lib/stats.ts';
import type { AgentCtx } from '../src/lib/agent/types.ts';

const ds = generateDataset(20261031);
const analyses = new Map(ds.experiments.map((e) => [e.id, analyze(e, ds.daily)]));

function ctxOf(id: string): AgentCtx {
  const exp = ds.experiments.find((e) => e.id === id)!;
  return { dataset: ds, analyses, exp, analysis: analyses.get(id)! };
}

// E001 = guardrail 型（主指标正向但退款率恶化），E002 = 异质型
const guardrailCtx = ctxOf('E001');
const heteroCtx = ctxOf('E002');

describe('Agent 工具（M4）', () => {
  it('8 个工具都能调用，且引用的证据编号都真实存在', () => {
    expect(TOOL_NAMES.length).toBe(8);
    const valid = new Set(guardrailCtx.analysis.evidence.map((e) => e.id));
    for (const name of TOOL_NAMES) {
      const call = runTool(name, guardrailCtx, name === 'segment_breakdown' ? { dimension: 'device' } : {});
      expect(call.tool).toBe(name);
      expect(call.summary.length).toBeGreaterThan(0);
      for (const id of call.cites) {
        expect(valid.has(id), `${name} 引用了不存在的证据 ${id}`).toBe(true);
      }
    }
  });

  it('compute_mde 的数字与统计库一致', () => {
    const ctx = guardrailCtx;
    const call = runTool('compute_mde', ctx, { baseline: 0.05, nPerArm: 10000 });
    const data = call.data as { mde: number };
    expect(data.mde).toBeCloseTo(mdeTwoProportion(0.05, 10000), 10);
  });

  it('explain_rules 报出的命中序号与实际规则顺序一致', () => {
    const call = runTool('explain_rules', guardrailCtx);
    const idx = (call.data as { code: string }[]).findIndex((r) => r.code === guardrailCtx.analysis.reasonCode);
    expect(call.summary).toContain(`第 ${idx + 1} 条`);
  });
});

describe('规则模式的回答', () => {
  it('问护栏 → 命中 guardrail 意图、引用了护栏证据、数字全部可溯源', () => {
    const r = answerQuestion('退款率恶化了吗？有风险吗', guardrailCtx);
    expect(r.intent).toBe('guardrail');
    expect(r.text).toMatch(/退款率/);
    expect(r.calls.some((c) => c.tool === 'check_guardrails')).toBe(true);
    expect(r.text).toMatch(/\[E\d+\]/);
    expect(r.audit.suspicious).toEqual([]);
  });

  it('问为什么 → 命中 rules 意图，并指出先命中的是哪条规则', () => {
    const r = answerQuestion('为什么不能上线？依据是什么', guardrailCtx);
    expect(r.intent).toBe('rules');
    expect(r.text).toContain(guardrailCtx.analysis.reasonCode);
    expect(r.audit.suspicious).toEqual([]);
  });

  it('问分层 → 列出两层并带 BH q 值', () => {
    const r = answerQuestion('新老用户有差异吗', heteroCtx);
    expect(r.intent).toBe('segment');
    expect(r.text).toContain('新用户');
    expect(r.text).toContain('老用户');
    expect(r.audit.suspicious).toEqual([]);
  });

  it('问样本 → 用 MDE 解释「不显著」是样本不足还是真的没效果', () => {
    const r = answerQuestion('样本够不够？能检出多大差异', guardrailCtx);
    expect(r.intent).toBe('mde');
    expect(r.text).toMatch(/最小可检出差异/);
    expect(r.audit.suspicious).toEqual([]);
  });

  it('一键问跨实验 → 返回列表数量并与数据集一致', () => {
    const r = answerQuestion('有哪些实验被护栏拦了', guardrailCtx);
    expect(r.intent).toBe('list');
    const expected = [...analyses.values()].filter((a) => a.decision === 'no-ship').length;
    expect(r.text).toContain(String(expected));
  });

  it('问到实验没测的指标时，必须明确说没有这个口径', () => {
    const r = answerQuestion('这个实验的 ARPU 提升了多少？', guardrailCtx);
    expect(r.intent).toBe('metric_scope');
    expect(r.text).toContain('没有');
    expect(r.text).toContain('ARPU');
    expect(r.audit.suspicious).toEqual([]);
  });

  it('兜底问题也能给出结论概览，不空转', () => {
    const r = answerQuestion('你好', guardrailCtx);
    expect(r.intent).toBe('overview');
    expect(r.text.length).toBeGreaterThan(20);
    expect(r.audit.suspicious).toEqual([]);
  });

  it('常见问题集合：规则模式下的可疑数字必须为 0', () => {
    const qs = [
      '这个实验有效果吗', '为什么是这个结论', '护栏怎么样', '新老用户差异',
      '样本够吗', '有类似实验吗', '哪些实验被拦截了', '置信区间是多少', '给我个总结',
    ];
    for (const q of qs) {
      const r = answerQuestion(q, guardrailCtx);
      expect(r.audit.suspicious, `问题「${q}」出现了可疑数字：${r.audit.suspicious.join(',')}`).toEqual([]);
    }
  });
});

describe('数字保真度检查', () => {
  it('能抓到引擎从未算过的数字', () => {
    const wl = buildWhitelist([guardrailCtx.analysis]);
    const bad = '主指标提升了 3.21pp，约等于 12.7% 的相对提升。';
    const res = auditNumbers(bad, wl);
    expect(res.suspicious.length).toBeGreaterThan(0);
  });

  it('引擎真实数字不会被误判', () => {
    const a = guardrailCtx.analysis;
    const wl = buildWhitelist([a]);
    const good = `差值 ${(a.overall.diff * 100).toFixed(2)}pp，control ${(a.overall.controlRate * 100).toFixed(2)}%，n=${a.overall.n1}`;
    expect(auditNumbers(good, wl).suspicious).toEqual([]);
  });

  it('LLM 编造的数字会被标记并保留原文', () => {
    const r = replyFromLlm('这个实验提升了 42.42pp [E2]。', [], guardrailCtx, '测试');
    expect(r.by).toBe('llm');
    expect(r.audit.suspicious).toContain('42.42');
  });
});

describe('LLM 的 system prompt', () => {
  it('包含 5 条铁律与当前实验信息', () => {
    const p = systemPrompt(guardrailCtx);
    expect(p).toContain('不许自己算数');
    expect(p).toContain('[E2]');
    expect(p).toContain('证据不足就说不知道');
    expect(p).toContain(guardrailCtx.exp.id);
  });
});
