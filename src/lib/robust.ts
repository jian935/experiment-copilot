/**
 * 稳健性诊断：极端值（长尾）到底在多大程度上决定了 ARPU 的结论。
 *
 * ## 为什么这件事对 ARPU 比对转化率重要一个量级
 *
 * 转化率有伯努利结构：均值唯一决定方差，极端值最多把某一行推到 100%。
 * ARPU 没有这个结构 —— 同样 ARPU = 3.8 元，可能是「人人 3.8 元」，
 * 也可能是「2% 的用户付了 190 元」。后一种情况下：
 *   - 点估计被几十个人主导（删掉 3 个人，结论就能从 +5% 变成 −2%）；
 *   - 方差同样被他们主导，delta method 的 SE 剧烈抖动；
 *   - 而这几十个人往往正是**最不像普通用户**的那批（代购、黄牛、B 端账号）。
 * 所以「先看极端值有没有在替你做决定」不是卫生习惯，是 ARPU 分析的前置动作。
 *
 * ## 为什么是截尾（winsorize）而不是删掉（trim → drop）
 *
 * 删掉极端行 = 连分母一起删 = **改变了指标定义**（「人均消费」里少了几个人）。
 * 截尾是「把他们按分位线的水平计」：分母不动、含义不动，只是不让极端值无限放大。
 * 这是本质区别，不是术语偏好 —— drop 之后你算的不再是 ARPU。
 *
 * ## 截尾单位 = 行，且**不按曝光加权**（这条决定了它在两种数据上都成立）
 *
 * 我们的数据可能是两种形态：
 *   - **用户级明细**：一行一个用户，`exposures = 1`，`sum/n` 就是这个人自己的消费；
 *   - **聚合格子**：一行是 日期 × 臂 × 设备 × 人群，`exposures` 上千，`sum/n` 是这格的人均。
 *
 * 于是「行」是唯一在两种形态下都成立的单位，而且它不是权宜之计 ——
 * `ratioTest` 的方差本来就把**每一行当成一个抽样单元**（聚类均值方差）。
 * 对抽样单元做截尾，和估计量自己的抽样模型是一致的；反过来，
 * 若按曝光加权定分位线，一行占 1.8% 流量时分位线永远落在这一行**内部**，
 * 1% 档一根都截不到 —— 那个「稳健性检查」什么都没检查就报了「稳定」，比不做更糟。
 *
 * 已知边界（界面上必须写）：聚合数据上，截掉一行 = 去掉「某一天 / 某个人群的整格异常」，
 * 控制不了格子**内部**的用户长尾；要真正的用户级截尾，需要用户级明细表。
 * 这条由 `granularity` 字段如实报出，并用 `exposureTouchedShare` 给出「你刚刚压平了
 * 多少流量」——两个数字一起看，读者才知道这次截尾到底动了什么。
 *
 * ## 为什么只看右尾
 *
 * 左尾（收入 = 0 的非付费用户）不是异常值，是 ARPU 的**主体**（通常 90%+ 曝光不付费）。
 * 按左尾截尾等于「假装所有人都买了」，会把 ARPU 抬高一个量级 —— 那是做错，不是做稳。
 * 所以下界默认关闭；只有指标本身是「客单价」这类左尾确实是录入错误时才该打开。
 *
 * ## 截尾后的 p 值不是名义 α 下的有效检验
 *
 * 分位数是**看着数据定的**，截尾后的统计量不再服从原分布，p 值也就没有 5% 的第一类错误保证。
 * 它只有一种用途、且必须只用在这一个用途上：**回答「结论会不会翻转」**。
 * 若把它当成「我又跑了一次更稳的检验，p=0.03，所以更可信」，那是在用数据依赖的变换
 * 伪造确定性。这句话写成 `CAVEAT` 常量，UI / 报告 / 文档共用。
 */

import { quantile, ratioTest, type RatioCell } from './stats.ts';

/**
 * 一句话说清「截尾 p 值」的边界。UI、报告脚本、文档都引用这一个常量，
 * 避免三处各写一版、措辞漂移。
 */
export const CAVEAT =
  '截尾分位是看着数据定下来的，所以截尾后的 p 值不再服从名义 α 分布。它的用途只有「结论会不会翻转」这一个，不能当成第二个显著性结论去引用。';

/** 参与稳健性诊断的格子。与 RatioCell 同形，多带展示字段 */
export interface RobustCell extends RatioCell {
  /** 展示用标签（日期 · 设备 · 人群） */
  label?: string;
  /** 稳定 id，影响力表格按它定位 */
  key?: string;
}

export interface ArmWinsorStat {
  /** 上界截尾比例（0.01 = 截掉最高的 1%） */
  p: number;
  /** 下界分位（每单位值）；下界关闭时为 -Infinity */
  lower: number;
  /** 上界分位（每单位值）；上界关闭时为 Infinity */
  upper: number;
  /** 被抬升 / 压平的行数 */
  clippedLow: number;
  clippedHigh: number;
  /** 被截行的曝光数（绝对值） */
  touchedExposures: number;
  /** 被截行的曝光占该臂总曝光的比例 —— 「你刚刚压平了多少流量」 */
  exposureTouchedShare: number;
  revenueBefore: number;
  revenueAfter: number;
  cells: number;
}

/** 单臂截尾：返回截断后的格子与该臂的截尾统计 */
function clampArm(
  group: RobustCell[],
  lowerP: number,
  upperP: number,
): { out: RobustCell[]; stat: ArmWinsorStat } {
  const revenueBefore = group.reduce((s, c) => s + c.sum, 0);
  const totalN = group.reduce((s, c) => s + c.n, 0);
  const base = {
    p: upperP,
    cells: group.length,
    revenueBefore,
    revenueAfter: revenueBefore,
    clippedLow: 0,
    clippedHigh: 0,
    touchedExposures: 0,
    exposureTouchedShare: 0,
  };
  if (!(lowerP > 0) && !(upperP > 0)) {
    return { out: group, stat: { ...base, lower: -Infinity, upper: Infinity } };
  }
  const vals = group.map((c) => c.sum / c.n);
  const lower = lowerP > 0 ? quantile(vals, lowerP) : -Infinity;
  const upper = upperP > 0 ? quantile(vals, 1 - upperP) : Infinity;
  // 相对容差：分位线可能**正好等于**某一行的值，此时 1ulp 的乘法误差
  // 不该把那一行算成「被截掉」，否则「截尾 0%」这一档就不再逐位等于原始口径。
  const tol = 1e-12;
  let clippedLow = 0;
  let clippedHigh = 0;
  let touched = 0;
  let revenueAfter = 0;
  const out = group.map((c) => {
    const v = c.sum / c.n;
    if (Number.isFinite(upper) && v > upper * (1 + tol)) {
      clippedHigh++;
      touched += c.n;
      const sum = upper * c.n;
      revenueAfter += sum;
      return { ...c, sum };
    }
    if (Number.isFinite(lower) && v < lower * (1 - tol)) {
      clippedLow++;
      touched += c.n;
      const sum = lower * c.n;
      revenueAfter += sum;
      return { ...c, sum };
    }
    revenueAfter += c.sum;
    return c;
  });
  return {
    out,
    stat: {
      ...base,
      lower,
      upper,
      clippedLow,
      clippedHigh,
      touchedExposures: touched,
      exposureTouchedShare: totalN > 0 ? touched / totalN : 0,
      revenueAfter,
    },
  };
}

/**
 * 按臂各自做截尾。
 *
 * 为什么按臂而不是两臂合并定分位线：合并定线会让**处理臂的数据影响对照臂的截尾门槛**
 * （处理臂长尾更重 → 合并分位线更高 → 对照臂几乎不被截），两臂的指标定义就不再对称。
 * 分臂截尾是 Eppo / Statsig 的做法，也让「每臂各自的 ARPU 分位」这句话成立。
 */
export function winsorizeCells(
  cells: RobustCell[],
  lowerP = 0,
  upperP = 0.01,
): { cells: RobustCell[]; control: ArmWinsorStat; treatment: ArmWinsorStat } {
  const c = clampArm(cells.filter((x) => !x.treatment && x.n > 0), lowerP, upperP);
  const t = clampArm(cells.filter((x) => x.treatment && x.n > 0), lowerP, upperP);
  return { cells: [...c.out, ...t.out], control: c.stat, treatment: t.stat };
}

export interface SensitivityPoint {
  /** 截尾比例（0 = 原始口径） */
  p: number;
  diff: number;
  pValue: number;
  ci95: [number, number];
  controlValue: number;
  treatmentValue: number;
  /** 双侧 p < α */
  sig: boolean;
  /** 被压平的行数（两臂合计） */
  clippedHigh: number;
  /** 被截行占两臂总曝光的比例 */
  exposureTouchedShare: number;
  /** 截尾后保留的收入比例（越低说明被截掉的钱越多） */
  revenueRetained: number;
}

function pointOf(cells: RobustCell[], p: number, alpha: number): SensitivityPoint | null {
  const w = winsorizeCells(cells, 0, p);
  const rt = ratioTest(w.cells);
  if (!rt) return null;
  const before = w.control.revenueBefore + w.treatment.revenueBefore;
  const after = w.control.revenueAfter + w.treatment.revenueAfter;
  const touched = w.control.touchedExposures + w.treatment.touchedExposures;
  const nAll = totalNOf(cells);
  return {
    p,
    diff: rt.diff,
    pValue: rt.p,
    ci95: rt.ci95,
    controlValue: rt.controlValue,
    treatmentValue: rt.treatmentValue,
    sig: rt.p < alpha,
    clippedHigh: w.control.clippedHigh + w.treatment.clippedHigh,
    exposureTouchedShare: nAll > 0 ? touched / nAll : 0,
    revenueRetained: before > 0 ? after / before : 1,
  };
}

/** 全部曝光数（两臂合计） */
function totalNOf(cells: RobustCell[]): number {
  return cells.reduce((s, c) => s + (c.n > 0 ? c.n : 0), 0);
}

export interface Concentration {
  /** 有收入的曝光占总曝光比例（ARPU 里「谁在付钱」的骨架） */
  payerShare: number;
  /** 按每曝光收入降序，最重的前 pct 曝光贡献了多少收入 */
  top: Array<{ pct: number; revenueShare: number }>;
  /** 每曝光收入的 Gini（0 = 人人相等，1 = 全在一人身上） */
  gini: number;
  totalRevenue: number;
  totalExposures: number;
}

/**
 * 收入集中度。
 *
 * 为什么它比截尾本身更有诊断力：截尾回答「去掉极端值会怎样」，
 * 集中度直接回答「极端值到底占多少」—— 后者不依赖任何分位选择，是数据本身的性质。
 * 两者一起看才有判断：集中度高而截尾后结论不变 = 长尾虽重但两臂对称；
 * 集中度高且结论翻转 = 长尾在替你做决定。
 */
export function concentrationOf(cells: RobustCell[]): Concentration {
  const use = cells.filter((c) => c.n > 0);
  const totalExposures = use.reduce((s, c) => s + c.n, 0);
  const totalRevenue = use.reduce((s, c) => s + c.sum, 0);
  const payerExposures = use.reduce((s, c) => s + (c.sum > 0 ? c.n : 0), 0);
  if (!(totalExposures > 0) || !(totalRevenue > 0)) {
    return { payerShare: 0, top: [], gini: 0, totalRevenue, totalExposures };
  }
  const desc = [...use].sort((a, b) => b.sum / b.n - a.sum / a.n);
  const top: Array<{ pct: number; revenueShare: number }> = [];
  for (const pct of [0.01, 0.05, 0.1]) {
    const target = totalExposures * pct;
    let accN = 0;
    let accR = 0;
    for (const c of desc) {
      accN += c.n;
      accR += c.sum;
      if (accN >= target) break;
    }
    top.push({ pct, revenueShare: accR / totalRevenue });
  }
  // 加权 Gini：把每行的曝光当重复次数展开后的标准定义
  const asc = [...use].sort((a, b) => a.sum / a.n - b.sum / b.n);
  const N = totalExposures;
  let S = 0;
  let cumW = 0;
  for (const c of asc) {
    const v = c.sum / c.n;
    S += v * c.n * (cumW + (c.n + 1) / 2);
    cumW += c.n;
  }
  const gini = Math.max(0, Math.min(1, (2 * S) / (N * totalRevenue) - (N + 1) / N));
  return {
    payerShare: payerExposures / totalExposures,
    top,
    gini,
    totalRevenue,
    totalExposures,
  };
}

export interface LeverageRow {
  key: string;
  label: string;
  arm: string;
  n: number;
  sum: number;
  /** 该行的每曝光收入 */
  arpu: number;
  /** 这一行收入占**该臂**总收入的比例 */
  shareOfArmRevenue: number;
  /** 删掉这一行后的差值 / p */
  diffWithout: number;
  pWithout: number;
  dDiff: number;
  dP: number;
}

/**
 * 单点杠杆：哪几行在决定差值。
 *
 * 口径是 leave-one-row-out（真的把那一行删掉重算一遍），不是解析近似。
 * 为什么不用 Cook's distance 那类闭式影响函数：ARPU 是比值估计量，
 * 一行同时经分子和分母两条路径发力，闭式公式很容易写成「只对分子求导」——
 * 看起来更专业，在这套指标上却是错的。行数只有几十到几百，
 * 精确重算最贵也就十几次 ratioTest，没有性能理由去换近似。
 */
export function leverageRows(
  cells: RobustCell[],
  k = 3,
  controlArm = 'control',
  treatmentArm = 'treatment',
): LeverageRow[] {
  const use = cells.filter((c) => c.n > 0);
  const base = ratioTest(use);
  if (!base) return [];
  const armMean = (isT: boolean) => {
    const g = use.filter((c) => c.treatment === isT);
    const n = g.reduce((s, c) => s + c.n, 0);
    const sum = g.reduce((s, c) => s + c.sum, 0);
    return n > 0 ? sum / n : 0;
  };
  const armRevenue = (isT: boolean) => use.filter((c) => c.treatment === isT).reduce((s, c) => s + c.sum, 0);
  const mc = armMean(false);
  const mt = armMean(true);
  const rc = armRevenue(false);
  const rt = armRevenue(true);

  // 候选：每臂「超出该臂人均收入的绝对金额」最大的几行 —— 那才是能撬动比值的行
  const scored = use
    .map((c) => ({ c, excess: Math.abs(c.sum - (c.treatment ? mt : mc) * c.n) }))
    .sort((a, b) => b.excess - a.excess)
    .slice(0, Math.max(1, k * 2));

  const out: LeverageRow[] = [];
  const seen = new Set<string>();
  for (const { c } of scored) {
    const key = c.key ?? c.label ?? `${c.treatment}-${c.n}-${c.sum}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rest = use.filter((x) => x !== c);
    const r = ratioTest(rest);
    if (!r) continue;
    const share = c.treatment ? (rt > 0 ? c.sum / rt : 0) : (rc > 0 ? c.sum / rc : 0);
    out.push({
      key,
      label: c.label ?? key,
      arm: c.treatment ? treatmentArm : controlArm,
      n: c.n,
      sum: c.sum,
      arpu: c.sum / c.n,
      shareOfArmRevenue: share,
      diffWithout: r.diff,
      pWithout: r.p,
      dDiff: r.diff - base.diff,
      dP: r.p - base.p,
    });
  }
  // 按「对差值的实际影响力」排序，取前 k 条
  return out.sort((a, b) => Math.abs(b.dDiff) - Math.abs(a.dDiff)).slice(0, k);
}

export interface RobustnessReport {
  verdict: 'stable' | 'sensitive' | 'flip' | 'unavailable';
  /** 中文一句话结论（UI 直接显示） */
  reason: string;
  grid: SensitivityPoint[];
  concentration: Concentration;
  leverage: LeverageRow[];
  /** 每行曝光的中位数：判断截尾作用在「用户级」还是「整格」 */
  medianExposuresPerRow: number;
  /**
   * 数据粒度判断。'user' = 每行基本就是一两个人（截尾真的作用于用户）；
   * 'cell' = 每行是聚合格子（截尾只能去掉整格异常）。
   */
  granularity: 'user' | 'cell';
  /** 参考档位（默认 1%）下各臂的截尾统计，展示用 */
  arms: { control: ArmWinsorStat; treatment: ArmWinsorStat };
  /** 截尾让差值变动最大多少（绝对量，与主指标同单位） */
  maxAbsChange: number;
  /** 同上，换成「相当于对照基准的百分比」—— 差值为 0 时也不会除爆 */
  maxRelChange: number;
  caveat: string;
}

export interface RobustnessOptions {
  /** 显著性水平（与决策同口径） */
  alpha?: number;
  /** 扫描的截尾档位；第一档应为 0（原始口径） */
  grid?: number[];
  /** 影响力诊断取前几条 */
  leverageK?: number;
  /** 每臂最少几行才给诊断（太少算不出分位数） */
  minCellsPerArm?: number;
  /** `arms` 字段用的参考截尾比例（默认 1%） */
  refP?: number;
  controlArm?: string;
  treatmentArm?: string;
}

const DEFAULT_GRID = [0, 0.005, 0.01, 0.02, 0.05];

/** 中位数（不依赖排序稳定性的朴素实现） */
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 未截尾的臂统计（「算不出来」的分支也要给真实数字，不能填 0 假装看过） */
function rawStat(group: RobustCell[]): ArmWinsorStat {
  const rev = group.reduce((s, c) => s + c.sum, 0);
  return {
    p: 0,
    lower: -Infinity,
    upper: Infinity,
    clippedLow: 0,
    clippedHigh: 0,
    exposureTouchedShare: 0,
    touchedExposures: 0,
    revenueBefore: rev,
    revenueAfter: rev,
    cells: group.length,
  };
}

/** 金额格式化（主指标单位是元）—— 只写一次，UI 与报告共用 */
export function fmtYuan(v: number): string {
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(0);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

/**
 * 组装稳健性诊断。
 *
 * 返回值恒为 `RobustnessReport`（哪怕不可用也返回），因为 UI 需要在「算不出来」时
 * 说明原因，而不是静默隐藏一块 —— 隐藏会让人以为「查过了，没问题」。
 */
export function robustnessReport(cells: RobustCell[], opts: RobustnessOptions = {}): RobustnessReport {
  const alpha = opts.alpha ?? 0.05;
  const grid = opts.grid && opts.grid.length ? opts.grid : DEFAULT_GRID;
  const minCells = opts.minCellsPerArm ?? 4;
  const controlArm = opts.controlArm ?? 'control';
  const treatmentArm = opts.treatmentArm ?? 'treatment';

  const use = cells.filter((c) => c.n > 0);
  const gc = use.filter((c) => !c.treatment);
  const gt = use.filter((c) => c.treatment);
  const kc = gc.length;
  const kt = gt.length;
  const concentration = concentrationOf(use);
  const medianExposuresPerRow = median(use.map((c) => c.n));
  // 阈值 2：一行平均一两个人 → 基本就是用户级明细；否则是聚合格子
  const granularity: 'user' | 'cell' = medianExposuresPerRow <= 2 ? 'user' : 'cell';

  /** 「算不出来」的统一出口：仍带上真实数字与原因，UI 不隐藏这一块 */
  const unavailable = (reason: string, pts: SensitivityPoint[]): RobustnessReport => ({
    verdict: 'unavailable',
    reason,
    grid: pts,
    concentration,
    leverage: [],
    medianExposuresPerRow,
    granularity,
    arms: { control: rawStat(gc), treatment: rawStat(gt) },
    maxAbsChange: 0,
    maxRelChange: 0,
    caveat: CAVEAT,
  });

  if (kc < minCells || kt < minCells) {
    return unavailable(
      `每臂独立格子不足 ${minCells} 个（对照 ${kc}、处理 ${kt}）：分位数在小样本上没有意义，不做截尾诊断。多导几天数据（或多切几层人群）即可恢复。`,
      [],
    );
  }

  const points: SensitivityPoint[] = [];
  for (const p of grid) {
    const pt = pointOf(use, p, alpha);
    if (pt) points.push(pt);
  }
  if (points.length < 2) {
    return unavailable('截尾扫描没有跑出有效档位（两臂的独立格子太少或分布退化），不做判定。', points);
  }

  const base = points[0];
  const rest = points.slice(1);
  const scale = Math.abs(base.controlValue) > 1e-9 ? Math.abs(base.controlValue) : 1;
  /**
   * 符号翻转只有在差值本身「有分量」时才是危险的。
   * 纯零效应实验的差值会在 0 附近随机摆动（实测 E060：+0.003 → −0.001 元，相当于基准的 0.1%），
   * 把它报成「符号翻转、最危险的一类」是耸人听闻，也是错的 —— 那种摆动连噪声都算不上方向。
   * 所以要求翻转两侧的差值至少达到基准的 0.2% 才认。
   */
  const MATERIAL = 0.002;
  const signFlip = rest.find(
    (x) =>
      base.diff !== 0 &&
      x.diff !== 0 &&
      Math.sign(x.diff) !== Math.sign(base.diff) &&
      Math.min(Math.abs(x.diff), Math.abs(base.diff)) / scale >= MATERIAL,
  );
  const sigFlip = rest.find((x) => x.sig !== base.sig);
  const verdict: RobustnessReport['verdict'] = signFlip ? 'flip' : sigFlip ? 'sensitive' : 'stable';

  const maxAbsChange = rest.reduce((m, x) => Math.max(m, Math.abs(x.diff - base.diff)), 0);
  const maxRelChange = maxAbsChange / scale;
  const maxP = rest[rest.length - 1].p;

  let reason: string;
  if (verdict === 'stable') {
    // 零附近摆动与「真稳」都要说清，否则会被读成「查过了没问题」
    const noised = rest.find((x) => base.diff !== 0 && x.diff !== 0 && Math.sign(x.diff) !== Math.sign(base.diff));
    reason =
      `截尾到最高 ${(maxP * 100).toFixed(1)}% 时，差值的符号与显著性判定都没有变化（${base.sig ? '始终显著' : '始终不显著'}，` +
      `差值变动最大 ${fmtYuan(maxAbsChange)} 元，相当于对照基准的 ${(maxRelChange * 100).toFixed(2)}%）。` +
      (noised
        ? `注意差值本身只有 ${fmtYuan(base.diff)} 元（基准的 ${((Math.abs(base.diff) / scale) * 100).toFixed(2)}%），符号在 0 附近来回摆，这属于纯噪声、不是「翻转」——结论是「本来就没有效应」，不是「效应稳」。`
        : '结论不是被少数极端行撑起来的。');
  } else if (verdict === 'sensitive') {
    const f = sigFlip!;
    const nearBorder = Math.abs(base.pValue - alpha) < 0.02;
    reason =
      `截掉最高的 ${(f.p * 100).toFixed(1)}% 行之后，显著性判定翻转：差值从 ` +
      `${base.diff >= 0 ? '+' : ''}${fmtYuan(base.diff)} 元（p=${base.pValue.toFixed(3)}）变成 ` +
      `${f.diff >= 0 ? '+' : ''}${fmtYuan(f.diff)} 元（p=${f.pValue.toFixed(3)}）。` +
      (nearBorder
        ? `原始 p 本来就在 α=${alpha} 的边界上（相差 ${Math.abs(base.pValue - alpha).toFixed(3)}），截尾只是把它推过了线——这种「显著与否」本来就不该拿来当结论。`
        : '方向没变，但「显著」这件事依赖那几行，不能当硬结论用。');
  } else {
    const f = signFlip!;
    reason =
      `截掉最高的 ${(f.p * 100).toFixed(1)}% 行之后，差值**符号翻转**：` +
      `${base.diff >= 0 ? '+' : ''}${fmtYuan(base.diff)} 元 → ${f.diff >= 0 ? '+' : ''}${fmtYuan(f.diff)} 元。` +
      '这是最危险的一类：连方向都取决于极端值，上线前必须查清那几行是谁。';
  }

  const w = winsorizeCells(use, 0, opts.refP ?? 0.01);
  return {
    verdict,
    reason,
    grid: points,
    concentration,
    leverage: leverageRows(use, opts.leverageK ?? 3, controlArm, treatmentArm),
    medianExposuresPerRow,
    granularity,
    arms: { control: w.control, treatment: w.treatment },
    maxAbsChange,
    maxRelChange,
    caveat: CAVEAT,
  };
}
