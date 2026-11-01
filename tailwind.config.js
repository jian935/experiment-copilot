/**
 * ⚠️ 与 src/app/index.css 里的 `--c-*` 变量一一对应（有单测 `tests/theme.test.ts` 对账）。
 *
 * 颜色一律写成 `rgb(var(--c-名字) / <alpha-value>)`：
 * ① 切主题只改变量，不用在组件里写 dark: 变体；
 * ② `<alpha-value>` 让 `bg-brand/10`、`border-noship/30` 这类透明度写法继续可用
 *    ——如果写成 `var(--c-brand)`（不带 alpha 槽），Tailwind 会生成一个
 *    无效的 `rgb(249 115 22 / 0.3)` 之外的东西，透明度语法直接失效。
 */
const c = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        base: c('base'),
        panel: c('panel'),
        panel2: c('panel2'),
        line: c('line'),
        line2: c('line2'),
        ink: c('ink'),
        muted: c('muted'),
        dim: c('dim'),
        brand: c('brand'),
        brand2: c('brand2'),
        ship: c('ship'),
        noship: c('noship'),
        iterate: c('iterate'),
        incon: c('incon'),
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'PingFang SC',
          'Hiragino Sans GB',
          'Microsoft YaHei',
          'sans-serif',
        ],
        mono: ['SFMono-Regular', 'ui-monospace', 'JetBrains Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgb(var(--c-shadow-rgb) / 0.05), 0 12px 28px -22px rgb(var(--c-shadow-rgb) / 0.35)',
        lift: '0 2px 6px rgb(var(--c-shadow-rgb) / 0.07), 0 18px 36px -24px rgb(var(--c-shadow-rgb) / 0.4)',
      },
    },
  },
  plugins: [],
};
