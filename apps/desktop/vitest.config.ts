import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

// 双测试环境：renderer 组件测试（jsdom）+ main 进程测试（node）；
// 契约包以 TS 源消费（与 vite.config.ts 一致）；/ipc 子路径单独映射
const contractAliases = [
  { find: /^@forgedesk\/contracts\/ipc$/, replacement: path.join(root, '../../packages/contracts/src/ipc.ts') },
  { find: /^@forgedesk\/contracts$/, replacement: path.join(root, '../../packages/contracts/src/index.ts') },
];

export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    alias: contractAliases,
  },
  test: {
    projects: [
      {
        resolve: { alias: contractAliases },
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/test/**/*.test.{ts,tsx}'],
          setupFiles: ['src/renderer/test/setup.ts'],
        },
      },
      {
        resolve: { alias: contractAliases },
        test: {
          name: 'main',
          environment: 'node',
          include: ['src/main/test/**/*.test.ts'],
        },
      },
    ],
  },
});
