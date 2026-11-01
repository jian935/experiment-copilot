/**
 * 序贯检验（always-valid inference）：把「偷看」这件事算进阈值里。
 *
 * 为什么必须有这一块：真实团队每天都在刷新看板，看到 p=0.043 就宣布成功。
 * 但 p 值的 5% 只对**一次**计划好的检验成立。看 7 次、每次都用 0.05 判，
 * 零效应下「至少有一次显著」的概率远大于 5%（本项目 A/A 模拟实测见 tests/sequential.test.ts）。
 *
 * 两条路线，用途不同，不是二选一：
 *
 *   1. **O'Brien–Fleming + Lan–DeMets α 消耗函数（默认）**
 *      先声明「我打算看 K 次」，按信息量比例 t 分配累计 α：α*(t) = 2 − 2Φ(z_{1−α/2}/√t)。
 *      边界 c_k 由**联合分布**递推数值解出（不是简单地把 α 除以 K，也不是拿 α*(t_k) 当名义 α
 *      —— 那样会把前面几次的拒绝机会漏掉，实际 FWER > α）。
 *      特点：早期边界极宽（几乎不可能早停），末期接近 2σ，功效损失很小。
 *
 *   2. **mSPRT / always-valid p（补充口径）**
 *      不预设看几次，对任意停时都有效。代价是每条边界都更宽（~3σ）：
 *      「随时可以看」是真的要用功效去换的，不是免费的。
 *      先验尺度 τ 必须在看数据前定好（本项目取 1.96×最终标准误，即「刚好能检出的效应」），
 *      看完数据再挑 τ 就不 valid 了 —— 这一点在 UI 上也要写明。
 *
 * 全部为纯函数、零依赖、可复现；边界有缓存（同一组信息量只解一次）。
 */

import { normalCdf, normalInv } from './stats.ts';

// ===================== α 消耗函数 =====================

/**
 * Lan–DeMets O'Brien–Fleming 消耗函数：到信息量比例 t 时累计可花的 α。
 *
 * t→0 时 →0（极早期几乎不给 α），t=1 时 = α（总量守恒）。
 * 形式取 2−2Φ(z_{1−α/2}/√t)：早期不放 α，末期开口，所以功效损失小。
 */
export function obfAlphaSpent(t: number, alpha = 0.05): number {
  if (!(t > 0)) return 0;
  if (t >= 1) return alpha;
  return Math.min(alpha, 2 - 2 * normalCdf(normalInv(1 - alpha / 2) / Math.sqrt(t)));
}

/**
 * Pocock 消耗函数（对照组）：α·ln(1+(e−1)t)。
 * 与 OBF 的区别正是「早停容不容易」：Pocock 早期边界就很低，但如果最终才出结果，
 * 它的边界比 OBF 严。临床上一个要「尽早停」、一个要「末期别太吃亏」，本项目默认 OBF。
 */
export function pocockAlphaSpent(t: number, alpha = 0.05): number {
  if (!(t > 0)) return 0;
  if (t >= 1) return alpha;
  return alpha * Math.log(1 + (Math.E - 1) * t);
}

// ===================== 联合分布递推（求 OBF 边界） =====================

/** 数值积分网格：−9…9，步长 0.02。f 是光滑正态型密度，梯形误差 ~1e-5，足够三位小数对齐。 */
const GRID_H = 0.02;
const GRID_MAX = 9;
const GRID: number[] = (() => {
  const n = Math.round((2 * GRID_MAX) / GRID_H) + 1;
  const g: number[] = new Array(n);
  for (let i = 0; i < n; i++) g[i] = -GRID_MAX + i * GRID_H;
  return g;
})();

const INV_SQRT_2PI = 1 / Math.sqrt(2 * Math.PI);
const phi = (z: number) => INV_SQRT_2PI * Math.exp(-0.5 * z * z);

/**
 * 上一步的子密度在「没有提前越界」条件下的转移：
 *   f_k(z) = ∫_{|u|<c_{k−1}} f_{k−1}(u) · φ((z − ρu)/s)/s du
 * ρ = √(t_{k−1}/t_k)，s = √(1−ρ²)：独立增量的布朗运动在两次观察间的相关系数是 √(t₁/t₂)。
 */
function transition(prev: number[], cPrev: number, rho: number): number[] {
  const s = Math.sqrt(Math.max(1e-12, 1 - rho * rho));
  const out = new Array(GRID.length).fill(0);
  for (let j = 0; j < GRID.length; j++) {
    const fj = prev[j];
    if (fj === 0) continue;
    const u = GRID[j];
    if (Math.abs(u) >= cPrev) continue; // 已经越界的路径不再贡献（这就是「子密度」的含义）
    const ru = rho * u;
    for (let i = 0; i < GRID.length; i++) {
      const d = (GRID[i] - ru) / s;
      out[i] += fj * phi(d) / s;
    }
  }
  // 梯形权重（两端半格）
  for (let i = 0; i < out.length; i++) out[i] *= GRID_H;
  return out;
}

/**
 * 越界质量：P(|Z_k| ≥ c | 之前都没越界)。
 * 交换积分顺序后内层有闭式（正态尾），不用做二维积分：
 *   ∫_{|u|<c_{k−1}} f_{k−1}(u)·[1 − Φ((c−ρu)/s) + Φ((−c−ρu)/s)] du
 */
function tailMass(prev: number[], cPrev: number, rho: number, c: number): number {
  const s = Math.sqrt(Math.max(1e-12, 1 - rho * rho));
  let sum = 0;
  for (let j = 0; j < GRID.length; j++) {
    const u = GRID[j];
    if (Math.abs(u) >= cPrev) continue;
    const fj = prev[j];
    if (fj === 0) continue;
    const ru = rho * u;
    sum += fj * (1 - normalCdf((c - ru) / s) + normalCdf((-c - ru) / s));
  }
  return sum * GRID_H;
}

export interface BoundaryResult {
  /** 每次观察的名义 z 边界：|Z_k| ≥ c_k 判显著 */
  boundaries: number[];
  /** 每次观察的名义 p 边界（双侧） */
  nominalP: number[];
  /** 每次观察的累计 α 消耗 */
  alphaSpent: number[];
  /** 数值解出的累计 FWER（应当等于 alphaSpent，用来验证递归没算错） */
  cumulativeError: number[];
}

const BOUNDARY_CACHE = new Map<string, BoundaryResult>();

/**
 * 把观察时点吸附到等距网格（仅当每个时点的偏差都小于 tol）。
 *
 * 为什么要吸附：解边界是 O(K·n²) 的数值递推（本项目 n=901、K=7 时约 30ms），
 * 而每个实验的「信息量比例」都会因当天流量抖动而略有不同，
 * 不吸附就等于每次换一组数字、缓存全 miss，评测跑 120 个实验要 4 秒。
 * 吸附后同一观察次数只解一次；代价是边界误差 < 0.01σ（有单测钉住这个量级）。
 *
 * 只在偏差很小时吸附：导入的真实数据若观察时点很不均匀（例如中途加投），
 * 仍然按真实时点精确求解 —— 那才是 Lan–DeMets 相对固定序列 OBF 的优势所在。
 */
export function snapToEqual(times: number[], tol = 0.02): { times: number[]; snapped: boolean } {
  const k = times.length;
  if (k === 0) return { times, snapped: false };
  const equal = times.every((t, i) => Math.abs(t - (i + 1) / k) <= tol);
  return equal ? { times: times.map((_, i) => (i + 1) / k), snapped: true } : { times, snapped: false };
}

/**
 * 按信息量比例切分并解出边界。
 *
 * times 必须严格递增、末项为 1（信息量比例：第 k 次观察时已积累的样本 / 最终样本）。
 * 解的是「累计越界概率 = α*(t_k)」这个方程，逐步从 c_1 求到 c_K。
 */
export function obfBoundary(times: number[], alpha = 0.05): BoundaryResult {
  const snapped = snapToEqual(times).times;
  const ts = snapped.map((t) => Math.min(1, Math.max(1e-6, t)));
  // 缓存键：信息量比例对齐到 4 位小数（同一批实验天数相同，命中率很高）
  const key = `${alpha}|${ts.map((t) => t.toFixed(4)).join(',')}`;
  const hit = BOUNDARY_CACHE.get(key);
  if (hit) return hit;

  const k = ts.length;
  const boundaries: number[] = new Array(k).fill(0);
  const nominalP: number[] = new Array(k).fill(1);
  const alphaSpent: number[] = new Array(k).fill(0);
  const cumulativeError: number[] = new Array(k).fill(0);

  // dens = Z_{i−1} 在「前面都没越界」条件下的子密度；第一次观察前就是标准正态密度
  let dens = GRID.map((z) => phi(z));
  let cPrev = Infinity;
  let spentPrev = 0;

  /** 把密度截断到 |z| < c 并重新归一化（条件于本次也没越界） */
  const truncate = (d: number[], c: number, keepMass: number): number[] => {
    const out = d.map((v, i) => (Math.abs(GRID[i]) < c ? v : 0));
    // 注意：d 是「密度值」（每单位高度），质量要乘格宽；直接拿 sum 归一化会少算 1/h 倍
    const mass = out.reduce((a, b) => a + b, 0) * GRID_H;
    if (mass > 1e-14 && keepMass > 0) {
      const scale = keepMass / mass;
      for (let j = 0; j < out.length; j++) out[j] *= scale;
    }
    return out;
  };

  for (let i = 0; i < k; i++) {
    const target = obfAlphaSpent(ts[i], alpha);
    alphaSpent[i] = target;
    const rho = i === 0 ? 0 : Math.sqrt(ts[i - 1] / ts[i]);

    if (i === 0) {
      // 第一次观察：没有前置截断，越界质量就是普通双侧尾概率
      boundaries[0] = normalInv(1 - target / 2);
      cumulativeError[0] = target;
    } else {
      // 单调递减：c 越大越界越少 → 二分
      let lo = 0.3;
      let hi = 10;
      for (let it = 0; it < 60; it++) {
        const mid = (lo + hi) / 2;
        const total = spentPrev + tailMass(dens, cPrev, rho, mid);
        if (total > target) lo = mid;
        else hi = mid;
      }
      boundaries[i] = (lo + hi) / 2;
      cumulativeError[i] = spentPrev + tailMass(dens, cPrev, rho, boundaries[i]);
    }
    nominalP[i] = 2 * (1 - normalCdf(boundaries[i]));

    // 准备下一次递推：先按本次的相关系数把 Z_{i−1} 的密度推到 Z_i，
    // 再截断掉「本次越界」的那部分（|z| ≥ c_i），剩下的才是下一次的子密度。
    if (i + 1 < k) {
      const moved = i === 0 ? dens : transition(dens, cPrev, rho);
      dens = truncate(moved, boundaries[i], 1 - cumulativeError[i]);
      cPrev = boundaries[i];
    }
    spentPrev = cumulativeError[i];
  }

  const res: BoundaryResult = { boundaries, nominalP, alphaSpent, cumulativeError };
  BOUNDARY_CACHE.set(key, res);
  return res;
}

// ===================== mSPRT / always-valid p =====================

/**
 * 混合似然比的对数（正态混合先验 N(0, τ²)，观测为无偏估计 + 其标准误）。
 *
 *   Λ = √(σ²/(σ²+τ²)) · exp( τ²δ̂² / (2σ²(σ²+τ²)) )，σ² = se²
 *
 * H0 下 E[Λ]=1 且 Λ_t 是鞅 → Ville 不等式给出 P(sup_t Λ_t ≥ 1/α) ≤ α，
 * 于是 p = min(1, 1/Λ) 在**任意停时**都有效（这就是「随时可看」的来源）。
 * 代价：单点上看它比普通 p 保守得多（见 msprtRequiredZ）。
 */
export function msprtLogLR(estimate: number, se: number, tau: number): number {
  if (!(se > 0) || !Number.isFinite(se) || !(tau > 0)) return 0;
  const c = (tau * tau) / (se * se);
  return -0.5 * Math.log(1 + c) + (c * estimate * estimate) / (2 * se * se * (1 + c));
}

/** always-valid p（单个停时上也有效，不需要事先声明看几次） */
export function msprtAlwaysValidP(estimate: number, se: number, tau: number): number {
  const logLR = msprtLogLR(estimate, se, tau);
  return Math.min(1, Math.exp(-logLR));
}

/**
 * 在给定先验尺度 τ 下，mSPRT 需要多大的 z 才能在最后一刻拒绝（p<α）。
 * 用途是把「随时可看的价格」量化出来：τ 与真实效应匹配时约 3σ，否则更宽。
 * 二分求解，单调性明确（z 越大越显著）。
 */
export function msprtRequiredZ(tauOverSe: number, alpha = 0.05): number {
  if (!(tauOverSe > 0)) return Infinity;
  const target = Math.log(1 / alpha);
  const f = (z: number) => {
    const c = tauOverSe * tauOverSe;
    return -0.5 * Math.log(1 + c) + (c * z * z) / (2 * (1 + c));
  };
  let lo = 0;
  let hi = 20;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * 最优先验尺度下的门槛：max_τ logΛ 的解在 c = z²−1，
 * 于是「先验刚好匹配真实效应」时 mSPRT 只需要 z* 满足 (z*²−1)/2 − ln z* = ln(1/α)。
 * α=0.05 时 z* ≈ 2.97 —— 这是 anytime-valid 的理论价格，作为对照展示。
 */
export function msprtBestCaseZ(alpha = 0.05): number {
  const target = Math.log(1 / alpha);
  const f = (z: number) => (z * z - 1) / 2 - Math.log(z);
  let lo = 1.01;
  let hi = 10;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ===================== 逐日累积 → 一份窥探报告 =====================

export interface LookInput {
  day: number;
  date: string;
  /** 该次观察时的累计样本（两臂平均） */
  nPerArm: number;
  diff: number;
  se: number;
}

export interface PeekLook extends LookInput {
  /** 信息量比例（当前累计样本 / 最终样本） */
  infoFrac: number;
  z: number;
  /** 未校正的双侧 p：就是"每天看一次"时大家实际在用的那个数 */
  pNaive: number;
  /** OBF 边界（z 尺度） */
  zBoundary: number;
  /** OBF 边界对应的名义 p（该次观察要低于它才算显著） */
  pBoundary: number;
  /** 到这次观察为止累计花掉的 α */
  alphaSpent: number;
  /** 该次观察的 always-valid p */
  pAlways: number;
}

export interface PeekReport {
  looks: PeekLook[];
  /** 计划观察次数 */
  k: number;
  alpha: number;
  /** mSPRT 先验尺度（效应单位） */
  priorScale: number;
  /**
   * 三套判定（语义 = 「整个观察过程里有没有达到过显著」）。
   * 序贯检验的用法是**一停即结论**：任何一次越过该次边界，当时就该停下并宣布，
   * 之后不再回看。所以这里给的是「曾经显著」而不是「现在显著」。
   */
  naiveSig: boolean;
  obfSig: boolean;
  alwaysSig: boolean;
  /** 第一次越过 OBF 边界是第几次观察（没有则为 null） */
  obfCrossDay: number | null;
  /** 第一次越过 always-valid 门槛是第几次观察 */
  alwaysCrossDay: number | null;
  /**
   * 最后一次观察本身是否越过边界。
   * 与 obfSig 不同：早期越过、后面又回落是常态（z 会随样本增加而漂移），
   * 不说清这一点，读者会觉得「当前 |z| 没过边界」和「OBF 显著」自相矛盾。
   */
  obfSigNow: boolean;
  /** 最终观察的名义 p / OBF 名义门槛 / always-valid p */
  finalPNaive: number;
  finalPBoundary: number;
  finalPAlways: number;
  /**
   * 整条轨迹上最小的 naive p 与最小的 always-valid p。
   * always-valid p 的正确报法就是**取整条轨迹的最小值**——它控制的正是
   * 「整个过程里有没有出现过证据」，只报最后一次会漏掉早期就已经越界的情形
   * （那时按规矩就应该停下宣布了）。
   */
  minNaiveP: number;
  minAlwaysP: number;
  /** OBF 门槛相对 naive 的收紧倍数（0.05 / pBoundary） */
  obfTightening: number;
  /**
   * 没有任何可判读的观察序列时给出原因（只有 1 天、或 SE 全为 0）。
   * 有值时 UI 不应画图，直接显示原因。
   */
  skipped?: string;
}

export interface PeekOptions {
  alpha?: number;
  /** mSPRT 先验尺度；缺省 = z_{1−α/2} × 最终 SE（"刚好能检出的效应"） */
  priorScale?: number;
  /** 信息量口径：用样本量（默认）还是原始曝光 —— 本项目用两臂平均样本，等价 */
  label?: string;
}

/**
 * 把逐日累积估计变成一份序贯报告。
 *
 * 纪律：looks 必须按时间升序、样本单调不减；这里不再重算统计量，
 * 只做「同一个 z 轨迹在不同窥探纪律下会不会被判显著」的换算。
 * 所以它不可能出现「换了个统计量」的漂移 —— 口径由调用方唯一决定。
 */
export function buildPeekReport(looks: LookInput[], opts: PeekOptions = {}): PeekReport {
  const alpha = opts.alpha ?? 0.05;
  const empty = (skipped: string): PeekReport => ({
    looks: [],
    k: 0,
    alpha,
    priorScale: 0,
    naiveSig: false,
    obfSig: false,
    alwaysSig: false,
    obfCrossDay: null,
    alwaysCrossDay: null,
    obfSigNow: false,
    finalPNaive: 1,
    finalPBoundary: alpha,
    finalPAlways: 1,
    minNaiveP: 1,
    minAlwaysP: 1,
    obfTightening: 1,
    skipped,
  });
  if (looks.length === 0) return empty('没有逐日数据');
  if (looks.length === 1) return empty('只有一天的观察，序贯校正无从谈起（至少需要 2 次观察）');

  const valid = looks.filter((l) => l.se > 0 && Number.isFinite(l.se));
  if (valid.length < 2) return empty('标准误为 0 或缺失，无法构造 z 轨迹');

  const nFinal = valid[valid.length - 1].nPerArm;
  if (!(nFinal > 0)) return empty('累计样本量为 0');

  const times = snapToEqual(
    valid.map((l) => Math.max(1e-6, Math.min(1, l.nPerArm / nFinal))),
  ).times;
  const bd = obfBoundary(times, alpha);
  const finalSe = valid[valid.length - 1].se;
  const priorScale = opts.priorScale && opts.priorScale > 0 ? opts.priorScale : normalInv(1 - alpha / 2) * finalSe;

  const out: PeekLook[] = valid.map((l, i) => {
    const z = l.diff / l.se;
    return {
      ...l,
      infoFrac: times[i],
      z,
      pNaive: 2 * (1 - normalCdf(Math.abs(z))),
      zBoundary: bd.boundaries[i],
      pBoundary: bd.nominalP[i],
      alphaSpent: bd.alphaSpent[i],
      pAlways: msprtAlwaysValidP(l.diff, l.se, priorScale),
    };
  });

  const last = out[out.length - 1];
  const crossIdx = out.findIndex((l) => Math.abs(l.z) >= l.zBoundary);
  const alwaysIdx = out.findIndex((l) => l.pAlways < alpha);
  return {
    looks: out,
    k: out.length,
    alpha,
    priorScale,
    naiveSig: last.pNaive < alpha,
    // 序贯判定：任何一次观察越过该次的 OBF 边界即判显著（这才是 always-valid 的用法）
    obfSig: crossIdx >= 0,
    alwaysSig: alwaysIdx >= 0,
    obfCrossDay: crossIdx >= 0 ? out[crossIdx].day : null,
    alwaysCrossDay: alwaysIdx >= 0 ? out[alwaysIdx].day : null,
    obfSigNow: Math.abs(last.z) >= last.zBoundary,
    finalPNaive: last.pNaive,
    finalPBoundary: last.pBoundary,
    finalPAlways: last.pAlways,
    minNaiveP: Math.min(...out.map((l) => l.pNaive)),
    minAlwaysP: Math.min(...out.map((l) => l.pAlways)),
    obfTightening: last.pBoundary > 0 ? alpha / last.pBoundary : 1,
  };
}
