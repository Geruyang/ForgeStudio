import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

// renderer 构建输出到 dist/renderer，由 Electron main 以 file:// 加载
export default defineConfig({
  root: path.join(root, 'src/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: path.join(root, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: false,
  },
  resolve: {
    // 契约包直接以 TS 源消费（主进程与 renderer 共用同一份冻结契约）
    alias: {
      '@forgedesk/contracts': path.join(root, '../../packages/contracts/src/index.ts'),
    },
  },
});
