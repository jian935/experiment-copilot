import { describe, expect, it } from 'vitest';
import { nearestIndex, scaleY, xAt, yDomain, yTicks } from '../src/lib/trendGeom.ts';

/**
 * 趋势图几何（F9）。
 *
 * 这里锁的四条都是「写错了肉眼也看不出来」的类型：
 * 纵轴方向画反、点被挤出画布、悬停取到隔壁那天、值域把细微差别压平。
 */
describe('F9 · 趋势图几何', () => {
  it('scaleY 方向正确：值越大越靠上（SVG 的 y 向下增长，最容易写反）', () => {
    const top = 10;
    const bottom = 110;
    const yLo = scaleY(0, 0, 1, top, bottom);
    const yHi = scaleY(1, 0, 1, top, bottom);
    expect(yHi).toBeLessThan(yLo); // 大的在上
    expect(yHi).toBe(top);
    expect(yLo).toBe(bottom);
    expect(scaleY(0.5, 0, 1, top, bottom)).toBe(60);
  });

  it('值域退化时不炸：空数组 / 全同值 / 单个点', () => {
    expect(yDomain([], false)).toEqual([0, 1]);
    const flat = yDomain([0.5, 0.5, 0.5], false);
    expect(flat[0]).toBeLessThan(flat[1]); // 不能退化成 lo === hi（会让所有点叠在一条线上）
    const one = yDomain([0.42], true);
    // 连续口径下界钉在 0；上界 = 最大观测 + max(25% 跨度, 0.02) 的余量（与旧图保持同一口径）
    expect(one).toEqual([0, 0.42 + Math.max(0.42 * 0.25, 0.02)]);
  });

  it('连续口径下界必须是 0（金额画成负的是假信息）；率口径不钉死在 0', () => {
    const cont = yDomain([12, 13], true);
    expect(cont[0]).toBe(0);
    const rate = yDomain([0.004, 0.005], false);
    // 钉死到 0 的话 0.004 与 0.005 的差别会被压成一条线
    expect(rate[0]).toBeGreaterThan(0);
    expect(rate[0]).toBeLessThan(0.004);
  });

  it('所有点都落在画布内（含极值点）', () => {
    const vals = [0.01, 0.05, 0.03];
    const [lo, hi] = yDomain(vals, false);
    for (const v of vals) {
      const y = scaleY(v, lo, hi, 0, 176);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(176);
    }
  });

  it('纵轴刻度落在值域内且不超过 6 条', () => {
    for (const [lo, hi, cont] of [
      [0, 1.2, true],
      [0.003, 0.007, false],
      [0, 0.05, false],
    ] as const) {
      const ts = yTicks(lo, hi, cont);
      expect(ts.length).toBeGreaterThanOrEqual(2);
      expect(ts.length).toBeLessThanOrEqual(6);
      for (const t of ts) {
        expect(t).toBeGreaterThanOrEqual(lo - 1e-9);
        expect(t).toBeLessThanOrEqual(hi + 1e-9);
      }
      for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]);
    }
  });

  it('nearestIndex：越界要夹住，不能返回 -1（那会取到 undefined 的一天）', () => {
    expect(nearestIndex(7, 600, -50)).toBe(0);
    expect(nearestIndex(7, 600, 9999)).toBe(6);
    expect(nearestIndex(7, 600, 0)).toBe(0);
    expect(nearestIndex(7, 600, 600)).toBe(6);
    // 7 天 6 段，每段 100px：中点两侧各归到最近的那天
    expect(nearestIndex(7, 600, 149)).toBe(1);
    expect(nearestIndex(7, 600, 151)).toBe(2);
    expect(nearestIndex(0, 600, 10)).toBe(-1);
    expect(nearestIndex(1, 600, 300)).toBe(0);
    // 容器宽度为 0（还没测量出来）时不能崩
    expect(nearestIndex(5, 0, 10)).toBe(0);
  });

  it('xAt 首尾贴边、间距均匀；单点居中', () => {
    expect(xAt(0, 7, 600)).toBe(0);
    expect(xAt(6, 7, 600)).toBe(600);
    expect(xAt(3, 7, 600)).toBe(300);
    expect(xAt(0, 1, 600)).toBe(300);
  });
});
