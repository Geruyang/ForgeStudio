import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

// 组件测试配置：jsdom 环境，契约包以 TS 源消费（与 vite.config.ts 一致）
export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    alias: {
      '@forgedesk/contracts': path.join(root, '../../packages/contracts/src/index.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/renderer/test/**/*.test.{ts,tsx}'],
    setupFiles: ['src/renderer/test/setup.ts'],
  },
});
