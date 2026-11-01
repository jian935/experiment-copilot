import type { Analysis } from '../lib/decide.ts';
import type { Archetype, Dataset, Decision } from '../lib/types.ts';
import { mulberry32 } from './stats.ts';
import type { AgentQaEval } from './agentEval.ts';

export const DECISIONS: Decision[] = ['ship', 'no-ship', 'iterate', 'inconclusive'];

export interface EvalRow {
  id: string;
  name: string;
  archetype: Archetype;
  trueDecision: Decision;
  predDecision: Decision;
  reasonCode: string;
  p: number;
  diff: number;
  /** 主指标类型：pp 与 元 混在一张表里时，读数必须知道口径 */
  metricKind: 'rate' | 'continuous';
  /** 贝叶斯置信度：P(treatment 真正优于 control) */
  confidence: number;
  /** 真实整体效应是否 > 0（校准曲线的观测目标） */
  trueLiftPositive: boolean;
  /** 真实效应是否非零（null / SRM 的真值是精确 0，放进校准会人为拉高 ECE，见 eceEffects） */
  trueLiftNonZero: boolean;
  /** 异质检测器判定（与决策解耦：决策可能被更早的规则拦走） */
  heteroDetected: boolean;
  /** 只看交互是否显著（检测器的宽松口径） */
  heteroInteractionSig: boolean;
  correct: boolean;
}

export interface CalibrationBin {
  /** 预测概率区间中点（0.05, 0.15, …, 0.95，以及 1.0 代表 ≥0.9） */
  probMid: number;
  n: number;
  /** 该桶内真实整体效应 > 0 的比例 */
  observed: number;
}

/** 混淆四格 + 由它导出的 precision / recall / F1 */
export interface F1Block {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  f1: number;
}

/**
 * 分层（效应异质）检测的 F1。
 *
 * 为什么单独算而不看决策准确率：决策是 SRM → 护栏 → 负向 → 异质 → 不显著 → 正向的合取链，
 * 一个异质实验可能因为更早的规则被拦走，从决策上看是「对」的，但异质检测器其实没被验证到。
 * 所以这里直接对**检测器**打分：真值 = archetype 是 heterogeneous，
 * 预测 = analysis.heterogeneity.detected。
 *
 * `interactionOnly` 是同一个检测器去掉「一个分层显著为正、另一个无效」这层合取后的口径，
 * 它给出灵敏度上限——两个 F1 摆一起，才能看出掉分是掉在「交互没显著」还是「合取条件太严」。
 */
export interface HeteroF1 extends F1Block {
  /** 真异质实验总数（= tp + fn） */
  positives: number;
  /** 对实验重抽样的 95% 区间。n=120 时 F1 的抽样波动很大，不给区间等于骗人 */
  f1Ci: [number, number];
  interactionOnly: F1Block;
}

export interface EvalSummary {
  n: number;
  correct: number;
  accuracy: number;
  /** 混淆矩阵：rows = 真实，cols = 预测（顺序见 DECISIONS） */
  confusion: number[][];
  /** 无效应被判为有效应（null → ship/iterate） */
  fpr: { hit: number; n: number; rate: number };
  /** 正向实验没被判 ship */
  fnrPositive: { miss: number; n: number; rate: number };
  /** 负向实验没被判 no-ship */
  fnrNegative: { miss: number; n: number; rate: number };
  byArchetype: { archetype: Archetype; n: number; correct: number; accuracy: number }[];
  /** 按 p 值分桶：越靠近阈值，准确率越能反映"证据强度" */
  byPValue: { label: string; n: number; correct: number; accuracy: number }[];
  /** 贝叶斯置信度校准：预测 P(B>A) 分桶 vs 实际 treatment 更优的比例 */
  calibration: CalibrationBin[];
  /** 期望校准误差（ECE）：各桶 |预测−观测| 按样本量加权平均 */
  ece: number;
  /**
   * 只在「真实效应非零」的实验上算的 ECE。
   *
   * 为什么需要第二个口径：null 与 SRM 的真值是**精确的 0**，而校准的观测目标被二值化成
   * 「真实效应 > 0」。精确 0 会被记成 0（负类），于是任何 5%–85% 的中间置信度都必然算错，
   * 全量 ECE 被这批实验系统性抬高。这不是后验不校准，是二值化口径的产物。
   * 在真值非零的实验上算，才是在问「贝叶斯说 90% 更优时，真的 90% 更优吗」。
   */
  eceEffects: { ece: number; n: number; calibration: CalibrationBin[] };
  /** 分层（异质）检测的 F1（E1） */
  hetero: HeteroF1;
  /** Agent 问答评测（D6）。由调用方传入 —— 它要跑上千次模板生成，不在 evaluate 里实时算 */
  agent?: AgentQaEval;
  rows: EvalRow[];
  mismatches: EvalRow[];
}

const BUCKETS: { label: string; test: (p: number) => boolean }[] = [
  { label: 'p < 0.001', test: (p) => p < 0.001 },
  { label: '0.001 ≤ p < 0.01', test: (p) => p >= 0.001 && p < 0.01 },
  { label: '0.01 ≤ p < 0.05', test: (p) => p >= 0.01 && p < 0.05 },
  { label: 'p ≥ 0.05', test: (p) => p >= 0.05 },
];

/** 把预测 P(B>A) 分 10 桶，看每桶里真实效应为正的比例，并算 ECE */
function calibrate(rows: EvalRow[]): { calibration: CalibrationBin[]; ece: number } {
  const NB = 10;
  const binAgg: { n: number; hit: number; mid: number }[] = Array.from({ length: NB }, (_, i) => ({
    n: 0,
    hit: 0,
    mid: (i + 0.5) / NB,
  }));
  for (const r of rows) {
    const b = Math.min(NB - 1, Math.max(0, Math.floor(r.confidence * NB)));
    binAgg[b].n += 1;
    if (r.trueLiftPositive) binAgg[b].hit += 1;
  }
  const calibration: CalibrationBin[] = binAgg
    .filter((x) => x.n > 0)
    .map((x) => ({ probMid: x.mid, n: x.n, observed: x.n ? x.hit / x.n : 0 }));
  const total = rows.length;
  const ece = total
    ? calibration.reduce((s, b) => s + (b.n / total) * Math.abs(b.probMid - b.observed), 0)
    : 0;
  return { calibration, ece };
}

/** 由四格算 precision / recall / F1；分母为 0 时按 0 记（没有正预测就是没有检出，F1 不该是 1） */
export function f1Of(tp: number, fp: number, fn: number, tn: number): F1Block {
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, fp, fn, tn, precision, recall, f1 };
}

/** bootstrap 的固定种子：区间每次跑必须一样，否则基线比对每次都说「漂移了」 */
const F1_BOOT_SEED = 20261101;
const F1_BOOT_REPS = 1000;

/**
 * 分层 F1。
 *
 * 真值取 archetype === 'heterogeneous'（生成器注入的「新老用户效应不同」），
 * 预测取 analysis.heterogeneity.detected。**不拿 decision === 'iterate' 当预测**：
 * 决策是多规则合取的产物，用它反推会把别的规则的锅算到分层头上。
 *
 * 为什么必须带区间：正例只有 15 个，F1 对单个样本的移动极其敏感（动一个正例 F1 就跳几个点）。
 * 只报点估计会让人以为「F1=0.8 就是稳定达到 0.8」，实际上区间可能跨 0.6–0.9。
 */
function heteroF1Of(rows: EvalRow[]): HeteroF1 {
  const count = (useInteractionOnly: boolean) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    for (const r of rows) {
      const truth = r.archetype === 'heterogeneous';
      const pred = useInteractionOnly ? r.heteroInteractionSig : r.heteroDetected;
      if (truth && pred) tp += 1;
      else if (!truth && pred) fp += 1;
      else if (truth && !pred) fn += 1;
      else tn += 1;
    }
    return f1Of(tp, fp, fn, tn);
  };

  const main = count(false);
  const draws: number[] = [];
  if (rows.length > 1) {
    const rng = mulberry32(F1_BOOT_SEED);
    for (let b = 0; b < F1_BOOT_REPS; b++) {
      let tp = 0;
      let fp = 0;
      let fn = 0;
      let tn = 0;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[Math.floor(rng() * rows.length)];
        const truth = r.archetype === 'heterogeneous';
        if (truth && r.heteroDetected) tp += 1;
        else if (!truth && r.heteroDetected) fp += 1;
        else if (truth && !r.heteroDetected) fn += 1;
        else tn += 1;
      }
      draws.push(f1Of(tp, fp, fn, tn).f1);
    }
    draws.sort((a, b) => a - b);
  }
  const pick = (q: number) => (draws.length ? draws[Math.min(draws.length - 1, Math.max(0, Math.floor(q * draws.length)))] : main.f1);

  return {
    ...main,
    positives: main.tp + main.fn,
    f1Ci: [pick(0.025), pick(0.975)],
    interactionOnly: count(true),
  };
}

/**
 * 评测的唯一口径：脚本与看板都走这里，避免两套数字。
 *
 * `opts.agent` 用来把 Agent 问答评测（D6）并进来。它不在这里实时跑，因为跑一遍要 1 秒左右
 * （120 个实验 × 14 道题 ≈ 1700 条回答），放进 useMemo 会卡界面；
 * 由脚本生成 `data/agent_eval.json`、看板 fetch 后传进来，口径仍然只有一份。
 */
export function evaluate(
  dataset: Dataset,
  analyses: Map<string, Analysis>,
  opts?: { agent?: AgentQaEval },
): EvalSummary {
  const rows: EvalRow[] = [];
  const confusion = DECISIONS.map(() => DECISIONS.map(() => 0));

  for (const e of dataset.experiments) {
    const a = analyses.get(e.id);
    if (!a) continue;
    rows.push({
      id: e.id,
      name: e.name,
      archetype: e.archetype,
      trueDecision: e.trueDecision,
      predDecision: a.decision,
      reasonCode: a.reasonCode,
      // 用主指标口径（率 or ARPU）而不是恒有的转化率口径：
      // 主指标是 ARPU 的实验，决策依据是 ARPU 的 p 值，用它分桶才与决策逻辑一致。
      p: a.primary.p,
      diff: a.primary.diff,
      metricKind: a.primary.kind,
      confidence: a.bayes?.probTreatBetter ?? 0.5,
      trueLiftPositive: e.trueLiftOverall > 0,
      trueLiftNonZero: e.trueLiftOverall !== 0,
      // 旧版 Analysis 没有 heterogeneity 字段（比如测试里的手搓对象）：按「未检出」处理，
      // 而不是抛错——评测不该因为一个可选字段缺失就整页崩掉。
      heteroDetected: a.heterogeneity?.detected ?? false,
      heteroInteractionSig: a.heterogeneity?.interactionSig ?? false,
      correct: a.decision === e.trueDecision,
    });
    confusion[DECISIONS.indexOf(e.trueDecision)][DECISIONS.indexOf(a.decision)] += 1;
  }

  const n = rows.length;
  const correct = rows.filter((r) => r.correct).length;

  // 只用 archetype=null（真实无效应）做分母：SRM 实验属于"数据坏了"，是另一种失败模式，
  // 混进来会把误报率稀释（10 个 SRM 全部被规则拦下，等于白送分母）。
  const nullRows = rows.filter((r) => r.archetype === 'null');
  const nullHit = nullRows.filter((r) => r.predDecision === 'ship' || r.predDecision === 'iterate').length;
  const posRows = rows.filter((r) => r.trueDecision === 'ship');
  const posMiss = posRows.filter((r) => r.predDecision !== 'ship').length;
  const negRows = rows.filter((r) => r.trueDecision === 'no-ship');
  const negMiss = negRows.filter((r) => r.predDecision !== 'no-ship').length;

  const archetypes = [...new Set(rows.map((r) => r.archetype))];
  const byArchetype = archetypes
    .map((archetype) => {
      const sub = rows.filter((r) => r.archetype === archetype);
      return { archetype, n: sub.length, correct: sub.filter((r) => r.correct).length, accuracy: 0 };
    })
    .map((r) => ({ ...r, accuracy: r.n ? r.correct / r.n : 0 }))
    .sort((a, b) => b.n - a.n);

  const byPValue = BUCKETS.map((b) => {
    const sub = rows.filter((r) => b.test(r.p));
    return { label: b.label, n: sub.length, correct: sub.filter((r) => r.correct).length, accuracy: sub.length ? sub.filter((r) => r.correct).length / sub.length : 0 };
  });

  // 贝叶斯置信度校准：两个口径一起给（全量 + 只看真值非零的实验），差异本身就是结论
  const full = calibrate(rows);
  const effects = calibrate(rows.filter((r) => r.trueLiftNonZero));
  const { calibration, ece } = full;

  return {
    n,
    correct,
    accuracy: n ? correct / n : 0,
    confusion,
    fpr: { hit: nullHit, n: nullRows.length, rate: nullRows.length ? nullHit / nullRows.length : 0 },
    fnrPositive: { miss: posMiss, n: posRows.length, rate: posRows.length ? posMiss / posRows.length : 0 },
    fnrNegative: { miss: negMiss, n: negRows.length, rate: negRows.length ? negMiss / negRows.length : 0 },
    byArchetype,
    byPValue,
    calibration,
    ece,
    eceEffects: { ece: effects.ece, n: effects.calibration.reduce((s, b) => s + b.n, 0), calibration: effects.calibration },
    hetero: heteroF1Of(rows),
    ...(opts?.agent ? { agent: opts.agent } : {}),
    rows,
    mismatches: rows.filter((r) => !r.correct),
  };
}
