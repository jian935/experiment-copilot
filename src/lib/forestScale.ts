/**
 * 森林图横轴的定标与刻度（纯函数，供 Forest 使用，单测直接算数）。
 *
 * 这里有个真实踩过的坑：**步长与取值必须同量纲**。
 * pp 的显示值是 `v×100`（0.02 显示成 +2），所以「每 5 格一个刻度」算出来的
 * 步长也必须是**显示单位**的步长。曾经用 pp 单位算步长、用百分数取起点，
 * 两者差 100 倍，于是一条横轴画出了 341 条网格线——肉眼看到的是一片浅色条纹底，
 * 而刻度文字全被挤出画布；单看一张图很像「淡淡的网格背景」，很容易当成设计。
 *
 * 所以：先统一换算到显示单位，再算步长、取起点、生成刻度，最后换回原单位画图。
 */
export type ForestUnit = 'pp' | '元';

export interface ForestScale {
  /** 绘图区左右边界（原单位） */
  x0: number;
  x1: number;
  /** 刻度值（原单位），单调递增，全部落在 [x0, x1] 内 */
  ticks: number[];
  /** 刻度文字的小数位（在显示单位下） */
  decimals: number;
  /** 显示单位下的步长（测试用） */
  step: number;
}

/** 取「好看」的刻度步长：1 / 2 / 5 × 10^k */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/** 目标刻度条数：太少看不出分辨率，太多糊成底纹 */
export const TARGET_TICKS = 7;
/** 一个区间最多画几条刻度：超过就说明步长选错了，而不是「多画几条更细」 */
export const MAX_TICKS = 12;

export function forestScale(cis: [number, number][], unit: ForestUnit): ForestScale {
  const dec = unit === 'pp' ? 100 : 1;
  // 边界必须含 0：零点参考线是这张图的锚，没有它看不出「跨 0 = 不显著」
  const lo = Math.min(0, ...cis.map((c) => c[0]));
  const hi = Math.max(0, ...cis.map((c) => c[1]));
  const span = Math.max(hi - lo, unit === '元' ? 0.02 : 0.004);
  const pad = span * 0.14;
  const x0 = lo - pad;
  const x1 = hi + pad;

  // 全部换算到显示单位再算，避免 100 倍错配
  const d0 = x0 * dec;
  const d1 = x1 * dec;
  // 目标是 7 条左右：除以 5 常常只落 3 条，负半轴一个刻度都没有，读者看不出轴从哪里起
  let step = niceStep((d1 - d0) / TARGET_TICKS);
  // 兜底：极端窄区间可能算出过密的步长，放大到条数可控为止
  let guard = 0;
  while ((d1 - d0) / step > MAX_TICKS && guard++ < 20) step *= 2;

  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  const ticks: number[] = [];
  const start = Math.ceil(d0 / step) * step;
  // 1e-9 的容差：浮点累加会让最后一个刻度差一点点落在边界外
  for (let t = start; t <= d1 + 1e-9; t += step) ticks.push(round(t / dec, 10));

  return { x0, x1, ticks, decimals, step };
}

/** 去掉浮点尾灰（`0.30000000000000004`）与负零（`-0` 会印成「-0」），只保留到 1e-10 */
function round(v: number, digits: number): number {
  const f = 10 ** digits;
  const r = Math.round(v * f) / f;
  return r === 0 ? 0 : r;
}

/** 刻度文字：显示单位 + 正号（「+1」与「-1」要一眼分得出方向） */
export function tickLabel(v: number, unit: ForestUnit, decimals: number): string {
  const s = unit === 'pp' ? v * 100 : v;
  return `${s > 0 ? '+' : ''}${s.toFixed(decimals)}`;
}
