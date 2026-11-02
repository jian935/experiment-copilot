import { describe, expect, it } from 'vitest';
import { parseCsvText, parseDatasetCsv } from '../src/lib/import.ts';
import { normalizeDate } from '../src/lib/tableImport.ts';
import { analyze } from '../src/lib/decide.ts';

const HEAD_ZH = '实验ID,统计日期,分组,曝光数（人）,转化数,退款数,投诉数';

function csv(lines: string[], head = HEAD_ZH) {
  return [head, ...lines].join('\n');
}

describe('表格导入：中文表头', () => {
  it('「实验ID/统计日期/分组/曝光数/转化数」直接能导，不用改表头', () => {
    const text = csv([
      'exp_001,2026-01-05,control,1000,60,12,1',
      'exp_001,2026-01-05,实验组,1000,90,13,2',
      'exp_001,2026-01-06,对照,1000,62,12,1',
      'exp_001,2026-01-06,treatment,1000,92,13,2',
    ]);
    const { dataset, report } = parseCsvText(text);
    expect(dataset.experiments).toHaveLength(1);
    expect(dataset.daily).toHaveLength(4);
    // 分组别名归一
    expect(dataset.daily.filter((r) => r.variant === 'control')).toHaveLength(2);
    // 报告要说清「哪一列被当成什么」
    expect(report.mapping.expId).toBe('实验ID');
    expect(report.mapping.exposures).toBe('曝光数（人）');
    expect(report.rowsUsed).toBe(4);
    expect(report.dropped).toEqual([]);
    // 护栏列存在 → 进 guardrailMetrics
    expect(dataset.experiments[0].guardrailMetrics).toEqual(expect.arrayContaining(['refunds', 'complaints']));
  });

  it('日期写法不同也要归一到 YYYY-MM-DD（否则同一天被拆成两行）', () => {
    const text = csv([
      'e1,2026/1/5,control,1000,60',
      'e1,2026-01-05,treatment,1000,90',
      'e1,20260106,control,1000,60',
      'e1,2026.1.6,treatment,1000,90',
    ]);
    const { dataset } = parseCsvText(text);
    const days = [...new Set(dataset.daily.map((r) => r.date))].sort();
    expect(days).toEqual(['2026-01-05', '2026-01-06']);
    expect(dataset.experiments[0].startDate).toBe('2026-01-05');
    expect(dataset.experiments[0].endDate).toBe('2026-01-06');
  });

  it('normalizeDate 对空值报错，对无法识别的格式原样保留（不猜）', () => {
    expect(() => normalizeDate('', '第 2 行')).toThrow(/日期/);
    expect(normalizeDate('第 1 周', '第 2 行')).toBe('第 1 周');
  });
});

describe('表格导入：坏行容错', () => {
  it('少量坏行被跳过并写进报告，好行照常导入', () => {
    const lines = [
      'e1,2026-01-05,control,1000,60',
      'e1,2026-01-05,treatment,1000,90',
      'e1,2026-01-06,control,1000,60',
      'e1,2026-01-06,treatment,1000,90',
      'e1,2026-01-07,未知分组,1000,90', // 分组非法
      'e1,2026-01-07,control,1000,1200', // 转化数 > 曝光数
    ];
    const { dataset, report } = parseCsvText(csv(lines));
    expect(dataset.daily).toHaveLength(4);
    expect(report.dropped).toHaveLength(2);
    expect(report.dropped[0].row).toBe(6); // 行号跟 Excel 屏幕一致（含表头）
    expect(report.dropped[0].reason).toContain('分组值');
    expect(report.dropped[1].reason).toContain('conversions');
    // 丢弃必须留痕：不能让用户以为 6 行都进来了
    expect(report.warnings.some((w) => w.includes('已跳过 2 行'))).toBe(true);
  });

  it('坏行又多又超比例（>5 行且 >10%）→ 整体报错，而不是悄悄吞掉一半', () => {
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(`e1,2026-01-0${(i % 9) + 1},control,1000,60`);
      lines.push(`e1,2026-01-0${(i % 9) + 1},treatment,1000,90`);
    }
    // 再塞 6 行坏的：6 > 5 且 6/26 = 23% > 10%
    for (let i = 0; i < 6; i++) lines.push(`e1,2026-01-0${i + 1},坏分组,1000,90`);
    expect(() => parseCsvText(csv(lines))).toThrow(/超过 10%/);
  });

  it('全是坏行时，错误信息里带前几条具体原因', () => {
    const text = csv(['e1,2026-01-05,control,0,60']);
    expect(() => parseCsvText(text)).toThrow(/曝光数/);
  });

  it('空行不算坏行（Excel 尾部那几千行空行不该触发熔断）', () => {
    const text = csv([
      'e1,2026-01-05,control,1000,60',
      ',,,,',
      '',
      ',,,,',
      'e1,2026-01-05,treatment,1000,90',
    ]);
    const { dataset, report } = parseCsvText(text);
    expect(dataset.daily).toHaveLength(2);
    expect(report.dropped).toEqual([]);
  });
});

describe('表格导入：口径推断', () => {
  it('有收入列但没声明 continuous → 只作副指标，报告里说清怎么改', () => {
    const head = `${HEAD_ZH},收入`;
    const text = csv(
      ['e1,2026-01-05,control,1000,60,12,1,18000', 'e1,2026-01-05,treatment,1000,90,13,2,26000'],
      head,
    );
    const { dataset, report } = parseCsvText(text);
    expect(dataset.experiments[0].metricType).toBe('binary');
    expect(report.inferred.some((s) => s.includes('副指标'))).toBe(true);
    // 主指标仍是转化率（pp），不是元
    const an = analyze(dataset.experiments[0], dataset.daily);
    expect(an.primary.unit).toBe('pp');
  });

  it('声明 metricType=continuous 且有收入（≥2 天）→ 主指标变成 ARPU（元）', () => {
    const head = `${HEAD_ZH},收入,metricType`;
    const text = csv(
      [
        'e1,2026-01-05,control,1000,60,12,1,18000,continuous',
        'e1,2026-01-05,treatment,1000,90,13,2,26000,continuous',
        'e1,2026-01-06,control,1000,62,12,1,18600,continuous',
        'e1,2026-01-06,treatment,1000,92,13,2,26800,continuous',
      ],
      head,
    );
    const { dataset, report } = parseCsvText(text);
    expect(dataset.experiments[0].metricType).toBe('continuous');
    expect(report.experiments[0].metricType).toBe('continuous');
    const an = analyze(dataset.experiments[0], dataset.daily);
    expect(an.primary.label).toBe('ARPU');
    expect(an.primary.unit).toBe('元');
    expect(report.inferred.some((s) => s.includes('ARPU'))).toBe(true);
  });

  it('声明 continuous 但只有 1 天：退回转化率口径，并且**必须说明原因**', () => {
    // 单格子估不出 ARPU 的方差。静默退回最坏——读者会看到「主指标 ARPU」却读到一个 pp 的差值。
    const head = `${HEAD_ZH},收入,metricType`;
    const text = csv(
      [
        'e1,2026-01-05,control,1000,60,12,1,18000,continuous',
        'e1,2026-01-05,treatment,1000,90,13,2,26000,continuous',
      ],
      head,
    );
    const { dataset } = parseCsvText(text);
    const an = analyze(dataset.experiments[0], dataset.daily);
    expect(an.primary.unit).toBe('pp');
    expect(an.metricFallback).toBeTruthy();
    expect(an.metricFallback).toContain('格子');
  });

  it('只有一臂的实验会被点名警告（这种实验做不出比较）', () => {
    const text = csv(['e1,2026-01-05,control,1000,60', 'e2,2026-01-05,treatment,1000,90']);
    const { report } = parseCsvText(text);
    expect(report.warnings.some((w) => w.includes('只有对照组'))).toBe(true);
    expect(report.warnings.some((w) => w.includes('只有实验组'))).toBe(true);
  });
});

describe('表格导入：手动映射', () => {
  it('列名完全认不出时，用下标手动指定也能导', () => {
    const text = ['甲,乙,丙,丁,戊', 'e1,2026-01-05,control,1000,60'].join('\n');
    // 先确认自动识别会失败
    expect(() => parseCsvText(text)).toThrow(/没有识别出/);

    const { dataset, report } = parseCsvText(text, {
      expId: 0,
      date: 1,
      variant: 2,
      exposures: 3,
      conversions: 4,
    });
    expect(dataset.daily.length).toBe(1);
    // 手动映射的结果也要进报告，否则用户不知道自己刚才把哪列指成了什么
    expect(report.mapping.expId).toBe('甲');
    expect(report.mapping.conversions).toBe('戊');
  });

  it('自动识别失败时的报错要包含「你的表头长什么样」，否则用户不知道该改哪列', () => {
    const text = ['甲,乙,丙,丁,戊', 'e1,2026-01-05,control,1000,60'].join('\n');
    let msg = '';
    try {
      parseCsvText(text);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('你的表头是');
    expect(msg).toContain('甲');
    expect(msg).toContain('列映射');
  });
});

describe('表格导入：与旧入口兼容', () => {
  it('老的严格列名 CSV 行为不变（parseDatasetCsv 仍返回 Dataset）', () => {
    const text = 'expId,date,variant,exposures,conversions\na,2026-01-01,control,10,1';
    const d = parseDatasetCsv(text);
    expect(d.experiments[0].id).toBe('a');
    expect(d.daily).toHaveLength(1);
    expect(d.groundTruth).toBe(false);
  });
});
