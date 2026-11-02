/**
 * 去极值（winsorize）的证据产出。**先说结论：这组数字否掉了「截尾让结论更可信」这个直觉**，
 * 而否掉它的过程本身才是这个功能的全部价值。
 *
 *   ① **长尾让点估计变飘，但不让你误报**：κ 从 1 到 200，点估计的平均绝对偏差
 *      从 0.60 元涨到 1.76 元（MSE 0.56 → 4.89），而原始 delta method 的 95% 覆盖
 *      始终在 94.7%–96.7% —— 长尾的真实后果是「数字飘、测不出来」，
 *      不是「区间骗你」。这个区别决定了该修的是功效，不是显著性。
 *   ② **「截尾后更显著」是换假设换来的**：截尾把 MSE 压到 1/4（4.89 → 1.23），
 *      同时把检出率从 3.67% 抬到 68.67% —— 但它的区间覆盖率只剩 20.67%（名义 95%）。
 *      也就是说那些「检出」大多不是检出 ARPU 差，而是检出「截尾后的 ARPU 差」。
 *      所以截尾只能回答「换个口径结论还在不在」，不能当成第二次显著性检验。
 *   ③ **粒度决定截尾有没有用**：同一批用户，一行一个人时截尾把偏差降 54.9%，
 *      一行 5 个人只剩 12.9%，一行 50 个人只剩 3.0%。这是面板底部
 *      「截尾单位 = 你的数据粒度」那句话的硬证据，不是免责声明。
 *
 * 关键的实验设计：**保持均值不变，只改长尾权重**。
 * 如果让 κ 变大时均值也跟着涨，测到的差异就分不清是「长尾更重」还是「ARPU 更高」，不可归因。
 * 所以每换一个 κ，都把基础金额 A 重新标定到同一个目标 ARPU（3.6 元）。
 *
 * 数据全部由确定性 PRNG 生成（同 seed 同输出），不依赖任何私有数据。
 *
 * 用法：
 *   npm run robust                # 300 次/档，写 data/robust_report.json
 *   npm run robust -- --dry       # 只打印（CI 用）
 *   npm run robust -- --trials 800
 */
import { writeFileSync } from 'node:fs';
import { normalInv, mulberry32, ratioTest } from '../src/lib/stats.ts';
import { concentrationOf, winsorizeCells, type RobustCell } from '../src/lib/robust.ts';

export interface RobustRow {
  /** 长尾倍数：1% 的重度用户（付费用户里的 12.5%）消费是普通付费用户的 κ 倍 */
  kappa: number;
  /** 点估计的平均绝对偏差（元） */
  biasAbs: number;
  biasAbsTrim: number;
  /** 均方误差（元²）：偏差² + 方差，衡量「点估计到底准不准」 */
  mseRaw: number;
  mseTrim: number;
  /** 95% 区间覆盖真值的比例（名义 95%） */
  coverRaw: number;
  coverTrim: number;
  /** 真效应为 0 时的误报率（名义 5%） */
  falseSigRaw: number;
  falseSigTrim: number;
  /** 最重的 1% 曝光贡献了多少收入（用户级粒度下即「最富的 1% 用户」） */
  topShare1: number;
  gini: number;
}

export interface RobustReport {
  generatedAt: string;
  trials: number;
  usersPerArm: number;
  alpha: number;
  seed: number;
  params: {
    /** 付费率 */
    payerRate: number;
    /** 付费用户里属于重度用户的比例（8% × 12.5% = 全体用户的 1%） */
    whaleShareOfPayers: number;
    /** 目标 ARPU（元）——每换一个 κ 都重新标定到这个值 */
    arpuTarget: number;
    /** 订单金额的对数标准差 */
    sigma: number;
    /** 截尾比例 */
    trimP: number;
  };
  /** ① 长尾下的推断表现（真效应 = 0，用户级粒度） */
  tail: RobustRow[];
  /** ② 真效应 +3% 时的检出率：「截尾后更显著」到底来自哪里 */
  power: Array<{
    kappa: number;
    lift: number;
    detectRaw: number;
    detectTrim: number;
    /** 同一档位下截尾口径的区间覆盖率 —— 用来提醒「买回的功效不是免费的」 */
    coverTrim: number;
  }>;
  /** ③ 粒度决定截尾有没有用（κ = 200 的重尾数据） */
  granularity: Array<{
    perCell: number;
    rowsPerArm: number;
    kappa: number;
    biasAbsRaw: number;
    biasAbsTrim: number;
    coverRaw: number;
    coverTrim: number;
    /** 截尾后点估计的绝对偏差降低了多少（相对原始） */
    biasGain: number;
  }>;
}

const KAPPAS = [1, 10, 50, 200];
const ALPHA = 0.05;
const SEED = 20261105;

interface SimParams {
  usersPerArm: number;
  perCell: number;
  lift: number;
  kappa: number;
  payerRate: number;
  whaleShare: number;
  arpuTarget: number;
  sigma: number;
}

/**
 * 一次试验：生成两臂的用户收入并折成格子。
 *
 * 真值用解析式算，不从模拟里估 —— 用模拟估真值会把「估真值的误差」混进偏差里，
 * 那个偏差就不再是估计量的偏差了。
 *
 * E[每用户收入] = p_pay · A · e^{σ²/2} · (1 + w(κ−1))
 * 所以要让 ARPU 命中目标值，基础金额 A = target / (p_pay · e^{σ²/2} · (1 + w(κ−1)))。
 */
function simulate(rng: () => number, p: SimParams): { cells: RobustCell[]; truth: number } {
  const m = Math.exp((p.sigma * p.sigma) / 2);
  const a = p.arpuTarget / (p.payerRate * m * (1 + p.whaleShare * (p.kappa - 1)));
  const drawUser = (isTreatment: boolean): number => {
    if (rng() >= p.payerRate) return 0;
    // 标准正态：Box–Muller 太慢，用逆 CDF（Acklam 有理逼近，单次调用 ~几十 ns）
    const u = Math.min(1 - 1e-12, Math.max(1e-12, rng()));
    const z = normalInv(u);
    const heavy = rng() < p.whaleShare ? p.kappa : 1;
    const v = a * heavy * Math.exp(p.sigma * z);
    return isTreatment ? v * (1 + p.lift) : v;
  };

  const cells: RobustCell[] = [];
  for (const isT of [false, true]) {
    for (let row = 0; row * p.perCell < p.usersPerArm; row++) {
      let sum = 0;
      let n = 0;
      for (let i = 0; i < p.perCell; i++) {
        sum += drawUser(isT);
        n++;
      }
      cells.push({ n, sum, treatment: isT, label: `${isT ? 'T' : 'C'}${row}` });
    }
  }
  return { cells, truth: p.arpuTarget * p.lift };
}

/** 跑一组参数，返回统计量 */
function measure(trials: number, p: SimParams, trimP: number, seed: number) {
  const rng = mulberry32(seed);
  let bias = 0;
  let biasAbsRaw = 0;
  let biasAbsTrim = 0;
  let sqRaw = 0;
  let sqTrim = 0;
  let coverRaw = 0;
  let coverTrim = 0;
  let sigRaw = 0;
  let sigTrim = 0;
  let top1 = 0;
  let gini = 0;
  let used = 0;
  for (let t = 0; t < trials; t++) {
    const { cells, truth } = simulate(rng, p);
    const raw = ratioTest(cells);
    if (!raw) continue;
    const trim = ratioTest(winsorizeCells(cells, 0, trimP).cells);
    used++;
    bias += raw.diff - truth;
    biasAbsRaw += Math.abs(raw.diff - truth);
    sqRaw += (raw.diff - truth) ** 2;
    if (trim) {
      biasAbsTrim += Math.abs(trim.diff - truth);
      sqTrim += (trim.diff - truth) ** 2;
    }
    if (raw.ci95[0] <= truth && truth <= raw.ci95[1]) coverRaw++;
    if (trim && trim.ci95[0] <= truth && truth <= trim.ci95[1]) coverTrim++;
    if (raw.p < ALPHA) sigRaw++;
    if (trim && trim.p < ALPHA) sigTrim++;
    const cc = concentrationOf(cells);
    top1 += cc.top[0]?.revenueShare ?? 0;
    gini += cc.gini;
  }
  const d = Math.max(1, used);
  return {
    bias: bias / d,
    biasAbsRaw: biasAbsRaw / d,
    biasAbsTrim: biasAbsTrim / d,
    mseRaw: sqRaw / d,
    mseTrim: sqTrim / d,
    coverRaw: coverRaw / d,
    coverTrim: coverTrim / d,
    sigRaw: sigRaw / d,
    sigTrim: sigTrim / d,
    topShare1: top1 / d,
    gini: gini / d,
  };
}

export function runRobustReport(trials = 300, usersPerArm = 1200): RobustReport {
  const params: RobustReport['params'] = {
    payerRate: 0.08,
    whaleShareOfPayers: 0.125,
    arpuTarget: 3.6,
    sigma: 0.9,
    trimP: 0.01,
  };
  const base = {
    usersPerArm,
    payerRate: params.payerRate,
    whaleShare: params.whaleShareOfPayers,
    arpuTarget: params.arpuTarget,
    sigma: params.sigma,
  };

  // ① 真效应 = 0：长尾对区间与误报率的影响
  const tail: RobustRow[] = KAPPAS.map((kappa, i) => {
    const m = measure(trials, { ...base, perCell: 1, lift: 0, kappa }, params.trimP, SEED + i * 17);
    return {
      kappa,
      bias: m.bias,
      biasAbs: m.biasAbsRaw,
      biasAbsTrim: m.biasAbsTrim,
      mseRaw: m.mseRaw,
      mseTrim: m.mseTrim,
      coverRaw: m.coverRaw,
      coverTrim: m.coverTrim,
      falseSigRaw: m.sigRaw,
      falseSigTrim: m.sigTrim,
      topShare1: m.topShare1,
      gini: m.gini,
    };
  });

  // ② 真效应 +3%：长尾吃掉多少功效，截尾买回多少（顺带记下买回它的代价）
  const power = KAPPAS.map((kappa, i) => {
    const m = measure(trials, { ...base, perCell: 1, lift: 0.03, kappa }, params.trimP, SEED + 100 + i * 19);
    return { kappa, lift: 0.03, detectRaw: m.sigRaw, detectTrim: m.sigTrim, coverTrim: m.coverTrim };
  });

  // ③ 粒度：同一批用户，只改每行装多少人
  const heavy = KAPPAS[KAPPAS.length - 1];
  const granularity = [1, 5, 50].map((perCell, i) => {
    const m = measure(
      Math.max(80, Math.round(trials / 2)),
      { ...base, perCell, lift: 0, kappa: heavy },
      params.trimP,
      SEED + 200 + i * 23,
    );
    return {
      perCell,
      rowsPerArm: Math.ceil(usersPerArm / perCell),
      kappa: heavy,
      biasAbsRaw: m.biasAbsRaw,
      biasAbsTrim: m.biasAbsTrim,
      coverRaw: m.coverRaw,
      coverTrim: m.coverTrim,
      biasGain: m.biasAbsRaw > 0 ? 1 - m.biasAbsTrim / m.biasAbsRaw : 0,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    trials,
    usersPerArm,
    alpha: ALPHA,
    seed: SEED,
    params,
    tail,
    power,
    granularity,
  };
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const yuan = (v: number) => `${v >= 0 ? '' : ''}${v.toFixed(3)}`;
const isDirect = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/robust_report.ts');

if (isDirect) {
  const dry = process.argv.includes('--dry');
  const ti = process.argv.indexOf('--trials');
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const trials = ti >= 0 ? Number(process.argv[ti + 1]) : Number(positional[0] ?? 300);
  if (!Number.isFinite(trials) || trials <= 0) {
    console.error(`模拟次数必须是正整数，收到「${trials}」`);
    process.exit(1);
  }
  const t0 = Date.now();
  const r = runRobustReport(trials);
  const json = `${JSON.stringify(r, null, 2)}\n`;
  if (!dry) {
    writeFileSync('data/robust_report.json', json);
    try {
      writeFileSync('public/data/robust_report.json', json);
    } catch {
      console.log('（public/data/ 不存在，跳过前端副本）');
    }
  }

  console.log(`\n① 长尾下的推断表现（真效应 = 0，${r.trials} 次/档，每臂 ${r.usersPerArm} 用户，用户级粒度）`);
  console.log('─'.repeat(104));
  console.log('  κ      |偏差|原始  |偏差|截尾   MSE 原始→截尾      95%覆盖 原始→截尾    误报 原始→截尾    前1%收入  Gini');
  for (const t of r.tail) {
    console.log(
      `  ${String(t.kappa).padEnd(6)} ${yuan(t.biasAbs).padEnd(12)} ${yuan(t.biasAbsTrim).padEnd(13)} ` +
        `${`${t.mseRaw.toFixed(2)} → ${t.mseTrim.toFixed(2)}`.padEnd(22)} ${`${pct(t.coverRaw)} → ${pct(t.coverTrim)}`.padEnd(20)} ` +
        `${`${pct(t.falseSigRaw)} → ${pct(t.falseSigTrim)}`.padEnd(20)} ${pct(t.topShare1).padEnd(9)} ${t.gini.toFixed(3)}`,
    );
  }
  console.log('  κ=1 是没有长尾的对照组：这一行「覆盖 原始→截尾」的差，就是截尾在干净数据上白付的代价。');

  console.log(`\n② 「截尾后更显著」的真实来源（真效应 +${(r.power[0].lift * 100).toFixed(0)}% 相对提升）`);
  console.log('─'.repeat(104));
  console.log('  κ      检出率 原始   检出率 截尾1%    变化        截尾口径的 95% 覆盖   ← 这一列说明变化是不是真的');
  for (const p of r.power) {
    const d = (p.detectTrim - p.detectRaw) * 100;
    console.log(
      `  ${String(p.kappa).padEnd(6)} ${pct(p.detectRaw).padEnd(13)} ${pct(p.detectTrim).padEnd(14)} ` +
        `${`${d >= 0 ? '+' : ''}${d.toFixed(1)} 个点`.padEnd(11)} ${pct(p.coverTrim)}`,
    );
  }
  console.log('  ⚠ 截尾口径的检出率涨得越多，覆盖率掉得越狠：它检验的是「截尾后的差」，不是 ARPU 差。');
  console.log('    所以截尾只能回答「换个口径结论还在不在」，不能当成「更可信的显著性」。');

  console.log(`\n③ 粒度决定截尾有没有用（κ=${KAPPAS[KAPPAS.length - 1]}，同一批用户，只改每行装多少人）`);
  console.log('─'.repeat(104));
  console.log('  每行人数  行数/臂   点估计 |偏差| 原始→截尾      偏差降低   95% 覆盖 原始→截尾');
  for (const g of r.granularity) {
    console.log(
      `  ${String(g.perCell).padEnd(9)} ${String(g.rowsPerArm).padEnd(9)} ` +
        `${`${yuan(g.biasAbsRaw)} → ${yuan(g.biasAbsTrim)}`.padEnd(24)} ${`${(g.biasGain * 100).toFixed(1)}%`.padEnd(10)} ` +
        `${pct(g.coverRaw)} → ${pct(g.coverTrim)}`,
    );
  }
  console.log(`\n  耗时 ${Date.now() - t0}ms → ${dry ? '（--dry，未写文件）' : 'data/robust_report.json'}\n`);
}
