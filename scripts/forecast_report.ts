/**
 * 「还要跑几天」的批量报告：对主数据集的 120 个实验各跑一次预测，
 * 输出可复现的 JSON（npm run forecast）。
 *
 * 为什么要有这个脚本：预测本身是随机模拟，光靠单测只能验形状对不对；
 * 把它在整个数据集上跑一遍，才能看出「大多数实验的预测是不是合理」
 * （例如有没有大面积返回 Infinity、有没有一堆 stuck=100% 其实是因为效应真为 0）。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { analyze } from '../src/lib/decide.ts';
import { dailyRatePerArm, forecast } from '../src/lib/forecast.ts';
import { generateDataset } from '../src/lib/simulate.ts';

const ds = generateDataset(20261031);
const rowsByExp = new Map<string, typeof ds.daily>();
for (const r of ds.daily) {
  const list = rowsByExp.get(r.expId);
  if (list) list.push(r);
  else rowsByExp.set(r.expId, [r]);
}

interface Row {
  id: string;
  archetype: string;
  decision: string;
  diffPP: number;
  p: number;
  significant: boolean;
  medianDays: number | null;
  p80Days: number | null;
  stuck: number;
  requiredNPerArm: number | null;
  remainingDays: number | null;
  rate: number;
  verdict: string;
}

const rows: Row[] = [];
for (const exp of ds.experiments) {
  const rowsOfExp = rowsByExp.get(exp.id) ?? [];
  const a = analyze(exp, rowsOfExp);
  let n1 = 0, c1 = 0, n2 = 0, c2 = 0;
  for (const r of rowsOfExp) {
    if (r.variant === 'control') {
      n1 += r.exposures;
      c1 += r.conversions;
    } else {
      n2 += r.exposures;
      c2 += r.conversions;
    }
  }
  const f = forecast({
    n1,
    c1,
    n2,
    c2,
    diff: a.primary.diff,
    se: a.primary.se,
    dailyRate: dailyRatePerArm(rowsOfExp, 3),
    elapsedDays: new Set(rowsOfExp.map((r) => r.date)).size,
    horizonDays: 30,
    sims: 2000,
    seed: 20261101,
  });
  rows.push({
    id: exp.id,
    archetype: exp.archetype,
    decision: a.decision,
    diffPP: +(a.primary.diff * 100).toFixed(3),
    p: a.primary.p,
    significant: f.observed.significant,
    medianDays: f.sim.medianDays,
    p80Days: f.sim.p80Days,
    stuck: +f.sim.stuck.toFixed(3),
    requiredNPerArm: Number.isFinite(f.point.requiredNPerArm) ? f.point.requiredNPerArm : null,
    remainingDays: Number.isFinite(f.point.remainingDays) ? f.point.remainingDays : null,
    rate: Math.round(f.rate.perArmPerDay),
    verdict: f.verdict.code,
  });
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) / 2;
  return s.length % 2 ? s[Math.floor(i)] : (s[Math.floor(i)] + s[Math.ceil(i)]) / 2;
};

const notSig = rows.filter((r) => !r.significant);
const byArch = new Map<string, Row[]>();
for (const r of rows) {
  const list = byArch.get(r.archetype) ?? [];
  list.push(r);
  byArch.set(r.archetype, list);
}

const report = {
  generatedAt: new Date().toISOString(),
  seed: ds.seedBase,
  experiments: rows.length,
  horizonDays: 30,
  sims: 2000,
  significant: rows.filter((r) => r.significant).length,
  notSignificant: notSig.length,
  /** 未显著的实验里，「跑满 30 天仍等不到」的比例 —— 这个数高说明「再等等」多半是等不到的 */
  stuckAmongNotSignificant: +(notSig.filter((r) => r.stuck >= 0.5).length / Math.max(1, notSig.length)).toFixed(3),
  medianDays: median(notSig.map((r) => r.medianDays).filter((v): v is number => v !== null)),
  verdictCounts: rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
    return acc;
  }, {}),
  byArchetype: [...byArch.entries()].map(([archetype, list]) => ({
    archetype,
    n: list.length,
    significant: list.filter((r) => r.significant).length,
    medianStuck: +median(list.map((r) => r.stuck))!.toFixed(3),
    medianDays: median(list.map((r) => r.medianDays).filter((v): v is number => v !== null)),
  })),
  samples: rows.filter((r) => !r.significant).slice(0, 5),
};

mkdirSync('data', { recursive: true });
writeFileSync('data/forecast_report.json', JSON.stringify(report, null, 2) + '\n');

console.log('=== 还要跑几天 · 批量报告 ===');
console.log(`实验数 ${report.experiments}（已显著 ${report.significant}，未显著 ${report.notSignificant}）`);
console.log(`未显著实验里「跑满 ${report.horizonDays} 天仍等不到」占 ${(report.stuckAmongNotSignificant * 100).toFixed(1)}%`);
console.log(`未显著实验的中位天数：${report.medianDays ?? '—'}`);
console.log(`判定分布：${JSON.stringify(report.verdictCounts)}`);
console.log('按类型：');
for (const a of report.byArchetype) {
  console.log(
    `  ${a.archetype.padEnd(14)} n=${String(a.n).padStart(3)} 已显著 ${String(a.significant).padStart(3)}  stuck 中位 ${a.medianStuck}  天数中位 ${a.medianDays ?? '—'}`,
  );
}
console.log('样例（未显著的）：');
for (const s of report.samples) {
  console.log(
    `  ${s.id} ${s.archetype} Δ=${s.diffPP}pp p=${s.p.toFixed(3)} 第 ${s.medianDays ?? '—'} 天 / 80% ${s.p80Days ?? '—'} 天 · stuck ${(s.stuck * 100).toFixed(0)}% · ${s.verdict}`,
  );
}
console.log('\n已写入 data/forecast_report.json');
