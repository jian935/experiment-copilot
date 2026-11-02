import { describe, expect, it } from 'vitest';
import { analyze, estimateAt } from '../src/lib/decide.ts';
import { armsOf, allocationOf, controlArmOf } from '../src/lib/arms.ts';
import { buildMultiArmExperiment } from '../src/lib/simulate.ts';
import type { DailyRow, Experiment } from '../src/lib/types.ts';

function run(opts: Parameters<typeof buildMultiArmExperiment>[0]) {
  const { exp, rows } = buildMultiArmExperiment(opts);
  return { exp, rows, a: analyze(exp, rows) };
}

describe('多臂：识别与排序', () => {
  it('对照永远排第一，其余按声明顺序；数据里多出来的臂不会被丢掉', () => {
    const exp = {
      id: 'X', name: '', hypothesis: '', startDate: '', endDate: '',
      variants: ['control', 'treatment'], trafficSplit: '50/50', primaryMetric: 'x',
      metricType: 'binary', guardrailMetrics: [], archetype: 'null', trueLift: 0,
      trueLiftOverall: 0, trueLiftScope: 'overall', trueDecision: 'inconclusive', seed: 1,
    } as Experiment;
    const mk = (variant: string): DailyRow =>
      ({ expId: 'X', date: '2026-01-01', variant, device: 'iOS', tenure: 'new', exposures: 10, conversions: 1, refunds: 0, complaints: 0, latencyP95: 800 }) as DailyRow;
    const rows = [mk('control'), mk('treatment'), mk('variant_c')];
    expect(armsOf(exp, rows)).toEqual(['control', 'treatment', 'variant_c']);
  });

  it('数据里一行都没有的臂不出现在列表里（避免 n=0 的空行）', () => {
    const exp = {
      id: 'X', name: '', hypothesis: '', startDate: '', endDate: '',
      variants: ['control', 'treatment', 'variant_c'], trafficSplit: '34/33/33', primaryMetric: 'x',
      metricType: 'binary', guardrailMetrics: [], archetype: 'null', trueLift: 0,
      trueLiftOverall: 0, trueLiftScope: 'overall', trueDecision: 'inconclusive', seed: 1,
    } as Experiment;
    const rows = [
      { expId: 'X', date: '2026-01-01', variant: 'control', device: 'iOS', tenure: 'new', exposures: 10, conversions: 1, refunds: 0, complaints: 0, latencyP95: 800 },
      { expId: 'X', date: '2026-01-01', variant: 'variant_c', device: 'iOS', tenure: 'new', exposures: 10, conversions: 1, refunds: 0, complaints: 0, latencyP95: 800 },
    ] as DailyRow[];
    // 声明了 treatment 但数据里没有 → 过滤掉；不因为它「声明过」就画一个空行出来
    expect(armsOf(exp, rows)).toEqual(['control', 'variant_c']);
  });

  it('对照臂可以叫 baseline，不必叫 control', () => {
    const { exp, rows } = buildMultiArmExperiment({ arms: 3, days: 3 });
    const renamed = { ...exp, controlArm: 'control' };
    expect(controlArmOf(renamed)).toBe('control');
    const custom = { ...exp, variants: ['baseline', 'treatment', 'variant_c'], controlArm: 'baseline' };
    const rowsB = rows.map((r) => ({ ...r, variant: r.variant === 'control' ? 'baseline' : r.variant }));
    const a = analyze(custom, rowsB);
    expect(a.arms[0].id).toBe('baseline');
    expect(a.arms[0].isControl).toBe(true);
    expect(a.primary.diff).toBeCloseTo(a.arms.find((x) => x.id === a.multiArm!.focus)!.diff, 12);
  });

  it('分流比例：显式 allocation 优先，其次 trafficSplit，最后等分', () => {
    const { exp } = buildMultiArmExperiment({ arms: 3, allocation: [0.5, 0.25, 0.25] });
    const arms = armsOf(exp);
    expect(allocationOf(exp, arms)).toEqual({ ratios: [0.5, 0.25, 0.25], source: 'declared' });
    expect(allocationOf({ ...exp, allocation: undefined }, arms)).toEqual({ ratios: [0.5, 0.25, 0.25], source: 'trafficSplit' });
    expect(allocationOf({ ...exp, allocation: undefined, trafficSplit: '' }, arms).source).toBe('equal');
  });
});

describe('多臂：决策口径', () => {
  it('三臂实验：输出三行、校正 p 不小于边际 p、P(best) 归一', () => {
    const { a } = run({ arms: 3, lifts: [0.02, 0.004], seed: 7 });
    expect(a.arms).toHaveLength(3);
    expect(a.multiArm?.k).toBe(3);
    expect(a.multiArm?.comparisons).toBe(2);
    for (const arm of a.arms.filter((x) => !x.isControl)) {
      expect(arm.pAdj).toBeGreaterThanOrEqual(arm.pRaw - 1e-12);
      expect(arm.ci[0]).toBeLessThanOrEqual(arm.diff);
      expect(arm.ci[1]).toBeGreaterThanOrEqual(arm.diff);
    }
    const sum = a.arms.reduce((s, x) => s + x.pBest, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it('真实最优臂被选中，而且理由是「校正后显著」', () => {
    const { a } = run({ arms: 3, lifts: [0.02, 0.001], seed: 11 });
    expect(a.multiArm?.focus).toBe('treatment');
    expect(a.multiArm?.focusReason).toBe('best-significant');
    expect(a.decision).toBe('ship');
    // 主指标 p 必须是校正后的（与 arms 表一致）
    expect(a.primary.p).toBeCloseTo(a.arms.find((x) => x.id === 'treatment')!.pAdj, 12);
    expect(a.primary.adjusted).toBe(true);
    expect(a.primary.pRaw).toBeLessThan(a.primary.p + 1e-12);
  });

  it('校正真的改变了结论：边际显著但校正后不显著时，不判上线', () => {
    // 这一条是「多臂必须校正」的存在理由：k=3 时同一份数据在 2 臂口径下可能显著
    const { a } = run({ arms: 3, lifts: [0.012, 0], seed: 23, days: 3 });
    const focus = a.arms.find((x) => x.id === a.multiArm!.focus)!;
    if (focus.pRaw < 0.05 && focus.pAdj >= 0.05) {
      expect(a.decision).not.toBe('ship');
    }
    // 无论数据落在哪一侧，两条口径的关系必须成立
    expect(focus.pAdj).toBeGreaterThanOrEqual(focus.pRaw - 1e-12);
  });

  it('全零族下不硬挑赢家：焦点退回点估计最大，但结论不是上线', () => {
    let shipped = 0;
    for (let i = 0; i < 6; i++) {
      const { a } = run({ arms: 3, lifts: [0, 0], seed: 100 + i * 37 });
      if (a.decision === 'ship') shipped++;
      if (a.multiArm?.focusReason === 'best-point') {
        expect(a.primary.p).toBeGreaterThanOrEqual(0.05);
      }
    }
    // 6 个全零实验里最多允许 1 个误判（多臂校正后 FWER 5%）
    expect(shipped).toBeLessThanOrEqual(1);
  });

  it('护栏恶化的臂不会被选：转化最高但退款率爆了', () => {
    const { a } = run({ arms: 3, lifts: [0.002, 0.03], refundDiffs: [0, 0.02], seed: 31 });
    const c = a.arms.find((x) => x.id === 'variant_c')!;
    expect(c.diff).toBeGreaterThan(a.arms.find((x) => x.id === 'treatment')!.diff);
    expect(a.multiArm?.focus).toBe('variant_c');
    // 焦点臂的护栏必须能拦住它
    expect(a.decision).toBe('no-ship');
    expect(a.reasonCode).toBe('GUARDRAIL');
  });

  it('全局检验：有明显效应时 p 小，全零时 p 大', () => {
    const loud = run({ arms: 3, lifts: [0.02, 0.02], seed: 41 }).a;
    const flat = run({ arms: 3, lifts: [0, 0], seed: 43 }).a;
    expect(loud.multiArm!.global.p).toBeLessThan(0.001);
    expect(flat.multiArm!.global.p).toBeGreaterThan(0.05);
  });

  it('四臂也只是多一行：结构不随臂数变化', () => {
    const { a } = run({ arms: 4, lifts: [0.02, 0.005, 0], seed: 53 });
    expect(a.arms).toHaveLength(4);
    expect(a.multiArm?.k).toBe(4);
    expect(a.multiArm?.comparisons).toBe(3);
    expect(a.arms.reduce((s, x) => s + x.pBest, 0)).toBeCloseTo(1, 6);
  });
});

describe('多臂：口径一致性', () => {
  it('多臂表里的焦点臂与详情页主指标逐字相同（不能两套算法）', () => {
    const { exp, rows, a } = run({ arms: 3, lifts: [0.02, 0.004], seed: 61 });
    const focus = a.multiArm!.focus;
    const pair = rows.filter((r) => r.variant === 'control' || r.variant === focus);
    const est = estimateAt(pair, a.metricKind, 'cuped', 'control', focus)!;
    expect(est.diff).toBeCloseTo(a.primary.diff, 12);
  });

  it('带前周期数据时走 CUPED，而且双臂也走同一条路径', () => {
    const { a } = run({ arms: 3, lifts: [0.02, 0], seed: 71, withPre: true });
    expect(a.primary.via).toBe('cuped');
    expect(a.cuped).toBeDefined();
  });

  it('3 臂 SRM 用声明比例检查（50/25/25 不该被误判）', () => {
    const { a } = run({ arms: 3, allocation: [0.5, 0.25, 0.25], seed: 83 });
    expect(a.multiArm?.srmSource).toBe('declared');
    expect(a.srm.flagged).toBe(false);
    expect(a.srm.counts).toHaveLength(3);
  });

  it('没声明比例时按等分检查，并在证据里说清「比例来源是等分」', () => {
    const { a } = run({ arms: 3, allocation: [0.5, 0.25, 0.25], seed: 83 });
    const { exp, rows } = buildMultiArmExperiment({ arms: 3, allocation: [0.5, 0.25, 0.25], seed: 83 });
    const noDecl = analyze({ ...exp, allocation: undefined, trafficSplit: '' }, rows);
    expect(noDecl.multiArm?.srmSource).toBe('equal');
    expect(noDecl.srm.flagged).toBe(true);
    const ev = noDecl.evidence.find((e) => e.kind === 'srm')!;
    // 「多臂」在 label 上；「按等分」在①步的推导里（这条才是真正要说清的东西）
    expect(ev.label).toContain('多臂');
    expect(ev.detail).toContain('异常');
    expect(ev.calc?.some((s) => s.title.includes('等分'))).toBe(true);
    void a;
  });

  it('两臂实验不会冒出 multiArm 字段（老数据的行为必须一模一样）', () => {
    const { exp, rows } = buildMultiArmExperiment({ arms: 2, lifts: [0.02], seed: 97 });
    const a = analyze(exp, rows);
    expect(a.multiArm).toBeUndefined();
    expect(a.arms).toHaveLength(2);
    expect(a.primary.adjusted).toBeUndefined();
  });
});
