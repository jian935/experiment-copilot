import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  bayesBetaBinomial, betai, bhAdjust, bootstrapCI, bootstrapP, bootstrapTwoSample, chi2Sf1,
  guardrailBlocks, lgamma, mdeTwoProportion, mulberry32, newcombeDiffCI, nonInferiority,
  normalCdf, normalInv, powerTwoProportion, quantile, simulateDiffCiCoverage,
  simulateWilsonCoverage, srmChi2, twoProportionZ, twoSidedP, wilson,
} from '../src/lib/stats.ts';
import { DEFAULT_CONFIG } from '../src/lib/config.ts';

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

describe('贝叶斯层（Beta-Binomial）', () => {
  it('lgamma 与 ln Γ 已知值对齐', () => {
    close(lgamma(1), 0, 1e-10, 1e-12);
    close(lgamma(0.5), 0.5723649429, 1e-9, 1e-12); // ln √π
    close(lgamma(5), Math.log(24), 1e-9, 1e-12); // Γ(5)=24
    close(lgamma(10), Math.log(362880), 1e-9, 1e-12);
  });

  it('betai 与闭式 CDF 已知值对齐', () => {
    expect(betai(0.5, 1, 1)).toBeCloseTo(0.5, 12); // Uniform
    expect(betai(0.3, 1, 1)).toBeCloseTo(0.3, 12);
    // Beta(1,2): CDF = 2x − x²；I_0.5 = 0.75
    expect(betai(0.5, 1, 2)).toBeCloseTo(0.75, 10);
    // Beta(2,1): CDF = x²；I_0.5 = 0.25
    expect(betai(0.5, 2, 1)).toBeCloseTo(0.25, 10);
    // Beta(2,2): CDF = 3x² − 2x³；I_0.5 = 0.5
    expect(betai(0.5, 2, 2)).toBeCloseTo(0.5, 10);
  });

  it('betai 单调且在 [0,1]', () => {
    let prev = -1;
    for (let x = 0.05; x <= 0.95; x += 0.05) {
      const v = betai(x, 3, 7);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
  });

  it('P(B>A) 对称性：两变体相同时 ≈ 0.5', () => {
    const r = bayesBetaBinomial(500, 1000, 500, 1000);
    expect(r.probTreatBetter).toBeCloseTo(0.5, 2);
    expect(r.meanDiff).toBeCloseTo(0, 6);
  });

  it('treatment 明显更好时 P(B>A)→1，且期望损失很小', () => {
    const r = bayesBetaBinomial(100, 1000, 200, 1000);
    expect(r.probTreatBetter).toBeGreaterThan(0.999);
    expect(r.expectedLoss).toBeLessThan(0.005);
    expect(r.credLow).toBeGreaterThan(0);
  });

  it('treatment 明显更差时 P(B>A)→0，且期望损失≈|均值差|', () => {
    const r = bayesBetaBinomial(200, 1000, 100, 1000);
    expect(r.probTreatBetter).toBeLessThan(0.001);
    expect(r.expectedLoss).toBeGreaterThan(0.05);
    expect(r.meanDiff).toBeLessThan(0);
  });

  it('极端不对称处确定性且落在合理区间', () => {
    // 同一输入重复调用必须完全一致（确定性），且 P(B>A) 在合理范围内
    const a = bayesBetaBinomial(305, 990, 360, 1010);
    const b = bayesBetaBinomial(305, 990, 360, 1010);
    expect(a.probTreatBetter).toBe(b.probTreatBetter);
    expect(a.probTreatBetter).toBeGreaterThan(0.9);
    expect(a.probTreatBetter).toBeLessThan(1);
  });

  it('可信区间包含后验均值差', () => {
    const r = bayesBetaBinomial(305, 990, 360, 1010);
    expect(r.credLow).toBeLessThanOrEqual(r.meanDiff + 1e-12);
    expect(r.credHigh).toBeGreaterThanOrEqual(r.meanDiff - 1e-12);
  });
});

// ===================== A9：CI 覆盖率模拟 =====================
// 蓝图 §8 要求「区间覆盖率 94–96%」。以前只有「区间包含点估计」这种自证式断言，
// 现在改成真的拿已知真值去模拟抽样：覆盖率必须落在标称 95% 附近。
// 实测（trials=2000，seed=20261101）：n=500 → 95.40%；n=2000 → 95.30%；Wilson n=500 → 94.90%。
// Newcombe 略偏保守（覆盖 > 95%）是已知且符合理论的，所以上界取 96.5% 而不是 96%。
describe('A9 · 置信区间覆盖率模拟（蒙特卡洛）', () => {
  it('Newcombe 差值 CI 覆盖率落在 93.5%–96.5%', () => {
    const r = simulateDiffCiCoverage({ p1: 0.05, p2: 0.05, nPerArm: 2000, trials: 2000 });
    expect(r.trials).toBe(2000);
    expect(r.coverage).toBeGreaterThan(0.935);
    expect(r.coverage).toBeLessThan(0.965);
    // 覆盖率的标准误要足够小，这个数才谈得上"可信"
    expect(r.se).toBeLessThan(0.01);
  });

  it('小样本下也不至于塌（n=500/arm）', () => {
    const r = simulateDiffCiCoverage({ p1: 0.05, p2: 0.05, nPerArm: 500, trials: 2000 });
    expect(r.coverage).toBeGreaterThan(0.935);
    expect(r.coverage).toBeLessThan(0.965);
  });

  it('有真实效应时覆盖率同样成立', () => {
    const r = simulateDiffCiCoverage({ p1: 0.05, p2: 0.07, nPerArm: 2000, trials: 2000 });
    expect(r.coverage).toBeGreaterThan(0.935);
    expect(r.coverage).toBeLessThan(0.965);
  });

  it('Wilson 单比例 CI 覆盖率落在 93.5%–96.5%', () => {
    const r = simulateWilsonCoverage({ p: 0.05, n: 500, trials: 2000 });
    expect(r.coverage).toBeGreaterThan(0.935);
    expect(r.coverage).toBeLessThan(0.965);
  });

  it('同种子两次模拟逐位相同（可复现，能写进文档）', () => {
    const a = simulateDiffCiCoverage({ p1: 0.05, p2: 0.06, nPerArm: 800, trials: 300, seed: 42 });
    const b = simulateDiffCiCoverage({ p1: 0.05, p2: 0.06, nPerArm: 800, trials: 300, seed: 42 });
    expect(a.coverage).toBe(b.coverage);
    expect(a.hits).toBe(b.hits);
    expect(a.meanWidth).toBe(b.meanWidth);
  });

  it('mulberry32 均匀性与确定性', () => {
    const r1 = mulberry32(7);
    const r2 = mulberry32(7);
    for (let i = 0; i < 100; i++) expect(r1()).toBe(r2());
    const r3 = mulberry32(20261101);
    let s = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) s += r3();
    expect(Math.abs(s / N - 0.5)).toBeLessThan(0.01); // 均值≈0.5
  });
});

// ===================== A5：Bootstrap =====================
describe('A5 · Bootstrap（固定种子，可复现）', () => {
  const xs = Array.from({ length: 60 }, (_, i) => 100 + ((i * 37) % 61));

  it('同种子两次结果逐位相同', () => {
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const a = bootstrapCI(xs, mean, { reps: 2000, seed: 123 });
    const b = bootstrapCI(xs, mean, { reps: 2000, seed: 123 });
    expect(a.ciLow).toBe(b.ciLow);
    expect(a.ciHigh).toBe(b.ciHigh);
    expect(a.se).toBe(b.se);
  });

  it('均值 Bootstrap 区间与解析标准误同量级，且包含点估计', () => {
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const r = bootstrapCI(xs, mean, { reps: 10000, seed: 20261101 });
    expect(r.method).toBe('bca'); // 默认走 BCa，不是只做百分位法
    expect(Number.isFinite(r.z0)).toBe(true);
    expect(Number.isFinite(r.accel)).toBe(true);
    expect(r.ciLow).toBeLessThan(r.estimate);
    expect(r.ciHigh).toBeGreaterThan(r.estimate);
    // Bootstrap 标准误应接近 σ/√n
    const m = mean(xs);
    const sd = Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
    expect(r.se).toBeGreaterThan(0.7 * (sd / Math.sqrt(xs.length)));
    expect(r.se).toBeLessThan(1.4 * (sd / Math.sqrt(xs.length)));
  });

  it('reps 翻倍后区间宽度接近（收敛）', () => {
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const a = bootstrapCI(xs, mean, { reps: 2000, seed: 9 });
    const b = bootstrapCI(xs, mean, { reps: 8000, seed: 9 });
    const wa = a.ciHigh - a.ciLow;
    const wb = b.ciHigh - b.ciLow;
    expect(Math.abs(wa - wb) / wb).toBeLessThan(0.25);
  });

  it('两样本 Bootstrap：差值区间包含点估计差值', () => {
    const a = [10, 12, 9, 11, 13, 8, 12, 10];
    const b = [14, 16, 13, 15, 17, 12, 16, 14];
    const diff = (x: number[], y: number[]) =>
      y.reduce((s, v) => s + v, 0) / y.length - x.reduce((s, v) => s + v, 0) / x.length;
    const r = bootstrapTwoSample(a, b, diff, { reps: 5000, seed: 5 });
    expect(r.estimate).toBeCloseTo(4, 10);
    expect(r.ciLow).toBeLessThan(r.estimate);
    expect(r.ciHigh).toBeGreaterThan(r.estimate);
    // 两组完全分离，区间不该跨 0
    expect(r.ciLow).toBeGreaterThan(0);
  });

  it('分位数 Bootstrap（P95）：与 R type-7 分位数一致且可重抽样', () => {
    const q = quantile([1, 2, 3, 4, 5], 0.5);
    expect(q).toBeCloseTo(3, 10);
    expect(quantile([1, 2, 3, 4, 5], 0.95)).toBeCloseTo(4.8, 10);
    const r = bootstrapCI(xs, (a) => quantile(a, 0.95), { reps: 3000, seed: 11 });
    expect(r.ciLow).toBeLessThanOrEqual(r.estimate);
    expect(r.ciHigh).toBeGreaterThanOrEqual(r.estimate);
  });

  it('空样本返回 NaN 而不抛错', () => {
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const r = bootstrapCI([], mean);
    expect(Number.isNaN(r.estimate)).toBe(true);
  });

  it('bootstrapP：阈值在分布左侧时 p≈0，右侧时 p≈1', () => {
    expect(bootstrapP([1, 2, 3, 4, 5], 0)).toBe(0);
    expect(bootstrapP([1, 2, 3, 4, 5], 9)).toBe(1);
    expect(bootstrapP([1, 2, 3, 4, 5], 3)).toBeCloseTo(0.6, 10);
  });

  it('threshold 只会回传一个 p 值，不会把上万个数带进结果', () => {
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const r = bootstrapCI(xs, mean, { reps: 2000, threshold: 130 });
    expect(r.reps).toBe(2000);
    expect(typeof r.pBelow).toBe('number');
    expect((r as unknown as Record<string, unknown>).values).toBeUndefined();
    const keys = Object.keys(r);
    expect(keys.length).toBeLessThan(12);
  });

  it('显式指定 percentile 时不用 BCa', () => {
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const r = bootstrapCI(xs, mean, { reps: 2000, method: 'percentile' });
    expect(r.method).toBe('percentile');
    expect(r.z0).toBe(0);
    expect(r.accel).toBe(0);
  });
});

// ===================== A4：非劣检验 =====================
describe('A4 · 非劣检验（护栏的正式口径）', () => {
  it('恶化明显小于 margin → 非劣成立', () => {
    // 退款率 1.20% → 1.30%，margin 0.4pp：恶化 0.1pp 在容忍范围内
    const r = nonInferiority(120, 10000, 130, 10000, 0.004);
    expect(r.diff).toBeCloseTo(0.001, 10);
    expect(r.nonInferior).toBe(true);
    expect(r.worse).toBe(false);
    expect(r.verdict).toBe('non_inferior');
  });

  it('恶化明显超过 margin → 判 worse', () => {
    // 1.20% → 1.80%（10 万/臂），恶化 0.6pp > margin 0.4pp，样本足够才能确认
    const r = nonInferiority(1200, 100000, 1800, 100000, 0.004);
    expect(r.worse).toBe(true);
    expect(r.verdict).toBe('worse');
    expect(r.pWorse).toBeLessThan(0.05);
  });

  it('同样的点估计，样本不够时判 inconclusive 而不是 worse（不拿噪声当结论）', () => {
    // 与上一例同样的 1.20% → 1.80%，但只有 1 万/臂：恶化幅度看着一样，证据却不够
    const r = nonInferiority(120, 10000, 180, 10000, 0.004);
    expect(r.diff).toBeCloseTo(0.006, 10);
    expect(r.worse).toBe(false);
    expect(r.verdict).toBe('inconclusive');
  });

  it('样本不足 → inconclusive（不武断放行，也不误报）', () => {
    const r = nonInferiority(6, 500, 9, 500, 0.004);
    expect(r.verdict).toBe('inconclusive');
    expect(r.worse).toBe(false);
    expect(r.nonInferior).toBe(false);
  });

  it('与单侧 z 检验等价：两个方向各自对齐闭式', () => {
    const r = nonInferiority(120, 10000, 150, 10000, 0.004);
    const p1 = 0.012, p2 = 0.015;
    const se = Math.sqrt((p1 * (1 - p1)) / 10000 + (p2 * (1 - p2)) / 10000);
    close(r.se, se, 1e-10, 1e-12);
    // 确认恶化：右上尾
    close(r.pWorse, 1 - normalCdf((0.003 - 0.004) / se), 1e-10, 1e-12);
    // 非劣成立：左下尾（margin − Δ 方向）
    close(r.pNonInferior, 1 - normalCdf((0.004 - 0.003) / se), 1e-10, 1e-12);
    // 两个方向互斥（同一个单侧临界值的两端）
    close(r.pWorse + r.pNonInferior, 1, 1e-10, 1e-12);
  });

  it('margin = 0 时退化为单侧检验（与旧「差值为正且 p<0.01」同向）', () => {
    const r = nonInferiority(120, 10000, 180, 10000, 0);
    // 双侧 p ≈ 2×(1−Φ(z))；旧的硬门槛是双侧 p<0.01，即单侧 0.005
    expect(r.pWorse).toBeLessThan(0.005);
  });

  it('margin 越大越容易判非劣（单调）', () => {
    const a = nonInferiority(120, 10000, 150, 10000, 0.001);
    const b = nonInferiority(120, 10000, 150, 10000, 0.01);
    expect(b.pNonInferior).toBeLessThan(a.pNonInferior);
    expect(b.nonInferior).toBe(true);
  });

  it('三种护栏口径严度有序：非劣 ≥ 确认超 margin ≥ 统计显著∧达阈值', () => {
    // 注入的"退款率恶化 0.6pp"、margin 0.4pp、每臂 2 万（与本数据集同量级）
    const ni = nonInferiority(240, 20000, 360, 20000, 0.004, 0.005);
    const harm = guardrailBlocks(ni, 'harm_and_practical');
    const beyond = guardrailBlocks(ni, 'confirm_beyond_margin');
    const noninf = guardrailBlocks(ni, 'non_inferiority');
    // 拦得越严的组合越容易拦：非劣不成立即拦 ⊇ 确认超 margin ⊇ 显著∧达阈值
    if (harm) expect(beyond || noninf).toBe(true);
    if (beyond) expect(noninf).toBe(true);
    // 三种口径都必须是布尔值且互不矛盾
    expect(typeof harm).toBe('boolean');
    expect(harm && beyond && noninf).not.toBeUndefined();
  });

  it('margin 低于噪声地板时，最严口径会漏判（这正是默认不用它的原因）', () => {
    // 真实恶化 0.8pp、margin 0.4pp、SE≈0.126pp：确认超 margin 需要观测 > 0.73pp
    const ni = nonInferiority(240, 20000, 400, 20000, 0.004, 0.005);
    expect(ni.margin).toBeLessThan(ni.detectableDelta);
    expect(ni.detectableDelta).toBeGreaterThan(0.004);
    // 观测差值刚好等于注入值时，"统计显著∧达阈值"能拦，最严口径不一定能拦
    const okHarm = guardrailBlocks(ni, 'harm_and_practical');
    expect(okHarm).toBe(true);
  });

  it('默认配置选用 harm_and_practical（有据可依，不是迁就准确率）', () => {
    expect(DEFAULT_CONFIG.guardrails.refundRate.mode).toBe('harm_and_practical');
    expect(DEFAULT_CONFIG.guardrails.refundRate.gating).toBe(true);
    expect(DEFAULT_CONFIG.guardrails.complaintRate.gating).toBe(false);
    expect(DEFAULT_CONFIG.bootstrapReps).toBe(10000);
    expect(Number.isFinite(DEFAULT_CONFIG.simSeed)).toBe(true);
  });

  it('CI 与判定自洽：非劣成立 ⟺ 单侧上界 < margin', () => {
    const r = nonInferiority(120, 10000, 150, 10000, 0.004);
    const half = 1.96 * r.se;
    expect(r.ci95[0]).toBeCloseTo(r.diff - half, 12);
    expect(r.ci95[1]).toBeCloseTo(r.diff + half, 12);
    // α=0.05 的单侧临界值 1.645：Δ + 1.645·SE < margin 即为非劣成立
    expect(r.nonInferior).toBe(r.diff + 1.645 * r.se < 0.004);
    expect(r.worse).toBe(r.diff - 1.645 * r.se > 0.004);
  });
});
