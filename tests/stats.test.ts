import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  bhAdjust, chi2Sf1, mdeTwoProportion, newcombeDiffCI, normalCdf, normalInv,
  powerTwoProportion, srmChi2, twoProportionZ, twoSidedP, wilson,
} from '../src/lib/stats.ts';

const fx = JSON.parse(readFileSync('tests/fixtures/scipy.json', 'utf8'));

const close = (a: number, b: number, rel = 1e-4, abs = 1e-9) => {
  expect(Math.abs(a - b)).toBeLessThan(Math.max(abs, Math.abs(b) * rel));
};

describe('分布函数', () => {
  it('normalCdf 关键点', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 12);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 4);
  });
  it('twoSidedP(1.96)≈0.05', () => {
    expect(twoSidedP(1.96)).toBeCloseTo(0.05, 3);
  });
  it('normalInv 与 normalCdf 互逆', () => {
    for (const p of [0.001, 0.025, 0.5, 0.8, 0.975, 0.999]) {
      close(normalCdf(normalInv(p)), p, 1e-6, 1e-8);
    }
  });
  it('chi2Sf1(3.841)≈0.05', () => {
    expect(chi2Sf1(3.841)).toBeCloseTo(0.05, 3);
  });
});

describe('与 scipy 对齐', () => {
  it('两比例 z 检验 p 值', () => {
    for (const c of fx.ztest) {
      const r = twoProportionZ(c.c1, c.n1, c.c2, c.n2);
      close(r.z, c.z, 1e-6, 1e-8);
      close(r.p, c.p, 1e-4, 1e-12);
    }
  });
  it('SRM 卡方 p 值', () => {
    for (const c of fx.srm) {
      const r = srmChi2([c.n1, c.n2], [0.5, 0.5]);
      close(r.chi2, c.chi2, 1e-6, 1e-8);
      close(r.p, c.p, 1e-4, 1e-12);
    }
  });
});

describe('置信区间', () => {
  it('Wilson 区间包含点估计且在 [0,1]', () => {
    for (const [c, n] of [[100, 1000], [5, 200], [2100, 30000]] as const) {
      const [l, u] = wilson(c / n, n);
      expect(l).toBeLessThanOrEqual(c / n);
      expect(u).toBeGreaterThanOrEqual(c / n);
      expect(l).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
    }
  });
  it('Newcombe 差值 CI 包含差值', () => {
    for (const c of fx.ztest) {
      const r = twoProportionZ(c.c1, c.n1, c.c2, c.n2);
      const [l, u] = newcombeDiffCI(c.c1, c.n1, c.c2, c.n2);
      expect(l).toBeLessThanOrEqual(r.diff + 1e-12);
      expect(u).toBeGreaterThanOrEqual(r.diff - 1e-12);
    }
  });
});

describe('多重比较与功效', () => {
  it('BH 单调且已知例子正确', () => {
    const { qvals, rejected } = bhAdjust([0.01, 0.02, 0.03, 0.04], 0.1);
    expect(qvals.every((v) => v <= 0.1)).toBe(true);
    expect(rejected.every(Boolean)).toBe(true);
    const r2 = bhAdjust([0.001, 0.5, 0.9], 0.1);
    expect(r2.rejected[0]).toBe(true);
    expect(r2.rejected[1]).toBe(false);
  });
  it('MDE 与功效互为反函数', () => {
    const p = 0.05, n = 20000;
    const mde = mdeTwoProportion(p, n);
    expect(mde).toBeGreaterThan(0.004);
    expect(mde).toBeLessThan(0.010);
    const power = powerTwoProportion(p, p + mde, n);
    expect(power).toBeGreaterThan(0.75);
    expect(power).toBeLessThan(0.86);
  });
});

describe('SRM 规则', () => {
  it('大样本小偏差不误报（1.6% 偏差）', () => {
    const r = srmChi2([29258, 28320], [0.5, 0.5]);
    expect(r.p).toBeLessThan(0.001); // 统计上显著
    expect(r.relImb).toBeLessThan(0.02);
    expect(r.flagged).toBe(false); // 但运营上不算异常
  });
  it('21% 偏差判异常', () => {
    const r = srmChi2([31539, 20468], [0.5, 0.5]);
    expect(r.relImb).toBeGreaterThan(0.2);
    expect(r.flagged).toBe(true);
  });
});
