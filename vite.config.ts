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
  // `npm run dev` + `npm run server` 同时跑时，前端把 /v1 代理到后端。
  // 同源部署（后端直接服务 dist/）时不需要这条，fetch('/v1/...') 本来就同源。
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: { '/v1': { target: 'http://127.0.0.1:8787', changeOrigin: false } },
  },
});
