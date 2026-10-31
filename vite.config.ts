import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' + hash 路由 → 可部署到任意子路径（GitHub Pages /experiment-copilot/ 也能开）
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    // 默认压缩器会把 min-width 改写成 (width>=640px)，老内核（Chrome<104）不认；
    // 显式用 esbuild 压缩，保持传统 min-width 写法。
    cssMinify: 'esbuild',
    target: 'es2019',
  },
  server: { port: 5173, host: '127.0.0.1' },
});
