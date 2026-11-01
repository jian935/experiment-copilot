/**
 * 口径字典：所有指标的定义、方向、单位、计算式集中在这里。
 *
 * 为什么要有这一层：
 * 1. 指标以前是散落在代码里的中文字符串（'支付转化率' / '退款率'），
 *    Agent 想引用什么口径全凭模型发挥，引擎也无从校验——「Agent 不能自创口径」就没有落点。
 * 2. 护栏的 margin、方向（越大越好还是越差）必须和指标绑定，
 *    否则「退款率 +0.4pp 算恶化」和「转化率 +0.4pp 算改善」会混在一起。
 *
 * 纪律：只有这里登记过的指标才允许出现在结论、证据链和 Agent 回答里。
 */

export type MetricDirection = 'higher_better' | 'lower_better';
export type MetricKind = 'rate' | 'continuous' | 'quantile';

export interface MetricDef {
  /** 唯一键（英文，代码与配置里用） */
  key: string;
  /** 展示名（中文） */
  label: string;
  /** 指标类型：率 / 连续值 / 分位数 */
  kind: MetricKind;
  /** 方向：越大越好（主指标）还是越大越差（护栏） */
  direction: MetricDirection;
  /** 单位：pp（百分点）/ ms / 元 */
  unit: string;
  /** 计算式——必须能照着复算，不能是描述性文字 */
  formula: string;
  /** 数据源（DailyRow 上的字段） */
  source: string;
  /** 作为护栏时的默认容忍度（该指标的单位下）；不参与护栏的指标为 null */
  guardrailMargin: number | null;
  /** 统计方法（决定用什么检验） */
  method: string;
  /** 坑与注意事项 */
  note?: string;
}

export const METRIC_DEFS: MetricDef[] = [
  {
    key: 'conversion_rate',
    label: '支付转化率',
    kind: 'rate',
    direction: 'higher_better',
    unit: 'pp',
    formula: 'conversions / exposures',
    source: 'DailyRow.conversions / DailyRow.exposures',
    guardrailMargin: null,
    method: '两比例 z 检验（合并方差）+ Newcombe 差值 95% CI + BH 分层校正',
    note: '主指标。分层扫描（新老 / 设备）只在维度内做 BH，不做跨维度 FWER。',
  },
  {
    key: 'refund_rate',
    label: '退款率',
    kind: 'rate',
    direction: 'lower_better',
    unit: 'pp',
    formula: 'refunds / exposures',
    source: 'DailyRow.refunds / DailyRow.exposures',
    guardrailMargin: 0.004,
    method: '非劣检验（margin = 0.4pp，单侧 α = 0.005，非合并方差）',
    note: '唯一参与决策拦截的硬护栏。基线约 1.2%，+0.4pp 相当于相对 +33%。',
  },
  {
    key: 'complaint_rate',
    label: '投诉率',
    kind: 'rate',
    direction: 'lower_better',
    unit: 'pp',
    formula: 'complaints / exposures',
    source: 'DailyRow.complaints / DailyRow.exposures',
    guardrailMargin: 0,
    method: '非劣检验（margin = 0，单侧 α = 0.005）',
    note: '基数极低（0.12%），SE 与基线同量级 → 只提示、不拦截，避免噪声被当成结论。',
  },
  {
    key: 'latency_p95',
    label: 'P95 延迟',
    kind: 'quantile',
    direction: 'lower_better',
    unit: 'ms',
    formula: 'Σ(P95 × exposures) / Σ exposures（按曝光加权）',
    source: 'DailyRow.latencyP95（按 DailyRow.exposures 加权）',
    guardrailMargin: 0.05,
    method: '两样本 Bootstrap（BCa，10k 次，固定种子）+ 百分位检验',
    note: '分位数指标没有闭式检验，只能重抽样；容忍度用相对 +5%，因为不同接口基线差异极大。',
  },
  {
    key: 'arpu',
    label: 'ARPU',
    kind: 'continuous',
    direction: 'higher_better',
    unit: '元',
    formula: 'Σrevenue / Σexposures（每曝光收入，元）',
    source: 'DailyRow.revenue / DailyRow.exposures',
    guardrailMargin: null,
    method: '比值指标 delta method（格子级聚类方差，Welch–Satterthwaite 自由度）+ t 检验',
    note:
      'ARPU = 转化率 × 客单价，两个因子可以反向移动（打折拉量：转化率↑、客单价↓），' +
      '所以必须做因子分解，不能只看总量是涨了还是跌了。收入方差不由均值决定（不像比例），' +
      '因此不能套 p(1−p)/n；无单位级明细时用格子级聚类方差，区间偏保守。',
  },
];

const BY_KEY = new Map(METRIC_DEFS.map((m) => [m.key, m]));
const BY_LABEL = new Map(METRIC_DEFS.map((m) => [m.label, m]));

export const METRIC_KEYS: string[] = METRIC_DEFS.map((m) => m.key);
export const METRIC_LABELS: string[] = METRIC_DEFS.map((m) => m.label);

export function metricByKey(key: string): MetricDef | undefined {
  return BY_KEY.get(key);
}

export function metricByLabel(label: string): MetricDef | undefined {
  return BY_LABEL.get(label);
}

/** 参与决策拦截的护栏指标 */
export const GATING_METRICS: MetricDef[] = METRIC_DEFS.filter((m) => m.direction === 'lower_better');

/**
 * 在一段文本里找出被提到的指标（按中文标签匹配，长标签优先避免前缀误命中）。
 * Agent 回答与问题解析都用它来确认"说的是哪个口径"。
 */
export function findMetrics(text: string): MetricDef[] {
  const sorted = METRIC_DEFS.slice().sort((a, b) => b.label.length - a.label.length);
  const out: MetricDef[] = [];
  let rest = text;
  for (const m of sorted) {
    if (rest.includes(m.label)) {
      out.push(m);
      rest = rest.split(m.label).join('');
    }
  }
  return out;
}

/** 归一化：把「方向」翻译成人话，避免 UI 里出现 lower_better 这种内部字段 */
export function directionLabel(m: MetricDef): string {
  return m.direction === 'higher_better' ? '越大越好' : '越小越好';
}

/** 单位化展示：pp 用百分点，ms 原样 */
export function fmtMetricValue(m: MetricDef, v: number): string {
  if (m.unit === 'pp') return `${(v * 100).toFixed(2)}%`;
  if (m.unit === 'ms') return `${v.toFixed(0)}ms`;
  return `${v.toFixed(3)}${m.unit}`;
}
