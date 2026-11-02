import type { DailyRow, Decision, Experiment, Variant } from './types.ts';
import {
  bayesBetaBinomial, bayesNormal, bhAdjust, bootstrapTwoSample, cupedAdjust, guardrailBlocks,
  nonInferiority, ratioTest, srmChi2, twoProportionZ, twoSidedP, wilson,
  type BayesResult, type BootstrapResult, type CupedCell, type CupedResult, type NonInferiorityResult,
  type PropTest, type RatioCell, type RatioTest, type SrmResult,
} from './stats.ts';
import { DEFAULT_CONFIG, mergeConfig, type DecisionConfig } from './config.ts';
import { armsOf, allocationOf, armLabel, controlArmOf } from './arms.ts';
import {
  dunnettTwoSided, globalTest, probabilityBest, winnerCurse,
  type BestResult, type DunnettResult, type GlobalTestResult,
} from './multiarm.ts';
import { buildPeekReport, type LookInput, type PeekReport } from './sequential.ts';
import { noveltyReport, planExposureSplit, type NoveltyReport } from './novelty.ts';
import { robustnessReport, type RobustCell, type RobustnessReport } from './robust.ts';

export interface VariantAgg {
  n: number;
  c: number;
  refunds: number;
  complaints: number;
  latencyWeighted: number;
  revenue: number;
}

/**
 * 分层的统一视图：率口径与连续口径都能装进来。
 *
 * 以前 SegmentTest.test 直接是 PropTest，ARPU 分层就没地方放（连续指标没有 controlRate）。
 * 现在两种口径各自保留完整结果（rate / ratio），共用的那部分（diff / p / ci / se）提上来，
 * UI 和 Agent 只读共用字段，就不会出现「换个指标字段就对不上」的事。
 */
export interface SegmentTest {
  key: string;
  label: string;
  kind: 'rate' | 'continuous';
  controlValue: number;
  treatmentValue: number;
  diff: number;
  p: number;
  ci95: [number, number];
  se: number;
  q: number;
  /** 率口径的完整检验（rate 时有） */
  rate?: PropTest;
  /** 连续口径的完整检验（continuous 时有） */
  ratio?: RatioTest;
}

export interface GuardrailResult {
  key: string;
  label: string;
  controlRate: number;
  treatmentRate: number;
  diff: number;
  p: number;
  worse: boolean;
  gating: boolean;
  /** 率类护栏的原始检验结果（延迟指标没有），用于逐步代入时复用真实 z / CI */
  propTest?: PropTest;
  /**
   * 非劣检验结果（率类护栏）。护栏不再是「差值 > X 且 p < Y」的拍脑袋阈值，
   * 而是先声明容忍度 margin，再做单侧检验：只有确认恶化超过 margin 才算 worse。
   */
  nonInferiority?: NonInferiorityResult;
  /** 延迟类护栏的 Bootstrap 区间（P95 是分位数指标，只有重抽样才站得住） */
  bootstrap?: BootstrapResult;
  /** 本次判定使用的容忍度（展示用，让"凭什么是 0.4pp"有出处） */
  marginLabel?: string;
  /**
   * 该护栏**没被评估**的原因（数据里没有这一列）。
   * 有值时所有数值字段都无意义，UI 必须显示「不可用」而不是 0。
   */
  unavailable?: string;
}

/** 证据条目里的「逐步代入」：把公式和实际数字摊开，任何一步都能手算核对 */
export interface CalcStep {
  title: string;
  formula: string;
  value: string;
}

/** 规则判定轨迹：6 条规则按固定优先级依次判断，标出哪一条触发 */
export interface RuleTrace {
  code: string;
  label: string;
  condition: string;
  hit: boolean;
  detail: string;
}

export interface Evidence {
  id: string;
  kind: 'srm' | 'metric' | 'segment' | 'guardrail' | 'robustness' | 'decision';
  label: string;
  value?: number;
  detail: string;
  calc?: CalcStep[];
}

/** 主指标的统一视图：UI/Agent/导出卡只认这个，不再各自判断口径 */
export interface PrimaryView {
  kind: 'rate' | 'continuous';
  /** 指标名（与口径字典一致） */
  label: string;
  /** 展示单位：pp（百分点）或 元 */
  unit: 'pp' | '元';
  controlValue: number;
  treatmentValue: number;
  diff: number;
  p: number;
  ci95: [number, number];
  se: number;
  relativeLift: number;
  /** 决策实际采用的口径 */
  via: 'cuped' | 'robust' | 'ztest' | 'delta';
  /** 多臂：未经多重比较校正的边际 p（k=2 时不存在） */
  pRaw?: number;
  /** 多臂：边际 95% 区间（未校正） */
  ciRaw95?: [number, number];
  /** 是否已做多重比较校正（k>2） */
  adjusted?: boolean;
  /** 比较次数 m = k − 1 */
  comparisons?: number;
}

/**
 * ARPU 的因子分解：ARPU = 转化率 × 客单价。
 *
 * 为什么必须做：ARPU 涨了不代表「用户更愿意买」——打折拉量会让转化率涨、客单价跌，
 * 两者相抵后 ARPU 可能纹丝不动，甚至只看总量会得出「这版没用」的错结论。
 * 这个恒等式把总量差拆成三块，且严格相等（有单测到 1e-12），不是近似解释。
 */
export interface ArpuBreakdown {
  controlCvr: number;
  treatmentCvr: number;
  controlAov: number;
  treatmentAov: number;
  /** 总差 = fromCvr + fromAov + fromInteraction */
  total: number;
  /** 转化率变化带来的部分：AOV_c · ΔCVR */
  fromCvr: number;
  /** 客单价变化带来的部分：CVR_c · ΔAOV */
  fromAov: number;
  /** 交叉项：ΔCVR · ΔAOV */
  fromInteraction: number;
}

export interface Analysis {
  experimentId: string;
  /** 主指标类型（来自实验元信息；ARPU 但数据无收入时会退回 rate 并给出 metricFallback） */
  metricKind: 'rate' | 'continuous';
  /** 为什么退回了率口径（例如数据里没有 revenue 字段） */
  metricFallback?: string;
  primary: PrimaryView;
  /** 转化率口径（恒有：即使主指标是 ARPU，转化率也是可解释的副指标） */
  overall: PropTest;
  /** ARPU 口径（数据里有 revenue 时才有） */
  arpu?: RatioTest;
  /** ARPU 因子分解（有 arpu 时才有） */
  arpuBreakdown?: ArpuBreakdown;
  srm: SrmResult;
  segments: { tenure: SegmentTest[]; device: SegmentTest[] };
  interaction: { tenure: { diffDiff: number; se: number; z: number; p: number } | null };
  /**
   * 效应异质的检测结果（E1 分层 F1 要评价的是**检测器**，不是决策）。
   *
   * 为什么要单独导出而不是让评测去看 decision==='iterate'：
   * 决策是多个规则串起来的合取式，用决策反推「这个实验有没有被检测到异质」
   * 会把别的规则的失败混进分层指标里。检测器指标就该只看检测器。
   * 同时给出 `interactionSig`（只看交互是否显著）作为灵敏度上限：
   * 实际检测器还要求「一个分层显著为正、另一个无效」，是更严的合取口径。
   */
  heterogeneity: {
    /** 实际检测器判定：交互显著 ∧ 一个分层显著为正 ∧ 另一个分层无效 */
    detected: boolean;
    /** 只要求交互 p < interactionAlpha（不含合取），是检测器的宽松上限 */
    interactionSig: boolean;
    interactionP: number | null;
    bestSegment: string | null;
    flatSegment: string | null;
  };
  guardrails: GuardrailResult[];
  /**
   * 序贯监控：把「今天已经看了几次」算进阈值。
   *
   * 为什么不影响 decision：决策是真值标注与 A/A 校准都在用的主口径，
   * 一旦改成序贯阈值，历史 120 条的真值标注全部作废（那是改口径迁就引擎）。
   * 所以它作为**并行口径**给出：同一份数据，naive / OBF / always-valid 三套判定各自怎么说，
   * 以及差异有多大。真要按序贯口径上线，看 `sequential.obfSig` 而不是 `decision`。
   */
  sequential: PeekReport;
  /**
   * 新颖效应（效应衰减）检测：**只出报告，不参与 decision**。
   *
   * 真值标签是按频率派主指标 + 护栏口径标的，让衰减改 decision 就等于重标 120 条真值；
   * 那是"改口径迁就引擎"。所以这里与 heterogeneity 一样：检测器自己报，评审自己看。
   */
  novelty: NoveltyReport;
  /** CUPED：用前周期数据做方差缩减后的检验（无前周期数据时为 undefined）；口径与主指标一致 */
  cuped?: CupedResult;
  /**
   * 稳健性诊断：极端值有没有在替你做决定。**只对连续指标（ARPU）存在**。
   *
   * 为什么不参与 decision：截尾分位是看着数据定的，截尾后的 p 没有名义 α 保证
   * （见 `lib/robust.ts` 的 `CAVEAT`）。拿一个不保证第一类错误的检验去改决策，
   * 等于用一个更松的口径把结论推向"上线"。所以它作为**并行的诊断**给出，
   * 结论卡与详情页会把它标成风险，但 `decision` 仍由主口径决定。
   */
  robustness?: RobustnessReport;
  /** 贝叶斯视角：率口径用 Beta-Binomial，连续口径用正态后验 */
  bayes: BayesResult;
  /** 置信度 = P(treatment 真正优于 control)；与频率派 p 值口径不同，但结论互补 */
  confidence: number;
  decision: Decision;
  reason: string;
  reasonCode: 'SRM' | 'GUARDRAIL' | 'NOT_SIG' | 'NEGATIVE' | 'HETEROGENEOUS' | 'POSITIVE';
  evidence: Evidence[];
  rules: RuleTrace[];
  /**
   * 逐臂比较（A/B/n）。两臂实验也有值（两行），但 `multiArm` 只在 k>2 时给出——
   * 这样「是不是多臂」只看一个字段，不用数数组长度。
   */
  arms: ArmComparison[];
  /** 多臂专属信息（校正口径、全局检验、P(best)、焦点臂与理由） */
  multiArm?: MultiArmInfo;
}

/** 证据文本里的 p 值：erfc 大 |z| 下溢到 0 时写 <1e-16，避免出现 0.00e+0 */
function ep(p: number): string {
  if (!Number.isFinite(p)) return '—';
  if (p < 1e-16) return '<1e-16';
  if (p >= 0.001) return p.toFixed(3);
  return p.toExponential(2);
}

/** 护栏判定口径的人话解释（展示用，与 stats::guardrailBlocks 一一对应） */
const GUARDRAIL_MODE_LABEL: Record<string, string> = {
  harm_and_practical: '统计显著 ∧ 达到 margin',
  confirm_beyond_margin: '确认恶化超过 margin',
  non_inferiority: '非劣不成立即拦',
};

const GUARDRAIL_MODE_FORMULA: Record<string, string> = {
  harm_and_practical: '拦截 = 单侧 p(Δ>0) < α 且 Δ > margin',
  confirm_beyond_margin: '拦截 = 单侧 p(Δ>margin) < α（即 Δ − z₁₋α·SE > margin）',
  non_inferiority: '拦截 = 不能证明 Δ < margin（即 Δ + z₁₋α·SE ≥ margin）',
};

const p4 = (v: number) => `${(v * 100).toFixed(4)}%`;
const pp2 = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}pp`;

/**
 * 差值格式化：单位必须跟着指标走。
 * 二元指标写 pp（百分点），ARPU 写元——把 0.42 元写成 +0.42pp 是实打实的口径错误。
 */
function fmtDiff(v: number, unit: 'pp' | '元'): string {
  return unit === '元' ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}元` : pp2(v);
}

/** 指标水平值格式化（control/treatment 各自的绝对值） */
function fmtLevel(v: number, unit: 'pp' | '元'): string {
  return unit === '元' ? `${v.toFixed(2)}元` : `${(v * 100).toFixed(2)}%`;
}

function emptyAgg(): VariantAgg {
  return { n: 0, c: 0, refunds: 0, complaints: 0, latencyWeighted: 0, revenue: 0 };
}

export function aggregate(rows: DailyRow[], variant: Variant): VariantAgg {
  const a = emptyAgg();
  for (const r of rows) {
    if (r.variant !== variant) continue;
    a.n += r.exposures;
    a.c += r.conversions;
    a.refunds += r.refunds;
    a.complaints += r.complaints;
    a.latencyWeighted += r.latencyP95 * r.exposures;
    a.revenue += r.revenue ?? 0;
  }
  return a;
}

function unpooledSe(t: PropTest): number {
  return Math.sqrt(
    (t.controlRate * (1 - t.controlRate)) / t.n1 +
    (t.treatmentRate * (1 - t.treatmentRate)) / t.n2,
  );
}

/**
 * 决策实际采用的主指标口径。
 * 序贯监控必须**沿用同一个口径**，否则「换个观察窗口就换了个统计量」，
 * 那样的 z 轨迹不是鞅，OBF / mSPRT 的保证全部失效。
 */
export type PrimaryMode = 'cuped' | 'robust' | 'ztest' | 'delta';

/** 把明细折成 CUPED 需要的格子（协变量与主指标同口径） */
function cupedCellsOf(
  rows: DailyRow[],
  kind: 'rate' | 'continuous',
  control = 'control',
  treatment = 'treatment',
): CupedCell[] {
  const cells: CupedCell[] = [];
  for (const r of rows) {
    if (!(r.preExposures && r.exposures > 0)) continue;
    const isTreatment = r.variant === treatment;
    if (kind === 'continuous') {
      if (r.preRevenue === undefined) continue;
      cells.push({ n: r.exposures, c: r.revenue ?? 0, nPre: r.preExposures, cPre: r.preRevenue, treatment: isTreatment });
    } else if (r.preConversions !== undefined) {
      cells.push({ n: r.exposures, c: r.conversions, nPre: r.preExposures, cPre: r.preConversions, treatment: isTreatment });
    }
  }
  void control;
  return cells;
}

/**
 * 在任意行子集上按指定口径估一次「差值 + 标准误」。
 *
 * 存在的理由：序贯监控要在第 1 天、第 2 天……各估一次。如果这几处另写一套公式，
 * 就必然和最终决策口径漂移（历史上 `real_eval` 就因为 `or` 的短路算错过一次）。
 * 所以这里只做「同一套口径、不同数据量」，并由单测 `estimateAt(全集) === analysis.primary` 钉住。
 * CUPED 在某天不可用时（前周期格子不够）退回未校正口径，并在 via 里如实标明。
 */
/**
 * 格子级稳健估计（含 CUPED）要求的最低格子数。
 *
 * 为什么要设这个门槛：格子级方差是从「格子间离散程度」估的，自由度约 = 格子数。
 * 第 1 天只有 8 个格子（每臂 4 个），χ² 自由度 3 的离散度估计可以低到真值的 1/5，
 * 于是 SE 被低估数倍、z 虚高数倍 —— 实测 E060 第 1 天 z=3.97、第 2 天 se=0.157
 * 而第 3 天 se=0.210（SE 随样本增加反而变大，唯一解释就是它在被噪声估），
 * 那个 3.97 纯粹是「用几个格子估方差」的产物，不是数据里的信号。
 * 序贯监控最怕的正是这种早起的假信号，所以格子不够时退回朴素口径（SE 偏保守）。
 *
 * 24 个格子 ≈ 3 天（每天 8 格）：再少就退，再多的收益已经不明显。
 */
const MIN_CELLS_FOR_ROBUST = 24;

export interface PairEstimate {
  diff: number;
  se: number;
  via: PrimaryMode;
  /** 该口径下的双侧 p（cuped→pAdj，robust→pRaw，ztest/delta→各自检验的 p） */
  p: number;
  /** 自由度：率口径的稳健估计用格子数，z 检验为 Infinity，连续口径用 Welch df */
  df: number;
}

export function estimateAt(
  rows: DailyRow[],
  kind: 'rate' | 'continuous',
  mode: PrimaryMode,
  control = 'control',
  treatment = 'treatment',
): PairEstimate | null {
  if (kind === 'continuous') {
    const rt = ratioTest(ratioCellsOf(rows, treatment));
    if (!rt) return null;
    if (mode === 'cuped') {
      const cuCells = cupedCellsOf(rows, 'continuous', control, treatment);
      const nPerArm = cuCells.filter((c) => c.treatment).length;
      const cu = cuCells.length >= MIN_CELLS_FOR_ROBUST && nPerArm >= 4
        ? cupedAdjust(cuCells, 'continuous')
        : null;
      if (cu) return { diff: cu.diffAdj, se: cu.seAdj, via: 'cuped', p: cu.pAdj, df: cu.df };
    }
    return { diff: rt.diff, se: rt.se, via: 'delta', p: rt.p, df: rt.df };
  }
  const c = aggregate(rows, control);
  const t = aggregate(rows, treatment);
  if (!(c.n > 0) || !(t.n > 0)) return null;
  const zt = twoProportionZ(c.c, c.n, t.c, t.n);
  if (mode === 'cuped' || mode === 'robust') {
    const cuCells = cupedCellsOf(rows, 'rate', control, treatment);
    const nPerArm = cuCells.filter((x) => x.treatment).length;
    const cu = cuCells.length >= MIN_CELLS_FOR_ROBUST && nPerArm >= 4
      ? cupedAdjust(cuCells, 'rate')
      : null;
    if (cu) {
      return mode === 'cuped'
        ? { diff: cu.diffAdj, se: cu.seAdj, via: 'cuped', p: cu.pAdj, df: cu.df }
        : { diff: cu.diffRaw, se: cu.seRaw, via: 'robust', p: cu.pRaw, df: cu.df };
    }
  }
  return { diff: zt.diff, se: unpooledSe(zt), via: 'ztest', p: zt.p, df: Infinity };
}

/**
 * 逐日累积的观察点：第 k 天 = 第 1..k 天的全部数据（真实团队就是这样看板的）。
 *
 * 只看「日期」这一维，不按天重置——序贯检验针对的正是**累计**统计量的重复窥探。
 * 天数相同则按日期字符串升序（数据里是 YYYY-MM-DD，字典序即时间序）。
 */
export function dailyLooks(
  rows: DailyRow[],
  kind: 'rate' | 'continuous',
  mode: PrimaryMode,
  control = 'control',
  treatment = 'treatment',
): LookInput[] {
  const dates = Array.from(new Set(rows.map((r) => r.date))).sort();
  if (dates.length < 2) return [];
  const out: LookInput[] = [];
  for (let i = 0; i < dates.length; i++) {
    const upto = new Set(dates.slice(0, i + 1));
    const cum = rows.filter((r) => upto.has(r.date));
    const est = estimateAt(cum, kind, mode, control, treatment);
    if (!est || !(est.se > 0)) continue;
    const c = aggregate(cum, control);
    const t = aggregate(cum, treatment);
    out.push({ day: i + 1, date: dates[i], nPerArm: (c.n + t.n) / 2, diff: est.diff, se: est.se });
  }
  return out;
}

/**
 * 逐日**互不重叠**的分段估计（每天单独估一次，不是累计）。
 *
 * 与 dailyLooks 的区别必须记清楚：序贯检验要累计值（看板就是这么刷的），
 * 新颖效应要分段值（两段误差必须独立）。混用会把 SE 低估、把一切判成衰减。
 */
export function dailySegments(
  rows: DailyRow[],
  kind: 'rate' | 'continuous',
  mode: PrimaryMode,
  control = 'control',
  treatment = 'treatment',
): LookInput[] {
  const dates = Array.from(new Set(rows.map((r) => r.date))).sort();
  const out: LookInput[] = [];
  for (let i = 0; i < dates.length; i++) {
    const sub = rows.filter((r) => r.date === dates[i]);
    const est = estimateAt(sub, kind, mode, control, treatment);
    if (!est || !(est.se > 0)) continue;
    const c = aggregate(sub, control);
    const t = aggregate(sub, treatment);
    out.push({ day: i + 1, date: dates[i], nPerArm: (c.n + t.n) / 2, diff: est.diff, se: est.se });
  }
  return out;
}

/** 两比例检验的 4 步推导（主指标 / 分层 / 护栏共用） */
function propSteps(t: PropTest, unit: 'rate' | 'count' = 'rate'): CalcStep[] {
  const pooled = t.n1 + t.n2 > 0 ? (t.c1 + t.c2) / (t.n1 + t.n2) : 0;
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / t.n1 + 1 / t.n2));
  const [l1, u1] = wilson(t.controlRate, t.n1);
  const [l2, u2] = wilson(t.treatmentRate, t.n2);
  const dtxt = unit === 'rate' ? '转化率' : '发生率';
  return [
    {
      title: `① 两变体${dtxt}`,
      formula: 'p̂ = 计数 / 样本',
      value: `p̂₁ = ${t.c1} / ${t.n1} = ${p4(t.controlRate)}；p̂₂ = ${t.c2} / ${t.n2} = ${p4(t.treatmentRate)}`,
    },
    {
      title: '② 合并比例与标准误',
      formula: 'p̄ = (c₁+c₂)/(n₁+n₂)，SE = √(p̄(1−p̄)(1/n₁+1/n₂))',
      value: `p̄ = ${pooled.toFixed(6)}，SE = ${se.toFixed(6)}`,
    },
    {
      title: '③ z 统计量与 p 值',
      formula: 'z = (p̂₂ − p̂₁)/SE，p = erfc(|z|/√2)',
      value: `z = ${t.z.toFixed(4)}，p = ${ep(t.p)}`,
    },
    {
      title: '④ 差值置信区间（Newcombe 混合法）',
      formula: '先各自 Wilson，再合成差值区间',
      value:
        `Wilson₁ [${p4(l1)}, ${p4(u1)}]，Wilson₂ [${p4(l2)}, ${p4(u2)}] → ` +
        `差值 ${pp2(t.diff)}，95% CI [${pp2(t.ci95[0])}, ${pp2(t.ci95[1])}]`,
    },
  ];
}

/** 连续指标（ARPU）的 4 步推导：每一步都能照着复算 */
function ratioSteps(r: RatioTest, breakdown?: ArpuBreakdown): CalcStep[] {
  const rel = (v: number) => `${v.toFixed(2)}元`;
  const steps: CalcStep[] = [
    {
      title: '① 两变体 ARPU',
      formula: 'ARPU = Σ收入 / Σ曝光（元 / 曝光）',
      value: `control = ${r.sum1.toFixed(2)} / ${r.n1} = ${rel(r.controlValue)}；treatment = ${r.sum2.toFixed(2)} / ${r.n2} = ${rel(r.treatmentValue)}`,
    },
    {
      title: '② 标准误（delta method，格子级聚类方差）',
      formula: 'Var(R̂) = K/(K−1)·Σ[nᵢ(aᵢ−R̂)]² / (Σnᵢ)²，SE = √(Var_c + Var_t)',
      value:
        `两臂各 ${r.k1} / ${r.k2} 个格子；SE = √(${r.seControl.toFixed(5)}² + ${r.seTreatment.toFixed(5)}²) = ${r.se.toFixed(5)}元`,
    },
    {
      title: '③ t 统计量与自由度',
      formula: 't = Δ/SE；df 用 Welch–Satterthwaite（按格子数算，不是按人数）',
      value: `t = ${r.diff.toFixed(4)} / ${r.se.toFixed(5)} = ${r.z.toFixed(4)}，df = ${r.df.toFixed(1)}，p = ${ep(r.p)}`,
    },
    {
      title: '④ 95% 置信区间',
      formula: 'Δ ± t₀.₉₇₅(df) · SE（用 t 分位，不用 1.96）',
      value: `[${rel(r.ci95[0])}, ${rel(r.ci95[1])}]`,
    },
  ];
  if (breakdown) {
    steps.push({
      title: '⑤ 分解：这钱是「更多人买」还是「单笔更贵」赚来的',
      formula: 'ΔARPU = AOV_c·ΔCVR + CVR_c·ΔAOV + ΔCVR·ΔAOV（恒等式）',
      value:
        `转化率 ${p4(breakdown.controlCvr)} → ${p4(breakdown.treatmentCvr)}（贡献 ${rel(breakdown.fromCvr)}）；` +
        `客单价 ${rel(breakdown.controlAov)} → ${rel(breakdown.treatmentAov)}（贡献 ${rel(breakdown.fromAov)}）；` +
        `交叉项 ${rel(breakdown.fromInteraction)} → 合计 ${rel(breakdown.total)}`,
    });
  }
  return steps;
}

/** 把明细行折成「格子」：一行就是一个格子（日期 × 设备 × 新老 × 变体） */
function ratioCellsOf(rows: DailyRow[], treatment = 'treatment'): RatioCell[] {
  const out: RatioCell[] = [];
  for (const r of rows) {
    if (r.revenue === undefined || !(r.exposures > 0)) continue;
    out.push({ n: r.exposures, sum: r.revenue, treatment: r.variant === treatment });
  }
  return out;
}

function hasRevenue(rows: DailyRow[]): boolean {
  return rows.some((r) => r.revenue !== undefined && r.revenue > 0);
}

/**
 * 稳健性诊断用的格子：与 `ratioCellsOf` 同源，多带一个人类可读标签。
 *
 * 为什么标签要在这里生成而不是让 UI 拼：杠杆表里要写「删掉哪一行」，
 * 如果 UI 各自拼 `date + device + tenure`，一旦有人改了文案，「哪一行」就对不上了。
 * 标签是数据的一部分，跟着数据一起走。
 */
function robustCellsOf(rows: DailyRow[], control: string, treatment: string): RobustCell[] {
  const tenureLabel = (t: string) => (t === 'new' ? '新用户' : t === 'old' ? '老用户' : String(t));
  const out: RobustCell[] = [];
  for (const r of rows) {
    if (r.revenue === undefined || !(r.exposures > 0)) continue;
    if (r.variant !== control && r.variant !== treatment) continue;
    out.push({
      n: r.exposures,
      sum: r.revenue,
      treatment: r.variant === treatment,
      label: `${r.date} · ${r.device} · ${tenureLabel(r.tenure)}`,
      key: `${r.date}|${r.device}|${r.tenure}|${r.variant}`,
    });
  }
  return out;
}

function breakdownOf(c: VariantAgg, t: VariantAgg): ArpuBreakdown | undefined {
  if (!(c.n > 0) || !(t.n > 0) || !(c.c > 0) || !(t.c > 0)) return undefined;
  const cvrC = c.c / c.n;
  const cvrT = t.c / t.n;
  const aovC = c.revenue / c.c;
  const aovT = t.revenue / t.c;
  const fromCvr = aovC * (cvrT - cvrC);
  const fromAov = cvrC * (aovT - aovC);
  const fromInteraction = (cvrT - cvrC) * (aovT - aovC);
  return {
    controlCvr: cvrC,
    treatmentCvr: cvrT,
    controlAov: aovC,
    treatmentAov: aovT,
    total: t.revenue / t.n - c.revenue / c.n,
    fromCvr,
    fromAov,
    fromInteraction,
  };
}

function scanDimension(
  rows: DailyRow[],
  dim: 'tenure' | 'device',
  labels: Record<string, string>,
  fdr: number,
  kind: 'rate' | 'continuous',
  control = 'control',
  treatment = 'treatment',
): SegmentTest[] {
  const keys = Array.from(new Set(rows.map((r) => String(r[dim]))));
  const raw = keys.map((key): Omit<SegmentTest, 'q'> => {
    const sub = rows.filter((r) => String(r[dim]) === key);
    const label = labels[key] || key;
    if (kind === 'continuous') {
      const rt = ratioTest(ratioCellsOf(sub, treatment));
      if (rt) {
        return {
          key, label, kind: 'continuous',
          controlValue: rt.controlValue, treatmentValue: rt.treatmentValue,
          diff: rt.diff, p: rt.p, ci95: rt.ci95, se: rt.se, ratio: rt,
        };
      }
    }
    const c = aggregate(sub, control);
    const t = aggregate(sub, treatment);
    const pt = twoProportionZ(c.c, c.n, t.c, t.n);
    return {
      key, label, kind: 'rate',
      controlValue: pt.controlRate, treatmentValue: pt.treatmentRate,
      diff: pt.diff, p: pt.p, ci95: pt.ci95, se: unpooledSe(pt), rate: pt,
    };
  });
  const { qvals } = bhAdjust(raw.map((x) => x.p), fdr);
  return raw.map((x, i) => ({ ...x, q: qvals[i] }));
}

/** 单个臂与对照的比较（多臂表的一行） */
export interface ArmComparison {
  id: string;
  label: string;
  isControl: boolean;
  n: number;
  conversions: number;
  revenue: number;
  /** 主指标水平（率或 ARPU） */
  value: number;
  /** 与对照的差值（对照自身为 0） */
  diff: number;
  se: number;
  relativeLift: number;
  /** 边际 p（单次比较，未校正） */
  pRaw: number;
  /** Dunnett 校正后 p（k=2 时等于 pRaw） */
  pAdj: number;
  /** 同时 95% 区间（Dunnett），跨 0 ⟺ pAdj > α */
  ci: [number, number];
  /** P(这个臂是最优) —— 决策视角，不是显著性视角 */
  pBest: number;
  via: 'cuped' | 'robust' | 'ztest' | 'delta' | 'control';
  /** 该臂自己的护栏（只提示，不参与决策；决策看焦点臂那一套） */
  guardrails: Array<{ key: string; label: string; diff: number; worse: boolean; unavailable?: string }>;
}

export interface MultiArmInfo {
  k: number;
  control: string;
  /** 决策实际对比的那个处理臂 */
  focus: string;
  focusReason: 'declared' | 'best-significant' | 'best-point';
  alpha: number;
  /** 比较次数 = k−1 */
  comparisons: number;
  /** Dunnett 同时临界值（z 单位） */
  crit: number;
  /** Bonferroni 的临界值（并排展示「不用相关性要多付多少」） */
  bonferroniCritZ: number;
  /** 全局检验：这个实验到底测出东西没有 */
  global: GlobalTestResult;
  /** 赢家诅咒：全零时「挑最大」也会看起来有这个量级的效应 */
  winnerCurse: number;
  /** SRM 用的分流比例与来源（猜的比例会把正常实验判成异常） */
  srmRatios: number[];
  srmSource: 'declared' | 'trafficSplit' | 'equal';
  /** 没被选中的臂里点估计最高的那个（解释「为什么不选它」） */
  runnerUp?: { id: string; diff: number; pAdj: number };
}

/**
 * 主指标口径的自动选择：与决策口径**同一套规则**，否则多臂表与详情页会对不上。
 * 顺序：连续指标 → CUPED（有前周期且格子够）→ 否则 delta；率指标 → CUPED → 稳健 → z 检验。
 */
function autoMode(rows: DailyRow[], kind: 'rate' | 'continuous', cfg: DecisionConfig): PrimaryMode {
  if (cfg.useCuped !== false) {
    const cells = cupedCellsOf(rows, kind);
    const nPerArm = cells.filter((x) => x.treatment).length;
    if (cells.length >= MIN_CELLS_FOR_ROBUST && nPerArm >= 4) return 'cuped';
  }
  if (kind === 'continuous') return 'delta';
  return (cfg.seMode ?? 'robust') === 'robust' ? 'robust' : 'ztest';
}

/** 对照臂均值的标准误（多臂校正与 P(best) 都要用） */
function controlSe(rows: DailyRow[], control: string, kind: 'rate' | 'continuous'): number {
  const c = aggregate(rows, control);
  if (!(c.n > 0)) return 0;
  if (kind === 'rate') {
    const p = c.c / c.n;
    return Math.sqrt((p * (1 - p)) / c.n);
  }
  // 连续口径：用格子级方差（与 ratioTest 同一个估计量），没有格子时退回 n=1 的粗略值
  const vals = rows.filter((r) => r.variant === control && r.revenue !== undefined && r.exposures > 0);
  if (vals.length >= 2) {
    const rt = ratioTest(vals.map((r) => ({ n: r.exposures, sum: r.revenue ?? 0, treatment: false })));
    if (rt) return rt.seControl;
  }
  return 0;
}

/**
 * 逐臂算一遍「vs 对照」：多臂表的唯一数据源。
 *
 * 关键：每臂用的是**同一个估计器**（`estimateAt`），与详情页主指标逐字相同。
 * 如果这里另写一套（比如都退回 z 检验），就会出现「表里 p=0.03、点进去 p=0.06」
 * 这种最伤信任的不一致。
 */
function compareArms(
  rows: DailyRow[],
  arms: string[],
  control: string,
  kind: 'rate' | 'continuous',
  cfg: DecisionConfig,
): { list: ArmComparison[]; seControl: number; mode: PrimaryMode } {
  const mode = autoMode(rows, kind, cfg);
  const se0 = controlSe(rows, control, kind);
  const list: ArmComparison[] = arms.map((id) => {
    const agg = aggregate(rows, id);
    const base = {
      id,
      label: armLabel(id),
      isControl: id === control,
      n: agg.n,
      conversions: agg.c,
      revenue: agg.revenue,
      value: kind === 'continuous' ? (agg.n > 0 ? agg.revenue / agg.n : 0) : agg.n > 0 ? agg.c / agg.n : 0,
      diff: 0,
      se: 0,
      relativeLift: 0,
      pRaw: 1,
      pAdj: 1,
      ci: [0, 0] as [number, number],
      pBest: 0,
      via: 'control' as ArmComparison['via'],
      guardrails: [] as ArmComparison['guardrails'],
    };
    if (id === control) return base;
    const pair = rows.filter((r) => r.variant === control || r.variant === id);
    const est = estimateAt(pair, kind, mode, control, id);
    const cAgg = aggregate(pair, control);
    const guardrails = armGuardrails(pair, control, id, cAgg, agg, cfg);
    if (!est) return { ...base, guardrails };
    return {
      ...base,
      diff: est.diff,
      se: est.se,
      relativeLift: base.value !== 0 && !base.isControl ? est.diff / (kind === 'continuous' ? (cAgg.n > 0 ? cAgg.revenue / cAgg.n : 0) : cAgg.n > 0 ? cAgg.c / cAgg.n : 0) : 0,
      pRaw: est.p,
      pAdj: est.p,
      ci: [est.diff, est.diff],
      via: est.via,
      guardrails,
    };
  });
  return { list, seControl: se0, mode };
}

/** 每臂的护栏摘要：只做「这一臂有没有把硬护栏打坏」的提示，决策仍看焦点臂 */
function armGuardrails(
  pair: DailyRow[],
  control: string,
  arm: string,
  cAgg: VariantAgg,
  aAgg: VariantAgg,
  cfg: DecisionConfig,
): ArmComparison['guardrails'] {
  const out: ArmComparison['guardrails'] = [];
  const missing = new Set(cfg.missingGuardrails ?? []);
  const push = (key: string, label: string, c: number, a: number) => {
    const ni = nonInferiority(c, cAgg.n, a, aAgg.n, key === 'refund_rate' ? cfg.guardrails.refundRate.margin : cfg.guardrails.complaintRate.margin, key === 'refund_rate' ? cfg.guardrails.refundRate.alpha : cfg.guardrails.complaintRate.alpha);
    const spec = key === 'refund_rate' ? cfg.guardrails.refundRate : cfg.guardrails.complaintRate;
    out.push({
      key,
      label,
      diff: cAgg.n > 0 && aAgg.n > 0 ? a / aAgg.n - c / cAgg.n : 0,
      worse: guardrailBlocks(ni, spec.mode),
    });
  };
  if (!missing.has('refunds')) push('refund_rate', '退款率', cAgg.refunds, aAgg.refunds);
  if (!missing.has('complaints')) push('complaint_rate', '投诉率', cAgg.complaints, aAgg.complaints);
  void pair;
  void control;
  void arm;
  return out;
}

/** 两臂时代的下标工具：只看对照 + 焦点臂 */
function pairOf(rows: DailyRow[], control: string, arm: string): DailyRow[] {
  return rows.filter((r) => r.variant === control || r.variant === arm);
}

export function analyze(exp: Experiment, allRows: DailyRow[], cfgOverride?: Partial<DecisionConfig>): Analysis {
  const cfg = mergeConfig(cfgOverride);
  const rowsAll = allRows.filter((r) => r.expId === exp.id);
  const control = controlArmOf(exp);
  const arms = armsOf(exp, rowsAll);
  const isMulti = arms.length > 2;

  // ---- 口径判定（在**全部臂**上判，避免「换了个焦点臂就换了个口径」）----
  const revenueOk = hasRevenue(rowsAll);
  const wantContinuous = exp.metricType === 'continuous';
  // ARPU 是「总量/人数」的比值指标，方差要靠多个独立格子估。这里要求**每个处理臂**都够，
  // 否则会出现「B 用元、C 用 pp」这种单位混排——比退回率口径更糟。
  const enoughCells = (a: string) => ratioTest(ratioCellsOf(pairOf(rowsAll, control, a), a)) !== null;
  const continuousOk = wantContinuous && revenueOk && arms.slice(1).every(enoughCells);
  const metricKind: 'rate' | 'continuous' = continuousOk ? 'continuous' : 'rate';
  const metricFallback = !wantContinuous
    ? undefined
    : !revenueOk
      ? '该实验声明以 ARPU 为主指标，但数据中没有 revenue 字段，已退回转化率口径（结论仍然有效，只是主指标换了）'
      : !continuousOk
        ? '该实验声明以 ARPU 为主指标，但有臂的独立格子不足 2 个（只有 1 天且没有分层）——ARPU 的方差估不出来，已退回转化率口径。多导几天数据即可恢复'
        : undefined;

  // ---- 多臂：先逐臂估一遍，再定焦点臂 ----
  // 两臂时代这一步是「无操作」，但仍然要走同一条代码路径：
  // 臂名不再写死（可能是 baseline / v2），臂 id 必须一路传下去。
  const cmp = compareArms(rowsAll, arms, control, metricKind, cfg);
  const candidates = cmp.list.filter((a) => !a.isControl);
  let focus = candidates[0]?.id ?? (arms[1] ?? 'treatment');
  let focusReason: MultiArmInfo['focusReason'] = 'best-point';
  let dunnett: DunnettResult | null = null;
  let best: BestResult | null = null;
  let global: GlobalTestResult | null = null;

  if (isMulti && candidates.length) {
    dunnett = dunnettTwoSided(
      { diff: candidates.map((a) => a.diff), se: candidates.map((a) => a.se), seControl: cmp.seControl },
      cfg.alpha,
    );
    for (let i = 0; i < candidates.length; i++) {
      candidates[i].pAdj = dunnett.adjP[i];
      candidates[i].ci = dunnett.ci[i];
    }
    // P(best) 要把对照也算作一个「候选」：它也可能确实是最好的
    best = probabilityBest({
      estimate: [0, ...candidates.map((a) => a.diff)],
      se: [Math.max(cmp.seControl, 1e-12), ...candidates.map((a) => Math.max(a.se, 1e-12))],
      label: [control, ...candidates.map((a) => a.id)],
    });
    const all = [cmp.list.find((a) => a.isControl)!, ...candidates];
    const order = [0, ...candidates.map((a) => all.indexOf(a))];
    for (let i = 0; i < all.length; i++) {
      const k = order.indexOf(i);
      if (k >= 0) all[i].pBest = best.prob[k];
    }
    global = globalTest({ diff: candidates.map((a) => a.diff), se: candidates.map((a) => a.se), seControl: cmp.seControl });

    // 焦点臂：先看「校正后仍显著为正」的，再退回「点估计最大」。
    // 前者是决策口径（可以上），后者只是「详情页先看哪一臂」——两者必须分开，
    // 否则「都不显著」时会把某一臂的 raw p 当成结论。
    const sig = candidates.filter((a) => a.pAdj < cfg.alpha && a.diff > 0);
    const pool = sig.length ? sig : candidates;
    const win = pool.reduce((a, b) => (b.diff > a.diff ? b : a));
    focus = win.id;
    focusReason = sig.length ? 'best-significant' : 'best-point';
  }

  const treatment = focus;
  // 两臂不过滤（数据里就这两臂）；多臂只把「对照 + 焦点臂」交给下游管线，
  // 于是序贯 / 新颖 / 分层 / 护栏全部只讲这一对，不会把别的臂混进同一个差值里。
  const rows = isMulti ? pairOf(rowsAll, control, treatment) : rowsAll;
  const c = aggregate(rows, control);
  const t = aggregate(rows, treatment);
  const overall = twoProportionZ(c.c, c.n, t.c, t.n);
  const arpu = revenueOk ? ratioTest(ratioCellsOf(rows, treatment)) ?? undefined : undefined;
  const arpuBreakdown = arpu ? breakdownOf(c, t) : undefined;

  // 稳健性诊断：只在主指标真的是连续口径时算（率口径的极端值问题是另一件事，
  // 伯努利结构下不存在「几个用户撑起均值」，硬塞一份 ARPU 的截尾表只会误导）。
  const robustness =
    metricKind === 'continuous' && arpu
      ? robustnessReport(robustCellsOf(rows, control, treatment), {
          alpha: cfg.alpha,
          controlArm: control,
          treatmentArm: treatment,
        })
      : undefined;

  // CUPED：只有明细行带前周期数据时才算（导入的真实数据常常没有，那就自动退回普通检验）。
  // 协变量必须与主指标同口径：率指标用前周期转化数，ARPU 用前周期收入。
  // 格子构造与 estimateAt 共用同一个函数，避免「主指标走 A、逐日监控走 B」的口径漂移。
  const cells = cupedCellsOf(rows, metricKind, control, treatment);
  const cuped = cells.length ? cupedAdjust(cells, metricKind) : null;

  // 决策口径，按优先级选：
  //   1) 有前周期 + 开了 CUPED → CUPED 调整后的差值与区间（方差更小）
  //   2) 有前周期 + seMode=robust → 差值不变，但标准误改用格子级稳健估计（修过离散）
  //   3) 连续指标 → delta method（这条本来就不假设 i.i.d.，没有更"稳健"的版本可退）
  //   4) 否则 → 经典两比例 z 检验（要求 i.i.d.，真实数据上会偏乐观）
  const useCuped = !!cuped && cfg.useCuped !== false;
  let primary: PrimaryView;
  if (metricKind === 'continuous' && arpu) {
    primary = useCuped
      ? { kind: 'continuous', label: 'ARPU', unit: '元', controlValue: arpu.controlValue, treatmentValue: arpu.treatmentValue, diff: cuped!.diffAdj, p: cuped!.pAdj, ci95: cuped!.ciAdj, se: cuped!.seAdj, relativeLift: arpu.relativeLift, via: 'cuped' }
      : { kind: 'continuous', label: 'ARPU', unit: '元', controlValue: arpu.controlValue, treatmentValue: arpu.treatmentValue, diff: arpu.diff, p: arpu.p, ci95: arpu.ci95, se: arpu.se, relativeLift: arpu.relativeLift, via: 'delta' };
  } else if (useCuped) {
    primary = { kind: 'rate', label: exp.primaryMetric, unit: 'pp', controlValue: overall.controlRate, treatmentValue: overall.treatmentRate, diff: cuped!.diffAdj, p: cuped!.pAdj, ci95: cuped!.ciAdj, se: cuped!.seAdj, relativeLift: overall.relativeLift, via: 'cuped' };
  } else if (cuped && (cfg.seMode ?? 'robust') === 'robust') {
    primary = { kind: 'rate', label: exp.primaryMetric, unit: 'pp', controlValue: overall.controlRate, treatmentValue: overall.treatmentRate, diff: cuped!.diffRaw, p: cuped!.pRaw, ci95: cuped!.ciRaw, se: cuped!.seRaw, relativeLift: overall.relativeLift, via: 'robust' };
  } else {
    primary = { kind: 'rate', label: exp.primaryMetric, unit: 'pp', controlValue: overall.controlRate, treatmentValue: overall.treatmentRate, diff: overall.diff, p: overall.p, ci95: overall.ci95, se: unpooledSe(overall), relativeLift: overall.relativeLift, via: 'ztest' };
  }

  // ---- 多臂把「校正后 p + 同时区间」换成决策口径 ----
  // 为什么必须换：焦点臂是「从 k−1 个里挑出来的赢家」，用它的边际 p 就是把
  // 「挑最大」的偏差藏起来。Dunnett 校正后的 p 与同时区间自洽（跨 0 ⟺ p>α），
  // 而且边际值仍保留在 pRaw / ciRaw 里，读者能看到「校正前有多显著」。
  if (isMulti && dunnett) {
    const idx = candidates.findIndex((a) => a.id === treatment);
    if (idx >= 0) {
      primary = {
        ...primary,
        pRaw: primary.p,
        ciRaw95: primary.ci95,
        p: dunnett.adjP[idx],
        ci95: dunnett.ci[idx],
        adjusted: true,
        comparisons: dunnett.m,
      };
    }
  }

  // 序贯监控：沿用**同一个口径**（primary.via）逐日重估，再换算出三套阈值。
  // 逐日重估而不是按天重置，是因为偷看的人看的就是累计看板。
  const sequential = buildPeekReport(dailyLooks(rows, metricKind, primary.via, control, treatment), { alpha: cfg.alpha });

  // 新颖效应：逐日**分段**（互不重叠）估一次，按曝光量对半切，两半各自再估一次。
  //
  // 半段的标准误**不**用「把半段的行重新估一次」那套 SE —— A/A 实测过，那样算出来的
  // 「前后半段差异」误报率是 12%（率）/ 15%（ARPU），因为半段只有 3–4 天、16 个格子，
  // 任何当天 SE 都会漏掉日间整体漂移。改用日级聚类（每天一个观测单位）+ Welch t，
  // 同一套 A/A 落到 4.8% / 6.4%（见 scripts/novelty_report.ts 与 tests/novelty.test.ts）。
  const segs = dailySegments(rows, metricKind, primary.via, control, treatment);
  const novelty = noveltyReport({ points: segs, alpha: cfg.noveltyAlpha });

  // 贝叶斯视角：率口径用 Beta-Binomial（把过离散折算成有效样本量，否则后验过度自信）；
  // 连续口径没有「计数/样本量」结构，用正态后验（bayesNormal），公式逐字对应。
  const bayes =
    metricKind === 'continuous'
      ? bayesNormal(primary.diff, primary.se)
      : bayesBetaBinomial(c.c, c.n, t.c, t.n, cuped?.dispersion ?? 1);

  /**
   * SRM 的分流期望。
   * 两臂沿用「等分」：内置数据里的 trafficSplit 是**描述实际分流**的字段，
   * 拿它当期望会把「本来就跑歪的 40/60 坏实验」检查成正常（历史上的 srm 原型就是这样标的）。
   * 多臂则用声明比例（"50/25/25"）——三臂实验的等分假设几乎总是不成立，
   * 用等分去查会把正常实验判成异常。比例来源会写进 `multiArm.srmSource` 并在 UI 上标明。
   */
  const alloc = allocationOf(exp, arms);
  const srmCounts = isMulti ? arms.map((a) => aggregate(rowsAll, a).n) : [c.n, t.n];
  const srmRatios = isMulti ? alloc.ratios : [0.5, 0.5];
  const srm = srmChi2(srmCounts, srmRatios, cfg.srmAlpha, cfg.srmMaxRelImb);

  // 分层也必须跟主指标同口径：ARPU 实验按转化率分层会答错问题
  const segments = {
    tenure: scanDimension(rows, 'tenure', { new: '新用户', old: '老用户' }, cfg.segmentFdr, metricKind, control, treatment),
    device: scanDimension(rows, 'device', { iOS: 'iOS', Android: 'Android' }, cfg.segmentFdr, metricKind, control, treatment),
  };

  // 分层交互：新老效应差是否显著
  const tenureTests = segments.tenure;
  let interaction: Analysis['interaction']['tenure'] = null;
  if (tenureTests.length === 2) {
    const [a, b] = tenureTests;
    const se = Math.sqrt(a.se ** 2 + b.se ** 2);
    const diffDiff = b.diff - a.diff;
    interaction = { diffDiff, se, z: se > 0 ? diffDiff / se : 0, p: se > 0 ? twoSidedP(diffDiff / se) : 1 };
  }

  // ---- 护栏：全部改成「声明容忍度 → 检验有没有超过它」 ----
  // 退款 / 投诉是率指标 → 非劣检验（margin 是业务声明的最大可容忍恶化）；
  // P95 延迟是分位数指标 → Bootstrap（拿日级 P95 做两样本重抽样），
  // 而不是像 v1 那样硬编码 sd=50 假装做了个 t 检验。
  // 注意：护栏口径与主指标无关——ARPU 实验的退款率仍然是率指标，不能跟着换。
  //
  // 三条护栏**各自独立**：缺一列不能连累另外两条。
  // 第一版写成 `if (缺退款) {...} else if (有数据) {...三条一起...}`，
  // 结果缺 refunds 时投诉率与延迟整行消失——表格里只剩一行，
  // 比显示一个假的 0 更难被发现（截图核对时才发现）。
  const guardrails: GuardrailResult[] = [];
  // 整列缺失的护栏不能「填 0 照常算」：那会在证据链里写出一句「0.00% → 0.00%，未恶化」，
  // 读者会当成「查过了没问题」，实际是没数据。这里显式标成 unavailable，并让它不参与决策。
  const missing = new Set(cfg.missingGuardrails ?? []);
  const NA = (col: string) => `这份数据没有 ${col} 列：本护栏不参与判定`;
  const hasData = c.n > 0 && t.n > 0;
  const skip = (key: string, label: string, col: string) =>
    guardrails.push({
      key,
      label,
      controlRate: 0,
      treatmentRate: 0,
      diff: 0,
      p: 1,
      worse: false,
      gating: false,
      unavailable: NA(col),
    });

  if (hasData) {
    if (missing.has('refunds')) {
      skip('refund_rate', '退款率', 'refunds');
    } else {
      const refundTest = twoProportionZ(c.refunds, c.n, t.refunds, t.n);
      const rg = cfg.guardrails.refundRate;
      const refundNi = nonInferiority(c.refunds, c.n, t.refunds, t.n, rg.margin, rg.alpha);
      guardrails.push({
        key: 'refund_rate',
        label: '退款率',
        controlRate: c.refunds / c.n,
        treatmentRate: t.refunds / t.n,
        diff: refundTest.diff,
        p: refundTest.p,
        worse: guardrailBlocks(refundNi, rg.mode),
        gating: rg.gating,
        propTest: refundTest,
        nonInferiority: refundNi,
        marginLabel: `≤ ${(rg.margin * 100).toFixed(2)}pp`,
      });
    }

    if (missing.has('complaints')) {
      skip('complaint_rate', '投诉率', 'complaints');
    } else {
      const complaintTest = twoProportionZ(c.complaints, c.n, t.complaints, t.n);
      const cg = cfg.guardrails.complaintRate;
      const complaintNi = nonInferiority(c.complaints, c.n, t.complaints, t.n, cg.margin, cg.alpha);
      guardrails.push({
        key: 'complaint_rate',
        label: '投诉率',
        controlRate: c.complaints / c.n,
        treatmentRate: t.complaints / t.n,
        diff: complaintTest.diff,
        p: complaintTest.p,
        worse: guardrailBlocks(complaintNi, cg.mode),
        gating: cg.gating, // 低基数、噪声大，仅提示不拦截
        propTest: complaintTest,
        nonInferiority: complaintNi,
        marginLabel: cg.margin > 0 ? `≤ ${(cg.margin * 100).toFixed(3)}pp` : '任何确认的上升都要提示',
      });
    }

    if (missing.has('latencyP95')) {
      skip('latency_p95', 'P95 延迟', 'latencyP95');
    } else {
      const lc = c.latencyWeighted / c.n;
      const lt = t.latencyWeighted / t.n;
      const lg = cfg.guardrails.latencyP95;
      const latC = rows.filter((r) => r.variant === control).map((r) => r.latencyP95);
      const latT = rows.filter((r) => r.variant === treatment).map((r) => r.latencyP95);
      const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
      // 延迟用相对容忍度：margin 读作「相对 control 的比例」
      const latMargin = lg.relative ? lc * lg.margin : lg.margin;
      const latBoot = bootstrapTwoSample(latC, latT, (x, y) => mean(y) - mean(x), {
        reps: cfg.bootstrapReps,
        seed: cfg.simSeed,
        // Bootstrap 百分位检验：p = 比例{θ* ≤ margin}，p 小 → 有证据认为恶化已超过容忍度
        threshold: latMargin,
      });
      const latP = latBoot.pBelow ?? 1;
      guardrails.push({
        key: 'latency_p95',
        label: 'P95 延迟',
        controlRate: lc,
        treatmentRate: lt,
        diff: lt - lc,
        p: latP,
        worse: latP < lg.alpha,
        gating: lg.gating, // 延迟噪声大且与损失非线性，v1 仅展示
        bootstrap: latBoot,
        marginLabel: `≤ +${(lg.margin * 100).toFixed(0)}%（${latMargin.toFixed(1)}ms）`,
      });
    }
  }

  const evidence: Evidence[] = [];
  let eid = 1;
  const add = (kind: Evidence['kind'], label: string, detail: string, value?: number, calc?: CalcStep[]) => {
    evidence.push({ id: `E${eid++}`, kind, label, detail, value, calc });
  };

  // ---- SRM ----
  if (!isMulti) {
    const expC = srm.expected[0];
    const expT = srm.expected[1];
    add(
      'srm',
      'SRM 分流检查',
      `control ${c.n} vs treatment ${t.n}；χ²=${srm.chi2.toFixed(1)}，p=${ep(srm.p)}，相对偏差 ${(srm.relImb * 100).toFixed(2)}%${srm.flagged ? ' → 异常' : ' → 通过'}`,
      srm.p,
      [
        {
          title: '① 期望样本（按 50/50 分流）',
          formula: 'E = 总样本 × 分流比',
          value: `N = ${c.n} + ${t.n} = ${c.n + t.n}；E₁ = E₂ = ${expC.toFixed(1)}`,
        },
        {
          title: '② 卡方统计量',
          formula: 'χ² = Σ (观测 − 期望)² / 期望',
          value:
            `(${c.n} − ${expC.toFixed(1)})² / ${expC.toFixed(1)} + (${t.n} − ${expT.toFixed(1)})² / ${expT.toFixed(1)} = ` +
            `${(((c.n - expC) ** 2) / expC).toFixed(3)} + ${(((t.n - expT) ** 2) / expT).toFixed(3)} = ${srm.chi2.toFixed(3)}`,
        },
        {
          title: '③ p 值与判定',
          formula: `p = erfc(√(χ²/2))；异常 = p < ${cfg.srmAlpha} 且 相对偏差 > ${(cfg.srmMaxRelImb * 100).toFixed(0)}%`,
          value: `p = ${ep(srm.p)}，相对偏差 ${(srm.relImb * 100).toFixed(3)}% → ${srm.flagged ? '判定异常' : '判定通过'}`,
        },
        {
          title: '④ 为什么还要看相对偏差',
          formula: '大样本下 p 值会过度敏感',
          value: `本实验样本 ${c.n + t.n}；仅 ${(cfg.srmMaxRelImb * 100).toFixed(0)}% 以下的不均衡也可能算出 p<${cfg.srmAlpha}，所以加了实际阈值`,
        },
      ],
    );
  } else {
    const ratioText = srmRatios.map((r) => `${(r * 100).toFixed(0)}%`).join(' / ');
    const sourceText = alloc.source === 'declared' ? '实验元信息声明' : alloc.source === 'trafficSplit' ? 'trafficSplit 字段' : '按等分（数据里没有分流声明）';
    const items = arms.map((a, i) => `(${srmCounts[i]} − ${srm.expected[i].toFixed(1)})² / ${srm.expected[i].toFixed(1)}`).join(' + ');
    add(
      'srm',
      'SRM 分流检查（多臂）',
      `${arms.map((a, i) => `${armLabel(a)} ${srmCounts[i]}`).join(' / ')}；χ²=${srm.chi2.toFixed(1)}，p=${ep(srm.p)}，最大相对偏差 ${(srm.relImb * 100).toFixed(2)}%${srm.flagged ? ' → 异常' : ' → 通过'}`,
      srm.p,
      [
        {
          title: `① 期望样本（按 ${ratioText} 分流，来源：${sourceText}）`,
          formula: 'E = 总样本 × 分流比',
          value: `N = ${srmCounts.reduce((x, y) => x + y, 0)}；期望 ${srm.expected.map((e) => e.toFixed(1)).join(' / ')}`,
        },
        {
          title: '② 卡方统计量（k−1 个自由度）',
          formula: 'χ² = Σ (观测 − 期望)² / 期望，df = 臂数 − 1',
          value: `${items} = ${srm.chi2.toFixed(3)}，df = ${arms.length - 1}`,
        },
        {
          title: '③ p 值与判定',
          formula: `p 取 χ²_{${arms.length - 1}} 上尾；异常 = p < ${cfg.srmAlpha} 且 相对偏差 > ${(cfg.srmMaxRelImb * 100).toFixed(0)}%`,
          value: `p = ${ep(srm.p)}，最大相对偏差 ${(srm.relImb * 100).toFixed(3)}% → ${srm.flagged ? '判定异常' : '判定通过'}`,
        },
        {
          title: '④ 多臂的 SRM 更容易误报，所以口径必须写死',
          formula: '期望比例来自声明，不是猜的',
          value:
            alloc.source === 'equal'
              ? '⚠ 没有找到分流声明，这里按等分检查。如果实际是 50/25/25，这条 SRM 结论不可信——请在数据里补 trafficSplit（例如 "50/25/25"）。'
              : `按 ${ratioText} 检查（${sourceText}）。比例一旦猜错，正常实验会被判成异常，所以来源要显式写出来。`,
        },
      ],
    );
  }

  // ---- 主指标 ----
  if (metricKind === 'continuous' && arpu) {
    const bd = arpuBreakdown!;
    add(
      'metric',
      'ARPU',
      `control ${fmtLevel(arpu.controlValue, '元')} vs treatment ${fmtLevel(arpu.treatmentValue, '元')}；差值 ${fmtDiff(primary.diff, '元')}，95% CI [${primary.ci95[0].toFixed(2)}, ${primary.ci95[1].toFixed(2)}]元，p=${ep(primary.p)}` +
        (useCuped ? '（CUPED 调整后口径）' : '（delta method 口径）'),
      primary.p,
      ratioSteps(arpu, bd),
    );
    add(
      'metric',
      'ARPU 因子分解',
      `转化率贡献 ${bd.fromCvr >= 0 ? '+' : ''}${bd.fromCvr.toFixed(2)}元、客单价贡献 ${bd.fromAov >= 0 ? '+' : ''}${bd.fromAov.toFixed(2)}元、交叉项 ${bd.fromInteraction >= 0 ? '+' : ''}${bd.fromInteraction.toFixed(2)}元；合计 ${bd.total >= 0 ? '+' : ''}${bd.total.toFixed(2)}元`,
      undefined,
      [
        {
          title: '① 两个因子各自的水平',
          formula: 'ARPU = 转化率 × 客单价，客单价 = 收入 / 订单数',
          value: `control：${p4(bd.controlCvr)} × ${bd.controlAov.toFixed(2)}元；treatment：${p4(bd.treatmentCvr)} × ${bd.treatmentAov.toFixed(2)}元`,
        },
        {
          title: '② 恒等分解',
          formula: 'ΔARPU = AOV_c·ΔCVR + CVR_c·ΔAOV + ΔCVR·ΔAOV',
          value:
            `${bd.controlAov.toFixed(2)}×${(bd.treatmentCvr - bd.controlCvr).toFixed(6)} + ` +
            `${bd.controlCvr.toFixed(6)}×${(bd.treatmentAov - bd.controlAov).toFixed(4)} + ` +
            `${(bd.treatmentCvr - bd.controlCvr).toFixed(6)}×${(bd.treatmentAov - bd.controlAov).toFixed(4)} = ${bd.total.toFixed(4)}元`,
        },
        {
          title: '③ 怎么读',
          formula: '两块贡献的符号可以相反',
          value:
            bd.fromCvr * bd.fromAov < 0
              ? `两块贡献方向相反（转化率 ${bd.fromCvr >= 0 ? '拉高' : '拖低'}、客单价 ${bd.fromAov >= 0 ? '拉高' : '拖低'}），只看 ARPU 总量会看不出到底发生了什么——这正是必须分解的理由。`
              : `两块贡献同向，说明是「更多人买」与「单笔更贵」一起发力。`,
        },
      ],
    );
  } else {
    add(
      'metric',
      exp.primaryMetric,
      `control ${(overall.controlRate * 100).toFixed(2)}% vs treatment ${(overall.treatmentRate * 100).toFixed(2)}%；差值 ${(primary.diff * 100).toFixed(2)}pp，95% CI [${(primary.ci95[0] * 100).toFixed(2)}, ${(primary.ci95[1] * 100).toFixed(2)}]pp，p=${ep(primary.p)}` +
        (useCuped ? `（CUPED 调整后口径）` : ''),
      primary.p,
      propSteps(overall),
    );
  }

  // ---- 稳健性（只有 ARPU 口径才有）----
  // 位置在主指标之后：读者刚看到「ARPU 差 −1.04 元、p<0.001」，紧接着最该被回答的
  // 就是「这 1 块钱是不是几十个大客户贡献的」。等看完四层分析再问，性质就变了。
  if (robustness) {
    const cc = robustness.concentration;
    const top1 = cc.top[0];
    const lev = robustness.leverage[0];
    const vLabel: Record<RobustnessReport['verdict'], string> = {
      stable: '截尾前后一致（稳定）',
      sensitive: '截尾后「显著与否」翻转（对极值敏感）',
      flip: '截尾后差值符号翻转',
      unavailable: '不可用',
    };
    const scan = robustness.grid
      .map(
        (g) =>
          `${(g.p * 100).toFixed(1)}% → ${fmtDiff(g.diff, '元')}，p=${ep(g.pValue)}` +
          `（压平 ${g.clippedHigh} 行 / 占曝光 ${(g.exposureTouchedShare * 100).toFixed(1)}%）`,
      )
      .join('；');
    add(
      'robustness',
      '稳健性：极端值敏感性',
      `${vLabel[robustness.verdict]}；最重的 1% 曝光贡献了 ${(top1.revenueShare * 100).toFixed(1)}% 的收入（人人等额时这个数是 1.0%），` +
        `收入 Gini ${cc.gini.toFixed(3)}` +
        (lev
          ? `；杠杆最大的一行是「${lev.label}」（${lev.arm}，占该臂收入 ${(lev.shareOfArmRevenue * 100).toFixed(1)}%），删掉它差值会变成 ${fmtDiff(lev.diffWithout, '元')}`
          : ''),
      robustness.grid[0]?.pValue,
      [
        {
          title: '① 截尾在做什么（口径先说清）',
          formula: '每行的每单位值 vᵢ = 收入ᵢ / 曝光ᵢ；分臂按 v 的 1−p 分位把 vᵢ 压到分位线，收入ᵢ’ = min(vᵢ, v₍₁₋ₚ₎) × 曝光ᵢ',
          value:
            `分母不动、指标定义不变（这是截尾与「删掉」的本质区别）。只动右尾：左尾是「没买」的合法值，` +
            `截掉它等于假装所有人都买了。参考档位 p=${((robustness.arms.control.p || 0) * 100).toFixed(1)}% → ` +
            `对照臂上界 ${Number.isFinite(robustness.arms.control.upper) ? `${robustness.arms.control.upper.toFixed(2)} 元` : '未截尾'}，` +
            `处理臂上界 ${Number.isFinite(robustness.arms.treatment.upper) ? `${robustness.arms.treatment.upper.toFixed(2)} 元` : '未截尾'}`,
        },
        {
          title: '② 扫描：每个档位各估一次',
          formula: '同一份数据、同一套 delta method，只换截尾比例',
          value: scan || '（无有效档位）',
        },
        {
          title: '③ 集中度：极端值到底占多少（不依赖分位选择）',
          formula: '按每曝光收入降序，取最重的前 pct 曝光，累计收入 / 总收入',
          value:
            cc.top.map((x) => `前 ${(x.pct * 100).toFixed(0)}% 曝光 → ${(x.revenueShare * 100).toFixed(1)}% 收入`).join('；') +
            `；Gini ${cc.gini.toFixed(3)}（0 = 人人等额，1 = 全在一人身上）` +
            (cc.payerShare < 1 ? `；有收入的曝光占 ${(cc.payerShare * 100).toFixed(1)}%` : ''),
        },
        {
          title: '④ 单点杠杆：删掉一行，结论会变成什么（精确重算，不是近似）',
          formula: 'leave-one-row-out：去掉该行后重新跑一遍 delta method',
          value:
            robustness.leverage.length
              ? robustness.leverage
                  .map(
                    (l) =>
                      `「${l.label}」(${l.arm}) 人均 ${l.arpu.toFixed(2)} 元 → 删掉后差值 ${fmtDiff(l.diffWithout, '元')}、` +
                      `p=${ep(l.pWithout)}（差值的变动 ${fmtDiff(l.dDiff, '元')}）`,
                  )
                  .join('；')
              : '两臂分布对称，没有任何一行能单独掀动结论',
        },
        {
          title: '⑤ 这次诊断的边界（必须一起读）',
          formula: '截尾单位 = 你的数据粒度；截尾 p 值 = 敏感性指标，不是显著性结论',
          value:
            (robustness.granularity === 'user'
              ? '数据是用户级明细（每行约 1 人），截尾真正作用在用户身上。'
              : `数据是聚合格子（每行中位 ${robustness.medianExposuresPerRow.toFixed(0)} 次曝光），` +
                '截尾去掉的是「整格异常」（某一天被刷、某个人群灌量），控制不了格子内部的长尾；要做用户级截尾需要用户级明细表。') +
            ` ${robustness.reason} ${robustness.caveat}`,
        },
      ],
    );
  }


  // ---- 多臂比较（A/B/n）----
  // 放在主指标之后、副指标之前：读者先看到「这一臂 vs 对照」的结论，
  // 紧接着就要看到「你为什么选了这一臂、其余臂差在哪」。
  if (isMulti && dunnett && best && global) {
    const others = candidates.filter((a) => a.id !== treatment);
    const reasonText =
      focusReason === 'best-significant'
        ? `「${armLabel(treatment)}」在校正后仍显著为正，且是显著臂里点估计最大的`
        : focusReason === 'best-point'
          ? `没有任何臂通过校正，这里只是先把点估计最大的「${armLabel(treatment)}」摊开看（结论仍是不确定）`
          : `按元信息里指定的主推臂「${armLabel(treatment)}」`;
    add(
      'metric',
      '多臂比较（Dunnett 校正）',
      `共 ${arms.length} 臂、${dunnett.m} 次比较；` +
        candidates.map((a) => `${armLabel(a.id)} ${a.diff >= 0 ? '+' : ''}${primary.unit === '元' ? `${a.diff.toFixed(2)}元` : `${(a.diff * 100).toFixed(2)}pp`}（校正 p=${ep(a.pAdj)}，P(best)=${(a.pBest * 100).toFixed(0)}%）`).join('，') +
        `；全局检验 χ²=${global.chi2.toFixed(1)}，df=${global.df}，p=${ep(global.p)}`,
      dunnett.adjP[0],
      [
        {
          title: '① 为什么「多跑几次两臂检验」不行',
          formula: `m 次比较、每次 α=${cfg.alpha} → 全零族下至少一次误报 = 1−(1−α)^m`,
          value: `m = ${dunnett.m} → 1−0.95^${dunnett.m} = ${((1 - (1 - cfg.alpha) ** dunnett.m) * 100).toFixed(1)}%；臂越多，越容易挑出一个假赢家`,
        },
        {
          title: '② 但各臂并不独立：它们共享同一个对照',
          formula: 'ρᵢⱼ = se₀² / (seᵢ·seⱼ)，等样本量时 ≈ 0.5',
          value: `对照臂 SE = ${cmp.seControl.toExponential(3)}；本例 ρ ≈ ${dunnett.correlation.map((r) => r.toFixed(2)).join('、')}（正相关 → 可以用比 Bonferroni 更省的办法）`,
        },
        {
          title: '③ Dunnett 同时临界值（利用相关性）',
          formula: 'P(所有 |Zⱼ| ≤ c) = E_u[∏ Φ(·)] = 1−α，对 c 二分',
          value: `c = ${dunnett.crit.toFixed(3)}；Bonferroni 需要 ${dunnett.bonferroniCritZ.toFixed(3)}（差了 ${(dunnett.bonferroniCritZ - dunnett.crit).toFixed(3)}，就是「不用相关性」的代价）`,
        },
        {
          title: '④ 逐臂：校正 p 与同时区间',
          formula: 'pᵢ = 1 − P(所有 |Zⱼ| ≤ |Zᵢ|)；区间 = Δ ± c·SE（同时覆盖全部臂，不是逐条 95%）',
          value:
            candidates
              .map((a) => `${armLabel(a.id)}：边际 p=${ep(a.pRaw)} → 校正 p=${ep(a.pAdj)}，区间 [${fmtDiff(a.ci[0], primary.unit)}, ${fmtDiff(a.ci[1], primary.unit)}]`)
              .join('；'),
        },
        {
          title: '⑤ 全局检验：这个实验到底测出东西没有',
          formula: 'Q = ΔᵀΣ⁻¹Δ ~ χ²_{k−1}（Σ 对角是差值方差、非对角是共享对照的协方差）',
          value: `Q = ${global.chi2.toFixed(2)}，df = ${global.df}，p = ${ep(global.p)} → ${global.p < cfg.alpha ? '至少有一臂与对照不同' : '整体没有证据说明任何一臂不同'}`,
        },
        {
          title: '⑥ 焦点臂怎么定的，以及「赢家诅咒」',
          formula: '先看校正后显著为正者，再退回点估计最大；E[max] 的偏差约 se·(√(2lnk) − …)',
          value:
            `焦点 = 「${armLabel(treatment)}」（${reasonText}）。` +
            `全零假设下「挑最大」也会看起来有 ${primary.unit === '元' ? `+${best.winnerCurse.toFixed(2)}元` : `+${(best.winnerCurse * 100).toFixed(2)}pp`} 的效应，` +
            `所以结论不能只看「谁最大」，要看校正后的 p 与同时区间。` +
            (others.length ? `其余臂：${others.map((a) => `${armLabel(a.id)} 校正 p=${ep(a.pAdj)}`).join('、')}。` : ''),
        },
      ],
    );
  }

  // ARPU 不是主指标时，作为副指标也给出（数据里有收入就展示，避免"看不到另一个口径"）
  if (metricKind === 'rate' && arpu) {
    add(
      'metric',
      '副指标：ARPU',
      `control ${fmtLevel(arpu.controlValue, '元')} vs treatment ${fmtLevel(arpu.treatmentValue, '元')}；差值 ${fmtDiff(arpu.diff, '元')}，p=${ep(arpu.p)}（不参与决策，仅供交叉验证）`,
      arpu.p,
      arpuBreakdown ? ratioSteps(arpu, arpuBreakdown) : undefined,
    );
  }

  if (cuped) {
    const unit: 'pp' | '元' = metricKind === 'continuous' ? '元' : 'pp';
    add(
      'metric',
      'CUPED 方差缩减',
      `前周期相关系数 ρ=${cuped.rho.toFixed(3)}，θ=${cuped.theta.toFixed(3)}；` +
        `差值 ${fmtDiff(cuped.diffRaw, unit)} → ${fmtDiff(cuped.diffAdj, unit)}，` +
        `SE ${fmtDiff(cuped.seRaw, unit)} → ${fmtDiff(cuped.seAdj, unit)}，` +
        `方差缩减 ${(cuped.varReduction * 100).toFixed(1)}%${useCuped ? '（已作为决策口径）' : '（未启用）'}`,
      cuped.pAdj,
      [
        {
          title: '① 前后周期同口径对齐',
          formula: metricKind === 'continuous' ? 'X = 前周期 ARPU，Y = 实验期 ARPU（同一批单位）' : 'X = 前周期转化率，Y = 实验期转化率（同一批单位）',
          value:
            `格子数 ${cuped.nCells}；过离散因子 φ = ${cuped.dispersion.toFixed(2)}` +
            (metricKind === 'continuous'
              ? '（连续指标不适用二项过离散，固定为 1）'
              : cuped.dispersion > 1.2
                ? '（>1：朴素 i.i.d. 标准误会偏乐观）'
                : ''),
        },
        {
          title: '② 回归系数 θ',
          formula: 'θ = Σ w(X−X̄ᵥ)(Y−Ȳᵥ) / Σ w(X−X̄ᵥ)²（臂内中心化后合并）',
          value: `θ = ${cuped.theta.toFixed(4)}，ρ = ${cuped.rho.toFixed(4)}`,
        },
        {
          title: '③ 调整后的差值',
          formula: 'Δ_adj = (Ȳ_t − Ȳ_c) − θ(X̄_t − X̄_c)',
          value: `${fmtDiff(cuped.diffRaw, unit)} − ${cuped.theta.toFixed(4)} × ${fmtDiff(useCuped ? cuped.diffRaw - cuped.diffAdj : 0, unit)} = ${fmtDiff(cuped.diffAdj, unit)}`,
        },
        {
          title: '④ 标准误（格子级稳健估计，不假设 i.i.d.）',
          formula: 'Var(均值) = Σ wᵢ²(zᵢ − z̄)² / (Σwᵢ)²，z = Y − θX',
          value:
            `SE ${fmtDiff(cuped.seRaw, unit)} → ${fmtDiff(cuped.seAdj, unit)}；` +
            `方差缩减 ${(cuped.varReduction * 100).toFixed(1)}% ≈ 省 ${(cuped.sampleSaving * 100).toFixed(1)}% 样本`,
        },
        {
          title: '⑤ 检验',
          formula: `z = Δ/SE，p 用 t 分布（df = ${cuped.df}）`,
          value: `原始 p = ${ep(cuped.pRaw)}；CUPED p = ${ep(cuped.pAdj)} → ${useCuped ? '采用 CUPED 口径' : '未启用，仍用原始口径'}`,
        },
      ],
    );
  }

  // ---- 序贯（偷看校正）----
  if (!sequential.skipped && sequential.looks.length >= 2) {
    const L = sequential.looks;
    const last = L[L.length - 1];
    const first = L[0];
    add(
      'metric',
      '序贯监控（窥探校正）',
      `已观察 ${sequential.k} 次（第 1 天起每天累计）；最终 naive p=${ep(sequential.finalPNaive)}、` +
        `OBF 门槛 p<${ep(sequential.finalPBoundary)}、always-valid p=${ep(sequential.finalPAlways)}；` +
        `按 OBF 口径${sequential.obfSig ? '已越过边界' : '尚未越过边界'}`,
      sequential.finalPBoundary,
      [
        {
          title: '① 你其实看了几次',
          formula: '每看一次，α 就被花掉一点；naive 0.05 只对「只看一次」成立',
          value:
            `信息量比例 ${first.infoFrac.toFixed(2)} → ${last.infoFrac.toFixed(2)}，共 ${sequential.k} 次观察；` +
            `第 1 次观察的 z=${first.z.toFixed(3)}（边界 ±${first.zBoundary.toFixed(3)}），最后一次 z=${last.z.toFixed(3)}（边界 ±${last.zBoundary.toFixed(3)}）`,
        },
        {
          title: '② OBF α 消耗函数（Lan–DeMets）',
          formula: 'α*(t) = 2 − 2Φ(z₁₋α/₂/√t)，边界由联合分布递推数值解出',
          value:
            `累计花掉 α = ${(last.alphaSpent * 100).toFixed(2)}%（t=1 时正好等于 α=${(sequential.alpha * 100).toFixed(0)}%）；` +
            `最后一次的名义门槛收紧到 ${(sequential.finalPBoundary * 100).toFixed(2)}%，相当于 naive 阈值的 1/${sequential.obfTightening.toFixed(2)}`,
        },
        {
          title: '③ always-valid p（mSPRT）',
          formula: 'Λ = √(σ²/(σ²+τ²))·exp(τ²δ̂²/(2σ²(σ²+τ²)))，p = min(1, 1/Λ)',
          value:
            `先验尺度 τ = ${fmtDiff(sequential.priorScale, primary.unit)}（= 1.96×最终标准误，看数据前就定好）；` +
            `p_always = ${ep(sequential.finalPAlways)}。代价是它比 OBF 更严：随时可看是用功效换来的`,
        },
        {
          title: '④ 三套口径的判定',
          formula: 'naive：p<α；OBF：任一次越过该次边界；always-valid：任一次 p_always<α',
          value:
            `naive ${sequential.naiveSig ? '显著' : '不显著'} · OBF ${sequential.obfSig ? '显著' : '不显著'} · ` +
            `always-valid ${sequential.alwaysSig ? '显著' : '不显著'}` +
            (sequential.naiveSig && !sequential.obfSig ? ' → 这正是「偷看把不显著看成显著」的样子' : ''),
        },
      ],
    );
  }

  // ---- 新颖效应（效应是否随时间衰减）----
  if (!novelty.skipped && novelty.points.length >= 2) {
    const unit = primary.unit;
    const PATTERN_CN: Record<string, string> = {
      decay: '效应在衰减（后半段明显低于前半段）',
      growth: '效应在增强（后半段明显高于前半段）',
      stable: '未见衰减',
      insufficient: '数据不足',
    };
    add(
      'metric',
      '新颖效应（时间维度）',
      `前半段 ${novelty.early.days} 天 ${fmtDiff(novelty.early.diff, unit)}，后半段 ${novelty.late.days} 天 ${fmtDiff(novelty.late.diff, unit)}；` +
        `前后差 ${fmtDiff(novelty.delta, unit)}，p=${ep(novelty.p)} → ${PATTERN_CN[novelty.pattern]}`,
      novelty.p,
      [
        {
          title: '① 为什么要按曝光量对半切',
          formula: '按累计曝光首次 ≥50% 的那天切，而不是按日历天数等分',
          value:
            `两段样本 ${novelty.early.days} 天 / ${novelty.late.days} 天；` +
            `按日历等分在某天没跑量时会让两段严重失衡，SE 就没法比`,
        },
        {
          title: '② 两段的点估计',
          formula: 'Δ = 日效应按 1/SEᵢ² 精度加权（样本少的日不该和样本多的日等权）',
          value: `Δ₁ = ${fmtDiff(novelty.early.diff, unit)}（${novelty.early.days} 天，日间方差 ${fmtDiff(novelty.early.dayVar, unit)}²），Δ₂ = ${fmtDiff(novelty.late.diff, unit)}（${novelty.late.days} 天）`,
        },
        {
          title: '③ 衰减检验（日级聚类 + t）',
          formula: 'δ = Δ₂ − Δ₁；SE = √(s₁²/n₁ + s₂²/n₂)，s² 为日效应样本方差；t 用 Welch 自由度 ν',
          value:
            `δ = ${fmtDiff(novelty.delta, unit)}，SE = ${fmtDiff(novelty.seDelta, unit)}，t = ${novelty.t.toFixed(3)}，ν = ${novelty.df.toFixed(1)}，p = ${ep(novelty.p)}` +
            (novelty.relativeDelta !== null ? `；相对变化 ${(novelty.relativeDelta * 100).toFixed(1)}%` : ''),
        },
        {
          title: '④ 逐日斜率（描述形状，不做判定）',
          formula: 'WLS：Δᵢ ~ 天序号，权重 1/SEᵢ²；φ = max(1, χ²/df) 修正过离散',
          value:
            novelty.slope === null
              ? '逐日点数不足 4 个，不拟合斜率'
              : `斜率 ${fmtDiff(novelty.slope, unit)}/天，p = ${ep(novelty.slopeP ?? 1)}（过离散因子 φ = ${(novelty.dispersion ?? 1).toFixed(2)}）`,
        },
      ],
    );
  }

  // ---- 分层 ----
  for (const s of segments.tenure) {
    const segRows = rows.filter((r) => r.tenure === s.key);
    add(
      'segment',
      `分层：${s.label}`,
      `差值 ${fmtDiff(s.diff, primary.unit)}，p=${ep(s.p)}，BH q=${s.q.toFixed(3)}${s.q <= cfg.segmentFdr ? ' → 显著' : ''}`,
      s.p,
      [
        ...(s.kind === 'continuous' && s.ratio
          ? ratioSteps(s.ratio, breakdownOf(aggregate(segRows, control), aggregate(segRows, treatment)))
          : propSteps(s.rate ?? overall)),
        {
          title: '⑤ 多重比较校正（BH）',
          formula: 'q = min_{k≥rank} ( p_(k) · m / k )，m = 该维度分层数',
          value: `m = ${segments.tenure.length}，原始 p = ${ep(s.p)} → q = ${s.q.toFixed(4)}（阈值 q ≤ ${cfg.segmentFdr}）`,
        },
      ],
    );
  }
  if (interaction) {
    add(
      'segment',
      '新老交互',
      `新老效应差 ${fmtDiff(interaction.diffDiff, primary.unit)}，p=${ep(interaction.p)}`,
      interaction.p,
      [
        {
          title: '① 两个分层各自的效应',
          formula: 'Δᵢ = 该层的 treatment − control',
          value: segments.tenure.map((s) => `${s.label} Δ = ${fmtDiff(s.diff, primary.unit)}`).join('；'),
        },
        {
          title: '② 效应差与其标准误',
          formula: 'ΔΔ = Δ₂ − Δ₁，SE = √(SE₁² + SE₂²)（不合并方差）',
          value: `ΔΔ = ${fmtDiff(interaction.diffDiff, primary.unit)}，SE = ${interaction.se.toFixed(6)}`,
        },
        {
          title: '③ 交互检验',
          formula: `z = ΔΔ / SE，p = erfc(|z|/√2)，p<${cfg.interactionAlpha} 视为效应异质`,
          value: `z = ${interaction.z.toFixed(3)}，p = ${ep(interaction.p)} → ${interaction.p < cfg.interactionAlpha ? '判定异质' : '判定同质'}`,
        },
      ],
    );
  }

  // ---- 护栏 ----
  for (const g of guardrails) {
    if (g.unavailable) {
      // 没有数据就没有「逐步代入」可给——给一条说明，并把结论导向「补齐这一列」
      add('guardrail', `护栏：${g.label}（未评估）`, `${g.unavailable}。**不能把未评估当成未恶化**：要判断这条护栏，需要 refunds / complaints / latencyP95 这几列。`);
      continue;
    }
    const isMs = g.key === 'latency_p95';
    const fmt = (v: number) => (isMs ? `${v.toFixed(0)}ms` : `${(v * 100).toFixed(2)}%`);
    const fmtDiffV = (v: number) => (isMs ? `${v >= 0 ? '+' : ''}${v.toFixed(0)}ms` : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}pp`);
    let calc: CalcStep[];
    if (isMs) {
      // P95 是分位数指标，没有闭式检验：用两样本 Bootstrap（BCa）给区间，
      // 再用 Bootstrap 百分位检验给 p 值——而不是 v1 那样硬编码 sd 假装做了个 t 检验。
      const b = g.bootstrap!;
      calc = [
        {
          title: '① 两变体加权均值',
          formula: '均值 = Σ(P95ᵢ × 曝光ᵢ) / Σ曝光ᵢ',
          value: `control ${g.controlRate.toFixed(1)}ms，treatment ${g.treatmentRate.toFixed(1)}ms，差值 ${fmtDiffV(g.diff)}`,
        },
        {
          title: '② 声明容忍度',
          formula: `margin = control × ${(cfg.guardrails.latencyP95.margin * 100).toFixed(0)}%`,
          value: `${g.controlRate.toFixed(1)}ms × ${(cfg.guardrails.latencyP95.margin * 100).toFixed(0)}% = ${(g.controlRate * cfg.guardrails.latencyP95.margin).toFixed(1)}ms（${g.marginLabel}）`,
        },
        {
          title: `③ Bootstrap 区间（${b.reps.toLocaleString('en-US')} 次重抽样，${b.method === 'bca' ? 'BCa' : '百分位'}法）`,
          formula: '对两组的日级 P95 分别有放回重抽样，取均值差',
          value:
            `差值 ${fmtDiffV(b.estimate)}，95% CI [${b.ciLow.toFixed(1)}, ${b.ciHigh.toFixed(1)}]ms` +
            (b.method === 'bca' ? `（z₀=${b.z0.toFixed(3)}，a=${b.accel.toFixed(3)}）` : ''),
        },
        {
          title: '④ 判定',
          formula: `Bootstrap 百分位检验：p = 比例{θ* ≤ margin}，p < ${cfg.guardrails.latencyP95.alpha} → 确认恶化`,
          value: `p = ${ep(g.p)} → ${g.worse ? '确认恶化超容忍度' : '不能确认恶化超容忍度'}${g.gating ? '' : '（仅展示，不参与决策）'}`,
        },
      ];
    } else {
      const label = g.key === 'refund_rate' ? '退款率' : '投诉率';
      const ni = g.nonInferiority!;
      const ga = g.key === 'refund_rate' ? cfg.guardrails.refundRate : cfg.guardrails.complaintRate;
      calc = [
        ...propSteps(g.propTest!, 'count'),
        {
          title: '⑤ 声明容忍度（margin）',
          formula: 'margin = 业务可接受的最大恶化（绝对比例）',
          value: `${label} margin = ${ga.margin > 0 ? `${(ga.margin * 100).toFixed(2)}pp` : '0（任何确认的上升都要提示）'}；基线 ${(ni.controlRate * 100).toFixed(2)}%`,
        },
        {
          title: '⑥ 非劣检验（单侧，非合并方差）',
          formula: 'SE = √(p₁(1−p₁)/n₁ + p₂(1−p₂)/n₂)；z = (Δ − margin)/SE；p = 1 − Φ(z)',
          value: `SE = ${ni.se.toFixed(6)}，z = ${((ni.diff - ni.margin) / ni.se).toFixed(4)}，p = ${ep(ni.pWorse)}`,
        },
        {
          title: '⑦ 判定',
          formula: `口径「${GUARDRAIL_MODE_LABEL[ga.mode]}」：${GUARDRAIL_MODE_FORMULA[ga.mode]}`,
          value:
            `恶化 p = ${ep(ni.pHarm)}（显著 ${ni.harmSignificant ? '是' : '否'}）· 实际 ${pp2(ni.diff)} vs margin ${pp2(ni.margin)}（达阈值 ${ni.practical ? '是' : '否'}）→ ` +
            `${g.worse ? '判定恶化' : '未判定恶化'}${g.gating ? '' : '（不参与决策）'}`,
        },
        {
          title: '⑧ 这个 margin 在当前样本量下可不可判',
          formula: '「确认恶化超 margin」需要观测差值 > margin + z₁₋α·SE',
          value:
            `SE = ${(ni.se * 100).toFixed(3)}pp → 至少需要 ${(ni.detectableDelta * 100).toFixed(3)}pp 才能确认；` +
            `本实验观测 ${pp2(ni.diff)}。` +
            (ni.margin < ni.minDetectableMargin
              ? '⚠ margin 小于噪声地板（z₁₋α·SE），最严口径会漏判真实伤害，所以默认用"统计显著 ∧ 达阈值"。'
              : 'margin 高于噪声地板，最严口径可用。'),
        },
      ];
    }
    add(
      'guardrail',
      `护栏：${g.label}`,
      `control ${fmt(g.controlRate)} vs treatment ${fmt(g.treatmentRate)}，差值 ${fmtDiffV(g.diff)}，p=${ep(g.p)}${g.gating ? '' : '（仅展示，不参与决策）'}`,
      g.p,
      calc,
    );
  }

  // ---- 规则判定（按固定优先级） ----
  const worseGuardrail = guardrails.find((g) => g.gating && g.worse);
  const posSegments = segments.tenure.filter((s) => s.q <= cfg.segmentFdr && s.diff > 0);
  const bestPos = posSegments.sort((a, b) => b.diff - a.diff)[0];
  const flatSegment = bestPos
    ? segments.tenure.find((s) => s.key !== bestPos.key && s.p > cfg.alpha && Math.abs(s.diff) < 0.5 * Math.abs(bestPos.diff))
    : undefined;
  const interactionSig = !!interaction && interaction.p < cfg.interactionAlpha;
  const heterogeneous = interactionSig && !!bestPos && !!flatSegment;

  const D = (v: number) => fmtDiff(v, primary.unit);
  let decision: Decision;
  let reasonCode: Analysis['reasonCode'];
  let reason: string;

  if (srm.flagged) {
    decision = 'inconclusive';
    reasonCode = 'SRM';
    reason = `SRM 分流异常（相对偏差 ${(srm.relImb * 100).toFixed(1)}%），实验结果不可信，不能下结论。`;
  } else if (worseGuardrail) {
    decision = 'no-ship';
    reasonCode = 'GUARDRAIL';
    reason = `主指标${primary.diff > 0 ? '正向' : '负向'}，但${worseGuardrail.label}显著恶化（${(worseGuardrail.diff * 100).toFixed(2)}pp，p=${ep(worseGuardrail.p)}），护栏不通过。`;
  } else if (primary.p < cfg.alpha && primary.diff < 0) {
    decision = 'no-ship';
    reasonCode = 'NEGATIVE';
    reason = `主指标（${primary.label}）显著负向（${D(primary.diff)}，p=${ep(primary.p)}），不建议上线。`;
  } else if (heterogeneous) {
    decision = 'iterate';
    reasonCode = 'HETEROGENEOUS';
    reason = `效应集中在「${bestPos.label}」（${D(bestPos.diff)}），「${flatSegment.label}」基本无效（${D(flatSegment.diff)}，p=${ep(flatSegment.p)}），交互 p=${ep(interaction?.p ?? 1)}；建议定向上线，仅对「${bestPos.label}」放开。`;
  } else if (primary.p >= cfg.alpha) {
    decision = 'inconclusive';
    reasonCode = 'NOT_SIG';
    reason = `主指标（${primary.label}）差值 ${D(primary.diff)}，95% CI 跨 0，p=${primary.p.toFixed(2)}，证据不足。`;
  } else {
    decision = 'ship';
    reasonCode = 'POSITIVE';
    reason = `主指标（${primary.label}）显著正向（${D(primary.diff)}，p=${ep(primary.p)}），护栏无显著恶化，建议上线。`;
  }

  if (isMulti && dunnett) {
    reason += ` 多臂口径：在 ${arms.length} 个臂里选出「${armLabel(treatment)}」，p 已按 Dunnett 校正（同比较 ${dunnett.m} 次，临界值 ${dunnett.crit.toFixed(2)}）。`;
  }

  const rules: RuleTrace[] = [
    {
      code: 'SRM',
      label: '分流异常',
      condition: `p < ${cfg.srmAlpha} 且 相对偏差 > ${(cfg.srmMaxRelImb * 100).toFixed(0)}%`,
      hit: srm.flagged,
      detail: `相对偏差 ${(srm.relImb * 100).toFixed(2)}%，p = ${ep(srm.p)}`,
    },
    {
      code: 'GUARDRAIL',
      label: '护栏拦截',
      condition: `硬护栏（退款率）确认恶化超过 margin ${(cfg.guardrails.refundRate.margin * 100).toFixed(2)}pp（单侧 p < ${cfg.guardrails.refundRate.alpha}）`,
      hit: !!worseGuardrail,
      detail: worseGuardrail
        ? `${worseGuardrail.label} ${pp2(worseGuardrail.diff)}，p = ${ep(worseGuardrail.p)}${worseGuardrail.nonInferiority ? `（非劣 p=${ep(worseGuardrail.nonInferiority.pWorse)}，margin ${pp2(worseGuardrail.nonInferiority.margin)}）` : ''}`
        : '硬护栏未确认恶化',
    },
    {
      code: 'NEGATIVE',
      label: '主指标负向',
      condition: `p < ${cfg.alpha} 且 差值为负`,
      hit: primary.p < cfg.alpha && primary.diff < 0,
      detail: `${primary.label} 差值 ${D(primary.diff)}，p = ${ep(primary.p)}`,
    },
    {
      code: 'HETEROGENEOUS',
      label: '效应异质',
      condition: `交互 p < ${cfg.interactionAlpha}，且一个分层显著为正、另一个无效`,
      hit: heterogeneous,
      detail: heterogeneous
        ? `交互 p = ${ep(interaction?.p ?? 1)}；${bestPos.label} ${D(bestPos.diff)}、${flatSegment!.label} ${D(flatSegment!.diff)}`
        : interaction
          ? `交互 p = ${ep(interaction.p)}`
          : '无新老分层，无法检验',
    },
    {
      code: 'NOT_SIG',
      label: '证据不足',
      condition: `p ≥ ${cfg.alpha}（差值 95% CI 跨 0）`,
      hit: primary.p >= cfg.alpha,
      detail: `p = ${ep(primary.p)}，CI [${D(primary.ci95[0])}, ${D(primary.ci95[1])}]`,
    },
    {
      code: 'POSITIVE',
      label: '显著正向',
      condition: `p < ${cfg.alpha}、差值为正，且以上均未触发`,
      hit: primary.p < cfg.alpha && primary.diff > 0,
      detail: `${primary.label} 差值 ${D(primary.diff)}，p = ${ep(primary.p)}`,
    },
  ];

  add('decision', '结论', `${decision} · ${reason}`);

  return {
    experimentId: exp.id,
    metricKind,
    ...(metricFallback ? { metricFallback } : {}),
    primary,
    overall,
    ...(arpu ? { arpu } : {}),
    ...(arpuBreakdown ? { arpuBreakdown } : {}),
    ...(robustness ? { robustness } : {}),
    srm,
    segments,
    interaction: { tenure: interaction },
    heterogeneity: {
      detected: heterogeneous,
      interactionSig,
      interactionP: interaction ? interaction.p : null,
      bestSegment: bestPos ? bestPos.label : null,
      flatSegment: flatSegment ? flatSegment.label : null,
    },
    guardrails,
    sequential,
    novelty,
    ...(cuped ? { cuped } : {}),
    bayes,
    confidence: bayes.probTreatBetter,
    decision,
    reason,
    reasonCode,
    evidence,
    rules,
    arms: cmp.list,
    ...(isMulti && dunnett && best && global
      ? {
          multiArm: {
            k: arms.length,
            control,
            focus: treatment,
            focusReason,
            alpha: cfg.alpha,
            comparisons: dunnett.m,
            crit: dunnett.crit,
            bonferroniCritZ: dunnett.bonferroniCritZ,
            global,
            winnerCurse: best.winnerCurse,
            srmRatios,
            srmSource: alloc.source,
            ...(candidates.filter((a) => a.id !== treatment).length
              ? {
                  runnerUp: (() => {
                    const rest = candidates.filter((a) => a.id !== treatment);
                    const r = rest.reduce((a, b) => (b.diff > a.diff ? b : a));
                    return { id: r.id, diff: r.diff, pAdj: r.pAdj };
                  })(),
                }
              : {}),
          },
        }
      : {}),
  };
}
