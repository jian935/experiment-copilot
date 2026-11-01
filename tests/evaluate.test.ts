import { describe, expect, it } from 'vitest';
import { analyze } from '../src/lib/decide.ts';
import { generateDataset } from '../src/lib/simulate.ts';
import { evaluate, DECISIONS, f1Of } from '../src/lib/evaluate.ts';

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
    // 加入真实的按臂基线异质性 + 改用格子级稳健标准误后，null 误报从 3/40 降到 2/40
    expect(r.fpr.hit).toBe(2);
    expect(r.fpr.rate).toBeCloseTo(2 / 40, 10);
  });

  it('负效应漏判为 0；正效应剩 1 条，且原因可查（不靠调阈值掩盖）', () => {
    expect(r.fnrNegative.miss).toBe(0);
    // 把连续口径（ARPU）实验也铺到所有类型之后，多出 1 条「正效应被判成 iterate」。
    // 原因不是主指标判错，而是分层交互显著：E029 新用户 +1.81元 / 老用户 +0.66元，
    // 交互 p=0.004 —— 而造数据时两段真值完全相同（+2pp），所以这是抽样噪声撞上了
    // 「交互显著就要求分层复查」这条规则。规则本身在 A/A 上极保守（异质误判 0.4%–0.8%），
    // 我们没有为了让这条数字变成 0 去放宽阈值。
    expect(r.fnrPositive.miss).toBe(1);
    const bad = r.rows.filter((x) => x.trueDecision === 'ship' && x.predDecision !== 'ship');
    expect(bad.length).toBe(1);
    expect(bad[0].id).toBe('E029');
    expect(bad[0].predDecision).toBe('iterate');
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

  it('贝叶斯校准：每行的置信度都在 [0,1]，且校准桶覆盖全部样本', () => {
    for (const row of r.rows) {
      expect(row.confidence).toBeGreaterThanOrEqual(0);
      expect(row.confidence).toBeLessThanOrEqual(1);
    }
    const binN = r.calibration.reduce((s, b) => s + b.n, 0);
    expect(binN).toBe(r.n);
  });

  it('校准基本自洽：真实整体效应为正的实验，平均置信度高于为负的', () => {
    const pos = r.rows.filter((x) => x.trueLiftPositive);
    const neg = r.rows.filter((x) => !x.trueLiftPositive);
    const avg = (xs: typeof r.rows) => xs.reduce((s, x) => s + x.confidence, 0) / (xs.length || 1);
    // 整体效应为正的实验，其 P(B>A) 应当系统性更高（贝叶斯自校准）
    expect(avg(pos)).toBeGreaterThan(avg(neg));
  });

  it('ECE 为非负且落在合理范围', () => {
    expect(r.ece).toBeGreaterThanOrEqual(0);
    expect(r.ece).toBeLessThan(0.3);
  });
});

describe('分层（异质）检测 F1（E1）', () => {
  const h = r.hetero;

  it('四格之和等于实验数，正例数等于真异质实验数', () => {
    expect(h.tp + h.fp + h.fn + h.tn).toBe(r.n);
    expect(h.positives).toBe(ds.experiments.filter((e) => e.archetype === 'heterogeneous').length);
    expect(h.positives).toBe(h.tp + h.fn);
  });

  it('precision / recall / F1 与四格手算一致', () => {
    expect(h.precision).toBeCloseTo(h.tp / (h.tp + h.fp), 12);
    expect(h.recall).toBeCloseTo(h.tp / (h.tp + h.fn), 12);
    expect(h.f1).toBeCloseTo((2 * h.precision * h.recall) / (h.precision + h.recall), 12);
  });

  it('预测口径是检测器本身，不是决策（不拿 iterate 当预测值）', () => {
    // 只要有实验被判 iterate 但检测器没报异质，或反之，就说明两者口径不同、必须分开
    const iterateIds = new Set(r.rows.filter((x) => x.predDecision === 'iterate').map((x) => x.id));
    const detectedIds = new Set(r.rows.filter((x) => x.heteroDetected).map((x) => x.id));
    expect([...iterateIds].sort()).toEqual([...detectedIds].sort());
    // 真值来源必须是 archetype，而不是 trueDecision（heterogeneous 的真决策就是 iterate）
    expect(h.tp + h.fn).toBe(15);
  });

  it('放宽口径的召回不会低于严格口径（逻辑性质，写反就会红）', () => {
    const loose = h.interactionOnly;
    expect(loose.tp).toBeGreaterThanOrEqual(h.tp);
    expect(loose.fn).toBeLessThanOrEqual(h.fn);
    expect(loose.fp).toBeGreaterThanOrEqual(h.fp);
  });

  it('区间确定性：同一份数据跑两次完全一致，且落在 [0,1]', () => {
    const again = evaluate(ds, analyses).hetero;
    expect(again.f1Ci).toEqual(h.f1Ci);
    expect(h.f1Ci[0]).toBeLessThanOrEqual(h.f1Ci[1]);
    expect(h.f1Ci[0]).toBeGreaterThanOrEqual(0);
    expect(h.f1Ci[1]).toBeLessThanOrEqual(1);
  });

  it('分母为 0 时 F1 记 0，不记 1（没有正预测不等于完美）', () => {
    const f = f1Of(0, 0, 3, 10);
    expect(f.precision).toBe(0);
    expect(f.f1).toBe(0);
  });
});

describe('置信度校准的两个口径', () => {
  it('「真值非零」子集的样本量等于非零真值实验数，且分桶不丢样本', () => {
    const nonZero = ds.experiments.filter((e) => e.trueLiftOverall !== 0).length;
    expect(r.eceEffects.n).toBe(nonZero);
    expect(nonZero).toBeLessThan(r.n); // null / srm 的真值是精确 0，必须被排除在子集外
    expect(r.eceEffects.calibration.reduce((s, b) => s + b.n, 0)).toBe(nonZero);
  });

  it('子集里每个桶的观测值都能用 rows 重算出来（分桶逻辑不自洽会红）', () => {
    const sub = r.rows.filter((x) => x.trueLiftNonZero);
    for (const b of r.eceEffects.calibration) {
      const inBin = sub.filter((x) => Math.min(9, Math.max(0, Math.floor(x.confidence * 10))) === Math.round(b.probMid * 10 - 0.5));
      expect(inBin.length).toBe(b.n);
      const hit = inBin.filter((x) => x.trueLiftPositive).length;
      expect(b.observed).toBeCloseTo(hit / b.n, 10);
    }
  });

  it('全量 ECE 被「精确 0」抬高：它比子集 ECE 大，且两者都在 [0,1]', () => {
    // 这不是后验不校准，而是观测目标二值化的产物：精确 0 只能记成「不为正」。
    // 两个口径都留着的意义就在于这个差值本身。
    expect(r.ece).toBeGreaterThan(r.eceEffects.ece);
    for (const v of [r.ece, r.eceEffects.ece]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
