import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rendererRoot = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(rendererRoot, '../..');

// 组件测试配置：jsdom 环境，契约包以 TS 源消费（与 vite.config.ts 一致）。
// npm run test（vitest run --root .，包根）使用包根 vitest.config.ts；本文件供以 renderer 为根运行时使用。
export default defineConfig({
  root: rendererRoot,
  plugins: [react()],
  resolve: {
    alias: {
      '@forgedesk/contracts': path.join(pkgRoot, '../../packages/contracts/src/index.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
  },
});
