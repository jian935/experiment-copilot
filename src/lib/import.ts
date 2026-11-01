import type { Archetype, DailyRow, Dataset, Decision, Device, Experiment, Tenure, Variant } from './types.ts';

/** 导入失败的统一错误类型，UI 直接拿 message 展示 */
export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

const DECISIONS: Decision[] = ['ship', 'no-ship', 'iterate', 'inconclusive'];
const ARCHETYPES: Archetype[] = ['null', 'positive', 'negative', 'heterogeneous', 'srm', 'guardrail'];
const DEVICES: Device[] = ['iOS', 'Android'];
const TENURES: Tenure[] = ['new', 'old'];

/** variant 常见别名归一化（中英文、A/B、0/1 都认） */
const VARIANT_ALIASES: Record<string, Variant> = {
  control: 'control',
  treatment: 'treatment',
  c: 'control',
  t: 'treatment',
  a: 'control',
  b: 'treatment',
  '0': 'control',
  '1': 'treatment',
  对照: 'control',
  控制: 'control',
  对照组: 'control',
  控制组: 'control',
  实验: 'treatment',
  实验组: 'treatment',
  处理: 'treatment',
  新: 'treatment',
};

function normVariant(raw: unknown, ctx: string): Variant {
  if (raw == null || String(raw).trim() === '') throw new ImportError(`${ctx}：缺少 variant 字段`);
  const v = String(raw).trim().toLowerCase();
  const m = VARIANT_ALIASES[v];
  if (!m) {
    throw new ImportError(
      `${ctx}：variant 非法「${raw}」（需为 control / treatment，或别名 对照/实验组/A/B/0/1）`,
    );
  }
  return m;
}

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

function num(raw: unknown, field: string, ctx: string, min = -Infinity): number {
  if (raw == null || String(raw).trim() === '') throw new ImportError(`${ctx}：缺少 ${field}`);
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) throw new ImportError(`${ctx}：${field} 不是数字「${raw}」`);
  if (n < min) throw new ImportError(`${ctx}：${field} 不能小于 ${min}`);
  return n;
}

function defaultSpec() {
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

function normDaily(raw: Record<string, unknown>, i: number, expIds: Set<string>): DailyRow {
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
  return {
    expId, date, variant, device, tenure, exposures, conversions, refunds, complaints, latencyP95,
    ...(revenue !== undefined ? { revenue } : {}),
    ...(preExposures !== undefined ? { preExposures } : {}),
    ...(preConversions !== undefined ? { preConversions } : {}),
    ...(preRevenue !== undefined ? { preRevenue } : {}),
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
  const daily = (raw.daily as Record<string, unknown>[]).map((r, i) => normDaily(r, i, expIds));

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

/** 极简但正确的 CSV 解析：支持引号转义、字段内逗号、CRLF */
function parseCsv(text: string): string[][] {
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
    else if (ch === ',') {
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
 * 必需列：expId, date, variant, exposures, conversions
 * 可选列：device, tenure, refunds, complaints, latencyP95, name,
 *         revenue（该格子收入合计，元）、preExposures / preConversions / preRevenue（CUPED 协变量）、
 *         primaryMetric / metricType（把某个实验声明成 ARPU 主指标）
 * - variant 支持别名（对照/实验组/A/B/0/1）。
 * - 缺失 device/tenure 时整行归入默认单层（'iOS'/'new'），仍可分析（只是无分层）。
 * - 自动从明细推导 experiments（唯一 expId、日期范围、存在哪些护栏列）。
 * - 有 revenue 列时 ARPU 会自动被计算（作为主指标或副指标）；没有则该能力静默关闭，不报错。
 * - 真实数据通常没有已知真值 → groundTruth = false，评测看板会自动隐藏。
 */
export function parseDatasetCsv(text: string): Dataset {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new ImportError('CSV 至少需要一行表头 + 一行数据');

  const header = rows[0].map((h) => String(h).trim());
  const required = ['expId', 'date', 'variant', 'exposures', 'conversions'];
  const missing = required.filter((c) => !header.includes(c));
  if (missing.length) {
    throw new ImportError(`CSV 缺少必需列：${missing.join('、')}（必需列：${required.join('、')}）`);
  }
  const col = (name: string) => header.indexOf(name);
  const iExp = col('expId');
  const iDate = col('date');
  const iVar = col('variant');
  const iDev = col('device');
  const iTnt = col('tenure');
  const iExpN = col('exposures');
  const iConv = col('conversions');
  const iName = col('name');
  const iRef = col('refunds');
  const iComp = col('complaints');
  const iLat = col('latencyP95');
  const iRev = col('revenue');
  const iPreN = col('preExposures');
  const iPreC = col('preConversions');
  const iPreR = col('preRevenue');
  const iPrim = col('primaryMetric');
  const iType = col('metricType');
  const has = (i: number) => i >= 0;

  const daily: DailyRow[] = [];
  const meta = new Map<
    string,
    { name?: string; devices: Set<Device>; tenures: Set<Tenure>; dates: string[]; primaryMetric?: string; metricType?: 'binary' | 'continuous' }
  >();

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const get = (i: number) => (i >= 0 && i < cells.length ? cells[i] : '');
    const expId = get(iExp).trim();
    if (!expId) continue; // 跳过空 expId 行
    const ctx = `CSV 第 ${r + 1} 行`;
    const variant = normVariant(get(iVar), ctx);
    const device = normEnum<Device>(get(iDev), DEVICES, 'device', ctx, 'iOS');
    const tenure = normEnum<Tenure>(get(iTnt), TENURES, 'tenure', ctx, 'new');
    const exposures = num(get(iExpN), 'exposures', ctx, 1);
    const conversions = num(get(iConv), 'conversions', ctx, 0);
    if (conversions > exposures) throw new ImportError(`${ctx}：conversions 不能超过 exposures`);
    const refunds = has(iRef) && get(iRef).trim() !== '' ? num(get(iRef), 'refunds', ctx, 0) : 0;
    const complaints = has(iComp) && get(iComp).trim() !== '' ? num(get(iComp), 'complaints', ctx, 0) : 0;
    const latencyP95 = has(iLat) && get(iLat).trim() !== '' ? num(get(iLat), 'latencyP95', ctx, 0) : 0;
    const revenue = has(iRev) && get(iRev).trim() !== '' ? num(get(iRev), 'revenue', ctx, 0) : undefined;
    const preExposures = has(iPreN) && get(iPreN).trim() !== '' ? num(get(iPreN), 'preExposures', ctx, 0) : undefined;
    const preConversions = has(iPreC) && get(iPreC).trim() !== '' ? num(get(iPreC), 'preConversions', ctx, 0) : undefined;
    const preRevenue = has(iPreR) && get(iPreR).trim() !== '' ? num(get(iPreR), 'preRevenue', ctx, 0) : undefined;

    const date = get(iDate).trim();
    if (!date) throw new ImportError(`${ctx}：缺少 date`);

    daily.push({
      expId, date, variant, device, tenure, exposures, conversions, refunds, complaints, latencyP95,
      ...(revenue !== undefined ? { revenue } : {}),
      ...(preExposures !== undefined ? { preExposures } : {}),
      ...(preConversions !== undefined ? { preConversions } : {}),
      ...(preRevenue !== undefined ? { preRevenue } : {}),
    });

    let m = meta.get(expId);
    if (!m) {
      m = { devices: new Set(), tenures: new Set(), dates: [] };
      meta.set(expId, m);
    }
    m.devices.add(device);
    m.tenures.add(tenure);
    m.dates.push(date);
    if (has(iName)) {
      const nm = get(iName).trim();
      if (nm && !m.name) m.name = nm;
    }
    if (has(iPrim)) {
      const pm = get(iPrim).trim();
      if (pm && !m.primaryMetric) m.primaryMetric = pm;
    }
    if (has(iType)) {
      const mt = get(iType).trim().toLowerCase();
      if ((mt === 'continuous' || mt === 'binary') && !m.metricType) m.metricType = mt;
    }
  }

  if (daily.length === 0) throw new ImportError('CSV 没有有效数据行（请检查 expId / variant 列）');

  const guardrailMetrics: string[] = [];
  if (has(iRef)) guardrailMetrics.push('refunds');
  if (has(iComp)) guardrailMetrics.push('complaints');
  if (has(iLat)) guardrailMetrics.push('latencyP95');

  const experiments: Experiment[] = [];
  for (const [expId, m] of meta) {
    const dates = m.dates.slice().sort();
    // 有 revenue 且声明了 continuous 才走 ARPU 主指标；只声明 continuous 但没收入会在 analyze 里被显式退回
    const metricType = m.metricType ?? 'binary';
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

  // CSV 的「缺失」看表头：没有这一列 = 整列缺失（空格子算有列，走填 0）
  const missingCsv = OPTIONAL_COLUMNS.filter((c) => !header.includes(c));
  return {
    generatedAt: new Date().toISOString(),
    seedBase: 0,
    groundTruth: false,
    spec: defaultSpec(),
    experiments,
    daily,
    missingColumns: missingCsv,
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
