import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// 与 IDEACODE 根项目的 vite 配置保持一致，便于复用依赖
export default defineConfig({
  plugins: [react()],
  // 使用相对路径，让 Extension Host 能正确内联资源到 HTML
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
    // 复用根 node_modules
    preserveSymlinks: false,
  },
  build: {
    outDir: 'webview-dist',
    emptyOutDir: true,
    target: 'es2020',
    rollupOptions: {
      output: {
        // 单一入口，避免多 chunk 之间的相对路径问题（Extension Host 内联 HTML）
        manualChunks: undefined,
        inlineDynamicImports: true,
      },
    },
  },
  server: {
    port: 5179,
  },
});