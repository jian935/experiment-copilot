/**
 * 维度切片：把「按设备/新老切」推广成「按任何一列切」。
 *
 * ## 为什么这件事不是「多写几个 if」
 *
 * 固定两维（device × tenure）时，分析口径是**写死**在代码里的：`segments.tenure`、`segments.device`
 * 各扫一遍、各自 BH 校正。一旦维度来自用户的表（渠道 × 城市 × App 版本 × 会员等级），
 * 就有三个新问题必须一次性答清：
 *
 *   1. **维度从哪来**：不能要求用户改列名。所以「发现维度」是数据驱动的——
 *      行上有哪些字符串字段、哪些 `dims.*` 键，就自动成为可切维度。
 *   2. **多少算太多**：`订单号` 这种每行一个值的列如果被当成维度，切片扫描会跑出几百个
 *      只有一两个格子的组，p 值全是噪声，而且看起来「很详细」。所以设上限（见 `MAX_DIM_VALUES`），
 *      超了就**明说跳过**，不做「看起来跑了其实全是垃圾」的扫描。
 *   3. **k 个取值怎么判「效应随维度变化」**：新老用户只有两组，diff-in-diff 就够；
 *      渠道有 5 个取值时，两两比会产生 10 次比较。所以用 **Cochran's Q**：
 *      `Q = Σ wᵢ(dᵢ − d̄)²`，`wᵢ = 1/seᵢ²`，零假设下 ~ χ²_{k−1}。
 *      k=2 时它严格等于 `(d₂−d₁)²/(se₁²+se₂²)`，也就是原来那个 diff-in-diff 的 z²——
 *      所以这不是「又一套口径」，而是同一套在多组上的推广（有单测钉住 k=2 的等价性）。
 *
 * ## 为什么「周内/周末」也算内置维度
 *
 * 它不需要数据里多一列（从日期就能推），而「周末效应」是 PM 真会问的切片。
 * 更要紧的是它给了一个**不导入数据也能看到多维度**的例子——否则这个能力在内置数据上
 * 只能看到设备与新老两维，和改造前一模一样，等于白做。
 *
 * ## 不做的事
 *
 * 不做「自动挑最显著的切片来讲故事」（那是 p-hacking 的工业化）。
 * 扫描结果一律带 BH 校正后的 q，并显式给出「这次扫了几个维度、几组」——
 * 让「我切了 12 次才找到这个显著」这件事没法藏起来。
 */

import type { DailyRow } from './types.ts';
import { chi2Sf } from './stats.ts';

/** 一个维度的取值上限。超过就不做切片扫描，但会在 `skipped` 里说明原因 */
export const MAX_DIM_VALUES = 12;

export interface DimensionValue {
  key: string;
  label: string;
}

export interface DimensionSpec {
  /** 稳定标识：`device` / `tenure` / `weekend` / `dims.<列名>` */
  key: string;
  label: string;
  values: DimensionValue[];
  source: 'builtin' | 'data';
}

export interface SkippedDimension {
  key: string;
  label: string;
  distinct: number;
  reason: string;
}

export interface DimensionDiscovery {
  dims: DimensionSpec[];
  skipped: SkippedDimension[];
  /** 这一份数据一共有多少行 —— UI 用来解释「为什么某个维度被跳过了」 */
  rows: number;
}

const TENURE_LABEL: Record<string, string> = { new: '新用户', old: '老用户' };
const WEEKEND_LABEL: Record<string, string> = { weekday: '周内', weekend: '周末' };

/** 日期是不是周末（UTC，和生成数据用的时区一致） */
export function isWeekend(date: string): boolean {
  const t = Date.parse(`${String(date).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  const d = new Date(t).getUTCDay();
  return d === 0 || d === 6;
}

/**
 * 读一行的某个维度值。
 *
 * 集中在这里而不是每个调用点各写一遍：`dimensions` 的 key 是字符串，
 * 读法一旦分散，「星期维度按 UTC 还是本地时区」这种差异就会在三个地方各错一次。
 */
export function readDim(row: DailyRow, key: string): string | undefined {
  if (key === 'device') return row.device;
  if (key === 'tenure') return row.tenure;
  if (key === 'weekend') return isWeekend(row.date) ? 'weekend' : 'weekday';
  if (key.startsWith('dims.')) {
    const k = key.slice('dims.'.length);
    const v = row.dims?.[k];
    return v == null || String(v).trim() === '' ? undefined : String(v).trim();
  }
  return undefined;
}

function labelOf(key: string, raw: string): string {
  if (key === 'tenure') return TENURE_LABEL[raw] ?? raw;
  if (key === 'weekend') return WEEKEND_LABEL[raw] ?? raw;
  return raw;
}

/**
 * 发现可用维度。
 *
 * 顺序即优先级（UI 默认选第一个）：设备 → 新老用户 → 周内周末 → 数据里的 dims（按首次出现顺序）。
 * 为什么内置维度排前面：它们的语义已知、取值固定，扫出来的结论最容易解释；
 * 用户自己的维度（如「渠道」）放后面，需要人主动选。
 */
export function discoverDimensions(rows: DailyRow[]): DimensionDiscovery {
  const dims: DimensionSpec[] = [];
  const skipped: SkippedDimension[] = [];
  if (!rows.length) return { dims, skipped, rows: 0 };

  const collect = (key: string, fn: (r: DailyRow) => string | undefined): string[] => {
    const seen = new Set<string>();
    for (const r of rows) {
      const v = fn(r);
      if (v != null && v !== '') seen.add(v);
    }
    return [...seen];
  };

  // ---- 设备 / 新老：内置，取值固定，只要出现两种就算 ----
  for (const [key, label] of [['device', '设备'], ['tenure', '新老用户']] as const) {
    const vals = collect(key, (r) => readDim(r, key));
    if (vals.length >= 2 && vals.length <= MAX_DIM_VALUES) {
      dims.push({
        key,
        label,
        source: 'builtin',
        values: vals.map((v) => ({ key: v, label: labelOf(key, v) })),
      });
    }
  }

  // ---- 周内 / 周末：从日期推，要求足够多天且两种都出现 ----
  const dates = new Set(rows.map((r) => r.date));
  if (dates.size >= 5) {
    const vals = collect('weekend', (r) => readDim(r, 'weekend'));
    if (vals.length === 2) {
      dims.push({
        key: 'weekend',
        label: '周内/周末',
        source: 'builtin',
        values: ['weekday', 'weekend']
          .filter((v) => vals.includes(v))
          .map((v) => ({ key: v, label: labelOf('weekend', v) })),
      });
    }
  }

  // ---- 数据自带的维度（dims.*）----
  const dimKeys: string[] = [];
  for (const r of rows) {
    if (!r.dims) continue;
    for (const k of Object.keys(r.dims)) {
      if (!dimKeys.includes(k)) dimKeys.push(k);
    }
  }
  for (const k of dimKeys) {
    const vals = collect(`dims.${k}`, (r) => readDim(r, `dims.${k}`));
    if (vals.length < 2) {
      // 只有一种取值 = 没有可切的分组，静默跳过（它不是「有问题」，只是没信息）
      continue;
    }
    if (vals.length > MAX_DIM_VALUES) {
      skipped.push({
        key: `dims.${k}`,
        label: k,
        distinct: vals.length,
        reason: `有 ${vals.length} 个取值，超过上限 ${MAX_DIM_VALUES}——按它切片会切出一堆只有几个格子的组，p 值全是噪声。建议先在 SQL 里把长尾取值归并成「其他」`,
      });
      continue;
    }
    dims.push({
      key: `dims.${k}`,
      label: k,
      source: 'data',
      values: vals.map((v) => ({ key: v, label: labelOf(`dims.${k}`, v) })),
    });
  }

  return { dims, skipped, rows: rows.length };
}

export interface HeterogeneityQ {
  q: number;
  df: number;
  p: number;
}

/**
 * 效应是否随维度变化：Cochran's Q。
 *
 * 为什么不用「两两比较 + Holm」：k 个取值两两比会产生 k(k−1)/2 次比较，
 * 5 个取值就是 10 次，最后你总能找到一对「显著不同」——而那只是在描述噪声的形状。
 * Q 是一个**单个**统计量，零假设是「所有取值的真实效应相同」，不随 k 增长而膨胀。
 *
 * k=2 时 Q 严格等于 diff-in-diff 的 z²（有单测钉住），所以它和原有的新老交互不是两套口径。
 */
export function cochranQ(items: Array<{ diff: number; se: number }>): HeterogeneityQ | null {
  const use = items.filter((x) => Number.isFinite(x.diff) && Number.isFinite(x.se) && x.se > 0);
  if (use.length < 2) return null;
  const w = use.map((x) => 1 / (x.se * x.se));
  const sw = w.reduce((a, b) => a + b, 0);
  if (!(sw > 0)) return null;
  const dbar = use.reduce((a, x, i) => a + w[i] * x.diff, 0) / sw;
  const q = use.reduce((a, x, i) => a + w[i] * (x.diff - dbar) ** 2, 0);
  const df = use.length - 1;
  return { q, df, p: chi2Sf(q, df) };
}
