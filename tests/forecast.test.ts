import { describe, expect, it } from 'vitest';
import { dailyRatePerArm, forecast, requiredNPerArm } from '../src/lib/forecast.ts';
import { generateDataset } from '../src/lib/simulate.ts';
import { analyze } from '../src/lib/decide.ts';
import { mdeTwoProportion, powerTwoProportion } from '../src/lib/stats.ts';

describe('还要跑几天 · 点估计外推', () => {
  it('requiredNPerArm 与 mdeTwoProportion 互为反函数（同一公式，不许各写一份）', () => {
    for (const p of [0.02, 0.05, 0.12, 0.4]) {
      for (const d of [0.002, 0.008, 0.03]) {
        const n = requiredNPerArm(p, d, 0.05, 0.8);
        const back = mdeTwoProportion(p, n, 0.05, 0.8);
        // ceil 到整数，反推出来的 MDE 应略小于目标差值（不超过 0.1% 的差）
        expect(back).toBeLessThanOrEqual(d + 1e-12);
        expect(back).toBeGreaterThan(d * 0.999);
      }
    }
  });

  it('效应为 0 时不给出样本量（返回 Infinity，而不是一个看似合理的数字）', () => {
    expect(requiredNPerArm(0.05, 0)).toBe(Infinity);
    expect(requiredNPerArm(0.05, 1e-15)).toBe(Infinity);
  });

  it('日均流量翻倍，点估计的剩余天数约减半', () => {
    const base = { n1: 5000, c1: 250, n2: 5000, c2: 270, diff: 0.004 };
    const a = forecast({ ...base, dailyRate: 1000, sims: 10 });
    const b = forecast({ ...base, dailyRate: 2000, sims: 10 });
    const ra = a.point.remainingDays;
    const rb = b.point.remainingDays;
    expect(ra).toBeGreaterThan(0);
    expect(Math.abs(rb - ra / 2)).toBeLessThanOrEqual(1);
  });

  it('样本已经远超所需时，剩余天数为 0 而不是负数', () => {
    const f = forecast({ n1: 200000, c1: 10000, n2: 200000, c2: 10800, diff: 0.004, dailyRate: 1000, sims: 10 });
    expect(f.point.remainingNPerArm).toBe(0);
    expect(f.point.remainingDays).toBe(0);
  });
});

describe('还要跑几天 · 概率模拟', () => {
  // 起点只放 500/臂：既保证 p̂ 能估出来，又让「起点数据已被条件化、没有抽样噪声」
  // 对后续功效的影响小到可以忽略（否则模拟会系统性偏乐观，与闭式功效对不上）
  const base = { n1: 500, c1: 25, n2: 500, c2: 27, diff: 0.004, se: 0, dailyRate: 2000, sims: 3000, seed: 7 };

  it('中位天数处的理论功效应接近 50%（这是模拟正确性的原理性检验）', () => {
    // se=0 → 真实效应固定为 0.004，每个模拟只是同一实验的一次重复。
    // 「50% 的模拟已经显著」⇔ 那个样本量下单次检验的功效约 50%。
    const f = forecast({ ...base, horizonDays: 40 });
    expect(f.sim.medianDays).not.toBeNull();
    const nAtMedian = 500 + 2000 * f.sim.medianDays!;
    expect(powerTwoProportion(0.05, 0.054, nAtMedian)).toBeGreaterThan(0.40);
    expect(powerTwoProportion(0.05, 0.054, nAtMedian)).toBeLessThan(0.64);
  });

  it('80% 分位处的功效应接近 80%', () => {
    const f = forecast({ ...base, horizonDays: 45 });
    expect(f.sim.p80Days).not.toBeNull();
    const n = 500 + 2000 * f.sim.p80Days!;
    expect(powerTwoProportion(0.05, 0.054, n)).toBeGreaterThan(0.70);
    expect(powerTwoProportion(0.05, 0.054, n)).toBeLessThan(0.90);
  });

  it('把握度曲线整体上升，末值 = 1 − stuck（不是「累计」而是「当天快照」）', () => {
    const f = forecast({ ...base, horizonDays: 25 });
    // 允许小抖动：p 值不随样本量严格单调，抖动量级应在几个百分点内
    for (let i = 1; i < f.sim.curve.length; i++) {
      expect(f.sim.curve[i].p).toBeGreaterThanOrEqual(f.sim.curve[i - 1].p - 0.05);
    }
    expect(f.sim.curve.at(-1)!.p).toBeCloseTo(1 - f.sim.stuck, 10);
    expect(f.sim.curve[0].day).toBe(0);
    expect(f.sim.curve.at(-1)!.day).toBe(25);
    // 后半程的把握度必须明显高于前半程（否则「还要跑几天」就没有意义了）
    expect(f.sim.curve.at(-1)!.p).toBeGreaterThan(f.sim.curve[0].p + 0.4);
  });

  it('分位数有序：p20 ≤ p50 ≤ p80', () => {
    const f = forecast({ ...base, horizonDays: 40 });
    expect(f.sim.p20Days!).toBeLessThanOrEqual(f.sim.medianDays!);
    expect(f.sim.medianDays!).toBeLessThanOrEqual(f.sim.p80Days!);
  });

  it('同一种子可复现，换种子结果接近但不相同（不是伪随机摆样子）', () => {
    const a = forecast({ ...base, horizonDays: 30 });
    const b = forecast({ ...base, horizonDays: 30 });
    const c = forecast({ ...base, horizonDays: 30, seed: 99 });
    expect(a.sim.medianDays).toBe(b.sim.medianDays);
    expect(a.sim.stuck).toBe(b.sim.stuck);
    expect(Math.abs(a.sim.stuck - c.sim.stuck)).toBeLessThan(0.1);
  });

  it('horizon 越长，等不到显著的比例越低', () => {
    const short = forecast({ ...base, horizonDays: 8 });
    const long = forecast({ ...base, horizonDays: 60 });
    expect(long.sim.stuck).toBeLessThanOrEqual(short.sim.stuck);
  });
});

describe('还要跑几天 · 判定与退化输入', () => {
  it('已经显著：中位天数 0，结论是「不用再跑了」', () => {
    const f = forecast({ n1: 50000, c1: 2500, n2: 50000, c2: 2800, diff: 0.006, dailyRate: 2000, sims: 200 });
    expect(f.observed.significant).toBe(true);
    expect(f.sim.medianDays).toBe(0);
    expect(f.sim.stuck).toBe(0);
    expect(f.verdict.code).toBe('done');
    expect(f.sim.curve.every((c) => c.p === 1)).toBe(true);
  });

  it('真实效应在 0 附近：多数模拟等不到显著，结论是「不值得等」', () => {
    const f = forecast({ n1: 20000, c1: 1000, n2: 20000, c2: 1000, diff: 0, dailyRate: 2000, horizonDays: 30, sims: 2000 });
    expect(f.sim.stuck).toBeGreaterThan(0.6);
    expect(f.verdict.code).toBe('unlikely');
  });

  it('日均流量为 0（数据里没有可用日期）时不崩、不编造天数', () => {
    const f = forecast({ n1: 1000, c1: 50, n2: 1000, c2: 60, dailyRate: 0, sims: 50 });
    expect(f.point.remainingDays).toBe(Infinity);
    expect(f.sim.medianDays).toBeNull();
    expect(f.verdict.code).toBe('unlikely');
    expect(f.verdict.text).toMatch(/没有可用的日级曝光/);
  });

  it('空数据不抛异常', () => {
    const f = forecast({ n1: 0, c1: 0, n2: 0, c2: 0, dailyRate: 0, sims: 10 });
    expect(Number.isFinite(f.observed.diff)).toBe(true);
    expect(f.observed.se).toBe(0);
  });

  it('MDE 随时间下降（流量越多，越能检出小效应）', () => {
    const f = forecast({ n1: 5000, c1: 250, n2: 5000, c2: 260, dailyRate: 1000, horizonDays: 30, sims: 50 });
    expect(f.mde.atHorizon).toBeLessThan(f.mde.now);
  });
});

describe('还要跑几天 · 与真实数据表对齐', () => {
  const ds = generateDataset(20261101);

  it('dailyRatePerArm 按「每臂取较小值」算，只取最近 k 天', () => {
    const rows = [
      { variant: 'control', date: '2026-09-01', exposures: 100 },
      { variant: 'treatment', date: '2026-09-01', exposures: 90 },
      { variant: 'control', date: '2026-09-02', exposures: 200 },
      { variant: 'treatment', date: '2026-09-02', exposures: 180 },
      { variant: 'control', date: '2026-09-03', exposures: 300 },
      { variant: 'treatment', date: '2026-09-03', exposures: 300 },
    ];
    expect(dailyRatePerArm(rows, 2)).toBeCloseTo((180 + 300) / 2, 6);
    expect(dailyRatePerArm(rows, 99)).toBeCloseTo((90 + 180 + 300) / 3, 6);
    expect(dailyRatePerArm([], 3)).toBe(0);
  });

  it('对 120 个合成实验逐个预测：不抛错、值域合法', () => {
    for (const exp of ds.experiments) {
      const rows = ds.daily.filter((r) => r.expId === exp.id);
      const a = analyze(exp, rows);
      const f = forecast({
        n1: a.overall.n1,
        c1: Math.round(a.overall.controlRate * a.overall.n1),
        n2: a.overall.n2,
        c2: Math.round(a.overall.treatmentRate * a.overall.n2),
        diff: a.primary.diff,
        se: a.primary.se,
        dailyRate: dailyRatePerArm(rows, 3),
        elapsedDays: 7,
        sims: 200,
      });
      expect(f.sim.stuck).toBeGreaterThanOrEqual(0);
      expect(f.sim.stuck).toBeLessThanOrEqual(1);
      expect(['done', 'eta', 'unlikely']).toContain(f.verdict.code);
      if (f.sim.medianDays !== null) expect(f.sim.medianDays).toBeLessThanOrEqual(30);
    }
  });
});
