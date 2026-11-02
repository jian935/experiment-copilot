/**
 * 巡检（inspection）任务的数据结构。
 *
 * 为什么把它们与 `AgentCtx` 分开：现有 16 个工具全部绑定**单个实验**
 * （`AgentCtx.exp` 与 `ctx.analysis` 必填），而巡检是跨实验的。
 * 与其把 `exp?` 改成可选、让 16 个工具的调用点都要处理 undefined（那是给旧代码埋雷），
 * 不如新增一层「任务上下文」，让工具各管各的：单实验工具照旧，巡检走自己的编排。
 */
import type { Decision } from '../types.ts';

/** 风险等级。语义是「谁该处理、什么时候处理」，不是「分数高低」 */
export type RiskLevel = 'critical' | 'warn' | 'info' | 'ok';

/**
 * 信号代码。每个都对应引擎里一个**已有的**判定或诊断，巡检只是把它们翻译成
 * 「这件事要不要人管」——不引入任何新统计口径。
 */
export type SignalCode =
  /** 分流坏了：这批数据不能用 */
  | 'srm_broken'
  /** 一个实验声明了但一行数据都没有：可能是埋点没上 */
  | 'no_data'
  /** 拦截型护栏确认恶化 */
  | 'guardrail_worse'
  /** 主指标显著为负 */
  | 'sig_negative'
  /** 效应随人群变化（定向上线） */
  | 'heterogeneous'
  /**
   * 统计显著，但幅度小于业务门槛。
   *
   * 这是「样本一大 p 就显著」的直接后果，也是巡检最容易被误判的一类：
   * 界面上 p=0.042，读者以为有结论了，实际幅度只有 0.01pp。
   * 它既不是坏消息（不该让人去停），也不是好消息（不该上线）。
   */
  | 'trivial_effect'
  /** 稳健性诊断判「敏感/翻转」：结论靠少数行 */
  | 'fragile'
  /** naive 显著但 OBF 不显著：这个显著可能是反复看出来的 */
  | 'peeking_risk'
  /** 数据已经 N 天没有新增，但实验还在跑 */
  | 'stale_data'
  /** 测不出，但补样本可行（MDE 只是业务效应的 1~2.5 倍）：不是「没效果」 */
  | 'underpowered'
  /**
   * 设计不足：MDE 是业务效应的 2.5 倍以上。
   *
   * 与 underpowered 分开是必须的：补 16 倍样本不是建议，是劝人放弃。
   * 这一类的正确说法是「这个实验按现在的规模回答不了这个问题」，
   * 所以它不加分（归「无需动作」），但要在报告里作为一个集体事实单独说。
   */
  | 'design_insufficient'
  /** 显著为正，等你拍板 */
  | 'sig_positive'
  /** 排除了业务关心的效应量：确实没效果 */
  | 'no_effect_confident';

export interface RiskSignal {
  code: SignalCode;
  label: string;
  /** 打分权重。0 表示「只陈述事实，不加分」（例如「确实没效果」） */
  weight: number;
  detail: string;
  /** 当前实验的证据编号（E1..E14），UI 可直接跳到证据抽屉 */
  cites: string[];
}

export type NextActionKind =
  | 'fix-traffic'
  | 'instrument'
  | 'hold'
  | 'ship'
  | 'collect-more'
  | 'iterate'
  | 'review';

export interface NextAction {
  kind: NextActionKind;
  /** 短标签，清单里直接显示 */
  label: string;
  /** 具体要做什么，带数字 */
  detail: string;
  /**
   * 「补样本」时给出的解析估算。用解析式而非蒙特卡洛，见 `inspection.ts` 的注释。
   * 算不出来时字段为 null，**不要填 0**。
   */
  forecast?: { nPerArm: number | null; days: number | null; note: string };
}

export interface InspectionItem {
  expId: string;
  name: string;
  primaryMetric: string;
  decision: Decision;
  reasonCode: string;
  risk: RiskLevel;
  score: number;
  /** 一句话：它为什么在这个位置。清单里只显示这一句 */
  why: string;
  signals: RiskSignal[];
  next: NextAction;
  rowCount: number;
  /** 该实验自己最后一天的数据日期（不是数据集的） */
  lastDate: string | null;
  /** 相对「巡检基准日」过去了几天 */
  daysSinceLastData: number | null;
}

export interface InspectionTotals {
  experiments: number;
  rows: number;
  /** 有数据的实验数 */
  withData: number;
  critical: number;
  warn: number;
  info: number;
  ok: number;
  /** 按引擎决策分布 */
  byDecision: Record<Decision, number>;
}

/**
 * 样本量现状的集体事实。
 *
 * 单个实验的「测不出」是个人问题，50 个实验同时测不出就是**设计问题**：
 * 它说明这批实验的规模与业务关心的效应量根本不匹配。
 * 这件事必须单独报一次，而不是在 50 条清单里各说一遍——
 * 后者的效果是让人逐条去「补样本」，而那是做不到的。
 */
export interface PowerSummary {
  /** 不显著的实验数（分子） */
  inconclusive: number;
  /** 其中「设计不足」的数量 */
  insufficient: number;
  /** 其中「补样本可行」的数量 */
  fixable: number;
  /** 业务声明的效应量（绝对单位取中位数，单位随主指标不同，仅作量级参考） */
  materialityRel: number;
  /** 这批实验当前能检出的最小**相对**效应的中位数（0.09 = 9%） */
  medianMdeRel: number | null;
  /** 要检出业务效应量，样本量需要放大的倍数的中位数 */
  medianNMultiple: number | null;
}

export interface InspectionReport {
  /** 巡检基准日 = 数据集里最晚的一天（不是系统时间，见 inspection.ts） */
  asOf: string;
  generatedAt: string;
  totals: InspectionTotals;
  /** 已按（风险等级, 分数降序, id）排序 */
  items: InspectionItem[];
  /**
   * 第一屏：今天只看这几件。
   * 规则：critical 全部（上限 5，超出则改为报「系统性问题」）+ warn 前 2。
   */
  mustLook: InspectionItem[];
  /** critical 超过上限时的系统性问题提示；否则 null */
  systemic: string | null;
  /** 这份报告回答什么、不回答什么 */
  scope: string[];
  /** 样本量现状（集体事实，见 PowerSummary 注释） */
  power: PowerSummary;
  /** 评测用：结构化摘要（不含长文本），便于逐位比对基线 */
  digest: InspectionDigest;
}

/**
 * 巡检的机器可读摘要。
 *
 * 为什么要单独给一份而不是让评测去解析 `items`：
 * 评测要的是**稳定的数字**（排序质量、拒答次数、证据深度），
 * 而 `items` 里有大量文案，文案一改基线就红——那会把评测变成「文案快照」，
 * 于是没人敢改文案，最后大家开始改断言。数字与文案必须分开。
 */
export interface InspectionDigest {
  /** 必须看的前 N 个（按排序） */
  mustLookIds: string[];
  /** 各等级的实验 id（升序，便于逐位比对） */
  criticalIds: string[];
  warnIds: string[];
  infoIds: string[];
  okIds: string[];
  /** 被判成「测不出、但补样本可行」的实验数 */
  underpowered: number;
  /** 被判成「设计不足」的实验数 */
  designInsufficient: number;
  /** 被判成「确实没效果」的实验数 */
  noEffectConfident: number;
  /**
   * 硬给结论的次数。定义：引擎判 inconclusive，但信号里出现了
   * sig_positive / sig_negative / heterogeneous 这类「有方向」的结论。
   * 这是巡检最该为 0 的数字。
   */
  hardVerdictsOnInconclusive: number;
  /** 每条结论的平均证据引用数 */
  evidencePerItem: number;
  /** 总证据引用数 */
  evidenceCites: number;
}

/** 巡检参数。全部显式声明，不藏在代码里 */
export interface InspectionOptions {
  /**
   * 业务关心的最小效应（**绝对**单位：率口径是百分点，连续口径是元）。
   * 这是**业务声明**，不是统计默认值——它决定「测不出」和「确实没效果」的分界。
   */
  materiality?: number;
  /** critical 超过这个数就判「系统性问题」 */
  criticalLimit?: number;
  /** 超过几天没有新数据算停滞 */
  staleDays?: number;
  /** 功效口径（用于解析估算「还要多少人」） */
  power?: number;
  alpha?: number;
}
