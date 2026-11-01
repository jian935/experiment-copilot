/**
 * A/A 自校准：让引擎跑 1000 个「两臂同分布、零效应」的实验，看它会不会乱报。
 *
 * 这是比"决策准确率 96.7%"更硬的一类证据——准确率依赖我们对真值的标注口径，
 * 而 A/A 误报率是纯粹的统计性质：真值就是 0，引擎报了多少次显著，一目了然。
 * 名义上：
 *   - 主指标误报（ship / no-ship）各约 α/2 = 2.5%，合计 ≈ α = 5%
 *   - SRM 误报 ≈ 0.1%（判定同时要求 p<0.001 且相对偏差>2%）
 *   - 硬护栏误报 ≈ 0.5%（单侧 α=0.005）
 * 实测值由本脚本算出并写入 data/aa_report.json，文档只引用这里的数。
 */
import { writeFileSync } from 'node:fs';
import { analyze, type Analysis } from '../src/lib/decide.ts';
import { generateAA } from '../src/lib/simulate.ts';
import { DEFAULT_CONFIG } from '../src/lib/config.ts';
import type { Dataset, Decision } from '../src/lib/types.ts';

export interface AaReport {
  generatedAt: string;
  seedBase: number;
  trials: number;
  days: number;
  config: { alpha: number; srmAlpha: number; guardrailAlpha: number; guardrailMode: string };
  decisions: Record<Decision, number>;
  /** 任何"非 inconclusive"的结论都算误报（真值就是 inconclusive） */
  falsePositiveRate: number;
  /** 只统计 ship（把无害的也说成有效，这是最贵的那种错） */
  shipRate: number;
  noShipRate: number;
  iterateRate: number;
  srmFlagRate: number;
  guardrailFlagRate: number;
  /** 贝叶斯 P(B>A) 在 A/A 下应当均匀分布在 [0,1]：这里看它是否系统性偏离 0.5 */
  bayesMeanProb: number;
  bayesProbAbove095: number;
  /** 主指标 p 值应当服从 Uniform(0,1)：看分布是否均匀（分 10 桶） */
  pValueHistogram: number[];
  /** 平均样本量，便于复现时对齐 */
  meanSamplePerArm: number;
}

export function runAa(trials = 1000, seedBase = 20261101, days = 7): AaReport {
  const ds: Dataset = generateAA(trials, seedBase, days);
  const rowsByExp = new Map<string, (typeof ds.daily)[number][]>();
  for (const r of ds.daily) {
    const list = rowsByExp.get(r.expId);
    if (list) list.push(r);
    else rowsByExp.set(r.expId, [r]);
  }

  const decisions: Record<Decision, number> = { ship: 0, 'no-ship': 0, iterate: 0, inconclusive: 0 };
  const pHist = new Array(10).fill(0);
  let srmFlag = 0;
  let guardFlag = 0;
  let bayesSum = 0;
  let bayesHi = 0;
  let nSum = 0;

  for (const e of ds.experiments) {
    const a: Analysis = analyze(e, rowsByExp.get(e.id) ?? []);
    decisions[a.decision]++;
    const p = a.overall.p;
    const bucket = Math.min(9, Math.max(0, Math.floor(p * 10)));
    pHist[bucket]++;
    if (a.srm.flagged) srmFlag++;
    if (a.guardrails.some((g) => g.gating && g.worse)) guardFlag++;
    bayesSum += a.bayes.probTreatBetter;
    if (a.bayes.probTreatBetter > 0.95) bayesHi++;
    nSum += (a.overall.n1 + a.overall.n2) / 2;
  }

  const n = ds.experiments.length;
  return {
    generatedAt: new Date().toISOString(),
    seedBase,
    trials: n,
    days,
    config: {
      alpha: DEFAULT_CONFIG.alpha,
      srmAlpha: DEFAULT_CONFIG.srmAlpha,
      guardrailAlpha: DEFAULT_CONFIG.guardrails.refundRate.alpha,
      guardrailMode: DEFAULT_CONFIG.guardrails.refundRate.mode,
    },
    decisions,
    falsePositiveRate: (n - decisions.inconclusive) / n,
    shipRate: decisions.ship / n,
    noShipRate: decisions['no-ship'] / n,
    iterateRate: decisions.iterate / n,
    srmFlagRate: srmFlag / n,
    guardrailFlagRate: guardFlag / n,
    bayesMeanProb: bayesSum / n,
    bayesProbAbove095: bayesHi / n,
    pValueHistogram: pHist,
    meanSamplePerArm: nSum / n,
  };
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

const isDirectRun = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/aa_test.ts');

if (isDirectRun) {
  const trials = Number(process.argv[2] ?? 1000);
  const t0 = Date.now();
  const r = runAa(trials);
  // 两份：data/ 进仓库当文档证据，public/data/ 供前端评测看板直接读
  const json = `${JSON.stringify(r, null, 2)}\n`;
  writeFileSync('data/aa_report.json', json);
  try {
    writeFileSync('public/data/aa_report.json', json);
  } catch {
    console.log('（public/data/ 不存在，跳过前端副本；先跑 npm run data）');
  }

  console.log(`\nA/A 自校准（${r.trials} 个零效应实验，seed=${r.seedBase}，${r.days} 天，每臂平均 ${Math.round(r.meanSamplePerArm)} 样本）`);
  console.log('─'.repeat(78));
  console.log(`结论分布：  ship ${r.decisions.ship}  no-ship ${r.decisions['no-ship']}  iterate ${r.decisions.iterate}  inconclusive ${r.decisions.inconclusive}`);
  console.log('');
  console.log(`  总误报率（非 inconclusive）  ${pct(r.falsePositiveRate)}   名义 α = ${pct(r.config.alpha)}`);
  console.log(`  正向误报 ship                ${pct(r.shipRate)}   名义 α/2 = 2.50%`);
  console.log(`  负向误报 no-ship             ${pct(r.noShipRate)}   名义 α/2 = 2.50%`);
  console.log(`  iterate                      ${pct(r.iterateRate)}`);
  console.log(`  SRM 误报                     ${pct(r.srmFlagRate)}   名义 ${pct(r.config.srmAlpha)}`);
  console.log(`  硬护栏误报                   ${pct(r.guardrailFlagRate)}   名义 ${pct(r.config.guardrailAlpha)}（单侧）`);
  console.log('');
  console.log(`  贝叶斯 P(B>A) 均值           ${r.bayesMeanProb.toFixed(4)}   （A/A 下应≈0.5）`);
  console.log(`  P(B>A) > 0.95 的比例         ${pct(r.bayesProbAbove095)}   （应≈5%）`);
  console.log('');
  console.log('  主指标 p 值分布（应近似均匀，桶宽 0.1）：');
  const maxBar = Math.max(...r.pValueHistogram);
  r.pValueHistogram.forEach((v, i) => {
    const bar = '█'.repeat(Math.round((v / maxBar) * 40));
    console.log(`    [${(i / 10).toFixed(1)}, ${((i + 1) / 10).toFixed(1)})  ${String(v).padStart(4)}  ${bar}`);
  });
  console.log(`\n  耗时 ${Date.now() - t0}ms → data/aa_report.json\n`);
}
