/**
 * 臂标识。两臂时代是 `'control' | 'treatment'`；A/B/n 之后是任意字符串
 * （'control' / 'treatment' / 'b2' / '实验组2' …），由 `lib/arms.ts` 负责
 * 「谁是对照、一共几臂、按什么顺序」的单一来源。
 *
 * 为什么不保留联合类型：臂名来自用户导入的表，枚举不完；写死会让第三臂在类型上就消失。
 */
export type Variant = string;
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
  /**
   * 任意维度切片（来自用户表里的其他字符串列）：`{ 渠道: '应用商店', 城市: '上海' }`。
   *
   * 为什么不把它们提成正式字段：维度的名字与个数完全由用户的表决定，
   * 枚举不完（渠道/城市/App版本/会员等级/活动ID…），写死任何一个都会让别的维度消失。
   * 内置数据不带这个字段——设备与新老用户已经是正式字段，另加「周内/周末」由日期推导，
   * 所以不导入数据也有三个维度可切（见 `lib/dimensions.ts`）。
   */
  dims?: Record<string, string>;
}

export interface Experiment {
  id: string;
  name: string;
  hypothesis: string;
  startDate: string;
  endDate: string;
  /** 全部臂（含对照），对照在前。两臂实验照旧写 ['control','treatment'] */
  variants: Variant[];
  /**
   * 对照臂的 id。缺省时用 'control'；若 variants 里没有 'control'，则取第一个。
   * 单独一个字段是为了支持「对照组叫 baseline / 版本A」的真实表。
   */
  controlArm?: string;
  /** 分流比例（与 variants 同序，总和不必为 1）。缺省时由 trafficSplit 解析，再退等分 */
  allocation?: number[];
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
  /**
   * 整列缺失的字段名（由导入器填，内置数据不填）。
   *
   * 为什么要记这一笔：`refunds` 缺失时归一化会填 0，于是护栏会显示
   * 「退款率 0.00% → 0.00%，未恶化」——**那是在证据链里编数字**，
   * 比不显示更糟。有了这个字段，下游可以把护栏标成「不可用」而不是「没恶化」。
   */
  missingColumns?: string[];
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
