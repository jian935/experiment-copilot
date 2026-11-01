import type { DailyRow, Decision, Experiment, Variant } from './types.ts';
import {
  bayesBetaBinomial, bayesNormal, bhAdjust, bootstrapTwoSample, cupedAdjust, guardrailBlocks,
  nonInferiority, ratioTest, srmChi2, twoProportionZ, twoSidedP, wilson,
  type BayesResult, type BootstrapResult, type CupedCell, type CupedResult, type NonInferiorityResult,
  type PropTest, type RatioCell, type RatioTest, type SrmResult,
} from './stats.ts';
import { DEFAULT_CONFIG, mergeConfig, type DecisionConfig } from './config.ts';

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
  kind: 'srm' | 'metric' | 'segment' | 'guardrail' | 'decision';
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
  guardrails: GuardrailResult[];
  /** CUPED：用前周期数据做方差缩减后的检验（无前周期数据时为 undefined）；口径与主指标一致 */
  cuped?: CupedResult;
  /** 贝叶斯视角：率口径用 Beta-Binomial，连续口径用正态后验 */
  bayes: BayesResult;
  /** 置信度 = P(treatment 真正优于 control)；与频率派 p 值口径不同，但结论互补 */
  confidence: number;
  decision: Decision;
  reason: string;
  reasonCode: 'SRM' | 'GUARDRAIL' | 'NOT_SIG' | 'NEGATIVE' | 'HETEROGENEOUS' | 'POSITIVE';
  evidence: Evidence[];
  rules: RuleTrace[];
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
function ratioCellsOf(rows: DailyRow[]): RatioCell[] {
  const out: RatioCell[] = [];
  for (const r of rows) {
    if (r.revenue === undefined || !(r.exposures > 0)) continue;
    out.push({ n: r.exposures, sum: r.revenue, treatment: r.variant === 'treatment' });
  }
  return out;
}

function hasRevenue(rows: DailyRow[]): boolean {
  return rows.some((r) => r.revenue !== undefined && r.revenue > 0);
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
): SegmentTest[] {
  const keys = Array.from(new Set(rows.map((r) => String(r[dim]))));
  const raw = keys.map((key): Omit<SegmentTest, 'q'> => {
    const sub = rows.filter((r) => String(r[dim]) === key);
    const label = labels[key] || key;
    if (kind === 'continuous') {
      const rt = ratioTest(ratioCellsOf(sub));
      if (rt) {
        return {
          key, label, kind: 'continuous',
          controlValue: rt.controlValue, treatmentValue: rt.treatmentValue,
          diff: rt.diff, p: rt.p, ci95: rt.ci95, se: rt.se, ratio: rt,
        };
      }
    }
    const c = aggregate(sub, 'control');
    const t = aggregate(sub, 'treatment');
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

export function analyze(exp: Experiment, allRows: DailyRow[], cfgOverride?: Partial<DecisionConfig>): Analysis {
  const cfg = mergeConfig(cfgOverride);
  const rows = allRows.filter((r) => r.expId === exp.id);
  const c = aggregate(rows, 'control');
  const t = aggregate(rows, 'treatment');
  const overall = twoProportionZ(c.c, c.n, t.c, t.n);

  // ---- 口径判定 ----
  // 实验声明了 ARPU 但数据里没有收入字段时，不能"当成率算"糊过去，也不能假装有数：
  // 退回转化率口径，并把原因写进 metricFallback 让 UI 显式提示。
  const revenueOk = hasRevenue(rows);
  const wantContinuous = exp.metricType === 'continuous';
  const metricKind: 'rate' | 'continuous' = wantContinuous && revenueOk ? 'continuous' : 'rate';
  const metricFallback =
    wantContinuous && !revenueOk
      ? '该实验声明以 ARPU 为主指标，但数据中没有 revenue 字段，已退回转化率口径（结论仍然有效，只是主指标换了）'
      : undefined;

  const arpu = revenueOk ? ratioTest(ratioCellsOf(rows)) ?? undefined : undefined;
  const arpuBreakdown = arpu ? breakdownOf(c, t) : undefined;

  // CUPED：只有明细行带前周期数据时才算（导入的真实数据常常没有，那就自动退回普通检验）。
  // 协变量必须与主指标同口径：率指标用前周期转化数，ARPU 用前周期收入。
  const cells: CupedCell[] = [];
  for (const r of rows) {
    if (r.preExposures && r.exposures > 0) {
      if (metricKind === 'continuous') {
        if (r.preRevenue === undefined) continue;
        cells.push({ n: r.exposures, c: r.revenue ?? 0, nPre: r.preExposures, cPre: r.preRevenue, treatment: r.variant === 'treatment' });
      } else if (r.preConversions !== undefined) {
        cells.push({ n: r.exposures, c: r.conversions, nPre: r.preExposures, cPre: r.preConversions, treatment: r.variant === 'treatment' });
      }
    }
  }
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

  // 贝叶斯视角：率口径用 Beta-Binomial（把过离散折算成有效样本量，否则后验过度自信）；
  // 连续口径没有「计数/样本量」结构，用正态后验（bayesNormal），公式逐字对应。
  const bayes =
    metricKind === 'continuous'
      ? bayesNormal(primary.diff, primary.se)
      : bayesBetaBinomial(c.c, c.n, t.c, t.n, cuped?.dispersion ?? 1);

  const srm = srmChi2([c.n, t.n], [0.5, 0.5], cfg.srmAlpha, cfg.srmMaxRelImb);

  // 分层也必须跟主指标同口径：ARPU 实验按转化率分层会答错问题
  const segments = {
    tenure: scanDimension(rows, 'tenure', { new: '新用户', old: '老用户' }, cfg.segmentFdr, metricKind),
    device: scanDimension(rows, 'device', { iOS: 'iOS', Android: 'Android' }, cfg.segmentFdr, metricKind),
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
  const guardrails: GuardrailResult[] = [];
  if (c.n > 0 && t.n > 0) {
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

    const lc = c.latencyWeighted / c.n;
    const lt = t.latencyWeighted / t.n;
    const lg = cfg.guardrails.latencyP95;
    const latC = rows.filter((r) => r.variant === 'control').map((r) => r.latencyP95);
    const latT = rows.filter((r) => r.variant === 'treatment').map((r) => r.latencyP95);
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

  const evidence: Evidence[] = [];
  let eid = 1;
  const add = (kind: Evidence['kind'], label: string, detail: string, value?: number, calc?: CalcStep[]) => {
    evidence.push({ id: `E${eid++}`, kind, label, detail, value, calc });
  };

  // ---- SRM ----
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
          ? ratioSteps(s.ratio, breakdownOf(aggregate(segRows, 'control'), aggregate(segRows, 'treatment')))
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
  const heterogeneous = !!interaction && interaction.p < cfg.interactionAlpha && !!bestPos && !!flatSegment;

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
    srm,
    segments,
    interaction: { tenure: interaction },
    guardrails,
    ...(cuped ? { cuped } : {}),
    bayes,
    confidence: bayes.probTreatBetter,
    decision,
    reason,
    reasonCode,
    evidence,
    rules,
  };
}
