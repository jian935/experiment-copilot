/**
 * 确定性统计引擎（零依赖）
 * 原则：LLM 不算数，所有统计量都从这里来；每个函数都要有单测。
 */

/** Numerical Recipes erfc，相对误差 ~1.2e-7，支持大 |x|（不会因 1-Φ 掉精度） */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;
  const cof = [
    -1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2,
    -9.561514786808631e-3, -9.46595344482036e-4, 3.66839497852761e-4,
    4.2523324806907e-5, -2.0278578112534e-5, -1.624290004647e-6,
    1.30365583558e-6, 1.5626441722e-8, -8.5238095915e-8,
    6.529054439e-9, 5.059343495e-9, -9.91364156e-10, -2.27365122e-10,
    9.6467911e-11, 2.394038e-12, -6.886027e-12, 8.94487e-13,
    3.13092e-13, -1.12708e-13, 3.81e-16, 7.106e-15,
  ];
  let d = 0, dd = 0;
  for (let j = cof.length - 1; j >= 1; j--) {
    const tmp = d;
    d = ty * d - dd + cof[j];
    dd = tmp;
  }
  const ans = t * Math.exp(-z * z + 0.5 * (cof[0] + ty * d) - dd);
  return x >= 0 ? ans : 2 - ans;
}

export function normalCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2);
}

/** 双侧 p 值（数值稳定版） */
export function twoSidedP(z: number): number {
  return erfc(Math.abs(z) / Math.SQRT2);
}

/** Acklam 正态分位数 */
export function normalInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425, phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** 卡方 df=1 的上尾概率 */
export function chi2Sf1(x: number): number {
  return erfc(Math.sqrt(Math.max(0, x) / 2));
}

export interface PropTest {
  controlRate: number;
  treatmentRate: number;
  diff: number; // treatment - control（绝对提升）
  relativeLift: number; // diff / controlRate
  z: number;
  p: number;
  ci95: [number, number]; // 差值 95% CI（Newcombe）
  n1: number;
  n2: number;
  c1: number;
  c2: number;
}

export function wilson(p: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 1];
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** Newcombe method 10：两比例差值的置信区间 */
export function newcombeDiffCI(c1: number, n1: number, c2: number, n2: number, z = 1.96): [number, number] {
  const p1 = n1 > 0 ? c1 / n1 : 0;
  const p2 = n2 > 0 ? c2 / n2 : 0;
  const [l1, u1] = wilson(p1, n1, z);
  const [l2, u2] = wilson(p2, n2, z);
  const d = p2 - p1;
  return [
    d - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2),
    d + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2),
  ];
}

export function twoProportionZ(c1: number, n1: number, c2: number, n2: number): PropTest {
  const p1 = n1 > 0 ? c1 / n1 : 0;
  const p2 = n2 > 0 ? c2 / n2 : 0;
  const pooled = n1 + n2 > 0 ? (c1 + c2) / (n1 + n2) : 0;
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  const z = se > 0 ? (p2 - p1) / se : 0;
  return {
    controlRate: p1,
    treatmentRate: p2,
    diff: p2 - p1,
    relativeLift: p1 > 0 ? (p2 - p1) / p1 : 0,
    z,
    p: twoSidedP(z),
    ci95: newcombeDiffCI(c1, n1, c2, n2),
    n1, n2, c1, c2,
  };
}

export interface SrmResult {
  chi2: number;
  p: number;
  relImb: number; // max |obs-exp|/exp
  flagged: boolean;
  expected: number[];
  counts: number[];
}

/**
 * SRM：p<0.001 且 相对偏差>2% 才判异常。
 * 只用一个 p 值，在 5–6 万样本下 1.6% 的不均衡也会报错，属于过度报警。
 */
export function srmChi2(counts: number[], ratios?: number[], alpha = 0.001, maxRel = 0.02): SrmResult {
  const N = counts.reduce((a, b) => a + b, 0);
  const k = counts.length;
  const rs = ratios && ratios.length === k ? ratios : new Array(k).fill(1 / k);
  const expected = rs.map((r) => r * N);
  let chi2 = 0;
  let relImb = 0;
  for (let i = 0; i < k; i++) {
    if (expected[i] <= 0) continue;
    chi2 += ((counts[i] - expected[i]) ** 2) / expected[i];
    relImb = Math.max(relImb, Math.abs(counts[i] - expected[i]) / expected[i]);
  }
  const p = chi2Sf1(chi2);
  return { chi2, p, relImb, flagged: p < alpha && relImb > maxRel, expected, counts };
}

export interface BhResult {
  qvals: number[];
  rejected: boolean[];
}

/** Benjamini–Hochberg FDR */
export function bhAdjust(pvals: number[], q = 0.1): BhResult {
  const m = pvals.length;
  const order = pvals.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const qvals = new Array(m).fill(1);
  let prev = 1;
  for (let rank = m; rank >= 1; rank--) {
    const { p, i } = order[rank - 1];
    const v = Math.min(prev, (p * m) / rank);
    qvals[i] = v;
    prev = v;
  }
  return { qvals, rejected: qvals.map((v) => v <= q) };
}

export function powerTwoProportion(p1: number, p2: number, nPerArm: number, alpha = 0.05): number {
  const za = normalInv(1 - alpha / 2);
  const se = Math.sqrt((p1 * (1 - p1)) / nPerArm + (p2 * (1 - p2)) / nPerArm);
  if (!(se > 0)) return 1;
  const z = Math.abs(p2 - p1) / se;
  return normalCdf(z - za) + normalCdf(-z - za);
}

export function mdeTwoProportion(p: number, nPerArm: number, alpha = 0.05, power = 0.8): number {
  const za = normalInv(1 - alpha / 2);
  const zb = normalInv(power);
  return (za + zb) * Math.sqrt((2 * p * (1 - p)) / nPerArm);
}

/** Welch t（大样本下用正态近似；v1 仅用于连续指标展示，不参与决策） */
export function welchTest(m1: number, s1: number, n1: number, m2: number, s2: number, n2: number) {
  const se = Math.sqrt((s1 * s1) / n1 + (s2 * s2) / n2);
  const t = se > 0 ? (m2 - m1) / se : 0;
  const num = (s1 * s1 / n1 + s2 * s2 / n2) ** 2;
  const den = (s1 ** 4) / (n1 * n1 * (n1 - 1)) + (s2 ** 4) / (n2 * n2 * (n2 - 1));
  const df = den > 0 ? num / den : n1 + n2 - 2;
  return { t, df, p: twoSidedP(t) };
}
