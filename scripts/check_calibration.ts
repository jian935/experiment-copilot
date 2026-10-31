import { readFileSync } from 'node:fs';
import { analyze } from '../src/lib/decide.ts';
import type { Dataset, Decision } from '../src/lib/types.ts';

const ds: Dataset = JSON.parse(readFileSync('data/experiments.json', 'utf8'));
const labels: Decision[] = ['ship', 'no-ship', 'iterate', 'inconclusive'];
const cm: Record<string, Record<string, number>> = {};
for (const t of labels) {
  cm[t] = {};
  for (const p of labels) cm[t][p] = 0;
}

let correct = 0;
const mismatches: string[] = [];
for (const e of ds.experiments) {
  const a = analyze(e, ds.daily);
  cm[e.trueDecision][a.decision]++;
  if (a.decision === e.trueDecision) correct++;
  else mismatches.push(`${e.id} ${e.archetype.padEnd(13)} true=${e.trueDecision.padEnd(12)} pred=${a.decision.padEnd(12)} ${a.reasonCode.padEnd(13)} p=${a.overall.p.toExponential(2)}`);
}

const total = ds.experiments.length;
console.log(`\n校准自检：${total} 个实验\n`);
console.log('混淆矩阵（行=真实，列=预测）');
console.log('true\\pred     ' + labels.map((l) => l.padEnd(12)).join(''));
for (const t of labels) console.log(t.padEnd(14) + labels.map((p) => String(cm[t][p]).padEnd(12)).join(''));

const byArch: Record<string, { n: number; ok: number; ship: number; noship: number; iter: number; inc: number }> = {};
for (const e of ds.experiments) {
  const a = analyze(e, ds.daily);
  const b = (byArch[e.archetype] ||= { n: 0, ok: 0, ship: 0, noship: 0, iter: 0, inc: 0 });
  b.n++;
  if (a.decision === e.trueDecision) b.ok++;
  if (a.decision === 'ship') b.ship++;
  if (a.decision === 'no-ship') b.noship++;
  if (a.decision === 'iterate') b.iter++;
  if (a.decision === 'inconclusive') b.inc++;
}

console.log('\n按类型：');
for (const [k, v] of Object.entries(byArch)) {
  console.log(`  ${k.padEnd(14)} n=${String(v.n).padStart(3)} 一致=${String(v.ok).padStart(3)} (${((v.ok / v.n) * 100).toFixed(1)}%)  ship=${v.ship} no-ship=${v.noship} iterate=${v.iter} inconclusive=${v.inc}`);
}

const nullN = byArch.null?.n || 0;
const nullShip = byArch.null?.ship || 0;
const posN = byArch.positive?.n || 0;
const posMiss = posN - (byArch.positive?.ok || 0);
const negN = byArch.negative?.n || 0;
const negMiss = negN - (byArch.negative?.ok || 0);

console.log('\n关键指标：');
console.log(`  决策准确率        ${(correct / total * 100).toFixed(1)}%  (${correct}/${total})`);
console.log(`  null 误报率(FPR)  ${nullN ? (nullShip / nullN * 100).toFixed(1) : '0'}%  (${nullShip}/${nullN})`);
console.log(`  正效应漏判(FNR)   ${posN ? (posMiss / posN * 100).toFixed(1) : '0'}%  (${posMiss}/${posN})`);
console.log(`  负效应漏判(FNR)   ${negN ? (negMiss / negN * 100).toFixed(1) : '0'}%  (${negMiss}/${negN})`);

if (mismatches.length) {
  console.log('\n不一致样例（前 12 条）：');
  for (const m of mismatches.slice(0, 12)) console.log('  ' + m);
}
