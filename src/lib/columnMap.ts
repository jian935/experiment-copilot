/**
 * 表头识别：把「用户手里那张表」的列名映射到引擎需要的字段。
 *
 * 为什么需要这一层：真实 PM 拿到的表几乎不会叫 `expId / exposures / conversions`，
 * 而是「实验ID」「统计日期」「分组」「曝光数（人）」「转化数」。要求用户改表头，
 * 等于把「把数据整理成工具能吃的形状」这件事又推回给用户——这是导入失败的第一大原因。
 *
 * 三条纪律：
 * 1. **不做猜测性的模糊匹配**。所有别名都是显式登记的；没登记就是没识别，宁可让用户在
 *    映射下拉里手动选，也不要把 `gmv` 悄悄当成 `conversions` 用。
 * 2. **同分时必需列优先**。`实验` 既可能是编号也可是名称，谁更具体谁赢（见 SCORES）。
 * 3. **一列只归一个字段**。两列抢同一字段时，分高的拿走，另一个进「未识别」清单——
 *    否则 `conversions` 与 `conversions_rate` 会互相覆盖，且没人会发现。
 */

export type FieldKey =
  | 'expId'
  | 'date'
  | 'variant'
  | 'device'
  | 'tenure'
  | 'exposures'
  | 'conversions'
  | 'refunds'
  | 'complaints'
  | 'latencyP95'
  | 'revenue'
  | 'preExposures'
  | 'preConversions'
  | 'preRevenue'
  | 'name'
  | 'primaryMetric'
  | 'metricType'
  | 'trafficSplit';

export interface FieldSpec {
  key: FieldKey;
  /** 展示名（UI 下拉用） */
  label: string;
  required: boolean;
  /** 说明：为什么需要它 / 缺了会怎样 */
  hint: string;
}

export const FIELDS: FieldSpec[] = [
  { key: 'expId', label: '实验编号', required: true, hint: '一列一个实验；同一实验的多天多行靠它聚合' },
  { key: 'date', label: '日期', required: true, hint: '天级粒度；分日趋势与序贯检验都靠它' },
  { key: 'variant', label: '分组', required: true, hint: 'control / treatment，或 对照 / 实验组 / A / B / 0 / 1' },
  { key: 'exposures', label: '曝光数', required: true, hint: '该行进入实验的人数（分母）' },
  { key: 'conversions', label: '转化数', required: true, hint: '该行转化人数（分子），不能大于曝光数' },
  { key: 'device', label: '设备', required: false, hint: 'iOS / Android；缺了就没有设备维分层' },
  { key: 'tenure', label: '用户类型', required: false, hint: 'new / old；缺了就没有新老用户分层' },
  { key: 'refunds', label: '退款数', required: false, hint: '唯一参与决策的硬护栏；缺了护栏显示「不可用」' },
  { key: 'complaints', label: '投诉数', required: false, hint: '低基数，只提示不拦截' },
  { key: 'latencyP95', label: 'P95 延迟', required: false, hint: '毫秒；只提示不拦截' },
  { key: 'revenue', label: '收入', required: false, hint: '该行总收入（元）；有它才能按 ARPU 分析' },
  { key: 'preExposures', label: '实验前曝光', required: false, hint: 'CUPED 的前窗口分母' },
  { key: 'preConversions', label: '实验前转化', required: false, hint: 'CUPED 的前窗口分子' },
  { key: 'preRevenue', label: '实验前收入', required: false, hint: 'CUPED 的前窗口收入' },
  { key: 'name', label: '实验名称', required: false, hint: '缺了用编号当名称' },
  { key: 'primaryMetric', label: '主指标名', required: false, hint: '缺了按 metricType 推断' },
  { key: 'metricType', label: '指标类型', required: false, hint: 'binary（率）/ continuous（ARPU）' },
  {
    key: 'trafficSplit',
    label: '分流比例',
    required: false,
    hint: '如 50/50 或 50/25/25；多臂实验缺了它，SRM 只能按等分检查',
  },
];

export const REQUIRED_FIELDS = FIELDS.filter((f) => f.required).map((f) => f.key);

/**
 * 别名表。第一项永远是引擎自己的字段名——保证老格式（严格列名）100% 命中，
 * 不因为加了识别层而改变旧行为。
 */
const ALIASES: Record<FieldKey, string[]> = {
  expId: ['expid', 'exp_id', '实验id', '实验编号', '实验号', '实验', '试验id', '测试id', 'experiment', 'experimentid', 'experiment_id', 'testid', 'test_id', 'abtest', 'ab实验'],
  date: ['date', '日期', '统计日期', '数据日期', 'dt', 'day', 'date_day', '时间'],
  variant: ['variant', '分组', '组别', '组', '变体', '实验组别', 'arm', 'group', 'bucket', 'ab组', 'ab', '版本'],
  device: ['device', '设备', '平台', '端', 'os', 'device_type', '终端', '设备类型'],
  tenure: ['tenure', '用户类型', '用户分层', '新老用户', '新老', 'lifecycle', 'user_type', '用户阶段'],
  exposures: ['exposures', 'exposure', '曝光数', '曝光量', '曝光', '样本量', '人数', '用户数', 'uv', '访问量', '流量', 'impressions', 'users', 'sample', 'n', '进组人数'],
  conversions: ['conversions', 'conversion', '转化数', '转化人数', '转化量', '转化', '支付数', '支付人数', '下单数', '成交数', '成功数', 'converted', 'cnt', '进组转化'],
  refunds: ['refunds', 'refund', '退款数', '退款量', '退款', '退单数', '退单'],
  complaints: ['complaints', 'complaint', '投诉数', '投诉量', '投诉', '客诉数', '客诉'],
  latencyP95: ['latencyp95', 'latency_p95', 'p95', 'p95延迟', '延迟', '响应时间', '首屏时间', 'latency', 'rt', '耗时'],
  revenue: ['revenue', '收入', '金额', 'gmv', '营收', '销售额', '成交金额', '支付金额', '流水'],
  preExposures: ['preexposures', 'pre_exposures', '实验前曝光', '前窗口曝光', '前置曝光', 'pre曝光'],
  preConversions: ['preconversions', 'pre_conversions', '实验前转化', '前窗口转化', '前置转化', 'pre转化'],
  preRevenue: ['prerevenue', 'pre_revenue', '实验前收入', '前窗口收入', '前置收入', 'pre收入'],
  name: ['name', '实验名称', '实验名', '名称', '标题', 'title', '实验标题', '实验描述'],
  primaryMetric: ['primarymetric', 'primary_metric', '主指标', '核心指标', '主指标名', '指标名'],
  metricType: ['metrictype', 'metric_type', '指标类型', '指标口径', '类型'],
  trafficSplit: ['trafficsplit', 'traffic_split', '分流比例', '分流比', '流量比例', '流量分配', '分流', 'split', 'allocation'],
};

/** 全角转半角 + 小写 + 去掉分隔符与括号注释 */
export function normalizeHeader(raw: string): string {
  return String(raw ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .toLowerCase()
    // 括号里的内容通常是单位或注释：「曝光数（人）」「收入(元)」
    .replace(/[（(\[【][^）)\]】]*[）)\]】]/g, '')
    .replace(/[\s_\-./·:：]/g, '')
    .trim();
}

/** 单个表头对某字段的匹配分：0 = 不匹配 */
function scoreOne(header: string, key: FieldKey): number {
  const norm = normalizeHeader(header);
  if (!norm) return 0;
  for (const alias of ALIASES[key]) {
    const a = normalizeHeader(alias);
    if (!a) continue;
    if (norm === a) return 100;
  }
  // 包含匹配只对长度 ≥3 的别名开放：`n` `os` `rt` 这种短别名一旦放开包含匹配，
  // 会把 `national` 认成曝光数、把 `cost` 认成设备
  let best = 0;
  for (const alias of ALIASES[key]) {
    const a = normalizeHeader(alias);
    if (a.length < 3) continue;
    if (norm.includes(a) || a.includes(norm)) best = Math.max(best, 60);
  }
  return best;
}

export interface Detection {
  /** 字段 → 表头下标（-1 表示没识别到） */
  mapping: Record<FieldKey, number>;
  /** 识别得分，UI 用来说明「这一列是猜的」 */
  scores: Record<FieldKey, number>;
  /** 表头里没有被任何字段认领的列下标 */
  unmatched: number[];
  missingRequired: FieldKey[];
}

/**
 * 识别表头。
 * - 每个字段取分数最高的列；同分取**更靠左**的那列（用户习惯把主键放最前）
 * - 每个列最多被认领一次
 * - 分数 < 100 的识别会在 UI 里标成「猜测」，让用户确认
 */
export function detectColumns(header: string[]): Detection {
  const mapping = {} as Record<FieldKey, number>;
  const scores = {} as Record<FieldKey, number>;
  const taken = new Set<number>();
  const ordered = [...FIELDS].sort((a, b) => Number(b.required) - Number(a.required));

  /**
   * 两阶段识别，顺序很重要：
   * 先让所有字段做**精确**命中，再做包含匹配。
   *
   * 反例（真实踩过）：表里只有 `preExposures` 一列，如果按字段顺序逐个匹配，
   * `exposures` 的包含匹配会先把这一列抢走，`preExposures` 精确命中时已经没位置了——
   * 于是 CUPED 的前窗口分母被当成当期的曝光数，方差削减算出来是错的，而且没人看得出来。
   */
  for (const exact of [true, false]) {
    for (const f of ordered) {
      if (mapping[f.key] !== undefined) continue;
      let bestIdx = -1;
      let bestScore = 0;
      header.forEach((h, i) => {
        if (taken.has(i)) return;
        const s = scoreOne(h, f.key);
        if (exact ? s !== 100 : s === 100 || s === 0) return;
        if (s > bestScore) {
          bestScore = s;
          bestIdx = i;
        }
      });
      if (bestIdx >= 0) {
        mapping[f.key] = bestIdx;
        scores[f.key] = bestScore;
        taken.add(bestIdx);
      }
    }
  }
  // 两轮都没认领的字段补上 -1，保证 mapping 覆盖全部 FieldKey
  for (const f of FIELDS) {
    if (mapping[f.key] === undefined) {
      mapping[f.key] = -1;
      scores[f.key] = 0;
    }
  }

  const unmatched: number[] = [];
  header.forEach((_, i) => {
    if (!taken.has(i)) unmatched.push(i);
  });

  return {
    mapping,
    scores,
    unmatched,
    missingRequired: REQUIRED_FIELDS.filter((k) => mapping[k] < 0),
  };
}

/** 给定一份明细表，判断它像不像「已经聚合好的日级明细」（而不是原始事件流水） */
export function looksLikeDailyTable(header: string[]): boolean {
  const d = detectColumns(header);
  return d.missingRequired.length === 0;
}
