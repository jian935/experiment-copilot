/**
 * 唯一色板：SVG / canvas / 内联样式用的颜色都在这里，且**与 Tailwind 共用同一批变量**。
 *
 * 为什么改成 `rgb(var(--c-x))`：
 * 以前这里是十六进制字面量（`C.ship = '#15803d'`），类名能切主题、SVG 不能切，
 * 深色模式下一打开就会变成「卡片是黑的、森林图还是浅色那套」的补丁拼盘。
 * SVG 的 fill / stroke 是**表现属性**，按 CSS 值解析，所以 var() 在这里可用
 * —— 换成 var 之后，89 处调用点一行都不用改。
 *
 * ⚠️ 与 tailwind.config.js / src/app/index.css 必须一致（有单测 `tests/theme.test.ts` 对账）。
 *
 * 主题：浅色是「纯白 + 橙的暖色清透风」，深色是暖深色（不是纯黑）。
 */
const v = (name: string) => `rgb(var(--c-${name}))`;

export const C = {
  page: v('base'),
  card: v('panel'),
  soft: v('panel2'),
  line: v('line'),
  line2: v('line2'),
  ink: v('ink'),
  muted: v('muted'),
  dim: v('dim'),

  brand: v('brand'),
  brand2: v('brand2'),

  ship: v('ship'),
  noship: v('noship'),
  iterate: v('iterate'),
  incon: v('incon'),

  // 图表专用
  grid: v('grid'),
  zero: v('zero'),
  neutral: v('neutral'),
} as const;

/** 色板里每个键对应的变量名——主题测试靠它逐一对账 */
export const C_VARS: Record<keyof typeof C, string> = {
  page: 'base',
  card: 'panel',
  soft: 'panel2',
  line: 'line',
  line2: 'line2',
  ink: 'ink',
  muted: 'muted',
  dim: 'dim',
  brand: 'brand',
  brand2: 'brand2',
  ship: 'ship',
  noship: 'noship',
  iterate: 'iterate',
  incon: 'incon',
  grid: 'grid',
  zero: 'zero',
  neutral: 'neutral',
};

/**
 * 把变量解析成**真实颜色**（canvas 用）。
 * canvas 的 fillStyle 不认 var()，所以导出的结论卡只能拿到当前主题下的具体值——
 * 这也意味着「导出成图片」永远是照着当前主题画的（浅色导出适合贴文档）。
 */
export function resolvePalette(el: Element | null = typeof document === 'undefined' ? null : document.documentElement): typeof C {
  const out = { ...C } as Record<string, string>;
  if (!el || typeof getComputedStyle !== 'function') return out as typeof C;
  const cs = getComputedStyle(el);
  for (const [k, name] of Object.entries(C_VARS)) {
    const raw = cs.getPropertyValue(`--c-${name}`).trim();
    if (raw) out[k] = `rgb(${raw})`;
  }
  return out as typeof C;
}

export type Tone = 'ship' | 'noship' | 'iterate' | 'incon';
export type Hex = string;
