/**
 * 开发流程：vite dev server（renderer）+ esbuild watch（main/preload）+ Electron。
 * 用法：npm run dev
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:vite';

const require = createRequire(import.meta.url);
const root = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.dirname(root);
const electronBin = require.resolve('electron/electron.cjs') ? path.join(path.dirname(require.resolve('electron/package.json')), 'dist', 'electron.exe') : 'electron';

// 1) 先完整构建 preload/bridge/runner（watch 只跟主进程；preload 改动少，改动后需重启）
{
  const { execSync } = await import('node:child_process');
  execSync('node scripts/build-main.mjs', { cwd: desktopDir, stdio: 'inherit' });
}

// 2) renderer dev server
const vite = await createServer({
  configFile: path.join(desktopDir, 'vite.config.ts'),
  server: { port: 5173, strictPort: true },
});
await vite.listen(5173);
const devUrl = 'http://localhost:5173';
console.log(`[dev] vite ready: ${devUrl}`);

// 3) esbuild watch 主进程
const watchProc = spawn(process.execPath, ['scripts/build-main.mjs', '--watch'], {
  cwd: desktopDir,
  stdio: 'inherit',
});

// 4) 启动 Electron（重载 renderer 即时生效；主进程改动需重启 dev）
const child = spawn(electronBin, ['.'], {
  cwd: desktopDir,
  stdio: 'inherit',
  env: { ...process.env, FD_DEV_SERVER_URL: devUrl },
});
child.on('exit', (code) => {
  watchProc.kill();
  vite.close();
  process.exit(code ?? 0);
});

const shutdown = () => {
  child.kill();
  watchProc.kill();
  void vite.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
