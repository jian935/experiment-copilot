/**
 * 期望损失决策（B1）。
 *
 * 频率派给的是「显不显著」，业务要的是「该不该上」。这两件事不一样：
 * 一个 p=0.19、点估计 +0.4pp 的实验，"不显著"和"上了没用"完全是两个意思；
 * 一个 p<0.001、点估计 +0.05pp 的实验，"显著"也可能是"上了不划算"。
 *
 * 决策论表述（两个参数就够了，都能让 PM 自己声明）：
 *
 *   Δ 的真实后验 ≈ Normal(Δ̂, SE²)          ← 直接用引擎的差值 + 标准误，不另造口径
 *   上网价值 V(上线 | Δ)   = max(0, Δ) − k·max(0, −Δ) − MMP
 *   上网价值 V(不上线 | Δ) = 0
 *
 *   ⇒ E[V(上线)] = E[max(0,Δ)] − k·E[max(0,−Δ)] − MMP
 *   ⇒ **建议上线 ⟺ E[V(上线)] > 0**
 *
 * 两个参数：
 *   - **MMP（minimum meaningful payoff）**：小到这个程度以下的提升不值得上线
 *     （发布/返工/维护/后续实验的复杂度，折算成同样的效应单位）。默认 0.1pp / 0.02 元。
 *   - **k（风险厌恶）**：1 单位负向效应按 k 单位代价计。默认 2——
 *     上一个有害改动要赔 2 倍，因为除了业务量还有返工和信任。
 *
 * **必须公开的一条性质**：k = 1 时
 *   E[max(0,Δ)] − E[max(0,−Δ)] ≡ Δ̂（恒等）
 *   于是规则退化成「点估计 > MMP 就上线」。
 * 也就是说这个工具的价值全在 **k > 1 与 MMP > 0**，不在数学花哨。参数必须摆在页面上。
 *
 * ⚠️ **这套价值函数只记主指标的账**。护栏指标（退款率、投诉率、延迟）恶化是另一种货币，
 * 没有汇率就不该塞进同一个 E[V] 里做加减——那样等于悄悄给"退款翻倍"标了个价。
 * 所以本模块分两层：
 *
 *   第 1 层 硬门禁（applyGates）：SRM / 护栏拦 / 已确认负向 / 效应异质 → 直接否决，
 *           不论净价值多少。这与 Booking/Netflix 一类平台的「护栏是约束不是目标」一致。
 *   第 2 层 净价值（expectedLoss）：只在门禁放行后，回答"这批主指标收益值不值得一次发布"。
 *
 * 拿掉第 1 层的裸规则会被如实报出来做对照（见 scripts/loss_report.ts），
 * 它会为了主指标收益去上线一个退款率翻倍的实验——那不是"更激进"，是"漏账"。
 *
 * 纪律：与 heterogeneity / sequential / novelty 一样**不参与 decision**——
 * decision 的口径由历史 120 条真值标注对账，改口径就得重标。
 * 这里只回答"在你声明的成本下，两种动作各值多少"，并给出等价点与净价值。
 */

import { normalCdf } from './stats.ts';

export interface LossParams {
  /** 风险厌恶：1 单位负向效应按多少单位代价计（≥1） */
  riskAversion: number;
  /** 最小值得上线的提升（效应单位：pp 或 元） */
  mmp: number;
}

/**
 * 默认参数与理由（必须显示在 UI 上，不能藏成"引擎的默认值"）：
 *   - riskAversion = 2：上一个有害改动的代价 = 漏掉等量收益的 2 倍
 *   - mmp 按指标单位给：率指标 0.1pp（转化率 4–5% 的量级下，0.1pp ≈ 2% 相对提升，
 *     再小就是噪声级改动，不值得一次发布）；ARPU 0.02 元（客单价 55–95 元、ARPU 约 4 元）
 * 这些是**产品判断，不是统计结论**——所以参数可调，结论必须连带参数一起显示。
 */
export function defaultLoss(unit: 'pp' | '元'): LossParams {
  return { riskAversion: 2, mmp: unit === '元' ? 0.02 : 0.001 };
}

export type LossAction = 'ship' | 'no-ship' | 'indistinguishable';

export interface LossDecision {
  diff: number;
  se: number;
  unit: 'pp' | '元';
  params: LossParams;
  /** E[max(0, Δ)]：上线能拿到的期望收益（不算风险） */
  eGain: number;
  /** E[max(0, −Δ)]：上线要冒的期望损失（乘上 k 才是代价） */
  eHarm: number;
  /** 净价值 = 期望收益 − k·期望损失 */
  netValue: number;
  /** 扣掉 MMP 之后的净价值（>0 就建议上线） */
  netAfterMmp: number;
  action: LossAction;
  /** 等价点：真实效应等于它时，上线的净价值刚好等于 MMP */
  breakEvenDiff: number;
  /** 点估计离等价点有几个标准误 */
  breakEvenGapSe: number;
  /** k = 1 时的等价点（= MMP），用来给读者对账「不厌恶风险时门槛在哪」 */
  breakEvenIfNeutral: number;
}

/** E[max(0, −Δ)]，Δ ~ N(mu, sd²) */
export function expNegPart(mu: number, sd: number): number {
  if (!(sd > 0)) return Math.max(0, -mu);
  const a = mu / sd;
  return (sd * Math.exp(-0.5 * a * a)) / Math.sqrt(2 * Math.PI) - mu * normalCdf(-a);
}

/** E[max(0, Δ)] */
export function expPosPart(mu: number, sd: number): number {
  if (!(sd > 0)) return Math.max(0, mu);
  const a = mu / sd;
  return (sd * Math.exp(-0.5 * a * a)) / Math.sqrt(2 * Math.PI) + mu * normalCdf(a);
}

/** 净价值（未扣 MMP）：关于 mu 严格单调递增，二分可解等价点 */
export function netValueAt(mu: number, se: number, k: number): number {
  return expPosPart(mu, se) - k * expNegPart(mu, se);
}

/** 解「净价值 = MMP」对应的真实效应 */
export function breakEven(params: LossParams, se: number): number {
  const { riskAversion: k, mmp } = params;
  const f = (mu: number) => netValueAt(mu, se, k) - mmp;
  // k=1 时恒等为 mu − mmp，闭式；其余情形二分
  if (Math.abs(k - 1) < 1e-12) return mmp;
  let lo = -Math.max(20 * se, 1) - Math.abs(mmp) - 1;
  let hi = Math.max(20 * se, 1) + Math.abs(mmp) + 1;
  if (f(lo) > 0) return lo;
  if (f(hi) < 0) return hi;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < 0) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-12) break;
  }
  return (lo + hi) / 2;
}

export function expectedLoss(
  diff: number,
  se: number,
  unit: 'pp' | '元',
  params: LossParams = defaultLoss(unit),
): LossDecision {
  const { riskAversion: k, mmp } = params;
  const eGain = expPosPart(diff, se);
  const eHarm = expNegPart(diff, se);
  const net = eGain - k * eHarm;
  const netAfterMmp = net - mmp;
  // 无差别区间：净价值的绝对值小于 MMP 的 10% 时，说"分不出高下"比硬给一个方向更诚实
  const band = Math.max(mmp * 0.1, 1e-15);
  const action: LossAction = Math.abs(netAfterMmp) < band ? 'indistinguishable' : netAfterMmp > 0 ? 'ship' : 'no-ship';
  const be = breakEven(params, se);
  return {
    diff,
    se,
    unit,
    params,
    eGain,
    eHarm,
    netValue: net,
    netAfterMmp,
    action,
    breakEvenDiff: be,
    breakEvenGapSe: se > 0 ? (diff - be) / se : 0,
    breakEvenIfNeutral: mmp,
  };
}

/* ────────────────────────── 第 1 层：硬门禁 ────────────────────────── */

/**
 * **硬门禁**：会被直接否决的 reasonCode。三条都是「净价值算不出来或不该算」的情形。
 *
 * 这里的 key 直接沿用引擎的 `Analysis['reasonCode']`，但用字符串而不是 import 那个类型：
 * 决策层不该反向依赖 analyze()，否则以后想拿这层去评别家的实验就带不走。
 */
export const LOSS_GATES: Record<string, string> = {
  SRM: '分流比例失衡，样本本身不可信——差值不是效应',
  GUARDRAIL: '护栏指标已恶化，属另一套货币，不能拿主指标收益来抵',
  NEGATIVE: '已确认负向，净价值无须再算',
};

/**
 * **建议（不否决）**：这些情形下净价值仍然算得出来，只是池化口径会稀释结论。
 *
 * 为什么 heterogenous 不能被当成门禁：它的整体效应是**真的正的**（只是集中在某一人群），
 * 把它判成"不上线"等于白扔那部分真实收益。正确的动作是"上线但限定人群"，
 * 所以这里给的是附加说明，让决策层去补 targeting，而不是替它做决定。
 */
export const LOSS_CAUTIONS: Record<string, string> = {
  HETEROGENEOUS: '效应集中在部分人群——整体上线的收益会被稀释，建议只对有效人群上线',
};

export interface GatedDecision {
  /** 最终建议动作 */
  action: LossAction;
  /** 净价值层自己算出来的动作（门禁之前） */
  rawAction: LossAction;
  /** 是否被门禁改写 */
  vetoed: boolean;
  /** 改写它的 reasonCode（未改写则为 null） */
  vetoCode: string | null;
  vetoReason: string | null;
  /** 不否决但必须随结论一起显示的建议（如异质 → 限定人群） */
  cautionCode: string | null;
  caution: string | null;
}

/**
 * 两层合并：硬门禁否决优先，其余交给净价值；异质只加建议。
 *
 * 关键点：门禁否决不区分"netValue 多大"——这正是"约束而非目标"的含义。
 * 一旦允许用主指标收益去抵护栏恶化，门槛就变成了"退款率翻倍能换多少转化"，
 * 那个汇率没人真敢拍，拍出来的数也不该假装是算出来的。
 */
export function applyGates(raw: LossAction, reasonCode: string | null | undefined): GatedDecision {
  const code = reasonCode ?? null;
  const vetoReason = code ? LOSS_GATES[code] : undefined;
  const caution = code ? LOSS_CAUTIONS[code] : undefined;
  const base = {
    rawAction: raw,
    cautionCode: caution ? code : null,
    caution: caution ?? null,
  };
  if (code && vetoReason && raw !== 'no-ship') {
    return { ...base, action: 'no-ship', vetoed: true, vetoCode: code, vetoReason };
  }
  return { ...base, action: raw, vetoed: false, vetoCode: null, vetoReason: null };
}


