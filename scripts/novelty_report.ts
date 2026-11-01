/**
 * 新颖效应 / 效应衰减的证据产出（A7）。
 *
 * 三块数字分开写，混在一起就又变成"我说它有用"：
 *   ① **模拟**：同方差数据上「零衰减判成衰减」的比例（误报，必须 ≈ α）与注入不同幅度
 *      衰减的检出率（功效）。只有功效没有误报率，等于把所有实验都判成衰减。
 *   ② **A/A 实测校准**：1000 个真效应恒为 0 的实验走**真实引擎路径**再看误报率。
 *      这一块曾经抓出过真 bug：最早的「两段各自重估 + 正态」口径在这里是 12%/15%，
 *      不是 5%（半段只有 3–4 天、16 个格子，当天 SE 漏掉了日间整体漂移）。
 *      改成日级聚类 + Welch t 后落到 4.8%/6.4%。
 *   ③ **120 个实验上的判定分布**——特别是「已经判 ship 的实验里有多少同时在衰减」，
 *      那才是这个功能存在的理由（累计值会把衰减平均掉，于是结论永远成立）。
 *
 * 用法：
 *   npm run novelty                # 4000 次模拟 + 120 个实验，写 data/novelty_report.json
 *   npm run novelty -- --dry       # 只打印（CI 用）
 *   npm run novelty -- --trials 20000
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { analyze, dailySegments } from '../src/lib/decide.ts';
import { noveltyReport, planExposureSplit, type DayEffect } from '../src/lib/novelty.ts';
import { generateAA } from '../src/lib/simulate.ts';
import { mulberry32, studentTInv } from '../src/lib/stats.ts';
import type { Dataset } from '../src/lib/types.ts';

function randn(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 每天 4000/臂、基线 5% 时单日差值 SE —— 与 tests/novelty.test.ts 用的是同一个量 */
const DAY_SE = Math.sqrt((2 * 0.05 * 0.95) / 4000);

export interface NoveltySim {
  days: number;
  trials: number;
  alpha: number;
  daySe: number;
  /** 零衰减（每天同一个效应）下被判成 decay/growth 的比例 */
  falsePositive: number;
  /** 注入「前半段有效、后半段归零」的检出率 */
  power: { injected: number; rate: number; theoreticalZ: number }[];
  /** 该样本量 80% 功效下能检出的最小衰减（模拟口径） */
  detectable: number;
}

function flatPoints(days: number): DayEffect[] {
  return Array.from({ length: days }, (_, i) => ({
    day: i + 1,
    date: `2026-11-${String(i + 1).padStart(2, '0')}`,
    nPerArm: 4000,
    diff: 0,
    se: DAY_SE,
  }));
}

/** 同方差模拟：零衰减 + 若干强度的注入衰减（同一种子序列，保证两组可比） */
export function simulateNovelty(
  days = 7,
  trials = 4000,
  seed = 20261101,
  alpha = 0.05,
  injected = [0.005, 0.01, 0.02],
): NoveltySim {
  const base = flatPoints(days);
  const split = planExposureSplit(base)!;
  const rng = mulberry32(seed);
  const judge = (draw: (day: number) => number) => {
    const pts = base.map((p) => ({ ...p, diff: draw(p.day) }));
    return noveltyReport({ points: pts, alpha });
  };

  let fp = 0;
  for (let t = 0; t < trials; t++) {
    if (judge(() => 0.005 + DAY_SE * randn(rng)).pattern !== 'stable') fp++;
  }

  const seDeltaTheory = Math.sqrt(DAY_SE ** 2 / split.earlyDays.length + DAY_SE ** 2 / split.lateDays.length);
  const power = injected.map((d) => {
    let hit = 0;
    for (let t = 0; t < trials; t++) {
      const v = judge((day) => (split.earlyDays.includes(day) ? d : 0) + DAY_SE * randn(rng));
      if (v.pattern === 'decay') hit++;
    }
    return { injected: d, rate: hit / trials, theoreticalZ: d / seDeltaTheory };
  });

  // 80% 功效下能检出的最小衰减：解析式（ν = 两段日数之和 − 2），不靠单次抽样
  const dfTheory = split.earlyDays.length + split.lateDays.length - 2;
  const detectable = (studentTInv(1 - alpha / 2, dfTheory) + studentTInv(0.8, dfTheory)) * seDeltaTheory;
  return {
    days,
    trials,
    alpha,
    daySe: DAY_SE,
    falsePositive: fp / trials,
    power,
    detectable,
  };
}

export interface AACalibration {
  n: number;
  /** 率指标的误报率（应 ≈ α） */
  rateFp: number;
  rateN: number;
  /** ARPU 的误报率（收入重尾，通常比率指标高一点） */
  continuousFp: number;
  continuousN: number;
  /** 判成 decay 与 growth 各多少 —— 零效应下应当对半，否则说明有方向性偏差 */
  up: number;
  down: number;
}

/** 1000 个 A/A（真效应恒为 0）走真实引擎路径，量误报率 */
export function calibrateOnAA(count = 1000, seedBase = 20261101): AACalibration {
  const aa = generateAA(count, seedBase, 7);
  const byExp = new Map<string, Dataset['daily']>();
  for (const r of aa.daily) {
    const l = byExp.get(r.expId);
    if (l) l.push(r);
    else byExp.set(r.expId, [r]);
  }
  let rateN = 0;
  let rateFp = 0;
  let contN = 0;
  let contFp = 0;
  let up = 0;
  let down = 0;
  for (const e of aa.experiments) {
    const a = analyze(e, byExp.get(e.id) ?? []);
    const isCont = e.metricType === 'continuous';
    if (isCont) contN++;
    else rateN++;
    if (a.novelty.pattern === 'stable' || a.novelty.pattern === 'insufficient') continue;
    if (isCont) contFp++;
    else rateFp++;
    if (a.novelty.delta > 0) up++;
    else down++;
  }
  return {
    n: aa.experiments.length,
    rateN,
    continuousN: contN,
    rateFp: rateN ? rateFp / rateN : 0,
    continuousFp: contN ? contFp / contN : 0,
    up,
    down,
  };
}

export interface ExpNovelty {
  id: string;
  archetype: string;
  decision: string;
  pattern: string;
  /** pp（率指标）或 元（ARPU）—— 打印时必须按指标单位换算，不能一律 ×100 */
  unit: 'pp' | '元';
  earlyDiff: number;
  lateDiff: number;
  delta: number;
  relativeDelta: number | null;
  p: number;
  slope: number | null;
  dispersion: number | null;
}

export interface NoveltyReportFile {
  generatedAt: string;
  seedBase: number;
  sim: NoveltySim;
  aa: AACalibration;
  experiments: {
    n: number;
    patterns: Record<string, number>;
    /** 判成 ship 的实验里有多少同时在衰减 —— 这条才是「为什么需要这个功能」 */
    shipInDecay: number;
    shipTotal: number;
    significant: number;
    medianRelativeDelta: number | null;
    overdispersed: number;
    /** 判 stable 的实验里，detectableDelta 的中位数（"看不出这么小的"要有个量） */
    medianDetectable: number;
  };
  decayExamples: ExpNovelty[];
}

export function runNoveltyReport(trials = 4000, datasetPath = 'data/experiments.json'): NoveltyReportFile {
  const ds: Dataset = JSON.parse(readFileSync(datasetPath, 'utf8'));
  const byExp = new Map<string, Dataset['daily']>();
  for (const r of ds.daily) {
    const l = byExp.get(r.expId);
    if (l) l.push(r);
    else byExp.set(r.expId, [r]);
  }

  const rows: ExpNovelty[] = [];
  const patterns: Record<string, number> = {};
  const detectables: number[] = [];
  let shipInDecay = 0;
  let shipTotal = 0;
  let overdispersed = 0;
  const rels: number[] = [];

  for (const e of ds.experiments) {
    const a = analyze(e, byExp.get(e.id) ?? []);
    const nv = a.novelty;
    patterns[nv.pattern] = (patterns[nv.pattern] ?? 0) + 1;
    if (a.decision === 'ship') {
      shipTotal++;
      if (nv.pattern === 'decay') shipInDecay++;
    }
    if (nv.dispersion !== null && nv.dispersion > 1.0000001) overdispersed++;
    if (Number.isFinite(nv.detectableDelta)) detectables.push(nv.detectableDelta);
    if (nv.relativeDelta !== null && Number.isFinite(nv.relativeDelta)) rels.push(nv.relativeDelta);
    rows.push({
      id: e.id,
      archetype: e.archetype,
      decision: a.decision,
      pattern: nv.pattern,
      unit: a.primary.unit,
      earlyDiff: nv.early.diff,
      lateDiff: nv.late.diff,
      delta: nv.delta,
      relativeDelta: nv.relativeDelta,
      p: nv.p,
      slope: nv.slope,
      dispersion: nv.dispersion,
    });
  }

  rels.sort((a, b) => a - b);
  detectables.sort((a, b) => a - b);

  return {
    generatedAt: new Date().toISOString(),
    seedBase: ds.seedBase,
    sim: simulateNovelty(7, trials),
    aa: calibrateOnAA(1000),
    experiments: {
      n: rows.length,
      patterns,
      shipInDecay,
      shipTotal,
      significant: rows.filter((r) => r.pattern === 'decay' || r.pattern === 'growth').length,
      medianRelativeDelta: rels.length ? rels[Math.floor(rels.length / 2)] : null,
      overdispersed,
      medianDetectable: detectables.length ? detectables[Math.floor(detectables.length / 2)] : 0,
    },
    decayExamples: rows
      .filter((r) => r.pattern === 'decay')
      .sort((a, b) => a.p - b.p)
      .slice(0, 8),
  };
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
/** 按指标单位格式化差值：率指标 ×100 成 pp，ARPU 直接是元 */
const diffTxt = (v: number, unit: 'pp' | '元') => (unit === '元' ? `${v.toFixed(2)}元` : `${(v * 100).toFixed(2)}pp`);
const isDirect = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/novelty_report.ts');

if (isDirect) {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const dry = process.argv.includes('--dry');
  const ti = process.argv.indexOf('--trials');
  const trials = ti >= 0 ? Number(process.argv[ti + 1]) : Number(positional[0] ?? 4000);
  if (!Number.isFinite(trials) || trials <= 0) {
    console.error(`模拟次数必须是正整数，收到「${trials}」`);
    process.exit(1);
  }
  const t0 = Date.now();
  const r = runNoveltyReport(trials);
  const json = `${JSON.stringify(r, null, 2)}\n`;
  if (!dry) {
    writeFileSync('data/novelty_report.json', json);
    try {
      writeFileSync('public/data/novelty_report.json', json);
    } catch {
      console.log('（public/data/ 不存在，跳过前端副本）');
    }
  }

  const s = r.sim;
  console.log(`\n① 同方差模拟（7 天、单日 SE=${s.daySe.toFixed(5)}、${s.trials} 次）`);
  console.log('─'.repeat(78));
  console.log(`  零衰减却判成 decay/growth     ${pct(s.falsePositive)}   ← 应≈α=${(s.alpha * 100).toFixed(0)}%`);
  for (const p of s.power) {
    console.log(`  注入 ${(p.injected * 100).toFixed(1)}pp 衰减（理论 z=${p.theoreticalZ.toFixed(2)}）  检出 ${pct(p.rate)}`);
  }
  console.log(`  该样本量 80% 功效下可检出的最小衰减 ${pct(s.detectable)}`);

  const aa = r.aa;
  console.log(`\n② A/A 实测校准（${aa.n} 个真效应为 0 的实验，走真实引擎路径）`);
  console.log('─'.repeat(78));
  console.log(`  率指标  ${pct(aa.rateFp)}（n=${aa.rateN}）   ← 应≈5%`);
  console.log(`  ARPU    ${pct(aa.continuousFp)}（n=${aa.continuousN}）   ← 收入重尾，通常略高`);
  console.log(`  方向：判 growth ${aa.up} / decay ${aa.down}（零效应下应大致对半）`);

  const e = r.experiments;
  console.log(`\n③ 120 个实验上的实测（${e.n} 个）`);
  console.log('─'.repeat(78));
  console.log(`  判定分布：${Object.entries(e.patterns).map(([k, v]) => `${k} ${v}`).join('  ·  ')}`);
  console.log(`  前后半段差异显著 ${e.significant} 个；过离散修正生效（φ>1）${e.overdispersed} 个`);
  console.log(`  判 stable 的实验里，可检出下限中位数 ${pct(e.medianDetectable)}（小于这个幅度的衰减看不出来）`);
  console.log(
    `  已判 ship 的 ${e.shipTotal} 个实验里，同时被判「在衰减」的 ${e.shipInDecay} 个` +
      (e.shipTotal ? `（${pct(e.shipInDecay / e.shipTotal)}）` : ''),
  );
  if (e.medianRelativeDelta !== null) {
    console.log(`  后半段相对前半段的变化中位数 ${pct(e.medianRelativeDelta)}`);
  }
  if (r.decayExamples.length) {
    console.log('\n  衰减最明显的几条：');
    for (const d of r.decayExamples) {
      console.log(
        `    ${d.id} ${d.archetype.padEnd(13)} ${d.decision.padEnd(12)} 前 ${diffTxt(d.earlyDiff, d.unit)} → 后 ${diffTxt(d.lateDiff, d.unit)}  p=${d.p.toExponential(2)}`,
      );
    }
  }
  console.log(`\n  耗时 ${Date.now() - t0}ms → ${dry ? '（--dry，未写文件）' : 'data/novelty_report.json'}\n`);
}
