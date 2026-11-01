/**
 * 唯一色板：SVG / canvas / 内联样式用的十六进制值都在这里。
 *
 * ⚠️ 与 tailwind.config.js 里的 colors 必须一致（有单测 `tests/theme.test.ts` 对账）。
 * 改配色时两处一起改，否则页面会出现「Tailwind 一套、SVG 另一套」的割裂。
 *
 * 主题：纯白 + 橙的暖色清透风
 *   - 底与卡片都是白，靠 1px 暖灰描边和极浅阴影分层，不用深色块
 *   - 橙只做点缀（主按钮 / 选中态 / 关键强调），大面积仍是白
 *   - 语义色（上线/拦截/定向/存疑）降饱和，避免在浅底上刺眼
 */
export const C = {
  page: '#fffdf9',
  card: '#ffffff',
  soft: '#fff7ed',
  line: '#f2e9df',
  line2: '#e7d8c9',
  ink: '#241a12',
  muted: '#6f5f50',
  dim: '#9d8b7a',

  brand: '#f97316',
  brand2: '#c2410c',

  ship: '#15803d',
  noship: '#be123c',
  iterate: '#b45309',
  incon: '#78716c',

  // 图表专用
  grid: '#f4ede5',
  zero: '#cbb8a4',
  neutral: '#a8a29e',
} as const;

export type Tone = 'ship' | 'noship' | 'iterate' | 'incon';
export type Hex = string;
