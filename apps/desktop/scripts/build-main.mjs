/**
 * 主进程/预加载/MCP桥/Runner服务 的 esbuild 打包。
 * 产物：
 *   dist/main/index.js       ESM（Electron 主进程）
 *   dist/preload/index.js    CJS（sandbox 兼容）
 *   dist/bridge/mcp-bridge.cjs CJS（ELECTRON_RUN_AS_NODE 加载，MCP stdio）
 *   dist/runner/service.cjs  CJS（utilityProcess 加载；serialport 外置）
 */
import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // apps/desktop
const NODE_EXTERNAL = [
  'electron',
  'node:fs', 'node:path', 'node:url', 'node:crypto', 'node:util', 'node:events',
  'node:child_process', 'node:os', 'node:http', 'node:net', 'node:stream',
  'node:sqlite', 'node:module', 'node:process', 'node:buffer', 'node:timers',
  'node:async_hooks', 'node:worker_threads', 'node:perf_hooks', 'node:string_decoder',
];

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  // sourcemap 外置（产物内联 sourceMap 会使体积翻倍；外置仍可调试，不随包分发）
  sourcemap: process.env.FD_SOURCEMAP === 'inline' ? 'inline' : true,
  logLevel: 'info',
  external: NODE_EXTERNAL,
};

async function buildAll() {
  await esbuild.build({
    ...common,
    format: 'esm',
    entryPoints: [path.join(root, 'src/main/index.ts')],
    outfile: path.join(root, 'dist/main/index.js'),
    // electron-updater 走 require 动态加载（main bundle -2.3MB：updater 含 js-yaml/semver/
    // builder-util 全家桶，且仅设置页更新检查用到——冷启动不再解析）
    external: [...NODE_EXTERNAL, 'fsevents', 'electron-updater'],
    banner: { js: "import { createRequire } from 'node:module';const require = createRequire(import.meta.url);" },
  });
  await esbuild.build({
    ...common,
    entryPoints: [path.join(root, 'src/preload/index.ts')],
    outfile: path.join(root, 'dist/preload/index.js'),
  });
  await esbuild.build({
    ...common,
    entryPoints: [path.join(root, 'src/bridge/entry.ts')],
    outfile: path.join(root, 'dist/bridge/mcp-bridge.cjs'),
  });
  await esbuild.build({
    ...common,
    entryPoints: [path.join(root, 'src/runner/entry.ts')],
    outfile: path.join(root, 'dist/runner/service.cjs'),
    external: [...NODE_EXTERNAL, 'serialport', '@serialport/bindings-cpp'],
  });
  console.log('MAIN_BUNDLE_OK');
}

// --watch 模式（dev.mjs 使用）
if (process.argv.includes('--watch')) {
  const ctx = await esbuild.context({
    ...common,
    format: 'esm',
    entryPoints: [path.join(root, 'src/main/index.ts')],
    outfile: path.join(root, 'dist/main/index.js'),
    external: [...NODE_EXTERNAL, 'fsevents'],
    banner: { js: "import { createRequire } from 'node:module';const require = createRequire(import.meta.url);" },
  });
  await ctx.watch();
  console.log('MAIN_WATCH_READY');
} else {
  await buildAll();
}
