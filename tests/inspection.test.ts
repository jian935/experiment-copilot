/**
 * 巡检任务的单测。
 *
 * 每一条都对应一个**真实的设计判断**，不是「函数能跑」。判断本身写在
 * `src/lib/tasks/inspection.ts` 的注释里，这里只负责钉住它不会在以后被悄悄改掉。
 *
 * 数据全部手工构造（十几行），不读 2MB 的 dataset.json——巡检的判定逻辑
 * 与数据规模无关，用大文件只会让失败信息难以定位。
 */
import { describe, expect, it } from 'vitest';
import { analyze, type Analysis } from '../src/lib/decide.ts';
import { runInspection, renderMarkdown, INSPECTION_STEPS } from '../src/lib/tasks/inspection.ts';
import { MATERIALITY_REL, N_RATIO_LIMIT } from '../src/lib/tasks/constants.ts';
import type { DailyRow, Dataset, Experiment } from '../src/lib/types.ts';

const DAYS = 8;

function expOf(id: string, over: Partial<Experiment> = {}): Experiment {
  return {
    id,
    name: `${id} 测试实验`,
    hypothesis: '',
    startDate: '2026-01-01',
    endDate: '2026-01-08',
    variants: ['control', 'treatment'],
    trafficSplit: '50/50',
    primaryMetric: '转化率',
    metricType: 'binary',
    guardrailMetrics: ['退款率'],
    archetype: 'null',
    trueLift: 0,
    trueLiftScope: 'overall',
    trueLiftOverall: 0,
    trueDecision: 'inconclusive',
    seed: 1,
    ...over,
  };
}

function row(
  expId: string,
  day: number,
  variant: string,
  exposures: number,
  conversions: number,
  over: Partial<DailyRow> = {},
): DailyRow {
  return {
    expId,
    date: `2026-01-${String(day + 1).padStart(2, '0')}`,
    variant,
    device: 'iOS',
    tenure: 'new',
    exposures,
    conversions,
    refunds: 0,
    complaints: 0,
    latencyP95: 800,
    ...over,
  };
}

interface MkOpts {
  /** 每臂总曝光 */
  nPerArm: number;
  cRate: number;
  tRate: number;
  /** 对照臂拿到的流量份额（≠0.5 就是制造 SRM） */
  controlShare?: number;
  cRefund?: number;
  tRefund?: number;
}

function rowsOf(id: string, o: MkOpts): DailyRow[] {
  const share = o.controlShare ?? 0.5;
  const out: DailyRow[] = [];
  // nPerArm 是**每臂**样本：总曝光 = 2 × nPerArm，对照臂拿 share。
  // 第一版写成 nPerArm × share / DAYS，于是「每臂 5 万」实际只有 2.5 万，
  // MDE 判档整体偏一档——测试和实现都没错，是夹具错了。
  for (let d = 0; d < DAYS; d++) {
    const nc = Math.round((2 * o.nPerArm * share) / DAYS);
    const nt = Math.round((2 * o.nPerArm * (1 - share)) / DAYS);
    out.push(row(id, d, 'control', nc, Math.round(nc * o.cRate), { refunds: Math.round(nc * (o.cRefund ?? 0)) }));
    out.push(row(id, d, 'treatment', nt, Math.round(nt * o.tRate), { refunds: Math.round(nt * (o.tRefund ?? 0)) }));
  }
  return out;
}

/** iid 标准误：MDE 的测试要能精确控制样本量，robust SE 会跟着格子抖动走 */
const CFG = { seMode: 'iid' as const };

function build(cases: Array<{ exp: Experiment; rows: DailyRow[] }>): {
  dataset: Dataset;
  analyses: Map<string, Analysis>;
} {
  const dataset: Dataset = {
    generatedAt: '2026-01-09T00:00:00.000Z',
    seedBase: 1,
    groundTruth: false,
    spec: { days: DAYS, segments: [] },
    experiments: cases.map((c) => c.exp),
    daily: cases.flatMap((c) => c.rows),
  } as unknown as Dataset;
  const analyses = new Map<string, Analysis>();
  for (const c of cases) analyses.set(c.exp.id, analyze(c.exp, c.rows, CFG));
  return { dataset, analyses };
}

function one(exp: Experiment, rows: DailyRow[]) {
  const { dataset, analyses } = build([{ exp, rows }]);
  return runInspection(dataset, analyses).items[0];
}

describe('巡检：确定性', () => {
  it('基准日取数据里最晚的一天，不是系统时钟', () => {
    const exp = expOf('X1');
    const rows = rowsOf('X1', { nPerArm: 20000, cRate: 0.1, tRate: 0.1 });
    const { dataset, analyses } = build([{ exp, rows }]);
    const r = runInspection(dataset, analyses);
    expect(r.asOf).toBe('2026-01-08');
    expect(r.items[0].lastDate).toBe('2026-01-08');
    expect(r.items[0].daysSinceLastData).toBe(0);
  });

  it('同一份数据跑两次，digest 逐字节相同', () => {
    const exp = expOf('X1');
    const rows = rowsOf('X1', { nPerArm: 20000, cRate: 0.1, tRate: 0.105 });
    const { dataset, analyses } = build([{ exp, rows }]);
    const a = runInspection(dataset, analyses);
    const b = runInspection(dataset, analyses);
    expect(JSON.stringify(a.digest)).toBe(JSON.stringify(b.digest));
  });

  it('没有分析结果的实验不进清单（数据缺失不能假装查过了）', () => {
    const exp = expOf('X1');
    const rows = rowsOf('X1', { nPerArm: 20000, cRate: 0.1, tRate: 0.1 });
    const { dataset, analyses } = build([{ exp, rows }]);
    dataset.experiments.push(expOf('GHOST'));
    const r = runInspection(dataset, analyses);
    expect(r.items.map((x) => x.expId)).toEqual(['X1']);
    expect(r.systemic).toContain('1 个实验没有可用的分析结果');
  });
});

describe('巡检：前置条件不满足时短路', () => {
  it('分流坏了只报分流，不再叠加截尾/样本量诊断', () => {
    const exp = expOf('SRM1');
    // 60/40 分流 vs 声明的 50/50 → relImb 20%，远超 2%
    const rows = rowsOf('SRM1', { nPerArm: 40000, cRate: 0.1, tRate: 0.1, controlShare: 0.6 });
    const item = one(exp, rows);
    expect(item.risk).toBe('critical');
    expect(item.signals.map((s) => s.code)).toEqual(['srm_broken']);
    expect(item.next.kind).toBe('fix-traffic');
  });

  it('一行数据都没有：判必须处理，并指向埋点而不是效应', () => {
    const item = one(expOf('EMPTY'), []);
    expect(item.risk).toBe('critical');
    expect(item.signals.map((s) => s.code)).toEqual(['no_data']);
    expect(item.next.kind).toBe('instrument');
    expect(item.why).toContain('埋点');
  });
});

describe('巡检：显著不等于值得做', () => {
  it('显著但幅度小于业务门槛 → 判「不值得动」，不算好也不算坏消息', () => {
    // 6% 基线、绝对差 0.12pp（= 相对 2%，低于默认 3% 门槛），样本足够大到显著
    const exp = expOf('TRIV');
    const rows = rowsOf('TRIV', { nPerArm: 400000, cRate: 0.06, tRate: 0.0612 });
    const item = one(exp, rows);
    const codes = item.signals.map((s) => s.code);
    expect(codes).toContain('trivial_effect');
    expect(codes).not.toContain('sig_positive');
    expect(codes).not.toContain('sig_negative');
    expect(item.next.kind).toBe('review');
    expect(item.next.label).toBe('不值得动');
  });

  it('幅度超过门槛时不会被误判成「不值得动」', () => {
    // 6% → 7%，绝对差 1pp，远高于 3% 门槛（0.18pp）
    const exp = expOf('BIG');
    const rows = rowsOf('BIG', { nPerArm: 40000, cRate: 0.06, tRate: 0.07 });
    const codes = one(exp, rows).signals.map((s) => s.code);
    expect(codes).toContain('sig_positive');
    expect(codes).not.toContain('trivial_effect');
  });

  it('百分点的差值与水平值单位不同：差值写 pp，水平写 %', () => {
    // 每臂 8 万、每天 1 万：0.06→600 人、0.055→550 人，差恰好 −0.50pp、基线 6.00%
    const exp = expOf('FMT');
    const rows = rowsOf('FMT', { nPerArm: 80000, cRate: 0.06, tRate: 0.055 });
    const item = one(exp, rows);
    const neg = item.signals.find((s) => s.code === 'sig_negative');
    expect(neg).toBeDefined();
    expect(neg!.detail).toContain('0.50pp');
    // 0.50pp 曾经被印成 0.00pp（多除了一次 100），这条断言就是防它回来
    expect(neg!.detail).not.toContain('0.00pp');
    expect(neg!.detail).toContain('6.00%');
  });
});

describe('巡检：效应异质时不重复表态', () => {
  it('判定为定向的实验不再出现「显著为正」信号', () => {
    const exp = expOf('HET', { archetype: 'heterogeneous' });
    const rows: DailyRow[] = [];
    for (let d = 0; d < DAYS; d++) {
      // 新用户：treatment 明显更好；老用户：两臂一样
      rows.push(row('HET', d, 'control', 2000, 200, { tenure: 'new' }));
      rows.push(row('HET', d, 'treatment', 2000, 260, { tenure: 'new' }));
      rows.push(row('HET', d, 'control', 2000, 200, { tenure: 'old' }));
      rows.push(row('HET', d, 'treatment', 2000, 200, { tenure: 'old' }));
    }
    const codes = one(exp, rows).signals.map((s) => s.code);
    // 先确认引擎真的判了定向（否则这条测试在测空气）
    expect(one(exp, rows).decision).toBe('iterate');
    expect(codes).toContain('heterogeneous');
    expect(codes).not.toContain('sig_positive');
  });
});

describe('巡检：测不出 / 确实没效果 / 设计不足', () => {
  const base = { cRate: 0.1, tRate: 0.101 };

  it('样本远不够（MDE 超过业务门槛 2.5 倍）→ 设计不足，不给「补样本」建议', () => {
    const item = one(expOf('LOW'), rowsOf('LOW', { ...base, nPerArm: 5000 }));
    const sig = item.signals.find((s) => s.code === 'design_insufficient');
    expect(sig).toBeDefined();
    expect(item.risk).toBe('ok'); // 归「无需动作」，但 why 说清是设计问题
    expect(item.why).toContain('设计不足');
    expect(item.next.label).toBe('设计不足');
    expect(item.next.forecast).toBeUndefined();
    expect(sig!.detail).toContain('倍样本');
  });

  it('样本差一点（MDE 在 1~2.5 倍门槛之间）→ 补样本，并给人数与天数', () => {
    const item = one(expOf('MID'), rowsOf('MID', { ...base, nPerArm: 50000 }));
    const sig = item.signals.find((s) => s.code === 'underpowered');
    expect(sig).toBeDefined();
    expect(item.risk).toBe('info');
    expect(item.next.kind).toBe('collect-more');
    expect(item.next.forecast?.nPerArm).toBeGreaterThan(50000);
    expect(item.next.forecast?.days).toBeGreaterThan(0);
  });

  it('「还要多少人」用的是 n′ = n × (MDE / 目标效应)²，可以手算核对', () => {
    const exp = expOf('MID2');
    const rows = rowsOf('MID2', { ...base, nPerArm: 50000 });
    const { dataset, analyses } = build([{ exp, rows }]);
    const an = analyses.get('MID2')!;
    const r = runInspection(dataset, analyses);
    const item = r.items[0];
    const z = 1.959963984540054 + 0.8416212335729143;
    const mde = z * an.primary.se;
    const materiality = Math.abs(an.primary.controlValue) * MATERIALITY_REL;
    const nControl = rows.filter((x) => x.variant === 'control').reduce((s, x) => s + x.exposures, 0);
    const expectN = Math.ceil(nControl * (mde / materiality) ** 2);
    expect(item.next.forecast?.nPerArm).toBe(expectN);
  });

  it('样本足够大（能排除业务效应量）→ 确实没效果，且不归「必须处理」', () => {
    // 0.1 基线、3% 门槛 = 0.3pp；16 万/臂时 MDE ≈ 0.2pp < 0.3pp
    const item = one(expOf('HIGH'), rowsOf('HIGH', { cRate: 0.1, tRate: 0.1, nPerArm: 160000 }));
    const codes = item.signals.map((s) => s.code);
    expect(codes).toContain('no_effect_confident');
    expect(codes).not.toContain('design_insufficient');
    expect(item.risk).toBe('ok');
  });

  it('三档的边界由 N_RATIO_LIMIT 决定，而不是三个各写一遍的魔数', () => {
    // 把门槛调到 1 倍时，「5000/臂」这一档必须从设计不足变成测不出（说明它读的是常量）
    const exp = expOf('EDGE1');
    const rows = rowsOf('EDGE1', { ...base, nPerArm: 5000 });
    const { dataset, analyses } = build([{ exp, rows }]);
    const strict = runInspection(dataset, analyses, { materiality: 0.0001 });
    // 门槛极小 → ratio 极大 → 仍然是设计不足
    expect(strict.items[0].signals.some((s) => s.code === 'design_insufficient')).toBe(true);
    // 门槛极大（比 MDE 还大）→ ratio < 1 → 变成「确实没效果」
    const loose = runInspection(dataset, analyses, { materiality: 10 });
    expect(loose.items[0].signals.some((s) => s.code === 'no_effect_confident')).toBe(true);
    expect(N_RATIO_LIMIT).toBeGreaterThan(1);
  });
});

describe('巡检：第一屏与系统性问题', () => {
  const srmCases = () =>
    ['S1', 'S2', 'S3'].map((id) => ({
      exp: expOf(id),
      rows: rowsOf(id, { nPerArm: 40000, cRate: 0.1, tRate: 0.1, controlShare: 0.6 }),
    }));

  it('多个同因实验同时坏：只报一次「系统性问题」，第一屏同类只留一个代表', () => {
    const { dataset, analyses } = build(srmCases());
    const r = runInspection(dataset, analyses);
    expect(r.totals.critical).toBe(3);
    expect(r.systemic).toContain('同时出现「分流坏了」');
    expect(r.systemic).toContain('3 个实验');
    // 第一屏只有 1 条（没有 warn 可补）
    expect(r.mustLook).toHaveLength(1);
    expect(r.mustLook[0].signals[0].code).toBe('srm_broken');
  });

  it('不同原因的 critical 各自出现在第一屏（去重是按原因，不是按数量砍）', () => {
    const { dataset, analyses } = build([
      ...srmCases(),
      { exp: expOf('G1'), rows: rowsOf('G1', { nPerArm: 40000, cRate: 0.1, tRate: 0.1, cRefund: 0.012, tRefund: 0.02 }) },
      { exp: expOf('N1'), rows: rowsOf('N1', { nPerArm: 40000, cRate: 0.06, tRate: 0.0538 }) },
    ]);
    const r = runInspection(dataset, analyses);
    const codes = r.mustLook.map((x) => x.signals[0].code);
    expect(codes).toContain('srm_broken');
    expect(codes).toContain('guardrail_worse');
    expect(codes).toContain('sig_negative');
    // 三条 SRM 只贡献一个代表
    expect(codes.filter((c) => c === 'srm_broken')).toHaveLength(1);
  });

  it('护栏恶化不会被当成系统性问题（那是各功能各自的业务结论）', () => {
    const cases = ['G1', 'G2', 'G3', 'G4'].map((id) => ({
      exp: expOf(id),
      rows: rowsOf(id, { nPerArm: 40000, cRate: 0.1, tRate: 0.1, cRefund: 0.012, tRefund: 0.02 }),
    }));
    const { dataset, analyses } = build(cases);
    const r = runInspection(dataset, analyses);
    expect(r.totals.critical).toBe(4);
    expect(r.systemic).toBeNull();
  });
});

describe('巡检：报告与边界', () => {
  it('周报正文包含第一屏、样本量现状与步骤说明，且不含未替换的占位符', () => {
    const exp = expOf('R1');
    const rows = rowsOf('R1', { nPerArm: 20000, cRate: 0.1, tRate: 0.1 });
    const { dataset, analyses } = build([{ exp, rows }]);
    const md = renderMarkdown(runInspection(dataset, analyses));
    expect(md).toContain('# 实验巡检周报');
    expect(md).toContain('这份报告怎么来的');
    expect(md).toContain('基准日');
    for (const s of INSPECTION_STEPS) expect(md).toContain(s.slice(0, 12));
    expect(md).not.toContain('undefined');
    expect(md).not.toContain('[object Object]');
    expect(md).not.toContain('NaN');
  });

  it('范围声明必须包含「不是所有实验都正常」这条边界', () => {
    const exp = expOf('R2');
    const rows = rowsOf('R2', { nPerArm: 20000, cRate: 0.1, tRate: 0.1 });
    const { dataset, analyses } = build([{ exp, rows }]);
    const r = runInspection(dataset, analyses);
    const text = r.scope.join(' ');
    expect(text).toContain('不是「所有实验都正常」');
    expect(text).toContain('不处理的代价');
  });

  it('「硬给结论」次数在纯零效应数据上必须是 0', () => {
    const cases = ['Z1', 'Z2', 'Z3'].map((id) => ({
      exp: expOf(id),
      rows: rowsOf(id, { nPerArm: 20000, cRate: 0.1, tRate: 0.1 }),
    }));
    const { dataset, analyses } = build(cases);
    const r = runInspection(dataset, analyses);
    expect(r.digest.hardVerdictsOnInconclusive).toBe(0);
    // 每条结论都得指回证据
    expect(r.digest.evidenceCites).toBeGreaterThan(0);
    for (const x of r.items) {
      const withCites = x.signals.filter((s) => s.cites.length > 0);
      expect(withCites.length).toBe(x.signals.length);
    }
  });
});
