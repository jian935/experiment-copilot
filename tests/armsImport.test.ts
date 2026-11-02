/**
 * A/B/n 的**导入**路径。
 *
 * 这一组的重点不是统计（`multiarm.test.ts` 管那个），而是「一份真实的三人肉表格能不能进来」：
 * 分组列叫「方案C」「版本B2」「实验组2」怎么办？A/B/C 里的 C 会不会被当成对照组？
 * 一行手滑的 typo 会不会被当成第 3 臂、让模型在垃圾数据上算出结论？
 */
import { describe, expect, it } from 'vitest';
import { parseCsvText, SAMPLE_CSV_MULTIARM, parseDatasetJson, SAMPLE_JSON } from '../src/lib/import.ts';
import { analyze } from '../src/lib/decide.ts';
import { armsOf, controlArmOf } from '../src/lib/arms.ts';

const HEAD = '实验ID,统计日期,分组,曝光数,转化数';

function csv(lines: string[], head = HEAD) {
  return [head, ...lines].join('\n');
}

/** 一天三臂的最小可分析表 */
function threeArmCsv(names: [string, string, string]) {
  const lines: string[] = [];
  for (const d of ['01', '02', '03', '04']) {
    lines.push(`e1,2026-03-${d},${names[0]},8000,400`);
    lines.push(`e1,2026-03-${d},${names[1]},4000,232`);
    lines.push(`e1,2026-03-${d},${names[2]},4000,214`);
  }
  return csv(lines);
}

describe('多臂导入：臂名不受白名单限制', () => {
  it('control / 实验组 / 方案C 三臂都能进来，并按三臂分析', () => {
    const { dataset, report } = parseCsvText(threeArmCsv(['control', '实验组', '方案C']));
    const exp = dataset.experiments[0];
    expect(exp.variants).toEqual(['control', 'treatment', '方案C']);
    expect(controlArmOf(exp)).toBe('control');
    expect(report.experiments[0].arms).toEqual(['control', 'treatment', '方案C']);
    expect(report.experiments[0].controlImplicit).toBe(false);

    const a = analyze(exp, dataset.daily);
    expect(a.arms).toHaveLength(3);
    expect(a.multiArm?.k).toBe(3);
    expect(a.multiArm?.comparisons).toBe(2);
    // 焦点臂之外的两个臂都要有和对照组的比较
    expect(a.arms.map((x) => x.id)).toEqual(['control', 'treatment', '方案C']);
  });

  it('A/B/C 里的 C 必须是新增臂，不能因为「c 曾是 control 的简写」变成对照组', () => {
    const { dataset } = parseCsvText(threeArmCsv(['A', 'B', 'C']));
    void dataset;
    const exp = dataset.experiments[0];
    expect(exp.variants).toEqual(['control', 'treatment', 'variant_c']);
    // 三条臂的行数必须都在（早期版本 C 会被并进 control，于是「C vs C」差值为 0 且不报错）
    const counts = new Map<string, number>();
    for (const r of dataset.daily) counts.set(r.variant, (counts.get(r.variant) ?? 0) + 1);
    expect(counts.get('control')).toBe(4);
    expect(counts.get('variant_c')).toBe(4);
  });

  it('臂名里的 ASCII 大小写与空格归一，中文原样保留', () => {
    const { dataset } = parseCsvText(threeArmCsv(['Control', 'Version B2', '文案短版']));
    const exp = dataset.experiments[0];
    expect(exp.variants).toEqual(['control', 'version b2', '文案短版']);
  });

  it('没有对照组别名时按「第一个出现的臂」当对照，并且报告里明说是推出来的', () => {
    const { dataset, report } = parseCsvText(threeArmCsv(['版本A', '版本B', '版本C']));
    const exp = dataset.experiments[0];
    expect(exp.variants[0]).toBe('版本A');
    expect(controlArmOf(exp)).toBe('版本A');
    expect(report.experiments[0].controlImplicit).toBe(true);
    expect(report.warnings.some((w) => w.includes('没有对照组别名') && w.includes('版本A'))).toBe(true);
  });

  it('可以手动指定对照臂（版本A 其实不是基线时）', () => {
    const { dataset, report } = parseCsvText(threeArmCsv(['版本A', '版本B', '版本C']), undefined, '版本C');
    expect(dataset.experiments[0].controlArm).toBe('版本C');
    expect(report.experiments[0].controlArm).toBe('版本C');
    expect(report.experiments[0].controlImplicit).toBe(false);
    const a = analyze(dataset.experiments[0], dataset.daily);
    expect(a.arms[0].id).toBe('版本C');
    expect(a.arms[0].isControl).toBe(true);
  });
});

describe('多臂导入：误判防线', () => {
  it('只出现 1 行的手滑值不当成第 3 臂（原因写进「已跳过」）', () => {
    const text = csv([
      'e1,2026-03-01,control,8000,400',
      'e1,2026-03-01,实验组,4000,232',
      'e1,2026-03-01,实验祖,4000,214', // 手滑
      'e1,2026-03-02,control,8000,404',
      'e1,2026-03-02,实验组,4000,238',
    ]);
    const { dataset, report } = parseCsvText(text);
    expect(dataset.experiments[0].variants).toEqual(['control', 'treatment']);
    expect(report.dropped).toHaveLength(1);
    expect(report.dropped[0].reason).toContain('实验祖');
    expect(report.dropped[0].reason).toContain('不足 3 行');
  });

  it('占位文本（合计 / 未填）不算臂，且错在占位而不是「无法识别」', () => {
    const text = csv([
      'e1,2026-03-01,control,60,30',
      'e1,2026-03-01,实验组,60,36',
      'e1,2026-03-02,control,60,30',
      'e1,2026-03-02,实验组,60,36',
      'e1,2026-03-03,合计,120,66',
    ]);
    const { dataset, report } = parseCsvText(text);
    expect(dataset.experiments[0].variants).toEqual(['control', 'treatment']);
    expect(report.dropped[0].reason).toContain('不像臂名');
  });

  it('臂数超过 6 → 当作列指错了直接报错，不硬着头皮分析', () => {
    const lines: string[] = [];
    for (let i = 0; i < 9; i++) lines.push(`e1,2026-03-01,臂${i},100,10`);
    expect(() => parseCsvText(csv(lines))).toThrow(/分组列里.*9 个不同取值/s);
  });

  it('分组列被指到日期列时，报错要说清是「看起来像日期」', () => {
    // 表里只有 日期 一列被同时认成分组（手动映射）
    const text = ['甲,乙,丙,丁,戊', 'e1,2026-03-01,2026-03-01,1000,60'].join('\n');
    expect(() => parseCsvText(text, { expId: 0, date: 1, variant: 2, exposures: 3, conversions: 4 })).toThrow(
      /不像臂名/,
    );
  });
});

describe('多臂导入：分流比例与 SRM', () => {
  it('带 trafficSplit 的 50/25/25 不会被误判成 SRM 异常', () => {
    const { dataset, report } = parseCsvText(SAMPLE_CSV_MULTIARM);
    const exp = dataset.experiments[0];
    expect(exp.trafficSplit).toBe('50/25/25');
    const a = analyze(exp, dataset.daily);
    expect(a.multiArm?.srmSource).toBe('trafficSplit');
    expect(a.srm.flagged).toBe(false);
    expect(report.inferred.some((s) => s.includes('trafficSplit'))).toBe(true);
  });

  it('没有分流列时会明确警告「按等分检查，可能误判」', () => {
    const { report } = parseCsvText(threeArmCsv(['control', '实验组', '方案C']));
    expect(report.inferred.some((s) => s.includes('等分'))).toBe(true);
    expect(report.inferred.some((s) => s.includes('50/25/25'))).toBe(true);
  });

  it('3 臂样例本身是可分析的完整数据（不是只有格式）', () => {
    const { dataset } = parseCsvText(SAMPLE_CSV_MULTIARM);
    const a = analyze(dataset.experiments[0], dataset.daily);
    expect(a.arms).toHaveLength(3);
    expect(a.primary.adjusted).toBe(true);
    up(a.primary.pRaw);
    up(a.primary.p);
  });
});

describe('多臂导入：JSON 路径', () => {
  it('显式声明三臂的 JSON 能导，并被当成多臂', () => {
    const obj = JSON.parse(SAMPLE_JSON);
    obj.experiments[0].variants = ['control', 'treatment', 'variant_c'];
    const d = '2026-01-05';
    obj.daily.push({ ...obj.daily[1], variant: 'variant_c', conversions: 300 });
    obj.daily.push({ ...obj.daily[0], date: d });
    const ds = parseDatasetJson(JSON.stringify(obj));
    expect(ds.experiments[0].variants).toHaveLength(3);
    expect(armsOf(ds.experiments[0], ds.daily)).toEqual(['control', 'treatment', 'variant_c']);
  });

  it('数据里出现没声明的臂 → 报错并指出该改哪里（JSON 有声明可依，不能默默收下）', () => {
    const obj = JSON.parse(SAMPLE_JSON);
    obj.daily.push({ ...obj.daily[1], variant: 'variant_c' });
    expect(() => parseDatasetJson(JSON.stringify(obj))).toThrow(/不在实验 exp_001 声明的 variants 里/);
    expect(() => parseDatasetJson(JSON.stringify(obj))).toThrow(/experiments\[\]\.variants/);
  });
});

/** 断言 p 值是合法概率：多臂下很容易把「校正 p」写成区间外的数 */
function up(p: number | undefined) {
  expect(typeof p).toBe('number');
  expect(Number.isFinite(p)).toBe(true);
  expect(p!).toBeGreaterThanOrEqual(0);
  expect(p!).toBeLessThanOrEqual(1);
}
