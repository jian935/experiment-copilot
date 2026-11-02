/**
 * 巡检报告的产出（`npm run inspect`）。
 *
 * 这份脚本的价值不在「打印一份周报」，而在**证明同一份数据永远得到同一份周报**：
 * 它不调模型、不用系统时钟（基准日取数据里最晚的一天）、不重算任何统计量
 * （直接复用缓存好的 Analysis）。所以它的输出可以进 CI 做逐位比对。
 *
 * 用法：
 *   npm run inspect                 # 打印周报摘要 + 前 5 件
 *   npm run inspect -- --md out.md  # 导出完整 Markdown
 *   npm run inspect -- --json       # 只打印 digest（CI 用）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { analyze } from '../src/lib/decide.ts';
import { runInspection, renderMarkdown, INSPECTION_STEPS } from '../src/lib/tasks/inspection.ts';
import type { Dataset } from '../src/lib/types.ts';

const args = process.argv.slice(2);
const mdIdx = args.indexOf('--md');
const mdPath = mdIdx >= 0 ? args[mdIdx + 1] : null;
const jsonOnly = args.includes('--json');

const ds = JSON.parse(readFileSync('public/data/dataset.json', 'utf8')) as Dataset;

const t0 = Date.now();
const analyses = new Map(ds.experiments.map((e) => [e.id, analyze(e, ds.daily)]));
const tAnalyze = Date.now() - t0;

const t1 = Date.now();
const report = runInspection(ds, analyses);
const tInspect = Date.now() - t1;

if (jsonOnly) {
  console.log(JSON.stringify({ asOf: report.asOf, totals: report.totals, power: report.power, digest: report.digest }, null, 2));
  process.exit(0);
}

const { totals: T, power: P, digest: D } = report;
console.log(`\n巡检报告 · 基准日 ${report.asOf}（${ds.experiments.length} 个实验 / ${T.rows.toLocaleString('en-US')} 行）`);
console.log('─'.repeat(88));
console.log(`必须处理 ${T.critical}｜本周处理 ${T.warn}｜等你拍板 ${T.info}｜无需动作 ${T.ok}`);
console.log(
  `引擎结论：上线 ${T.byDecision.ship}｜不上 ${T.byDecision['no-ship']}｜定向 ${T.byDecision.iterate}｜无结论 ${T.byDecision.inconclusive}`,
);

if (report.systemic) {
  console.log(`\n⚠ 系统性问题：${report.systemic}`);
}

console.log(`\n第一屏（${report.mustLook.length} 件，同类只留一个代表）`);
console.log('─'.repeat(88));
if (!report.mustLook.length) {
  console.log('  今天没有必须处理的事。');
} else {
  for (const x of report.mustLook) {
    console.log(`  ${x.expId} [${x.risk}] ${x.name}`);
    console.log(`     ${x.why}`);
    console.log(`     → ${x.next.label}：${x.next.detail.slice(0, 78)}${x.next.detail.length > 78 ? '…' : ''}`);
  }
}

console.log(`\n样本量现状`);
console.log('─'.repeat(88));
console.log(
  `  ${P.inconclusive} 个没结论，其中 ${P.insufficient} 个设计不足、${P.fixable} 个补样本可行；` +
    `能检出的最小相对效应中位数 ${P.medianMdeRel !== null ? (P.medianMdeRel * 100).toFixed(1) + '%' : '—'}，` +
    `业务门槛相对 ${(P.materialityRel * 100).toFixed(0)}%` +
    (P.medianNMultiple !== null ? `（要检出需 ${P.medianNMultiple.toFixed(0)} 倍样本）` : ''),
);

console.log(`\n证据与保真`);
console.log('─'.repeat(88));
console.log(`  证据引用 ${D.evidenceCites} 处，平均每个实验 ${D.evidencePerItem.toFixed(2)} 处`);
console.log(`  引擎判无结论却硬给方向的次数：${D.hardVerdictsOnInconclusive}（必须为 0）`);

console.log(`\n七个步骤（全部确定性）`);
console.log('─'.repeat(88));
INSPECTION_STEPS.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));

console.log(`\n耗时 analyze ${tAnalyze}ms + inspect ${tInspect}ms`);

if (mdPath) {
  writeFileSync(mdPath, renderMarkdown(report), 'utf8');
  console.log(`\nMarkdown 已写入 ${mdPath}`);
}
