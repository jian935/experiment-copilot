import { describe, expect, it } from 'vitest';
import { MAX_TICKS, forestScale, niceStep, tickLabel } from '../src/lib/forestScale.ts';

/**
 * 森林图定标。
 *
 * 这一组测试存在的直接原因是一个真 bug：pp 单位的刻度用「百分点」算步长、
 * 却用「百分数」取起点，两者差 100 倍，一条横轴画出 341 条网格线——
 * 渲染出来是一片浅色条纹底，肉眼看很像刻意做的网格背景，没人会怀疑。
 * 所以这里锁死三件事：**刻度条数可控、刻度落在画布内、标签与单位对得上**。
 */
describe('森林图定标', () => {
  it('niceStep 只产出 1/2/5 × 10^k', () => {
    for (const raw of [0.0007, 0.003, 0.013, 0.2, 0.7, 3.4, 61, 940]) {
      const s = niceStep(raw);
      const mant = s / 10 ** Math.floor(Math.log10(s));
      expect([1, 2, 5, 10]).toContain(Math.round(mant * 10) / 10);
      expect(s).toBeGreaterThanOrEqual(raw / 2.5);
    }
  });

  it('回归：pp 单位的窄区间不再画出几百条刻度', () => {
    // 就是对比视图的真实数据（E001 [1.44,2.47] 与 E002 [-0.19,0.99] 同轴）
    const s = forestScale(
      [
        [1.44, 2.47],
        [-0.19, 0.99],
      ],
      'pp',
    );
    expect(s.ticks.length).toBeLessThanOrEqual(MAX_TICKS);
    expect(s.ticks.length).toBeGreaterThanOrEqual(3);
    // 步长是显示单位的 1/2/5 × 10^k：这次应当是 50（即 0.5pp）
    expect([25, 50, 100, 200]).toContain(s.step);
    // 负半轴也要有刻度，否则读者看不出横轴从哪里起
    expect(s.ticks).toEqual([-0.5, 0, 0.5, 1, 1.5, 2, 2.5]);
  });

  it('刻度全部落在画布内、单调递增、且含 0（零点参考线必须在轴上）', () => {
    const cases: [number, number][][] = [
      [[0.4, 1.2]],
      [[-1.1, -0.3]],
      [[-0.4, 0.6]],
      [
        [1.65, 2.55],
        [1.8, 3.0],
        [2.1, 2.6],
      ],
      [[0.0001, 0.0002]],
      [[12, 210]],
    ];
    for (const cis of cases) {
      for (const unit of ['pp', '元'] as const) {
        const s = forestScale(cis, unit);
        expect(s.ticks.length).toBeLessThanOrEqual(MAX_TICKS);
        for (let i = 0; i < s.ticks.length; i++) {
          expect(s.ticks[i]).toBeGreaterThanOrEqual(s.x0 - 1e-9);
          expect(s.ticks[i]).toBeLessThanOrEqual(s.x1 + 1e-9);
          if (i > 0) expect(s.ticks[i]).toBeGreaterThan(s.ticks[i - 1]);
        }
        expect(s.x0).toBeLessThan(0);
        expect(s.x1).toBeGreaterThan(0);
        // 两端都不留白会刚好切到 CI 端点
        expect(s.x0).toBeLessThan(Math.min(...cis.map((c) => c[0])));
        expect(s.x1).toBeGreaterThan(Math.max(...cis.map((c) => c[1])));
      }
    }
  });

  it('刻度间隔均匀（浮点累加不漂）：相邻差不等于步长就说明换算又错位了', () => {
    const s = forestScale(
      [
        [1.44, 2.47],
        [-0.19, 0.99],
      ],
      'pp',
    );
    const gaps = s.ticks.slice(1).map((t, i) => (t - s.ticks[i]) * 100);
    for (const g of gaps) expect(g).toBeCloseTo(s.step, 6);
  });

  it('单位决定标签：pp 乘 100 且不带小数，元按步长给小数', () => {
    const pp = forestScale([[0.02, 0.05]], 'pp');
    expect(pp.decimals).toBe(0);
    expect(pp.ticks.map((t) => tickLabel(t, 'pp', pp.decimals))).toContain('+4');

    const yuan = forestScale([[0.4, 1.2]], '元');
    const labels = yuan.ticks.map((t) => tickLabel(t, '元', yuan.decimals));
    // 元的口径下绝不能出现「+100」这种百分数标签
    for (const l of labels) expect(Math.abs(Number(l))).toBeLessThanOrEqual(2);
    // 符号与零的写法要稳定：靠它区分「落在 0 哪一侧」
    expect(tickLabel(0, '元', 1)).toBe('0.0');
    expect(tickLabel(0.4, '元', 1)).toBe('+0.4');
    expect(tickLabel(-0.3, '元', 1)).toBe('-0.3');
    expect(tickLabel(-0, 'pp', 0)).toBe('0');
  });

  it('退化输入不打崩：单点 CI、负数区间、极窄区间都给得出合理刻度', () => {
    const zero: [number, number][] = [[0, 0]];
    const s = forestScale(zero, 'pp');
    expect(s.ticks.length).toBeGreaterThanOrEqual(3);
    expect(Number.isFinite(s.x0)).toBe(true);
    expect(Number.isFinite(s.x1)).toBe(true);
    expect(s.ticks.every(Number.isFinite)).toBe(true);

    const narrow = forestScale([[1e-9, 2e-9]], '元');
    expect(narrow.ticks.length).toBeLessThanOrEqual(MAX_TICKS);
    expect(narrow.ticks.length).toBeGreaterThanOrEqual(3);
  });
});
