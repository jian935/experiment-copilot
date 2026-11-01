/**
 * 评测基线：扁平化 + 比对（E6）
 *
 * 为什么把这段从脚本里抽出来：**检查器本身必须被测**。
 * 一段「永远报通过」的比对代码，比没有比对更危险——它会让人误以为指标受控。
 * 所以这里全是纯函数，配 `tests/evalBaseline.test.ts`：证明它抓得到漂移、也不会被浮点表示误差误报。
 */
import type { EvalSummary } from './evaluate.ts';
import type { AgentQaEval } from './agentEval.ts';

export interface BaselineSnapshot {
  generatedAt: string;
  /**
   * 数据指纹：去掉 generatedAt 后对 experiments + daily 求 sha256 前 16 位。
   * 有了它，「同一份代码重建出同一份数据」可以逐字断言——比只看指标漂移更早发现问题：
   * 生成器的随机流一变，指标可能恰好没动（比如只改了没被用到的字段），但那批数据已经不是同一批。
   */
  dataset: { seedBase: number; experiments: number; daily: number; contentHash?: string };
  config: Record<string, number | string | boolean | undefined>;
  metrics: Record<string, number>;
  strings: Record<string, string>;
}

export interface BaselineDiff {
  /** 值变了的指标 */
  drift: { key: string; from: number; to: number }[];
  /** 当前有、基线没有（新增指标，通常是加了新功能） */
  added: string[];
  /** 基线有、当前没有（指标被删或改名） */
  removed: string[];
  /** 字符串类字段的变化（如 uncoveredTools） */
  stringDrift: { key: string; from: string; to: string }[];
  /** 是否完全一致 */
  clean: boolean;
}

/** 把评测结果摊平成「指标名 → 数值」。key 用点号分层，便于直接看出是哪一块变了 */
export function flattenEval(s: EvalSummary): Record<string, number> {
  const f: Record<string, number> = {};
  f['n'] = s.n;
  f['correct'] = s.correct;
  f['accuracy'] = s.accuracy;
  f['fpr.hit'] = s.fpr.hit;
  f['fpr.n'] = s.fpr.n;
  f['fnrPositive.miss'] = s.fnrPositive.miss;
  f['fnrPositive.n'] = s.fnrPositive.n;
  f['fnrNegative.miss'] = s.fnrNegative.miss;
  f['fnrNegative.n'] = s.fnrNegative.n;
  f['ece'] = s.ece;
  f['eceEffects.ece'] = s.eceEffects.ece;
  f['eceEffects.n'] = s.eceEffects.n;
  s.confusion.forEach((row, i) => row.forEach((v, j) => (f[`confusion.${i}${j}`] = v)));
  for (const a of s.byArchetype) {
    f[`archetype.${a.archetype}.n`] = a.n;
    f[`archetype.${a.archetype}.correct`] = a.correct;
  }
  for (const b of s.byPValue) {
    f[`pBucket.${b.label}.n`] = b.n;
    f[`pBucket.${b.label}.correct`] = b.correct;
  }
  f['hetero.tp'] = s.hetero.tp;
  f['hetero.fp'] = s.hetero.fp;
  f['hetero.fn'] = s.hetero.fn;
  f['hetero.tn'] = s.hetero.tn;
  f['hetero.f1'] = s.hetero.f1;
  f['hetero.precision'] = s.hetero.precision;
  f['hetero.recall'] = s.hetero.recall;
  f['hetero.interactionOnly.tp'] = s.hetero.interactionOnly.tp;
  f['hetero.interactionOnly.fp'] = s.hetero.interactionOnly.fp;
  f['hetero.interactionOnly.f1'] = s.hetero.interactionOnly.f1;
  return f;
}

/** Agent 那一块的指标（D6）。单独一个函数，是因为它要等 agent 结果才算得出来 */
export function flattenAgent(a: AgentQaEval): Record<string, number> {
  const f: Record<string, number> = {
    'agent.n': a.n,
    'agent.numbers': a.numbers,
    'agent.suspicious': a.suspicious,
    'agent.hallucinationRate': a.hallucinationRate,
    'agent.dirtyAnswerRate': a.dirtyAnswerRate,
    'agent.citationRate': a.citationRate,
    'agent.citableN': a.citableN,
    'agent.violationRate': a.violationRate,
    'agent.scopeRate': a.scopeRate,
    'agent.trapN': a.trapN,
    'agent.routeAccuracy': a.routeAccuracy,
    'agent.routeN': a.routeN,
  };
  for (const t of a.toolCalls) f[`agent.tool.${t.tool}`] = t.calls;
  return f;
}

/**
 * 浮点容差。确定性指标理论上应逐位相同，但压缩 / 序列化顺序可能带来 1e-16 级别的噪声，
 * 所以给绝对 1e-9 + 相对 1e-6 的宽容。**不放宽到能吃掉真实漂移**：
 * 一个实验判错 = 准确率动 0.0083，比容差大 4 个数量级。
 */
const sameNumber = (a: number, b: number) => Math.abs(a - b) <= 1e-9 + 1e-6 * Math.abs(b);

export function diffBaseline(
  current: Record<string, number>,
  base: Record<string, number>,
  currentStrings: Record<string, string> = {},
  baseStrings: Record<string, string> = {},
): BaselineDiff {
  const drift: BaselineDiff['drift'] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [k, v] of Object.entries(current)) {
    if (!(k in base)) {
      added.push(k);
      continue;
    }
    if (!sameNumber(v, base[k])) drift.push({ key: k, from: base[k], to: v });
  }
  for (const k of Object.keys(base)) if (!(k in current)) removed.push(k);

  const stringDrift: BaselineDiff['stringDrift'] = [];
  for (const [k, v] of Object.entries(currentStrings)) {
    if (k in baseStrings && baseStrings[k] !== v) stringDrift.push({ key: k, from: baseStrings[k], to: v });
  }

  return {
    drift,
    added,
    removed,
    stringDrift,
    clean: drift.length === 0 && added.length === 0 && removed.length === 0 && stringDrift.length === 0,
  };
}

/** 人话描述一个指标的变化：比例类显示成百分比，计数类显示成整数 */
export function describeChange(from: number, to: number): string {
  const isRate = Math.abs(from) <= 1 && Math.abs(to) <= 1 && !Number.isInteger(from);
  if (isRate) return `${(from * 100).toFixed(2)}% → ${(to * 100).toFixed(2)}%（${to - from >= 0 ? '+' : ''}${((to - from) * 100).toFixed(2)}pp）`;
  const d = to - from;
  return `${from} → ${to}（${d >= 0 ? '+' : ''}${d}）`;
}
