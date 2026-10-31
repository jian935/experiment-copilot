import { mkdirSync, writeFileSync } from 'node:fs';
import { generateDataset } from '../src/lib/simulate.ts';
import type { Archetype } from '../src/lib/types.ts';

const ds = generateDataset(20261031);
mkdirSync('data', { recursive: true });
writeFileSync('data/experiments.json', JSON.stringify(ds));

// 导出 CSV，便于人工抽查（不是应用数据源）
const csv = (rows: (string | number)[][]) =>
  rows.map((r) => r.map((v) => (typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n');

const expHeader = ['exp_id', 'exp_name', 'hypothesis', 'start_date', 'end_date', 'variants', 'traffic_split', 'primary_metric', 'metric_type', 'guardrail_metrics', 'archetype', 'true_lift', 'true_lift_scope', 'true_lift_overall', 'true_decision', 'seed'];
const expRows = ds.experiments.map((e) => [e.id, e.name, e.hypothesis, e.startDate, e.endDate, e.variants.join('|'), e.trafficSplit, e.primaryMetric, e.metricType, e.guardrailMetrics.join('|'), e.archetype, e.trueLift, e.trueLiftScope, e.trueLiftOverall, e.trueDecision, e.seed]);
writeFileSync('data/experiments.csv', csv([expHeader, ...expRows]));

const dailyHeader = ['exp_id', 'date', 'variant', 'device', 'tenure', 'exposures', 'conversions', 'refunds', 'complaints', 'latency_p95'];
const dailyRows = ds.daily.map((r) => [r.expId, r.date, r.variant, r.device, r.tenure, r.exposures, r.conversions, r.refunds, r.complaints, r.latencyP95]);
writeFileSync('data/daily_metrics.csv', csv([dailyHeader, ...dailyRows]));

const byArch: Record<string, number> = {};
for (const e of ds.experiments) byArch[e.archetype] = (byArch[e.archetype] || 0) + 1;
const byDecision: Record<string, number> = {};
for (const e of ds.experiments) byDecision[e.trueDecision] = (byDecision[e.trueDecision] || 0) + 1;

console.log('generated:', ds.experiments.length, 'experiments |', ds.daily.length, 'daily rows');
console.log('archetypes:', JSON.stringify(byArch as Record<Archetype, number>));
console.log('true decisions:', JSON.stringify(byDecision));
console.log('files: data/experiments.json, data/experiments.csv, data/daily_metrics.csv');
