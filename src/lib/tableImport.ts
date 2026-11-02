/**
 * 表格导入：把「一份二维表」变成引擎能吃的 Dataset，并产出一份**预检报告**。
 *
 * 与 v1 的差别：v1 只认严格列名，遇到「实验ID / 日期 / 曝光数」这种真实表头就报
 * 「CSV 缺少必需列：expId」。v2 先做列识别（`columnMap.ts`），再把识别结果、丢弃行、
 * 缺列、推断项全部摊在用户面前——**导入不该是黑盒**。
 *
 * 行级容错的规矩（唯一一条，但必须能解释）：
 * - 问题行占比 ≤ 10% 且 ≤ 5 行 → 丢弃这些行，写进报告的「已跳过」；
 * - 否则视为整份表结构不对（多半是选错文件或列错位），直接报错并列出前 5 条。
 * 这样既不因为一行脏数据让 950 行白导，也不会把「列错位」这种系统性错误悄悄吞掉。
 */

import type { Dataset, DailyRow, Experiment, Variant } from './types.ts';
import { detectColumns, FIELDS, REQUIRED_FIELDS, type Detection, type FieldKey } from './columnMap.ts';

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

const VARIANT_ALIASES: Record<string, Variant> = {
  control: 'control',
  c: 'control',
  '0': 'control',
  对照: 'control',
  控制: 'control',
  对照组: 'control',
  控制组: 'control',
  treatment: 'treatment',
  t: 'treatment',
  '1': 'treatment',
  a: 'control',
  b: 'treatment',
  实验: 'treatment',
  实验组: 'treatment',
  处理: 'treatment',
  新: 'treatment',
};

export function normVariant(raw: unknown, ctx: string): Variant {
  if (raw == null || String(raw).trim() === '') throw new ImportError(`${ctx}：缺少分组（variant）`);
  const v = String(raw).trim().toLowerCase();
  const m = VARIANT_ALIASES[v];
  if (!m) {
    throw new ImportError(
      `${ctx}：分组值「${raw}」无法识别（variant 需为 control / treatment，或 对照 / 实验组 / A / B / 0 / 1）`,
    );
  }
  return m;
}

export function num(raw: unknown, field: string, ctx: string, min = -Infinity): number {
  if (raw == null || String(raw).trim() === '') throw new ImportError(`${ctx}：缺少 ${field}`);
  const cleaned = String(raw).replace(/[,，\s]/g, '').trim();
  const n = Number(cleaned);
  if (!Number.isFinite(n)) throw new ImportError(`${ctx}：${field} 不是数字「${raw}」`);
  if (n < min) throw new ImportError(`${ctx}：${field} 不能小于 ${min}`);
  return n;
}

/**
 * 日期归一。真实表里同一列可能混着 `2026-01-05`、`2026/1/5`、`20260105`、`2026-01-05 00:00:00`。
 * 不归一的话，同一个实验的同一天会被拆成两行，趋势图与序贯检验都会算错。
 */
export function normalizeDate(raw: unknown, ctx: string): string {
  if (raw == null || String(raw).trim() === '') throw new ImportError(`${ctx}：缺少日期（date）`);
  const s = String(raw).trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return s;
}

export function defaultSpec() {
  return {
    days: 0,
    segments: ['device', 'tenure'] as string[],
    baselineRate: [0, 0] as [number, number],
    refundRate: 0,
    complaintRate: 0,
    latencyMean: 0,
    latencySd: 0,
  };
}

export interface DroppedRow {
  /** 表里的行号（1 基，含表头，跟 Excel 屏幕上一致） */
  row: number;
  reason: string;
}

export interface ImportReport {
  source: 'csv' | 'json' | 'xlsx';
  sheet?: string;
  /** 原始表头 */
  header: string[];
  /** 字段 → 原始列名；没识别到的不出现在这里 */
  mapping: Partial<Record<FieldKey, string>>;
  /** 得分 <100 的识别：这些是「猜」的，UI 要请用户确认 */
  guessed: FieldKey[];
  /** 表头里没被任何字段认领的列 */
  unmatchedColumns: string[];
  rowsTotal: number;
  rowsUsed: number;
  dropped: DroppedRow[];
  experiments: Array<{
    id: string;
    name: string;
    rows: number;
    days: number;
    dateFrom: string;
    dateTo: string;
    hasControl: boolean;
    hasTreatment: boolean;
    /** 主指标口径：连续（ARPU）还是率 */
    metricType: 'binary' | 'continuous';
  }>;
  /** 缺了但不算错的列（缺了对应能力会关闭） */
  missingOptional: FieldKey[];
  /** 导入时做的推断，用户必须能看到 */
  inferred: string[];
  warnings: string[];
}

export interface TableParseResult {
  dataset: Dataset;
  report: ImportReport;
}

export interface TableParseOptions {
  source: 'csv' | 'xlsx';
  sheet?: string;
  /** 手动指定列（字段 → 表头下标）。给了就不再自动识别 */
  mapping?: Partial<Record<FieldKey, number>>;
}

const FIELD_LABEL = Object.fromEntries(FIELDS.map((f) => [f.key, f.label])) as Record<FieldKey, string>;

/** 问题行占比超过这个比例，就不再逐行丢弃，而是整体报错 */
const MAX_DROP_RATIO = 0.1;
const MAX_DROP_ROWS = 5;

export function parseTableRows(rows: unknown[][], opts: TableParseOptions): TableParseResult {
  if (!rows.length) throw new ImportError('表是空的（连表头都没有）');
  const header = (rows[0] ?? []).map((c) => String(c ?? '').trim());
  if (header.every((h) => !h)) throw new ImportError('第一行是全空的：请确认表头在第一行');

  const auto: Detection = opts.mapping
    ? {
        mapping: { ...blankMapping(), ...opts.mapping } as Record<FieldKey, number>,
        scores: {} as Record<FieldKey, number>,
        unmatched: [],
        missingRequired: [],
      }
    : detectColumns(header);

  const mapping = auto.mapping;
  const missingRequired = REQUIRED_FIELDS.filter((k) => !(mapping[k] >= 0));
  if (missingRequired.length) {
    // 报错必须能指导下一步：说清「哪几列没认出来」+「我在你的表头里看到了什么」
    const seen = header.filter(Boolean).slice(0, 12).join('、') || '（空）';
    throw new ImportError(
      `没有识别出这几个必需字段：${missingRequired.map((k) => `${FIELD_LABEL[k]}（${k}）`).join('、')}。\n` +
        `你的表头是：${seen}\n` +
        `请在下方的列映射里手动指定，或把列名改成 expId / date / variant / exposures / conversions。`,
    );
  }

  const idx = (k: FieldKey) => mapping[k];
  const has = (k: FieldKey) => mapping[k] >= 0;
  const cell = (row: unknown[], k: FieldKey) => {
    const i = idx(k);
    return i >= 0 ? row[i] : undefined;
  };

  const daily: DailyRow[] = [];
  const dropped: DroppedRow[] = [];
  const badVariantValues = new Set<string>();
  const meta = new Map<
    string,
    {
      name?: string;
      primaryMetric?: string;
      metricType?: 'binary' | 'continuous';
      dates: Set<string>;
      rows: number;
      variants: Set<Variant>;
    }
  >();

  const dataRows = rows.slice(1);
  for (let r = 0; r < dataRows.length; r++) {
    const row = dataRows[r] ?? [];
    const rowNo = r + 2; // +1 表头 +1 转 1 基
    const expId = String(cell(row, 'expId') ?? '').trim();
    // 完全空行直接跳过，不算「问题行」（Excel 尾部常有一堆空行）
    if (row.every((c) => String(c ?? '').trim() === '')) continue;
    if (!expId) {
      dropped.push({ row: rowNo, reason: '实验编号为空' });
      continue;
    }
    const ctx = `第 ${rowNo} 行`;
    try {
      const variant = normVariant(cell(row, 'variant'), ctx);
      const exposures = num(cell(row, 'exposures'), '曝光数（exposures）', ctx, 1);
      const conversions = num(cell(row, 'conversions'), '转化数（conversions）', ctx, 0);
      if (conversions > exposures) {
        throw new ImportError(
          `${ctx}：转化数（conversions = ${conversions}）大于曝光数（exposures = ${exposures}）——通常是列错位`,
        );
      }
      const date = normalizeDate(cell(row, 'date'), ctx);

      const rawDevice = String(cell(row, 'device') ?? '').trim().toLowerCase();
      const device = rawDevice.startsWith('android') || rawDevice === '安卓' ? 'Android' : 'iOS';
      const rawTenure = String(cell(row, 'tenure') ?? '').trim().toLowerCase();
      const tenure = /old|老|成熟/.test(rawTenure) ? 'old' : 'new';

      const optNum = (k: FieldKey, min = 0): number | undefined => {
        if (!has(k)) return undefined;
        const v = cell(row, k);
        if (v == null || String(v).trim() === '') return undefined;
        return num(v, FIELD_LABEL[k], ctx, min);
      };

      const refunds = optNum('refunds') ?? 0;
      const complaints = optNum('complaints') ?? 0;
      const latencyP95 = optNum('latencyP95') ?? 0;
      const revenue = optNum('revenue');
      const preExposures = optNum('preExposures');
      const preConversions = optNum('preConversions');
      const preRevenue = optNum('preRevenue');

      daily.push({
        expId,
        date,
        variant,
        device,
        tenure,
        exposures,
        conversions,
        refunds,
        complaints,
        latencyP95,
        ...(revenue !== undefined ? { revenue } : {}),
        ...(preExposures !== undefined ? { preExposures } : {}),
        ...(preConversions !== undefined ? { preConversions } : {}),
        ...(preRevenue !== undefined ? { preRevenue } : {}),
      });

      let m = meta.get(expId);
      if (!m) {
        m = { dates: new Set(), rows: 0, variants: new Set() };
        meta.set(expId, m);
      }
      m.dates.add(date);
      m.rows += 1;
      m.variants.add(variant);
      const nm = String(cell(row, 'name') ?? '').trim();
      if (nm && !m.name) m.name = nm;
      const pm = String(cell(row, 'primaryMetric') ?? '').trim();
      if (pm && !m.primaryMetric) m.primaryMetric = pm;
      const mt = String(cell(row, 'metricType') ?? '').trim().toLowerCase();
      if ((mt === 'continuous' || mt === 'binary') && !m.metricType) m.metricType = mt;
    } catch (e) {
      const reason = e instanceof ImportError ? e.message.replace(`${ctx}：`, '') : String(e);
      if (/分组值/.test(reason)) badVariantValues.add(String(cell(row, 'variant') ?? '').trim());
      dropped.push({ row: rowNo, reason });
    }
  }

  if (daily.length === 0) {
    const first = dropped.slice(0, 3).map((d) => `第 ${d.row} 行：${d.reason}`).join('；');
    throw new ImportError(`没有任何有效数据行。${first ? `前几条问题：${first}` : '请检查实验编号 / 分组 / 曝光与转化列是否指对了。'}`);
  }

  // 结构性错误：坏行太多说明不是「个别脏数据」，而是整张表不对
  const badCount = dropped.length;
  const ratio = badCount / (badCount + daily.length);
  if (badCount > MAX_DROP_ROWS && ratio > MAX_DROP_RATIO) {
    const first = dropped.slice(0, 5).map((d) => `第 ${d.row} 行：${d.reason}`).join('\n');
    throw new ImportError(
      `${badCount} / ${badCount + daily.length} 行有问题（${(ratio * 100).toFixed(0)}%），超过 10% 就不再逐行跳过——` +
        `这通常意味着列指错了。前几条：\n${first}`,
    );
  }

  // ---- 由明细推导 experiments ----
  const guardrailMetrics: string[] = [];
  if (has('refunds')) guardrailMetrics.push('refunds');
  if (has('complaints')) guardrailMetrics.push('complaints');
  if (has('latencyP95')) guardrailMetrics.push('latencyP95');

  const hasRevenue = has('revenue') && daily.some((r) => r.revenue !== undefined && r.revenue > 0);
  const experiments: Experiment[] = [];
  for (const [expId, m] of meta) {
    const dates = [...m.dates].sort();
    const declaredContinuous = m.metricType === 'continuous';
    // 声明了 continuous 但没有收入列 → 引擎会退回转化率口径并写明原因（不是这里悄悄改）
    const metricType = declaredContinuous ? 'continuous' : 'binary';
    experiments.push({
      id: expId,
      name: m.name ?? expId,
      hypothesis: '',
      startDate: dates[0] ?? '',
      endDate: dates[dates.length - 1] ?? '',
      variants: ['control', 'treatment'],
      trafficSplit: '',
      primaryMetric: m.primaryMetric ?? (metricType === 'continuous' ? 'ARPU' : 'conversions'),
      metricType,
      guardrailMetrics,
      archetype: 'null',
      trueLift: 0,
      trueLiftOverall: 0,
      trueLiftScope: 'overall',
      trueDecision: 'inconclusive',
      seed: 0,
    });
  }

  const missingOptional = FIELDS.filter((f) => !f.required && !has(f.key)).map((f) => f.key);

  const inferred: string[] = [];
  const continuousCount = [...meta.values()].filter((m) => m.metricType === 'continuous').length;
  if (hasRevenue && continuousCount > 0) {
    inferred.push(`${continuousCount} 个实验声明为连续口径（metricType=continuous）：主指标为 ARPU，差值以「元」为单位`);
  } else if (hasRevenue) {
    // 有收入列 ≠ 主指标就是 ARPU。擅自改主指标会让结论不可比，所以只作副指标，并把「怎么改」写出来
    inferred.push(
      '检测到收入列，但没有任何实验声明 metricType=continuous：ARPU 只作为**副指标**展示，主指标仍是转化率。' +
        '要让 ARPU 当主指标，请在表里加一列 metricType 并填 continuous',
    );
  }
  if (has('preExposures') && has('preConversions')) inferred.push('检测到实验前曝光/转化：已启用 CUPED 方差削减');
  if (badVariantValues.size) {
    inferred.push(`分组值按别名归一：${[...badVariantValues].slice(0, 4).join('、')} 等`);
  }

  const warnings: string[] = [];
  for (const [expId, m] of meta) {
    if (!m.variants.has('control') || !m.variants.has('treatment')) {
      const only = m.variants.has('control') ? '只有对照组' : '只有实验组';
      warnings.push(`${expId} ${only}——缺少另一臂，无法比较`);
    }
    if (m.dates.size === 1) {
      warnings.push(`${expId} 只有 1 天数据：分日趋势与序变检验不可用，结论只能看整体`);
    }
  }
  if (has('refunds') && daily.every((r) => r.refunds === 0)) {
    warnings.push('退款列整列都是 0：要么真的没有退款，要么这一列没导出——若是后者，护栏等于没查');
  }
  if (dropped.length) {
    warnings.push(`已跳过 ${dropped.length} 行（见下方清单），其余 ${daily.length} 行正常导入`);
  }

  // mapping 回填成「字段 → 列名」，UI 展示更直观
  const mappingByName: Partial<Record<FieldKey, string>> = {};
  for (const f of FIELDS) {
    const i = mapping[f.key];
    if (i >= 0 && header[i]) mappingByName[f.key] = header[i];
  }

  const report: ImportReport = {
    source: opts.source,
    sheet: opts.sheet,
    header,
    mapping: mappingByName,
    guessed: opts.mapping
      ? []
      : FIELDS.filter((f) => mapping[f.key] >= 0 && (auto.scores?.[f.key] ?? 0) < 100).map((f) => f.key),
    unmatchedColumns: header.filter((_, i) => !FIELDS.some((f) => mapping[f.key] === i) && header[i]),
    rowsTotal: dataRows.filter((r) => (r ?? []).some((c) => String(c ?? '').trim() !== '')).length,
    rowsUsed: daily.length,
    dropped: dropped.slice(0, 20),
    experiments: [...meta.entries()].map(([id, m]) => {
      const dates = [...m.dates].sort();
      return {
        id,
        name: m.name ?? id,
        rows: m.rows,
        days: m.dates.size,
        dateFrom: dates[0] ?? '',
        dateTo: dates[dates.length - 1] ?? '',
        hasControl: m.variants.has('control'),
        hasTreatment: m.variants.has('treatment'),
        metricType: m.metricType ?? 'binary',
      };
    }),
    missingOptional,
    inferred,
    warnings,
  };

  const dataset: Dataset = {
    generatedAt: new Date().toISOString(),
    seedBase: 0,
    groundTruth: false,
    spec: defaultSpec(),
    experiments,
    daily,
    missingColumns: missingOptional.filter((c) =>
      ['refunds', 'complaints', 'latencyP95', 'revenue', 'preExposures', 'preConversions', 'preRevenue'].includes(c),
    ),
  };

  return { dataset, report };
}

function blankMapping(): Record<FieldKey, number> {
  const out = {} as Record<FieldKey, number>;
  for (const f of FIELDS) out[f.key] = -1;
  return out;
}
