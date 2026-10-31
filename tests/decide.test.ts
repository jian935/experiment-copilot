import { describe, expect, it } from 'vitest';
import { analyze } from '../src/lib/decide.ts';
import type { DailyRow, Experiment, Tenure, Variant } from '../src/lib/types.ts';

const mkExp = (id = 'E001'): Experiment => ({
  id,
  name: '测试实验',
  hypothesis: '新方案能提升转化',
  startDate: '2026-09-01',
  endDate: '2026-09-07',
  variants: ['control', 'treatment'],
  trafficSplit: '50/50',
  primaryMetric: '支付转化率',
  metricType: 'binary',
  guardrailMetrics: ['退款率', '投诉率'],
  archetype: 'null',
  trueLift: 0,
  trueLiftScope: 'overall',
  trueLiftOverall: 0,
  trueDecision: 'inconclusive',
  seed: 1,
});

interface Cell { c: number; n: number }
interface Spec {
  cNew: Cell; tNew: Cell; cOld: Cell; tOld: Cell;
  refundC?: number; refundT?: number;
}

function mkRows(id: string, s: Spec): DailyRow[] {
  const mk = (variant: Variant, tenure: Tenure, cell: Cell): DailyRow => ({
    expId: id,
    date: '2026-09-01',
    variant,
    device: 'iOS',
    tenure,
    exposures: cell.n,
    conversions: cell.c,
    refunds: variant === 'control' ? (s.refundC ?? Math.round(cell.n * 0.012)) : (s.refundT ?? Math.round(cell.n * 0.012)),
    complaints: Math.round(cell.n * 0.0012),
    latencyP95: 820,
  });
  return [mk('control', 'new', s.cNew), mk('treatment', 'new', s.tNew), mk('control', 'old', s.cOld), mk('treatment', 'old', s.tOld)];
}

describe('决策规则', () => {
  it('显著正向 + 护栏正常 → ship', () => {
    const exp = mkExp();
    const rows = mkRows(exp.id, {
      cNew: { c: 200, n: 4000 }, tNew: { c: 280, n: 4000 },
      cOld: { c: 800, n: 16000 }, tOld: { c: 1120, n: 16000 },
    });
    const a = analyze(exp, rows);
    expect(a.decision).toBe('ship');
    expect(a.reasonCode).toBe('POSITIVE');
  });

  it('显著负向 → no-ship', () => {
    const exp = mkExp();
    const rows = mkRows(exp.id, {
      cNew: { c: 280, n: 4000 }, tNew: { c: 200, n: 4000 },
      cOld: { c: 1120, n: 16000 }, tOld: { c: 800, n: 16000 },
    });
    expect(analyze(exp, rows).decision).toBe('no-ship');
  });

  it('无差异 → inconclusive', () => {
    const exp = mkExp();
    const rows = mkRows(exp.id, {
      cNew: { c: 200, n: 4000 }, tNew: { c: 202, n: 4000 },
      cOld: { c: 800, n: 16000 }, tOld: { c: 808, n: 16000 },
    });
    expect(analyze(exp, rows).decision).toBe('inconclusive');
  });

  it('主指标正向但退款护栏恶化 → no-ship', () => {
    const exp = mkExp();
    const rows = mkRows(exp.id, {
      cNew: { c: 200, n: 4000 }, tNew: { c: 272, n: 4000 },
      cOld: { c: 800, n: 16000 }, tOld: { c: 1088, n: 16000 },
      refundC: 240, refundT: 500,
    });
    const a = analyze(exp, rows);
    expect(a.decision).toBe('no-ship');
    expect(a.reasonCode).toBe('GUARDRAIL');
  });

  it('SRM 分流异常 → inconclusive（优先于其他判断）', () => {
    const exp = mkExp();
    const rows = mkRows(exp.id, {
      cNew: { c: 200, n: 8000 }, tNew: { c: 100, n: 4000 },
      cOld: { c: 800, n: 12000 }, tOld: { c: 400, n: 6000 },
    });
    const a = analyze(exp, rows);
    expect(a.decision).toBe('inconclusive');
    expect(a.reasonCode).toBe('SRM');
  });

  it('整体显著但仅新用户有效 → iterate', () => {
    const exp = mkExp();
    const rows = mkRows(exp.id, {
      cNew: { c: 250, n: 5000 }, tNew: { c: 390, n: 5000 },
      cOld: { c: 750, n: 15000 }, tOld: { c: 750, n: 15000 },
    });
    const a = analyze(exp, rows);
    expect(a.decision).toBe('iterate');
    expect(a.reasonCode).toBe('HETEROGENEOUS');
  });
});
