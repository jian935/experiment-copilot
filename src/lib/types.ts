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
  metricType: 'binary';
  guardrailMetrics: string[];
  archetype: Archetype;
  /** 注入的真实效应（绝对提升，pp 的小数形式；0.022 = +2.2pp） */
  trueLift: number;
  trueLiftScope: 'overall' | 'new_users';
  /** 整体真实效应（异质实验时与 trueLift 不同） */
  trueLiftOverall: number;
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
