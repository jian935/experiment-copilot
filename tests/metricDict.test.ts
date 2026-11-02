import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ExprError, compileMetricExpr, evalMetricExpr, exprRefs, parseMetricExpr } from '../src/lib/metricExpr.ts';
import {
  baseDoc, computeCustomMetric, currentSnapshot, currentVersion, diffSnapshots, resolveDefs,
  rollbackTo, saveSnapshot, validateSnapshot, emptySnapshot,
  type CustomMetric,
} from '../src/lib/metricDict.ts';
import type { DailyRow, Dataset } from '../src/lib/types.ts';

const ds = JSON.parse(readFileSync('public/data/dataset.json', 'utf8')) as Dataset;
const ev = (src: string, row: Record<string, number>) => evalMetricExpr(parseMetricExpr(src), row);

describe('metricExpr：只认四则运算的解析器', () => {
  it('优先级与括号', () => {
    const row = { exposures: 200, conversions: 10 };
    expect(ev('exposures / conversions', row)).toBe(20);
    expect(ev('(exposures + conversions) / 2', row)).toBe(105);
    expect(ev('exposures - conversions * 2', row)).toBe(180);
    expect(ev('-exposures + 10', row)).toBe(-190);
    expect(ev('1.5 * 4', {})).toBe(6);
  });

  it('除数为 0 返回 null，而不是 Infinity 或 0（那会把「算不出」变成「值很小」）', () => {
    expect(ev('revenue / conversions', { revenue: 100, conversions: 0 })).toBeNull();
    expect(ev('revenue / conversions', { revenue: 100 })).toBeNull();
  });

  it('字段缺失返回 null', () => {
    expect(ev('revenue / exposures', { exposures: 10 })).toBeNull();
  });

  it('未知字段、函数调用、比较、字符串全部报错（不是「尽量解析」）', () => {
    expect(() => parseMetricExpr('unknown_field / exposures')).toThrow(ExprError);
    // 函数调用连词法都过不去（逗号不在白名单里）；就算写成单参数 max(x) 也会在字段白名单被拦下
    expect(() => parseMetricExpr('max(revenue, 1)')).toThrow(ExprError);
    expect(() => parseMetricExpr('max(revenue)')).toThrow(/不认识字段/);
    expect(() => parseMetricExpr('revenue > 0')).toThrow(ExprError);
    expect(() => parseMetricExpr("'abc'")).toThrow(ExprError);
    expect(() => parseMetricExpr('')).toThrow(/空/);
    expect(() => parseMetricExpr('(revenue / exposures')).toThrow(/括号没闭合/);
    expect(() => parseMetricExpr('revenue / ')).toThrow(/提前结束/);
    expect(() => parseMetricExpr('revenue exposures')).toThrow(/多余的内容/);
  });

  it('exprRefs 去重且保持出现顺序（用于「这份数据没这列」的早期报错）', () => {
    const { refs } = compileMetricExpr('revenue / conversions + revenue / exposures');
    expect(refs).toEqual(['revenue', 'conversions', 'exposures']);
    expect(exprRefs(parseMetricExpr('42'))).toEqual([]);
  });
});

describe('metricDict：版本与回滚', () => {
  it('初始只有 v1，且没有覆盖也没有自定义', () => {
    const d = baseDoc('本机', '2026-11-02T00:00:00.000Z');
    expect(d.versions).toHaveLength(1);
    expect(currentVersion(d)).toBe(1);
    expect(currentSnapshot(d)).toEqual({ patches: {}, custom: [] });
    expect(d.versions[0].summary[0]).toContain('初始版本');
  });

  it('没有改动时拒绝生成新版本（空版本会让历史变成没人看的流水账）', () => {
    const d = baseDoc('本机', '2026-11-02T00:00:00.000Z');
    expect(() => saveSnapshot(d, emptySnapshot())).toThrow(/没有改动/);
  });

  it('改方向 + 加自定义指标 → 自动生成人话摘要', () => {
    const d = baseDoc('本机', '2026-11-02T00:00:00.000Z');
    const next = {
      patches: { arpu: { direction: 'lower_better' as const } },
      custom: [
        {
          key: 'custom_1', label: '客单价', numerator: 'revenue', denominator: 'conversions',
          unit: '元', direction: 'higher_better' as const, formula: '', note: '',
        },
      ],
    };
    const r = saveSnapshot(d, next, 'jian935', '2026-11-02T10:00:00.000Z');
    expect(r.version).toBe(2);
    expect(r.summary.join(' ')).toContain('把「ARPU」的方向从 越大越好（默认） 改成 越小越好');
    expect(r.summary.join(' ')).toContain('新增自定义指标「客单价」');
    expect(r.doc.versions[1].author).toBe('jian935');
    // 旧版本原封不动
    expect(r.doc.versions[0]).toEqual(d.versions[0]);
  });

  it('回滚是新增一版（带 restoredFrom），旧版本不被改写', () => {
    const d0 = baseDoc('本机', '2026-11-02T00:00:00.000Z');
    const d1 = saveSnapshot(d0, { patches: { arpu: { unit: 'USD' } }, custom: [] }, 'a', '2026-11-02T01:00:00.000Z').doc;
    expect(currentSnapshot(d1).patches.arpu.unit).toBe('USD');
    const back = rollbackTo(d1, 1, 'b', '2026-11-02T02:00:00.000Z');
    expect(back.version).toBe(3);
    expect(back.doc.versions[2].restoredFrom).toBe(1);
    expect(currentSnapshot(back.doc)).toEqual({ patches: {}, custom: [] });
    // 历史仍然是三版，v2 的 USD 还在（没有被抹掉）
    expect(back.doc.versions[1].snapshot.patches.arpu.unit).toBe('USD');
    expect(back.summary[0]).toContain('回滚到 v1');
  });

  it('校验：坏表达式、非法 key、重名都拦下来', () => {
    const errs = validateSnapshot({
      patches: { not_a_metric: { unit: 'x' } },
      custom: [
        { key: 'custom_1', label: 'A', numerator: 'revenue / ', denominator: 'exposures', unit: '', direction: 'higher_better', formula: '', note: '' },
        { key: 'bad_key', label: 'A', numerator: 'revenue', denominator: 'exposures', unit: '', direction: 'higher_better', formula: '', note: '' },
      ],
    });
    expect(errs.join(' ')).toContain('不存在的内置指标');
    expect(errs.join(' ')).toContain('分子表达式有问题');
    expect(errs.join(' ')).toContain('key 不合法');
    expect(errs.join(' ')).toContain('重名');
  });

  it('resolveDefs：覆盖只作用于对应字段，自定义指标追加在后面', () => {
    const defs = resolveDefs({
      patches: { refund_rate: { note: '自定义说明' } },
      custom: [
        { key: 'custom_9', label: '客单价', numerator: 'revenue', denominator: 'conversions', unit: '元', direction: 'higher_better', formula: '', note: 'x' },
      ],
    });
    const refund = defs.find((d) => d.key === 'refund_rate')!;
    expect(refund.note).toBe('自定义说明');
    expect(refund.label).toBe('退款率'); // label 不受覆盖影响
    expect(refund.guardrailMargin).toBe(0.004);
    expect(defs[defs.length - 1].key).toBe('custom_9');
    expect(defs[defs.length - 1].kind).toBe('continuous');
  });

  it('diffSnapshots 对删除与说明修改也给得出人话', () => {
    const a = {
      patches: {},
      custom: [{ key: 'custom_1', label: 'A', numerator: 'revenue', denominator: 'exposures', unit: '元', direction: 'higher_better' as const, formula: '', note: '' }],
    };
    const b = { patches: { arpu: { note: '新说明' } }, custom: [] };
    const s = diffSnapshots(a, b);
    expect(s.join(' ')).toContain('删除自定义指标「A」');
    expect(s.join(' ')).toContain('改了「ARPU」的说明');
  });
});

describe('computeCustomMetric：比值口径的自定义指标', () => {
  const def: CustomMetric = {
    key: 'custom_1', label: '客单价', numerator: 'revenue', denominator: 'conversions',
    unit: '元', direction: 'higher_better', formula: '', note: '',
  };

  it('客单价 = Σrevenue / Σconversions，与手算一致', () => {
    const exp = ds.experiments.find((e) => e.id === 'E003')!;
    const rows = ds.daily.filter((r) => r.expId === exp.id);
    const r = computeCustomMetric(rows, 'control', 'treatment', def);
    expect(r.error).toBeUndefined();
    const c = rows.filter((x) => x.variant === 'control');
    const sumR = c.reduce((s, x) => s + (x.revenue ?? 0), 0);
    const sumC = c.reduce((s, x) => s + x.conversions, 0);
    expect(r.controlValue).toBeCloseTo(sumR / sumC, 10);
    expect(r.se).toBeGreaterThan(0);
    expect(r.p).toBeGreaterThanOrEqual(0);
    expect(r.p).toBeLessThanOrEqual(1);
  });

  it('整列缺字段时说清是哪一列，而不是给 0', () => {
    const exp = ds.experiments.find((e) => e.id === 'E001')!;
    const rows: DailyRow[] = ds.daily.filter((r) => r.expId === exp.id).map((r) => ({ ...r, revenue: undefined }));
    const r = computeCustomMetric(rows, 'control', 'treatment', def);
    expect(r.error).toContain('revenue');
    expect(r.p).toBe(1);
  });

  it('除法失败的行被跳过并计数（不是当 0 参与计算）', () => {
    const rows: DailyRow[] = [
      { expId: 'X', date: '2026-01-01', variant: 'control', device: 'iOS', tenure: 'new', exposures: 100, conversions: 10, refunds: 1, complaints: 0, latencyP95: 800, revenue: 1000 },
      { expId: 'X', date: '2026-01-01', variant: 'control', device: 'Android', tenure: 'new', exposures: 100, conversions: 0, refunds: 1, complaints: 0, latencyP95: 800, revenue: 0 },
      { expId: 'X', date: '2026-01-01', variant: 'control', device: 'iOS', tenure: 'old', exposures: 100, conversions: 5, refunds: 1, complaints: 0, latencyP95: 800, revenue: 500 },
      { expId: 'X', date: '2026-01-01', variant: 'treatment', device: 'iOS', tenure: 'new', exposures: 100, conversions: 12, refunds: 1, complaints: 0, latencyP95: 800, revenue: 1440 },
      { expId: 'X', date: '2026-01-01', variant: 'treatment', device: 'Android', tenure: 'new', exposures: 100, conversions: 8, refunds: 1, complaints: 0, latencyP95: 800, revenue: 720 },
    ];
    const r = computeCustomMetric(rows, 'control', 'treatment', def);
    expect(r.skippedRows).toBe(1);
    expect(r.controlValue).toBeCloseTo(100, 10);
  });
});
