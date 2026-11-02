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
import { allocationOf, controlArmOf } from './arms.ts';

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

const VARIANT_ALIASES: Record<string, Variant> = {
  control: 'control',
  ctrl: 'control',
  baseline: 'control',
  base: 'control',
  '0': 'control',
  对照: 'control',
  控制: 'control',
  对照组: 'control',
  控制组: 'control',
  基准: 'control',
  基准组: 'control',
  基线: 'control',
  老版: 'control',
  treatment: 'treatment',
  treat: 'treatment',
  '1': 'treatment',
  a: 'control',
  b: 'treatment',
  实验: 'treatment',
  实验组: 'treatment',
  处理: 'treatment',
  处理组: 'treatment',
  新: 'treatment',
  新版: 'treatment',
  // 单字母 / 单数字的 A/B/C… 写法：A→对照、B→实验、C 起是新增臂。
  // 注意 `c` 早期被当成 control 的简写，那是个坑：A/B/C 三臂表里 C 会被判成对照组，
  // 于是「C 臂 vs C 臂」，差值为 0 且不报错。改成 variant_c。
  c: 'variant_c',
  d: 'variant_d',
  e: 'variant_e',
  f: 'variant_f',
  g: 'variant_g',
  h: 'variant_h',
  i: 'variant_i',
  j: 'variant_j',
  '2': 'variant_c',
  '3': 'variant_d',
  '4': 'variant_e',
  '5': 'variant_f',
  '6': 'variant_g',
  '7': 'variant_h',
  '8': 'variant_i',
  '9': 'variant_j',
};

/** 单表最多这么多臂。超了几乎一定是「分组列指错」，而不是真的做了 7 臂实验。 */
export const MAX_ARMS = 6;

/**
 * 分组值的比较键：中文原样保留（"版本A" 比 "版本a" 好读），ASCII 统一小写并压掉空白。
 * 只做「同一行值是否相等」的归一，不做语义猜测。
 */
export function armKey(raw: unknown): string {
  const s = String(raw ?? '')
    .replace(/[\s\u3000]+/g, ' ')
    .trim();
  if (!s) return '';
  return /[\u4e00-\u9fa5]/.test(s) ? s : s.toLowerCase();
}

/** 占位文本：这些出现在分组列里是「表没填好」，不是「新增了一臂」 */
const PLACEHOLDER_ARM =
  /^(未知|未知分组|未知组|空|空值|无|null|none|nan|n\/a|na|坏|坏分组|坏数据|合计|总计|汇总|小计|其他|其它|其余|全部|全量|总体|overall|total|subtotal|sum|all|unknown|invalid|error|#n\/a|#value!|-|--|---|—|\/|\\|\?)$/i;

/**
 * 这个值**看起来**像不像一个臂名。
 *
 * 为什么需要这一步：`normVariant` 放开到「任意臂名」之后，一个手滑的 `坏分组`
 * 或一行粘错的日期就会被当成第 3 臂，模型静默地在垃圾数据上跑出结论。
 * 所以先做形态判断（日期 / 长数字 / 占位词 → 不是臂），再看出现频次（见 `buildArmPlan`）。
 */
export function isPlausibleArmLabel(raw: unknown): boolean {
  const s = armKey(raw);
  if (!s || s.length > 24) return false;
  if (PLACEHOLDER_ARM.test(s)) return false;
  // 日期形态：分组列被指到了日期列
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(s)) return false;
  if (/^\d{8}$/.test(s)) return false;
  // 纯小数 / 多位数字：多半是指到了数值列（"0"~"9" 已在别名表里，走不到这里）
  if (/^-?\d+(\.\d+)?$/.test(s)) return false;
  return true;
}

/**
 * 分组值 → 臂 id。
 *
 * 别名命中就归一（对照 / control / 0 / A 都是同一个臂）；没命中就**原样收下**
 * ——A/B/n 的臂名是业务起的（"版本B2"、"文案短版"、"算法v3"），不该有白名单。
 * 「原样收下」的安全阀不在这一层，而在 `buildArmPlan` 的频次门槛与臂数上限。
 */
export function normVariant(raw: unknown, ctx: string): Variant {
  if (raw == null || String(raw).trim() === '') throw new ImportError(`${ctx}：缺少分组（variant）`);
  const key = armKey(raw);
  return VARIANT_ALIASES[key] ?? key;
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

/** 一个实验的臂识别结果（预扫描得出，行循环只查表） */
export interface ArmPlan {
  /** 对照在前，其余按首次出现顺序 */
  arms: string[];
  /** 对照臂 id */
  control: string;
  /** 对照组不是别名认出来的，而是「第一个出现的臂」——UI 必须说出来 */
  controlImplicit: boolean;
  /** 分组值（`armKey` 后）→ 臂 id */
  map: Map<string, string>;
  /** 被判定为「不是臂」的分组值 → 人话原因 */
  rejected: Map<string, string>;
}

/**
 * 把「某个实验里出现过的所有分组值」判成臂 / 不是臂。
 *
 * 两条判据（缺一不可）：
 * 1. **形态**像臂名（`isPlausibleArmLabel`）——挡掉日期、长数字、占位词；
 * 2. **频次**够（≥3 行，或 ≥25% 的行）——挡掉只出现一两次的手滑。
 *    一条臂在 A/B/n 里至少占设计流量的几分之一，而 typo 通常只砸中一行。
 * 小样本表（每天两行 × 3 臂）靠「占比 ≥25%」这一条通过，不必凑够 3 行。
 *
 * 判成「不是臂」的行不当成静默丢弃：原因会写进 `rejected`，由行循环逐行报出来。
 */
export function buildArmPlan(
  expId: string,
  observed: Array<{ raw: string; count: number; first: number }>,
  rowTotal: number,
  opts: { controlArm?: string } = {},
): ArmPlan {
  const map = new Map<string, string>();
  const rejected = new Map<string, string>();
  const info = new Map<string, { count: number; first: number }>(); // 臂 id → 汇总
  const order = [...observed].sort((a, b) => a.first - b.first);

  const bump = (id: string, count: number, first: number) => {
    const cur = info.get(id);
    info.set(id, { count: (cur?.count ?? 0) + count, first: Math.min(cur?.first ?? first, first) });
  };

  // 第一遍：分类。臂数上限要在频次门槛**之前**判——否则「9 个臂各只有 1 行」会被
  // 全部当成手滑丢掉，用户拿到的报错是「没有任何有效数据行」，完全指不到真问题（列指错了）。
  const candidates: typeof order = [];
  const plausibleIds = new Set<string>();
  for (const o of order) {
    const alias = VARIANT_ALIASES[o.raw];
    if (alias) {
      bump(alias, o.count, o.first);
      map.set(o.raw, alias);
      plausibleIds.add(alias);
      continue;
    }
    if (!isPlausibleArmLabel(o.raw)) {
      rejected.set(o.raw, `分组值「${o.raw}」不像臂名（像占位文本或指错了列）`);
      continue;
    }
    candidates.push(o);
    plausibleIds.add(o.raw);
  }
  if (plausibleIds.size > MAX_ARMS) {
    const names = [...plausibleIds].slice(0, 8).join('、');
    throw new ImportError(
      `实验 ${expId} 分组列里有 ${plausibleIds.size} 个不同取值（${names}${plausibleIds.size > 8 ? ' …' : ''}），` +
        `超过 ${MAX_ARMS} 个臂的上限——几乎一定是「分组列指错了」（比如指到了日期、用户 id 或渠道列）。\n` +
        `如果这确实是多臂实验，请把臂数控制在 ${MAX_ARMS} 个以内；如果只是个别值写错了，改掉那几行再导。`,
    );
  }

  // 第二遍：频次门槛。形态像臂名、但只出现一两次的，按手滑处理并逐行报原因。
  for (const o of candidates) {
    const share = rowTotal > 0 ? o.count / rowTotal : 0;
    if (o.count < 3 && share < 0.25) {
      rejected.set(
        o.raw,
        `分组值「${o.raw}」在实验 ${expId} 里只出现 ${o.count} 行（${(share * 100).toFixed(1)}%），` +
          `不足 3 行也未达 25%，不当作新增臂——若它确实是一臂，请检查这份导出是否残缺`,
      );
      continue;
    }
    bump(o.raw, o.count, o.first);
    map.set(o.raw, o.raw);
  }

  const declared = opts.controlArm ? VARIANT_ALIASES[armKey(opts.controlArm)] ?? armKey(opts.controlArm) : '';
  let control: string;
  let controlImplicit = false;
  if (declared && info.has(declared)) control = declared;
  else if (info.has('control')) control = 'control';
  else if (info.size >= 2) {
    // 没有对照组别名：按「第一个出现的臂是对照」这个平台惯例，并标记为隐式
    control = order.filter((o) => map.has(o.raw)).map((o) => map.get(o.raw)!)[0]!;
    controlImplicit = true;
  } else if (info.size === 1) {
    // 只有一臂：'treatment' 单独出现时不把它当对照（否则「只有实验组」的告警会消失）
    const only = [...info.keys()][0];
    control = only === 'treatment' ? 'control' : only;
  } else {
    control = 'control';
  }

  const arms = [control, ...[...info.entries()].filter(([id]) => id !== control).sort((a, b) => a[1].first - b[1].first).map(([id]) => id)];
  return { arms, control, controlImplicit, map, rejected };
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
    /** 识别出的臂（对照在前）；长度 > 2 就是多臂实验 */
    arms: string[];
    /** 对照臂 id */
    controlArm: string;
    /** 对照组是「第一个出现的臂」推出来的，不是别名认出来的 */
    controlImplicit: boolean;
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
  /** 手动指定对照臂（覆盖自动识别）。用于「版本A/B/C 里 A 其实是最新版」这类反直觉的表 */
  controlArm?: string;
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

  const dataRows = rows.slice(1);

  /**
   * 预扫描：每个实验的分组列有哪些取值、各出现多少行。
   *
   * 「哪几个值算臂」必须在行循环**之前**定下来，否则同一份表里先出现的 typo
   * 会被当成第 3 臂、后出现的却被跳过——结果依赖行顺序，无法解释也无法复现。
   */
  const observed = new Map<string, Map<string, { count: number; first: number }>>();
  const expRowCount = new Map<string, number>();
  for (let r = 0; r < dataRows.length; r++) {
    const row = dataRows[r] ?? [];
    if (row.every((c) => String(c ?? '').trim() === '')) continue;
    const expId = String(cell(row, 'expId') ?? '').trim();
    const key = armKey(cell(row, 'variant'));
    if (!expId || !key) continue;
    expRowCount.set(expId, (expRowCount.get(expId) ?? 0) + 1);
    let m = observed.get(expId);
    if (!m) {
      m = new Map();
      observed.set(expId, m);
    }
    const cur = m.get(key);
    if (cur) cur.count += 1;
    else m.set(key, { count: 1, first: r });
  }
  const plans = new Map<string, ArmPlan>();
  for (const [expId, m] of observed) {
    plans.set(
      expId,
      buildArmPlan(
        expId,
        [...m.entries()].map(([raw, v]) => ({ raw, count: v.count, first: v.first })),
        expRowCount.get(expId) ?? 0,
        { controlArm: opts.controlArm },
      ),
    );
  }

  const daily: DailyRow[] = [];
  const dropped: DroppedRow[] = [];
  const badVariantValues = new Set<string>();
  const meta = new Map<
    string,
    {
      name?: string;
      primaryMetric?: string;
      metricType?: 'binary' | 'continuous';
      trafficSplit?: string;
      dates: Set<string>;
      rows: number;
      variants: Set<Variant>;
    }
  >();

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
      const rawKey = armKey(cell(row, 'variant'));
      if (!rawKey) throw new ImportError(`${ctx}：缺少分组（variant）`);
      const plan = plans.get(expId);
      const variant = plan?.map.get(rawKey);
      if (!variant) {
        const why = plan?.rejected.get(rawKey);
        throw new ImportError(
          why
            ? `${ctx}：${why}`
            : `${ctx}：分组值「${rawKey}」无法识别（variant 需为对照 / 实验组 / A / B / 0 / 1，或任意的臂名）`,
        );
      }
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
      const ts = String(cell(row, 'trafficSplit') ?? '').trim();
      if (ts && !m.trafficSplit) m.trafficSplit = ts;
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
    const plan = plans.get(expId);
    // 臂列表只认「真的有行」的臂；plans 是从原表预扫描来的，若某些臂的行全被判坏了，
    // 这里要按实际进库的数据再收一遍，否则会出现 n=0 的空臂。
    const armsUsed = (plan?.arms ?? ['control']).filter((a) => m.variants.has(a));
    const variantsUsed = armsUsed.length ? armsUsed : [...m.variants];
    experiments.push({
      id: expId,
      name: m.name ?? expId,
      hypothesis: '',
      startDate: dates[0] ?? '',
      endDate: dates[dates.length - 1] ?? '',
      variants: variantsUsed,
      ...(plan && plan.control !== 'control' && variantsUsed.includes(plan.control)
        ? { controlArm: plan.control }
        : {}),
      trafficSplit: m.trafficSplit ?? '',
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

  const multi = experiments.filter((e) => e.variants.length > 2);
  for (const e of multi) {
    inferred.push(
      `${e.id} 识别出 ${e.variants.length} 个臂（${e.variants
        .map((v) => (v === 'control' ? '对照组' : v === 'treatment' ? '实验组' : v))
        .join(' / ')}）：按 A/B/n 口径分析，每个臂都与对照组比，多重比较用 Dunnett 校正（共享对照组，比 Bonferroni 更省样本）`,
    );
  }
  if (multi.length) {
    const equalOnly = multi.filter((e) => allocationOf(e, e.variants).source === 'equal');
    if (equalOnly.length) {
      inferred.push(
        `${equalOnly.map((e) => e.id).join('、')} 没有可用的分流比例：SRM 检查按**等分**做。` +
          '若实际分流不是等分（例如 50/25/25），请加一列 trafficSplit 填 "50/25/25"——' +
          '用错的期望做 SRM 会把正常实验判成异常',
      );
    } else {
      inferred.push(`分流比例已从 trafficSplit 读取：SRM 用声明比例检查，不用等分假设`);
    }
  }

  const armInfo = new Map<string, { arms: string[]; control: string; implicit: boolean }>();
  const dayCount = new Map<string, Set<string>>();
  const rowsPerExp = new Map<string, number>();
  for (const r of daily) {
    const s = dayCount.get(r.expId) ?? new Set<string>();
    s.add(r.date);
    dayCount.set(r.expId, s);
    rowsPerExp.set(r.expId, (rowsPerExp.get(r.expId) ?? 0) + 1);
  }
  for (const e of experiments) {
    armInfo.set(e.id, {
      arms: e.variants,
      control: controlArmOf(e),
      implicit: Boolean(plans.get(e.id)?.controlImplicit) && e.variants.length > 1,
    });
  }

  const warnings: string[] = [];
  for (const e of experiments) {
    const info = armInfo.get(e.id)!;
    if (info.arms.length === 1) {
      const only = info.arms[0];
      warnings.push(`${e.id} ${only === 'treatment' ? '只有实验组' : '只有对照组'}——缺少另一臂，无法比较`);
    }
    if (info.implicit) {
      warnings.push(
        `${e.id} 的分组值里没有对照组别名（control / 对照 / 0 / A）：已把「${info.control}」当作对照组。` +
          `如果它其实是实验臂，请把对照臂改成正确的那一臂`,
      );
    }
    if ((dayCount.get(e.id)?.size ?? 0) === 1) {
      warnings.push(`${e.id} 只有 1 天数据：分日趋势与序变检验不可用，结论只能看整体`);
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
    experiments: experiments.map((e) => {
      const info = armInfo.get(e.id)!;
      const dates = [...(dayCount.get(e.id) ?? [])].sort();
      return {
        id: e.id,
        name: e.name,
        rows: rowsPerExp.get(e.id) ?? 0,
        days: dates.length,
        dateFrom: dates[0] ?? '',
        dateTo: dates[dates.length - 1] ?? '',
        hasControl: info.arms.includes(info.control),
        hasTreatment: info.arms.some((a) => a !== info.control),
        arms: info.arms,
        controlArm: info.control,
        controlImplicit: info.implicit,
        metricType: e.metricType,
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
