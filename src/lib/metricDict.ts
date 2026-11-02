/**
 * 指标字典：可编辑 + 带版本历史。
 *
 * ## 为什么「能改」这件事必须带版本
 *
 * 口径字典一旦可编辑，它就变成了**会影响结论的东西**：把 ARPU 的方向从「越大越好」改成
 * 「越小越好」，同一个实验的决策会反过来。如果只允许改、不允许留痕，三个月后没人能解释
 * 「当时为什么判了不上线」。所以这里的模型是「**快照 + 不可变版本链**」：
 *
 *   - 每个版本存一份**完整快照**（对内置指标的覆盖 + 自定义指标列表），不是存 diff。
 *     diff 更省空间，但回滚时要重放整条链，任何一次重放错误都会静默改掉历史口径；
 *   - 每次保存自动生成**人话摘要**（改了谁的哪个字段、从什么改成什么、增删了哪个指标），
 *     不是让用户自己写提交信息——那样十次有九次是空的；
 *   - 回滚本身也是**新增一个版本**（带 `restoredFrom`），历史永不被改写。
 *
 * ## 两个刻意的边界
 *
 * 1. **内置指标的 label 不可改**。实验的 `primaryMetric` 存的是中文名，Agent 的口径匹配也按
 *    label 走；改 label 等于让历史数据里的指标名对不上号。方向/单位/计算式/说明可改。
 * 2. **自定义指标只支持「比值」形态**（`Σ分子 / Σ分母`）。这不是偷懒：率与 ARPU 都是这个形态，
 *    而「先按行算再取平均」这种形态会引入「谁有权重」的问题（一行代表 100 人还是 1 个人），
 *    引擎里没有对应的方差模型——硬做出来会得到一个看着像结论、其实没有方差依据的数字。
 */

import { METRIC_DEFS, type MetricDef, type MetricDirection } from './metrics.ts';
import type { DailyRow } from './types.ts';
import { ratioTest } from './stats.ts';
import { compileMetricExpr, type ExprRow } from './metricExpr.ts';

/** 内置指标可改的字段（label 不在其中，见文件头） */
export interface MetricPatch {
  direction?: MetricDirection;
  unit?: string;
  formula?: string;
  note?: string;
}

export interface CustomMetric {
  key: string;
  label: string;
  /** 分子表达式（在 DailyRow 上求值） */
  numerator: string;
  /** 分母表达式，通常是 exposures */
  denominator: string;
  unit: string;
  direction: MetricDirection;
  formula: string;
  note: string;
}

export interface MetricSnapshot {
  /** 内置指标 key → 覆盖 */
  patches: Record<string, MetricPatch>;
  custom: CustomMetric[];
}

export interface MetricVersion {
  version: number;
  changedAt: string;
  /** 谁改的。纯前端阶段是「本机」；接上后端后是登录用户名 */
  author: string;
  /** 自动生成的变更摘要（人话，逐条） */
  summary: string[];
  /** 由回滚产生时：回到哪一版 */
  restoredFrom?: number;
  snapshot: MetricSnapshot;
}

export interface MetricDoc {
  /** 版本 1..n；最后一个是当前生效版本 */
  versions: MetricVersion[];
}

export const CUSTOM_PREFIX = 'custom_';

export function emptySnapshot(): MetricSnapshot {
  return { patches: {}, custom: [] };
}

export function baseDoc(author = '本机', at = new Date().toISOString()): MetricDoc {
  return {
    versions: [
      {
        version: 1,
        changedAt: at,
        author,
        summary: [`初始版本：内置 ${METRIC_DEFS.length} 个指标，无自定义指标`],
        snapshot: emptySnapshot(),
      },
    ],
  };
}

export function currentVersion(doc: MetricDoc): number {
  return doc.versions[doc.versions.length - 1]?.version ?? 0;
}

export function currentSnapshot(doc: MetricDoc): MetricSnapshot {
  return doc.versions[doc.versions.length - 1]?.snapshot ?? emptySnapshot();
}

/** 把「当前快照」解析成完整的指标定义表（内置覆盖 + 自定义） */
export function resolveDefs(snapshot: MetricSnapshot): MetricDef[] {
  const builtins = METRIC_DEFS.map((m) => {
    const p = snapshot.patches[m.key];
    if (!p) return m;
    return {
      ...m,
      ...(p.direction ? { direction: p.direction } : {}),
      ...(p.unit !== undefined ? { unit: p.unit } : {}),
      ...(p.formula !== undefined ? { formula: p.formula } : {}),
      ...(p.note !== undefined ? { note: p.note } : {}),
    };
  });
  const custom: MetricDef[] = snapshot.custom.map((c) => ({
    key: c.key,
    label: c.label,
    kind: 'continuous',
    direction: c.direction,
    unit: c.unit,
    formula: c.formula || `${c.numerator} / (${c.denominator})`,
    source: `自定义：${c.numerator} / ${c.denominator}`,
    guardrailMargin: null,
    method: '比值 delta method（Σ分子 / Σ分母，格子级聚类方差 + t 检验）',
    note: c.note,
  }));
  return [...builtins, ...custom];
}

const FIELD_CN: Record<keyof MetricPatch, string> = {
  direction: '方向',
  unit: '单位',
  formula: '计算式',
  note: '说明',
};

const DIR_CN: Record<string, string> = { higher_better: '越大越好', lower_better: '越小越好' };

/** 两版快照之间的人话差异（保存时自动生成，不让用户手写） */
export function diffSnapshots(a: MetricSnapshot, b: MetricSnapshot): string[] {
  const out: string[] = [];
  const keys = new Set([...Object.keys(a.patches), ...Object.keys(b.patches)]);
  for (const k of keys) {
    const pa = a.patches[k] ?? {};
    const pb = b.patches[k] ?? {};
    const label = METRIC_DEFS.find((m) => m.key === k)?.label ?? k;
    // 没被覆盖时要知道「默认是什么」——写「（默认）」读者看不出发生了什么，
    // 写「越大越好（默认）」才让人明白这一改意味着什么。
    const baseDef = METRIC_DEFS.find((m) => m.key === k);
    const defOf = (f: keyof MetricPatch): string => {
      if (f === 'direction') return DIR_CN[baseDef?.direction ?? 'higher_better'] ?? '';
      if (f === 'unit') return baseDef?.unit ?? '—';
      if (f === 'formula') return baseDef?.formula ?? '—';
      return '（原说明）';
    };
    for (const f of Object.keys(FIELD_CN) as Array<keyof MetricPatch>) {
      const va = pa[f];
      const vb = pb[f];
      if (va === vb) continue;
      const show = (v: string | undefined) =>
        v === undefined ? `${defOf(f)}（默认）` : f === 'direction' ? (DIR_CN[v] ?? v) : v;
      if (f === 'note') {
        out.push(`改了「${label}」的说明`);
      } else {
        out.push(`把「${label}」的${FIELD_CN[f]}从 ${show(va)} 改成 ${show(vb)}`);
      }
    }
  }
  const aKeys = new Set(a.custom.map((c) => c.key));
  const bKeys = new Set(b.custom.map((c) => c.key));
  for (const c of b.custom) {
    if (!aKeys.has(c.key)) {
      out.push(`新增自定义指标「${c.label}」= ${c.numerator} / (${c.denominator})`);
    } else {
      const old = a.custom.find((x) => x.key === c.key)!;
      for (const f of ['label', 'numerator', 'denominator', 'unit', 'direction', 'note'] as const) {
        if (old[f] === c[f]) continue;
        if (f === 'note') out.push(`改了自定义指标「${c.label}」的说明`);
        else if (f === 'direction') out.push(`把「${c.label}」的方向改成 ${DIR_CN[c[f]] ?? c[f]}`);
        else out.push(`把「${c.label}」的${{ label: '名称', numerator: '分子', denominator: '分母', unit: '单位' }[f]}改成 ${c[f]}`);
      }
    }
  }
  for (const c of a.custom) {
    if (!bKeys.has(c.key)) out.push(`删除自定义指标「${c.label}」`);
  }
  return out;
}

/** 校验一份快照能不能存（表达式能不能解析、字段是否可用、key 是否冲突） */
export function validateSnapshot(snapshot: MetricSnapshot): string[] {
  const errs: string[] = [];
  const seen = new Set<string>();
  for (const c of snapshot.custom) {
    if (!c.label.trim()) errs.push('自定义指标缺名称');
    if (seen.has(c.label.trim())) errs.push(`自定义指标「${c.label}」重名`);
    seen.add(c.label.trim());
    if (!/^custom_[a-z0-9]+$/.test(c.key)) errs.push(`自定义指标「${c.label}」的 key 不合法（应为 custom_xxx）`);
    for (const [role, src] of [['分子', c.numerator], ['分母', c.denominator]] as const) {
      try {
        compileMetricExpr(src);
      } catch (e) {
        errs.push(`「${c.label}」的${role}表达式有问题：${(e as Error).message}`);
      }
    }
  }
  for (const k of Object.keys(snapshot.patches)) {
    if (!METRIC_DEFS.some((m) => m.key === k)) errs.push(`覆盖了一个不存在的内置指标：${k}`);
  }
  return errs;
}

/**
 * 保存成新版本。没有实际改动时**不生成新版本**并抛错——
 * 空版本会让历史里出现一串「什么都没改」的记录，那种历史没人会看第二次。
 */
export function saveSnapshot(
  doc: MetricDoc,
  next: MetricSnapshot,
  author = '本机',
  at = new Date().toISOString(),
  restoredFrom?: number,
): { doc: MetricDoc; version: number; summary: string[] } {
  const errs = validateSnapshot(next);
  if (errs.length) throw new Error(errs.join('；'));
  const summary = diffSnapshots(currentSnapshot(doc), next);
  if (!summary.length && restoredFrom === undefined) {
    throw new Error('没有改动，不需要新建版本');
  }
  if (restoredFrom !== undefined) {
    summary.unshift(`回滚到 v${restoredFrom}（历史上新增一版，旧版本不被改写）`);
  }
  const version = currentVersion(doc) + 1;
  const versions = [
    ...doc.versions,
    { version, changedAt: at, author, summary, snapshot: next, ...(restoredFrom ? { restoredFrom } : {}) },
  ];
  return { doc: { versions }, version, summary };
}

/** 回滚：把某一版的快照当作新版本存下去 */
export function rollbackTo(doc: MetricDoc, version: number, author = '本机', at = new Date().toISOString()) {
  const target = doc.versions.find((v) => v.version === version);
  if (!target) throw new Error(`没有第 ${version} 版`);
  return saveSnapshot(doc, target.snapshot, author, at, version);
}

export interface CustomMetricResult {
  key: string;
  label: string;
  unit: string;
  formula: string;
  numerator: string;
  denominator: string;
  controlValue: number;
  treatmentValue: number;
  diff: number;
  ci95: [number, number];
  p: number;
  se: number;
  relativeLift: number;
  n1: number;
  n2: number;
  /** 因为字段缺失或除数为 0 而被跳过的行数 */
  skippedRows: number;
  /** 算不出来时的原因（此时所有数字字段无意义，UI 必须显示原因而不是 0） */
  error?: string;
}

/**
 * 算一个自定义指标：每行取 (分子, 分母) 当格子，再走一遍 ratioTest。
 *
 * 为什么不复用主指标那条路：主指标的检验口径（两比例 z / CUPED）建立在「这个指标是转化率」
 * 或「这个是 ARPU」之上。自定义指标只承诺「Σ分子/Σ分母 这个比值」，所以用比值估计量的
 * delta method —— 与 ARPU 同源，且不需要假设指标的统计结构。代价是区间偏保守，
 * 这一点写在面板上（而不是让人以为它和主指标一样精）。
 */
export function computeCustomMetric(
  rows: DailyRow[],
  control: string,
  treatment: string,
  def: CustomMetric,
): CustomMetricResult {
  const base: CustomMetricResult = {
    key: def.key,
    label: def.label,
    unit: def.unit,
    formula: def.formula || `${def.numerator} / (${def.denominator})`,
    numerator: def.numerator,
    denominator: def.denominator,
    controlValue: 0,
    treatmentValue: 0,
    diff: 0,
    ci95: [0, 0],
    p: 1,
    se: 0,
    relativeLift: 0,
    n1: 0,
    n2: 0,
    skippedRows: 0,
  };
  let num: ReturnType<typeof compileMetricExpr>;
  let den: ReturnType<typeof compileMetricExpr>;
  try {
    num = compileMetricExpr(def.numerator);
    den = compileMetricExpr(def.denominator);
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }

  const missing = [...num.refs, ...den.refs].filter(
    (f) => !rows.some((r) => typeof (r as unknown as Record<string, number>)[f] === 'number'),
  );
  if (missing.length) {
    return {
      ...base,
      error: `这份数据里没有 ${[...new Set(missing)].join(' / ')} 列（整列缺失），这个指标算不出来`,
    };
  }

  const cells: Array<{ n: number; sum: number; treatment: boolean }> = [];
  let skipped = 0;
  for (const r of rows) {
    if (r.variant !== control && r.variant !== treatment) continue;
    // DailyRow 里有非数值字段，而表达式只读白名单里的数值字段——这一处转换是有意的窄化
    const row = r as unknown as ExprRow;
    const d = den.eval(row);
    const s = num.eval(row);
    if (d === null || s === null || !(d > 0)) {
      skipped++;
      continue;
    }
    cells.push({ n: d, sum: s, treatment: r.variant === treatment });
  }
  const rt = ratioTest(cells);
  if (!rt) {
    return {
      ...base,
      skippedRows: skipped,
      error: '两臂各自的有效格子都不足 2 个（分母为 0 或缺字段的行被跳过），算不出方差',
    };
  }
  return {
    ...base,
    controlValue: rt.controlValue,
    treatmentValue: rt.treatmentValue,
    diff: rt.diff,
    ci95: rt.ci95,
    p: rt.p,
    se: rt.se,
    relativeLift: rt.relativeLift,
    n1: rt.n1,
    n2: rt.n2,
    skippedRows: skipped,
  };
}

/** 一个新自定义指标的 key（避开已有） */
export function nextCustomKey(snapshot: MetricSnapshot): string {
  let i = snapshot.custom.length + 1;
  const used = new Set(snapshot.custom.map((c) => c.key));
  while (used.has(`${CUSTOM_PREFIX}${i}`)) i++;
  return `${CUSTOM_PREFIX}${i}`;
}
