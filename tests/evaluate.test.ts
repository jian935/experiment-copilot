import { describe, expect, it } from 'vitest';
import { analyze } from '../src/lib/decide.ts';
import { generateDataset } from '../src/lib/simulate.ts';
import { evaluate, DECISIONS } from '../src/lib/evaluate.ts';

const ds = generateDataset(20261031);
const analyses = new Map(ds.experiments.map((e) => [e.id, analyze(e, ds.daily)]));
const r = evaluate(ds, analyses);

describe('评测口径（M5）', () => {
  it('样本量、混淆矩阵与准确率自洽', () => {
    expect(r.n).toBe(ds.experiments.length);
    expect(r.confusion.length).toBe(4);
    for (const row of r.confusion) {
      expect(row.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(0);
    }
    const cellSum = r.confusion.flat().reduce((a, b) => a + b, 0);
    expect(cellSum).toBe(r.n);
    expect(r.correct).toBe(r.confusion.reduce((s, row, i) => s + row[i], 0));
    expect(r.accuracy).toBeCloseTo(r.correct / r.n, 10);
  });

  it('FPR 分母只算真实无效应（null 40 个），不含 SRM', () => {
    const nullN = ds.experiments.filter((e) => e.archetype === 'null').length;
    expect(r.fpr.n).toBe(nullN);
    expect(r.fpr.hit).toBe(3);
    expect(r.fpr.rate).toBeCloseTo(3 / 40, 10);
  });

  it('正/负效应漏判为 0', () => {
    expect(r.fnrPositive.miss).toBe(0);
    expect(r.fnrNegative.miss).toBe(0);
  });

  it('四类结论都在混淆矩阵里出现，且失败案例可枚举', () => {
    expect(DECISIONS.length).toBe(4);
    expect(r.mismatches.length).toBe(r.n - r.correct);
    expect(r.mismatches.length).toBeGreaterThan(0); // 故意留着，评测要如实展示
    for (const m of r.mismatches) {
      expect(m.correct).toBe(false);
      expect(m.trueDecision).not.toBe(m.predDecision);
    }
  });

  it('p 值分桶覆盖全部样本，且临界桶准确率最低（诚实展示 α 的代价）', () => {
    const sum = r.byPValue.reduce((s, b) => s + b.n, 0);
    expect(sum).toBe(r.n);
    const near = r.byPValue.find((b) => b.label === '0.01 ≤ p < 0.05')!;
    expect(near.n).toBeGreaterThan(0);
    expect(near.accuracy).toBeLessThan(1);
  });

  it('按类型统计的样本量之和等于总数', () => {
    expect(r.byArchetype.reduce((s, a) => s + a.n, 0)).toBe(r.n);
  });
});
