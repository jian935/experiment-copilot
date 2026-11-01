import { describe, expect, it } from 'vitest';
import { analyze } from '../src/lib/decide.ts';
import type { DailyRow, Experiment, Tenure, Variant } from '../src/lib/types.ts';
import { buildCardSvg } from '../src/app/lib/exportCard.ts';

const mkExp = (over: Partial<Experiment> = {}): Experiment => ({
  id: 'E900',
  name: '结算页改版',
  hypothesis: '新方案能提升转化',
  startDate: '2026-09-01',
  endDate: '2026-09-07',
  variants: ['control', 'treatment'],
  trafficSplit: '50/50',
  primaryMetric: '支付转化率',
  metricType: 'binary',
  guardrailMetrics: ['退款率', '投诉率'],
  archetype: 'positive',
  trueLift: 0.02,
  trueLiftScope: 'overall',
  trueLiftOverall: 0.02,
  trueDecision: 'ship',
  seed: 1,
  ...over,
});

interface Cell { c: number; n: number }

function mkRows(id: string, spec: { cNew: Cell; tNew: Cell; cOld: Cell; tOld: Cell; refundC?: number; refundT?: number }): DailyRow[] {
  const mk = (variant: Variant, tenure: Tenure, cell: Cell): DailyRow => ({
    expId: id,
    date: '2026-09-01',
    variant,
    device: 'iOS',
    tenure,
    exposures: cell.n,
    conversions: cell.c,
    refunds: variant === 'control' ? (spec.refundC ?? Math.round(cell.n * 0.012)) : (spec.refundT ?? Math.round(cell.n * 0.012)),
    complaints: Math.round(cell.n * 0.0012),
    latencyP95: 820,
  });
  return [mk('control', 'new', spec.cNew), mk('treatment', 'new', spec.tNew), mk('control', 'old', spec.cOld), mk('treatment', 'old', spec.tOld)];
}

const POSITIVE = {
  cNew: { c: 200, n: 4000 }, tNew: { c: 280, n: 4000 },
  cOld: { c: 800, n: 16000 }, tOld: { c: 1120, n: 16000 },
};

describe('证据链的推导（M3）', () => {
  it('除结论外每条证据都带逐步代入', () => {
    const exp = mkExp();
    const a = analyze(exp, mkRows(exp.id, POSITIVE));
    const calcItems = a.evidence.filter((e) => e.kind !== 'decision');
    expect(calcItems.length).toBeGreaterThan(4);
    for (const e of calcItems) {
      expect(e.calc, `${e.id} ${e.label} 缺少 calc`).toBeTruthy();
      expect(e.calc!.length).toBeGreaterThanOrEqual(3);
      for (const s of e.calc!) {
        expect(s.title.length).toBeGreaterThan(0);
        expect(s.formula.length).toBeGreaterThan(0);
        expect(s.value.length).toBeGreaterThan(0);
        expect(s.value).not.toContain('undefined');
        expect(s.value).not.toContain('NaN');
      }
    }
  });

  it('主指标第一步的转化率与引擎输出一致', () => {
    const exp = mkExp();
    const a = analyze(exp, mkRows(exp.id, POSITIVE));
    const metric = a.evidence.find((e) => e.kind === 'metric')!;
    const p1 = (a.overall.controlRate * 100).toFixed(4);
    const p2 = (a.overall.treatmentRate * 100).toFixed(4);
    expect(metric.calc![0].value).toContain(p1);
    expect(metric.calc![0].value).toContain(p2);
    // 第 ③ 步的 z 值也必须与引擎一致
    expect(metric.calc![2].value).toContain(a.overall.z.toFixed(4));
  });

  it('规则轨迹：6 条规则、恰好命中当前 reasonCode、且没有更早的规则同时命中', () => {
    const exp = mkExp();
    const a = analyze(exp, mkRows(exp.id, POSITIVE));
    expect(a.rules.map((r) => r.code)).toEqual([
      'SRM', 'GUARDRAIL', 'NEGATIVE', 'HETEROGENEOUS', 'NOT_SIG', 'POSITIVE',
    ]);
    const hitIndex = a.rules.findIndex((r) => r.code === a.reasonCode);
    expect(hitIndex).toBeGreaterThanOrEqual(0);
    expect(a.rules[hitIndex].hit).toBe(true);
    // 高优先级规则不应同时命中（否则说明规则顺序被打乱）
    const earlierHit = a.rules.slice(0, hitIndex).filter((r) => r.hit);
    expect(earlierHit.map((r) => r.code)).toEqual([]);
  });

  it('SRM 异常实验：即使主指标显著，也必须被判为分流异常', () => {
    const exp = mkExp();
    const a = analyze(exp, mkRows(exp.id, {
      cNew: { c: 200, n: 8000 }, tNew: { c: 100, n: 4000 },
      cOld: { c: 800, n: 12000 }, tOld: { c: 400, n: 6000 },
    }));
    expect(a.reasonCode).toBe('SRM');
    const srmRule = a.rules.find((r) => r.code === 'SRM')!;
    expect(srmRule.hit).toBe(true);
    // 证据里的卡方计算必须能对上引擎
    const srmEvidence = a.evidence.find((e) => e.kind === 'srm')!;
    expect(srmEvidence.calc![1].value).toContain(a.srm.chi2.toFixed(3));
  });

  it('同一份数据复算：证据与规则轨迹逐字一致', () => {
    const exp = mkExp();
    const rows = mkRows(exp.id, { ...POSITIVE, refundC: 240, refundT: 500 });
    const a1 = analyze(exp, rows);
    const a2 = analyze(exp, rows);
    expect(JSON.stringify(a1.evidence)).toBe(JSON.stringify(a2.evidence));
    expect(JSON.stringify(a1.rules)).toBe(JSON.stringify(a2.rules));
  });

  it('护栏的 z / CI 必须来自真实检验，不能用占位值', () => {
    const exp = mkExp();
    const a = analyze(exp, mkRows(exp.id, { ...POSITIVE, refundC: 240, refundT: 500 }));
    const refund = a.guardrails.find((g) => g.key === 'refund_rate')!;
    expect(refund.propTest).toBeTruthy();
    // 这组数据的退款率差异很大，z 不可能接近 0
    expect(Math.abs(refund.propTest!.z)).toBeGreaterThan(1);
    const ev = a.evidence.find((e) => e.label.includes('退款率'))!;
    expect(ev.calc![2].value).toContain(refund.propTest!.z.toFixed(4));
    expect(ev.calc![2].value).not.toContain('z = 0.0000');
    // 区间必须包含点估计，且不是 [d, d] 这种退化的对称值
    const [lo, hi] = refund.propTest!.ci95;
    expect(lo).toBeLessThan(refund.diff);
    expect(hi).toBeGreaterThan(refund.diff);
    expect(ev.calc![3].value).toContain((hi * 100).toFixed(2));
  });

  it('延迟护栏没有 PropTest，推导走 Bootstrap 区间 + 相对容忍度', () => {
    const exp = mkExp();
    const a = analyze(exp, mkRows(exp.id, POSITIVE));
    const lat = a.guardrails.find((g) => g.key === 'latency_p95')!;
    // P95 是分位数指标，没有闭式检验 → 不给 propTest，改给 Bootstrap 结果
    expect(lat.propTest).toBeUndefined();
    expect(lat.bootstrap).toBeDefined();
    expect(lat.bootstrap!.reps).toBeGreaterThan(0);
    expect(lat.bootstrap!.ciLow).toBeLessThanOrEqual(lat.bootstrap!.ciHigh);
    const ev = a.evidence.find((e) => e.label.includes('P95'))!;
    // 推导必须写明容忍度从哪来，且是真的重抽样（不再是硬编码 sd 的假 t 检验）
    expect(ev.calc!.some((s) => s.title.includes('Bootstrap'))).toBe(true);
    expect(ev.calc!.some((s) => s.formula.includes('margin'))).toBe(true);
    expect(ev.calc!.some((s) => s.formula.includes('重抽样'))).toBe(true);
  });
});

describe('结论卡导出（SVG）', () => {
  it('不出现 undefined / NaN，且包含实验名与结论标签', () => {
    const exp = mkExp();
    const a = analyze(exp, mkRows(exp.id, POSITIVE));
    const svg = buildCardSvg(exp, a, { datasetVersion: '2026-10-31 22:43', seed: '20261031' });
    expect(svg).toContain('<svg');
    expect(svg).toContain('结算页改版');
    expect(svg).toContain('建议上线');
    expect(svg).not.toContain('undefined');
    expect(svg).not.toContain('NaN');
    // 差值/样本这类关键数字必须在图上
    expect(svg).toContain((a.overall.diff * 100).toFixed(2));
  });

  it('四种结论都能生成对应的标签与颜色', () => {
    const exp = mkExp();
    const variants: { exp: Experiment; rows: ReturnType<typeof mkRows> }[] = [
      { exp, rows: mkRows(exp.id, POSITIVE) },
      { exp: mkExp({ id: 'E901' }), rows: mkRows('E901', { cNew: { c: 280, n: 4000 }, tNew: { c: 200, n: 4000 }, cOld: { c: 1120, n: 16000 }, tOld: { c: 800, n: 16000 } }) },
      { exp: mkExp({ id: 'E902' }), rows: mkRows('E902', { cNew: { c: 200, n: 4000 }, tNew: { c: 202, n: 4000 }, cOld: { c: 800, n: 16000 }, tOld: { c: 808, n: 16000 } }) },
      { exp: mkExp({ id: 'E903' }), rows: mkRows('E903', { cNew: { c: 200, n: 4000 }, tNew: { c: 272, n: 4000 }, cOld: { c: 800, n: 16000 }, tOld: { c: 1088, n: 16000 }, refundC: 240, refundT: 500 }) },
    ];
    const labels = new Set<string>();
    for (const v of variants) {
      const a = analyze(v.exp, v.rows);
      const svg = buildCardSvg(v.exp, a, { datasetVersion: 'x', seed: '1' });
      expect(svg).not.toContain('NaN');
      labels.add(a.decision);
    }
    expect(labels.size).toBeGreaterThanOrEqual(3); // ship / no-ship / inconclusive 至少三种
  });
});
