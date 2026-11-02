/**
 * 多臂（A/B/n）统计层：Dunnett 校正、P(最优臂)、全局检验、多臂样本量。
 *
 * 为什么不能「多跑几次两臂检验」了事：3 个臂 = 2 次「处理组 vs 对照」，
 * 每次都按 α=0.05 判，全零族下「至少一条显著」的概率是 1−0.95² ≈ 9.75%，
 * 4 个臂是 14.3%。这正是多重比较问题在实验平台里的样子：**臂越多，越容易挑出一个假的赢家**。
 *
 * 两条路：
 *  1. α 分摊（Bonferroni）：α/m，简单但保守，m 大时功效掉得厉害；
 *  2. Dunnett（1955）：所有处理臂共享同一个对照，于是统计量之间**正相关**（等样本量时 ρ=0.5）。
 *     利用相关性可以比 Bonferroni 少损失功效——这是多臂实验的标准做法（SAS/R 的 `Dunnett`）。
 *
 * 本文件的关键实现技巧：**条件独立把 k 维积分降成 1 维**。
 * 记 Δᵢ = Mᵢ − M₀（臂 i 与对照的均值差），给定对照均值 M₀ 后，各 Δᵢ 互相独立，
 * 所以「所有 |Δᵢ| ≤ t」的概率 = E_{M₀}[∏ Φ(...)] —— 一个光滑的一维积分，
 * 用 Gauss–Hermite 求积算到机器精度，既精确又完全是确定性的（无随机数，可复现，可进单测）。
 */

import { chi2Sf, normalCdf, normalInv } from './stats.ts';

// ===================== Gauss–Hermite 求积（确定，无随机） =====================
// ∫ f(u) e^{−u²} du ≈ Σ wᵢ f(xᵢ)，节点是 Hermite 多项式的根。
//
// 为什么不硬编码节点表：看不出来精度来源，也没法换点数核对收敛。
// 为什么不用「经验初值 + Newton」：NR 的 gauher 初始猜测在 n 大时会跑飞
// （本项目试过，40 点时第三个根直接冲到 20 以外，权重全变成 1e-24）。
// 这里改用**扫描变号 + 二分**：Hermite 函数的根互相交错，在 [-B, B] 上扫够细
// 就能把全部 n 个根框住，再二分到机器精度。慢一点（一次性 20ms，且按 n 缓存），
// 但结果可验证：Σw、二阶矩、∫e^{−x²}cos x 三条都能对到 1e-12。

const PIM4 = Math.pow(Math.PI, -0.25);

export interface Quadrature {
  x: number[];
  w: number[];
}

/** 归一化 Hermite 函数 ψₙ(z)：ψ₀ = π^{−1/4}，ψⱼ = z√(2/j)ψⱼ₋₁ − √((j−1)/j)ψⱼ₋₂ */
function hermiteNorm(z: number, n: number): { psi: number; psiPrev: number } {
  let p1 = PIM4;
  let p2 = 0;
  for (let j = 1; j <= n; j++) {
    const p3 = p2;
    p2 = p1;
    p1 = z * Math.sqrt(2 / j) * p2 - Math.sqrt((j - 1) / j) * p3;
  }
  return { psi: p1, psiPrev: p2 };
}

const GH_CACHE = new Map<number, Quadrature>();

/**
 * n 点 Gauss–Hermite 节点与权重（权重和为 √π）。
 * 单测核对：Σw = √π、Σw x² = √π/2、∫e^{−x²}cos x = √π e^{−1/4}。
 */
export function gaussHermite(n = 40): Quadrature {
  const hit = GH_CACHE.get(n);
  if (hit) return hit;
  const bound = Math.sqrt(2 * n + 1) + 1;
  const steps = Math.max(2000, 40 * n);
  const roots: number[] = [];
  let prevZ = -bound;
  let prevV = hermiteNorm(prevZ, n).psi;
  for (let i = 1; i <= steps; i++) {
    const z = -bound + (2 * bound * i) / steps;
    const v = hermiteNorm(z, n).psi;
    if (prevV === 0 || (prevV < 0) !== (v < 0)) {
      // 二分
      let lo = prevZ;
      let hi = z;
      let flo = prevV;
      for (let k = 0; k < 80 && hi - lo > 1e-15; k++) {
        const mid = (lo + hi) / 2;
        const fm = hermiteNorm(mid, n).psi;
        if ((flo < 0) !== (fm < 0)) hi = mid;
        else {
          lo = mid;
          flo = fm;
        }
      }
      roots.push((lo + hi) / 2);
    }
    prevZ = z;
    prevV = v;
  }
  if (roots.length !== n) {
    // 兜底：宁可抛错也不要给出错的积分权重（错权重会让所有 p 值静默偏移）
    throw new Error(`Gauss–Hermite 求根失败：n=${n} 只找到 ${roots.length} 个根`);
  }
  const w = roots.map((z) => {
    const { psiPrev } = hermiteNorm(z, n);
    const pp = Math.sqrt(2 * n) * psiPrev;
    return 2 / (pp * pp);
  });
  const out = { x: roots, w };
  GH_CACHE.set(n, out);
  return out;
}

/** ∫ f(u)·φ(u) du（标准正态权重），用 GH 换元 u = √2·x */
export function integrateNormal(f: (u: number) => number, n = 40): number {
  const { x, w } = gaussHermite(n);
  let s = 0;
  for (let i = 0; i < x.length; i++) s += w[i] * f(Math.SQRT2 * x[i]);
  return s / Math.sqrt(Math.PI);
}

// ===================== Dunnett =====================

export interface DunnettInput {
  /** 各处理臂相对对照的差值（与该指标自身单位一致） */
  diff: number[];
  /** 各处理臂的差值标准误 */
  se: number[];
  /** 对照臂均值的标准误（所有处理臂共享它，这是相关性来源） */
  seControl: number;
}

export interface DunnettResult {
  /** 校正后 p（与输入同序）：P(max_j |Δ_j| ≥ |Δ_i|) */
  adjP: number[];
  /** 单次比较的边际双侧 p（= 2Φ(−|Δ_i|/se_i)） */
  rawP: number[];
  /** 同时 95% 临界值 c（**与差值同单位**）：Δ ± c·SE 是同时置信区间 */
  crit: number;
  /** 同一临界值的 z 表示（= crit，两者本就同单位；保留别名便于 UI 并排展示） */
  critZ: number;
  /** Bonferroni 的临界值（z 单位）z_{1−α/(2m)}，用来展示 Dunnett 省了多少 */
  bonferroniCritZ: number;
  /** 同时区间（与 adjP 一致：跨 0 ⟺ adjP > α） */
  ci: Array<[number, number]>;
  m: number;
  alpha: number;
  /** 相关系数（等样本量时 ≈ 0.5） */
  correlation: number[];
}

/** 处理臂自身的方差 = 差值方差 − 对照方差。共享对照的条件积分里必须用这个，不能用差值 SE。 */
function treatmentVar(seDiff: number, seControl: number): number {
  const v = seDiff * seDiff - seControl * seControl;
  return v > 0 ? v : Math.max(seDiff * seDiff * 0.5, 1e-18);
}

/**
 * Dunnett 单步校正（双侧）。
 *
 * 给定对照均值 M₀ = se₀·u，各臂的 Δᵢ 条件独立（方差只剩处理臂自己的 se_tᵢ²），于是
 *   P(所有 |Δᵢ| ≤ t) = E_u[ ∏ᵢ ( Φ((t + se₀u)/se_tᵢ) − Φ((−t + se₀u)/se_tᵢ) ) ]
 * 校正 pᵢ = 1 − P(所有 |Zⱼ| ≤ |Zᵢ|)，临界值 c 解 P(所有 |Zⱼ| ≤ c) = 1−α（c 为 z 单位）。
 *
 * ⚠️ 积分里的界必须与「z 单位」一致：每臂都要乘自己的 se[i] 再除以处理臂的 se_t。
 * 这里踩过一次：把 |Δ|（差值单位）直接当 z 传进积分，区间跑出 2.2「个百分点」，
 * coverage≈1、adjP 退化成 rawP——表面上「看起来合理」，实际校正完全没生效。
 * 是「全零族 FWER 模拟」那条单测把它抓出来的。
 *
 * 这个口径的三个性质（都被单测钉住）：
 *  1. m=1 时严格退化成普通双侧 z 检验；
 *  2. adjP ≥ rawP 且随臂数增加而变大；
 *  3. adjP < α ⟺ 同时区间不含 0——不会出现「p 显著但 CI 跨 0」这种自相矛盾。
 */
export function dunnettTwoSided(input: DunnettInput, alpha = 0.05): DunnettResult {
  const { diff, se, seControl } = input;
  const m = diff.length;
  const rawP = diff.map((d, i) => (se[i] > 0 ? 2 * (1 - normalCdf(Math.abs(d) / se[i])) : d === 0 ? 1 : 0));
  if (m === 0) {
    return {
      adjP: [], rawP: [], crit: 0, critZ: normalInv(1 - alpha / 2), bonferroniCritZ: normalInv(1 - alpha / 2),
      ci: [], m: 0, alpha, correlation: [],
    };
  }
  const st = se.map((s) => Math.sqrt(treatmentVar(s, seControl)));

  /**
   * P(所有 |Zⱼ| ≤ c)，c 是 **z 单位**（每臂用各自的 SE 换算回差值尺度）。
   * 用 z 单位而不是差值单位，是因为区间必须是 Δ ± c·SEᵢ：SE 不等时
   * 「同一个差值界宽」对不同臂并不等价，而「同一个 z 界」才是等价的。
   */
  const coverage = (c: number): number => {
    if (!(c > 0)) return 0;
    return integrateNormal((u) => {
      let p = 1;
      for (let i = 0; i < m; i++) {
        if (!(se[i] > 0)) continue;
        const hi = normalCdf((c * se[i] + seControl * u) / st[i]);
        const lo = normalCdf((-c * se[i] + seControl * u) / st[i]);
        p *= hi - lo;
        if (p === 0) return 0;
      }
      return p;
    });
  };

  // 临界值：coverage 单调增，二分到 1e-12（上界 20 已远超任何多臂临界值）
  let lo = 0;
  let hi = 20;
  for (let i = 0; i < 200 && hi - lo > 1e-12; i++) {
    const mid = (lo + hi) / 2;
    if (coverage(mid) < 1 - alpha) lo = mid;
    else hi = mid;
  }
  const crit = (lo + hi) / 2;

  const adjP = diff.map((d, i) => {
    if (!(se[i] > 0)) return rawP[i];
    const c = coverage(Math.abs(d) / se[i]);
    return Math.min(1, Math.max(rawP[i], 1 - c));
  });

  // 臂 i 与臂 j 的相关系数：共享对照 → ρᵢⱼ = se₀² / (seᵢ·seⱼ)（差值尺度上）
  const correlation = se.map((s) => (s > 0 ? Math.min(1, (seControl * seControl) / (s * s)) : 0));

  return {
    adjP,
    rawP,
    crit,
    critZ: crit,
    bonferroniCritZ: normalInv(1 - alpha / (2 * m)),
    ci: diff.map((d, i) => [d - crit * se[i], d + crit * se[i]] as [number, number]),
    m,
    alpha,
    correlation,
  };
}

/** 在等相关的简化设计下解 Dunnett 临界值（规划阶段用；不给 se，只用 ρ 与 k） */
export function dunnettCritEqual(alpha: number, k: number, rho = 0.5): number {
  const m = Math.max(1, k - 1);
  const coverage = (t: number): number => {
    if (!(t > 0)) return 0;
    const sd = Math.sqrt(Math.max(1e-12, 1 - rho));
    const shift = Math.sqrt(Math.max(0, rho));
    return integrateNormal((u) => {
      const hi = normalCdf((t + shift * u) / sd);
      const lo = normalCdf((-t + shift * u) / sd);
      return (hi - lo) ** m;
    });
  };
  let lo = 0;
  let hi = 12;
  for (let i = 0; i < 200 && hi - lo > 1e-10; i++) {
    const mid = (lo + hi) / 2;
    if (coverage(mid) < 1 - alpha) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ===================== P(每个臂是最优) =====================

export interface BestInput {
  /** 各臂的估计值（对照臂传 0）；顺序与 label 一致 */
  estimate: number[];
  /** 各臂估计值的标准误 */
  se: number[];
  /** 臂名（仅回传用） */
  label: string[];
}

export interface BestResult {
  /** P(臂 i 最优)，和为 1 */
  prob: number[];
  /** 若必须现在选一个，选它 */
  bestIndex: number;
  /** 该臂成为最优的概率 */
  bestProb: number;
  /** 选择带来的「赢家诅咒」：点估计中被选中的那个，期望被高估多少（近似） */
  winnerCurse: number;
}

/**
 * P(臂 i 真是最优)。
 *
 * 为什么 PM 需要这个数：Dunnett 校正回答「A 和 B 谁显著不同」，但不回答
 * 「该上哪个」。真实决策是选最大值，而**最大值是有偏的**（赢家诅咒：
 * 3 个臂里挑最大的，即便全零也会挑出一个 +1.2pp）。
 *
 * 做法：给定臂 i 的估计值 Mᵢ = x，其余臂独立，于是
 *   P(i 最优 | Mᵢ=x) = ∏_{j≠i} Φ((x − M̂ⱼ)/seⱼ)
 * 再对 x ~ N(M̂ᵢ, seᵢ²) 积分——又是一维，GH 求积。
 * 注意对照臂的均值在「i 是否优于 j」里会抵消（Δᵢ−Δⱼ = Mᵢ−Mⱼ），所以只需要各臂均值本身。
 */
export function probabilityBest(input: BestInput): BestResult {
  const { estimate, se, label } = input;
  const k = estimate.length;
  if (k === 0) return { prob: [], bestIndex: -1, bestProb: 0, winnerCurse: 0 };
  if (k === 1) return { prob: [1], bestIndex: 0, bestProb: 1, winnerCurse: 0 };
  const prob = estimate.map((e, i) => {
    const s = se[i];
    if (!(s > 0)) {
      // 方差为 0 的退化臂：只在它是唯一最大值时给 1
      const isMax = estimate.every((v, j) => j === i || v < e);
      return isMax ? 1 : 0;
    }
    return integrateNormal((u) => {
      const x = e + s * u;
      let p = 1;
      for (let j = 0; j < k; j++) {
        if (j === i) continue;
        const sj = se[j];
        if (!(sj > 0)) {
          if (estimate[j] >= x) return 0;
          continue;
        }
        p *= normalCdf((x - estimate[j]) / sj);
        if (p === 0) return 0;
      }
      return p;
    });
  });
  const total = prob.reduce((a, b) => a + b, 0);
  const norm = total > 0 ? prob.map((p) => p / total) : estimate.map((_, i) => (i === 0 ? 1 : 0));
  let bestIndex = 0;
  for (let i = 1; i < k; i++) if (norm[i] > norm[bestIndex]) bestIndex = i;
  // 赢家诅咒的粗估：被选中臂的最大后验概率对应的「选择偏差」= E[max 噪声]（用极值近似）
  const curse = winnerCurse(se, k);
  void label;
  return { prob: norm, bestIndex, bestProb: norm[bestIndex], winnerCurse: curse };
}

/**
 * 赢家诅咒的量级：k 个独立 N(0, se²) 的最大值的期望。
 * 用 se 的均值和极值近似 E[max] ≈ σ·(√(2 ln k) − (ln ln k + ln 4π)/(2√(2 ln k)))。
 * 它回答的是「即便全部无效，挑出来的赢家看起来有多大」——所以必须写在赢家卡片旁边。
 */
export function winnerCurse(se: number[], k: number): number {
  const kk = Math.max(2, k);
  const s = se.length ? se.reduce((a, b) => a + b, 0) / se.length : 0;
  const l = Math.log(kk);
  const eMax = Math.sqrt(2 * l) - (Math.log(l) + Math.log(4 * Math.PI)) / (2 * Math.sqrt(2 * l));
  return s * eMax;
}

// ===================== 全局检验（k 臂是否至少有一个不同） =====================

export interface GlobalTestResult {
  /** 二次型 Q = Δ' Σ⁻¹ Δ */
  chi2: number;
  df: number;
  p: number;
}

/**
 * 全局检验：H0「所有臂与对照无差异」。Q = Δ'Σ⁻¹Δ ~ χ²_{k−1}。
 *
 * Σ 是差值向量协方差：对角 = seᵢ²（差值本身的方差），非对角 = se₀²（共享对照）。
 * 写成 Σ = D + se₀²·11ᵀ，其中 D 的对角是**处理臂自己的方差** seᵢ²−se₀²，
 * 再用 Sherman–Morrison 求逆（不引入矩阵库）：
 *   Σ⁻¹ = D⁻¹ − se₀²·D⁻¹11ᵀD⁻¹ / (1 + se₀²·1ᵀD⁻¹1)
 * 于是 Q = Σ dᵢΔᵢ² − se₀²(Σ dᵢΔᵢ)² / (1 + se₀²Σdᵢ)，dᵢ = 1/(seᵢ²−se₀²)。
 * m=1 时它必须退化成 (Δ/se)²，这是单测的第一条断言（写错 dᵢ 会立刻暴露）。
 *
 * 注意它**不替代** Dunnett：全局显著只说明「至少有一个不同」，
 * 要回答「哪个不同」还得回到校正后的逐臂区间。两者都报，是因为全局检验能一句话回答
 * 「这个实验到底测出东西没有」，而逐臂 p 不能。
 */
export function globalTest(input: DunnettInput): GlobalTestResult {
  const { diff, se, seControl } = input;
  const m = diff.length;
  if (m === 0) return { chi2: 0, df: 0, p: 1 };
  const d = se.map((s) => 1 / treatmentVar(s, seControl));
  let sum = 0;
  let sumD = 0;
  let sumDD = 0;
  for (let i = 0; i < m; i++) {
    sum += d[i] * diff[i] * diff[i];
    sumD += d[i];
    sumDD += d[i] * diff[i];
  }
  const denom = 1 + seControl * seControl * sumD;
  const q = denom > 0 ? sum - (seControl * seControl * sumDD * sumDD) / denom : sum;
  return { chi2: Math.max(0, q), df: m, p: chi2Sf(Math.max(0, q), m) };
}

// ===================== 多臂样本量（规划） =====================

export interface MultiArmPlanOptions {
  /** 对照基线率 */
  p1: number;
  /** 每个处理臂的目标率（规划时假设各臂效应相同，这是标准做法） */
  p2: number;
  /** 臂数（含对照），≥2 */
  arms: number;
  alpha?: number;
  power?: number;
  cap?: number;
}

export interface MultiArmPlanResult {
  arms: number;
  comparisons: number;
  /** Dunnett 临界值 */
  crit: number;
  /** Bonferroni 临界值（用来展示多花的样本） */
  bonferroniCrit: number;
  /** 每组所需样本（Dunnett 口径） */
  nPerArm: number;
  total: number;
  achievedPower: number;
  /** 同样设计下用 Bonferroni 需要的每组样本（多出来的是「不用相关性」的代价） */
  nPerArmBonferroni: number;
  /** 与两臂设计相比，总流量要乘多少（同样效应、同样 α/power） */
  trafficMultiplier: number;
  /** 估计相关性 ρ（共享对照导致） */
  correlation: number;
  /** 「至少一臂显著」的概率（只用于解读，不参与反解） */
  powerAnyArm: number;
}

/**
 * 「至少一臂显著」的功效：Zᵢ ~ N(λ, 1)，Corr(Zᵢ,Zⱼ) = ρ，
 *   power = 1 − E_u[ ∏ᵢ ( Φ((c−λ+√ρu)/√(1−ρ)) − Φ((−c−λ+√ρu)/√(1−ρ)) ) ]
 *
 * ⚠️ 它**不是**用来算样本量的口径。臂越多这个数越大（多几个机会撞上显著），
 * 会得出「4 臂比 2 臂更省样本」的荒谬结论。规划要用 `powerOneArm`（每臂各自的检出率），
 * 这个数只用来回答另一个问题：「这次实验有多大概率至少测出一个赢家」。
 */
export function powerEqualCorr(shift: number, rho: number, m: number, crit: number): number {
  const sd = Math.sqrt(Math.max(1e-12, 1 - rho));
  const sr = Math.sqrt(Math.max(0, rho));
  const cover = integrateNormal((u) => {
    const hi = normalCdf((crit - shift + sr * u) / sd);
    const lo = normalCdf((-crit - shift + sr * u) / sd);
    return (hi - lo) ** m;
  });
  return Math.min(1, Math.max(0, 1 - cover));
}

/** 单个臂的检出率（边际功效）：P(|Zᵢ| > c)，Zᵢ ~ N(λ, 1)。样本量规划用这个。 */
export function powerOneArm(shift: number, crit: number): number {
  return Math.min(1, normalCdf(shift - crit) + normalCdf(-shift - crit));
}

export function sampleSizeMultiArm(opts: MultiArmPlanOptions): MultiArmPlanResult {
  const { p1, p2 } = opts;
  const arms = Math.max(2, Math.round(opts.arms));
  const m = arms - 1;
  const alpha = opts.alpha ?? 0.05;
  const target = opts.power ?? 0.8;
  const cap = opts.cap ?? 50_000_000;
  if (!(p1 > 0 && p1 < 1) || !(p2 > 0 && p2 < 1)) throw new Error('基线率与目标率都必须在 (0,1) 之间');
  if (p1 === p2) throw new Error('目标率与基线相同：效应为 0 时任何样本量都测不出来');

  // 相关性只取决于两臂方差之比，与 n 无关（这是等分流假设下的性质）
  const v1 = p1 * (1 - p1);
  const v2 = p2 * (1 - p2);
  const rho = v1 / (v1 + v2);

  const crit = dunnettCritEqual(alpha, arms, rho);
  const bonferroniCrit = normalInv(1 - alpha / (2 * m));

  const shiftAt = (n: number) => {
    const se = Math.sqrt(v1 / n + v2 / n);
    return se > 0 ? Math.abs(p2 - p1) / se : Infinity;
  };
  const powerAt = (n: number, c: number) => powerOneArm(shiftAt(n), c);

  const solve = (c: number): number => {
    let hi = 64;
    while (powerAt(hi, c) < target) {
      hi *= 2;
      if (hi > cap) throw new Error('在这个流量下需要超过 5000 万样本/组，实际上不可行——请放大要检测的效应');
    }
    let lo = 2;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (powerAt(mid, c) >= target) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };

  const nPerArm = solve(crit);
  const nBonf = solve(bonferroniCrit);
  const twoArm = solve(normalInv(1 - alpha / 2));
  return {
    arms,
    comparisons: m,
    crit,
    bonferroniCrit,
    nPerArm,
    total: nPerArm * arms,
    achievedPower: powerAt(nPerArm, crit),
    nPerArmBonferroni: nBonf,
    trafficMultiplier: twoArm > 0 ? (nPerArm * arms) / (twoArm * 2) : 1,
    correlation: rho,
    /** 同一设计下「至少一臂显著」的概率（通常明显高于 80%，不是规划口径） */
    powerAnyArm: powerEqualCorr(shiftAt(nPerArm), rho, m, crit),
  };
}

/**
 * 反方向：给定「每组只能跑 n 人」，多臂设计最多能检出多大的相对提升。
 *
 * 为什么不能用两臂的 MDE 公式再乘个系数：Dunnett 临界值本身依赖 ρ，
 * 而 ρ = v₁/(v₁+v₂) 又依赖 p₂——「要检出的效应」和「临界值」互相牵制。
 * 所以这里对 p₂ 做二分：功效随 p₂ 单调增（效应越大越容易检出），可直接收敛。
 */
export function mdeMultiArmRate(opts: {
  p1: number;
  arms: number;
  nPerArm: number;
  alpha?: number;
  power?: number;
}): { p2: number; mdeAbs: number; mdeRel: number; crit: number } {
  const arms = Math.max(2, Math.round(opts.arms));
  const alpha = opts.alpha ?? 0.05;
  const target = opts.power ?? 0.8;
  const n = opts.nPerArm;
  const p1 = opts.p1;
  if (!(n >= 2)) throw new Error('每组样本至少 2 人');
  if (!(p1 > 0 && p1 < 1)) throw new Error('基线率必须在 (0,1) 之间');

  const critAt = (p2: number) => {
    const v1 = p1 * (1 - p1);
    const v2 = p2 * (1 - p2);
    return dunnettCritEqual(alpha, arms, v1 / (v1 + v2));
  };
  const poweredAt = (p2: number) => {
    const se = Math.sqrt(v1Of(p1) / n + v1Of(p2) / n);
    if (!(se > 0)) return true;
    return powerOneArm(Math.abs(p2 - p1) / se, critAt(p2)) >= target;
  };
  // 上限取 min(1−ε, 2p₁)：再大的相对提升在真实实验里不叫效应，叫新功能
  const hi = Math.min(1 - 1e-6, Math.min(1, p1 * 2) - 1e-9);
  if (!poweredAt(hi)) {
    throw new Error(
      `每组 ${n} 人、${arms} 个臂，即使提升 100% 也达不到 ${(target * 100).toFixed(0)}% 功效——请加长实验或减少臂数`,
    );
  }
  let lo = p1 + 1e-9;
  let high = hi;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + high) / 2;
    if (poweredAt(mid)) high = mid;
    else lo = mid;
  }
  const p2 = high;
  return { p2, mdeAbs: p2 - p1, mdeRel: (p2 - p1) / p1, crit: critAt(p2) };
}

/** p(1−p)，独立成函数只为了让上面的公式读起来跟纸面一致 */
function v1Of(p: number): number {
  return p * (1 - p);
}

export interface MultiArmContinuousPlan {
  sd: number;
  delta: number;
  arms: number;
  alpha?: number;
  power?: number;
}
/** 连续指标（ARPU / 时长）的多臂样本量：ρ=0.5（两臂方差相同），Δ 用指标自身单位 */
export function sampleSizeMultiArmContinuous(opts: MultiArmContinuousPlan): {
  nPerArm: number;
  total: number;
  crit: number;
  nPerArmBonferroni: number;
  bonferroniCrit: number;
} {
  const arms = Math.max(2, Math.round(opts.arms));
  const m = arms - 1;
  const alpha = opts.alpha ?? 0.05;
  const target = opts.power ?? 0.8;
  if (!(opts.sd > 0)) throw new Error('标准差必须大于 0');
  if (!(Math.abs(opts.delta) > 0)) throw new Error('要检出的差值不能为 0');
  const crit = dunnettCritEqual(alpha, arms, 0.5);
  const bonf = normalInv(1 - alpha / (2 * m));
  const shiftAt = (n: number) => (Math.abs(opts.delta) * Math.sqrt(n)) / (opts.sd * Math.SQRT2);
  const solve = (c: number) => {
    // λ = Δ/(σ√(2/n)) → 每臂功效随 n 单调增
    let hi = 64;
    while (powerOneArm(shiftAt(hi), c) < target) {
      hi *= 2;
      if (hi > 50_000_000) throw new Error('所需样本超过 5000 万/组，请放大要检测的差值');
    }
    let lo = 2;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (powerOneArm(shiftAt(mid), c) >= target) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  const nPerArm = solve(crit);
  return { nPerArm, total: nPerArm * arms, crit, nPerArmBonferroni: solve(bonf), bonferroniCrit: bonf };
}

// ===================== 分流比例 =====================

/**
 * 解析分流声明：`50/25/25`、`1:1:1`、`50%, 25%, 25%` 都认。
 * 解析不出来就返回 null，由调用方退回「等分流」并在 UI 上标明——
 * 猜一个分流比例去做 SRM 检查，比不做更危险（会把正常实验判成异常）。
 */
export function parseAllocation(raw: string | undefined | null): number[] | null {
  if (!raw) return null;
  const nums = String(raw)
    .replace(/[%％]/g, '')
    .split(/[/:：,，\s|]+/)
    .map((s) => Number(s.trim()))
    .filter((v) => Number.isFinite(v) && v >= 0);
  if (nums.length < 2) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return null;
  return nums.map((v) => v / sum);
}
