import type { Analysis } from '../lib/decide.ts';
import type { Archetype, Dataset, Decision } from '../lib/types.ts';

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
  /** 贝叶斯置信度：P(treatment 真正优于 control) */
  confidence: number;
  /** 真实整体效应是否 > 0（校准曲线的观测目标） */
  trueLiftPositive: boolean;
  correct: boolean;
}

export interface CalibrationBin {
  /** 预测概率区间中点（0.05, 0.15, …, 0.95，以及 1.0 代表 ≥0.9） */
  probMid: number;
  n: number;
  /** 该桶内真实整体效应 > 0 的比例 */
  observed: number;
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
  rows: EvalRow[];
  mismatches: EvalRow[];
}

const BUCKETS: { label: string; test: (p: number) => boolean }[] = [
  { label: 'p < 0.001', test: (p) => p < 0.001 },
  { label: '0.001 ≤ p < 0.01', test: (p) => p >= 0.001 && p < 0.01 },
  { label: '0.01 ≤ p < 0.05', test: (p) => p >= 0.01 && p < 0.05 },
  { label: 'p ≥ 0.05', test: (p) => p >= 0.05 },
];

/** 评测的唯一口径：脚本与看板都走这里，避免两套数字 */
export function evaluate(dataset: Dataset, analyses: Map<string, Analysis>): EvalSummary {
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
      p: a.overall.p,
      diff: a.overall.diff,
      confidence: a.bayes?.probTreatBetter ?? 0.5,
      trueLiftPositive: e.trueLiftOverall > 0,
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

  // 贝叶斯置信度校准：把预测 P(B>A) 分 10 个桶，看每桶里「真实整体效应 > 0」的比例
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
  const ece =
    calibration.reduce((s, b) => s + (b.n / n) * Math.abs(b.probMid - b.observed), 0);

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
    rows,
    mismatches: rows.filter((r) => !r.correct),
  };
}
