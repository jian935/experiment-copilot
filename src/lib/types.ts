export type Variant = 'control' | 'treatment';
export type Device = 'iOS' | 'Android';
export type Tenure = 'new' | 'old';
export type Decision = 'ship' | 'no-ship' | 'iterate' | 'inconclusive';
export type Archetype = 'null' | 'positive' | 'negative' | 'heterogeneous' | 'srm' | 'guardrail';

export interface DailyRow {
  expId: string;
  date: string;
  variant: Variant;
  device: Device;
  tenure: Tenure;
  exposures: number;
  conversions: number;
  refunds: number;
  complaints: number;
  latencyP95: number;
  /**
   * 该格子本期收入合计（元）。缺省表示这份数据只有转化口径，ARPU 相关能力自动关闭。
   * 存"总量"而不是"人均"：人均再乘回曝光会引入浮点误差，且总量才能与明细对账。
   */
  revenue?: number;
  /** 实验前同口径的曝光数（CUPED 协变量）。没有前周期数据时留空 → 自动退回普通检验 */
  preExposures?: number;
  /** 实验前同口径的转化数 */
  preConversions?: number;
  /** 实验前同口径的收入合计（ARPU 的 CUPED 协变量） */
  preRevenue?: number;
}

export interface Experiment {
  id: string;
  name: string;
  hypothesis: string;
  startDate: string;
  endDate: string;
  variants: Variant[];
  trafficSplit: string;
  primaryMetric: string;
  /**
   * 主指标类型：
   *   binary     = 转化率这类率指标（两比例 z 检验）
   *   continuous = ARPU 这类连续/比值指标（delta method + t 检验）
   * 两种口径的方差来源完全不同，所以决策引擎必须分开走，不能"统一成率"了事。
   */
  metricType: 'binary' | 'continuous';
  guardrailMetrics: string[];
  archetype: Archetype;
  /** 注入的真实效应（绝对提升，pp 的小数形式；0.022 = +2.2pp） */
  trueLift: number;
  trueLiftScope: 'overall' | 'new_users';
  /** 整体真实效应（异质实验时与 trueLift 不同） */
  trueLiftOverall: number;
  /** 收入口径的真实相对提升（ARPU 主指标时用于真值对照；由转化率效应换算） */
  trueRpuLift?: number;
  /** 真实决策（由参数决定，不是由样本数据决定） */
  trueDecision: Decision;
  seed: number;
}

export interface Dataset {
  generatedAt: string;
  seedBase: number;
  /** 是否为「已知真值」数据。合成数据 = true；用户导入的真实数据若无真值字段则为 false，
   *  此时评测看板（准确率/混淆/校准）与详情页「真值对比」不可用。 */
  groundTruth?: boolean;
  spec: {
    days: number;
    /** 前周期天数（CUPED 协变量窗口）；0 表示无前周期数据 */
    preDays?: number;
    /** 数据里注入的日级 / 设备级基线异质性（相对基线率的标准差，比例单位） */
    baselineDaySd?: number;
    baselineDeviceSd?: number;
    /** 客单价模型的三个参数：均值、对数标准差（订单金额的离散度）、格子级漂移（相对） */
    aovMean?: number;
    aovLogSd?: number;
    aovArmSd?: number;
    segments: string[];
    baselineRate: [number, number];
    refundRate: number;
    complaintRate: number;
    latencyMean: number;
    latencySd: number;
  };
  experiments: Experiment[];
  daily: DailyRow[];
}
