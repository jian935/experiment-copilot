/**
 * 基线比对器自身的测试。
 *
 * 为什么检查器必须有测试：一个「永远报通过」的比对器比没有比对更危险 ——
 * 它会让人以为指标受控。这里逐条证明：抓得到漂移、不误报浮点噪声、新增/消失也报。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { describeChange, diffBaseline, flattenAgent, flattenEval } from '../src/lib/evalBaseline.ts';
import { analyze } from '../src/lib/decide.ts';
import { evaluate } from '../src/lib/evaluate.ts';
import { evaluateAgent } from '../src/lib/agentEval.ts';
import type { Dataset } from '../src/lib/types.ts';

const base = { accuracy: 0.9333, 'fpr.hit': 2, 'hetero.f1': 0.8571 };

describe('diffBaseline', () => {
  it('完全相同 → clean', () => {
    const d = diffBaseline(base, { ...base });
    expect(d.clean).toBe(true);
    expect(d.drift).toHaveLength(0);
  });

  it('改一个指标 → 精确指出是哪个，并带上前后值', () => {
    const d = diffBaseline({ ...base, accuracy: 0.9167 }, { ...base });
    expect(d.clean).toBe(false);
    expect(d.drift).toHaveLength(1);
    expect(d.drift[0].key).toBe('accuracy');
    expect(d.drift[0].from).toBeCloseTo(0.9333, 6);
    expect(d.drift[0].to).toBeCloseTo(0.9167, 6);
  });

  it('一个实验判错（准确率动 0.83pp）必须被抓到 —— 不能被容差吃掉', () => {
    const one = 1 / 120;
    const d = diffBaseline({ ...base, accuracy: base.accuracy - one }, { ...base });
    expect(d.drift.map((x) => x.key)).toEqual(['accuracy']);
  });

  it('浮点表示噪声（1e-15）不误报', () => {
    const d = diffBaseline({ ...base, accuracy: base.accuracy + 1e-15 }, { ...base });
    expect(d.clean).toBe(true);
  });

  it('新增 / 消失的指标都要报出来', () => {
    const d = diffBaseline({ ...base, 'agent.hallucinationRate': 0 }, { ...base, 'legacy.metric': 1 });
    expect(d.added).toEqual(['agent.hallucinationRate']);
    expect(d.removed).toEqual(['legacy.metric']);
    expect(d.clean).toBe(false);
  });

  it('字符串字段（未覆盖工具）变化也要报', () => {
    const d = diffBaseline({ ...base }, { ...base }, { uncoveredTools: 'forecast_days' }, { uncoveredTools: '' });
    expect(d.stringDrift).toEqual([{ key: 'uncoveredTools', from: '', to: 'forecast_days' }]);
    expect(d.clean).toBe(false);
  });
});

describe('describeChange', () => {
  it('比例显示成百分比 + 百分点差', () => {
    expect(describeChange(0.9333, 0.9167)).toContain('93.33% → 91.67%');
    expect(describeChange(0.9333, 0.9167)).toContain('pp');
  });

  it('计数显示成整数差', () => {
    expect(describeChange(12, 11)).toBe('12 → 11（-1）');
  });
});

describe('flattenEval / flattenAgent', () => {
  const ds: Dataset = JSON.parse(readFileSync('data/experiments.json', 'utf8')) as Dataset;
  const analyses = new Map(ds.experiments.map((e) => [e.id, analyze(e, ds.daily)]));
  const agent = evaluateAgent(ds, analyses);
  const r = evaluate(ds, analyses, { agent });

  it('摊平结果覆盖决策 / 分层 / Agent 三块，且都是有限数', () => {
    const f = { ...flattenEval(r), ...flattenAgent(agent) };
    expect(f['accuracy']).toBeGreaterThan(0.9);
    expect(f['hetero.f1']).toBeGreaterThan(0.8);
    expect(f['agent.hallucinationRate']).toBe(0);
    for (const [k, v] of Object.entries(f)) {
      if (!Number.isFinite(v)) throw new Error(`${k} 不是有限数`);
    }
  });

  it('14 个工具都在基线里各占一个 key（新增工具会显式进基线，不会悄悄漏掉）', () => {
    const f = flattenAgent(agent);
    const toolKeys = Object.keys(f).filter((k) => k.startsWith('agent.tool.'));
    expect(toolKeys).toHaveLength(14);
    expect(toolKeys.every((k) => f[k] > 0)).toBe(true);
  });
});
