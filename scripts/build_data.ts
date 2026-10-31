/**
 * 把 data/experiments.json 压成前端要 fetch 的静态文件。
 * 保留全部字段（详情页要能复算），只去掉缩进；1.18MB → 约 0.7MB。
 */
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';

const SRC = 'data/experiments.json';
const OUT = 'public/data/dataset.json';

const raw = readFileSync(SRC, 'utf8');
const json = JSON.parse(raw) as { experiments: unknown[]; daily: unknown[] };

mkdirSync('public/data', { recursive: true });
writeFileSync(OUT, JSON.stringify(json));

const kb = (n: number) => `${(n / 1024).toFixed(0)}KB`;
console.log(
  `dataset: ${json.experiments.length} experiments, ${json.daily.length} rows | ` +
    `${kb(statSync(SRC).size)} → ${kb(statSync(OUT).size)} (${OUT})`,
);
