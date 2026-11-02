import { describe, expect, it } from 'vitest';
import { detectColumns, FIELDS, looksLikeDailyTable, normalizeHeader, REQUIRED_FIELDS } from '../src/lib/columnMap.ts';

describe('列识别：表头归一', () => {
  it('全角、空格、括号单位都归一掉', () => {
    expect(normalizeHeader('曝光数（人）')).toBe('曝光数');
    expect(normalizeHeader('Exposures (UV)')).toBe('exposures');
    expect(normalizeHeader(' 转化  人数 ')).toBe('转化人数');
    expect(normalizeHeader('ＡＢ测试')).toBe('ab测试');
  });
});

describe('列识别：真实表头', () => {
  it('中文表头（PM 从 Excel 里直接导出的那种）全部认得出', () => {
    const d = detectColumns(['实验ID', '统计日期', '分组', '曝光数（人）', '转化数', '退款数', '投诉数', '收入（元）']);
    expect(d.missingRequired).toEqual([]);
    for (const k of ['expId', 'date', 'variant', 'exposures', 'conversions', 'refunds', 'complaints', 'revenue']) {
      expect(d.mapping[k as keyof typeof d.mapping], `字段 ${k} 没识别到`).toBeGreaterThanOrEqual(0);
    }
    // 精确命中就别标成「猜的」——UI 靠这个分数决定要不要请用户确认
    expect(d.scores.expId).toBe(100);
    expect(d.scores.exposures).toBe(100);
  });

  it('仓库里那份真实 xlsx 的表头（exp_id / segment_device / latency_p95_ms）能认出来', () => {
    const header = [
      'exp_id',
      'date',
      'variant',
      'segment_device',
      'segment_tenure',
      'exposures',
      'conversions',
      'refunds',
      'complaints',
      'latency_p95_ms',
    ];
    const d = detectColumns(header);
    expect(d.missingRequired).toEqual([]);
    expect(d.mapping.device).toBe(3);
    expect(d.mapping.tenure).toBe(4);
    expect(d.mapping.latencyP95).toBe(9);
    // 带前缀的列名是「包含匹配」，分数低于精确命中：UI 会提示用户确认
    expect(d.scores.device).toBe(60);
  });

  it('短别名不做包含匹配：national / cost 不能被认成曝光数 / 设备', () => {
    const d = detectColumns(['national', 'cost']);
    expect(d.mapping.exposures).toBe(-1);
    expect(d.mapping.device).toBe(-1);
  });

  it('同名字段只认一次：conversions 与 conversions_rate 不会互相覆盖', () => {
    const d = detectColumns(['conversions', 'conversions_rate']);
    const picked = d.mapping.conversions;
    expect(picked).toBe(0); // 精确命中的那个（同分取靠左）
    expect(d.unmatched).toEqual([1]);
  });

  it('「实验」是编号、「实验名称」是名称，别互相抢', () => {
    const d = detectColumns(['实验', '实验名称']);
    expect(d.mapping.expId).toBe(0);
    expect(d.mapping.name).toBe(1);
  });

  it('缺必需列时清单里能说出缺的是哪几个', () => {
    const d = detectColumns(['实验ID', '日期']);
    expect(d.missingRequired).toEqual(['variant', 'exposures', 'conversions']);
    expect(looksLikeDailyTable(['实验ID', '日期'])).toBe(false);
  });

  it('别名表里每个字段都含自己的英文键（保证老格式 100% 命中）', () => {
    // 这条是回归锁：以后往别名表里加词，若把英文键挤掉了，老用户的严格列名会突然不认
    for (const f of FIELDS) {
      const d = detectColumns([f.key]);
      expect(d.mapping[f.key], `字段 ${f.key} 认不出自己的英文键`).toBe(0);
      expect(d.scores[f.key]).toBe(100);
    }
    // 必需列顺序也是对外契约（报告里的文案顺序）
    expect(REQUIRED_FIELDS).toEqual(['expId', 'date', 'variant', 'exposures', 'conversions']);
  });
});
