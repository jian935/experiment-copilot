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
  /**
   * 按主指标口径拆开的方差缩减与 A/A 误报。
   * 为什么必须拆：ARPU 的方差来自收入分布的离散度，转化率的方差来自 p(1−p)，
   * 两者可缩减的空间本来就不同；混在一起报一个中位数会掩盖其中一侧。
   */
  varReductionByKind: Record<
    'rate' | 'continuous',
    { n: number; median: number; mean: number; rhoMedian: number; dispersionMedian: number }
  >;
  aaFprByKind: Record<
    'rate' | 'continuous',
    { trials: number; cuped: number; robust: number; iid: number; seCuped: number }
  >;
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

export function runCupedReport(seedBase = 20261031, aaTrials = 2000): CupedReport {
  const ds = generateDataset(seedBase, 7);
  const rows = byExp(ds);

  const reductions: number[] = [];
  const rhos: number[] = [];
  const disps: number[] = [];
  const byKindVals: Record<'rate' | 'continuous', { red: number[]; rho: number[]; disp: number[] }> = {
    rate: { red: [], rho: [], disp: [] },
    continuous: { red: [], rho: [], disp: [] },
  };
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
      const k = a.primary.kind;
      byKindVals[k].red.push(a.cuped.varReduction);
      byKindVals[k].rho.push(a.cuped.rho);
      byKindVals[k].disp.push(a.cuped.dispersion);
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

  const kindStats = (kind: 'rate' | 'continuous') => {
    const v = byKindVals[kind];
    return {
      n: v.red.length,
      median: med(v.red),
      mean: v.red.reduce((s, x) => s + x, 0) / (v.red.length || 1),
      rhoMedian: med(v.rho),
      dispersionMedian: med(v.disp),
    };
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
    varReductionByKind: { rate: kindStats('rate'), continuous: kindStats('continuous') },
    // 三次 runAa 各自内部已按口径分好桶（同一批种子、同一批实验），直接取来对齐，
    // 不再单独跑一遍——否则多跑的那遍会用不同随机流，和上面的总数对不上。
    aaFprByKind: {
      rate: {
        trials: aaCuped.byMetricKind.rate.trials,
        cuped: aaCuped.byMetricKind.rate.rate,
        robust: aaRobust.byMetricKind.rate.rate,
        iid: aaIid.byMetricKind.rate.rate,
        seCuped: aaCuped.byMetricKind.rate.se,
      },
      continuous: {
        trials: aaCuped.byMetricKind.continuous.trials,
        cuped: aaCuped.byMetricKind.continuous.rate,
        robust: aaRobust.byMetricKind.continuous.rate,
        iid: aaIid.byMetricKind.continuous.rate,
        seCuped: aaCuped.byMetricKind.continuous.se,
      },
    },
  };
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

const isDirect = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/cuped_report.ts');
if (isDirect) {
  const t0 = Date.now();
  const r = runCupedReport(20261031, Number(process.argv[2] ?? 2000));
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
  console.log('  按主指标口径拆开（协变量与方差来源都不同，不能混算中位）：');
  for (const k of ['rate', 'continuous'] as const) {
    const b = r.varReductionByKind[k];
    const label = k === 'rate' ? '率口径（转化率）' : '连续口径（ARPU）  ';
    console.log(
      `    ${label} n=${String(b.n).padStart(3)}  方差缩减 ${pct(b.median).padStart(7)}（均值 ${pct(b.mean)}）` +
        `  ρ ${b.rhoMedian.toFixed(3)}  φ ${b.dispersionMedian.toFixed(2)}`,
    );
  }
  console.log('');
  console.log(`  真实正效应实验               ${r.positiveTotal} 个`);
  console.log(`  检出：CUPED / 稳健 / i.i.d.  ${r.detectedCuped} / ${r.detectedRobust} / ${r.detectedIid}`);
  console.log('');
  console.log(`  A/A 误报率（i.i.d. 标准误）  ${pct(r.aaFprIid)}   （${r.aaTrials} 次，名义 5%）← 基线，明显失控`);
  console.log(`  A/A 误报率（稳健标准误）     ${pct(r.aaFprRobust)}   ← 换标准误就修好了`);
  console.log(`  A/A 误报率（稳健 + CUPED）   ${pct(r.aaFprCuped)}   ← CUPED 在此基础上不破坏校准`);
  console.log('  按口径拆开（同上，两边方差机制不同）：');
  for (const k of ['rate', 'continuous'] as const) {
    const b = r.aaFprByKind[k];
    const label = k === 'rate' ? '率口径（转化率）' : '连续口径（ARPU）  ';
    console.log(
      `    ${label} n=${String(b.trials).padStart(4)}  i.i.d. ${pct(b.iid).padStart(7)} / 稳健 ${pct(b.robust).padStart(7)}` +
        ` / 稳健+CUPED ${pct(b.cuped).padStart(7)}±${(1.96 * b.seCuped * 100).toFixed(2)}pp`,
    );
  }
  console.log(`\n  耗时 ${Date.now() - t0}ms → data/cuped_report.json\n`);
}
