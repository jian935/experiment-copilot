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
  it('全部工具都能调用，且引用的证据编号都真实存在', () => {
    // 数量硬编码在这里，是为了让「加了一个工具却忘了注册 schema / 忘加标签」必然报错
    expect(TOOL_NAMES.length).toBe(16);
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
    // ARPU 在 M10 之后已经登记进口径字典，所以这里改用真正没登记的 GMV：
    // 「拒答字典外指标」这条铁律必须继续有测试压着，不能因为指标变多就悄悄失效。
    const r = answerQuestion('这个实验的 GMV 提升了多少？', guardrailCtx);
    expect(r.intent).toBe('metric_scope');
    expect(r.text).toContain('没有');
    expect(r.text).toContain('GMV');
    expect(r.audit.suspicious).toEqual([]);
  });

  it('口径问题走字典，且不会编造未登记的指标', () => {
    // 「退款率…」会先命中护栏意图、「有哪些…」会先命中列表意图（都对），
    // 所以字典意图用只含口径关键词、不撞其它意图的问法验证
    const r = answerQuestion('指标怎么算的', guardrailCtx);
    expect(r.intent).toBe('metric');
    expect(r.text).toContain('口径字典共登记');
    expect(r.text).toContain('支付转化率');
    expect(r.text).toContain('refunds / exposures');
    expect(r.audit.suspicious).toEqual([]);

    // 直接点名某个指标时，工具要能精确命中并给出它的计算式与统计方法
    const call = runTool('metric_dictionary', guardrailCtx, { metric: '退款率' });
    const data = call.data as { matched: string[]; known: { key: string; formula: string; method: string }[] };
    expect(data.matched).toEqual(['refund_rate']);
    expect(data.known.find((m) => m.key === 'refund_rate')!.formula).toBe('refunds / exposures');
    expect(call.summary).toContain('退款率');
  });

  it('问到字典外的指标：明说没有，不自己定义', () => {
    const r = answerQuestion('留存的口径是什么', guardrailCtx);
    expect(r.intent).toBe('metric_scope');
    expect(r.text).toContain('不在口径字典里');
    expect(r.text).toContain('支付转化率');
    expect(r.text).not.toContain('留存（');
    expect(r.audit.suspicious).toEqual([]);
  });

  it('ARPU 已登记进口径字典：问它时必须能答，不许再拒答', () => {
    const r = answerQuestion('ARPU 的口径怎么算', guardrailCtx);
    expect(r.intent).toBe('metric');
    expect(r.text).toContain('ARPU');
    expect(r.text).toContain('Σrevenue / Σexposures');
    expect(r.text).not.toContain('不在口径字典里');
    expect(r.audit.suspicious).toEqual([]);
  });

  it('系统提示里写明了可引用的指标白名单', () => {
    const p = systemPrompt(guardrailCtx);
    expect(p).toContain('只能引用口径字典里登记过的指标');
    expect(p).toContain('支付转化率');
    expect(p).toContain('退款率');
  });

  it('兜底问题也能给出结论概览，不空转', () => {
    const r = answerQuestion('你好', guardrailCtx);
    expect(r.intent).toBe('overview');
    expect(r.text.length).toBeGreaterThan(20);
    expect(r.audit.suspicious).toEqual([]);
  });

  it('贝叶斯视角一句话正常渲染（带 P(B>A)，且不含畸形符号）', () => {
    const r = answerQuestion('这个实验有效果吗', guardrailCtx);
    expect(r.intent).toBe('test');
    expect(r.text).toContain('贝叶斯视角');
    expect(r.text).not.toContain('+-');
    expect(r.text).toMatch(/有 \d+(\.\d+)?% 的概率优于 control/);
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
