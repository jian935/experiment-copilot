/**
 * 新颖效应 / 效应衰减检测（A7）。
 *
 * 要回答的问题：7 天趋势里「前 3 天 +2pp、后 4 天归零」，引擎能不能自己看出来。
 * 这是真分析师每天在问的事，也是「上线后第 5 天开始打脸」的根本原因；
 * 而所有结论都看累计值——累计会把衰减平均掉，于是「有效」这个结论永远成立。
 *
 * 主判定：按**曝光量**把观察期对半切（不是按日历天数等分，某天没跑量时按日历切
 * 会让两段样本严重失衡），两段各自重新估一次差值，再检验「后半 − 前半」= 0。
 * 两段数据互不重叠 → 增量独立，也不需要假设任何衰减形状。
 * 辅助：把每天的差值对天序号做 WLS，斜率描述「每天衰减多少」（只作描述）。
 *
 * ── 为什么 SE 不用「两段各自的标准误相加」 ───────────────────────────────
 * 直觉做法是 seDelta = √(se₁²+se₂²)，其中 se 是该段的重估标准误。实测下来它是错的：
 * 在 1000 个 A/A 实验（真效应恒为 0）上，这样算出来的「前后半段差异」误报率是
 * **12.0%（率指标）/ 15.0%（ARPU）**，而不是 5%。原因是半段只有 3–4 天、
 * 16 个格子，任何「当天 SE」「格子级稳健 SE」都严重低估日间波动——
 * 日与日之间本来就有整天的基线漂移、投放结构变化，这些不会进当天的二项方差。
 *
 * 所以这里改用**日级聚类**（day as the unit of analysis）：
 *   - 点估计：日效应按精度加权（样本少的日不该和样本多的日等权）
 *   - 方差：日效应的**无偏样本方差** / 天数（不依赖各日 SE 准不准——那正是失准之处）
 *   - 参考分布：Welch–Satterthwaite 自由度下的 t（7 天时 ν≈4–5，临界值约 2.7 而不是 1.96）
 * 同一套 A/A 上误报率落到 **4.8% / 6.4%**，代价是真能检出的最小衰减变大
 * （见 NoveltyReport.detectableDelta，UI 会直接告诉用户「这个样本量只够检出 ≥X」）。
 *
 * 纪律：这块是**检测器**，不参与 decision。
 * 真值标签（trueDecision）按频率派主指标 + 护栏口径标注，一旦让衰减改变 decision，
 * 历史 120 条标注全部作废——那是改口径迁就引擎。所以它和 heterogeneity 一样，
 * 只出报告、出证据，让评审自己看。
 *
 * 分段估计**必须互不重叠**（每天一段）。把累计值传进来会低估 SE、把一切都判成衰减。
 */

import { normalCdf, studentTInv, studentTTwoSided } from './stats.ts';

export interface DayEffect {
  /** 第几天（1-based） */
  day: number;
  date: string;
  nPerArm: number;
  /** 该段的效应（**当段独立**估计，不是累计值） */
  diff: number;
  se: number;
}

export interface HalfEstimate {
  /** 日效应的精度加权均值 */
  diff: number;
  /** 日级聚类标准误：√(日效应样本方差 / 天数) */
  se: number;
  days: number;
  /** 该半段日效应的无偏样本方差（聚类 SE 的分子，也用来判断"日间抖动有多大"） */
  dayVar: number;
}

export interface NoveltyPoint extends DayEffect {
  /** 该段曝光占全期比例 */
  share: number;
  /** 该段效应是否显著（95%，仅描述单日，不用于主判定） */
  sig: boolean;
  /** 属于前半段（true）还是后半段 */
  half: 'early' | 'late';
}

export type NoveltyPattern = 'decay' | 'growth' | 'stable' | 'insufficient';

export interface NoveltyReport {
  pattern: NoveltyPattern;
  early: HalfEstimate;
  late: HalfEstimate;
  /** 后半 − 前半 */
  delta: number;
  /** 相对变化（delta / |前半效应|）；前半效应≈0 时为 null（此时说"衰减了 x%"没有意义） */
  relativeDelta: number | null;
  seDelta: number;
  /** t 统计量（长这样叫是因为参考分布是 t，不是正态） */
  t: number;
  /** Welch–Satterthwaite 自由度：日数少，这个数直接决定临界值有多宽 */
  df: number;
  /** 前后半段差异检验的 p（主判定，t 双尾） */
  p: number;
  alpha: number;
  /** 这个样本量在 80% 功效下能检出的最小衰减幅度（|δ|）；检不出不等于没有衰减 */
  detectableDelta: number;
  points: NoveltyPoint[];
  /** 加权回归斜率（每天变化多少效应） */
  slope: number | null;
  slopeP: number | null;
  /** 过离散修正因子（≥1）；>1 说明逐日效应比噪声更散，斜率的 p 已被相应放宽 */
  dispersion: number | null;
  skipped?: string;
}

export interface SplitPlan {
  earlyDays: number[];
  lateDays: number[];
  cutDay: number;
  totalN: number;
}

/**
 * 按曝光量对半切，返回两段各含哪些天。
 * 切点定义：累计曝光首次 ≥ 50% 的那一天归前半段（于是前半段通常略多于半天）。
 */
export function planExposureSplit(points: DayEffect[]): SplitPlan | null {
  const usable = points.filter((p) => p.se > 0 && Number.isFinite(p.se) && Number.isFinite(p.diff) && p.nPerArm > 0);
  if (usable.length < 2) return null;
  const totalN = usable.reduce((s, p) => s + p.nPerArm, 0);
  if (!(totalN > 0)) return null;
  let acc = 0;
  let cut = 0;
  for (let i = 0; i < usable.length; i++) {
    acc += usable[i].nPerArm;
    if (acc >= totalN / 2) {
      cut = i;
      break;
    }
  }
  const earlyDays = usable.slice(0, cut + 1).map((p) => p.day);
  const lateDays = usable.slice(cut + 1).map((p) => p.day);
  if (earlyDays.length === 0 || lateDays.length === 0) return null;
  return { earlyDays, lateDays, cutDay: usable[cut].day, totalN };
}

/**
 * 半段估计：精度加权点估计 + 日级聚类标准误。
 * 至少需要 2 天（1 天估不出日间方差）。样本量/方差都不合法的天直接丢掉。
 */
export function segmentStats(points: DayEffect[], days: number[]): HalfEstimate | null {
  const list = points.filter((p) => days.includes(p.day) && p.se > 0 && Number.isFinite(p.se) && Number.isFinite(p.diff));
  const k = list.length;
  if (k < 2) return null;
  let sw = 0;
  let swd = 0;
  for (const p of list) {
    const w = 1 / (p.se * p.se);
    sw += w;
    swd += w * p.diff;
  }
  const mean = list.reduce((s, p) => s + p.diff, 0) / k;
  const dayVar = list.reduce((s, p) => s + (p.diff - mean) ** 2, 0) / (k - 1);
  // 日间方差为 0（每天都一模一样）是估计量的退化，不是真的零方差——
  // 此时退回「单日抽样方差按精度合成」的那档（1/Σw），否则会读成
  // "这个半段的效应已知到小数点后无限位"。不在这里加统一的 max 下限：
  // dayVar 是无偏的，加了 max 反而让 seDelta 系统性偏大 ~30%（实测 A/A 上 sd(t)=0.88）。
  const varOfMean = dayVar > 0 ? dayVar / k : 1 / sw;
  return { diff: swd / sw, se: Math.sqrt(varOfMean), days: k, dayVar };
}

export interface NoveltyInput {
  /** 逐日（互不重叠）的分段估计 */
  points: DayEffect[];
  alpha?: number;
  /** 逐日效应最少几个点才拟合斜率（默认 4） */
  minPointsForSlope?: number;
}

export function noveltyReport(input: NoveltyInput): NoveltyReport {
  const alpha = input.alpha ?? 0.05;
  const minPts = input.minPointsForSlope ?? 4;
  const { points } = input;

  const zero: HalfEstimate = { diff: 0, se: 0, days: 0, dayVar: 0 };
  const empty = (skipped: string): NoveltyReport => ({
    pattern: 'insufficient',
    early: zero,
    late: zero,
    delta: 0,
    relativeDelta: null,
    seDelta: 0,
    t: 0,
    df: 0,
    p: 1,
    alpha,
    detectableDelta: Number.POSITIVE_INFINITY,
    points: [],
    slope: null,
    slopeP: null,
    dispersion: null,
    skipped,
  });

  if (points.length < 3) return empty('不足 3 天的分段数据，谈不上前后半段对比');

  const split = planExposureSplit(points);
  if (!split) return empty('按曝光量切分失败（某段曝光为 0）');
  const early = segmentStats(points, split.earlyDays);
  const late = segmentStats(points, split.lateDays);
  if (!early || !late) {
    return empty(
      `有一半不足 2 天（前半 ${split.earlyDays.length} 天 / 后半 ${split.lateDays.length} 天），估不出日间方差`,
    );
  }

  const totalN = points.reduce((s, p) => s + p.nPerArm, 0);
  const scored: NoveltyPoint[] = points.map((p) => ({
    ...p,
    share: totalN > 0 ? p.nPerArm / totalN : 0,
    sig: p.se > 0 && Math.abs(p.diff / p.se) >= 1.96,
    half: p.day <= split.cutDay ? 'early' : 'late',
  }));

  const delta = late.diff - early.diff;
  const varE = early.se * early.se;
  const varL = late.se * late.se;
  const seDelta = Math.sqrt(varE + varL);
  // Welch–Satterthwaite：两段各有 3–4 天，方差估计本身很粗，必须按 t 而不是正态判
  const df =
    seDelta > 0 ? (seDelta ** 4) / (varE ** 2 / (early.days - 1) + varL ** 2 / (late.days - 1)) : 0;
  const t = seDelta > 0 ? delta / seDelta : 0;
  const p = df > 0 ? studentTTwoSided(t, df) : 1;
  // 80% 功效下能检出的最小 |δ|：给「判 stable」配一句"不是说没衰减，是看不出这么小的"
  const detectableDelta =
    df > 0 && seDelta > 0 ? (studentTInv(1 - alpha / 2, df) + studentTInv(0.8, df)) * seDelta : Number.POSITIVE_INFINITY;

  // 逐日加权回归：斜率 = 每天变化多少
  let slope: number | null = null;
  let slopeP: number | null = null;
  let dispersion: number | null = null;
  const fitPts = scored.filter((d) => d.se > 0);
  if (fitPts.length >= minPts) {
    const w = fitPts.map((d) => 1 / (d.se * d.se));
    const sw = w.reduce((a, b) => a + b, 0);
    const xbar = fitPts.reduce((s, d, i) => s + (w[i] * d.day) / sw, 0);
    const ybar = fitPts.reduce((s, d, i) => s + (w[i] * d.diff) / sw, 0);
    const sxx = fitPts.reduce((s, d, i) => s + w[i] * (d.day - xbar) ** 2, 0);
    const sxy = fitPts.reduce((s, d, i) => s + w[i] * (d.day - xbar) * (d.diff - ybar), 0);
    if (sxx > 0) {
      const b = sxy / sxx;
      const a = ybar - b * xbar;
      const chi2 = fitPts.reduce((s, d, i) => s + w[i] * (d.diff - (a + b * d.day)) ** 2, 0);
      const dfe = Math.max(1, fitPts.length - 2);
      // φ = max(1, χ²/df)：残差比噪声更散时才放大 SE，绝不把 p 往小里改
      dispersion = Math.max(1, chi2 / dfe);
      const seSlope = Math.sqrt(dispersion / sxx);
      slope = b;
      slopeP = seSlope > 0 ? 2 * (1 - normalCdf(Math.abs(b / seSlope))) : 1;
    }
  }

  const pattern: NoveltyPattern = p < alpha ? (delta < 0 ? 'decay' : 'growth') : 'stable';

  return {
    pattern,
    early,
    late,
    delta,
    relativeDelta: Math.abs(early.diff) > 1e-12 ? delta / Math.abs(early.diff) : null,
    seDelta,
    t,
    df,
    p,
    alpha,
    detectableDelta,
    points: scored,
    slope,
    slopeP,
    dispersion,
  };
}
