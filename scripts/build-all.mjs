/**
 * ForgeDesk 自身完整构建（forgedesk-self profile 的 build/verifier 命令）。
 * 输出 BUILD_OK 表示成功；非 0 退出即构建失败。
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const desktop = path.join(repoRoot, 'apps', 'desktop');

execSync('npm run build', { cwd: desktop, stdio: 'inherit' });
console.log('BUILD_OK');
