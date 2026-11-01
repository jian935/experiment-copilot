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

// ===================== 贝叶斯层（Beta-Binomial） =====================
// 频率派之外，给出「treatment 真比 control 好」的后验概率与可信区间。
// 全部确定性（无随机），每个函数都有单测对齐权威实现（Beta CDF 闭式 betai）。
// P(B>A) 用正态近似：两 Beta 后验之差在大样本下收敛到正态，且与下面的 95% 可信区间
// 同源（均来自后验差的均值/方差），避免对极陡的 Beta CDF 台阶做数值积分时漏掉分辨率。

/** Lanczos 近似 ln Γ(x)（相对误差 ~1e-14） */
export function lgamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** 正则化不完全 Beta 函数 I_x(a,b)（Numerical Recipes betai） */
export function betai(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(x, a, b)) / a;
  return 1 - (bt * betacf(1 - x, b, a)) / b;
}

/** 不完全 Beta 连分式（Lentz 法，Numerical Recipes betacf） */
function betacf(x: number, a: number, b: number): number {
  const MAXIT = 300;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

export interface BayesResult {
  /** P(treatment 转化率 > control 转化率)：把两变体当作 Beta 后验，对「谁更大」做积分 */
  probTreatBetter: number;
  /** 后验期望差值（treatment − control，比例单位） */
  meanDiff: number;
  /** 差值 95% 可信区间（比例单位；正态近似后验差） */
  credLow: number;
  credHigh: number;
  /** 期望损失（若误判上线，treatment 实际更差时的平均损失，比例单位） */
  expectedLoss: number;
}

/**
 * Beta-Binomial 贝叶斯：以 Beta(成功+1, 失败+1) 为后验，给频率派结论配一个概率口径。
 *
 * dispersion（过离散因子，≥1）会把样本量折算成「有效样本量」n/φ、c/φ：
 * 均值不变，但后验变宽 φ 倍。不做这一步的话，只要数据存在格子级基线漂移，
 * 后验就会系统性过度自信——实测 A/A 下 P(B>A)>0.95 的比例会到 9.5%（理论 5%）。
 */
export function bayesBetaBinomial(
  c1: number, n1: number,
  c2: number, n2: number,
  dispersion = 1,
): BayesResult {
  const overdisp = Number.isFinite(dispersion) && dispersion > 1 ? dispersion : 1;
  // treatment 后验 Beta(a, b)，control 后验 Beta(cc, d)（用有效样本量）
  const a = c2 / overdisp + 1;
  const b = (n2 - c2) / overdisp + 1;
  const cc = c1 / overdisp + 1;
  const d = (n1 - c1) / overdisp + 1;

  const mt = a / (a + b);
  const mc = cc / (cc + d);
  const vt = (mt * (1 - mt)) / (a + b + 1);
  const vc = (mc * (1 - mc)) / (cc + d + 1);
  const meanDiff = mt - mc;
  const varDiff = vt + vc;
  const sd = Math.sqrt(Math.max(varDiff, 0));

  const credLow = meanDiff - 1.96 * sd;
  const credHigh = meanDiff + 1.96 * sd;

  // P(B>A)：两 Beta 后验之差 Δ 在 n 大时收敛到 N(meanDiff, varDiff)，
  // 于是 P(B>A)=P(Δ>0)=Φ(meanDiff/sd)。与下方 95% 可信区间同源，数值稳定。
  const probTreatBetter = sd > 0 ? normalCdf(meanDiff / sd) : 0.5;

  // 期望损失 E[max(0, control − treatment)]：后验差 Δ~N(meanDiff, varDiff)
  const z = sd > 0 ? meanDiff / sd : 0;
  const phi = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const expectedLoss = sd * phi - meanDiff * normalCdf(-z);

  return { probTreatBetter, meanDiff, credLow, credHigh, expectedLoss };
}

// ===================== 非劣检验（护栏的正式统计口径） =====================
// 护栏不该是「差值 > 0.4pp 且 p < 0.01」这种拍脑袋阈值，而是一次非劣检验：
// 先声明「最多能容忍多少恶化」（margin），再用单侧检验判断恶化有没有超过它。
// 这样被追问「凭什么是 0.4pp」时，答的是业务容忍度，而不是统计默认值。

export interface NonInferiorityResult {
  controlRate: number;
  treatmentRate: number;
  /** treatment − control（该指标方向；对护栏指标来说正 = 恶化） */
  diff: number;
  /** 允许的最大恶化（绝对比例单位） */
  margin: number;
  /** 非合并标准误（非劣检验的标准做法） */
  se: number;
  /** 95% 置信区间（非合并方差） */
  ci95: [number, number];
  /** H0「恶化 ≥ margin」的单侧 p；p 小 → 有把握恶化仍在容忍度内（非劣成立） */
  pNonInferior: number;
  /** H0「恶化 ≤ margin」的单侧 p；p 小 → 确认恶化已超过容忍度 */
  pWorse: number;
  /** 非劣成立（有把握恶化仍在 margin 之内） */
  nonInferior: boolean;
  /** 确认恶化超过 margin（最严的一种判定） */
  worse: boolean;
  /** 「有任何恶化」的单侧 p（H0: Δ ≤ 0），与 margin 无关 */
  pHarm: number;
  /** 恶化在统计上显著（pHarm < α） */
  harmSignificant: boolean;
  /** 恶化达到实际显著性（Δ > margin） */
  practical: boolean;
  /**
   * 想让「确认恶化超 margin」成立，观测差值至少要这么大 = margin + z₁₋α·SE。
   * 这是护栏设计里最容易被忽略的一条：margin 一旦小于 SE 的量级，
   * "确认恶化超过 margin" 就会因为要求过高而漏掉真实伤害。
   */
  detectableDelta: number;
  /** 当前样本量下 margin 至少要多大才有意义（= z₁₋α·SE） */
  minDetectableMargin: number;
  verdict: 'non_inferior' | 'worse' | 'inconclusive';
}

/** 护栏的三种正式判定口径（都基于同一次非劣/单侧检验，只是触发条件不同） */
export type GuardrailMode =
  /** 只要"统计上确有恶化"且"恶化达到 margin"就拦（统计显著性 ∧ 实际显著性） */
  | 'harm_and_practical'
  /** 必须"确认恶化已超过 margin"才拦（最严，要求 margin + z·SE 都被跨过） */
  | 'confirm_beyond_margin'
  /** 非劣不成立就拦（最保守：拿不出"损害在容忍度内"的证据就不许上线） */
  | 'non_inferiority';

/** 按模式给出"该不该拦" */
export function guardrailBlocks(ni: NonInferiorityResult, mode: GuardrailMode): boolean {
  if (mode === 'non_inferiority') return !ni.nonInferior;
  if (mode === 'confirm_beyond_margin') return ni.worse;
  return ni.harmSignificant && ni.practical;
}

/**
 * 两比例非劣检验（护栏口径：Δ 越大越差，margin = 可容忍的最大恶化）。
 *
 * 两个方向都用同一个单侧临界值 z_{1−α}，共用非合并方差：
 * - 确认恶化：H0「Δ ≤ margin」，z = (Δ − margin)/SE，p = 1 − Φ(z)；p < α → 恶化已超容忍度。
 * - 非劣成立：H0「Δ ≥ margin」，z = (margin − Δ)/SE，p = 1 − Φ(z)；p < α → 有把握恶化在容忍度内。
 *
 * 两者互斥（α<0.5 时不可能同时成立），且允许都不成立——那就是 inconclusive：
 * 既没证据说它坏透了，也没把握说它没问题。护栏只在第一种情况下拦截。
 */
export function nonInferiority(
  c1: number, n1: number,
  c2: number, n2: number,
  margin: number,
  alpha = 0.05,
): NonInferiorityResult {
  const p1 = n1 > 0 ? c1 / n1 : 0;
  const p2 = n2 > 0 ? c2 / n2 : 0;
  const diff = p2 - p1;
  const se = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);

  const zWo = se > 0 ? (diff - margin) / se : diff > margin ? Infinity : -Infinity;
  const zNi = se > 0 ? (margin - diff) / se : diff < margin ? Infinity : -Infinity;
  const pWorse = Number.isFinite(zWo) ? 1 - normalCdf(zWo) : zWo > 0 ? 0 : 1;
  const pNonInferior = Number.isFinite(zNi) ? 1 - normalCdf(zNi) : zNi > 0 ? 0 : 1;

  const halfWidth = 1.96 * se;
  const worse = pWorse < alpha;
  const nonInferior = pNonInferior < alpha;
  const zCrit = normalInv(1 - alpha);
  const pHarm = se > 0 ? 1 - normalCdf(diff / se) : diff > 0 ? 0 : 1;
  return {
    controlRate: p1,
    treatmentRate: p2,
    diff,
    margin,
    se,
    ci95: [diff - halfWidth, diff + halfWidth],
    pNonInferior,
    pWorse,
    nonInferior,
    worse,
    pHarm,
    harmSignificant: pHarm < alpha,
    practical: diff > margin,
    detectableDelta: margin + zCrit * se,
    minDetectableMargin: zCrit * se,
    // 「确认恶化」优先于「非劣成立」：区间整体落在 margin 之上时，结论是恶化而非非劣
    verdict: worse ? 'worse' : nonInferior ? 'non_inferior' : 'inconclusive',
  };
}

// ===================== t 分布（精确，用已有的 betai） =====================

/**
 * Student-t 上尾概率 P(T > t)，用不完全 Beta 精确计算：
 *   P(T > t) = ½ · I_{ν/(ν+t²)}(ν/2, ½)
 * 以前项目里 Welch 检验拿正态近似顶替，df 小的时候会偏乐观；现在有闭式就用闭式。
 */
export function studentTSf(t: number, df: number): number {
  if (!(df > 0)) return twoSidedP(t) / 2;
  const x = df / (df + t * t);
  const half = 0.5 * betai(x, df / 2, 0.5);
  return t > 0 ? half : 1 - half;
}

/** 双侧 t 检验 p 值 */
export function studentTTwoSided(t: number, df: number): number {
  return Math.min(1, 2 * studentTSf(Math.abs(t), df));
}

// ===================== CUPED（方差缩减） =====================

export interface CupedCell {
  /** 后周期样本量（同时作为权重） */
  n: number;
  /** 后周期转化数 */
  c: number;
  /** 前周期样本量 */
  nPre: number;
  /** 前周期转化数 */
  cPre: number;
  treatment: boolean;
}

export interface CupedResult {
  /** CUPED 系数 θ = Cov(X,Y)/Var(X)（按臂内中心化、按样本量加权后合并） */
  theta: number;
  /** 前后周期的相关系数 ρ（臂内、加权） */
  rho: number;
  /** 未调整的差值（treatment − control） */
  diffRaw: number;
  /** CUPED 调整后的差值 */
  diffAdj: number;
  /** 未调整的标准误（格子级稳健估计，含过离散） */
  seRaw: number;
  /** 调整后的标准误 */
  seAdj: number;
  /** 方差缩减比例 = 1 − seAdj²/seRaw² */
  varReduction: number;
  /** 等同样本量下"省了多少样本"：达到同样精度需要的样本量下降比例 */
  sampleSaving: number;
  /** 格子的过离散因子 φ（1 = 纯二项；>1 说明朴素 i.i.d. 标准误偏乐观） */
  dispersion: number;
  /** 自由度（格子数 − 参数数） */
  df: number;
  zRaw: number;
  zAdj: number;
  pRaw: number;
  pAdj: number;
  ciRaw: [number, number];
  ciAdj: [number, number];
  nCells: number;
}

/**
 * 格子均值的稳健方差（比率估计量形式）。
 *
 * 为什么不能直接套 p(1−p)/n：真实数据里每个格子的基线会漂（用户构成、当天的整体水位），
 * 于是格子率的方差比纯二项更大（过离散）。这一式直接从格子间的离散程度估方差，
 * 不假设 i.i.d.——朴素二项式标准误在过离散下会系统性偏乐观（实测会把 A/A 误报率推到 11%）。
 */
function clusterMeanVar(vals: number[], ws: number[], dofLoss: number): { mean: number; varr: number } {
  const K = vals.length;
  const W = ws.reduce((s, v) => s + v, 0);
  if (K === 0 || W <= 0) return { mean: 0, varr: 0 };
  let mean = 0;
  for (let i = 0; i < K; i++) mean += ws[i] * vals[i];
  mean /= W;
  let ss = 0;
  for (let i = 0; i < K; i++) ss += ws[i] * ws[i] * (vals[i] - mean) ** 2;
  const df = Math.max(1, K - dofLoss);
  // K/(K−1) 是无偏修正；除以 df 而不是 K 是为了扣掉估计均值/θ 花掉的自由度
  return { mean, varr: (ss * K) / (K - 1) / (W * W) };
}

/**
 * CUPED（Controlled-experiment Using Pre-Experiment Data）。
 *
 * 做法：把每个「日期 × 设备 × 新老 × 变体」当作一个格子，
 *   - Y = 该格子实验期转化率，X = 同一批人在实验前的同口径转化率；
 *   - θ = 臂内中心化后的加权 Cov(X,Y)/Var(X)；
 *   - 调整后的差值 = (ȳ_t − ȳ_c) − θ(x̄_t − x̄_c)。
 * 因为随机分流下 E[x̄_t − x̄_c] = 0，调整后的点估计仍然无偏，
 * 但把"这批人本来就活跃/不活跃"这部分方差扣掉了，于是区间更窄。
 *
 * 关键：**标准误不用 p(1−p)/n，而是从格子间离散程度直接估**（见 clusterMeanVar）。
 * 否则在过离散数据上，CUPED 带来的"精度提升"会是假的——区间变窄只是因为假设错了。
 */
export function cupedAdjust(cells: CupedCell[]): CupedResult | null {
  const use = cells.filter((x) => x.n > 0 && x.nPre > 0);
  // 每组至少要有 4 个格子，否则稳健方差的分母太小，估出来的 SE 不可信
  if (use.length < 8) return null;
  const nT = use.filter((x) => x.treatment).length;
  const nC = use.length - nT;
  if (nT < 4 || nC < 4) return null;

  const y = use.map((x) => x.c / x.n);
  const x = use.map((x) => x.cPre / x.nPre);
  const w = use.map((x) => x.n);

  // ---- θ：臂内中心化后合并（避免把组间差异当成协变量的作用）----
  const meanW = (vals: number[], ws: number[]) => {
    let s = 0;
    let W = 0;
    for (let i = 0; i < vals.length; i++) {
      s += ws[i] * vals[i];
      W += ws[i];
    }
    return W > 0 ? s / W : 0;
  };
  const yT = meanW(y.filter((_, i) => use[i].treatment), w.filter((_, i) => use[i].treatment));
  const yC = meanW(y.filter((_, i) => !use[i].treatment), w.filter((_, i) => !use[i].treatment));
  const xT = meanW(x.filter((_, i) => use[i].treatment), w.filter((_, i) => use[i].treatment));
  const xC = meanW(x.filter((_, i) => !use[i].treatment), w.filter((_, i) => !use[i].treatment));

  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < use.length; i++) {
    const dx = x[i] - (use[i].treatment ? xT : xC);
    const dy = y[i] - (use[i].treatment ? yT : yC);
    sxy += w[i] * dx * dy;
    sxx += w[i] * dx * dx;
    syy += w[i] * dy * dy;
  }
  const theta = sxx > 0 ? sxy / sxx : 0;
  const rho = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;

  const diffRaw = yT - yC;
  const diffAdj = diffRaw - theta * (xT - xC);

  // ---- 稳健标准误：分别对原始值与调整后的值做格子级方差 ----
  const rawT = clusterMeanVar(y.filter((_, i) => use[i].treatment), w.filter((_, i) => use[i].treatment), 1);
  const rawC = clusterMeanVar(y.filter((_, i) => !use[i].treatment), w.filter((_, i) => !use[i].treatment), 1);
  const z = y.map((v, i) => v - theta * x[i]);
  const adjT = clusterMeanVar(z.filter((_, i) => use[i].treatment), w.filter((_, i) => use[i].treatment), 2);
  const adjC = clusterMeanVar(z.filter((_, i) => !use[i].treatment), w.filter((_, i) => !use[i].treatment), 2);

  const seRaw = Math.sqrt(Math.max(0, rawT.varr + rawC.varr));
  const seAdj = Math.sqrt(Math.max(0, adjT.varr + adjC.varr));

  // 过离散因子：格子率的加权离散度 ÷ 二项期望方差
  let chi = 0;
  const pAll = use.reduce((s, v) => s + v.c, 0) / use.reduce((s, v) => s + v.n, 0);
  for (let i = 0; i < use.length; i++) {
    const pArm = use[i].treatment ? yT : yC;
    const varr = pArm * (1 - pArm);
    if (varr > 0) chi += ((y[i] - pArm) ** 2) * use[i].n / varr;
  }
  const dispersion = chi / Math.max(1, use.length - 2);

  const df = Math.max(1, use.length - 3);
  const zRaw = seRaw > 0 ? diffRaw / seRaw : 0;
  const zAdj = seAdj > 0 ? diffAdj / seAdj : 0;
  const tCrit = Math.abs(normalInv(0.975));
  return {
    theta,
    rho,
    diffRaw,
    diffAdj,
    seRaw,
    seAdj,
    varReduction: seRaw > 0 ? Math.max(0, 1 - (seAdj * seAdj) / (seRaw * seRaw)) : 0,
    sampleSaving: seRaw > 0 && seAdj > 0 ? Math.max(0, 1 - (seAdj * seAdj) / (seRaw * seRaw)) : 0,
    dispersion,
    df,
    zRaw,
    zAdj,
    pRaw: studentTTwoSided(zRaw, df),
    pAdj: studentTTwoSided(zAdj, df),
    ciRaw: [diffRaw - tCrit * seRaw, diffRaw + tCrit * seRaw],
    ciAdj: [diffAdj - tCrit * seAdj, diffAdj + tCrit * seAdj],
    nCells: use.length,
  };
}

// ===================== 蒙特卡洛（固定种子，完全可复现） =====================
// 用途：CI 覆盖率模拟、Bootstrap、A/A 自校准。所有随机数只走 mulberry32，
// 同种子逐位可复现，所以模拟结果可以写进文档当硬证据，而不是"跑一次看看"。

/** mulberry32：32 位确定性 PRNG，周期 2³²，分布均匀性足够做蒙特卡洛 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 二项抽样（逐次 Bernoulli，开销 O(n)；模拟里按需取 n） */
export function binomialSample(n: number, p: number, rng: () => number): number {
  if (!(n > 0) || p <= 0) return 0;
  if (p >= 1) return n;
  let c = 0;
  for (let i = 0; i < n; i++) if (rng() < p) c++;
  return c;
}

export interface CoverageResult {
  trials: number;
  /** 区间包含真值的比例（标称 0.95） */
  coverage: number;
  /** 覆盖率的标准误 √(p(1−p)/trials) */
  se: number;
  /** 平均区间宽度 */
  meanWidth: number;
  /** 命中次数，便于复算 */
  hits: number;
}

/** 两比例差值 CI（Newcombe）的覆盖率模拟 */
export function simulateDiffCiCoverage(opts: {
  p1: number;
  p2: number;
  nPerArm: number;
  trials?: number;
  seed?: number;
  z?: number;
}): CoverageResult {
  const { p1, p2, nPerArm, trials = 2000, seed = 20261101, z = 1.96 } = opts;
  const rng = mulberry32(seed);
  const trueDiff = p2 - p1;
  let hits = 0;
  let width = 0;
  for (let i = 0; i < trials; i++) {
    const c1 = binomialSample(nPerArm, p1, rng);
    const c2 = binomialSample(nPerArm, p2, rng);
    const [l, u] = newcombeDiffCI(c1, nPerArm, c2, nPerArm, z);
    if (l <= trueDiff && trueDiff <= u) hits++;
    width += u - l;
  }
  const coverage = hits / trials;
  return {
    trials,
    coverage,
    se: Math.sqrt((coverage * (1 - coverage)) / trials),
    meanWidth: width / trials,
    hits,
  };
}

/** 单比例 Wilson CI 的覆盖率模拟 */
export function simulateWilsonCoverage(opts: {
  p: number;
  n: number;
  trials?: number;
  seed?: number;
  z?: number;
}): CoverageResult {
  const { p, n, trials = 2000, seed = 20261102, z = 1.96 } = opts;
  const rng = mulberry32(seed);
  let hits = 0;
  let width = 0;
  for (let i = 0; i < trials; i++) {
    const c = binomialSample(n, p, rng);
    const [l, u] = wilson(n > 0 ? c / n : 0, n, z);
    if (l <= p && p <= u) hits++;
    width += u - l;
  }
  const coverage = hits / trials;
  return {
    trials,
    coverage,
    se: Math.sqrt((coverage * (1 - coverage)) / trials),
    meanWidth: width / trials,
    hits,
  };
}

// ===================== Bootstrap（固定种子，可复现） =====================
// 比值指标（人均订单数）、连续指标（ARPU）、分位数（P95）的稳健区间只能靠重抽样。
// 用百分位法（percentile），不做 BCa：BCa 需要 jackknife 加速常数，多一层实现风险，
// 而百分位法在本项目的用途（给区间、看宽度）上已经够用，且更好解释。

export type BootstrapMethod = 'bca' | 'percentile';

export interface BootstrapResult {
  /** 原始样本上的统计量 */
  estimate: number;
  ciLow: number;
  ciHigh: number;
  /** Bootstrap 分布的标准差，即标准误估计 */
  se: number;
  reps: number;
  alpha: number;
  /** 实际使用的方法：退化时会自动从 bca 回落成 percentile */
  method: BootstrapMethod;
  /** BCa 偏差校正 z₀；percentile 法下为 0 */
  z0: number;
  /** BCa 加速常数 a（jackknife 偏度）；percentile 法下为 0 */
  accel: number;
  /**
   * Bootstrap 百分位检验的 p 值：比例{θ* ≤ threshold}（仅传了 threshold 时给出）。
   * 不回传重抽样数组本身——那会把上万个数字带进 Analysis，既撑爆内存，
   * 也会污染 Agent 的数字白名单（白名单变宽 = 幻觉审查变松）。
   */
  pBelow?: number;
}

export interface BootstrapOptions {
  reps?: number;
  alpha?: number;
  seed?: number;
  method?: BootstrapMethod;
  /** 给 Bootstrap 百分位检验用的阈值：算出 P*(θ ≤ threshold) */
  threshold?: number;
}

const EMPTY_BOOT: BootstrapResult = {
  estimate: NaN, ciLow: NaN, ciHigh: NaN, se: NaN, reps: 0, alpha: 0.05, method: 'percentile', z0: 0, accel: 0,
};

/**
 * Bootstrap 单侧 p 值（百分位检验）：把重抽样分布当作抽样分布的估计，
 * H0「真值 ≤ threshold」的 p = 比例{θ* ≤ threshold}。p 小 → 有证据认为真值已超过 threshold。
 * 没有闭式检验的统计量（分位数、比值、P95）就用它。
 */
export function bootstrapP(values: number[], threshold: number): number {
  const n = values.length;
  if (n === 0) return 1;
  let below = 0;
  for (const v of values) if (v <= threshold) below++;
  return below / n;
}

/**
 * BCa（bias-corrected and accelerated）区间——旗舰统计库的默认做法。
 * 百分位法只做"照搬分位数"，BCa 额外修正两件事：
 *   1. z₀ 偏差校正：Bootstrap 分布相对点估计偏了多少；
 *   2. a 加速常数：统计量对样本扰动的敏感度随位置变化（由 jackknife 偏度给出）。
 * 所以偏态统计量（比值、分位数、P95）在区间形状上明显更准，不只是"能用"。
 * 退化条件（reps 太少 / jackknife 全等 / z₀ 或 a 非有限）自动回落百分位法，并在 method 里标明。
 */
function bcaSummary(
  estimate: number,
  vals: number[],
  reps: number,
  alpha: number,
  jack: number[] | null,
  wantBca: boolean,
  threshold?: number,
): BootstrapResult {
  const sorted = vals.slice().sort((x, y) => x - y);
  let mean = 0;
  for (const v of sorted) mean += v;
  mean /= reps;
  let ss = 0;
  for (const v of sorted) ss += (v - mean) ** 2;
  const se = reps > 1 ? Math.sqrt(ss / (reps - 1)) : NaN;

  const pct = (q: number) => quantileSorted(sorted, q);
  const base: BootstrapResult = {
    estimate,
    ciLow: pct(alpha / 2),
    ciHigh: pct(1 - alpha / 2),
    se,
    reps,
    alpha,
    method: 'percentile',
    z0: 0,
    accel: 0,
    ...(threshold === undefined ? {} : { pBelow: bootstrapP(sorted, threshold) }),
  };
  if (!wantBca || reps < 200 || !jack || jack.length < 3 || !Number.isFinite(se) || se === 0) return base;

  // ① 偏差校正 z₀ = Φ⁻¹( 比例{θ* < θ̂} )
  let below = 0;
  for (const v of sorted) if (v < estimate) below++;
  const prop = below / reps;
  if (prop <= 0 || prop >= 1) return base; // 点估计落在分布外，BCa 不适用
  const z0 = normalInv(prop);

  // ② 加速常数 a = Σ(θ̄₍.₎ − θ₍ᵢ₎)³ / 6[Σ(θ̄₍.₎ − θ₍ᵢ₎)²]^{3/2}
  let jm = 0;
  for (const v of jack) jm += v;
  jm /= jack.length;
  let num = 0;
  let den = 0;
  for (const v of jack) {
    num += (jm - v) ** 3;
    den += (jm - v) ** 2;
  }
  const accel = den > 0 ? num / (6 * Math.pow(den, 1.5)) : 0;
  if (!Number.isFinite(z0) || !Number.isFinite(accel)) return base;

  // ③ 校正后的两端分位点
  const zLo = normalInv(alpha / 2);
  const zHi = normalInv(1 - alpha / 2);
  const a1 = normalCdf(z0 + (z0 + zLo) / (1 - accel * (z0 + zLo)));
  const a2 = normalCdf(z0 + (z0 + zHi) / (1 - accel * (z0 + zHi)));
  if (!(a1 > 0 && a1 < 1) || !(a2 > 0 && a2 < 1)) return base;

  return {
    estimate,
    ciLow: pct(a1),
    ciHigh: pct(a2),
    se,
    reps,
    alpha,
    method: 'bca',
    z0,
    accel,
    ...(threshold === undefined ? {} : { pBelow: bootstrapP(sorted, threshold) }),
  };
}

/** 已排序数组的分位数（线性插值，R type-7） */
function quantileSorted(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const h = (n - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/** jackknife：逐次去掉一个观测后的统计量，用于 BCa 的加速常数 */
function jackknife(sample: number[], stat: (xs: number[]) => number): number[] | null {
  const n = sample.length;
  if (n < 3 || n > 300) return null; // O(n²)；n 大了不划算，直接回落百分位法
  const sub = new Array<number>(n - 1);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < i; k++) sub[k] = sample[k];
    for (let k = i + 1; k < n; k++) sub[k - 1] = sample[k];
    out[i] = stat(sub);
  }
  return out;
}

/** 单样本 Bootstrap 区间（默认 BCa）。stat 不得持有传入数组（每轮复用同一块缓冲） */
export function bootstrapCI(
  sample: number[],
  stat: (xs: number[]) => number,
  opts: BootstrapOptions = {},
): BootstrapResult {
  const { reps, alpha, rng } = bootOpts(opts);
  const n = sample.length;
  const estimate = n > 0 ? stat(sample) : NaN;
  if (n === 0 || reps <= 0) return { ...EMPTY_BOOT, estimate, reps, alpha };

  const buf = new Array<number>(n);
  const vals = new Array<number>(reps);
  for (let r = 0; r < reps; r++) {
    for (let i = 0; i < n; i++) buf[i] = sample[(rng() * n) | 0];
    vals[r] = stat(buf);
  }
  const wantBca = (opts.method ?? 'bca') === 'bca';
  return bcaSummary(
    estimate, vals, reps, alpha,
    wantBca ? jackknife(sample, stat) : null,
    wantBca,
    opts.threshold,
  );
}

/** 两样本 Bootstrap：两组独立重抽样，stat 取两组的函数（如差值、比值） */
export function bootstrapTwoSample(
  a: number[],
  b: number[],
  stat: (a: number[], b: number[]) => number,
  opts: BootstrapOptions = {},
): BootstrapResult {
  const { reps, alpha, rng } = bootOpts(opts);
  const na = a.length;
  const nb = b.length;
  const estimate = na > 0 && nb > 0 ? stat(a, b) : NaN;
  if (na === 0 || nb === 0 || reps <= 0) return { ...EMPTY_BOOT, estimate, reps, alpha };

  const ba = new Array<number>(na);
  const bb = new Array<number>(nb);
  const vals = new Array<number>(reps);
  for (let r = 0; r < reps; r++) {
    for (let i = 0; i < na; i++) ba[i] = a[(rng() * na) | 0];
    for (let i = 0; i < nb; i++) bb[i] = b[(rng() * nb) | 0];
    vals[r] = stat(ba, bb);
  }
  const wantBca = (opts.method ?? 'bca') === 'bca';
  // 两样本的 jackknife：对哪一组做都不对称，这里对两组都做、取合并后的加速常数
  let jack: number[] | null = null;
  if (wantBca) {
    const ja = jackknife(a, (x) => stat(x, b));
    const jb = jackknife(b, (x) => stat(a, x));
    if (ja && jb) jack = ja.concat(jb);
  }
  return bcaSummary(estimate, vals, reps, alpha, jack, wantBca, opts.threshold);
}

function bootOpts(opts: BootstrapOptions): { reps: number; alpha: number; rng: () => number } {
  return {
    reps: opts.reps ?? 10000,
    alpha: opts.alpha ?? 0.05,
    rng: mulberry32(opts.seed ?? 20261101),
  };
}

/** 分位数（线性插值，R type-7），给 P95 之类分位数指标的 Bootstrap 用 */
export function quantile(xs: number[], q: number): number {
  const n = xs.length;
  if (n === 0) return NaN;
  if (n === 1) return xs[0];
  return quantileSorted(xs.slice().sort((x, y) => x - y), q);
}
