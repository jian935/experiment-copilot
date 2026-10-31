import type { Archetype, DailyRow, Dataset, Decision, Device, Experiment, Tenure } from './types.ts';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
    const rng = mulberry32(seed);
    const cfg = CFG[archetype];
    const id = `E${String(i + 1).padStart(3, '0')}`;
    const p0 = 0.045 + 0.015 * rng();
    const refundBase = 0.012;
    const complaintBase = 0.0012;
    const latencyMean = 820;

    const trueLiftOverall = cfg.liftNew * cfg.newShare + cfg.liftOld * (1 - cfg.newShare);
    const exp: Experiment = {
      id,
      name: NAMES[i % NAMES.length],
      hypothesis: HYPOTHESES[i % HYPOTHESES.length],
      startDate: isoDate(start, 0),
      endDate: isoDate(start, days - 1),
      variants: ['control', 'treatment'],
      trafficSplit: `${Math.round((1 - cfg.ratio) * 100)}/${Math.round(cfg.ratio * 100)}`,
      primaryMetric: '支付转化率',
      metricType: 'binary',
      guardrailMetrics: ['退款率', '投诉率'],
      archetype,
      trueLift: archetype === 'heterogeneous' ? cfg.liftNew : trueLiftOverall,
      trueLiftScope: archetype === 'heterogeneous' ? 'new_users' : 'overall',
      trueLiftOverall,
      trueDecision: cfg.decision,
      seed,
    };
    experiments.push(exp);

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
            const p = Math.min(0.95, Math.max(0.001, p0 + (variant === 'treatment' ? lift : 0)));
            const c = binomial(n, p, rng);
            const refundP = Math.min(0.2, refundBase + (variant === 'treatment' ? cfg.refundDiff : 0));
            const refunds = binomial(n, refundP, rng);
            const complaints = poisson(n * complaintBase, rng);
            daily.push({
              expId: id,
              date: isoDate(start, d),
              variant,
              device,
              tenure,
              exposures: n,
              conversions: c,
              refunds,
              complaints,
              latencyP95: Math.round(latencyMean + 18 * randn(rng)),
            });
          }
        }
      }
    }
  });

  return {
    generatedAt: new Date().toISOString(),
    seedBase,
    spec: {
      days,
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
