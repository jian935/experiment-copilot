import type { DailyRow, Decision, Experiment, Variant } from './types.ts';
import {
  bayesBetaBinomial, bhAdjust, srmChi2, twoProportionZ, twoSidedP, welchTest, wilson,
  type BayesResult, type PropTest, type SrmResult,
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
  /** 率类护栏的原始检验结果（延迟指标没有），用于逐步代入时复用真实 z / CI */
  propTest?: PropTest;
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

export interface Analysis {
  experimentId: string;
  overall: PropTest;
  srm: SrmResult;
  segments: { tenure: SegmentTest[]; device: SegmentTest[] };
  interaction: { tenure: { diffDiff: number; se: number; z: number; p: number } | null };
  guardrails: GuardrailResult[];
  /** 贝叶斯视角（Beta-Binomial 后验）：P(treatment 更优)、可信区间、期望损失 */
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

const p4 = (v: number) => `${(v * 100).toFixed(4)}%`;
const pp2 = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}pp`;

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

  // 贝叶斯视角：把两变体当作 Beta 后验，给出「treatment 真比 control 好」的概率
  const bayes = bayesBetaBinomial(c.c, c.n, t.c, t.n);

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
    interaction = { diffDiff, se, z: se > 0 ? diffDiff / se : 0, p: se > 0 ? twoSidedP(diffDiff / se) : 1 };
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
      propTest: refundTest,
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
      propTest: complaintTest,
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
        formula: 'p = erfc(√(χ²/2))；异常 = p < 0.001 且 相对偏差 > 2%',
        value: `p = ${ep(srm.p)}，相对偏差 ${(srm.relImb * 100).toFixed(3)}% → ${srm.flagged ? '判定异常' : '判定通过'}`,
      },
      {
        title: '④ 为什么还要看相对偏差',
        formula: '大样本下 p 值会过度敏感',
        value: `本实验样本 ${c.n + t.n}；仅 1.6% 的不均衡也可能算出 p<0.001，所以加了 2% 的实际阈值`,
      },
    ],
  );

  // ---- 主指标 ----
  add(
    'metric',
    exp.primaryMetric,
    `control ${(overall.controlRate * 100).toFixed(2)}% vs treatment ${(overall.treatmentRate * 100).toFixed(2)}%；差值 ${(overall.diff * 100).toFixed(2)}pp，95% CI [${(overall.ci95[0] * 100).toFixed(2)}, ${(overall.ci95[1] * 100).toFixed(2)}]pp，p=${ep(overall.p)}`,
    overall.p,
    propSteps(overall),
  );

  // ---- 分层 ----
  for (const s of segments.tenure) {
    add(
      'segment',
      `分层：${s.label}`,
      `差值 ${(s.test.diff * 100).toFixed(2)}pp，p=${ep(s.test.p)}，BH q=${s.q.toFixed(3)}${s.q <= 0.1 ? ' → 显著' : ''}`,
      s.test.p,
      [
        ...propSteps(s.test),
        {
          title: '⑤ 多重比较校正（BH）',
          formula: 'q = min_{k≥rank} ( p_(k) · m / k )，m = 该维度分层数',
          value: `m = ${segments.tenure.length}，原始 p = ${ep(s.test.p)} → q = ${s.q.toFixed(4)}（阈值 q ≤ 0.10）`,
        },
      ],
    );
  }
  if (interaction) {
    add(
      'segment',
      '新老交互',
      `新老效应差 ${(interaction.diffDiff * 100).toFixed(2)}pp，p=${ep(interaction.p)}`,
      interaction.p,
      [
        {
          title: '① 两个分层各自的效应',
          formula: 'Δᵢ = p̂ᵢ,treatment − p̂ᵢ,control',
          value: segments.tenure
            .map((s) => `${s.label} Δ = ${pp2(s.test.diff)}`)
            .join('；'),
        },
        {
          title: '② 效应差与其标准误',
          formula: 'ΔΔ = Δ₂ − Δ₁，SE = √(SE₁² + SE₂²)（不合并方差）',
          value: `ΔΔ = ${pp2(interaction.diffDiff)}，SE = ${interaction.se.toFixed(6)}`,
        },
        {
          title: '③ 交互检验',
          formula: 'z = ΔΔ / SE，p = erfc(|z|/√2)，p<0.01 视为效应异质',
          value: `z = ${interaction.z.toFixed(3)}，p = ${ep(interaction.p)} → ${interaction.p < 0.01 ? '判定异质' : '判定同质'}`,
        },
      ],
    );
  }

  // ---- 护栏 ----
  for (const g of guardrails) {
    const isMs = g.key === 'latency_p95';
    const fmt = (v: number) => (isMs ? `${v.toFixed(0)}ms` : `${(v * 100).toFixed(2)}%`);
    const fmtDiff = (v: number) => (isMs ? `${v >= 0 ? '+' : ''}${v.toFixed(0)}ms` : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}pp`);
    let calc: CalcStep[];
    if (isMs) {
      calc = [
        {
          title: '① 两变体加权均值',
          formula: '均值 = Σ(P95ᵢ × 曝光ᵢ) / Σ曝光ᵢ',
          value: `control ${g.controlRate.toFixed(1)}ms，treatment ${g.treatmentRate.toFixed(1)}ms`,
        },
        {
          title: '② 判定规则',
          formula: '恶化 = treatment > control × 1.05',
          value: `${g.treatmentRate.toFixed(1)} vs ${(g.controlRate * 1.05).toFixed(1)}ms → ${g.worse ? '超阈值' : '未超阈值'}`,
        },
        {
          title: '③ 说明',
          formula: 'v1 中 P95 仅展示，不参与决策',
          value: '延迟噪声大且与业务损失非线性，先积累再纳入硬门槛',
        },
      ];
    } else {
      const label = g.key === 'refund_rate' ? '退款率' : '投诉率';
      calc = [
        ...propSteps(g.propTest!, 'count'),
        {
          title: '⑤ 判定规则',
          formula:
            g.key === 'refund_rate'
              ? '恶化 = 绝对差值 > 0.4pp 且 p < 0.01（硬门槛）'
              : '恶化 = 差值为正 且 p < 0.01（仅提示，不拦截）',
          value: `${label} 差值 ${fmtDiff(g.diff)}，p = ${ep(g.p)} → ${g.worse ? '判定恶化' : '未恶化'}${
            g.gating ? '' : '（不参与决策）'
          }`,
        },
      ];
    }
    add(
      'guardrail',
      `护栏：${g.label}`,
      `control ${fmt(g.controlRate)} vs treatment ${fmt(g.treatmentRate)}，差值 ${fmtDiff(g.diff)}，p=${ep(g.p)}${g.gating ? '' : '（仅展示，不参与决策）'}`,
      g.p,
      calc,
    );
  }

  // ---- 规则判定（按固定优先级） ----
  const worseGuardrail = guardrails.find((g) => g.gating && g.worse);
  const posSegments = segments.tenure.filter((s) => s.q <= 0.1 && s.test.diff > 0);
  const bestPos = posSegments.sort((a, b) => b.test.diff - a.test.diff)[0];
  const flatSegment = bestPos
    ? segments.tenure.find((s) => s.key !== bestPos.key && s.test.p > 0.1 && Math.abs(s.test.diff) < 0.5 * Math.abs(bestPos.test.diff))
    : undefined;
  const heterogeneous = !!interaction && interaction.p < 0.01 && !!bestPos && !!flatSegment;

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

  const rules: RuleTrace[] = [
    {
      code: 'SRM',
      label: '分流异常',
      condition: 'p < 0.001 且 相对偏差 > 2%',
      hit: srm.flagged,
      detail: `相对偏差 ${(srm.relImb * 100).toFixed(2)}%，p = ${ep(srm.p)}`,
    },
    {
      code: 'GUARDRAIL',
      label: '护栏拦截',
      condition: '硬护栏（退款率）恶化 > 0.4pp 且 p < 0.01',
      hit: !!worseGuardrail,
      detail: worseGuardrail
        ? `${worseGuardrail.label} ${pp2(worseGuardrail.diff)}，p = ${ep(worseGuardrail.p)}`
        : '硬护栏未恶化',
    },
    {
      code: 'NEGATIVE',
      label: '主指标负向',
      condition: 'p < 0.05 且 差值为负',
      hit: overall.p < 0.05 && overall.diff < 0,
      detail: `差值 ${pp2(overall.diff)}，p = ${ep(overall.p)}`,
    },
    {
      code: 'HETEROGENEOUS',
      label: '效应异质',
      condition: '交互 p < 0.01，且一个分层显著为正、另一个无效',
      hit: heterogeneous,
      detail: heterogeneous
        ? `交互 p = ${ep(interaction?.p ?? 1)}；${bestPos.label} ${pp2(bestPos.test.diff)}、${flatSegment!.label} ${pp2(flatSegment!.test.diff)}`
        : interaction
          ? `交互 p = ${ep(interaction.p)}`
          : '无新老分层，无法检验',
    },
    {
      code: 'NOT_SIG',
      label: '证据不足',
      condition: 'p ≥ 0.05（差值 95% CI 跨 0）',
      hit: overall.p >= 0.05,
      detail: `p = ${ep(overall.p)}，CI [${pp2(overall.ci95[0])}, ${pp2(overall.ci95[1])}]`,
    },
    {
      code: 'POSITIVE',
      label: '显著正向',
      condition: 'p < 0.05、差值为正，且以上均未触发',
      hit: overall.p < 0.05 && overall.diff > 0,
      detail: `差值 ${pp2(overall.diff)}，p = ${ep(overall.p)}`,
    },
  ];

  add('decision', '结论', `${decision} · ${reason}`);

  return {
    experimentId: exp.id,
    overall,
    srm,
    segments,
    interaction: { tenure: interaction },
    guardrails,
    bayes,
    confidence: bayes.probTreatBetter,
    decision,
    reason,
    reasonCode,
    evidence,
    rules,
  };
}
