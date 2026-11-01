import { describe, expect, it } from 'vitest';
import { analyze } from '../src/lib/decide.ts';
import {
  ImportError,
  parseDatasetCsv,
  parseDatasetJson,
  SAMPLE_CSV,
  SAMPLE_JSON,
} from '../src/lib/import.ts';
import type { Dataset } from '../src/lib/types.ts';

describe('导入：JSON', () => {
  it('示例 JSON 能解析成合法 Dataset，并推断 groundTruth=true', () => {
    const d = parseDatasetJson(SAMPLE_JSON);
    expect(d.experiments).toHaveLength(1);
    expect(d.daily).toHaveLength(2);
    expect(d.groundTruth).toBe(true);
    expect(d.experiments[0].trueDecision).toBe('ship');
  });

  it('显式 groundTruth:false 被尊重', () => {
    const txt = SAMPLE_JSON.replace('"trueDecision": "ship"', '"trueDecision": "inconclusive"');
    const d = parseDatasetJson(txt.replace('"trueLiftOverall": 0.012', '"trueLiftOverall": 0'));
    // 去掉真值后会推断为 false；这里直接验证显式开关
    const explicit = parseDatasetJson('{"groundTruth":false,' + txt.slice(txt.indexOf('"experiments"')));
    expect(explicit.groundTruth).toBe(false);
  });

  it('缺少 experiments 数组报错', () => {
    expect(() => parseDatasetJson('{"daily":[]}')).toThrow(ImportError);
  });

  it('daily 引用了不存在的 expId 报错并定位', () => {
    const bad = `{"experiments":[{"id":"a","name":"a"}],"daily":[{"expId":"zzz","date":"2026-01-01","variant":"control","exposures":10,"conversions":1}]}`;
    expect(() => parseDatasetJson(bad)).toThrow(/zzz/);
  });

  it('非法 variant 报错', () => {
    const bad = `{"experiments":[{"id":"a","name":"a"}],"daily":[{"expId":"a","date":"2026-01-01","variant":"x","exposures":10,"conversions":1}]}`;
    expect(() => parseDatasetJson(bad)).toThrow(/variant/);
  });

  it('conversions 超过 exposures 报错', () => {
    const bad = `{"experiments":[{"id":"a","name":"a"}],"daily":[{"expId":"a","date":"2026-01-01","variant":"control","exposures":10,"conversions":11}]}`;
    expect(() => parseDatasetJson(bad)).toThrow(/conversions/);
  });

  it('缺失可选字段用安全默认值（不崩）', () => {
    const min = `{"experiments":[{"id":"a"}],"daily":[{"expId":"a","date":"2026-01-01","variant":"control","exposures":10,"conversions":1}]}`;
    const d = parseDatasetJson(min);
    expect(d.experiments[0].trueDecision).toBe('inconclusive');
    expect(d.experiments[0].archetype).toBe('null');
  });
  it('整列缺 refunds 必须被记下来（否则护栏会显示「0.00% → 0.00%，未恶化」）', () => {
    // 「缺失」与「真的是 0」在数据里长得一样，所以只能在解析阶段记
    const withAll = JSON.parse(SAMPLE_JSON);
    const dsAll = parseDatasetJson(JSON.stringify(withAll));
    expect(dsAll.missingColumns).toEqual([]);

    const noRefund = JSON.parse(SAMPLE_JSON);
    for (const r of noRefund.daily) delete r.refunds;
    const dsNoRefund = parseDatasetJson(JSON.stringify(noRefund));
    expect(dsNoRefund.missingColumns).toContain('refunds');
    expect(dsNoRefund.missingColumns).not.toContain('complaints');
    // 数值仍被填成 0（下游类型不变），但「曾经缺过」这件事被记住了
    expect(dsNoRefund.daily[0].refunds).toBe(0);
  });

  it('CSV 的缺失看表头：没有这一列才算缺，空格子算「真的是 0」', () => {
    const header = 'expId,date,variant,exposures,conversions';
    const rows = [
      header,
      'exp_001,2026-01-05,control,1000,50',
      'exp_001,2026-01-05,treatment,1000,55',
    ].join('\n');
    const ds = parseDatasetCsv(rows);
    expect(ds.missingColumns).toContain('refunds');
    expect(ds.missingColumns).toContain('latencyP95');
    // revenue 也在缺失清单里：它决定 ARPU 能不能算
    expect(ds.missingColumns).toContain('revenue');

    const withEmpty = ['expId,date,variant,exposures,conversions,refunds', 'exp_001,2026-01-05,control,1000,50,'].join('\n');
    const ds2 = parseDatasetCsv(withEmpty);
    expect(ds2.missingColumns).not.toContain('refunds');
  });

});

describe('导入：CSV', () => {
  it('示例 CSV 能解析，自动推导 experiments，groundTruth=false', () => {
    const d = parseDatasetCsv(SAMPLE_CSV);
    expect(d.groundTruth).toBe(false);
    expect(d.experiments).toHaveLength(1);
    expect(d.daily).toHaveLength(4);
    // 别名归一化：对照 → control，实验组 → treatment
    expect(d.daily.filter((r) => r.variant === 'control')).toHaveLength(2);
    expect(d.daily.filter((r) => r.variant === 'treatment')).toHaveLength(2);
  });

  it('必需列缺失报错', () => {
    const bad = 'expId,variant\na,control';
    expect(() => parseDatasetCsv(bad)).toThrow(/exposures/);
  });

  it('conversions 超过 exposures 报错', () => {
    const bad = 'expId,date,variant,exposures,conversions\na,2026-01-01,control,10,11';
    expect(() => parseDatasetCsv(bad)).toThrow(/conversions/);
  });

  it('可选护栏列存在时进入 guardrailMetrics', () => {
    const d = parseDatasetCsv(SAMPLE_CSV); // 含 refunds/complaints/latencyP95
    expect(d.experiments[0].guardrailMetrics).toEqual(
      expect.arrayContaining(['refunds', 'complaints', 'latencyP95']),
    );
  });

  it('CRLF 与引号转义能正确解析', () => {
    const csv = 'expId,date,variant,exposures,conversions,name\r\na,2026-01-01,control,10,1,"带,逗号"';
    const d = parseDatasetCsv(csv);
    expect(d.daily).toHaveLength(1);
    expect(d.experiments[0].name).toBe('带,逗号');
  });

  it('解析后可直接跑确定性分析（不崩，决策合法）', () => {
    const d: Dataset = parseDatasetCsv(SAMPLE_CSV);
    const exp = d.experiments[0];
    const rows = d.daily.filter((r) => r.expId === exp.id);
    const a = analyze(exp, rows);
    expect(['ship', 'no-ship', 'iterate', 'inconclusive']).toContain(a.decision);
    expect(a.bayes.probTreatBetter).toBeGreaterThanOrEqual(0);
    expect(a.bayes.probTreatBetter).toBeLessThanOrEqual(1);
  });

  it('空数据行（expId 全空被跳过）报错', () => {
    expect(() => parseDatasetCsv('expId,date,variant,exposures,conversions\n,2026-01-01,control,10,1')).toThrow(
      /有效数据/,
    );
  });
});
