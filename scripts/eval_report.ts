/**
 * 评测报告 + 回归基线（E6 / G1 的本地那一半）
 *
 * 三件事：
 *  1. 打印一份完整评测报告（决策 / 分层 F1 / Agent 问答 / 校准）
 *  2. 写 `data/agent_eval.json` 给看板 fetch（1700 条回答不可能在浏览器里实时生成）
 *  3. `--check` 时与 `eval/baseline.json` 逐指标比对，任何漂移都会 exit 1
 *
 * 为什么基线只覆盖「确定性」部分：
 *   同 seed 下 gen → analyze → evaluate 是完全确定的，指标必须**逐位一致**；
 *   一旦不一致，要么是数据变了（那要显式改基线），要么是代码悄悄改了决策阈值——
 *   这两种都不该悄悄通过。A/A / CUPED 那些带随机模拟的报告不进基线，
 *   它们的批次波动写在自己的报告里。
 *
 * 用法：
 *   npm run eval              # 打印报告 + 写 data/agent_eval.json
 *   npm run eval -- --write   # 另外把当前值写成基线
 *   npm run eval -- --check   # 与基线比对，漂移则退出码 1（CI 用这个）
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { analyze } from '../src/lib/decide.ts';
import { evaluate } from '../src/lib/evaluate.ts';
import { flattenEval, flattenAgent, diffBaseline, describeChange } from '../src/lib/evalBaseline.ts';
import type { BaselineSnapshot } from '../src/lib/evalBaseline.ts';
import { evaluateAgent, byQa } from '../src/lib/agentEval.ts';
import { DEFAULT_CONFIG } from '../src/lib/config.ts';
import type { Dataset } from '../src/lib/types.ts';

const BASELINE = 'eval/baseline.json';
const AGENT_OUT = 'data/agent_eval.json';
const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const CHECK = args.includes('--check');

const ds: Dataset = JSON.parse(readFileSync('data/experiments.json', 'utf8'));

/**
 * 数据指纹。**不含 generatedAt**（每次生成都变），只指纹真正喂给引擎的内容。
 * JSON.stringify 依赖键插入顺序，而同一份代码构造对象的顺序是稳定的，所以可以作指纹用；
 * 一旦生成器改了字段或抽样顺序，指纹就会变。
 */
const contentHash = createHash('sha256')
  .update(JSON.stringify({ seedBase: ds.seedBase, experiments: ds.experiments, daily: ds.daily }))
  .digest('hex')
  .slice(0, 16);
const analyses = new Map(ds.experiments.map((e) => [e.id, analyze(e, ds.daily)]));

const t0 = Date.now();
const agent = evaluateAgent(ds, analyses);
const r = evaluate(ds, analyses, { agent });
const elapsed = Date.now() - t0;

const pct = (v: number, d = 2) => `${(v * 100).toFixed(d)}%`;

const current: Record<string, number> = { ...flattenEval(r), ...(r.agent ? flattenAgent(r.agent) : {}) };

// ---- 看板数据（瘦身：1700 条回答全文不进前端） ----
mkdirSync('data', { recursive: true });
const agentFile = {
  generatedAt: new Date().toISOString(),
  seedBase: ds.seedBase,
  config: {
    alpha: DEFAULT_CONFIG.alpha,
    interactionAlpha: DEFAULT_CONFIG.interactionAlpha,
    segmentFdr: DEFAULT_CONFIG.segmentFdr,
    seMode: DEFAULT_CONFIG.seMode,
    useCuped: DEFAULT_CONFIG.useCuped,
  },
  summary: {
    n: agent.n,
    numbers: agent.numbers,
    suspicious: agent.suspicious,
    hallucinationRate: agent.hallucinationRate,
    dirtyAnswerRate: agent.dirtyAnswerRate,
    citationRate: agent.citationRate,
    citableN: agent.citableN,
    violationRate: agent.violationRate,
    scopeRate: agent.scopeRate,
    trapN: agent.trapN,
    routeAccuracy: agent.routeAccuracy,
    routeN: agent.routeN,
  },
  byGroup: agent.byGroup,
  byIntent: agent.byIntent,
  byQa: byQa(agent),
  toolCalls: agent.toolCalls,
  uncoveredTools: agent.uncoveredTools,
  // 只留有问题的回答：审计用，也防止文件变成几 MB
  problems: agent.rows
    .filter((x) => x.suspicious > 0 || x.violations.length > 0)
    .map((x) => ({ expId: x.expId, qaId: x.qaId, q: x.q, suspicious: x.suspiciousList, violations: x.violations, answer: x.answer })),
};
writeFileSync(AGENT_OUT, JSON.stringify(agentFile, null, 2) + '\n');

// ---- 报告 ----
const h = r.hetero;
console.log(`\n=== 评测报告（${r.n} 个实验，耗时 ${elapsed}ms）===`);
console.log(`决策准确率 ${pct(r.accuracy, 1)}（${r.correct}/${r.n}）  null FPR ${pct(r.fpr.rate, 1)}（${r.fpr.hit}/${r.fpr.n}）`);
console.log(`正效应漏判 ${pct(r.fnrPositive.rate, 1)} 负效应漏判 ${pct(r.fnrNegative.rate, 1)}  贝叶斯 ECE ${pct(r.ece, 1)}`);

console.log(`\n分层（异质）检测 F1`);
console.log(`  四格 TP=${h.tp} FP=${h.fp} FN=${h.fn} TN=${h.tn}（真异质 ${h.positives} 个）`);
console.log(`  precision ${h.precision.toFixed(3)} · recall ${h.recall.toFixed(3)} · F1 ${h.f1.toFixed(3)}  95%CI [${h.f1Ci[0].toFixed(3)}, ${h.f1Ci[1].toFixed(3)}]`);
console.log(
  `  放宽口径（只要求交互显著）：F1 ${h.interactionOnly.f1.toFixed(3)}（P ${h.interactionOnly.precision.toFixed(3)} / R ${h.interactionOnly.recall.toFixed(3)}，FP ${h.interactionOnly.fp}）`,
);
console.log(`  说明：区间来自对实验重抽样 ${1000} 次（固定 seed）；正例只有 ${h.positives} 个，点估计不稳。`);

console.log(`\nAgent 问答（D6 幻觉数字率）`);
console.log(`  ${agent.n} 条问答 · ${agent.numbers} 个数字 · 可疑 ${agent.suspicious} 个 → 幻觉数字率 ${pct(agent.hallucinationRate, 3)}`);
console.log(`  引用覆盖 ${pct(agent.citationRate, 1)}（分母 ${agent.citableN}，无证据可引的不计入）  违规率 ${pct(agent.violationRate, 2)}`);
console.log(`  口径陷阱 ${pct(agent.scopeRate, 1)}（分母 ${agent.trapN}）  路由准确 ${pct(agent.routeAccuracy, 1)}（分母 ${agent.routeN}）`);
console.log(`  工具覆盖 ${agent.toolCalls.filter((t) => t.calls > 0).length}/${agent.toolCalls.length}${agent.uncoveredTools.length ? ` · 未覆盖：${agent.uncoveredTools.join(',')}` : ''}`);

console.log('\n按题号：');
for (const q of byQa(agent)) {
  const flag = q.suspicious > 0 || q.citationRate < 1 || q.routeAccuracy < 1 ? ' ←' : '';
  console.log(
    `  ${q.qaId.padEnd(9)} ${q.group.padEnd(3)} n=${String(q.n).padStart(3)} 可疑 ${q.suspicious} 引用 ${pct(q.citationRate, 0)} 路由 ${pct(q.routeAccuracy, 0)}${flag}`,
  );
}

if (r.mismatches.length) {
  console.log(`\n不一致（${r.mismatches.length} 条）：`);
  for (const m of r.mismatches) {
    console.log(`  ${m.id} ${m.archetype.padEnd(13)} true=${m.trueDecision.padEnd(12)} pred=${m.predDecision.padEnd(12)} ${m.reasonCode}`);
  }
}

console.log(`\n→ ${AGENT_OUT}（看板 fetch 它）`);

// ---- 基线 ----
if (CHECK || WRITE) {
  const snapshot = {
    generatedAt: new Date().toISOString(),
    dataset: { seedBase: ds.seedBase, experiments: ds.experiments.length, daily: ds.daily.length, contentHash },
    config: agentFile.config,
    metrics: current,
    strings: { uncoveredTools: agent.uncoveredTools.join(',') },
  };

  if (WRITE) {
    mkdirSync('eval', { recursive: true });
    writeFileSync(BASELINE, JSON.stringify(snapshot, null, 2) + '\n');
    console.log(`→ ${BASELINE}（${Object.keys(current).length} 个指标已写入基线）`);
  }

  if (CHECK) {
    if (!existsSync(BASELINE)) {
      console.error(`\n✗ 找不到 ${BASELINE}。先跑 npm run eval -- --write 生成基线。`);
      process.exit(1);
    }
    const base = JSON.parse(readFileSync(BASELINE, 'utf8')) as BaselineSnapshot;
    const d = diffBaseline(current, base.metrics, snapshot.strings, base.strings);
    // 指纹只在基线有值时比对（第一次加这个字段时基线里还没有，不该因此红）
    const hashChanged = !!base.dataset.contentHash && base.dataset.contentHash !== contentHash;

    console.log(`\n基线比对：${Object.keys(current).length} 个指标（对照 ${BASELINE}）`);
    if (hashChanged) {
      console.log(`  ✗ 数据指纹变了 ${base.dataset.contentHash} → ${contentHash}`);
      console.log('    说明生成器的字段或随机流被改动过，这批数据已经不是同一批——全部数字都要重测，不能只更新基线。');
    }
    if (d.clean && !hashChanged) {
      console.log('  ✓ 全部一致（同 seed 下评测指标必须逐位相同，数据指纹也相同）');
    } else {
      for (const x of d.drift) console.log(`  ✗ ${x.key.padEnd(34)} ${describeChange(x.from, x.to)}`);
      for (const x of d.stringDrift) console.log(`  ✗ ${x.key.padEnd(34)} "${x.from}" → "${x.to}"`);
      for (const k of d.added) console.log(`  + 新增指标 ${k}（基线里没有）`);
      for (const k of d.removed) console.log(`  - 指标消失 ${k}`);
      console.error(
        `\n✗ 评测结果与基线不符：${d.drift.length} 处变化、${d.added.length} 新增、${d.removed.length} 消失${hashChanged ? '、数据指纹变化' : ''}。\n` +
          `  如果这次改动**有意**改变口径，跑 npm run eval -- --write 更新基线并在提交信息里写明原因；\n` +
          `  如果不是有意的，说明决策逻辑被改动过，先查清楚再提交。`,
      );
      process.exit(1);
    }
  }
}
