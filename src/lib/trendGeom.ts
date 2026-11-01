import { niceStep } from './forestScale.ts';

/**
 * 分日趋势图的几何（F9 去 Recharts 时抽出来的纯函数）。
 *
 * 之所以要单独抽一层：**坐标换算是最容易写错又最难肉眼发现的东西**——
 * 纵轴上下颠倒、点落在画布外、悬停取到隔壁那天的点，图上都能"看起来正常"。
 * 这里把三件事做成可测的：值域、映射到画布、按像素找最近的那一天。
 */

export interface TrendDatum {
  date: string;
  control: number | null;
  treatment: number | null;
  /** 当日两臂样本量：悬停提示里要给，否则「这天为什么抖」没法判断 */
  nc: number;
  nt: number;
}

/**
 * 纵轴值域。
 * 连续口径（ARPU）下界取 0（金额不能是负的，画成负的是假信息）；
 * 率口径下界取 1？不 —— 取 min(观测值, 0)，因为转化率可能为 0，
 * 但刻意不把下界钉死在 0：0.4% 与 0.5% 的差别钉到 0 就看不见了。
 */
export function yDomain(vals: number[], continuous: boolean): [number, number] {
  const finite = vals.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return [0, 1];
  const lo = Math.min(...finite, continuous ? 0 : Infinity);
  const hi = Math.max(...finite);
  const pad = Math.max((hi - lo) * 0.25, continuous ? 0.02 : 0.002);
  return [continuous ? 0 : lo - pad, hi + pad];
}

/** 值 → 画布 y（上小下大，注意方向：SVG 的 y 向下增长） */
export function scaleY(v: number, lo: number, hi: number, top: number, bottom: number): number {
  if (!(hi > lo)) return bottom;
  const t = (v - lo) / (hi - lo);
  return bottom - t * (bottom - top);
}

/** 纵轴刻度：复用森林图那套 niceStep，两处刻度步长口径一致 */
export function yTicks(lo: number, hi: number, continuous: boolean, count = 4): number[] {
  const dec = continuous ? 1 : 100;
  const d0 = lo * dec;
  const d1 = hi * dec;
  const step = niceStep((d1 - d0) / count);
  const out: number[] = [];
  for (let t = Math.ceil(d0 / step) * step; t <= d1 + 1e-9; t += step) out.push(t / dec);
  return out;
}

/**
 * 按鼠标像素找最近的那一天。
 * 边界：比第一个点还靠左 → 0，比最后一个还靠右 → n−1（不能返回 -1，那会取到 undefined）。
 */
export function nearestIndex(count: number, plotW: number, px: number): number {
  if (count <= 0) return -1;
  if (count === 1 || !(plotW > 0)) return 0;
  const gap = plotW / (count - 1);
  return Math.min(count - 1, Math.max(0, Math.round(px / gap)));
}

/** 第 i 天的 x（index → 像素） */
export function xAt(i: number, count: number, plotW: number): number {
  if (count <= 1) return plotW / 2;
  return (i / (count - 1)) * plotW;
}
