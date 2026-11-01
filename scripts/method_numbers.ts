/**
 * H1 方法论长文背后的数字：全部当场跑，不引用记忆里的值。
 *
 * 输出 `docs/METHODOLOGY.md` 引用的每一个统计量，便于逐条复核：
 *   1. Wald vs Newcombe 的覆盖率（含零事件这个极端情形）
 *   2. BH 的 FDR 与功效（相对 Holm / Bonferroni），q=0.05 vs 0.1
 *   3. P(B>A) 的正态近似误差（对照 Beta 的精确概率）
 *   4. 护栏三种口径的检出率 / 误报率
 *
 * 全部固定种子，`npm run method` 重跑结果逐位一致。
 */

import { DEFAULT_CONFIG } from '../src/lib/config.ts';
import { analyze } from '../src/lib/decide.ts';
import { generateDataset } from '../src/lib/simulate.ts';
import {
  bhAdjust,
  bonferroniAdjust,
  holmAdjust,
  mulberry32,
  normalCdf,
  guardrailBlocks,
  nonInferiority,
  newcombeDiffCI,
} from '../src/lib/stats.ts';

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;

/**
 * 精确二项抽样（逆 CDF）。
 *
 * 第一版用了「均值 < 30 就走泊松」的简化，结果 p=0.5、n=30 那格方差差一倍
 * （泊松方差 = np = 15，真实是 np(1−p) = 7.5），覆盖率被算成 76% —— 假数字。
 * 覆盖率模拟对抽样精度是零容忍的，所以这里建一次 CDF，之后二分取样。
 */
const cdfCache = new Map<string, number[]>();
function binomialCdf(n: number, p: number): number[] {
  const key = `${n}:${p}`;
  const hit = cdfCache.get(key);
  if (hit) return hit;
  const cdf = new Array<number>(n + 2).fill(0);
  // 用对数概率递推，避免 n=20000、p=0.5 时的中间量溢出
  const lp0 = n * Math.log(1 - p);
  let lp = lp0;
  let maxLp = -Infinity;
  const lps = new Array<number>(n + 1);
  for (let k = 0; k <= n; k++) {
    if (k > 0) lp += Math.log((n - k + 1) / k) + Math.log(p) - Math.log(1 - p);
    lps[k] = lp;
    if (lp > maxLp) maxLp = lp;
  }
  let acc = 0;
  for (let k = 0; k <= n; k++) {
    acc += Math.exp(lps[k] - maxLp);
    cdf[k] = acc;
  }
  for (let k = 0; k <= n; k++) cdf[k] /= acc;
  cdf[n + 1] = 1;
  cdfCache.set(key, cdf);
  return cdf;
}

function binomial(n: number, p: number, rng: () => number): number {
  if (p <= 0) return 0;
  if (p >= 1) return n;
  const cdf = binomialCdf(n, p);
  const u = rng();
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < u) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 教科书 Wald 差值区间（不使用连续性校正） */
function waldDiffCI(c1: number, n1: number, c2: number, n2: number, z = 1.96): [number, number] {
  const p1 = n1 > 0 ? c1 / n1 : 0;
  const p2 = n2 > 0 ? c2 / n2 : 0;
  const se = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  const d = p2 - p1;
  return [d - z * se, d + z * se];
}

// ============ 1. 覆盖率 ============

/**
 * 小样本格点用**精确枚举**：n=30 时只有 31×31=961 个可能结果，
 * 按二项概率加权求和就是真实覆盖率，不需要抽样。
 * （抽样版在 n=30 的格点上与枚举差 0.5pp 以内，但既然能算准就不该凑。）
 */
function coverageExact(p1: number, p2: number, n1: number, n2: number): Coverage {
  const truth = p2 - p1;
  const pr1 = new Array<number>(n1 + 1);
  const pr2 = new Array<number>(n2 + 1);
  for (let c = 0; c <= n1; c++) pr1[c] = comb(n1, c) * p1 ** c * (1 - p1) ** (n1 - c);
  for (let c = 0; c <= n2; c++) pr2[c] = comb(n2, c) * p2 ** c * (1 - p2) ** (n2 - c);
  let hitW = 0;
  let hitN = 0;
  let wW = 0;
  let wN = 0;
  for (let c1 = 0; c1 <= n1; c1++) {
    for (let c2 = 0; c2 <= n2; c2++) {
      const w = pr1[c1] * pr2[c2];
      const [wl, wu] = waldDiffCI(c1, n1, c2, n2);
      const [nl, nu] = newcombeDiffCI(c1, n1, c2, n2);
      if (wl <= truth && truth <= wu) hitW += w;
      if (nl <= truth && truth <= nu) hitN += w;
      wW += w * (wu - wl);
      wN += w * (nu - nl);
    }
  }
  return {
    cell: `p=${(p1 * 100).toFixed(2)}% n=${n1}`,
    wald: hitW,
    newcombe: hitN,
    waldWidth: wW,
    newcombeWidth: wN,
  };
}

function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}



interface Coverage {
  cell: string;
  wald: number;
  newcombe: number;
  waldWidth: number;
  newcombeWidth: number;
}

function coverage(p1: number, p2: number, n1: number, n2: number, trials = 4000, seed = 7): Coverage {
  const rng = mulberry32(seed);
  const truth = p2 - p1;
  let hitW = 0;
  let hitN = 0;
  let wW = 0;
  let wN = 0;
  for (let i = 0; i < trials; i++) {
    const c1 = binomial(n1, p1, rng);
    const c2 = binomial(n2, p2, rng);
    const [wl, wu] = waldDiffCI(c1, n1, c2, n2);
    const [nl, nu] = newcombeDiffCI(c1, n1, c2, n2);
    if (wl <= truth && truth <= wu) hitW++;
    if (nl <= truth && truth <= nu) hitN++;
    wW += wu - wl;
    wN += nu - nl;
  }
  return {
    cell: `p=${(p1 * 100).toFixed(2)}% n=${n1}`,
    wald: hitW / trials,
    newcombe: hitN / trials,
    waldWidth: wW / trials,
    newcombeWidth: wN / trials,
  };
}

console.log('='.repeat(78));
console.log('1. 差值 95% CI 的覆盖率（null 下 p1=p2；n≤1000 精确枚举，n=20000 蒙特卡洛 4000 次）');
console.log('='.repeat(78));
console.log('cell'.padEnd(26), 'Wald'.padStart(8), 'Newcombe'.padStart(10), '宽度 W/N'.padStart(16));
const grid: Coverage[] = [];
for (const p of [0.0012, 0.012, 0.05, 0.2, 0.5]) {
  for (const n of [30, 100, 20000]) {
    // n=20000 枚举不动（4 亿个格子），只有这一格用蒙特卡洛
    const r = n <= 1000 ? coverageExact(p, p, n, n) : coverage(p, p, n, n);
    grid.push(r);
    console.log(
      r.cell.padEnd(26),
      pct(r.wald).padStart(8),
      pct(r.newcombe).padStart(10),
      `${(r.waldWidth * 100).toFixed(3)}/${(r.newcombeWidth * 100).toFixed(3)}`.padStart(16),
    );
  }
}

// 零事件：n=20000 但一次都没发生
{
  const n = 20000;
  const trials = 2000;
  const rng = mulberry32(99);
  let hitW = 0;
  let hitN = 0;
  let zeroBoth = 0;
  const pTrue = 0.00004; // 20k × 4e-5 ≈ 0.8 次
  for (let i = 0; i < trials; i++) {
    const c1 = binomial(n, pTrue, rng);
    const c2 = binomial(n, pTrue, rng);
    if (c1 === 0 && c2 === 0) zeroBoth++;
    const [wl, wu] = waldDiffCI(c1, n, c2, n);
    const [nl, nu] = newcombeDiffCI(c1, n, c2, n);
    if (wl <= 0 && 0 <= wu) hitW++;
    if (nl <= 0 && 0 <= nu) hitN++;
  }
  console.log(
    `\n零事件情形（p=0.004%、n=20000，${trials} 次里 ${zeroBoth} 次两臂都是 0）：`,
    `Wald 覆盖率 ${pct(hitW / trials)}，Newcombe ${pct(hitN / trials)}`,
  );
  const [wl, wu] = waldDiffCI(0, n, 0, n);
  const [nl, nu] = newcombeDiffCI(0, n, 0, n);
  console.log(`  两臂都 0 时：Wald = [${wl}, ${wu}]（宽度 0），Newcombe = [${(nl * 100).toFixed(4)}pp, ${(nu * 100).toFixed(4)}pp]`);
}

// 真实 A/B 口径（退款率量级）
{
  const r = coverage(0.0119, 0.0124, 20000, 20000, 4000, 11);
  console.log(
    `\n真实口径（1.19% vs 1.24%，每臂 2 万）：Wald ${pct(r.wald)} / Newcombe ${pct(r.newcombe)}，宽度 ${(r.waldWidth * 100).toFixed(3)}pp / ${(r.newcombeWidth * 100).toFixed(3)}pp`,
  );
}

// 结论真的会翻：找一个「Wald 说不跨 0、Newcombe 说跨 0」的格子
{
  console.log('\n同一个格子，两种区间给出相反结论的例子：');
  let shown = 0;
  for (const n of [50, 100, 200, 500]) {
    for (let c1 = 0; c1 <= n && shown < 3; c1++) {
      for (let c2 = c1; c2 <= n && shown < 3; c2++) {
        const [wl, wu] = waldDiffCI(c1, n, c2, n);
        const [nl, nu] = newcombeDiffCI(c1, n, c2, n);
        if (wl > 0 && nl <= 0) {
          console.log(
            `  n=${n}/臂，对照 ${c1} 次、处理 ${c2} 次：Wald [${(wl * 100).toFixed(2)}, ${(wu * 100).toFixed(2)}]pp（判「有提升」）` +
              ` vs Newcombe [${(nl * 100).toFixed(2)}, ${(nu * 100).toFixed(2)}]pp（判「证据不足」）`,
          );
          shown++;
        }
      }
    }
  }
  if (shown === 0) console.log('  （这一组网格里没有出现翻转）');
}

// ============ 2. BH：FDR 与功效 ============

console.log(`\n${'='.repeat(78)}`);
console.log('2. 多重比较：BH 控 FDR、Holm 控 FWER（200 次模拟 × 120 个检验，24 个为真）');
console.log('='.repeat(78));

function multiplicitySim(q: number, trials = 200, m = 120, nTrue = 24) {
  const rng = mulberry32(20261101);
  let fdp = 0;
  let power = 0;
  let holmPower = 0;
  let bonfPower = 0;
  let naivePower = 0;
  let naiveFdp = 0;
  let holmAny = 0;
  let naiveAny = 0;
  for (let t = 0; t < trials; t++) {
    const ps: number[] = [];
    const isTrue: boolean[] = [];
    for (let i = 0; i < m; i++) {
      const real = i < nTrue;
      isTrue.push(real);
      // 真效应：p 来自「功效约 0.8」的替代分布（等价于 z ~ N(2.8, 1)）
      const z = real ? 2.8 + gauss(rng) : gauss(rng);
      ps.push(2 * (1 - normalCdf(Math.abs(z))));
    }
    const bh = bhAdjust(ps, q);
    const holm = holmAdjust(ps, 0.05);
    const bonf = bonferroniAdjust(ps, 0.05);
    const rejected = bh.rejected.filter(Boolean).length;
    const falsePos = bh.rejected.filter((r, i) => r && !isTrue[i]).length;
    if (rejected > 0) fdp += falsePos / rejected;
    const trueHit = bh.rejected.filter((r, i) => r && isTrue[i]).length;
    power += trueHit / nTrue;
    holmPower += holm.rejected.filter((r, i) => r && isTrue[i]).length / nTrue;
    bonfPower += bonf.rejected.filter((r, i) => r && isTrue[i]).length / nTrue;
    // 不校正的口径：p < α 就拒。它的功效和假阳性率都要算出来，
    // 否则表格里那一行只能填「—」，读者会以为不校正更好
    const naiveRej = ps.map((p) => p < 0.05);
    const naiveHit = naiveRej.filter((r, i) => r && isTrue[i]).length;
    const naiveFalse = naiveRej.filter((r, i) => r && !isTrue[i]).length;
    naivePower += naiveHit / nTrue;
    if (naiveHit + naiveFalse > 0) naiveFdp += naiveFalse / (naiveHit + naiveFalse);
    if (holm.rejected.some(Boolean)) holmAny++;
    if (ps.some((p) => p < 0.05)) naiveAny++;
  }
  return {
    fdr: fdp / trials,
    naiveFdr: naiveFdp / trials,
    naivePower: naivePower / trials,
    power: power / trials,
    holmPower: holmPower / trials,
    bonfPower: bonfPower / trials,
    holmAny: holmAny / trials,
    naiveAny: naiveAny / trials,
  };
}

function gauss(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

const zero = multiplicitySim(0.1);
console.log(
  `不校正（p<0.05）: 实测 FDR ${pct(zero.naiveFdr)}（π₀=80%，理论 FDR = α·π₀/(α·π₀+功效) ）  功效 ${pct(zero.naivePower)}`,
);
for (const q of [0.05, 0.1, 0.2]) {
  const r = multiplicitySim(q);
  console.log(
    `BH q=${q}:  实测 FDR ${pct(r.fdr)}（上界 q·π₀ = ${pct(q * 0.8)}）  功效 ${pct(r.power)}  |  Holm 功效 ${pct(r.holmPower)}  Bonferroni 功效 ${pct(r.bonfPower)}`,
  );
}
{
  const r = multiplicitySim(0.1);
  console.log(`\n同一批数据上「至少拒掉一个」的比例：不校正 ${pct(r.naiveAny)} → Holm ${pct(r.holmAny)}`);
  const nullOnly = 1 - Math.pow(1 - 0.05, 120);
  console.log(`全零族理论上界 1−(1−0.05)^120 = ${pct(nullOnly, 2)}`);
}

// ============ 3. P(B>A) 的正态近似误差 ============

console.log(`\n${'='.repeat(78)}`);
console.log('3. P(B>A)：正态近似 vs Beta 精确值');
console.log('='.repeat(78));

/** Lanczos log-gamma */
function lgamma(x: number): number {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  const xx = x - 1;
  let a = 0.99999999999980993;
  const t = xx + 7.5;
  for (let i = 0; i < 8; i++) a += g[i] / (xx + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(a);
}

/** 正则化不完全 Beta（Lentz 连分式，Numerical Recipes betacf） */
function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 400; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-16) break;
  }
  return h;
}

/** I_x(a,b) */
function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Beta(a,b) 的密度 */
function dbeta(x: number, a: number, b: number): number {
  if (x <= 0 || x >= 1) return 0;
  return Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + (a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x));
}

/**
 * 精确 P(A>B) = ∫ f_B(y)·P(A>y) dy。
 * 直接在 (0,1) 上积分会被尖峰骗（p=0.012、n=2 万时峰宽约 5e-4，均匀网格取不到），
 * 所以在 B 的标准化坐标 u=(y−mean)/sd 上做 Simpson，峰值永远在 u=0 附近。
 */
function probAOverBExact(c1: number, n1: number, c2: number, n2: number): number {
  const a = c2 + 1; // treatment 后验
  const b = n2 - c2 + 1;
  const a2 = c1 + 1; // control 后验
  const b2 = n1 - c1 + 1;
  const meanB = a2 / (a2 + b2);
  const varB = (a2 * b2) / ((a2 + b2) ** 2 * (a2 + b2 + 1));
  const sdB = Math.sqrt(varB);
  const LO = -9;
  const HI = 9;
  const STEPS = 8000; // 偶数
  const h = (HI - LO) / STEPS;
  const f = (u: number) => {
    const y = meanB + sdB * u;
    if (y <= 0 || y >= 1) return 0;
    return dbeta(y, a2, b2) * sdB * (1 - betai(a, b, y));
  };
  let s = f(LO) + f(HI);
  for (let i = 1; i < STEPS; i++) s += (i % 2 ? 4 : 2) * f(LO + i * h);
  return (s * h) / 3;
}

const cases: [string, number, number, number, number][] = [
  ['n=20/臂，基线 5%', 1, 20, 2, 20],
  ['n=100/臂，基线 5%', 5, 100, 8, 100],
  ['n=1000/臂，基线 5%', 50, 1000, 60, 1000],
  ['n=20000/臂，基线 1.2%', 240, 20000, 300, 20000],
  ['n=20000/臂，基线 1.2%（无效应）', 240, 20000, 240, 20000],
  ['n=500/臂，基线 30%', 150, 500, 175, 500],
];

let maxErrBig = 0;
let maxErrSmall = 0;
for (const [label, c1, n1, c2, n2] of cases) {
  const exact = probAOverBExact(c1, n1, c2, n2);
  // 实现里的正态近似：Beta → 均值/方差 → Φ(Δ/sd)
  const a = c2 + 1;
  const b = n2 - c2 + 1;
  const a2 = c1 + 1;
  const b2 = n1 - c1 + 1;
  const mt = a / (a + b);
  const mc = a2 / (a2 + b2);
  const vt = (mt * (1 - mt)) / (a + b + 1);
  const vc = (mc * (1 - mc)) / (a2 + b2 + 1);
  const sd = Math.sqrt(vt + vc);
  const approx = normalCdf((mt - mc) / sd);
  const err = Math.abs(approx - exact) * 100;
  const isSmall = n1 <= 100;
  if (isSmall) maxErrSmall = Math.max(maxErrSmall, err);
  else maxErrBig = Math.max(maxErrBig, err);
  console.log(
    label.padEnd(34),
    `精确 ${(exact * 100).toFixed(2)}%`.padStart(14),
    `近似 ${(approx * 100).toFixed(2)}%`.padStart(14),
    `误差 ${err.toFixed(2)}pp`.padStart(12),
  );
}
console.log(`\n每臂 ≥1000 时最大误差 ${maxErrBig.toFixed(2)}pp；每臂 ≤100 时最大误差 ${maxErrSmall.toFixed(2)}pp`);

// ============ 4. 护栏三种口径 ============

console.log(`\n${'='.repeat(78)}`);
console.log('4. 退款率护栏：三种 mode 的误报率与检出率（每臂 2 万，基线 1.19%）');
console.log('='.repeat(78));

const rg = DEFAULT_CONFIG.guardrails.refundRate;
const N = 20000;
const BASE = 0.0119;

function guardrailSim(harm: number, mode: 'harm_and_practical' | 'confirm_beyond_margin' | 'non_inferiority', trials = 2000) {
  const rng = mulberry32(4242);
  let block = 0;
  let inconclusive = 0;
  for (let i = 0; i < trials; i++) {
    const c1 = binomial(N, BASE, rng);
    const c2 = binomial(N, BASE + harm, rng);
    const ni = nonInferiority(c1, N, c2, N, rg.margin, rg.alpha);
    if (ni.verdict === 'inconclusive') inconclusive++;
    if (guardrailBlocks(ni, mode)) block++;
  }
  return { block: block / trials, inconclusive: inconclusive / trials };
}

console.log(`margin = ${(rg.margin * 100).toFixed(1)}pp，单侧 α = ${rg.alpha}，SE ≈ ${(
  Math.sqrt((2 * BASE * (1 - BASE)) / N) * 100
).toFixed(3)}pp\n`);
console.log('真实恶化'.padEnd(12), 'harm_and_practical'.padStart(20), 'confirm_beyond_margin'.padStart(24), 'non_inferiority'.padStart(18));
for (const harm of [0, 0.002, 0.004, 0.008]) {
  const a = guardrailSim(harm, 'harm_and_practical');
  const b = guardrailSim(harm, 'confirm_beyond_margin');
  const c = guardrailSim(harm, 'non_inferiority');
  console.log(
    `+${(harm * 100).toFixed(1)}pp`.padEnd(12),
    `${pct(a.block)}（拦）`.padStart(20),
    `${pct(b.block)}（拦）`.padStart(24),
    `${pct(c.block)}（拦，${pct(c.inconclusive, 0)}不确定）`.padStart(18),
  );
}

// ============ 5. 在 120 个实验上复核：q 与护栏口径的选择 ============

console.log(`\n${'='.repeat(78)}`);
console.log('5. 120 个实验（固定种子）：改 q / 改护栏 mode 会动到谁');
console.log('='.repeat(78));

{
  const ds = generateDataset(20261031);
  const rowsOf = (id: string) => ds.daily.filter((r) => r.expId === id);

  // 5a. segmentFdr：分层扫描的检测数与误报数
  console.log('\n5a. 分层扫描的 q 阈值（m=2，tenure 维）：');
  console.log('q'.padEnd(8), '判异质'.padStart(8), '其中真异质'.padStart(12), '误报'.padStart(8), '漏报'.padStart(8));
  const hetero = ds.experiments.filter((e) => e.archetype === 'heterogeneous').length;
  for (const q of [0.05, 0.1, 0.2]) {
    let flagged = 0;
    let tp = 0;
    let fp = 0;
    for (const e of ds.experiments) {
      const an = analyze(e, rowsOf(e.id), { segmentFdr: q });
      const isHetero = e.archetype === 'heterogeneous';
      if (an.heterogeneity.detected) {
        flagged++;
        if (isHetero) tp++;
        else fp++;
      }
    }
    console.log(
      String(q).padEnd(8),
      String(flagged).padStart(8),
      `${tp}/${hetero}`.padStart(12),
      String(fp).padStart(8),
      String(hetero - tp).padStart(8),
    );
  }
  // BH 在 m=2 时的实际阈值：最小的 p 与不校正的 α 用同一个门
  const demo = bhAdjust([0.031, 0.42], 0.1);
  console.log(
    `   m=2、q=0.1 时 BH 的实际门槛：最小的 p 要 ≤ ${(0.1 / 2).toFixed(2)}，次小的 ≤ ${(0.1 * 2 / 2).toFixed(2)}`,
    `（示例 p=[0.031, 0.42] → 拒 ${demo.rejected.filter(Boolean).length} 个）`,
  );

  // 5b. 护栏口径：把退款率的 mode 换掉，看拦住谁
  console.log('\n5b. 退款率护栏换 mode（其余配置不变）：');
  console.log('mode'.padEnd(26), '拦截数'.padStart(8), '真护栏族'.padStart(12), '其它族误拦'.padStart(14));
  for (const mode of ['harm_and_practical', 'confirm_beyond_margin', 'non_inferiority'] as const) {
    let blocked = 0;
    let trueGuard = 0;
    let falseBlock = 0;
    for (const e of ds.experiments) {
      const an = analyze(e, rowsOf(e.id), {
        guardrails: { ...DEFAULT_CONFIG.guardrails, refundRate: { ...rg, mode } },
      });
      const hit = an.guardrails.some((g) => g.gating && g.worse);
      if (hit) {
        blocked++;
        if (e.archetype === 'guardrail') trueGuard++;
        else falseBlock++;
      }
    }
    console.log(String(mode).padEnd(26), String(blocked).padStart(8), `${trueGuard}/15`.padStart(12), String(falseBlock).padStart(14));
  }
}
