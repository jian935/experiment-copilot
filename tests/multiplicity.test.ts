import { describe, expect, it } from 'vitest';
import { bonferroniAdjust, holmAdjust } from '../src/lib/stats.ts';
import { familyReport, simulateFwer } from '../src/lib/multiplicity.ts';
import { analyze } from '../src/lib/decide.ts';
import { generateDataset } from '../src/lib/simulate.ts';

describe('A6 · 多重比较校正', () => {
  it('Holm 与 R 的 p.adjust(method="holm") 对齐', () => {
    // R: p.adjust(c(0.01, 0.04, 0.03, 0.005), "holm") → 0.03 0.06 0.06 0.02
    const r = holmAdjust([0.01, 0.04, 0.03, 0.005], 0.05);
    const want = [0.03, 0.06, 0.06, 0.02];
    r.adjusted.forEach((v, i) => expect(v).toBeCloseTo(want[i], 12));
    expect(r.rejected).toEqual([true, false, false, true]);
  });

  it('校正后 p 必须单调、不小于原 p、且封顶 1', () => {
    const raw = [0.0001, 0.02, 0.019, 0.4, 0.9, 0.5, 0.03];
    const r = holmAdjust(raw, 0.05);
    for (let i = 0; i < raw.length; i++) {
      expect(r.adjusted[i]).toBeGreaterThanOrEqual(raw[i] - 1e-15);
      expect(r.adjusted[i]).toBeLessThanOrEqual(1);
    }
    // 按 p 升序看，调整后 p 也必须升序（否则会出现"p 更小、校正后更大"的自相矛盾）
    const pairs = raw.map((p, i) => ({ p, a: r.adjusted[i] })).sort((x, y) => x.p - y.p);
    for (let i = 1; i < pairs.length; i++) expect(pairs[i].a).toBeGreaterThanOrEqual(pairs[i - 1].a - 1e-12);
  });

  it('Bonferroni = min(1, m·p)，判定等价于 p ≤ α/m', () => {
    const raw = [0.001, 0.02, 0.5];
    const r = bonferroniAdjust(raw, 0.05);
    raw.forEach((p, i) => expect(r.adjusted[i]).toBeCloseTo(Math.min(1, 3 * p), 12));
    expect(r.rejected).toEqual([true, false, false]);
    // Holm 逐步下降会多拒一个：p=0.02 在第二步只需比 α/2=0.025 小即可
    expect(holmAdjust(raw, 0.05).rejected).toEqual([true, true, false]);
  });

  it('Holm 至少和 Bonferroni 一样有功效（拒绝集是超集）', () => {
    const raw = [0.004, 0.012, 0.013, 0.2, 0.7];
    const holm = holmAdjust(raw, 0.05);
    const bonf = bonferroniAdjust(raw, 0.05);
    for (let i = 0; i < raw.length; i++) {
      if (bonf.rejected[i]) expect(holm.rejected[i]).toBe(true);
    }
    expect(holm.rejected.filter(Boolean).length).toBeGreaterThanOrEqual(bonf.rejected.filter(Boolean).length);
  });

  it('边界输入不崩：空数组 / 单个 / 全 1', () => {
    expect(holmAdjust([], 0.05).adjusted).toEqual([]);
    expect(holmAdjust([0.03], 0.05).rejected).toEqual([true]);
    expect(holmAdjust([1, 1, 1], 0.05).rejected).toEqual([false, false, false]);
  });

  it('全零族模拟：naive 逼近理论值，Holm/Bonferroni 守住 α', () => {
    const s = simulateFwer(120, 2000, 20261101, 0.05);
    // naive 的理论值 1−0.95^120 = 99.79%
    expect(s.naiveTheory).toBeCloseTo(0.9979, 3);
    expect(s.naive).toBeGreaterThan(0.98);
    expect(Math.abs(s.naive - s.naiveTheory)).toBeLessThan(0.01);
    // Holm / Bonferroni 必须落在 5% 附近（蒙特卡洛 2000 次，SE≈0.5pp）
    expect(s.holm).toBeLessThan(0.075);
    expect(s.holm).toBeGreaterThan(0.02);
    expect(s.bonferroni).toBeLessThan(0.075);
    // BH 在全零族下也控 FWER（FDR=FWER），所以同样 ≈5%
    expect(s.bh).toBeLessThan(0.08);
    // 同种子逐位可复现
    expect(simulateFwer(120, 2000, 20261101, 0.05)).toEqual(s);
  });
});

describe('A6 · 接进清单与分层', () => {
  const ds = generateDataset(20261031);
  const byExp = new Map<string, typeof ds.daily>();
  for (const r of ds.daily) {
    const l = byExp.get(r.expId);
    if (l) l.push(r);
    else byExp.set(r.expId, [r]);
  }
  const members = ds.experiments.map((e) => {
    const a = analyze(e, byExp.get(e.id) ?? []);
    return {
      id: e.id,
      name: e.name,
      p: a.primary.p,
      decision: a.decision,
      archetype: e.archetype,
      trueEffect: e.trueLiftOverall,
      trueDecision: e.trueDecision,
    };
  });

  it('120 个实验：Holm 收紧、收回的条数与注入真值对得上', () => {
    const f = familyReport(members, 0.05, 0.1);
    expect(f.n).toBe(120);
    expect(f.rows).toHaveLength(120);
    // 单调关系：Holm ⊆ naive，BH 通常比 Holm 宽
    expect(f.holmSig).toBeLessThanOrEqual(f.naiveSig);
    expect(f.bonferroniSig).toBeLessThanOrEqual(f.holmSig);
    expect(f.rescinded).toBe(f.naiveSig - f.holmSig);
    // 每条被收回的都必须是"原始显著、校正后不显著"
    for (const r of f.rows.filter((x) => x.rescinded)) {
      expect(r.p).toBeLessThanOrEqual(0.05);
      expect(r.pHolm).toBeGreaterThan(0.05);
    }
    expect(f.rescindedFalse).not.toBeNull();
    expect(f.rescindedFalse!).toBeLessThanOrEqual(f.rescinded);
    // 「总有一个显著」的算术
    expect(f.naiveAnySig).toBeCloseTo(1 - Math.pow(0.95, 120), 10);
  });

  it('校正只标清单，不改任何实验的 decision', () => {
    const f = familyReport(members, 0.05, 0.1);
    // 逐条对账：decision 原样带回来，没有因为 Holm 变成 inconclusive
    for (const r of f.rows) {
      const orig = members.find((m) => m.id === r.id)!;
      expect(r.decision).toBe(orig.decision);
    }
  });
});
