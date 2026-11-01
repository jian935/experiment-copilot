import { describe, expect, it } from 'vitest';
import { runAa } from '../scripts/aa_test.ts';
import { generateAA } from '../src/lib/simulate.ts';
import { analyze } from '../src/lib/decide.ts';
import type { Dataset } from '../src/lib/types.ts';

/**
 * A/A 自校准：真值就是"零效应"，引擎报了多少次显著，是纯粹的统计性质。
 * 这是「引擎在无效应时不乱报」的硬证据，比决策准确率更难被质疑。
 * 完整报告由 `npm run aa`（2000 次）产出并写进 data/aa_report.json；
 * 单测这里跑 300 次守住上界，保证 CI 里也守得住。
 */
// 240 次 A/A 只跑一次，多个断言共用（每次约 1.2s，别在单测里重复跑）
const R = runAa(240);

describe('A8 · A/A 自校准', () => {
  it('generateAA 生成的实验全部零效应、真值 inconclusive', () => {
    const ds: Dataset = generateAA(20);
    expect(ds.experiments.length).toBe(20);
    for (const e of ds.experiments) {
      expect(e.trueLiftOverall).toBe(0);
      expect(e.trueDecision).toBe('inconclusive');
      expect(e.archetype).toBe('null');
    }
    // 明细行分变体存在，且两臂样本量接近
    expect(ds.daily.length).toBe(20 * 7 * 2 * 2 * 2);
  });

  it('总误报率不超过 α + 3 倍标准误（240 次 A/A）', () => {
    const r = R;
    expect(r.trials).toBe(240);
    const se = Math.sqrt((r.falsePositiveRate * (1 - r.falsePositiveRate)) / r.trials);
    expect(r.falsePositiveRate).toBeLessThan(0.05 + 3 * se);
    expect(r.falsePositiveRate).toBeGreaterThan(0);
  });

  it('正向 / 负向误报各自受控（两侧对称，不偏袒某一方向）', () => {
    const r = R;
    expect(r.shipRate).toBeLessThan(0.07);
    expect(r.noShipRate).toBeLessThan(0.07);
    // 两侧不该系统性倾斜：差值不超过 2 倍合计误报
    expect(Math.abs(r.shipRate - r.noShipRate)).toBeLessThan(0.1);
  });

  it('SRM 与硬护栏在 A/A 下几乎不误报', () => {
    const r = R;
    expect(r.srmFlagRate).toBeLessThan(0.02);
    expect(r.guardrailFlagRate).toBeLessThan(0.02);
  });

  it('贝叶斯 P(B>A) 在 A/A 下均值≈0.5（不系统性偏向 treatment）', () => {
    const r = R;
    expect(r.bayesMeanProb).toBeGreaterThan(0.45);
    expect(r.bayesMeanProb).toBeLessThan(0.55);
    expect(r.bayesProbAbove095).toBeLessThan(0.12);
  });

  it('主指标 p 值近似均匀（每个十分位桶都有量）', () => {
    const r = R;
    expect(r.pValueHistogram.length).toBe(10);
    const total = r.pValueHistogram.reduce((s, v) => s + v, 0);
    expect(total).toBe(r.trials);
    for (const v of r.pValueHistogram) expect(v).toBeGreaterThan(0);
  });

  it('同种子两次运行完全一致（结论可复现）', () => {
    const a = runAa(30, 20261101);
    const b = runAa(30, 20261101);
    expect(a.decisions).toEqual(b.decisions);
    expect(a.falsePositiveRate).toBe(b.falsePositiveRate);
  });

  it('单条 A/A 实验的分析结构完整（导入 A/A 数据也能正常出结论）', () => {
    const ds = generateAA(1);
    const a = analyze(ds.experiments[0], ds.daily);
    expect(a.decision).toBeDefined();
    expect(a.bayes.probTreatBetter).toBeGreaterThanOrEqual(0);
    expect(a.bayes.probTreatBetter).toBeLessThanOrEqual(1);
    expect(a.guardrails.length).toBe(3);
    // 延迟护栏现在有 Bootstrap 区间（不再是硬编码 sd 的假 t 检验）
    const lat = a.guardrails.find((g) => g.key === 'latency_p95')!;
    expect(lat.bootstrap).toBeDefined();
    expect(lat.bootstrap!.ciLow).toBeLessThanOrEqual(lat.bootstrap!.ciHigh);
  });
});
