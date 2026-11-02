/**
 * 任务级评测 + 回归基线（`npm run eval:tasks`）。
 *
 * 与 `eval_report.ts` 的关系：那个管「统计与问答」的 86 项指标，
 * 这个管「巡检这个任务办得成办不成」。两套基线分开，是因为它们的
 * 变化原因不同——统计口径一动该红的是前者，巡检映射一动该红的是后者。
 * 混在一份基线里，改一处会同时红一片，最后没人敢动。
 *
 * 用法：
 *   npm run eval:tasks            # 打印
 *   npm run eval:tasks -- --write # 写基线
 *   npm run eval:tasks -- --check # 比对基线，漂移退出码 1（CI 用）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { analyze } from '../src/lib/decide.ts';
import { evaluateTasks } from '../src/lib/tasks/eval.ts';
import { runInspection } from '../src/lib/tasks/inspection.ts';
import type { Dataset } from '../src/lib/types.ts';

const BASELINE = 'eval/task_baseline.json';
const WRITE = process.argv.includes('--write');
const CHECK = process.argv.includes('--check');

const ds = JSON.parse(readFileSync('public/data/dataset.json', 'utf8')) as Dataset;
const analyses = new Map(ds.experiments.map((e) => [e.id, analyze(e, ds.daily)]));

const t0 = Date.now();
const ev = evaluateTasks(ds, analyses);
const report = runInspection(ds, analyses);
const ms = Date.now() - t0;

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

/** 扁平化成「名字 → 数字」，便于逐位比对（与 evalBaseline 同一套思路，但结构不同） */
function flatten(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of ev.cases) out[`case.${c.id}`] = c.passed ? 1 : 0;
  out['task.passed'] = ev.passed;
  out['task.failed'] = ev.failed;
  out['task.total'] = ev.cases.length;
  out['metric.alignment'] = ev.metrics.alignment;
  out['metric.inventedDirections'] = ev.metrics.inventedDirections;
  out['metric.engineFalsePositive'] = ev.metrics.engineFalsePositive;
  out['metric.coverage'] = ev.metrics.coverage;
  out['metric.fidelityNumbers'] = ev.metrics.fidelity.numbers;
  out['metric.fidelitySuspicious'] = ev.metrics.fidelity.suspicious;
  // 巡检自身的规模与分布：任何一个漂移都说明判定逻辑被改了
  out['inspect.experiments'] = report.totals.experiments;
  out['inspect.critical'] = report.totals.critical;
  out['inspect.warn'] = report.totals.warn;
  out['inspect.info'] = report.totals.info;
  out['inspect.ok'] = report.totals.ok;
  out['inspect.mustLook'] = report.mustLook.length;
  out['inspect.designInsufficient'] = report.digest.designInsufficient;
  out['inspect.underpowered'] = report.digest.underpowered;
  out['inspect.noEffectConfident'] = report.digest.noEffectConfident;
  out['inspect.evidenceCites'] = report.digest.evidenceCites;
  out['inspect.evidencePerItem'] = report.digest.evidencePerItem;
  out['inspect.inconclusive'] = report.power.inconclusive;
  out['inspect.medianNMultiple'] = report.power.medianNMultiple ?? -1;
  out['inspect.medianMdeRel'] = report.power.medianMdeRel ?? -1;
  return out;
}

const cur = flatten();

if (WRITE) {
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(
    BASELINE,
    JSON.stringify({ note: '巡检任务级基线（确定性，逐位比对）', values: cur }, null, 2) + '\n',
    'utf8',
  );
  console.log(`基线已写入 ${BASELINE}（${Object.keys(cur).length} 项）`);
  process.exit(0);
}

console.log(`\n任务级评测 · ${ev.scale.experiments} 个实验 / ${ev.scale.rows.toLocaleString('en-US')} 行（${ms}ms）`);
console.log('─'.repeat(88));
console.log(`任务 ${ev.passed}/${ev.cases.length} 通过`);
for (const c of ev.cases) {
  console.log(`  ${c.passed ? '✓' : '✗'} [${c.group}] ${c.name}`);
  if (!c.passed) for (const f of c.failures) console.log(`      - ${f}`);
}

console.log('\n指标（分清谁的问题）');
console.log('─'.repeat(88));
console.log(`  下一步与引擎决策相容率   ${pct(ev.metrics.alignment)}（分母 ${ev.scale.experiments} 个实验）`);
console.log(`  无结论却给方向的次数     ${ev.metrics.inventedDirections}（必须 0）`);
console.log(`  证据引用覆盖             ${pct(ev.metrics.coverage)}`);
console.log(`  报告数字串 / 可疑        ${ev.metrics.fidelity.numbers} / ${ev.metrics.fidelity.suspicious}`);
console.log(`  引擎在零效应实验上的假阳性 ${pct(ev.metrics.engineFalsePositive)}（这是引擎的指标，不是巡检的）`);

if (CHECK) {
  if (!existsSync(BASELINE)) {
    console.error(`\n✗ 基线不存在：${BASELINE}。先跑 npm run eval:tasks -- --write`);
    process.exit(1);
  }
  const base = JSON.parse(readFileSync(BASELINE, 'utf8')) as { values: Record<string, number> };
  const diffs: string[] = [];
  for (const [k, v] of Object.entries(cur)) {
    const b = base.values[k];
    if (b === undefined) diffs.push(`+ ${k} = ${v}（基线里没有）`);
    else if (Math.abs(b - v) > 1e-9) diffs.push(`~ ${k}: ${b} → ${v}`);
  }
  for (const k of Object.keys(base.values)) {
    if (!(k in cur)) diffs.push(`- ${k}（当前没有）`);
  }
  if (diffs.length) {
    console.error(`\n✗ 与基线不一致 ${diffs.length} 处：`);
    for (const d of diffs) console.error(`  ${d}`);
    process.exit(1);
  }
  console.log(`\n✓ 与基线逐位一致（${Object.keys(cur).length} 项）`);
}
