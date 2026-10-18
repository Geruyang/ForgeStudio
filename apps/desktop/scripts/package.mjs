/**
 * 打包：完整构建 → runner 依赖闭包 → electron-builder NSIS per-user 安装包。
 * 用法：npm run package（产物 apps/desktop/release/）
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // apps/desktop

console.log('[package] 1/4 完整构建（renderer + main/preload/bridge/runner）');
execSync('npm run build', { cwd: root, stdio: 'inherit' });

console.log('[package] 2/4 runner 运行时依赖闭包（自包含 node_modules）');
// 教训（A-10 首次安装冒烟）：extraResources 只拷 workspace 提升目录（serialport/@serialport）
// 会漏掉 debug/ms 等传递依赖，安装态 runner 启动即崩。改为在 dist/runner 内
// 独立安装完整闭包，随 dist/runner 整目录打包。
// --ignore-scripts：bindings-cpp 的预编译二进制内嵌于 npm 包（prebuilds/win32-x64），
// 运行时由 node-gyp-build 直接加载，无需 install 脚本。
const runnerDir = path.join(root, 'dist', 'runner');
fs.writeFileSync(
  path.join(runnerDir, 'package.json'),
  JSON.stringify(
    { name: 'fd-runner-runtime', private: true, version: '0.0.0', dependencies: { serialport: '13.0.0' } },
    null,
    2,
  ),
);
execSync('npm install --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock', {
  cwd: runnerDir,
  stdio: 'inherit',
});
const requiredModules = [
  'serialport',
  '@serialport/bindings-cpp',
  '@serialport/stream',
  'debug',
  'ms',
  'node-gyp-build',
];
for (const m of requiredModules) {
  const p = path.join(runnerDir, 'node_modules', ...m.split('/'));
  if (!fs.existsSync(p)) {
    throw new Error(`[package] runner 依赖闭包校验失败：缺少 ${m}（${p}）`);
  }
}
const prebuild = path.join(runnerDir, 'node_modules', '@serialport', 'bindings-cpp', 'prebuilds', 'win32-x64');
if (!fs.existsSync(prebuild)) {
  throw new Error(`[package] bindings-cpp 缺少 win32-x64 预编译（${prebuild}）`);
}
console.log('[package] runner 依赖闭包校验通过');

console.log('[package] 3/4 electron-builder（NSIS per-user）');
// FD_EB_OUTPUT：输出目录覆盖（默认 release；旧 win-unpacked 被系统句柄锁定时用新目录避开）
const ebOutput = process.env.FD_EB_OUTPUT ?? 'release';
execSync(`npx electron-builder --win nsis --x64 --publish never --config.directories.output=${ebOutput}`, {
  cwd: root,
  stdio: 'inherit',
});

console.log('[package] 4/4 计算安装包 SHA-256');
execSync(
  `Get-ChildItem ${ebOutput}/*.exe | ForEach-Object { "{0}  {1}" -f (Get-FileHash $_ -Algorithm SHA256).Hash, $_.Name } | Tee-Object ${ebOutput}/SHA256SUMS.txt`,
  { cwd: root, stdio: 'inherit', shell: 'powershell.exe' },
);
console.log('[package] 完成');

// [package] 5/5 生成 latest.yml（electron-updater generic 源；含 SHA-512 与 blockmap 引用由 electron-builder 产物推导）
// 说明：electron-builder --publish never 不产 latest.yml；此处从安装包与 blockmap 现算（与发布物规范一致）
import { createHash } from 'node:crypto';
const exeFile = fs.readdirSync(path.join(root, ebOutput)).find((f) => /^ForgeStudio Setup .*\.exe$/.test(f));
if (exeFile) {
  const exePath = path.join(root, ebOutput, exeFile);
  const exeBuf = fs.readFileSync(exePath);
  const sha512 = createHash('sha512').update(exeBuf).digest('base64');
  const size = exeBuf.length;
  const blockmapFile = exeFile + '.blockmap';
  const blockmapPath = path.join(root, ebOutput, blockmapFile);
  const blockmapExists = fs.existsSync(blockmapPath);
  const blockmapSha512 = blockmapExists
    ? createHash('sha512').update(fs.readFileSync(blockmapPath)).digest('base64')
    : '';
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const releaseDate = new Date().toISOString();
  const yml = [
    `version: ${pkg.version}`,
    `files:`,
    `  - url: ${exeFile}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    ...(blockmapExists ? [`  - url: ${blockmapFile}`, `    sha512: ${blockmapSha512}`, `    size: ${fs.statSync(blockmapPath).size}`] : []),
    `path: ${exeFile}`,
    `sha512: ${sha512}`,
    `releaseDate: ${releaseDate}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, ebOutput, 'latest.yml'), yml, 'utf8');
  console.log(`[package] latest.yml 已生成（${pkg.version}，${exeFile}）`);
} else {
  console.warn('[package] 未找到安装包，跳过 latest.yml');
}
