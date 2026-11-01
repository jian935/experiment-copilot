import type { Archetype, DailyRow, Dataset, Decision, Device, Experiment, Tenure } from './types.ts';
import { mulberry32 } from './stats.ts';

function randn(rng: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function binomial(n: number, p: number, rng: () => number): number {
  if (n <= 0 || p <= 0) return 0;
  if (p >= 1) return n;
  const mean = n * p;
  const sd = Math.sqrt(n * p * (1 - p));
  return Math.max(0, Math.min(n, Math.round(mean + sd * randn(rng))));
}

function poisson(lambda: number, rng: () => number): number {
  if (lambda <= 0) return 0;
  if (lambda < 30) {
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= rng(); } while (p > L);
    return k - 1;
  }
  return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * randn(rng)));
}

/**
 * 基线异质性强度（相对基线率的标准差，比例单位）。
 * 0.0012 / 0.0018 ≈ 基线的 2%–3%：足以让「所有格子同 p」这个 i.i.d. 假设不成立
 * （于是原来那套二项标准误会偏乐观），又不至于把主指标的相对效应淹没。
 * 改它必须重跑 A/A 自校准与 CI 覆盖率——见 docs/EVAL.md。
 */
export const BASELINE_DAY_SD = 0.0012;
export const BASELINE_DEVICE_SD = 0.0018;
/**
 * 每个「格子 × 变体」各自的基线偏离（比例单位）。
 *
 * 物理含义：同一个格子（某天 × 某端 × 某人群）里，control 与 treatment 分到的是
 * **不同的一批用户**，这批用户的平均倾向天然不同。这个偏离前后周期共享（同一批人），
 * 所以：
 *   - 它在两臂之间**不抵消**（不同用户）→ 是真实需要减掉的方差；
 *   - 它被前周期观测到 → CUPED 正是靠它把精度赚回来。
 * 量级：0.005 ≈ 二项噪声 sd（sqrt(0.05×0.95/700)≈0.0082）的 60%，
 * 于是格子率的真实方差比纯二项大约 36%，朴素 i.i.d. 标准误会偏乐观约 17%。
 */
export const BASELINE_ARM_SD = 0.005;

/**
 * 客单价模型（ARPU 的数据来源）。
 *
 * 订单金额天然右偏：多数人买几十块，少数人买几百块。用对数正态近似（σ_log = 0.45），
 * 这决定了 ARPU 的方差**不由均值决定**——正是它不能套 p(1−p)/n 的原因。
 *
 * AOV_ARM_SD 是「格子 × 变体」这一批用户的客单价漂移：同一批人前后周期共享，
 * 所以它既是 CUPED 能减掉的方差，也保证 ARPU 的 A/A 检验不会因为格子间差异被低估。
 */
export const AOV_LOG_SD = 0.45;
export const AOV_ARM_SD = 0.06;

const NAMES = [
  '结算页改版', '首页按钮颜色', '推荐算法迭代', '新用户弹窗', '列表加载优化',
  '搜索排序调整', '价格展示方式', '优惠券入口', '购物车交互', '详情页图集',
  '新手引导流程', '消息推送文案', '会员权益页', '支付方式排序', '筛选器改版',
];

const HYPOTHESES = [
  '新方案能提升主转化指标', '改版能改善点击到支付的转化', '新交互能降低流失',
  '优化能提升下单转化', '调整能提升用户留存', '新入口能提升使用率',
];

interface Cfg {
  liftNew: number;
  liftOld: number;
  refundDiff: number;
  ratio: number;
  newShare: number;
  decision: Decision;
}

const CFG: Record<Archetype, Cfg> = {
  null:          { liftNew: 0,      liftOld: 0,      refundDiff: 0,     ratio: 0.5, newShare: 0.5, decision: 'inconclusive' },
  positive:      { liftNew: 0.020,  liftOld: 0.020,  refundDiff: 0,     ratio: 0.5, newShare: 0.5, decision: 'ship' },
  negative:      { liftNew: -0.015, liftOld: -0.015, refundDiff: 0,     ratio: 0.5, newShare: 0.5, decision: 'no-ship' },
  heterogeneous: { liftNew: 0.028,  liftOld: 0,      refundDiff: 0,     ratio: 0.5, newShare: 0.3, decision: 'iterate' },
  srm:           { liftNew: 0,      liftOld: 0,      refundDiff: 0,     ratio: 0.6, newShare: 0.5, decision: 'inconclusive' },
  guardrail:     { liftNew: 0.018,  liftOld: 0.018,  refundDiff: 0.008, ratio: 0.5, newShare: 0.5, decision: 'no-ship' },
};

export const ARCHETYPE_COUNTS: Record<Archetype, number> = {
  null: 40, positive: 25, negative: 15, heterogeneous: 15, srm: 10, guardrail: 15,
};

function isoDate(start: Date, offsetDays: number): string {
  const d = new Date(start.getTime() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

/**
 * 单个实验的完整生成（元信息 + 明细行）。
 * 抽出来是为了 A/A 自校准能复用同一套生成逻辑：同一份代码造出来的"无效应"数据，
 * 才谈得上拿它检验引擎在无效应时会不会乱报。
 */
export function buildExperiment(
  id: string,
  archetype: Archetype,
  seed: number,
  days: number,
  opts: { startDate?: Date; nameIndex?: number; primaryMetric?: 'rate' | 'continuous' } = {},
): { exp: Experiment; rows: DailyRow[] } {
  const startDate = opts.startDate ?? new Date('2026-09-01T00:00:00Z');
  const nameIndex = opts.nameIndex ?? 0;
  const continuous = opts.primaryMetric === 'continuous';
  const rng = mulberry32(seed);
  const cfg = CFG[archetype];
  const p0 = 0.045 + 0.015 * rng();
  const aov = 55 + 40 * rng(); // 该实验的客单价基线（55–95 元）
  // 日效应 / 设备效应：整段实验内固定、前后周期共享 —— 这正是 CUPED 能减掉的方差来源
  const dayEffect = Array.from({ length: days }, () => BASELINE_DAY_SD * randn(rng));
  const devEffect: Record<Device, number> = {
    iOS: BASELINE_DEVICE_SD * randn(rng),
    Android: BASELINE_DEVICE_SD * randn(rng),
  };
  const refundBase = 0.012;
  const complaintBase = 0.0012;
  const latencyMean = 820;
  const rows: DailyRow[] = [];

  const trueLiftOverall = cfg.liftNew * cfg.newShare + cfg.liftOld * (1 - cfg.newShare);
  const exp: Experiment = {
    id,
    name: NAMES[nameIndex % NAMES.length],
    hypothesis: HYPOTHESES[nameIndex % HYPOTHESES.length],
    startDate: isoDate(startDate, 0),
    endDate: isoDate(startDate, days - 1),
    variants: ['control', 'treatment'],
    trafficSplit: `${Math.round((1 - cfg.ratio) * 100)}/${Math.round(cfg.ratio * 100)}`,
    primaryMetric: continuous ? 'ARPU' : '支付转化率',
    metricType: continuous ? 'continuous' : 'binary',
    guardrailMetrics: ['退款率', '投诉率'],
    archetype,
    trueLift: archetype === 'heterogeneous' ? cfg.liftNew : trueLiftOverall,
    trueLiftScope: archetype === 'heterogeneous' ? 'new_users' : 'overall',
    trueLiftOverall,
    // 收入口径的真实效应：客单价不变时 ARPU 的相对提升 ≈ 转化率的相对提升。
    // 写成 p0 的比值而不是拍一个数，是为了让「真值对照」能被手算核验。
    trueRpuLift: p0 > 0 ? trueLiftOverall / p0 : 0,
    trueDecision: cfg.decision,
    seed,
  };

  const devices: Device[] = ['iOS', 'Android'];
  const tenures: Tenure[] = ['new', 'old'];
  for (let d = 0; d < days; d++) {
    for (const device of devices) {
      for (const tenure of tenures) {
        const mult = tenure === 'new' ? cfg.newShare * 2 : (1 - cfg.newShare) * 2;
        const base = Math.round(1400 * mult * (0.85 + 0.3 * rng()));
        for (const variant of ['control', 'treatment'] as const) {
          const share = variant === 'control' ? 1 - cfg.ratio : cfg.ratio;
          const n = Math.max(1, Math.round(base * share));
          const lift = tenure === 'new' ? cfg.liftNew : cfg.liftOld;

          // 基线 = 实验基准 + 日效应 + 设备效应（前后周期共享）。
          // 加这一层有两个理由：
          //   ① 真实数据本来就有星期效应与端差异，以前所有格子共用同一个 p 反而不真实；
          //   ② 前后周期共享同一段基线，CUPED 才有东西可「借」——否则 rho=0，方差缩减无从谈起。
          const cellBase = Math.min(0.95, Math.max(0.001, p0 + dayEffect[d] + devEffect[device]));
          // 该「格子 × 变体」这批用户自己的倾向偏离：前后周期共享，两臂之间不抵消
          const armShift = BASELINE_ARM_SD * randn(rng);
          const p = Math.min(0.95, Math.max(0.001, cellBase + armShift + (variant === 'treatment' ? lift : 0)));
          const c = binomial(n, p, rng);

          // 前周期：同口径、同格子、同一批单位的实验前行为（无 lift，共享 cellBase 与 armShift）
          const nPre = Math.max(1, Math.round(n * (0.9 + 0.2 * rng())));
          const cPre = binomial(nPre, Math.min(0.95, Math.max(0.001, cellBase + armShift)), rng);

          const refundP = Math.min(0.2, refundBase + (variant === 'treatment' ? cfg.refundDiff : 0));
          const refunds = binomial(n, refundP, rng);
          const complaints = poisson(n * complaintBase, rng);

          // ---- 收入：c 笔订单 × 该格子的客单价 ----
          // 订单金额服从对数正态（σ_log = 0.45），c 笔之和按 CLT 用「均值 + 标准差 × 正态」抽样：
          //   单笔 sd = aov·√(e^{σ²}−1)，c 笔之和 sd = 单笔 sd·√c
          // 这条生成逻辑决定了 ARPU 的方差主要来自「多少人下单」和「每单多大」，
          // 与转化率完全同源（ARPU = CVR × AOV），所以 ARPU 的真值方向必然跟着转化率走。
          const aovCell = aov * (1 + AOV_ARM_SD * randn(rng));
          const orderSd = aovCell * Math.sqrt(Math.exp(AOV_LOG_SD * AOV_LOG_SD) - 1);
          const revenue = Math.max(0, c * aovCell + Math.sqrt(Math.max(c, 1)) * orderSd * randn(rng));
          const preRevenue = Math.max(0, cPre * aovCell + Math.sqrt(Math.max(cPre, 1)) * orderSd * randn(rng));

          rows.push({
            expId: id,
            date: isoDate(startDate, d),
            variant,
            device,
            tenure,
            exposures: n,
            conversions: c,
            refunds,
            complaints,
            latencyP95: Math.round(latencyMean + 18 * randn(rng)),
            revenue: Math.round(revenue * 100) / 100,
            preExposures: nPre,
            preConversions: cPre,
            preRevenue: Math.round(preRevenue * 100) / 100,
          });
        }
      }
    }
  }
  return { exp, rows };
}

/** A/A 自校准数据集：count 个「两臂同分布、零效应」的实验，不进主数据集 */
export function generateAA(count = 1000, seedBase = 20261101, days = 7): Dataset {
  const experiments: Experiment[] = [];
  const daily: DailyRow[] = [];
  for (let i = 0; i < count; i++) {
    const { exp, rows } = buildExperiment(
      `AA${String(i + 1).padStart(4, '0')}`,
      'null',
      seedBase + (i + 1) * 7919,
      days,
      // 一半率指标、一半 ARPU：两种口径的误报率要分开测，
      // 因为它们的方差来源不同（二项 vs 收入的重尾），混在一起平均会掩盖某一方的问题。
      { nameIndex: i, primaryMetric: i % 2 === 0 ? 'rate' : 'continuous' },
    );
    experiments.push(exp);
    daily.push(...rows);
  }
  return {
    generatedAt: new Date().toISOString(),
    seedBase,
    groundTruth: true,
    spec: {
      days,
      preDays: days,
      baselineDaySd: BASELINE_DAY_SD,
      baselineDeviceSd: BASELINE_DEVICE_SD,
      aovMean: 75,
      aovLogSd: AOV_LOG_SD,
      aovArmSd: AOV_ARM_SD,
      segments: ['device', 'tenure'],
      baselineRate: [0.045, 0.06],
      refundRate: 0.012,
      complaintRate: 0.0012,
      latencyMean: 820,
      latencySd: 18,
    },
    experiments,
    daily,
  };
}

export function generateDataset(seedBase = 20261031, days = 7): Dataset {
  const experiments: Experiment[] = [];
  const daily: DailyRow[] = [];
  const archetypes = Object.entries(ARCHETYPE_COUNTS).flatMap(([a, n]) => new Array(n).fill(a) as Archetype[]);
  // 交错排列，避免同类型实验连号（评测时更真实）
  archetypes.sort((a, b) => (a < b ? -1 : 1));
  const order: Archetype[] = [];
  const buckets = new Map<Archetype, Archetype[]>();
  for (const a of archetypes) {
    if (!buckets.has(a)) buckets.set(a, []);
    buckets.get(a)!.push(a);
  }
  while (order.length < archetypes.length) {
    for (const [, list] of buckets) {
      const v = list.pop();
      if (v) order.push(v);
    }
  }

  const start = new Date('2026-09-01T00:00:00Z');

  order.forEach((archetype, i) => {
    const seed = seedBase + (i + 1) * 7919;
    const id = `E${String(i + 1).padStart(3, '0')}`;
    // 每 3 个实验里有 1 个以 ARPU 为主指标（40 个）：两种口径都能被评测到，
    // 又不至于把转化率口径的样本砍掉一半（混淆矩阵需要每格都有足够样本）。
    //
    // ⚠️ 这里必须是「按块轮转」而不是 i % 3：archetype 是 6 个一循环铺下来的
    // （guardrail / heterogeneous / negative / null / positive / srm），
    // 用 i % 3 会让连续口径只落在 i≡2 (mod 3) 这一条线上 —— 恰好只剩 negative 与 srm 两类，
    // 也就是说 ARPU 实验永远没有正效应、永远不过护栏检验。那样测出来的
    // 「连续口径误报率/检出率」只覆盖了一半的决策路径，是评测盲区而不是结论。
    // 每 6 个实验把偏移转一格，18 个实验正好覆盖 6 类 × 各类 2 次，且总数仍是 1/3。
    const block = Math.floor(i / 6);
    const { exp, rows } = buildExperiment(id, archetype, seed, days, {
      startDate: start,
      nameIndex: i,
      primaryMetric: (i + block) % 3 === 2 ? 'continuous' : 'rate',
    });
    experiments.push(exp);
    daily.push(...rows);
  });

  return {
    generatedAt: new Date().toISOString(),
    seedBase,
    groundTruth: true,
    spec: {
      days,
      preDays: days,
      baselineDaySd: BASELINE_DAY_SD,
      baselineDeviceSd: BASELINE_DEVICE_SD,
      aovMean: 75,
      aovLogSd: AOV_LOG_SD,
      aovArmSd: AOV_ARM_SD,
      segments: ['device', 'tenure'],
      baselineRate: [0.045, 0.06],
      refundRate: 0.012,
      complaintRate: 0.0012,
      latencyMean: 820,
      latencySd: 18,
    },
    experiments,
    daily,
  };
}
