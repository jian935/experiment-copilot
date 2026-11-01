/**
 * 序贯检验的证据产出（A2）。
 *
 * 两类数字必须分开写在报告里，混在一起就会变成"我说它有效"：
 *   ① **模拟**：零效应下按 7 次观察反复偷看，naive / OBF / always-valid 各自的误报率。
 *      这是边界的正确性证据，与我们的数据无关，任何统计库跑出来都该是这个量级。
 *   ② **实测**：120 个实验上三套口径的分歧。这是"偷看校正到底改变了什么"。
 *
 * 用法：
 *   npm run seq                 # 20000 次模拟 + 120 个实验，写 data/sequential_report.json
 *   npm run seq -- --dry        # 只打印（CI 用，避免冲掉正式报告）
 *   npm run seq -- --trials 50000
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { analyze, type Analysis } from '../src/lib/decide.ts';
import { buildPeekReport, msprtBestCaseZ, msprtRequiredZ, obfBoundary } from '../src/lib/sequential.ts';
import { mulberry32, normalInv } from '../src/lib/stats.ts';
import type { Dataset } from '../src/lib/types.ts';

function randn(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface PeekSim {
  looks: number;
  trials: number;
  /** 每次都按 0.05 判（真实世界最常见的做法）下的"至少一次显著"比例 */
  naiveRate: number;
  /** OBF α 消耗边界下的比例（应 ≈ α） */
  obfRate: number;
  /** mSPRT always-valid p 下的比例（应 ≤ α，且更保守） */
  alwaysRate: number;
  /** 边界值（z 尺度，第一次 → 最后一次） */
  boundaries: number[];
  /** 最后一次观察对应的名义 p 门槛 */
  finalNominalP: number;
  /** mSPRT 先验取 1.96σ 时需要的 z；取"先验匹配真实效应"时的理论下界 */
  msprtZ: number;
  msprtBestZ: number;
}

/** 零效应模拟：标准布朗运动 + 三套判定 */
export function simulatePeeking(looks = 7, trials = 20000, seed = 20261101, alpha = 0.05): PeekSim {
  const times = Array.from({ length: looks }, (_, i) => (i + 1) / looks);
  const bd = obfBoundary(times, alpha);
  const rng = mulberry32(seed);
  const tauOverSe = normalInv(1 - alpha / 2); // τ = 1.96 × 最终 SE
  let naive = 0;
  let obf = 0;
  let always = 0;

  for (let t = 0; t < trials; t++) {
    let z = 0;
    let prev = 0;
    let hitNaive = false;
    let hitObf = false;
    let hitAlways = false;
    for (let k = 0; k < looks; k++) {
      z += Math.sqrt(times[k] - prev) * randn(rng);
      prev = times[k];
      const w = z / Math.sqrt(times[k]);
      if (Math.abs(w) >= normalInv(1 - alpha / 2)) hitNaive = true;
      if (Math.abs(w) >= bd.boundaries[k]) hitObf = true;
      // 等效验算：mSPRT 在信息量 t 处的边界可解成 z 门槛，与 obf 用同一个 z 比较
      // 第 k 次观察的 se_k = se_终/√t_k，所以 τ/se_k = 1.96·√t_k
      if (Math.abs(w) >= msprtRequiredZ(tauOverSe * Math.sqrt(times[k]), alpha)) hitAlways = true;
    }
    if (hitNaive) naive++;
    if (hitObf) obf++;
    if (hitAlways) always++;
  }

  return {
    looks,
    trials,
    naiveRate: naive / trials,
    obfRate: obf / trials,
    alwaysRate: always / trials,
    boundaries: bd.boundaries,
    finalNominalP: bd.nominalP[bd.nominalP.length - 1],
    msprtZ: msprtRequiredZ(tauOverSe, alpha),
    msprtBestZ: msprtBestCaseZ(alpha),
  };
}

export interface ExpPeek {
  id: string;
  archetype: string;
  decision: string;
  looks: number;
  naiveP: number;
  naiveSig: boolean;
  obfSig: boolean;
  obfCrossDay: number | null;
  alwaysSig: boolean;
}

export interface SeqReport {
  generatedAt: string;
  seedBase: number;
  sim: PeekSim;
  /** 120 个实验上的实测分布 */
  experiments: {
    n: number;
    looksHistogram: Record<string, number>;
    naiveSig: number;
    obfSig: number;
    alwaysSig: number;
    /** naive 说显著、但全程没越过 OBF 边界 —— 偷看校正真的改变了结论 */
    rescuedByCorrection: number;
    /** 前半段就越过边界（早停正确） */
    crossedEarly: number;
    finalNominalPMedian: number;
  };
  /** 分歧明细（最多 12 条，给文档举例用） */
  disagreements: ExpPeek[];
}

export function runSeqReport(trials = 20000, datasetPath = 'data/experiments.json'): SeqReport {
  const ds: Dataset = JSON.parse(readFileSync(datasetPath, 'utf8'));
  const byExp = new Map<string, Dataset['daily']>();
  for (const r of ds.daily) {
    const l = byExp.get(r.expId);
    if (l) l.push(r);
    else byExp.set(r.expId, [r]);
  }

  const rows: ExpPeek[] = [];
  const looksHist: Record<string, number> = {};
  for (const e of ds.experiments) {
    const a: Analysis = analyze(e, byExp.get(e.id) ?? []);
    const s = a.sequential;
    if (s.skipped) continue;
    looksHist[String(s.k)] = (looksHist[String(s.k)] ?? 0) + 1;
    rows.push({
      id: e.id,
      archetype: e.archetype,
      decision: a.decision,
      looks: s.k,
      naiveP: s.finalPNaive,
      naiveSig: s.naiveSig,
      obfSig: s.obfSig,
      obfCrossDay: s.obfCrossDay,
      alwaysSig: s.alwaysSig,
    });
  }

  const finals = rows.map((r) => {
    const a = analyze(ds.experiments.find((e) => e.id === r.id)!, byExp.get(r.id) ?? []);
    return a.sequential.finalPBoundary;
  });
  finals.sort((a, b) => a - b);

  return {
    generatedAt: new Date().toISOString(),
    seedBase: ds.seedBase,
    sim: simulatePeeking(7, trials),
    experiments: {
      n: rows.length,
      looksHistogram: looksHist,
      naiveSig: rows.filter((r) => r.naiveSig).length,
      obfSig: rows.filter((r) => r.obfSig).length,
      alwaysSig: rows.filter((r) => r.alwaysSig).length,
      rescuedByCorrection: rows.filter((r) => r.naiveSig && !r.obfSig).length,
      crossedEarly: rows.filter((r) => r.obfCrossDay !== null && r.obfCrossDay < r.looks).length,
      finalNominalPMedian: finals.length ? finals[Math.floor(finals.length / 2)] : 0,
    },
    disagreements: rows
      .filter((r) => r.naiveSig !== r.obfSig || r.obfSig !== r.alwaysSig)
      .slice(0, 12),
  };
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const isDirect = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/sequential_report.ts');

if (isDirect) {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const dry = process.argv.includes('--dry');
  const ti = process.argv.indexOf('--trials');
  const trials = ti >= 0 ? Number(process.argv[ti + 1]) : Number(positional[0] ?? 20000);
  if (!Number.isFinite(trials) || trials <= 0) {
    console.error(`模拟次数必须是正整数，收到「${trials}」`);
    process.exit(1);
  }
  const t0 = Date.now();
  const r = runSeqReport(trials);
  const json = `${JSON.stringify(r, null, 2)}\n`;
  if (!dry) {
    writeFileSync('data/sequential_report.json', json);
    try {
      writeFileSync('public/data/sequential_report.json', json);
    } catch {
      console.log('（public/data/ 不存在，跳过前端副本）');
    }
  }

  const s = r.sim;
  console.log(`\n零效应下反复窥探（${s.looks} 次等距观察，${s.trials} 次模拟，α=5%）`);
  console.log('─'.repeat(78));
  console.log(`  naive（每次都用 0.05 判）  误报 ${pct(s.naiveRate)}   ← 这就是 p-hacking 的实际代价`);
  console.log(`  OBF α 消耗边界             误报 ${pct(s.obfRate)}   ← 应≈5%`);
  console.log(`  mSPRT always-valid         误报 ${pct(s.alwaysRate)}   ← 应≤5%，更保守`);
  console.log(`  边界（z）：${s.boundaries.map((v) => v.toFixed(3)).join(' , ')}`);
  console.log(`  最后一次的名义门槛          p < ${(s.finalNominalP * 100).toFixed(2)}%（naive 是 5.00%）`);
  console.log(`  「随时可看」的价格          ${s.msprtZ.toFixed(2)}σ（先验取 1.96σ）/ ${s.msprtBestZ.toFixed(2)}σ（先验匹配真实效应）`);

  const e = r.experiments;
  console.log(`\n120 个实验上的实测（${e.n} 个可用）`);
  console.log('─'.repeat(78));
  console.log(`  观察次数分布：${Object.entries(e.looksHistogram).map(([k, v]) => `${k} 天 ${v} 个`).join('，')}`);
  console.log(`  naive 显著 ${e.naiveSig}  ${'·'}  OBF 显著 ${e.obfSig}  ${'·'}  always-valid 显著 ${e.alwaysSig}`);
  console.log(`  被偷看校正拦下（naive 显著但全程未越界）${e.rescuedByCorrection} 条`);
  console.log(`  中途就已越过边界（早停正确）${e.crossedEarly} 条`);
  console.log(`  末期名义门槛中位数 p < ${(e.finalNominalPMedian * 100).toFixed(2)}%`);
  if (r.disagreements.length) {
    console.log('\n  口径分歧：');
    for (const d of r.disagreements) {
      console.log(
        `    ${d.id} ${d.archetype.padEnd(13)} naive ${d.naiveSig ? '✓' : '✗'} OBF ${d.obfSig ? `✓(第${d.obfCrossDay}次)` : '✗'} always ${d.alwaysSig ? '✓' : '✗'}  p=${d.naiveP.toExponential(2)}`,
      );
    }
  }
  console.log(`\n  耗时 ${Date.now() - t0}ms → ${dry ? '（--dry，未写文件）' : 'data/sequential_report.json'}\n`);
}
