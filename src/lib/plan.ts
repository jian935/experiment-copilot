/**
 * 实验前：样本量与可检出效应。
 *
 * 为什么这一层比「再多一个统计检验」重要：真实工作里 PM 在**开实验之前**就要回答
 * 「这个实验要跑多久」「我的流量够不够测出 1pp」。答不上来，实验就会在第 3 天被
 * 「看起来有效果」叫停——这正是 peeking 与误判的来源。app 里原本只有事后的
 * 「还要跑几天」（forecast），缺的正是事前这一步。
 *
 * 口径纪律：
 * - 样本量用**二分反解自己的功效函数**，而不是套一个近似公式。近似公式（Fleiss）
 *   与真实功效差 1–3%，两者并存就会出现「按公式算的 n 跑完却只有 78% 功效」。
 *   反解的好处是可验证：`power(n) ≈ 目标 power` 就是单测断言。
 * - 全部按**双侧**计算。单侧省 20% 样本，但业务上「变差也算结论」，没有理由只看一侧。
 * - ARPU 这类连续指标要 σ（标准差）。没有历史数据时不给默认值瞎猜，
 *   而是让用户填一个来自自己数据的数，并说明「填错会差多少」。
 */

import { normalCdf, normalInv } from './stats.ts';

export interface SampleSizeOptions {
  /** 对照组的基线转化率（0–1） */
  p1: number;
  /** 实验组的目标转化率（0–1）。与 p1 的差就是要在 α 下检出的效应 */
  p2: number;
  alpha?: number;
  power?: number;
  /** 最多找到多少样本还找不到就放弃（防止无解时死循环） */
  cap?: number;
}

export interface SampleSizeResult {
  /** 每组所需样本（向上取整） */
  nPerArm: number;
  /** 总样本 = 2 × nPerArm */
  total: number;
  /** 该样本量下的实际功效（应 ≈ 目标值；二分有余量时会略高） */
  achievedPower: number;
  /** 用一套常见的近似公式算出来的数，只用于说明「为什么不用它」 */
  fleissEstimate: number;
}

/**
 * 二分求最小 n，使 `powerTwoProportion(p1,p2,n,α) ≥ target`。
 *
 * 上界用 Fleiss 近似 × 2 起步，再翻倍直到够用——不用「猜一个 1e7」，
 * 因为大 n 下功效函数接近 1，二分会在几十次内收敛。
 */
export function sampleSizeTwoProportion(opts: SampleSizeOptions): SampleSizeResult {
  const alpha = opts.alpha ?? 0.05;
  const target = opts.power ?? 0.8;
  const cap = opts.cap ?? 50_000_000;
  const { p1, p2 } = opts;
  if (!(p1 > 0 && p1 < 1) || !(p2 > 0 && p2 < 1)) {
    throw new Error('基线转化率与目标转化率都必须在 (0,1) 之间');
  }
  if (p1 === p2) throw new Error('目标转化率与基线相同：效应为 0 时任何样本量都测不出来');

  const powerAt = (n: number) => powerTwoProportionLocal(p1, p2, n, alpha);

  let hi = Math.max(2, Math.ceil(fleissEstimate(p1, p2, alpha, target) * 2));
  while (powerAt(hi) < target) {
    hi *= 2;
    if (hi > cap) throw new Error('在这个流量下需要超过 5000 万样本/组，实际上不可行——请放大要检测的效应');
  }
  let lo = 2;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (powerAt(mid) >= target) hi = mid;
    else lo = mid + 1;
  }
  return {
    nPerArm: lo,
    total: lo * 2,
    achievedPower: powerAt(lo),
    fleissEstimate: Math.ceil(fleissEstimate(p1, p2, alpha, target)),
  };
}

/**
 * 连续指标（ARPU / 人均时长…）的样本量：
 *   n = 2σ²(z_{1−α/2} + z_{1−β})² / Δ²
 * σ 必须来自用户自己的数据——拿别人的方差算出来的 n 只是看起来专业。
 */
export function sampleSizeContinuous(opts: {
  sd: number;
  /** 要检出的绝对差值（与 sd 同单位，比如 元） */
  delta: number;
  alpha?: number;
  power?: number;
}): { nPerArm: number; total: number } {
  const alpha = opts.alpha ?? 0.05;
  const power = opts.power ?? 0.8;
  if (!(opts.sd > 0)) throw new Error('标准差必须大于 0');
  if (!(Math.abs(opts.delta) > 0)) throw new Error('要检出的差值不能为 0');
  const za = normalInv(1 - alpha / 2);
  const zb = normalInv(power);
  const n = Math.ceil((2 * opts.sd * opts.sd * (za + zb) ** 2) / (opts.delta * opts.delta));
  return { nPerArm: n, total: n * 2 };
}

/** 给定每臂样本与分流比例，算需要几天（按天级流量，向上取整） */
export function daysNeeded(opts: {
  nPerArm: number;
  dailyTraffic: number;
  /** 对照组占比，0.5 = 五五分 */
  controlShare?: number;
}): { days: number; perArmPerDay: number } {
  const share = opts.controlShare ?? 0.5;
  if (!(opts.dailyTraffic > 0)) throw new Error('日流量必须大于 0');
  // 用 round 不用 floor：`1 - 0.9 = 0.09999999999999998`，floor 会在 90/10 分流时
  // 把「每天 2000 人」算成 1999 人，进而把 5 天算成 6 天。整数人流没有小数概念。
  const raw = opts.dailyTraffic * Math.min(share, 1 - share);
  if (raw < 1) throw new Error('按这个分流比例，每天进不了 1 个人——请调大日流量或分流比例');
  const perArmPerDay = Math.round(raw);
  return { days: Math.ceil(opts.nPerArm / perArmPerDay), perArmPerDay };
}

/**
 * 反方向：给定「能跑几天」，能检出多大的效应（相对提升）。
 * 返回相对值（0.08 = 8%）：PM 更容易理解「只能测出 8% 以上的提升」。
 */
export function mdeForDays(opts: {
  p1: number;
  days: number;
  dailyTraffic: number;
  controlShare?: number;
  alpha?: number;
  power?: number;
}): { mdeAbs: number; mdeRel: number; nPerArm: number } {
  const share = opts.controlShare ?? 0.5;
  const raw = opts.dailyTraffic * Math.min(share, 1 - share);
  if (raw < 1) throw new Error('按这个分流比例，每天进不了 1 个人——请调大日流量或分流比例');
  const perArmPerDay = Math.round(raw);
  const nPerArm = Math.max(2, perArmPerDay * Math.max(1, opts.days));
  const mdeAbs = mdeTwoProportionLocal(opts.p1, nPerArm, opts.alpha ?? 0.05, opts.power ?? 0.8);
  return { mdeAbs, mdeRel: mdeAbs / opts.p1, nPerArm };
}

/**
 * 多个变体（A/B/n）时，α 要按比较次数分摊。
 * 3 个臂 = 2 次「每个处理组 vs 对照」，所以 Bonferroni 用 α/2；
 * 这里不做 Dunnett（需要多元正态相关性），但把「为什么不是 α」说清楚。
 */
export function alphaForArms(alpha: number, arms: number): { alphaPerComparison: number; comparisons: number } {
  const comparisons = Math.max(1, arms - 1);
  return { alphaPerComparison: alpha / comparisons, comparisons };
}

/* ---------- 本地实现：避免与 stats.ts 的命名纠葛，同时保持公式一致 ---------- */

function powerTwoProportionLocal(p1: number, p2: number, n: number, alpha: number): number {
  const za = normalInv(1 - alpha / 2);
  const se = Math.sqrt((p1 * (1 - p1)) / n + (p2 * (1 - p2)) / n);
  if (!(se > 0)) return 1;
  const z = Math.abs(p2 - p1) / se;
  return normalCdf(z - za) + normalCdf(-z - za);
}

function mdeTwoProportionLocal(p: number, n: number, alpha: number, power: number): number {
  return (normalInv(1 - alpha / 2) + normalInv(power)) * Math.sqrt((2 * p * (1 - p)) / n);
}

function fleissEstimate(p1: number, p2: number, alpha: number, power: number): number {
  const za = normalInv(1 - alpha / 2);
  const zb = normalInv(power);
  const pBar = (p1 + p2) / 2;
  const num =
    (za * Math.sqrt(2 * pBar * (1 - pBar)) +
      zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2;
  return num / (p2 - p1) ** 2;
}
