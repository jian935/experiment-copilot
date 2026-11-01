import { describe, expect, it } from 'vitest';
import { analyze } from '../src/lib/decide.ts';
import { generateDataset } from '../src/lib/simulate.ts';

/**
 * 数据集本身的体检。
 *
 * 为什么值得单独锁：评测准确率、检出率、误报率全都建立在「数据集里每一类实验都够用」之上。
 * 一旦口径分配与实验类型相关（例如 ARPU 只落在负面实验上），
 * 那些数字会照常算出来、照常好看，但它测的是半个系统。
 */
const ds = generateDataset(20261031);
const kinds = ds.experiments.map((e) => e.metricType ?? 'binary');
const archetypes = [...new Set(ds.experiments.map((e) => e.archetype))];

describe('合成数据集的实验设计', () => {
  it('两种主指标口径都有，且比例是 1:2（ARPU 40 / 转化率 80）', () => {
    expect(kinds.filter((k) => k === 'continuous').length).toBe(40);
    expect(kinds.filter((k) => k === 'binary').length).toBe(80);
  });

  it('口径与实验类型正交：每一类实验里都有 ARPU 实验', () => {
    for (const a of archetypes) {
      const list = ds.experiments.filter((e) => e.archetype === a);
      const cont = list.filter((e) => e.metricType === 'continuous').length;
      // 每类至少 1 个，且不低于 1/6 —— 低于这个数说明口径被系统性绑到了某些类型上
      expect(cont, `archetype=${a} 的 ARPU 实验数 ${cont}/${list.length}`).toBeGreaterThanOrEqual(
        Math.floor(list.length / 6),
      );
    }
  });

  it('存在「有真实正效应」的 ARPU 实验（否则连续口径的检出能力无从测起）', () => {
    const posArpu = ds.experiments.filter((e) => e.archetype === 'positive' && e.metricType === 'continuous');
    expect(posArpu.length).toBeGreaterThan(0);
    for (const e of posArpu) {
      expect(e.trueRpuLift).toBeGreaterThan(0);
      const rows = ds.daily.filter((r) => r.expId === e.id);
      const a = analyze(e, rows);
      expect(a.metricKind).toBe('continuous');
      expect(a.primary.kind).toBe('continuous');
      expect(a.primary.diff).toBeGreaterThan(0);
    }
  });

  it('ARPU 实验的明细带 revenue 与前周期收入，且人均口径能被手算核对', () => {
    const e = ds.experiments.find((x) => x.metricType === 'continuous')!;
    const rows = ds.daily.filter((r) => r.expId === e.id);
    expect(rows.every((r) => typeof r.revenue === 'number' && typeof r.preRevenue === 'number')).toBe(true);
    const a = analyze(e, rows);
    // 手算：Σrevenue / Σexposures 必须等于引擎给的 controlValue（不留"两套口径"的缝）
    for (const v of ['control', 'treatment'] as const) {
      const sub = rows.filter((r) => r.variant === v);
      const n = sub.reduce((s, r) => s + r.exposures, 0);
      const rev = sub.reduce((s, r) => s + (r.revenue ?? 0), 0);
      const expectVal = rev / n;
      const got = v === 'control' ? a.primary.controlValue : a.primary.treatmentValue;
      expect(got).toBeCloseTo(expectVal, 6);
    }
  });

  it('ARPU 真值方向与转化率同源（ARPU = CVR × AOV，不是另编一套真值）', () => {
    for (const e of ds.experiments.filter((x) => x.metricType === 'continuous').slice(0, 10)) {
      const rows = ds.daily.filter((r) => r.expId === e.id);
      const a = analyze(e, rows);
      // trueRpuLift 由 trueLiftOverall / p0 推出，符号必须与转化率真值一致
      if (e.trueLiftOverall !== 0) {
        expect(Math.sign(e.trueRpuLift!)).toBe(Math.sign(e.trueLiftOverall));
      }
      // 护栏永远走率口径：退款率的检验结果不受主指标口径影响
      expect(a.guardrails.every((g) => g.key !== 'refundRate' || typeof g.p === 'number')).toBe(true);
    }
  });
});
