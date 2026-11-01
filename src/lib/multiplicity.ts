/**
 * 多重比较：把「一起看 120 个实验」这件事算清楚（A6）。
 *
 * 一个工程团队最常见的错误不是统计做错，而是**看太多**：
 * 120 个实验各自用 α=0.05 判，即使全部无效，至少出现一个"显著"的概率是
 * 1 − 0.95¹²⁰ ≈ 99.8% —— 「总有一个能上线」不是运气，是算术。
 *
 * 三种校正口径，对应三种不同的错误定义，不能混着说：
 *   - **Bonferroni**：每个都除以 m，最简单也最保守（检验之间不独立时尤其浪费功效）
 *   - **Holm**：逐步下降版 Bonferroni，同样控 FWER，但一旦拒掉一个就放宽一点 → 永远 ≥ Bonferroni 的功效
 *   - **BH**：控 FDR（被拒里假阳性的比例），最宽松；适合「筛线索」，不适合「下结论」
 *
 * 本项目的分工：
 *   - 跨实验清单 → **Holm**（要下结论：63 个实验"显著"里错一个，就会上线一个没用的版本）
 *   - 单实验内分层扫描 → **BH**（找线索：漏掉一个真实分层比多看一眼假分层更贵）
 *
 * 纪律：这一层只做「校正后的判定标在清单上」，**不改任何单个实验的 decision**
 * ——decision 是按单实验口径 + 护栏定的，历史 120 条真值标注不能被清单页的开关改写。
 */

import { bhAdjust, bonferroniAdjust, holmAdjust } from './stats.ts';

export interface FamilyMember {
  id: string;
  name?: string;
  /** 主指标的原始 p（单实验口径） */
  p: number;
  decision: string;
  archetype?: string;
  /** 合成数据才有：真实效应（用来核对"校正后还在的是不是真有效"） */
  trueEffect?: number | null;
  trueDecision?: string;
}

export interface FamilyRow extends FamilyMember {
  /** Holm 校正后 p */
  pHolm: number;
  holmSig: boolean;
  /** Bonferroni 校正后 p */
  pBonferroni: number;
  bonferroniSig: boolean;
  /** BH 校正后 q（q 默认取 alpha，便于与 Holm 直接对比） */
  pBH: number;
  bhSig: boolean;
  /** 原始 p 就显著、但 Holm 之后不显著 → 清单上要标出来 */
  rescinded: boolean;
}

export interface FamilyReport {
  n: number;
  alpha: number;
  fdr: number;
  /** 四种口径下「显著」的条数 */
  naiveSig: number;
  holmSig: number;
  bonferroniSig: number;
  bhSig: number;
  /** 被 Holm 收回的条数 / 其中真实无效的条数（合成数据才有） */
  rescinded: number;
  rescindedFalse: number | null;
  /** 全零假设族下"至少一个显著"的理论比例 1−(1−α)^m —— 就是"总有一个能上线"的数学 */
  naiveAnySig: number;
  rows: FamilyRow[];
}

export function familyReport(members: FamilyMember[], alpha = 0.05, fdr = 0.1): FamilyReport {
  const n = members.length;
  const ps = members.map((m) => (Number.isFinite(m.p) ? m.p : 1));
  const holm = holmAdjust(ps, alpha);
  const bonf = bonferroniAdjust(ps, alpha);
  const bh = bhAdjust(ps, fdr);

  const rows: FamilyRow[] = members.map((m, i) => ({
    ...m,
    pHolm: holm.adjusted[i],
    holmSig: holm.rejected[i],
    pBonferroni: bonf.adjusted[i],
    bonferroniSig: bonf.rejected[i],
    pBH: bh.qvals[i],
    bhSig: bh.rejected[i],
    rescinded: m.p <= alpha && !holm.rejected[i],
  }));

  const rescindedRows = rows.filter((r) => r.rescinded);
  const hasTruth = members.some((m) => m.trueEffect !== undefined && m.trueEffect !== null);

  return {
    n,
    alpha,
    fdr,
    naiveSig: members.filter((m) => m.p <= alpha).length,
    holmSig: holm.rejected.filter(Boolean).length,
    bonferroniSig: bonf.rejected.filter(Boolean).length,
    bhSig: bh.rejected.filter(Boolean).length,
    rescinded: rescindedRows.length,
    rescindedFalse: hasTruth ? rescindedRows.filter((r) => !(Math.abs(r.trueEffect ?? 0) > 1e-9)).length : null,
    naiveAnySig: 1 - Math.pow(1 - alpha, n),
    rows,
  };
}

export interface FwerSim {
  m: number;
  alpha: number;
  trials: number;
  /** 全零假设族里"至少一个被判显著"的比例（应 ≈α） */
  holm: number;
  bonferroni: number;
  bh: number;
  /** 不校正时这个比例会膨胀到接近 1 */
  naive: number;
  /** 理论值 1−(1−α)^m */
  naiveTheory: number;
}

/**
 * 全零假设族的 FWER 模拟。
 *
 * 刻意用「独立均匀 p 值」而不是引擎跑出来的 p：
 *   - 这是**校正方法本身**的正确性证据，与我们的数据无关，换谁来跑都该是这个量级；
 *   - 用引擎的 p 会把数据里的相关性与真实效应混进来，反而看不清校正有没有生效。
 * 真实数据上的效果单独在 `scripts/fwer_report.ts` 的第 ② 段实测。
 */
export function simulateFwer(m = 120, trials = 2000, seed = 20261101, alpha = 0.05): FwerSim {
  let s = seed >>> 0;
  const rnd = () => {
    // xorshift32：够快且对均匀性没有要求上的坑（不用正态逆变换）
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return (s + 0.5) / 4294967296;
  };
  let naive = 0;
  let holm = 0;
  let bonf = 0;
  let bh = 0;
  for (let t = 0; t < trials; t++) {
    const ps = Array.from({ length: m }, () => rnd());
    if (ps.some((p) => p <= alpha)) naive++;
    if (holmAdjust(ps, alpha).rejected.some(Boolean)) holm++;
    if (bonferroniAdjust(ps, alpha).rejected.some(Boolean)) bonf++;
    if (bhAdjust(ps, alpha).rejected.some(Boolean)) bh++;
  }
  return {
    m,
    alpha,
    trials,
    naive: naive / trials,
    holm: holm / trials,
    bonferroni: bonf / trials,
    bh: bh / trials,
    naiveTheory: 1 - Math.pow(1 - alpha, m),
  };
}
