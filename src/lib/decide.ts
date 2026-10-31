import type { DailyRow, Decision, Experiment, Variant } from './types.ts';
import {
  bhAdjust, srmChi2, twoProportionZ, twoSidedP, welchTest,
  type PropTest, type SrmResult,
} from './stats.ts';

export interface VariantAgg {
  n: number;
  c: number;
  refunds: number;
  complaints: number;
  latencyWeighted: number;
}

export interface SegmentTest {
  key: string;
  label: string;
  test: PropTest;
  q: number;
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
}

export interface Evidence {
  id: string;
  kind: 'srm' | 'metric' | 'segment' | 'guardrail' | 'decision';
  label: string;
  value?: number;
  detail: string;
}

export interface Analysis {
  experimentId: string;
  overall: PropTest;
  srm: SrmResult;
  segments: { tenure: SegmentTest[]; device: SegmentTest[] };
  interaction: { tenure: { diffDiff: number; p: number } | null };
  guardrails: GuardrailResult[];
  decision: Decision;
  reason: string;
  reasonCode: 'SRM' | 'GUARDRAIL' | 'NOT_SIG' | 'NEGATIVE' | 'HETEROGENEOUS' | 'POSITIVE';
  evidence: Evidence[];
}

/** 证据文本里的 p 值：erfc 大 |z| 下溢到 0 时写 <1e-16，避免出现 0.00e+0 */
function ep(p: number): string {
  if (!Number.isFinite(p)) return '—';
  if (p < 1e-16) return '<1e-16';
  if (p >= 0.001) return p.toFixed(3);
  return p.toExponential(2);
}

function emptyAgg(): VariantAgg {
  return { n: 0, c: 0, refunds: 0, complaints: 0, latencyWeighted: 0 };
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
  }
  return a;
}

function unpooledSe(t: PropTest): number {
  return Math.sqrt(
    (t.controlRate * (1 - t.controlRate)) / t.n1 +
    (t.treatmentRate * (1 - t.treatmentRate)) / t.n2,
  );
}

function scanDimension(rows: DailyRow[], dim: 'tenure' | 'device', labels: Record<string, string>): SegmentTest[] {
  const keys = Array.from(new Set(rows.map((r) => String(r[dim]))));
  const raw = keys.map((key) => {
    const sub = rows.filter((r) => String(r[dim]) === key);
    const c = aggregate(sub, 'control');
    const t = aggregate(sub, 'treatment');
    return { key, label: labels[key] || key, test: twoProportionZ(c.c, c.n, t.c, t.n) };
  });
  const { qvals } = bhAdjust(raw.map((x) => x.test.p), 0.1);
  return raw.map((x, i) => ({ ...x, q: qvals[i] }));
}

export function analyze(exp: Experiment, allRows: DailyRow[]): Analysis {
  const rows = allRows.filter((r) => r.expId === exp.id);
  const c = aggregate(rows, 'control');
  const t = aggregate(rows, 'treatment');
  const overall = twoProportionZ(c.c, c.n, t.c, t.n);

  const srm = srmChi2([c.n, t.n], [0.5, 0.5]);

  const segments = {
    tenure: scanDimension(rows, 'tenure', { new: '新用户', old: '老用户' }),
    device: scanDimension(rows, 'device', { iOS: 'iOS', Android: 'Android' }),
  };

  // 分层交互：新老效应差是否显著
  const tenureTests = segments.tenure;
  let interaction: Analysis['interaction']['tenure'] = null;
  if (tenureTests.length === 2) {
    const [a, b] = tenureTests;
    const se = Math.sqrt(unpooledSe(a.test) ** 2 + unpooledSe(b.test) ** 2);
    const diffDiff = b.test.diff - a.test.diff;
    interaction = { diffDiff, p: se > 0 ? twoSidedP(diffDiff / se) : 1 };
  }

  const guardrails: GuardrailResult[] = [];
  if (c.n > 0 && t.n > 0) {
    // v1 只让「退款率」做硬护栏：alpha 0.01 + 实际阈值 0.4pp
    // （1.2% 基线 → 相对 +33% 才算实质恶化；避免低基数指标随机波动导致误报）
    const refundTest = twoProportionZ(c.refunds, c.n, t.refunds, t.n);
    guardrails.push({
      key: 'refund_rate',
      label: '退款率',
      controlRate: c.refunds / c.n,
      treatmentRate: t.refunds / t.n,
      diff: refundTest.diff,
      p: refundTest.p,
      worse: refundTest.diff > 0.004 && refundTest.p < 0.01,
      gating: true,
    });
    const complaintTest = twoProportionZ(c.complaints, c.n, t.complaints, t.n);
    guardrails.push({
      key: 'complaint_rate',
      label: '投诉率',
      controlRate: c.complaints / c.n,
      treatmentRate: t.complaints / t.n,
      diff: complaintTest.diff,
      p: complaintTest.p,
      worse: complaintTest.diff > 0 && complaintTest.p < 0.01,
      gating: false, // 低基数、噪声大，v1 仅展示
    });
    const lc = c.latencyWeighted / c.n;
    const lt = t.latencyWeighted / t.n;
    guardrails.push({
      key: 'latency_p95',
      label: 'P95 延迟',
      controlRate: lc,
      treatmentRate: lt,
      diff: lt - lc,
      p: welchTest(lc, 50, c.n, lt, 50, t.n).p,
      worse: lt > lc * 1.05,
      gating: false, // v1 只展示，不参与决策
    });
  }

  const evidence: Evidence[] = [];
  let eid = 1;
  const add = (kind: Evidence['kind'], label: string, detail: string, value?: number) => {
    evidence.push({ id: `E${eid++}`, kind, label, detail, value });
  };

  add('srm', 'SRM 分流检查',
    `control ${c.n} vs treatment ${t.n}；χ²=${srm.chi2.toFixed(1)}，p=${ep(srm.p)}，相对偏差 ${(srm.relImb * 100).toFixed(2)}%${srm.flagged ? ' → 异常' : ' → 通过'}`,
    srm.p);
  add('metric', exp.primaryMetric,
    `control ${(overall.controlRate * 100).toFixed(2)}% vs treatment ${(overall.treatmentRate * 100).toFixed(2)}%；差值 ${(overall.diff * 100).toFixed(2)}pp，95% CI [${(overall.ci95[0] * 100).toFixed(2)}, ${(overall.ci95[1] * 100).toFixed(2)}]pp，p=${ep(overall.p)}`,
    overall.p);
  for (const s of segments.tenure) {
    add('segment', `分层：${s.label}`,
      `差值 ${(s.test.diff * 100).toFixed(2)}pp，p=${ep(s.test.p)}，BH q=${s.q.toFixed(3)}${s.q <= 0.1 ? ' → 显著' : ''}`,
      s.test.p);
  }
  if (interaction) {
    add('segment', '新老交互',
      `新老效应差 ${(interaction.diffDiff * 100).toFixed(2)}pp，p=${ep(interaction.p)}`,
      interaction.p);
  }
  for (const g of guardrails) {
    const isMs = g.key === 'latency_p95';
    const fmt = (v: number) => (isMs ? `${v.toFixed(0)}ms` : `${(v * 100).toFixed(2)}%`);
    const fmtDiff = (v: number) => (isMs ? `${v >= 0 ? '+' : ''}${v.toFixed(0)}ms` : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}pp`);
    add('guardrail', `护栏：${g.label}`,
      `control ${fmt(g.controlRate)} vs treatment ${fmt(g.treatmentRate)}，差值 ${fmtDiff(g.diff)}，p=${ep(g.p)}${g.gating ? '' : '（仅展示，不参与决策）'}`,
      g.p);
  }

  let decision: Decision;
  let reasonCode: Analysis['reasonCode'];
  let reason: string;

  const worseGuardrail = guardrails.find((g) => g.gating && g.worse);
  const posSegments = segments.tenure.filter((s) => s.q <= 0.1 && s.test.diff > 0);
  const bestPos = posSegments.sort((a, b) => b.test.diff - a.test.diff)[0];
  const flatSegment = bestPos
    ? segments.tenure.find((s) => s.key !== bestPos.key && s.test.p > 0.1 && Math.abs(s.test.diff) < 0.5 * Math.abs(bestPos.test.diff))
    : undefined;
  const heterogeneous = !!interaction && interaction.p < 0.01 && !!bestPos && !!flatSegment;

  if (srm.flagged) {
    decision = 'inconclusive';
    reasonCode = 'SRM';
    reason = `SRM 分流异常（相对偏差 ${(srm.relImb * 100).toFixed(1)}%），实验结果不可信，不能下结论。`;
  } else if (worseGuardrail) {
    decision = 'no-ship';
    reasonCode = 'GUARDRAIL';
    reason = `主指标${overall.diff > 0 ? '正向' : '负向'}，但${worseGuardrail.label}显著恶化（${(worseGuardrail.diff * 100).toFixed(2)}pp，p=${ep(worseGuardrail.p)}），护栏不通过。`;
  } else if (overall.p < 0.05 && overall.diff < 0) {
    decision = 'no-ship';
    reasonCode = 'NEGATIVE';
    reason = `主指标显著负向（${(overall.diff * 100).toFixed(2)}pp，p=${ep(overall.p)}），不建议上线。`;
  } else if (heterogeneous) {
    decision = 'iterate';
    reasonCode = 'HETEROGENEOUS';
    reason = `效应集中在「${bestPos.label}」（${(bestPos.test.diff * 100).toFixed(2)}pp），「${flatSegment.label}」基本无效（${(flatSegment.test.diff * 100).toFixed(2)}pp，p=${ep(flatSegment.test.p)}），交互 p=${ep(interaction?.p ?? 1)}；建议定向上线，仅对「${bestPos.label}」放开。`;
  } else if (overall.p >= 0.05) {
    decision = 'inconclusive';
    reasonCode = 'NOT_SIG';
    reason = `主指标差值 ${(overall.diff * 100).toFixed(2)}pp，95% CI 跨 0，p=${overall.p.toFixed(2)}，证据不足。`;
  } else {
    decision = 'ship';
    reasonCode = 'POSITIVE';
    reason = `主指标显著正向（${(overall.diff * 100).toFixed(2)}pp，p=${ep(overall.p)}），护栏无显著恶化，建议上线。`;
  }

  add('decision', '结论', `${decision} · ${reason}`);
  return { experimentId: exp.id, overall, srm, segments, interaction: { tenure: interaction }, guardrails, decision, reason, reasonCode, evidence };
}
