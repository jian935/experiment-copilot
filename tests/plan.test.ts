import { describe, expect, it } from 'vitest';
import {
  alphaForArms,
  daysNeeded,
  mdeForDays,
  sampleSizeContinuous,
  sampleSizeTwoProportion,
} from '../src/lib/plan.ts';
import { powerTwoProportion } from '../src/lib/stats.ts';

describe('样本量：两比例', () => {
  it('反解出来的 n 真的能达到目标功效（这是最重要的一条）', () => {
    // 「按公式算 3000、跑完只有 0.78 功效」是最常见的坑。所以断言不是「n 等于某个数」，
    // 而是「在这个 n 下，功效函数本身 ≥ 0.8」——两者自洽，不依赖外部近似公式
    for (const [p1, p2] of [
      [0.05, 0.055],
      [0.05, 0.06],
      [0.012, 0.014],
      [0.2, 0.22],
      [0.5, 0.55],
    ]) {
      const r = sampleSizeTwoProportion({ p1, p2, alpha: 0.05, power: 0.8 });
      const p = powerTwoProportion(p1, p2, r.nPerArm, 0.05);
      expect(p, `p1=${p1} p2=${p2} 功效只有 ${p.toFixed(4)}`).toBeGreaterThanOrEqual(0.7999);
      // 再少一个就达不到：说明 n 是最小的那一个，不是拍脑袋放大过
      expect(powerTwoProportion(p1, p2, r.nPerArm - 1, 0.05)).toBeLessThan(0.8);
      expect(r.achievedPower).toBeCloseTo(p, 10);
    }
  });

  it('5% → 5.5%（相对 +10%）需要约 3 万个/组——这是最该被看见的数字', () => {
    const r = sampleSizeTwoProportion({ p1: 0.05, p2: 0.055 });
    expect(r.nPerArm).toBeGreaterThan(28_000);
    expect(r.nPerArm).toBeLessThan(34_000);
    expect(r.total).toBe(r.nPerArm * 2);
    // 近似公式与二分反解差得不多，但差的那 1–3% 足够让结论翻车，所以对外只用反解值
    expect(Math.abs(r.fleissEstimate - r.nPerArm) / r.nPerArm).toBeLessThan(0.05);
  });

  it('效应越小样本越大（单调），且功效要求越高样本越大', () => {
    const a = sampleSizeTwoProportion({ p1: 0.1, p2: 0.11 }).nPerArm;
    const b = sampleSizeTwoProportion({ p1: 0.1, p2: 0.12 }).nPerArm;
    expect(a).toBeGreaterThan(b);

    const low = sampleSizeTwoProportion({ p1: 0.1, p2: 0.12, power: 0.8 }).nPerArm;
    const high = sampleSizeTwoProportion({ p1: 0.1, p2: 0.12, power: 0.9 }).nPerArm;
    expect(high).toBeGreaterThan(low);
  });

  it('α 更严 → 样本更多；同样是 2 臂时单双侧差异被显式忽略（统一按双侧）', () => {
    const a5 = sampleSizeTwoProportion({ p1: 0.1, p2: 0.12, alpha: 0.05 }).nPerArm;
    const a1 = sampleSizeTwoProportion({ p1: 0.1, p2: 0.12, alpha: 0.01 }).nPerArm;
    expect(a1).toBeGreaterThan(a5);
  });

  it('非法输入给可执行的提示，而不是 NaN', () => {
    expect(() => sampleSizeTwoProportion({ p1: 0, p2: 0.05 })).toThrow(/之间/);
    expect(() => sampleSizeTwoProportion({ p1: 0.05, p2: 0.05 })).toThrow(/效应为 0/);
    expect(() => sampleSizeTwoProportion({ p1: 0.05, p2: 1.5 })).toThrow();
  });
});

describe('样本量：连续指标', () => {
  it('闭式解与功效函数的定义一致（σ=50、Δ=2 元 → 约 1 万/组）', () => {
    const r = sampleSizeContinuous({ sd: 50, delta: 2 });
    expect(r.nPerArm).toBeGreaterThan(9_000);
    expect(r.nPerArm).toBeLessThan(11_000);
    expect(r.total).toBe(r.nPerArm * 2);
  });

  it('σ 翻倍 → 样本量翻四倍（平方关系，PM 最容易低估的地方）', () => {
    const a = sampleSizeContinuous({ sd: 25, delta: 2 }).nPerArm;
    const b = sampleSizeContinuous({ sd: 50, delta: 2 }).nPerArm;
    expect(b / a).toBeCloseTo(4, 0);
  });

  it('缺 σ 或 Δ 为 0 时拒绝计算，不猜默认值', () => {
    expect(() => sampleSizeContinuous({ sd: 0, delta: 2 })).toThrow(/标准差/);
    expect(() => sampleSizeContinuous({ sd: 50, delta: 0 })).toThrow(/差值/);
  });
});

describe('天数与可检出效应', () => {
  it('日流量 2 万、五五分：每组每天 1 万，31k/组要 4 天', () => {
    const r = daysNeeded({ nPerArm: 31_000, dailyTraffic: 20_000 });
    expect(r.perArmPerDay).toBe(10_000);
    expect(r.days).toBe(4);
  });

  it('分流不均时按**小的那一边**算（90/10 会让实验组等更久）', () => {
    const r = daysNeeded({ nPerArm: 10_000, dailyTraffic: 20_000, controlShare: 0.9 });
    expect(r.perArmPerDay).toBe(2_000);
    expect(r.days).toBe(5);
  });

  it('流量太小导致某组每天进不了人 → 报错而不是返回 Infinity', () => {
    expect(() => daysNeeded({ nPerArm: 100, dailyTraffic: 1, controlShare: 0.99 })).toThrow(/每天进不了/);
  });

  it('「只能跑 14 天」→ 反推可检出的最小相对提升', () => {
    const r = mdeForDays({ p1: 0.05, days: 14, dailyTraffic: 20_000 });
    expect(r.nPerArm).toBe(140_000);
    // 样本越少，能测出的效应越大
    const short = mdeForDays({ p1: 0.05, days: 3, dailyTraffic: 20_000 });
    expect(short.mdeRel).toBeGreaterThan(r.mdeRel);
    expect(r.mdeRel).toBeLessThan(0.05);
    expect(short.mdeRel).toBeGreaterThan(0.05);
  });
});

describe('多臂的 α 分摊', () => {
  it('3 臂 = 2 次比较，α 减半；把「为什么不是 α」写进返回值', () => {
    expect(alphaForArms(0.05, 2)).toEqual({ alphaPerComparison: 0.05, comparisons: 1 });
    expect(alphaForArms(0.05, 3)).toEqual({ alphaPerComparison: 0.025, comparisons: 2 });
    expect(alphaForArms(0.05, 4).comparisons).toBe(3);
  });
});
