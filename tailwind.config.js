/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // ⚠️ 与 src/app/lib/palette.ts 一一对应（tests/theme.test.ts 会对账）
      colors: {
        base: '#fffdf9',
        panel: '#ffffff',
        panel2: '#fff7ed',
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
        card: '0 1px 2px rgba(120, 80, 40, 0.05), 0 12px 28px -22px rgba(120, 80, 40, 0.35)',
        lift: '0 2px 6px rgba(120, 80, 40, 0.07), 0 18px 36px -24px rgba(120, 80, 40, 0.4)',
      },
    },
  },
  plugins: [],
};
