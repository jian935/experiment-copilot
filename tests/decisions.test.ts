import { describe, expect, it } from 'vitest';
import {
  createDecisionStore,
  exportMarkdown,
  memoryKv,
  needsReason,
  snapshotOf,
  type DecisionRecord,
} from '../src/app/lib/decisions.ts';
import { analyze } from '../src/lib/decide.ts';
import { generateDataset } from '../src/lib/simulate.ts';

const ds = generateDataset(20261031);
const an = (id: string) => {
  const e = ds.experiments.find((x) => x.id === id)!;
  return analyze(e, ds.daily.filter((r) => r.expId === id));
};

const rec = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  expId: 'E001',
  decision: 'no-ship',
  note: '退款率涨了，先修',
  decidedAt: '2026-11-02T10:00:00.000Z',
  snapshot: {
    engineDecision: 'no-ship',
    reasonCode: 'GUARDRAIL',
    diff: 0.0132,
    unit: 'pp',
    p: 0.001,
    ci: [0.005, 0.021],
    n: 48_000,
  },
  ...over,
});

describe('决策记录：存储', () => {
  it('写入→读出→删除，往返一致', () => {
    const s = createDecisionStore(memoryKv());
    expect(s.all()).toEqual([]);
    s.put(rec());
    expect(s.get('E001')?.note).toBe('退款率涨了，先修');
    expect(s.all()).toHaveLength(1);
    // 覆盖同一条实验：是更新而不是追加（一个实验只该有一个当前决定）
    s.put(rec({ decision: 'iterate', note: '改成只对新用户上' }));
    expect(s.all()).toHaveLength(1);
    expect(s.get('E001')?.decision).toBe('iterate');
    s.remove('E001');
    expect(s.all()).toEqual([]);
  });

  it('坏数据不把页面搞崩：当作没有记录', () => {
    const kv = memoryKv();
    kv.setItem('ec_decisions_v1', '{ 这不是 JSON');
    const s = createDecisionStore(kv);
    expect(s.all()).toEqual([]);
    // 还能继续写入
    s.put(rec());
    expect(s.all()).toHaveLength(1);
  });

  it('按时间倒序：最近的决定在最前', () => {
    const s = createDecisionStore(memoryKv());
    s.put(rec({ expId: 'E001', decidedAt: '2026-10-01T00:00:00.000Z' }));
    s.put(rec({ expId: 'E002', decidedAt: '2026-11-01T00:00:00.000Z' }));
    expect(s.all().map((r) => r.expId)).toEqual(['E002', 'E001']);
  });
});

describe('决策记录：与引擎不一致必须给理由', () => {
  it('一致时不需要理由；不一致时必须', () => {
    expect(needsReason('ship', 'ship')).toBe(false);
    expect(needsReason('no-ship', 'no-ship')).toBe(false);
    expect(needsReason('no-ship', 'ship')).toBe(true);
    expect(needsReason('ship', 'no-ship')).toBe(true);
    expect(needsReason('inconclusive', 'iterate')).toBe(true);
  });

  it('「先搁置」永远算不一致——它是产品动作，不是统计结论', () => {
    // 否则会出现「引擎说 ship，人写 hold，却不用说明」这种记录
    expect(needsReason('ship', 'hold')).toBe(true);
    expect(needsReason('hold', 'hold')).toBe(true);
  });
});

describe('决策记录：快照冻结当时的数字', () => {
  it('快照里的五个数就是当时屏幕上看到的', () => {
    const a = an('E001');
    const s = snapshotOf(a);
    expect(s.engineDecision).toBe(a.decision);
    expect(s.reasonCode).toBe(a.reasonCode);
    expect(s.diff).toBe(a.primary.diff);
    expect(s.unit).toBe(a.primary.unit);
    expect(s.p).toBe(a.primary.p);
    expect(s.ci).toEqual([a.primary.ci95[0], a.primary.ci95[1]]);
    expect(s.n).toBe(a.overall.n1 + a.overall.n2);
    expect(s.n).toBeGreaterThan(0);
  });

  it('快照是值拷贝：之后引擎输出变了也不会改写已记录的数字', () => {
    const a = an('E001');
    const s = snapshotOf(a);
    const before = s.diff;
    // 模拟「重新导入后数据变了」：改 analysis 对象
    a.primary.diff = 999;
    expect(s.diff).toBe(before);
  });
});

describe('决策记录：导出 markdown', () => {
  const fmt = (v: number, unit: string) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}${unit}`;

  it('与引擎一致时只写备注，不一致时写「为什么」', () => {
    const same = exportMarkdown([rec()], () => '结算页改版', fmt);
    expect(same).toContain('不上线');
    expect(same).toContain('结算页改版');
    expect(same).toContain('备注');
    expect(same).not.toContain('为什么与引擎不同');

    const diff = exportMarkdown([rec({ decision: 'ship', note: '退款是新客补贴的策略性成本' })], () => 'x', fmt);
    expect(diff).toContain('为什么与引擎不同');
    expect(diff).toContain('策略性成本');
  });

  it('不一致但没写理由时明确写「未填写」，而不是留空', () => {
    // 留空会让人以为「没有异议」，这正是决策记录最该防的一步
    const md = exportMarkdown([rec({ decision: 'ship', note: '' })], () => 'x', fmt);
    expect(md).toContain('未填写');
  });

  it('空列表给出可读提示，不是空字符串', () => {
    expect(exportMarkdown([], () => 'x', fmt)).toContain('还没有记录');
  });

  it('快照数字进 markdown：三个月后能还原「当时看到什么」', () => {
    const md = exportMarkdown([rec()], () => 'x', fmt);
    expect(md).toContain('p=0.0010');
    expect(md).toContain('48,000');
    expect(md).toContain('+1.32pp');
    expect(md).toContain('GUARDRAIL');
  });
});
