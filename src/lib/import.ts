import type { Archetype, DailyRow, Dataset, Decision, Device, Experiment, Tenure, Variant } from './types.ts';
import { armsOf, controlArmOf } from './arms.ts';
import {
  defaultSpec,
  ImportError,
  normalizeDate,
  normVariant,
  num,
  parseTableRows,
  type ImportReport,
  type TableParseResult,
} from './tableImport.ts';

// 这几个符号原来定义在本文件，UI 一直从 './import.ts' 引；挪到 tableImport 后在这里再导出，
// 调用方一行都不用改（也避免两个地方各有一份别名表而漂移）。
export { ImportError, normalizeDate, normVariant };
export type { DroppedRow, ImportReport } from './tableImport.ts';

const DECISIONS: Decision[] = ['ship', 'no-ship', 'iterate', 'inconclusive'];
const ARCHETYPES: Archetype[] = ['null', 'positive', 'negative', 'heterogeneous', 'srm', 'guardrail'];
const DEVICES: Device[] = ['iOS', 'Android'];
const TENURES: Tenure[] = ['new', 'old'];

function normEnum<T extends string>(raw: unknown, allowed: T[], field: string, ctx: string, dflt?: T): T {
  if (raw == null || String(raw).trim() === '') {
    if (dflt !== undefined) return dflt;
    throw new ImportError(`${ctx}：缺少 ${field}`);
  }
  const v = String(raw).trim();
  if (!allowed.includes(v as T)) {
    throw new ImportError(`${ctx}：${field} 非法「${raw}」（允许 ${allowed.join(' / ')}）`);
  }
  return v as T;
}

function optionalNum(raw: unknown, field: string, ctx: string, min = -Infinity): number | undefined {
  if (raw == null || String(raw).trim() === '') return undefined;
  return num(raw, field, ctx, min);
}

/* ============================ JSON 导入 ============================ */

function normExperiment(raw: Record<string, unknown>, i: number): Experiment {
  const ctx = `experiments[${i}]`;
  if (raw == null || typeof raw !== 'object') throw new ImportError(`${ctx}：必须是对象`);
  const id = raw.id != null ? String(raw.id).trim() : '';
  if (!id) throw new ImportError(`${ctx}：缺少 id`);
  const archetype = normEnum<Archetype>(raw.archetype, ARCHETYPES, 'archetype', ctx, 'null');
  const trueDecision = normEnum<Decision>(raw.trueDecision, DECISIONS, 'trueDecision', ctx, 'inconclusive');
  const trueLiftOverall = typeof raw.trueLiftOverall === 'number' ? raw.trueLiftOverall : 0;
  const trueLift = typeof raw.trueLift === 'number' ? raw.trueLift : 0;
  const trueLiftScope = raw.trueLiftScope === 'new_users' ? 'new_users' : 'overall';
  const variants = Array.isArray(raw.variants) && raw.variants.length
    ? (raw.variants as unknown[]).map((v) => normVariant(v, `${ctx}.variants`))
    : (['control', 'treatment'] as Variant[]);
  const guardrailMetrics = Array.isArray(raw.guardrailMetrics)
    ? (raw.guardrailMetrics as unknown[]).map((g) => String(g))
    : [];
  const metricType = raw.metricType === 'continuous' ? 'continuous' : 'binary';
  return {
    id,
    name: raw.name != null ? String(raw.name) : id,
    hypothesis: raw.hypothesis != null ? String(raw.hypothesis) : '',
    startDate: raw.startDate != null ? String(raw.startDate) : '',
    endDate: raw.endDate != null ? String(raw.endDate) : '',
    variants,
    trafficSplit: raw.trafficSplit != null ? String(raw.trafficSplit) : '',
    primaryMetric:
      raw.primaryMetric != null ? String(raw.primaryMetric) : metricType === 'continuous' ? 'ARPU' : 'conversions',
    metricType,
    guardrailMetrics,
    archetype,
    trueLift,
    trueLiftOverall,
    trueLiftScope,
    trueDecision,
    seed: typeof raw.seed === 'number' ? raw.seed : 0,
  };
}

/**
 * 维度字段（`daily[].dims`）的归一化。
 *
 * 纪律：**只收字符串，不做类型推断**。`{ 城市: 310000 }` 里的数字如果被当成维度值，
 * 会和 `{ 城市: "310000" }` 变成两个不同的取值，切片时一半数据凭空消失。
 * 所以统一 `String()` 再 trim；空值直接不收（不是空维度，而是这一行没有该维度）。
 */
const MAX_DIM_KEYS = 8;

function normDims(raw: unknown, ctx: string): Record<string, string> | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ImportError(`${ctx}：dims 必须是对象（形如 {"渠道":"应用商店"}）——维度名 → 维度值`);
  }
  const out: Record<string, string> = {};
  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.length > MAX_DIM_KEYS) {
    throw new ImportError(
      `${ctx}：dims 有 ${keys.length} 个维度，超过上限 ${MAX_DIM_KEYS}——` +
        `维度太多会让切片变成「每组几个格子」，请只保留真正要分析的维度`,
    );
  }
  for (const k of keys) {
    const name = String(k).trim();
    if (!name) throw new ImportError(`${ctx}：dims 里有空维度名`);
    const v = (raw as Record<string, unknown>)[k];
    if (v == null) continue;
    const s = String(v).trim();
    if (!s) continue;
    out[name] = s;
  }
  return Object.keys(out).length ? out : undefined;
}

function normDaily(raw: Record<string, unknown>, i: number, expIds: Set<string>, arms: Map<string, Variant[]>): DailyRow {
  const ctx = `daily[${i}]`;
  if (raw == null || typeof raw !== 'object') throw new ImportError(`${ctx}：必须是对象`);
  const expId = raw.expId != null ? String(raw.expId).trim() : '';
  if (!expId) throw new ImportError(`${ctx}：缺少 expId`);
  if (expIds.size && !expIds.has(expId)) {
    throw new ImportError(`${ctx}：expId「${expId}」在 experiments 里找不到（先确保 experiments 含该 id）`);
  }
  const date = raw.date != null ? String(raw.date).trim() : '';
  if (!date) throw new ImportError(`${ctx}：缺少 date`);
  const variant = normVariant(raw.variant, ctx);
  // JSON 是**显式声明** variants 的格式：数据里冒出没声明的臂，说明导出脚本与元信息不一致。
  // 这类不一致必须报出来，不能像 CSV 那样默默收下（CSV 没有声明可依，只能从数据推）。
  const declared = arms.get(expId);
  if (declared && declared.length && !declared.includes(variant)) {
    throw new ImportError(
      `${ctx}：variant「${variant}」不在实验 ${expId} 声明的 variants 里（${declared.join(' / ')}）——` +
        `如果是多臂实验，请把所有臂都写进 experiments[].variants`,
    );
  }
  const device = normEnum<Device>(raw.device, DEVICES, 'device', ctx, 'iOS');
  const tenure = normEnum<Tenure>(raw.tenure, TENURES, 'tenure', ctx, 'new');
  const exposures = num(raw.exposures, 'exposures', ctx, 1);
  const conversions = num(raw.conversions, 'conversions', ctx, 0);
  if (conversions > exposures) {
    throw new ImportError(`${ctx}：conversions(${conversions}) 不能超过 exposures(${exposures})`);
  }
  const refunds = optionalNum(raw.refunds, 'refunds', ctx, 0) ?? 0;
  const complaints = optionalNum(raw.complaints, 'complaints', ctx, 0) ?? 0;
  const latencyP95 = optionalNum(raw.latencyP95, 'latencyP95', ctx, 0) ?? 0;
  // 收入与 CUPED 协变量都是可选的：缺了并不报错，只是 ARPU / CUPED 相关能力自动关闭
  const revenue = optionalNum(raw.revenue, 'revenue', ctx, 0);
  const preExposures = optionalNum(raw.preExposures, 'preExposures', ctx, 0);
  const preConversions = optionalNum(raw.preConversions, 'preConversions', ctx, 0);
  const preRevenue = optionalNum(raw.preRevenue, 'preRevenue', ctx, 0);
  const dims = normDims(raw.dims, ctx);
  return {
    expId, date, variant, device, tenure, exposures, conversions, refunds, complaints, latencyP95,
    ...(revenue !== undefined ? { revenue } : {}),
    ...(preExposures !== undefined ? { preExposures } : {}),
    ...(preConversions !== undefined ? { preConversions } : {}),
    ...(preRevenue !== undefined ? { preRevenue } : {}),
    ...(dims ? { dims } : {}),
  };
}

/**
 * 会被「缺省填 0」的可选列。缺失与「真的是 0」在数据里长得一模一样，
 * 所以必须在**解析阶段**就把「整列都没有这个键」记下来，
 * 否则下游只能显示「0.00% → 0.00%，未恶化」——那是编数字。
 */
const OPTIONAL_COLUMNS = ['refunds', 'complaints', 'latencyP95', 'revenue', 'preExposures', 'preConversions', 'preRevenue'];

/** 整列缺失的列名：所有行都没有这个键（任意一行有值就不算缺失） */
function missingColumnsOf(rows: Record<string, unknown>[], cols: string[]): string[] {
  if (!rows.length) return [];
  return cols.filter((c) => !rows.some((r) => r && r[c] !== undefined && r[c] !== null && r[c] !== ''));
}

/**
 * 把用户提供的 JSON 解析成内部 Dataset。
 * - 校验 experiments / daily 的结构与引用关系，给出中文定位报错。
 * - groundTruth：显式给出用显式；否则若每个 experiment 都带 trueDecision + trueLiftOverall 则视为有真值。
 * - 缺失的可选字段（真值、segments、guardrailMetrics 等）用安全默认值填充，保证下游组件不崩。
 */
export function parseDatasetJson(text: string): Dataset {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new ImportError(`JSON 解析失败：${(e as Error).message}`);
  }
  if (raw == null || typeof raw !== 'object') throw new ImportError('JSON 根节点必须是对象');
  if (!Array.isArray(raw.experiments)) throw new ImportError('缺少 experiments 数组');
  if (!Array.isArray(raw.daily)) throw new ImportError('缺少 daily 数组');

  const experiments = (raw.experiments as Record<string, unknown>[]).map((e, i) => normExperiment(e, i));
  const expIds = new Set(experiments.map((e) => e.id));
  const armsByExp = new Map(experiments.map((e) => [e.id, e.variants]));
  const daily = (raw.daily as Record<string, unknown>[]).map((r, i) => normDaily(r, i, expIds, armsByExp));

  const rawExps = raw.experiments as Record<string, unknown>[];
  const rawHasGT =
    rawExps.length > 0 && rawExps.every((e) => e && e.trueDecision !== undefined && e.trueLiftOverall !== undefined);
  const groundTruth = typeof raw.groundTruth === 'boolean' ? raw.groundTruth : rawHasGT;

  const spec =
    raw.spec && typeof raw.spec === 'object' ? (raw.spec as Dataset['spec']) : defaultSpec();

  return {
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : new Date().toISOString(),
    seedBase: typeof raw.seedBase === 'number' ? raw.seedBase : 0,
    groundTruth,
    spec,
    experiments,
    daily,
    missingColumns: missingColumnsOf(raw.daily as Record<string, unknown>[], OPTIONAL_COLUMNS),
  };
}

/* ============================ CSV 导入 ============================ */

/**
 * 从 Excel 里复制出来的那片区域是 **Tab 分隔**，粘贴进来自动识别：
 * 首行 Tab 比逗号多就走 Tab。判错的代价是「整行被当成一列」，用户会看到
 * 「没有识别出曝光数列」——所以这个判断必须做，不能只支持逗号。
 */
export function detectDelimiter(text: string): string {
  const first = (text.split('\n')[0] ?? '').replace(/\r$/, '');
  const tabs = (first.match(/\t/g) ?? []).length;
  const commas = (first.match(/,/g) ?? []).length;
  return tabs > commas ? '\t' : ',';
}

/** 极简但正确的 CSV/TSV 解析：支持引号转义、字段内分隔符、CRLF */
function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/**
 * 从「日级明细 CSV」构造 Dataset。
 *
 * 列名不再要求写死：`实验ID / 日期 / 分组 / 曝光数 / 转化数` 这类中文表头也能识别
 * （别名表在 `columnMap.ts`）。识别不出必需列时会报错，并在消息里列出「你的表头长什么样」，
 * 让用户知道该改哪一列，而不是只收到一句「缺少 expId」。
 *
 * 想拿到「识别到了什么 / 丢了哪些行 / 缺哪些列」，用 `parseCsvText` —— 返回 dataset + report。
 */
/** 文本 → 二维表（自动识别逗号 / Tab）。UI 改列映射时要重跑，必须与首次解析走同一条路。 */
export function textToRows(text: string): string[][] {
  return parseCsv(text, detectDelimiter(text));
}

export function parseCsvText(
  text: string,
  mapping?: Partial<Record<import('./columnMap.ts').FieldKey, number>>,
  controlArm?: string,
): TableParseResult {
  const rows = textToRows(text);
  if (rows.length < 2) throw new ImportError('至少要有一行表头 + 一行数据');
  return parseTableRows(rows, { source: 'csv', mapping, controlArm });
}

/** 只要 Dataset 时的便捷入口（内部就是 parseCsvText().dataset） */
export function parseDatasetCsv(text: string): Dataset {
  return parseCsvText(text).dataset;
}

/**
 * JSON 路径的「预检报告」。
 *
 * JSON 已经是结构化格式，不存在列映射问题，但 UI 需要和 CSV/Excel 一样的一份摘要
 * （几个实验、多少行、有没有真值、有没有只有一臂的实验）。让两条导入路径共用同一个
 * 预检面板，而不是「JSON 走一套界面、Excel 走另一套」——后者是导入体验割裂的常见来源。
 */
export function reportForJson(dataset: Dataset, source: 'json' = 'json'): ImportReport {
  const byExp = new Map<string, typeof dataset.daily>();
  for (const r of dataset.daily) {
    const list = byExp.get(r.expId) ?? [];
    list.push(r);
    byExp.set(r.expId, list);
  }
  const warnings: string[] = [];
  for (const e of dataset.experiments) {
    const rows = byExp.get(e.id) ?? [];
    const arms = armsOf(e, rows);
    const control = controlArmOf(e);
    const days = new Set(rows.map((r) => r.date));
    if (arms.length <= 1) {
      warnings.push(`${e.id} ${arms[0] === 'treatment' ? '只有实验组' : '只有对照组'}——缺少另一臂，无法比较`);
    } else if (!arms.includes(control)) {
      warnings.push(`${e.id} 声明了 ${arms.length} 个臂，但数据里找不到对照组「${control}」——检查 variants 与数据是否对得上`);
    }
    if (days.size === 1) warnings.push(`${e.id} 只有 1 天数据：分日趋势与序变检验不可用`);
  }
  const hasGuardrail = dataset.experiments.some((e) => e.guardrailMetrics.length > 0);
  const missingOptional: ImportReport['missingOptional'] = hasGuardrail
    ? []
    : ['refunds', 'complaints', 'latencyP95'];
  return {
    source,
    header: [],
    mapping: {},
    guessed: [],
    unmatchedColumns: [],
    // JSON 里的维度来自每行的 dims 对象，没有「列」的概念，所以这里只报维度名
    dimensions: [...new Set(dataset.daily.flatMap((r) => Object.keys(r.dims ?? {})))],
    rowsTotal: dataset.daily.length,
    rowsUsed: dataset.daily.length,
    dropped: [],
    experiments: dataset.experiments.map((e) => {
      const rows = byExp.get(e.id) ?? [];
      const arms = armsOf(e, rows);
      const control = controlArmOf(e);
      const dates = [...new Set(rows.map((r) => r.date))].sort();
      return {
        id: e.id,
        name: e.name,
        rows: rows.length,
        days: dates.length,
        dateFrom: dates[0] ?? '',
        dateTo: dates[dates.length - 1] ?? '',
        hasControl: arms.includes(control),
        hasTreatment: arms.some((a) => a !== control),
        arms,
        controlArm: control,
        // JSON 是显式声明 variants 的，对照臂由声明或「第一个臂」约定得出，不算猜
        controlImplicit: false,
        metricType: e.metricType,
      };
    }),
    missingOptional,
    inferred: [
      dataset.groundTruth
        ? 'JSON 自带 trueDecision / trueLiftOverall：评测看板可用'
        : 'JSON 没有真值：评测看板会自动隐藏依赖真值的指标',
    ],
    warnings,
  };
}

/* ============================ 示例（供 UI 展示） ============================ */

export const SAMPLE_JSON = `{
  "experiments": [
    {
      "id": "exp_001",
      "name": "新首页改版",
      "startDate": "2026-01-05",
      "endDate": "2026-01-12",
      "variants": ["control", "treatment"],
      "primaryMetric": "ARPU",
      "metricType": "continuous",
      "archetype": "positive",
      "trueLift": 0.012,
      "trueLiftOverall": 0.012,
      "trueLiftScope": "overall",
      "trueDecision": "ship"
    }
  ],
  "daily": [
    { "expId": "exp_001", "date": "2026-01-05", "variant": "control", "device": "iOS", "tenure": "new", "exposures": 5000, "conversions": 260, "refunds": 60, "complaints": 5, "latencyP95": 800, "revenue": 18200, "preExposures": 4800, "preConversions": 250, "preRevenue": 17500 },
    { "expId": "exp_001", "date": "2026-01-05", "variant": "treatment", "device": "iOS", "tenure": "new", "exposures": 5000, "conversions": 320, "refunds": 62, "complaints": 6, "latencyP95": 810, "revenue": 22400, "preExposures": 4800, "preConversions": 248, "preRevenue": 17360 }
  ]
}`;

export const SAMPLE_CSV = `expId,date,variant,device,tenure,exposures,conversions,refunds,complaints,latencyP95,revenue,primaryMetric,metricType,name
exp_001,2026-01-05,control,iOS,new,5000,260,60,5,800,18200,ARPU,continuous,新首页改版
exp_001,2026-01-05,treatment,iOS,new,5000,320,62,6,810,22400,ARPU,continuous,新首页改版
exp_001,2026-01-06,对照,Android,old,4800,250,58,4,790,17500,ARPU,continuous,新首页改版
exp_001,2026-01-06,实验组,Android,old,4800,305,59,5,795,21350,ARPU,continuous,新首页改版`;

/**
 * 3 臂样例：分组值故意用三种不同的写法（`control` / `实验组` / `方案C`），
 * 演示「臂名不用改表」——别名归一的、中文的、业务自定义的都能一起认进来。
 * 分流不是等分（50/25/25），所以带了 trafficSplit，SRM 才不会误判。
 */
export const SAMPLE_CSV_MULTIARM = `expId,date,variant,trafficSplit,exposures,conversions,refunds,complaints,name
exp_301,2026-02-02,control,50/25/25,8000,400,96,8,支付页三版对比
exp_301,2026-02-02,实验组,50/25/25,4000,232,48,4,支付页三版对比
exp_301,2026-02-02,方案C,50/25/25,4000,214,45,4,支付页三版对比
exp_301,2026-02-03,control,50/25/25,8000,404,95,7,支付页三版对比
exp_301,2026-02-03,实验组,50/25/25,4000,238,49,5,支付页三版对比
exp_301,2026-02-03,方案C,50/25/25,4000,209,44,3,支付页三版对比
exp_301,2026-02-04,control,50/25/25,8000,398,97,9,支付页三版对比
exp_301,2026-02-04,实验组,50/25/25,4000,241,47,4,支付页三版对比
exp_301,2026-02-04,方案C,50/25/25,4000,216,46,5,支付页三版对比`;

/**
 * 多维度样例：表里多了「渠道」「城市」两列，导入器会自动把它们认成**可切维度**。
 *
 * 数据故意造成「渠道决定一切」：应用商店 +1.2pp、信息流基本没动。
 * 所以详情页切到「渠道」时 Cochran Q 会报「各取值确有差异」——这正是
 * 「整体 +0.8pp，但只对一个渠道有效」的真实样子，也是 `iterate`（定向上线）的来源。
 *
 * 注意它**没有** device / tenure 两列：导入器会按默认值（iOS / new）填，
 * 于是那两个维度只剩一个取值、不出现在 chip 里——这本身也是一次演示：
 * 维度列表是按数据实际有的东西算出来的，不是写死的。
 */
export const SAMPLE_CSV_DIMS = `expId,date,variant,渠道,城市,exposures,conversions,refunds,name
exp_401,2026-03-02,control,应用商店,上海,1200,55,6,新支付流程
exp_401,2026-03-02,treatment,应用商店,上海,1200,77,7,新支付流程
exp_401,2026-03-02,control,应用商店,成都,900,41,4,新支付流程
exp_401,2026-03-02,treatment,应用商店,成都,900,58,5,新支付流程
exp_401,2026-03-02,control,信息流,上海,800,32,3,新支付流程
exp_401,2026-03-02,treatment,信息流,上海,800,31,3,新支付流程
exp_401,2026-03-02,control,信息流,成都,700,28,2,新支付流程
exp_401,2026-03-02,treatment,信息流,成都,700,28,2,新支付流程
exp_401,2026-03-03,control,应用商店,上海,1180,54,6,新支付流程
exp_401,2026-03-03,treatment,应用商店,上海,1220,76,7,新支付流程
exp_401,2026-03-03,control,应用商店,成都,880,40,4,新支付流程
exp_401,2026-03-03,treatment,应用商店,成都,920,57,5,新支付流程
exp_401,2026-03-03,control,信息流,上海,790,31,3,新支付流程
exp_401,2026-03-03,treatment,信息流,上海,810,33,3,新支付流程
exp_401,2026-03-03,control,信息流,成都,690,27,2,新支付流程
exp_401,2026-03-03,treatment,信息流,成都,710,29,2,新支付流程`;
