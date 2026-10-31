/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        base: '#070a11',
        panel: '#0d1320',
        panel2: '#121a2b',
        line: '#1e2a3d',
        line2: '#2a3a52',
        ink: '#e9eef8',
        muted: '#93a3bb',
        dim: '#6b7c96',
        brand: '#6366f1',
        brand2: '#818cf8',
        ship: '#34d399',
        noship: '#fb7185',
        iterate: '#fbbf24',
        incon: '#94a3b8',
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
    },
  },
  plugins: [],
};
