import { readFileSync } from 'node:fs';
import { analyze } from '../src/lib/decide.ts';
import { evaluate, DECISIONS } from '../src/lib/evaluate.ts';
import type { Dataset } from '../src/lib/types.ts';

// 口径唯一源：src/lib/evaluate.ts（看板与脚本共用，避免两套数字）
const ds: Dataset = JSON.parse(readFileSync('data/experiments.json', 'utf8'));
const analyses = new Map(ds.experiments.map((e) => [e.id, analyze(e, ds.daily)]));
const r = evaluate(ds, analyses);

console.log(`\n校准自检：${r.n} 个实验\n`);
console.log('混淆矩阵（行=真实，列=预测）');
console.log('true\\pred     ' + DECISIONS.map((l) => l.padEnd(13)).join(''));
for (let i = 0; i < DECISIONS.length; i++) {
  console.log(DECISIONS[i].padEnd(14) + r.confusion[i].map((v) => String(v).padEnd(13)).join(''));
}

console.log('\n按类型：');
for (const a of r.byArchetype) {
  console.log(
    `  ${a.archetype.padEnd(14)} n=${String(a.n).padStart(3)} 一致=${String(a.correct).padStart(3)} (${(a.accuracy * 100).toFixed(1)}%)`,
  );
}

console.log('\n按证据强度（p 值分桶）：');
for (const b of r.byPValue) {
  console.log(`  ${b.label.padEnd(16)} n=${String(b.n).padStart(3)} 一致=${String(b.correct).padStart(3)} (${(b.accuracy * 100).toFixed(1)}%)`);
}

console.log('\n关键指标：');
console.log(`  决策准确率        ${(r.accuracy * 100).toFixed(1)}%  (${r.correct}/${r.n})`);
console.log(`  null 误报率(FPR)  ${(r.fpr.rate * 100).toFixed(1)}%  (${r.fpr.hit}/${r.fpr.n})`);
console.log(`  正效应漏判(FNR)   ${(r.fnrPositive.rate * 100).toFixed(1)}%  (${r.fnrPositive.miss}/${r.fnrPositive.n})`);
console.log(`  负效应漏判(FNR)   ${(r.fnrNegative.rate * 100).toFixed(1)}%  (${r.fnrNegative.miss}/${r.fnrNegative.n})`);

if (r.mismatches.length) {
  console.log('\n不一致样例（前 12 条）：');
  for (const m of r.mismatches.slice(0, 12)) {
    console.log(
      `  ${m.id} ${m.archetype.padEnd(13)} true=${m.trueDecision.padEnd(12)} pred=${m.predDecision.padEnd(12)} ${m.reasonCode.padEnd(13)} p=${m.p.toExponential(2)}`,
    );
  }
}
