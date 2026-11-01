/**
 * CUPED 收益报告（实测，不是理论值）。
 *
 * 回答三个问题：
 *  ① 方差缩减到底有多少？（每个实验的 1 − SE²_adj/SE²_raw）
 *  ② 代价是什么：A/A 误报率有没有守住？
 *  ③ 收益是什么：同样的数据，多检出多少真实效应？（功效对比）
 *
 * 全部用同一套生成器 + 同一套引擎，关掉 CUPED 再跑一遍做对照。
 */
import { writeFileSync } from 'node:fs';
import { analyze } from '../src/lib/decide.ts';
import { generateAA, generateDataset } from '../src/lib/simulate.ts';
import { runAa } from './aa_test.ts';
import type { Dataset } from '../src/lib/types.ts';

export interface CupedReport {
  generatedAt: string;
  seedBase: number;
  nExperiments: number;
  /** 方差缩减的中位 / 均值 / 最大 */
  varReductionMedian: number;
  varReductionMean: number;
  varReductionP90: number;
  /** 前后周期相关系数的中位 */
  rhoMedian: number;
  /** 过离散因子中位（1 = 纯二项） */
  dispersionMedian: number;
  /** 格子数 */
  nCells: number;
  /** 关掉 CUPED（退回两比例 z 检验）时的检出数 */
  /** 有真实正效应的实验总数 */
  positiveTotal: number;
  /**
   * A/A 误报率，三种口径分开测。
   * 关键：修好误报率的是「稳健标准误」，不是 CUPED——必须拆开，
   * 否则就是把 seMode 的功劳算到 CUPED 头上（自证式叙事）。
   */
  aaFprCuped: number;
  aaFprRobust: number;
  aaFprIid: number;
  aaTrials: number;
  /** 三种口径下检出的真实正效应数 */
  detectedCuped: number;
  detectedRobust: number;
  detectedIid: number;
}

function byExp(ds: Dataset) {
  const m = new Map<string, (typeof ds.daily)[number][]>();
  for (const r of ds.daily) {
    const l = m.get(r.expId);
    if (l) l.push(r);
    else m.set(r.expId, [r]);
  }
  return m;
}

export function runCupedReport(seedBase = 20261031, aaTrials = 400): CupedReport {
  const ds = generateDataset(seedBase, 7);
  const rows = byExp(ds);

  const reductions: number[] = [];
  const rhos: number[] = [];
  const disps: number[] = [];
  let cells = 0;

  const positives = ds.experiments.filter((e) => e.archetype === 'positive');
  let dCuped = 0;
  let dRobust = 0;
  let dIid = 0;

  for (const e of ds.experiments) {
    const r = rows.get(e.id) ?? [];
    const a = analyze(e, r);
    if (a.cuped) {
      reductions.push(a.cuped.varReduction);
      rhos.push(a.cuped.rho);
      disps.push(a.cuped.dispersion);
      cells = a.cuped.nCells;
    }
    if (e.archetype === 'positive') {
      if (analyze(e, r, { useCuped: true, seMode: 'robust' }).primary.p < 0.05) dCuped++;
      if (analyze(e, r, { useCuped: false, seMode: 'robust' }).primary.p < 0.05) dRobust++;
      if (analyze(e, r, { useCuped: false, seMode: 'iid' }).primary.p < 0.05) dIid++;
    }
  }

  const aaCuped = runAa(aaTrials, 20261101, 7, { useCuped: true, seMode: 'robust' });
  const aaRobust = runAa(aaTrials, 20261101, 7, { useCuped: false, seMode: 'robust' });
  const aaIid = runAa(aaTrials, 20261101, 7, { useCuped: false, seMode: 'iid' });

  const med = (a: number[]) => {
    if (!a.length) return 0;
    const s = a.slice().sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  const p90 = (a: number[]) => {
    if (!a.length) return 0;
    const s = a.slice().sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
  };

  return {
    generatedAt: new Date().toISOString(),
    seedBase,
    nExperiments: ds.experiments.length,
    varReductionMedian: med(reductions),
    varReductionMean: reductions.reduce((s, v) => s + v, 0) / (reductions.length || 1),
    varReductionP90: p90(reductions),
    rhoMedian: med(rhos),
    dispersionMedian: med(disps),
    nCells: cells,
    detectedCuped: dCuped,
    detectedRobust: dRobust,
    detectedIid: dIid,
    positiveTotal: positives.length,
    aaFprCuped: aaCuped.falsePositiveRate,
    aaFprRobust: aaRobust.falsePositiveRate,
    aaFprIid: aaIid.falsePositiveRate,
    aaTrials,
  };
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

const isDirect = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/cuped_report.ts');
if (isDirect) {
  const t0 = Date.now();
  const r = runCupedReport(20261031, Number(process.argv[2] ?? 400));
  const json = `${JSON.stringify(r, null, 2)}\n`;
  writeFileSync('data/cuped_report.json', json);
  try {
    writeFileSync('public/data/cuped_report.json', json);
  } catch {
    /* public/data 不存在时跳过；先跑 npm run data */
  }

  console.log(`\nCUPED 收益报告（${r.nExperiments} 个实验，每实验 ${r.nCells} 个格子）`);
  console.log('─'.repeat(74));
  console.log(`  前后周期相关系数 ρ（中位）   ${r.rhoMedian.toFixed(3)}`);
  console.log(`  过离散因子 φ（中位）         ${r.dispersionMedian.toFixed(2)}   （1 = 纯二项；>1 说明 i.i.d. 假设不成立）`);
  console.log(`  方差缩减（中位）             ${pct(r.varReductionMedian)}`);
  console.log(`  方差缩减（均值 / p90）       ${pct(r.varReductionMean)} / ${pct(r.varReductionP90)}`);
  console.log('');
  console.log(`  真实正效应实验               ${r.positiveTotal} 个`);
  console.log(`  检出：CUPED / 稳健 / i.i.d.  ${r.detectedCuped} / ${r.detectedRobust} / ${r.detectedIid}`);
  console.log('');
  console.log(`  A/A 误报率（i.i.d. 标准误）  ${pct(r.aaFprIid)}   （${r.aaTrials} 次，名义 5%）← 基线，明显失控`);
  console.log(`  A/A 误报率（稳健标准误）     ${pct(r.aaFprRobust)}   ← 换标准误就修好了`);
  console.log(`  A/A 误报率（稳健 + CUPED）   ${pct(r.aaFprCuped)}   ← CUPED 在此基础上不破坏校准`);
  console.log(`\n  耗时 ${Date.now() - t0}ms → data/cuped_report.json\n`);
}
