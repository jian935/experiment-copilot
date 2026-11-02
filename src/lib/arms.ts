/**
 * 臂（arm / variant）的识别与排序。
 *
 * 为什么要单独一层：两臂时代「treatment 就是那个非对照臂」是隐含假设，
 * 到了 A/B/n 就全崩了——`r.variant === 'treatment'` 会把 C 臂的数据直接丢掉，
 * 而且不会报错（数字看着还挺合理）。所以把「谁是对照、一共几臂、按什么顺序」抽成
 * 单一来源，引擎、UI、导入器都从这里取。
 */

import type { DailyRow, Experiment } from './types.ts';
import { parseAllocation } from './multiarm.ts';

/** 对照臂的默认 id。导入器与合成数据都用它，历史数据不需要迁移。 */
export const DEFAULT_CONTROL = 'control';

export function controlArmOf(exp: Experiment): string {
  if (exp.controlArm && exp.controlArm.trim()) return exp.controlArm.trim();
  // 声明了多个臂但没写对照 → 约定第一个是对照（与实验平台的惯例一致）
  if (exp.variants?.length && !exp.variants.includes('control')) return exp.variants[0];
  return DEFAULT_CONTROL;
}

/**
 * 该实验的臂列表：对照在前，其余按声明顺序，最后接上「数据里有、但元信息没声明」的臂。
 *
 * 为什么要把数据里多出来的臂也带上：导入的表里常有元信息没对齐的臂
 * （说明页只写了 A/B，数据里却有三组）。静默丢掉一臂会让结论建立在残缺数据上，
 * 所以宁可显示出来并提示「元信息没声明这一臂」。
 */
export function armsOf(exp: Experiment, rows?: DailyRow[]): string[] {
  const control = controlArmOf(exp);
  const seen = new Set<string>(rows ? rows.map((r) => r.variant) : []);
  const declared = (exp.variants?.length ? exp.variants : [DEFAULT_CONTROL, 'treatment']).slice();
  if (!declared.includes(control)) declared.unshift(control);
  const out: string[] = [control];
  for (const v of declared) if (v !== control && !out.includes(v)) out.push(v);
  for (const v of seen) if (!out.includes(v)) out.push(v);
  // 数据里一条该臂的行都没有的，不算「臂」（否则表里会出现 n=0 的空行）
  if (rows && rows.length) {
    const present = new Set(rows.map((r) => r.variant));
    return out.filter((v) => v === control || present.has(v));
  }
  return out;
}

/**
 * 分流比例（与 arms 同序）。
 *
 * 优先级：显式 `allocation` → 解析 `trafficSplit`（"50/25/25"、"1:1:1"）→ 等分。
 * 解析失败时**不猜**，直接等分，并由调用方在 UI 上标明「按等分检查」——
 * 用错的期望去做 SRM，会把正常实验判成异常，比不检查更糟。
 */
export function allocationOf(exp: Experiment, arms: string[]): { ratios: number[]; source: 'declared' | 'trafficSplit' | 'equal' } {
  if (exp.allocation && exp.allocation.length === arms.length) {
    const sum = exp.allocation.reduce((a, b) => a + b, 0);
    if (sum > 0) return { ratios: exp.allocation.map((v) => v / sum), source: 'declared' };
  }
  const parsed = parseAllocation(exp.trafficSplit);
  if (parsed && parsed.length === arms.length) return { ratios: parsed, source: 'trafficSplit' };
  return { ratios: arms.map(() => 1 / arms.length), source: 'equal' };
}

/** 臂的展示名：内置两臂给人话，variant_x 给「C 组」，其余自定义臂原样显示 */
export function armLabel(id: string): string {
  if (id === 'control') return '对照组';
  if (id === 'treatment') return '实验组';
  const m = /^variant_([a-z])$/.exec(id);
  if (m) return `${m[1].toUpperCase()} 组`;
  return id;
}

/** 臂的短名（图上用，省地方） */
export function armShort(id: string): string {
  if (id === 'control') return 'A';
  if (id === 'treatment') return 'B';
  const m = /^variant_([a-z])$/.exec(id);
  if (m) return m[1].toUpperCase();
  return id.length > 6 ? id.slice(0, 6) : id;
}

export function isMultiArm(exp: Experiment, rows?: DailyRow[]): boolean {
  return armsOf(exp, rows).length > 2;
}
