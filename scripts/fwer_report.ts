/**
 * 多重比较的证据产出（A6）。
 *
 * 三块数字，各自回答一个不同的问题，混在一起就会变成"我做了校正所以更严谨"：
 *   ① **全零族模拟**：120 个都无效时，"至少一个被判显著"的比例。
 *      naive 应该接近 1（这是算术：1−0.95¹²⁰），Holm / Bonferroni 应该 ≈α。
 *      这是校正方法本身的正确性，与我们的数据无关。
 *   ② **实测 120 个实验**：Holm 把 68 个"显著"收回了几条、收回的是不是真无效的。
 *      这是"校正到底改变了什么"。
 *   ③ **单实验内的跨维度扫描**：4 个分层检验（新/老 × iOS/Android）用 BH 与 Holm 的差别——
 *      本项目在分层上用 BH（找线索）而不是 Holm（下结论），这组数字是那个选择的依据。
 *
 * 用法：
 *   npm run fwer                # 2000 次模拟 + 120 个实验，写 data/fwer_report.json
 *   npm run fwer -- --dry       # 只打印（CI 用）
 *   npm run fwer -- --trials 20000
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { analyze } from '../src/lib/decide.ts';
import { familyReport, simulateFwer, type FwerSim, type FamilyReport } from '../src/lib/multiplicity.ts';
import type { DailyRow, Dataset } from '../src/lib/types.ts';

export interface SegmentScan {
  /** 参与比较的实验数（有 4 个分层检验的） */
  n: number;
  /** BH 判显著的分层总数 / Holm 判显著的分层总数 */
  bhHits: number;
  holmHits: number;
  /** 至少有一个分层只被 BH 判显著的实验数 */
  bhOnlyExperiments: number;
}

export interface FwerReportFile {
  generatedAt: string;
  seedBase: number;
  sim: FwerSim;
  family: {
    n: number;
    alpha: number;
    fdr: number;
    naiveSig: number;
    holmSig: number;
    bonferroniSig: number;
    bhSig: number;
    rescinded: number;
    /** 被收回的里面，注入效应为 0 的条数（真正该收回的） */
    rescindedFalse: number | null;
    naiveAnySig: number;
    /** 被收回的具体实验（给文档举例） */
    rescindedIds: { id: string; archetype: string; p: number; pHolm: number; trueEffect: number | null }[];
  };
  segments: SegmentScan;
}

export function runFwerReport(trials = 2000, datasetPath = 'data/experiments.json'): FwerReportFile {
  const ds: Dataset = JSON.parse(readFileSync(datasetPath, 'utf8'));
  const byExp = new Map<string, DailyRow[]>();
  for (const r of ds.daily) {
    const l = byExp.get(r.expId);
    if (l) l.push(r);
    else byExp.set(r.expId, [r]);
  }
  const analyses = ds.experiments.map((e) => ({ e, a: analyze(e, byExp.get(e.id) ?? []) }));

  const family: FamilyReport = familyReport(
    analyses.map(({ e, a }) => ({
      id: e.id,
      name: e.name,
      p: a.primary.p,
      decision: a.decision,
      archetype: e.archetype,
      trueEffect: e.trueLiftOverall,
      trueDecision: e.trueDecision,
    })),
  );

  let segN = 0;
  let bhHits = 0;
  let holmHits = 0;
  let bhOnly = 0;
  for (const { a } of analyses) {
    const segs = [...a.segments.tenure, ...a.segments.device];
    if (segs.length < 2) continue;
    segN++;
    const bh = segs.filter((s) => s.q <= 0.1).length;
    const holm = segs.filter((s) => s.p <= 0.05 / segs.length).length;
    bhHits += bh;
    holmHits += holm;
    if (bh > holm) bhOnly++;
  }

  return {
    generatedAt: new Date().toISOString(),
    seedBase: ds.seedBase,
    sim: simulateFwer(family.n, trials),
    family: {
      n: family.n,
      alpha: family.alpha,
      fdr: family.fdr,
      naiveSig: family.naiveSig,
      holmSig: family.holmSig,
      bonferroniSig: family.bonferroniSig,
      bhSig: family.bhSig,
      rescinded: family.rescinded,
      rescindedFalse: family.rescindedFalse,
      naiveAnySig: family.naiveAnySig,
      rescindedIds: family.rows
        .filter((r) => r.rescinded)
        .map((r) => ({ id: r.id, archetype: r.archetype ?? '—', p: r.p, pHolm: r.pHolm, trueEffect: r.trueEffect ?? null })),
    },
    segments: { n: segN, bhHits, holmHits, bhOnlyExperiments: bhOnly },
  };
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const isDirect = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/fwer_report.ts');

if (isDirect) {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const dry = process.argv.includes('--dry');
  const ti = process.argv.indexOf('--trials');
  const trials = ti >= 0 ? Number(process.argv[ti + 1]) : Number(positional[0] ?? 2000);
  if (!Number.isFinite(trials) || trials <= 0) {
    console.error(`模拟次数必须是正整数，收到「${trials}」`);
    process.exit(1);
  }
  const t0 = Date.now();
  const r = runFwerReport(trials);
  const json = `${JSON.stringify(r, null, 2)}\n`;
  if (!dry) {
    writeFileSync('data/fwer_report.json', json);
    try {
      writeFileSync('public/data/fwer_report.json', json);
    } catch {
      console.log('（public/data/ 不存在，跳过前端副本）');
    }
  }

  const s = r.sim;
  console.log(`\n① 全零族模拟（${s.m} 个实验全部无效，${s.trials} 次，p ~ U(0,1)）`);
  console.log('─'.repeat(78));
  console.log(`  naive（各自按 α=${s.alpha} 判）  至少一个显著 ${pct(s.naive)}   ← 理论 1−0.95^${s.m} = ${pct(s.naiveTheory)}`);
  console.log(`  Holm                             ${pct(s.holm)}   ← 应≤${(s.alpha * 100).toFixed(0)}%`);
  console.log(`  Bonferroni                       ${pct(s.bonferroni)}   ← 应≤${(s.alpha * 100).toFixed(0)}%`);
  console.log(`  BH（q=${s.alpha}，全零族下等价于控 FWER）  ${pct(s.bh)}`);

  const f = r.family;
  console.log(`\n② 实测 120 个实验（同一份数据，四种口径看"显著"几条）`);
  console.log('─'.repeat(78));
  console.log(`  naive ${f.naiveSig}  ·  Holm ${f.holmSig}  ·  Bonferroni ${f.bonferroniSig}  ·  BH(q=${f.fdr}) ${f.bhSig}`);
  console.log(
    `  Holm 收回 ${f.rescinded} 条${f.rescindedFalse === null ? '' : `，其中 ${f.rescindedFalse} 条注入效应为 0（本就该收回）`}`,
  );
  if (f.rescindedIds.length) {
    console.log('  被收回的：');
    for (const x of f.rescindedIds) {
      console.log(
        `    ${x.id} ${x.archetype.padEnd(13)} p=${x.p.toExponential(2)} → Holm ${x.pHolm.toFixed(3)}  真实效应 ${(x.trueEffect ?? 0).toFixed(4)}`,
      );
    }
  }

  const g = r.segments;
  console.log(`\n③ 单实验内的跨维度扫描（${g.n} 个实验 × 4 个分层检验）`);
  console.log('─'.repeat(78));
  console.log(`  BH(q=0.1) 判显著 ${g.bhHits} 个分层  ·  Holm(α=0.05) 只有 ${g.holmHits} 个`);
  console.log(`  ${g.bhOnlyExperiments} 个实验会出现"BH 说某个分层有效、Holm 说没有"`);
  console.log(`  → 所以分层扫描用 BH（找线索，漏掉真实分层比多看一眼假分层更贵），`);
  console.log(`     跨实验清单用 Holm（要下结论，错一个就上线一个没用的版本）。`);
  console.log(`\n  耗时 ${Date.now() - t0}ms → ${dry ? '（--dry，未写文件）' : 'data/fwer_report.json'}\n`);
}
