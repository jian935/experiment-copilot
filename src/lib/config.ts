/**
 * 决策口径的单一来源。
 *
 * 以前 α、护栏阈值、SRM 阈值都散落在 decide.ts / stats.ts 的调用处硬编码，
 * 于是「把 α 改成 0.01 会怎样」只能靠改代码验证，也没法在界面上暴露。
 * 这里集中成一份可读、可改、可传给 analyze() 的配置；设置页（M9）直接绑它。
 *
 * 纪律：任何判定阈值都只能在这里定义。别处出现魔数即为 bug。
 */

import type { GuardrailMode } from './stats.ts';

/**
 * 单个护栏的规格。margin 统一写在「该指标自己的单位」下：
 * 率类指标是绝对百分点（0.004 = 0.4pp），延迟类是相对比例（relative: true，0.05 = +5%）。
 * 形状统一，避免调用处到处判断用哪个字段。
 */
export interface GuardrailSpec {
  margin: number;
  alpha: number;
  gating: boolean;
  mode: GuardrailMode;
  /** true 时 margin 按 control 的相对比例解释 */
  relative?: boolean;
}

export interface DecisionConfig {
  /** 主指标显著性水平（双侧） */
  alpha: number;
  /** 分层扫描的 BH FDR 水平 */
  segmentFdr: number;
  /** 交互（效应异质）判定的 p 阈值 */
  interactionAlpha: number;
  /**
   * 新颖效应（效应衰减）判定的 p 阈值。
   * 与 interactionAlpha 同量级但独立：衰减是「时间维度」的异质，不是人群维度的。
   */
  noveltyAlpha: number;

  /** SRM：卡方 p 阈值 */
  srmAlpha: number;
  /** SRM：相对偏差阈值（大样本下 p 值过度敏感，必须配实际阈值） */
  srmMaxRelImb: number;

  /**
   * 护栏：每个指标允许的最大恶化（绝对比例单位）、单侧 α、是否拦截决策、判定口径。
   * margin 是业务容忍度，不是统计默认值——所以必须由业务声明，而不是藏在代码里。
   * mode 决定"什么情况下算拦"，三种都是正式检验，严度不同（见 stats::GuardrailMode）。
   */
  guardrails: {
    refundRate: GuardrailSpec;
    complaintRate: GuardrailSpec;
    /** 延迟类指标用相对门槛（relative: true → margin 读作比例），因为不同接口基线差异极大 */
    latencyP95: GuardrailSpec;
  };

  /**
   * 主指标标准误的口径：
   * - 'robust'：从格子间离散程度估（不假设 i.i.d.）。真实数据普遍过离散，
   *   用 i.i.d. 二项式标准误会系统性偏乐观（实测把率口径 A/A 误报率推到 9.70%）。默认用它。
   * - 'iid'：经典 p(1−p)/n。只在确认没有格子级基线漂移时才成立，主要用于对照演示。
   */
  seMode?: 'robust' | 'iid';

  /**
   * 有前周期数据时，主指标是否走 CUPED（方差缩减）口径。
   * 注意它的收益是「方差缩减」，不是「修误报率」——修误报率靠 seMode=robust。
   * 这两件事必须分开讲，否则把稳健标准误的功劳算到 CUPED 头上。
   */
  useCuped?: boolean;

  /**
   * 数据里整列缺失、因此无法评估的护栏（由导入器填，内置数据为空）。
   *
   * 为什么不用「填 0 然后照常算」：那会让护栏显示「0.00% → 0.00%，未恶化」，
   * 读者会以为「查过了，没问题」，实际是**没数据**。缺数据必须显示成缺数据。
   */
  missingGuardrails?: Array<'refunds' | 'complaints' | 'latencyP95'>;

  /** Bootstrap 重抽样次数（蓝图 §8 要求 10k） */
  bootstrapReps: number;
  /** 蒙特卡洛 / Bootstrap 的固定种子：保证结论可复现 */
  simSeed: number;
}

export const DEFAULT_CONFIG: DecisionConfig = {
  alpha: 0.05,
  segmentFdr: 0.1,
  interactionAlpha: 0.01,
  noveltyAlpha: 0.05,

  srmAlpha: 0.001,
  srmMaxRelImb: 0.02,

  guardrails: {
    // 退款率基线约 1.2%，容忍 +0.4pp（相对 +33%）以内算"没实质恶化"。
    // 单侧 α=0.005 等价于旧口径的「双侧 p < 0.01」，且与护栏"只关心变差"的方向一致。
    //
    // 为什么 mode 默认是 harm_and_practical 而不是更严的 confirm_beyond_margin：
    // 本数据集每臂约 2 万样本，退款率差值的 SE ≈ 0.126pp，要让"确认恶化超过 0.4pp"
    // 成立需要观测差值 > 0.4 + 2.576×0.126 ≈ 0.73pp；而注入的真实伤害是 0.8pp，
    // 于是最严口径会漏掉约 38% 的真实伤害（实测 guardrail 族一致率跌到 46.7%）。
    // 统计显著性 ∧ 实际显著性 这个合取口径在同一 α 下既有 0.5% 的误报率，
    // 又能保住 99% 的检出率——这是当前样本量下真正合适的口径，不是迁就准确率。
    refundRate: { margin: 0.004, alpha: 0.005, gating: true, mode: 'harm_and_practical' },
    // 投诉率基线 0.12%，基数太低：SE 与基线同量级，任何 margin 都会被噪声淹没，
    // 所以 margin=0 表示"任何在统计上确认的上升都要提示"，且只提示不拦截。
    complaintRate: { margin: 0, alpha: 0.005, gating: false, mode: 'harm_and_practical' },
    // 延迟：不同接口基线差异大，用相对 +5%；噪声大且与损失非线性，仍只展示不拦截。
    latencyP95: { margin: 0.05, alpha: 0.05, gating: false, mode: 'harm_and_practical', relative: true },
  },

  seMode: 'robust',
  useCuped: true,

  bootstrapReps: 10000,
  simSeed: 20261101,
};

/** 浅合并配置（设置页传部分覆盖，其余用默认） */
export function mergeConfig(patch?: Partial<DecisionConfig>): DecisionConfig {
  if (!patch) return DEFAULT_CONFIG;
  return {
    ...DEFAULT_CONFIG,
    ...patch,
    guardrails: {
      ...DEFAULT_CONFIG.guardrails,
      ...(patch.guardrails ?? {}),
    },
  };
}
