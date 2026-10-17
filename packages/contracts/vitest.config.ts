import { defineConfig } from 'vitest/config';

/**
 * contracts 契约级测试（Agent D 所有）。
 * contracts 的 npm test 脚本为 node --test（.mjs fallback）；.ts 契约测试经本配置用 vitest 运行：
 *   仓库根执行 `npx vitest run --root packages/contracts --reporter=basic`
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
