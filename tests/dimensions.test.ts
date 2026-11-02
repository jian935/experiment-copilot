import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MAX_DIM_VALUES,
  cochranQ,
  discoverDimensions,
  isWeekend,
  readDim,
} from '../src/lib/dimensions.ts';
import { analyze } from '../src/lib/decide.ts';
import { SAMPLE_CSV_DIMS, parseCsvText, parseDatasetJson } from '../src/lib/import.ts';
import type { DailyRow, Dataset } from '../src/lib/types.ts';

const ds = JSON.parse(readFileSync('public/data/dataset.json', 'utf8')) as Dataset;
const rowsOf = (id: string) => ds.daily.filter((r) => r.expId === id);

/** 造一行（只要维度相关字段，其余给最小值） */
const row = (date: string, device: 'iOS' | 'Android', tenure: 'new' | 'old', dims?: Record<string, string>): DailyRow => ({
  expId: 'X',
  date,
  variant: 'control',
  device,
  tenure,
  exposures: 100,
  conversions: 5,
  refunds: 1,
  complaints: 0,
  latencyP95: 800,
  ...(dims ? { dims } : {}),
});

describe('isWeekend / readDim', () => {
  it('周末判定按 UTC：周六周日为真，周一为假', () => {
    expect(isWeekend('2026-11-07')).toBe(true); // 周六
    expect(isWeekend('2026-11-08')).toBe(true); // 周日
    expect(isWeekend('2026-11-09')).toBe(false); // 周一
    expect(isWeekend('不是日期')).toBe(false);
  });

  it('读内置维度与 dims.* 都走同一个入口', () => {
    const r = row('2026-11-09', 'Android', 'old', { 渠道: '信息流', 城市: '成都' });
    expect(readDim(r, 'device')).toBe('Android');
    expect(readDim(r, 'tenure')).toBe('old');
    expect(readDim(r, 'weekend')).toBe('weekday');
    expect(readDim(r, 'dims.渠道')).toBe('信息流');
    expect(readDim(r, 'dims.不存在')).toBeUndefined();
    expect(readDim(r, 'unknown')).toBeUndefined();
  });
});

describe('discoverDimensions', () => {
  it('内置数据给出三维：设备 / 新老用户 / 周内周末', () => {
    const d = discoverDimensions(rowsOf('E001'));
    expect(d.dims.map((x) => x.key)).toEqual(['device', 'tenure', 'weekend']);
    expect(d.dims[1].values.map((v) => v.label)).toEqual(['新用户', '老用户']);
    expect(d.dims[2].values.map((v) => v.label)).toEqual(['周内', '周末']);
    expect(d.skipped).toEqual([]);
  });

  it('天数不足 5 天就不给「周内/周末」——两三天切不出有意义的两组', () => {
    const rows = [row('2026-11-07', 'iOS', 'new'), row('2026-11-08', 'Android', 'old')];
    expect(discoverDimensions(rows).dims.map((x) => x.key)).not.toContain('weekend');
  });

  it('数据里带来的维度被认出来，且排在三个内置维度之后', () => {
    // 日期要跨到周末，否则「周内/周末」只有一个取值、不会成为维度
    const rows = [
      row('2026-11-06', 'iOS', 'new', { 渠道: '应用商店', 城市: '上海' }),
      row('2026-11-07', 'Android', 'old', { 渠道: '信息流', 城市: '成都' }),
      row('2026-11-08', 'iOS', 'new', { 渠道: '应用商店', 城市: '成都' }),
      row('2026-11-09', 'Android', 'old', { 渠道: '信息流', 城市: '上海' }),
      row('2026-11-10', 'iOS', 'new', { 渠道: '应用商店', 城市: '上海' }),
    ];
    const d = discoverDimensions(rows);
    expect(d.dims.map((x) => x.key)).toEqual(['device', 'tenure', 'weekend', 'dims.渠道', 'dims.城市']);
    expect(d.dims[3].label).toBe('渠道');
    expect(d.dims[3].source).toBe('data');
  });

  it('取值只有一种的维度静默跳过（没信息，不是错误）', () => {
    const rows = [
      row('2026-11-02', 'iOS', 'new', { 渠道: '应用商店' }),
      row('2026-11-03', 'Android', 'old', { 渠道: '应用商店' }),
    ];
    expect(discoverDimensions(rows).dims.map((x) => x.key)).not.toContain('dims.渠道');
  });

  it('取值太多的维度明确跳过并说明原因（不做「看起来跑了其实全是噪声」的扫描）', () => {
    const rows = Array.from({ length: MAX_DIM_VALUES + 3 }, (_, i) =>
      row('2026-11-02', 'iOS', 'new', { 订单号: `NO${i}` }),
    );
    const d = discoverDimensions(rows);
    expect(d.dims.map((x) => x.key)).not.toContain('dims.订单号');
    expect(d.skipped).toHaveLength(1);
    expect(d.skipped[0].distinct).toBe(MAX_DIM_VALUES + 3);
    expect(d.skipped[0].reason).toContain('超过上限');
  });
});

describe('cochranQ', () => {
  it('两个取值时严格等于 diff-in-diff 的 z²（同一套口径，不是两套）', () => {
    const a = { diff: 0.012, se: 0.004 };
    const b = { diff: -0.003, se: 0.005 };
    const q = cochranQ([a, b])!;
    const z = (a.diff - b.diff) / Math.sqrt(a.se ** 2 + b.se ** 2);
    expect(q.q).toBeCloseTo(z * z, 10);
    expect(q.df).toBe(1);
    expect(q.p).toBeGreaterThan(0);
    expect(q.p).toBeLessThan(1);
  });

  it('三个取值：Q 随离散度上升，df = k − 1', () => {
    const flat = cochranQ([
      { diff: 0.01, se: 0.004 },
      { diff: 0.011, se: 0.004 },
      { diff: 0.009, se: 0.004 },
    ])!;
    const spread = cochranQ([
      { diff: 0.02, se: 0.004 },
      { diff: 0.01, se: 0.004 },
      { diff: 0.0, se: 0.004 },
    ])!;
    expect(flat.df).toBe(2);
    expect(spread.q).toBeGreaterThan(flat.q * 10);
    expect(spread.p).toBeLessThan(flat.p);
  });

  it('有效样本不足 2 组、或标准误为 0 时返回 null（不算硬凑一个数）', () => {
    expect(cochranQ([])).toBeNull();
    expect(cochranQ([{ diff: 0.1, se: 0.01 }])).toBeNull();
    expect(cochranQ([{ diff: 0.1, se: 0 }, { diff: 0.2, se: 0.01 }])).toBeNull();
  });
});

describe('analyze：维度切片接进引擎', () => {
  it('内置实验给出三个维度，且 tenure/device 与 segments 是同一份数组（不各算一次）', () => {
    const exp = ds.experiments.find((e) => e.id === 'E003')!;
    const a = analyze(exp, ds.daily);
    expect(a.dimensions.map((d) => d.key)).toEqual(['device', 'tenure', 'weekend']);
    expect(a.dimensions.find((d) => d.key === 'tenure')!.values).toBe(a.segments.tenure);
    expect(a.dimensions.find((d) => d.key === 'device')!.values).toBe(a.segments.device);
    for (const d of a.dimensions) {
      expect(d.scanned).toBe(d.values.length);
      expect(d.heterogeneity?.df).toBe(d.values.length - 1);
    }
  });

  it('维度表里的差值等于该取值子集重算一遍（表与图上不会是两套数）', () => {
    const exp = ds.experiments.find((e) => e.id === 'E001')!;
    const a = analyze(exp, ds.daily);
    const iOS = a.dimensions.find((d) => d.key === 'device')!.values.find((v) => v.key === 'iOS')!;
    const sub = ds.daily.filter((r) => r.expId === 'E001' && r.device === 'iOS');
    // 比的是**原始两比例差值**（overall），不是 primary——primary 可能走 CUPED 口径，
    // 而维度扫描从来不用 CUPED（切了片之后前周期格子会碎成一片）。
    const again = analyze(exp, sub);
    expect(iOS.diff).toBeCloseTo(again.overall.diff, 12);
  });

  it('导入的多维样例：渠道切出真差异，城市切不出', () => {
    const { dataset } = parseCsvText(SAMPLE_CSV_DIMS);
    const exp = dataset.experiments[0];
    const a = analyze(exp, dataset.daily);
    expect(a.dimensions.map((d) => d.key)).toEqual(['dims.渠道', 'dims.城市']);

    const ch = a.dimensions.find((d) => d.key === 'dims.渠道')!;
    expect(ch.values).toHaveLength(2);
    // 应用商店明显有效、信息流基本没动
    const store = ch.values.find((v) => v.label === '应用商店')!;
    const feed = ch.values.find((v) => v.label === '信息流')!;
    expect(store.diff).toBeGreaterThan(0.015);
    expect(Math.abs(feed.diff)).toBeLessThan(0.005);
    expect(store.q).toBeLessThan(0.01);
    expect(feed.q).toBeGreaterThan(0.5);
    // 效应随渠道变化
    expect(ch.heterogeneity!.p).toBeLessThan(0.05);
    expect(ch.spread!.gap).toBeGreaterThan(0.015);

    const city = a.dimensions.find((d) => d.key === 'dims.城市')!;
    expect(city.heterogeneity!.p).toBeGreaterThan(0.5);
  });

  it('维度只有一组时说清「做不了异质性检验」，而不是给个假 p', () => {
    // 只有 iOS + 只有 new 的数据：device / tenure 都不成维度
    const rows: DailyRow[] = [
      { ...row('2026-11-02', 'iOS', 'new'), variant: 'control' },
      { ...row('2026-11-03', 'iOS', 'new'), variant: 'treatment' },
    ];
    const a = analyze(
      { ...ds.experiments[0], id: 'X', variants: ['control', 'treatment'], metricType: 'binary' },
      rows,
    );
    expect(a.dimensions.map((d) => d.key)).not.toContain('device');
    expect(a.dimensions.map((d) => d.key)).not.toContain('tenure');
  });
});

describe('导入层：维度列识别', () => {
  it('多出来的字符串列被认成维度，且不再算「没被用上」', () => {
    const { report } = parseCsvText(SAMPLE_CSV_DIMS);
    expect(report.dimensions).toEqual(['渠道', '城市']);
    expect(report.unmatchedColumns).toEqual([]);
    expect(report.inferred.join(' ')).toContain('可切维度');
  });

  it('没映射上的**数值**列不会被当成维度（那是指标，不是分组）', () => {
    const csv = `expId,date,variant,exposures,conversions,未知金额列
e1,2026-01-05,control,1000,50,1234.5
e1,2026-01-05,treatment,1000,60,1500.2
e1,2026-01-06,control,1000,48,1190.0
e1,2026-01-06,treatment,1000,61,1480.7`;
    const { report, dataset } = parseCsvText(csv);
    expect(report.dimensions).toEqual([]);
    expect(report.unmatchedColumns).toEqual(['未知金额列']);
    expect(dataset.daily.every((r) => r.dims === undefined)).toBe(true);
  });

  it('JSON 的 daily[].dims 会被收下；类型不对时给中文定位报错', () => {
    const json = {
      experiments: [{ id: 'e1', variants: ['control', 'treatment'] }],
      daily: [
        { expId: 'e1', date: '2026-01-05', variant: 'control', device: 'iOS', tenure: 'new', exposures: 100, conversions: 5, dims: { 渠道: '应用商店', 城市: '上海' } },
        { expId: 'e1', date: '2026-01-05', variant: 'treatment', device: 'iOS', tenure: 'new', exposures: 100, conversions: 6, dims: { 渠道: '信息流', 城市: '成都' } },
      ],
    };
    const dataset = parseDatasetJson(JSON.stringify(json));
    expect(dataset.daily[0].dims).toEqual({ 渠道: '应用商店', 城市: '上海' });
    expect(() =>
      parseDatasetJson(
        JSON.stringify({
          experiments: [{ id: 'e1' }],
          daily: [{ expId: 'e1', date: '2026-01-05', variant: 'control', exposures: 10, conversions: 1, dims: ['渠道'] }],
        }),
      ),
    ).toThrow(/dims 必须是对象/);
  });
});
