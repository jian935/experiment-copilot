/**
 * A/B/n 的证据产出：三个数字，各自回答一个不同的问题。
 *
 *   ① **全零族误报率**：k 个臂全部无效时，「至少有一个臂被判显著」的比例。
 *      naive（每臂各自按 α=0.05 判）应 ≈ 1−0.95^(k−1)；Dunnett 应 ≈ α。
 *      这是「为什么不能多跑几次两臂检验」的定量依据。
 *   ② **赢家识别率**：真的有一个臂更好时，三种做法（点估计最大 / P(best) 最大 /
 *      校正后显著且点估计最大）选对的概率。回答「Dunnett 会让实验更容易失败吗」。
 *   ③ **P(best) 校准**：说 70% 最优的臂，实际有 70% 的试验里它确实最优吗。
 *      这个数字不对，P(best) 就只是好看的百分比。
 *
 * 数据全部由确定性 PRNG 生成（同 seed 同输出），所以这些数字是可复现的，
 * 不依赖任何私有数据。
 *
 * 用法：
 *   npm run multiarm               # 20000 次，写 data/multiarm_report.json
 *   npm run multiarm -- --dry      # 只打印（CI 用）
 *   npm run multiarm -- --trials 50000
 */
import { writeFileSync } from 'node:fs';
import { dunnettCritEqual, probabilityBest } from '../src/lib/multiarm.ts';
import { normalCdf, normalInv } from '../src/lib/stats.ts';

export interface MultiArmReport {
  generatedAt: string;
  trials: number;
  alpha: number;
  /** 等样本、等方差 + 共享对照 ⇒ ρ = 0.5 */
  rho: number;
  fwer: Array<{
    arms: number;
    comparisons: number;
    naive: number;
    naiveTheory: number;
    dunnett: number;
    bonferroni: number;
    crit: number;
    bonferroniCrit: number;
  }>;
  selection: Array<{
    /** 每臂真实提升（相对基线，arm1 有效、其余为零） */
    lift: number;
    /** 效应量 λ = Δ/SE，SE 取 n=8000/臂 的规模 */
    lambda: number;
    pickMaxPoint: number;
    pickMaxBest: number;
    pickMaxSignificant: number;
    /** 全零时「挑最大」会虚高多少（pp） */
    cursePP: number | null;
  }>;
  calibration: Array<{
    /** 每臂真实提升 */
    lift: number;
    /**
     * 被选中臂给出的平均置信度（mean of max P(best)）。
     * 这是「预测的概率」，要与它自己的命中率比才有意义。
     */
    stated: number;
    /** 实测「被选中的那个臂确实是最优」的频率 —— 也就是上面那个概率的真实命中率 */
    actual: number;
  }>;
  /**
   * 全零族（真的没有任何差异）时，被选中臂的平均置信度。
   * 这个数一定远大于 50%——因为「最大值」总是存在。它说明 P(best) 不能单独当证据。
   */
  nullMaxProb: number;
}

/** mulberry32：32 位确定性 PRNG，同 seed 逐位可复现 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller：u1/u2 已在外层生成，避免每次创建数组 */
function gauss(u1: number, u2: number): number {
  return Math.sqrt(-2 * Math.log(Math.max(u1, 1e-12))) * Math.cos(2 * Math.PI * u2);
}

const P1 = 0.05;
const N_PER_ARM = 8000;

/** 基线率 p1、每臂 n、真实相对提升 lift 下的差异标准误（pp） */
function sePP(p1: number, n: number, lift: number): number {
  const p2 = p1 * (1 + lift);
  return Math.sqrt((p1 * (1 - p1)) / n + (p2 * (1 - p2)) / n) * 100;
}

export function runMultiArmReport(trials = 20_000, seed = 20260301): MultiArmReport {
  const alpha = 0.05;
  const rho = 0.5;

  // ── ① 全零族误报率 ──
  const fwer: MultiArmReport['fwer'] = [];
  for (const arms of [2, 3, 4, 5]) {
    const m = arms - 1;
    const crit = dunnettCritEqual(alpha, arms, rho);
    const bonf = normalInv(1 - alpha / (2 * m));
    const rand = rng(seed + arms * 7919);
    const naiveCrit = normalInv(1 - alpha / 2);
    let naiveHit = 0;
    let dHit = 0;
    let bHit = 0;
    for (let t = 0; t < trials; t++) {
      const u = gauss(rand(), rand());
      let maxAbs = 0;
      for (let i = 0; i < m; i++) {
        const z = Math.sqrt(rho) * u + Math.sqrt(1 - rho) * gauss(rand(), rand());
        maxAbs = Math.max(maxAbs, Math.abs(z));
      }
      if (maxAbs > naiveCrit) naiveHit++;
      if (maxAbs > crit) dHit++;
      if (maxAbs > bonf) bHit++;
    }
    fwer.push({
      arms,
      comparisons: m,
      naive: naiveHit / trials,
      naiveTheory: 1 - Math.pow(1 - alpha, m),
      dunnett: dHit / trials,
      bonferroni: bHit / trials,
      crit,
      bonferroniCrit: bonf,
    });
  }

  // ── ② 赢家识别率 ──
  const selection: MultiArmReport['selection'] = [];
  const calibration: MultiArmReport['calibration'] = [];
  let nullMaxProb = 0;
  for (const lift of [0, 0.05, 0.1, 0.2]) {
    const arms = 3;
    const m = arms - 1;
    const crit = dunnettCritEqual(alpha, arms, rho);
    const se = sePP(P1, N_PER_ARM, lift);
    const deltaPP = P1 * lift * 100;
    const lambda = se > 0 ? deltaPP / se : 0;
    const rand = rng(seed + Math.round(lift * 1000) * 131);
    let pickPoint = 0;
    let pickBest = 0;
    let pickSig = 0;
    let maxSum = 0;
    let statedSum = 0;

    for (let t = 0; t < trials; t++) {
      // 三个处理臂：第 0 个有真实效应 lambda，其余为 0；共享对照 ⇒ 相关性 rho
      const u = gauss(rand(), rand());
      const z: number[] = [];
      for (let i = 0; i < m; i++) {
        const base = Math.sqrt(rho) * u + Math.sqrt(1 - rho) * gauss(rand(), rand());
        z.push(base + (i === 0 ? lambda : 0));
      }
      let bestIdx = 0;
      for (let i = 1; i < m; i++) if (z[i] > z[bestIdx]) bestIdx = i;
      if (bestIdx === 0) pickPoint++;

      // P(best)：入参是差值估计与 SE。这里用 z 单位（se=1），结论与用 pp 一致
      const pbest = probabilityBest({
        estimate: z.slice(),
        se: z.map(() => 1),
        label: z.map((_, i) => (i === 0 ? 'win' : `arm${i}`)),
      });
      const bestByProb = pbest.bestIndex;
      if (bestByProb === 0) pickBest++;
      // 校准看的是「被选中臂给出的置信度」与「它真的选中了最优」的命中率
      statedSum += pbest.bestProb;

      // 决策口径：校正后显著里点估计最大的那个；一个都不显著 → 不选
      const sig = z.map((v, i) => ({ v, i })).filter((x) => x.v > crit);
      if (sig.length) {
        const top = sig.reduce((a, b) => (b.v > a.v ? b : a));
        if (top.i === 0) pickSig++;
      }

      maxSum += Math.max(...z);
    }

    selection.push({
      lift,
      lambda,
      pickMaxPoint: pickPoint / trials,
      pickMaxBest: pickBest / trials,
      pickMaxSignificant: pickSig / trials,
      cursePP: lift === 0 ? (maxSum / trials) * se : null,
    });
    // 全零族下「谁最优」本身无定义，所以那一行不进校准表，只留一个「最大值有多高」的数
    if (lift === 0) {
      nullMaxProb = statedSum / trials;
    } else {
      calibration.push({ lift, stated: statedSum / trials, actual: pickPoint / trials });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    trials,
    alpha,
    rho,
    fwer,
    selection,
    calibration,
    nullMaxProb,
  };
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const isDirect = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/multiarm_report.ts');

if (isDirect) {
  const dry = process.argv.includes('--dry');
  const ti = process.argv.indexOf('--trials');
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const trials = ti >= 0 ? Number(process.argv[ti + 1]) : Number(positional[0] ?? 20_000);
  if (!Number.isFinite(trials) || trials <= 0) {
    console.error(`模拟次数必须是正整数，收到「${trials}」`);
    process.exit(1);
  }
  const t0 = Date.now();
  const r = runMultiArmReport(trials);
  const json = `${JSON.stringify(r, null, 2)}\n`;
  if (!dry) {
    writeFileSync('data/multiarm_report.json', json);
    try {
      writeFileSync('public/data/multiarm_report.json', json);
    } catch {
      console.log('（public/data/ 不存在，跳过前端副本）');
    }
  }

  console.log(`\n① 全零族误报率（${r.trials} 次，ρ=${r.rho}，α=${r.alpha}）——「至少一个臂被判显著」`);
  console.log('─'.repeat(78));
  console.log('  臂数  比较  naive(实测)   naive(理论)    Dunnett    Bonferroni   临界 z  vs  Bonf z');
  for (const f of r.fwer) {
    console.log(
      `  ${String(f.arms).padEnd(5)} ${String(f.comparisons).padEnd(5)} ${pct(f.naive).padEnd(13)} ${pct(f.naiveTheory).padEnd(13)} ${pct(f.dunnett).padEnd(10)} ${pct(f.bonferroni).padEnd(13)} ${f.crit.toFixed(3)}  vs  ${f.bonferroniCrit.toFixed(3)}`,
    );
  }

  console.log(`\n② 赢家识别率（3 臂，每臂 n=${N_PER_ARM}，基线 ${(P1 * 100).toFixed(1)}%）`);
  console.log('─'.repeat(78));
  console.log('  真实提升  λ=Δ/SE   挑点估计最大  挑 P(best) 最大   校正后显著里挑最大');
  for (const s of r.selection) {
    console.log(
      `  ${`${(s.lift * 100).toFixed(0)}%`.padEnd(9)} ${s.lambda.toFixed(2).padEnd(9)} ${pct(s.pickMaxPoint).padEnd(13)} ${pct(s.pickMaxBest).padEnd(17)} ${pct(s.pickMaxSignificant)}`,
    );
  }
  console.log('  注：等方差时 P(best) 的排序与点估计完全一致（单调变换），所以两列必然相同；');
  console.log('      它的价值不是「选得更准」，而是把「准不准」变成一个可读的概率刻度。');
  console.log('      「校正后显著里挑最大」= 敢下结论的比例，代价是不显著的实验会说不出话。');
  const curse = r.selection.find((s) => s.cursePP !== null)?.cursePP ?? null;
  if (curse !== null) {
    console.log(`  全零时「挑最大」平均虚高 ${curse.toFixed(3)}pp —— 这就是赢家诅咒，不是效应。`);
  }

  console.log(`\n③ P(best) 校准：说 76% 就该有 76% 的时候真的选中最优`);
  console.log('─'.repeat(78));
  for (const c of r.calibration) {
    const gap = (c.stated - c.actual) * 100;
    console.log(
      `  真实提升 ${`${(c.lift * 100).toFixed(0)}%`.padEnd(6)} 平均置信度=${pct(c.stated).padEnd(9)} 实际命中=${pct(c.actual).padEnd(9)} 偏差 ${gap >= 0 ? '+' : ''}${gap.toFixed(2)} 个点`,
    );
  }
  console.log(`  全零族下平均置信度仍有 ${pct(r.nullMaxProb)} —— 各臂完全等价时「最大值」也总存在，`);
  console.log('  所以 P(best) 单独看没有任何证明力，必须配全局检验（或校正后 p）一起读。');
  console.log('  有真实效应时置信度系统性偏低 = 偏保守，因为先验不假设「必有一个臂更好」——这是后验该有的样子。');
  console.log(`\n  耗时 ${Date.now() - t0}ms → ${dry ? '（--dry，未写文件）' : 'data/multiarm_report.json'}\n`);
}
