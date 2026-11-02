/**
 * 巡检：给定一份数据，回答「今天该看哪几个实验、每个该做什么」。
 *
 * ## 为什么是确定性编排，而不是让模型自己循环
 *
 * 现有 LLM 工具循环硬上限 3 轮（`src/app/lib/llm.ts`），而一份 120 个实验的数据
 * 每个都要看 SRM/护栏/证据，3 轮连零头都跑不完。就算把上限提到 200，
 * 每轮都是网络往返（几十秒 + 一堆 token），而且**同一份数据跑两次会得到两份不同的周报**——
 * 那就不叫周报了，叫「今天模型心情如何」。
 *
 * 所以这里的形态是：**确定性扫描 + 可解释打分 + 固定限额**，产出结构化报告；
 * 语言组织是另一层（模板或 LLM），它改不了任何判断。这样：
 *   - 同一份数据 → 逐字节相同的报告（能进 CI 做基线）；
 *   - 每个分数都能手算核对（权重表就在下面）；
 *   - 模型只在「怎么说」上有自由，「说什么」没有。
 *
 * ## 打分口径（这张表就是全部规则，没有隐藏项）
 *
 * | 信号 | 权重 | 判据 | 为什么是这个量级 |
 * |---|---|---|---|
 * | 分流坏了 | 100 | `srm.flagged` | 数据不可用，后面所有结论都作废，必须最先看 |
 * | 一行数据都没有 | 55 | `rows === 0` | 一周白等，且「以为在跑」比「跑出错」更常见 |
 * | 护栏确认恶化 | 70 | 任一 gating 护栏 `worse` | 有明确坏消息 |
 * | 主指标显著为负 | 65 | `p < α ∧ diff < 0` | 同上 |
 * | 效应随人群变化 | 35 | `reasonCode === 'HETEROGENEOUS'` | 不是坏事，但不是全量上线 |
 * | 结论靠少数行 | 30 | `robustness.verdict` 为 sensitive/flip | 数字站不住，需要人判断 |
 * | 早停风险 | 20 | naive 显著但 OBF 不显著 | 这个显著可能是反复看出来的 |
 * | 数据停滞 | 25 | 最后一天距今 > staleDays 且实验还在跑 | 可能埋点断了 |
 * | 测不出 | 14 | MDE > 业务效应 | 不是「没效果」，是「不知道」 |
 * | 显著为正 | 10 | `p < α ∧ diff > 0` | 好消息，但仍要人拍板 |
 * | 确实没效果 | 0 | MDE ≤ 业务效应且不显著 | 不用管 |
 *
 * 权重的选择原则是**「不处理的代价」而不是「统计上的严重程度」**：
 * 一个 p=0.9 的负向实验也不值得占用周一早上，但它不会出现（p=0.9 就不显著了）；
 * 而一个分流坏了、效应看起来很漂亮的实验必须排在第一位，因为那组数字根本不能用。
 *
 * ## 「测不出」与「确实没效果」必须分开
 *
 * 这是巡检最值钱的一句话。两者在界面上都是「不显著」，但结论完全相反：
 *   - 能排除业务关心的效应 → 这个版本**真的没用**，可以收工；
 *   - 排不掉 → **不知道**，要么补样本，要么别下结论。
 * 把后者说成前者，就是「用不显著证明了没效果」——统计上最经典的错误。
 * 分界点用业务声明的 `materiality`（默认「相对提升 3%」），不是拍脑袋的常数。
 */
import {
  CRITICAL_LIMIT, INFRA_SYSTEMIC_MIN, INSPECTION_SCOPE, MATERIALITY_REL, N_RATIO_LIMIT,
  POWER_DEFAULT, STALE_DEFAULT,
} from './constants.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { controlArmOf } from '../arms.ts';
import type {
  InspectionDigest, InspectionItem, InspectionOptions, InspectionReport,
  NextAction, PowerSummary, RiskLevel, RiskSignal, SignalCode,
} from './types.ts';
import type { Analysis } from '../decide.ts';
import { normalInv } from '../stats.ts';
import type { Dataset, Decision, Experiment } from '../types.ts';

/** 打分表：唯一来源。改这里就是改全场 */
const WEIGHT: Record<SignalCode, number> = {
  srm_broken: 100,
  no_data: 55,
  guardrail_worse: 70,
  sig_negative: 65,
  heterogeneous: 35,
  // 显著但幅度小于业务门槛：比「效应异质」还容易被误判成可以上线，所以权重更高
  trivial_effect: 40,
  fragile: 30,
  peeking_risk: 20,
  stale_data: 25,
  underpowered: 14,
  // 0 分：设计不足会归进「无需动作」，但报告里会作为集体事实单独说一次
  design_insufficient: 0,
  sig_positive: 10,
  no_effect_confident: 0,
};

const LABEL: Record<SignalCode, string> = {
  srm_broken: '分流坏了',
  no_data: '一行数据都没有',
  guardrail_worse: '护栏确认恶化',
  sig_negative: '主指标显著为负',
  heterogeneous: '效应随人群变化',
  trivial_effect: '显著但幅度不够',
  fragile: '结论靠少数行',
  peeking_risk: '早停风险',
  stale_data: '数据停滞',
  underpowered: '测不出',
  design_insufficient: '设计不足',
  sig_positive: '显著为正',
  no_effect_confident: '确实没效果',
};

/**
 * 巡检的七个确定性步骤。UI 会把它显示出来——「它到底做了几步」不该靠嘴说，
 * 而应该能逐条对上代码。这里的顺序与 `runInspection` 的执行顺序一致。
 */
export const INSPECTION_STEPS = [
  '定位基准日：取数据里最晚的一天（不是系统时钟，否则每天跑出来的报告都不一样）',
  '逐实验读取引擎结论：复用缓存好的 Analysis，不重算、不改口径',
  '判数据可用性：分流异常 / 一行数据都没有 / 数据停滞',
  '判坏消息：护栏确认恶化 / 主指标显著为负',
  '判「测不出」还是「确实没效果」：MDE 对比业务声明的效应量',
  '排序与限额：分四个等级；第一屏按主导信号去重，同类只留一个代表',
  '判系统性问题：只有分流 / 埋点 / 停滞三类共用链路的信号集中出现才报',
  '生成下一步动作与证据引用：每条结论都指回引擎的证据编号',
] as const;

const RISK_RANK: Record<RiskLevel, number> = { critical: 0, warn: 1, info: 2, ok: 3 };

/**
 * 水平值（基线、当前的转化率）的写法。
 *
 * 与 `fmtMagnitude` 分开是必须的：差值的单位是 pp（百分点），水平的单位是 %。
 * 把 0.0617 印成「6.17pp」是错的——它是一段转化率 6.17%，不是一段差值。
 */
function fmtLevel(v: number, unit: 'pp' | '元'): string {
  if (!Number.isFinite(v)) return '—';
  return unit === 'pp' ? `${(v * 100).toFixed(2)}%` : `${v.toFixed(2)} 元`;
}

/** p 值的统一写法：NaN 写「—」，下溢写 <1e-16，很小用科学计数，否则三位小数 */
function formatP(p: number): string {
  if (!Number.isFinite(p)) return '—';
  if (p < 1e-16) return '<1e-16';
  if (p < 0.001) return p.toExponential(1);
  return p.toFixed(3);
}

function fmtMagnitude(v: number, unit: 'pp' | '元', digits = 2): string {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (unit === 'pp') {
    // diff 本身就是比例（0.0062 = 0.62pp），**不要再除 100**。
    // 第一版写成 (n/100).toFixed(2)，于是 0.62pp 印成 0.00pp——
    // 一个「0.00pp 却 p=0.042」的自相矛盾就是这样出现的。
    const pp = abs * 100;
    if (pp === 0 && abs > 0) return '<0.01pp';
    return `${pp.toFixed(digits)}pp`;
  }
  if (abs === 0 && v !== 0) return '<0.01 元';
  return `${abs.toFixed(digits)} 元`;
}

/**
 * 当前样本量下的最小可检出效应（MDE，双侧 α、给定功效）。
 *
 * MDE = (z_{1−α/2} + z_{power}) × SE。
 * 它的含义是「以现在的数据，多大的真实效应有 power 概率能被检出」。
 * 注意它**取决于当前样本量**，不是这个实验的设计 MDE——所以样本越多它越小。
 */
function mdeOf(se: number, alpha: number, power: number): number {
  if (!Number.isFinite(se) || se <= 0) return Infinity;
  return (normalInv(1 - alpha / 2) + normalInv(power)) * se;
}

/**
 * 「要检出 delta，还需要多少样本」。
 *
 * 推导（这一步可手算核对）：SE ∝ 1/√n，所以
 *   n′ / n = (SE′ / SE)² = (MDE / delta)²
 * 于是 n′ = n × (MDE / delta)²。它对率口径和连续口径都成立，
 * 因为它只用到「标准误随样本量以 1/√n 收缩」这一件事，不假设二项分布。
 *
 * 为什么不用 `forecast()` 的蒙特卡洛：巡检一次要跑 120 个实验，
 * 蒙特卡洛会给整份报告引入随机抖动，破坏「同一份数据永远同一份周报」。
 * 解析式的结果是确定的，而且公式可以印在界面上让人自己算。
 */
function neededN(n: number, mde: number, delta: number): number | null {
  if (!(mde > 0) || !(delta > 0) || !Number.isFinite(mde)) return null;
  const ratio = mde / delta;
  const need = n * ratio * ratio;
  return Number.isFinite(need) ? Math.ceil(need) : null;
}

/** 逐臂日均曝光（用于把「还要多少人」换成「还要几天」） */
function dailyRatePerArm(rows: Dataset['daily'], arms: number): number {
  if (!rows.length) return 0;
  const days = new Set(rows.map((r) => r.date)).size;
  const total = rows.reduce((s, r) => s + r.exposures, 0);
  if (days <= 0) return 0;
  return total / days / Math.max(1, arms);
}

function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86400000) : 0;
}

function signal(code: SignalCode, detail: string, cites: string[] = []): RiskSignal {
  return { code, label: LABEL[code], weight: WEIGHT[code], detail, cites };
}

/** 证据引用：只取与这条信号相关的 kind，避免「全引用一遍」把证据深度虚高 */
function citesOf(a: Analysis, kinds: Array<Analysis['evidence'][number]['kind']>): string[] {
  return a.evidence.filter((e) => kinds.includes(e.kind)).map((e) => e.id);
}

interface Ctx {
  exp: Experiment;
  an: Analysis;
  rows: Dataset['daily'];
  asOf: string;
  opts: Required<Omit<InspectionOptions, 'materiality'>> & { materiality?: number };
}

/**
 * 单个实验的判定。返回 signals（可多条）与 next。
 *
 * 这里刻意**不按 `reasonCode` 分支**：reasonCode 只报「命中的第一条规则」，
 * 一个实验可能同时分流异常 + 护栏恶化，只看 reasonCode 会漏掉一半。
 * 每个信号独立判断，最后合成一个「下一步」。
 */
function inspectOne(c: Ctx): {
  item: InspectionItem;
  stat: { mde: number; materiality: number; ratio: number; mdeRel: number | null; insuff: boolean } | null;
} {
  const { exp, an, rows, asOf, opts } = c;
  const unit = an.primary.unit;
  const signals: RiskSignal[] = [];
  const alpha = opts.alpha;

  const lastDate = rows.length ? rows.reduce((m, r) => (r.date > m ? r.date : m), rows[0].date) : null;
  const daysSince = lastDate ? daysBetween(lastDate, asOf) : null;

  // ---- ① 一行数据都没有：这一条必须排在判断效应之前 ----
  if (rows.length === 0) {
    signals.push(signal('no_data', '实验已声明，但数据里没有任何一行：不是「没效果」，是没有数据'));
    return finish(c, signals);
  }

  // ---- ② 数据可用性 ----
  // 分流坏了或一行数据都没有时，**下游诊断全部跳过**：
  // 在一个分流比例错 20% 的实验上做截尾诊断、算 MDE，得到的数字都没有意义，
  // 列出来只会让人以为「这个实验还有别的毛病」。前置条件不满足时，结论只能是前置条件本身。
  if (an.srm.flagged) {
    signals.push(
      signal(
        'srm_broken',
        `分流比例与声明不符（χ²=${an.srm.chi2.toFixed(1)}，p${an.srm.p < 1e-16 ? '<1e-16' : `=${an.srm.p.toExponential(1)}`}，` +
          `最大相对偏差 ${(an.srm.relImb * 100).toFixed(2)}%）。这批数据不能用来判效应，先查分流`,
        citesOf(an, ['srm']),
      ),
    );
    return finish(c, signals);
  }

  // ---- ③ 数据停滞（只对还在跑的实验） ----
  if (lastDate && daysSince !== null && daysSince > opts.staleDays && exp.endDate >= asOf) {
    signals.push(
      signal(
        'stale_data',
        `最后一行数据是 ${lastDate}，距基准日 ${daysSince} 天，而实验计划到 ${exp.endDate}：` +
          '可能是埋点断了，也可能是这段时间真没人进来——两者都需要人看一眼',
      ),
    );
  }

  // ---- ④ 坏消息：护栏 / 显著但太小 / 负向 ----
  // 这三个量在这里就要算：判断「显著」是不是「显著但没用」需要业务效应量作标尺，
  // 而下面的 ⑧ 段还要用同一个 materiality —— 两处必须同源，不能各算一次。
  const mde = mdeOf(an.primary.se, alpha, opts.power);
  const materiality = opts.materiality ?? Math.abs(an.primary.controlValue) * MATERIALITY_REL;
  const ratio = materiality > 0 && Number.isFinite(mde) ? mde / materiality : Infinity;
  const relText = opts.materiality === undefined
    ? `业务效应量 ${fmtMagnitude(materiality, unit)}（= 对照基线 ${fmtLevel(an.primary.controlValue, unit)} 的 ${(MATERIALITY_REL * 100).toFixed(0)}%）`
    : `业务效应量 ${fmtMagnitude(materiality, unit)}（显式声明）`;

  const worse = an.guardrails.filter((g) => g.gating && g.worse);
  if (worse.length) {
    signals.push(
      signal(
        'guardrail_worse',
        `拦截型护栏确认恶化：${worse.map((g) => g.label).join('、')}（容忍度 ${worse[0].marginLabel ?? '已声明'}）` +
          '。护栏优先于主指标：主指标再好，这一条也让它不能上',
        citesOf(an, ['guardrail']),
      ),
    );
  }

  const sig = an.primary.p < alpha;
  /**
   * 统计显著但幅度小于业务门槛。
   *
   * 这一类在真实数据里极常见（样本一大，p 就会显著），而它最容易被读错：
   * 界面上写着 p=0.042，读者就以为「有结论了」，而效应可能只有 0.01pp。
   * 所以它既不能算「坏消息」（那会让人去停一个其实没变差的实验），
   * 也不能算「可以上线」（那是在推一个不值得做的改动）。
   */
  const trivial = sig && Math.abs(an.primary.diff) < materiality;
  if (trivial) {
    signals.push(
      signal(
        'trivial_effect',
        `统计上显著（p=${formatP(an.primary.p)}），但幅度只有 ${fmtMagnitude(Math.abs(an.primary.diff), unit)}，` +
          `小于${relText}。这不算「有结论」：这种幅度下，上线与不用的差别落在噪声里`,
        citesOf(an, ['metric']),
      ),
    );
  }
  if (sig && !trivial && an.primary.diff < 0) {
    signals.push(
      signal(
        'sig_negative',
        `主指标显著为负：${fmtMagnitude(an.primary.diff, unit)}（p=${formatP(an.primary.p)}），幅度也超过${relText}`,
        citesOf(an, ['metric']),
      ),
    );
  }

  // ---- ⑤ 早停风险：naive 显著但 OBF 不显著 ----
  if (an.sequential.naiveSig && !an.sequential.obfSig) {
    signals.push(
      signal(
        'peeking_risk',
        `naive 判定显著、但按序贯边界（OBF）不显著：这份「显著」是在 ${an.sequential.looks.length} 次观察里` +
          '反复看出来的可能性不能排除。要么按序贯口径判，要么等样本到位再看',
        citesOf(an, ['metric']),
      ),
    );
  }

  // ---- ⑥ 结论靠少数行（只有连续指标才有这个诊断） ----
  if (an.robustness && (an.robustness.verdict === 'sensitive' || an.robustness.verdict === 'flip')) {
    signals.push(
      signal(
        'fragile',
        an.robustness.verdict === 'flip'
          ? '截尾后差值的**符号翻转**：连方向都取决于少数极端行，上线前必须查清那几行是谁'
          : `截尾后显著性翻转：方向没变，但「显著」这件事依赖少数极端行`,
        citesOf(an, ['robustness']),
      ),
    );
  }

  // ---- ⑦ 效应随人群变化 ----
  if (an.reasonCode === 'HETEROGENEOUS') {
    const best = an.heterogeneity.bestSegment;
    const flat = an.heterogeneity.flatSegment;
    signals.push(
      signal(
        'heterogeneous',
        `效应随人群变化（交互 p=${formatP(an.heterogeneity.interactionP ?? NaN)}）：` +
          `${best ?? '某一人群'} 有效、${flat ?? '另一人群'} 无效。这不是「全量上线」的结论`,
        citesOf(an, ['segment', 'metric']),
      ),
    );
  }

  // ---- ⑧ 测不出 vs 确实没效果 ----
  // 只在「不显著」时判：显著了就不存在「测不出」的问题。
  // 只在引擎判「没结论」时解释「为什么没结论」——一个已经被护栏拦下的实验不需要
  // 再叠加一句「你测不出」，那是噪音，而且会让「设计不足」的计数与 inconclusive 对不上。
  if (an.decision === 'inconclusive' && rows.length > 0) {
    if (ratio <= 1) {
      signals.push(
        signal(
          'no_effect_confident',
          `以现在的样本量能排除 ${fmtMagnitude(mde, unit)} 以上的效应，而${relText}——` +
            '也就是说「没有值得做的效果」这件事是**有依据**的，不是「没测出来」',
          citesOf(an, ['metric']),
        ),
      );
    } else if (ratio <= N_RATIO_LIMIT) {
      signals.push(
        signal(
          'underpowered',
          `现在的样本量只能检出 ${fmtMagnitude(mde, unit)} 以上的效应，比${relText}大 ${ratio.toFixed(1)} 倍——` +
            '所以「不显著」只能说明**测不出**，不能说「没效果」；补样本可行（见下一步）',
          citesOf(an, ['metric']),
        ),
      );
    } else {
      signals.push(
        signal(
          'design_insufficient',
          `现在的样本量只能检出 ${fmtMagnitude(mde, unit)} 以上的效应，是${relText}的 ${ratio.toFixed(1)} 倍。` +
            `要检出业务效应量需要约 ${(ratio * ratio).toFixed(0)} 倍样本——**这不现实**，` +
            '所以这个实验的问题不在执行，在设计：规模与要回答的问题不匹配',
          citesOf(an, ['metric']),
        ),
      );
    }
  }

  // 异质时不加「显著为正」：结论已经是「定向」，再说一句「显著为正」
  // 会让读者以为可以全量上线（E008 实测就是这种自相矛盾的组合）。
  if (sig && !trivial && an.primary.diff > 0 && !worse.length && an.reasonCode !== 'HETEROGENEOUS') {
    signals.push(
      signal(
        'sig_positive',
        `主指标显著为正：${fmtMagnitude(an.primary.diff, unit)}（p=${formatP(an.primary.p)}），幅度超过${relText}，护栏未恶化`,
        citesOf(an, ['metric', 'decision']),
      ),
    );
  }

  return finish(c, signals);
}

/**
 * 把信号汇总成一个巡检项。
 *
 * 抽成函数是为了让「前置条件不满足就短路」能复用同一段收尾逻辑：
 * SRM 坏了的时候也要有 score / risk / next / why，只是 signals 只有一条。
 * 短路路径里 mde 这类量照样重算一遍——它很便宜，而让两条路径各自维护收尾逻辑
 * 迟早会长出两份不一致的「下一步」。
 */
function finish(c: Ctx, signals: RiskSignal[]): {
  item: InspectionItem;
  stat: { mde: number; materiality: number; ratio: number; mdeRel: number | null; insuff: boolean } | null;
} {
  const { exp, an, rows } = c;
  const unit = an.primary.unit;
  const mde = mdeOf(an.primary.se, c.opts.alpha, c.opts.power);
  const materiality = c.opts.materiality ?? Math.abs(an.primary.controlValue) * MATERIALITY_REL;
  const ratio = materiality > 0 && Number.isFinite(mde) ? mde / materiality : Infinity;
  const codes = new Set(signals.map((g) => g.code));
  const poweredGap = codes.has('underpowered');
  const designGap = codes.has('design_insufficient');

  const score = signals.reduce((s, x) => s + x.weight, 0);
  const risk = riskOf(signals, an);
  const controlArm = controlArmOf(exp);
  const nControl = rows
    .filter((r) => r.variant === controlArm)
    .reduce((s, r) => s + r.exposures, 0);
  const next = nextActionOf(an, signals, {
    unit, materiality, mde, poweredGap, designGap, ratio,
    rows, daily: dailyRatePerArm(rows, Math.max(2, an.arms.length)), nControl,
  });

  const hasPowerVerdict =
    codes.has('underpowered') || codes.has('design_insufficient') || codes.has('no_effect_confident');
  const stat = hasPowerVerdict
    ? {
        mde,
        materiality,
        ratio,
        mdeRel: Math.abs(an.primary.controlValue) > 0 ? mde / Math.abs(an.primary.controlValue) : null,
        insuff: designGap,
      }
    : null;

  const lastDate = rows.length ? rows.reduce((m, r) => (r.date > m ? r.date : m), rows[0].date) : null;
  return {
    item: {
      expId: exp.id,
      name: exp.name,
      primaryMetric: an.primary.label,
      decision: an.decision,
      reasonCode: an.reasonCode,
      risk,
      score,
      why: whyOf(signals, an, unit),
      signals,
      next,
      rowCount: rows.length,
      lastDate,
      daysSinceLastData: lastDate ? daysBetween(lastDate, c.asOf) : null,
    },
    stat,
  };
}

function riskOf(signals: RiskSignal[], an: Analysis): RiskLevel {
  const codes = new Set(signals.map((s) => s.code));
  if (codes.has('srm_broken') || codes.has('no_data') || codes.has('guardrail_worse') || codes.has('sig_negative')) {
    return 'critical';
  }
  if (
    codes.has('heterogeneous') || codes.has('fragile') || codes.has('peeking_risk') ||
    codes.has('stale_data') || codes.has('trivial_effect')
  ) {
    return 'warn';
  }
  if (codes.has('sig_positive') || codes.has('underpowered')) return 'info';
  // 「确实没效果」与「设计不足」都归 ok，但语义不同：
  //   前者是「问题回答完了」，后者是「这个问题这个实验答不了」。
  // 两者都不需要人现在动手，所以归同一组；区别写在 why 里（不能只靠颜色）。
  void an;
  return 'ok';
}

/** 一句话解释它在清单里的位置。读者看不到分数，只看这一句 */
function whyOf(signals: RiskSignal[], an: Analysis, unit: 'pp' | '元'): string {
  const byCode = (c: SignalCode) => signals.find((s) => s.code === c);
  const srm = byCode('srm_broken');
  if (srm) return '分流坏了，这批数据不能用来判效应——先修分流，其他结论先放一边';
  const nod = byCode('no_data');
  if (nod) return '一行数据都没有：先确认埋点是否真的上了，别等到周五才发现白跑一周';
  const g = byCode('guardrail_worse');
  if (g) return `护栏确认恶化（${g.detail.split('：')[1]?.split('。')[0] ?? ''}），主指标再好也不能上`;
  const neg = byCode('sig_negative');
  if (neg) return '主指标显著为负，这是明确的坏消息，建议尽快停掉或改版';
  const het = byCode('heterogeneous');
  if (het) return '效应只在一部分人群成立，值得做定向，但不该全量';
  const frag = byCode('fragile');
  if (frag) return '结论依赖少数极端行，先查清那几行是谁再谈上线';
  const peek = byCode('peeking_risk');
  if (peek) return '这个「显著」可能是反复看出来的，按序贯口径还不算数';
  const stale = byCode('stale_data');
  if (stale) return '数据好几天没动了，先确认是没人进来还是埋点断了';
  const triv = byCode('trivial_effect');
  if (triv) return '统计上显著，但幅度小于业务门槛：这不是「可以上线」，也不是「变差了」，是不值得动';
  const pos = byCode('sig_positive');
  if (pos) return `主指标 +${fmtMagnitude(an.primary.diff, unit)} 且护栏干净，等你拍板上线`;
  const und = byCode('underpowered');
  if (und) return '测不出：现在的样本量支撑不了「没效果」这个说法，要么补数据，要么别下结论';
  const insuff = byCode('design_insufficient');
  if (insuff) {
    return '设计不足：这个规模能检出的最小效应比业务关心的大好几倍，它没有能力回答这个问题，补样本也来不及';
  }
  return '能排除业务关心的效应量，这个版本确实不需要继续投入';
}

function nextActionOf(
  an: Analysis,
  signals: RiskSignal[],
  c: {
    unit: 'pp' | '元';
    materiality: number;
    mde: number;
    poweredGap: boolean;
    designGap: boolean;
    ratio: number;
    rows: Dataset['daily'];
    daily: number;
    nControl: number;
  },
): NextAction {
  const codes = new Set(signals.map((s) => s.code));
  if (codes.has('srm_broken')) {
    return {
      kind: 'fix-traffic',
      label: '先修分流',
      detail:
        '查分流服务的桶分配、以及这次实验有没有改动过流量规则；' +
        '在分流修好之前，这个实验的任何效应数字都不该进汇报',
    };
  }
  if (codes.has('no_data')) {
    return { kind: 'instrument', label: '确认埋点', detail: '实验声明存在但没有任何数据行：先确认事件是否上报成功，不要先怀疑效应' };
  }
  if (codes.has('guardrail_worse') || codes.has('sig_negative')) {
    const g = an.guardrails.find((x) => x.gating && x.worse);
    return {
      kind: 'hold',
      label: '不要上线',
      detail: g
        ? `护栏「${g.label}」已确认恶化超过容忍度。停掉或改版后重跑，不要靠主指标的正向去抵消它`
        : '主指标显著为负：停掉或改版后重跑',
    };
  }
  if (codes.has('trivial_effect')) {
    return {
      kind: 'review',
      label: '不值得动',
      detail:
        '统计显著但幅度小于业务门槛：上线它换不来可感知的收益，停掉它也不会有损失。' +
        '把样本留给更值得做的假设——这类实验最常见的浪费是「因为 p<0.05 就上线了」。',
    };
  }
  if (codes.has('heterogeneous')) {
    return {
      kind: 'iterate',
      label: '定向上线',
      detail: `只在「${an.heterogeneity.bestSegment ?? '有效人群'}」上线；「${an.heterogeneity.flatSegment ?? '无效人群'}」不要上——` +
        '全量会把无效人群的成本一起背上',
    };
  }
  if (codes.has('sig_positive')) {
    return {
      kind: 'ship',
      label: '可以上线',
      detail: `主指标 +${fmtMagnitude(an.primary.diff, c.unit)}（p=${an.primary.p.toFixed(3)}），护栏未恶化。` +
        '上线后建议再观察一周，确认没有迟到的护栏问题',
    };
  }
  if (codes.has('fragile') || codes.has('peeking_risk')) {
    return {
      kind: 'review',
      label: '人工复核',
      detail: codes.has('fragile')
        ? '先按「单点杠杆」查出是哪几行在决定结论，再决定要不要采纳这个显著性'
        : '按序贯口径（OBF）重新判一次；或等样本到位后只看一次，不要继续每天看',
    };
  }
  if (c.designGap) {
    return {
      kind: 'review',
      label: '设计不足',
      detail:
        `按现在的规模（每臂约 ${c.nControl.toLocaleString('en-US')} 人）只能检出 ${fmtMagnitude(c.mde, c.unit)} 以上的效应，` +
        `是业务效应量的 ${c.ratio.toFixed(1)} 倍，补样本要 ${(c.ratio * c.ratio).toFixed(0)} 倍人数——不现实。` +
        '下次设计时先算样本量：要么接受更粗的效应阈值，要么换方差更小的指标口径。' +
        '**不要因为「不显著」就说这个版本没用**——这个实验根本没能力回答这个问题',
    };
  }
  if (c.poweredGap) {
    const perArm = neededN(c.nControl, c.mde, c.materiality);
    const days = perArm !== null && c.daily > 0 ? Math.max(0, Math.ceil((perArm - c.nControl) / c.daily)) : null;
    return {
      kind: 'collect-more',
      label: '补样本',
      detail:
        perArm !== null
          ? `要检出 ${fmtMagnitude(c.materiality, c.unit)} 的效应，每臂约需 ${perArm.toLocaleString('en-US')} 人（现在 ${c.nControl.toLocaleString('en-US')}）` +
            (days !== null ? `，按现在的进人速度约还要 ${days} 天` : '')
          : '需要更多样本才能判断，但当前数据不足以估出具体天数',
      forecast: {
        nPerArm: perArm,
        days,
        note:
          perArm !== null
            ? `解析式：n′ = n × (MDE / 目标效应)² = ${c.nControl.toLocaleString('en-US')} × (${c.mde.toFixed(4)} / ${c.materiality.toFixed(4)})²`
            : '当前样本不足以估出所需人数',
      },
    };
  }
  if (codes.has('stale_data')) {
    return { kind: 'review', label: '查数据管道', detail: '先确认是不再有流量进来，还是上报链路断了' };
  }
  return {
    kind: 'review',
    label: '可以收工',
    detail: '这个实验已经能给出「没有值得做的效果」的结论，不需要再投入样本',
  };
}

/**
 * 跑一次巡检。
 *
 * 「今天」= 数据集里最晚的一天。这不是省事，而是**可复现的前提**：
 * 用系统时钟的话，同一份数据今天跑和明天跑会得到不同的「停滞天数」，
 * 基线比对就永远红——而一份不能比对的周报，等于没有评测。
 */
export function runInspection(
  dataset: Dataset,
  analyses: Map<string, Analysis>,
  opts: InspectionOptions = {},
): InspectionReport {
  const asOf = dataset.daily.length
    ? dataset.daily.reduce((m, r) => (r.date > m ? r.date : m), dataset.daily[0].date)
    : '—';

  const rowsByExp = new Map<string, Dataset['daily']>();
  for (const r of dataset.daily) {
    const list = rowsByExp.get(r.expId);
    if (list) list.push(r);
    else rowsByExp.set(r.expId, [r]);
  }

  const ctxOpts = {
    // α 不复制：直接读决策配置，否则设置页改了 α 而巡检还在用旧的
    alpha: opts.alpha ?? DEFAULT_CONFIG.alpha,
    power: opts.power ?? POWER_DEFAULT,
    staleDays: opts.staleDays ?? STALE_DEFAULT,
    criticalLimit: opts.criticalLimit ?? CRITICAL_LIMIT,
    materiality: opts.materiality,
  };

  const items: InspectionItem[] = [];
  const stats: Array<{ mdeRel: number | null; ratio: number; insuff: boolean }> = [];
  let noAnalysis = 0;
  for (const exp of dataset.experiments) {
    const an = analyses.get(exp.id);
    if (!an) {
      noAnalysis += 1;
      continue;
    }
    const rows = rowsByExp.get(exp.id) ?? [];
    const one = inspectOne({ exp, an, rows, asOf, opts: ctxOpts });
    items.push(one.item);
    if (one.stat) stats.push({ mdeRel: one.stat.mdeRel, ratio: one.stat.ratio, insuff: one.stat.insuff });
  }

  items.sort((a, b) => {
    const r = RISK_RANK[a.risk] - RISK_RANK[b.risk];
    if (r !== 0) return r;
    if (b.score !== a.score) return b.score - a.score;
    return a.expId.localeCompare(b.expId);
  });

  const critical = items.filter((x) => x.risk === 'critical');
  const warn = items.filter((x) => x.risk === 'warn');
  const info = items.filter((x) => x.risk === 'info');
  const ok = items.filter((x) => x.risk === 'ok');

  const limit = ctxOpts.criticalLimit;
  const mustLook = pickMustLook(critical, limit);

  /**
   * 系统性问题的判据是「同一类基础设施信号集中出现」，**不是 critical 的数量**。
   *
   * 这里踩过一次坑：最早用「critical > 5 就报系统性问题」，结果在一份 120 个历史实验的
   * 数据集上，42 个 critical（10 个分流异常 + 15 个护栏恶化 + 15 个真负效应）触发了警告——
   * 但那些是**积压的历史记录**，不是「今天同时坏了 42 个」。
   * 更糟的是它会让人去怀疑分流服务，而真实原因只是「这份数据里本来就有这么多坏实验」。
   *
   * 只有共用同一条链路的信号才可能是共因：分流（SRM）、埋点（无数据）、导出（停滞）。
   * 护栏恶化和主指标负向永远不判系统性——不同功能各有一个坏结论是正常的。
   */
  const INFRA: SignalCode[] = ['srm_broken', 'no_data', 'stale_data'];
  const infraHits = new Map<SignalCode, string[]>();
  for (const x of items) {
    for (const g of x.signals) {
      if (!INFRA.includes(g.code)) continue;
      const list = infraHits.get(g.code);
      if (list) list.push(x.expId);
      else infraHits.set(g.code, [x.expId]);
    }
  }
  const hot = [...infraHits.entries()]
    .filter(([, ids]) => ids.length >= INFRA_SYSTEMIC_MIN)
    .sort((a, b) => b[1].length - a[1].length)[0];
  const systemic = hot
    ? `有 ${hot[1].length} 个实验同时出现「${LABEL[hot[0]]}」（${hot[1].slice(0, 6).join('、')}${hot[1].length > 6 ? ' 等' : ''}）。` +
      '这类信号共用同一条链路，同时出现几乎不可能是巧合——优先查分流服务、埋点发布或导出脚本，' +
      '不要逐个实验去调。'
    : null;

  const byDecision: Record<Decision, number> = { ship: 0, 'no-ship': 0, iterate: 0, inconclusive: 0 };
  for (const x of items) byDecision[x.decision] += 1;

  const digest = digestOf(items, mustLook);
  const power = powerOf(stats);

  const report: InspectionReport = {
    asOf,
    generatedAt: new Date().toISOString(),
    totals: {
      experiments: items.length,
      rows: dataset.daily.length,
      withData: items.filter((x) => x.rowCount > 0).length,
      critical: critical.length,
      warn: warn.length,
      info: info.length,
      ok: ok.length,
      byDecision,
    },
    items,
    mustLook,
    systemic: systemic ?? (noAnalysis > 0 ? `有 ${noAnalysis} 个实验没有可用的分析结果（可能数据缺失），未纳入巡检。` : null),
    scope: [...INSPECTION_SCOPE],
    power,
    digest,
  };
  return report;
}

/**
 * 第一屏的挑选规则：**同类只留一个代表**。
 *
 * 第一版直接把 critical 前 5 条放上去，结果在真实数据上第一屏是 5 条「分流坏了」——
 * 内容几乎一字不差。那不是「今天有 5 件事」，那是「今天有 1 件事，被列了 5 遍」。
 * 读者划两下就学会跳过第一屏，而第一屏是这份报告唯一一定会被看到的地方。
 *
 * 所以按主导信号去重：分流、护栏、负向各留一个代表，再由 systemic 负责把
 * 「同类里还有 9 个」说清楚。第一屏的作用是告诉你**今天有哪几类事**，
 * 不是把同类的事列满。
 */
function pickMustLook(critical: InspectionItem[], limit: number): InspectionItem[] {
  const dominant = (x: InspectionItem): SignalCode => {
    let best = x.signals[0];
    for (const g of x.signals) if (g.weight > best.weight) best = g;
    return best?.code ?? 'review' as SignalCode;
  };
  const out: InspectionItem[] = [];
  const seen = new Set<SignalCode>();
  for (const x of critical) {
    if (out.length >= limit) break;
    const code = dominant(x);
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(x);
  }
  // 不再追加 warn：warn 的定义就是「本周处理」，放进「今天只看这几件」名不副实，
  // 而且会在下面的分组里重复出现一次——读者会以为有两件事。
  return out;
}

/** 中位数（偶数个取均值）。不排序稳定性无关，用朴素实现即可 */
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 样本量现状。
 *
 * 为什么这必须是一条**集体事实**而不是逐条建议：
 * 当 49 个实验的 MDE 都是业务效应量的 3~6 倍时，逐条说「请补样本」等于让读者
 * 去补 16 倍的人数——那不是建议，是劝人放弃。真实结论只有一句：
 * **这批实验的规模与业务关心的问题不匹配**，要么调低期望，要么在设计阶段就算样本量。
 */
function powerOf(
  stats: Array<{ mdeRel: number | null; ratio: number; insuff: boolean }>,
): PowerSummary {
  const rels = stats.map((s) => s.mdeRel).filter((v): v is number => v !== null && Number.isFinite(v));
  const ratios = stats.map((s) => s.ratio).filter((v) => Number.isFinite(v));
  return {
    inconclusive: stats.length,
    insufficient: stats.filter((s) => s.insuff).length,
    fixable: stats.filter((s) => !s.insuff && s.ratio > 1).length,
    materialityRel: MATERIALITY_REL,
    medianMdeRel: median(rels),
    medianNMultiple: ratios.length ? (median(ratios) as number) ** 2 : null,
  };
}

function digestOf(items: InspectionItem[], mustLook: InspectionItem[]): InspectionDigest {
  const ids = (lvl: RiskLevel) => items.filter((x) => x.risk === lvl).map((x) => x.expId).sort();
  let cites = 0;
  let hard = 0;
  for (const x of items) {
    cites += x.signals.reduce((s, g) => s + g.cites.length, 0);
    // 「硬给结论」：引擎判 inconclusive，但清单里出现有方向的结论信号
    if (x.decision === 'inconclusive') {
      const directional = x.signals.some((s) =>
        s.code === 'sig_positive' || s.code === 'sig_negative' || s.code === 'heterogeneous',
      );
      if (directional) hard += 1;
    }
  }
  return {
    mustLookIds: mustLook.map((x) => x.expId),
    criticalIds: ids('critical'),
    warnIds: ids('warn'),
    infoIds: ids('info'),
    okIds: ids('ok'),
    underpowered: items.filter((x) => x.signals.some((s) => s.code === 'underpowered')).length,
    designInsufficient: items.filter((x) => x.signals.some((s) => s.code === 'design_insufficient')).length,
    noEffectConfident: items.filter((x) => x.signals.some((s) => s.code === 'no_effect_confident')).length,
    hardVerdictsOnInconclusive: hard,
    evidencePerItem: items.length ? Number((cites / items.length).toFixed(3)) : 0,
    evidenceCites: cites,
  };
}

/**
 * 导出成 Markdown 周报。
 *
 * 注意它只消费 `InspectionReport`，不重新计算任何东西——
 * 报告与界面上看到的必须是同一份数字，否则「截图和导出的 md 不一致」会成为新的信任问题。
 */
export function renderMarkdown(r: InspectionReport): string {
  const L: string[] = [];
  L.push(`# 实验巡检周报（基准日 ${r.asOf}）`);
  L.push('');
  L.push(
    `共 ${r.totals.experiments} 个实验、${r.totals.rows.toLocaleString('en-US')} 行数据。` +
      `必须处理 **${r.totals.critical}** 个、本周处理 ${r.totals.warn} 个、等你拍板 ${r.totals.info} 个、` +
      `无需投入 ${r.totals.ok} 个。`,
  );
  L.push('');

  if (r.systemic) {
    L.push('> **系统性问题**：' + r.systemic);
    L.push('');
  }

  if (r.mustLook.length) {
    L.push('## 今天只看这几件');
    L.push('');
    r.mustLook.forEach((x, i) => {
      L.push(`### ${i + 1}. ${x.expId} ${x.name}`);
      L.push('');
      L.push(`- **为什么**：${x.why}`);
      for (const s of x.signals) {
        if (s.weight === 0) continue;
        L.push(`- **${s.label}**：${s.detail}${s.cites.length ? ` [${s.cites.join('][')}]` : ''}`);
      }
      L.push(`- **下一步**：${x.next.label} —— ${x.next.detail}`);
      L.push('');
    });
  } else {
    L.push('## 今天没有必须处理的事');
    L.push('');
    L.push('所有实验要么已能给出结论，要么还在正常积累数据。');
    L.push('');
  }

  const section = (title: string, list: InspectionItem[]) => {
    if (!list.length) return;
    L.push(`## ${title}（${list.length}）`);
    L.push('');
    L.push('| 实验 | 主指标 | 结论 | 分数 | 为什么 | 下一步 |');
    L.push('|---|---|---|---|---|---|');
    for (const x of list) {
      L.push(`| ${x.expId} ${x.name} | ${x.primaryMetric} | ${x.decision} | ${x.score} | ${x.why} | ${x.next.label} |`);
    }
    L.push('');
  };
  const p = r.power;
  if (p.inconclusive > 0) {
    L.push('## 样本量：这批实验大多回答不了业务问题');
    L.push('');
    if (p.insufficient > 0) {
      L.push(
        `${p.inconclusive} 个实验没有结论，其中 **${p.insufficient} 个（${((p.insufficient / p.inconclusive) * 100).toFixed(0)}%）是设计不足**：` +
          `按现在的规模，能检出的最小相对效应中位数是 ${p.medianMdeRel !== null ? (p.medianMdeRel * 100).toFixed(1) + '%' : '—'}，` +
          `而业务声明的效应量是相对 ${(p.materialityRel * 100).toFixed(0)}% 的提升`,
      );
      if (p.medianNMultiple !== null) {
        L.push(
          `——要检出它，样本量需要放大 **${p.medianNMultiple.toFixed(0)} 倍**。这不是执行问题，补样本不现实：` +
            '下次设计实验时先把样本量算出来，或者把要回答的问题改成更大的效应。',
        );
      }
      L.push('');
      L.push(
        '**这批实验的「不显著」不能被读成「没效果」。** 它们的分辨率比要回答的问题粗一个量级，' +
          '所以「没效果」这个结论在这批数据上根本没有被检验过。',
      );
    } else if (p.fixable > 0) {
      L.push(`${p.inconclusive} 个实验没有结论，其中 ${p.fixable} 个是「补样本可行」——见下表的具体人数与天数。`);
    }
    L.push('');
  }

  section('本周处理', r.items.filter((x) => x.risk === 'warn'));
  section('等你拍板 / 需要资源', r.items.filter((x) => x.risk === 'info'));
  section('无需投入', r.items.filter((x) => x.risk === 'ok'));

  L.push('## 这份报告怎么来的');
  L.push('');
  INSPECTION_STEPS.forEach((s, i) => L.push(`${i + 1}. ${s}`));
  L.push('');
  L.push(
    '排序不看的「效应大小」，看的是「不处理的代价」——分流坏了的实验排在第一位，' +
      '不是因为它效应大，而是因为那组数字不能用。',
  );
  L.push('');
  L.push(`- 「测不出」与「确实没效果」的分界：业务效应量 ${MATERIALITY_REL * 100}% 相对提升（可在设置里改），` +
    `不是拍脑袋的常数。`);
  L.push(`- 本报告不含任何模型生成的数字：所有数字来自引擎，每条结论都带证据编号。`);
  L.push('');
  return L.join('\n');
}

export { WEIGHT as SIGNAL_WEIGHT, LABEL as SIGNAL_LABEL };
