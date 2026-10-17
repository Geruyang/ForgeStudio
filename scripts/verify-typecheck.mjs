/**
 * 全工作区类型检查（forgedesk-self profile 的 typecheck 验收器）。
 * 输出 TYPECHECK_OK 表示成功。
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkgs = [
  'packages/contracts',
  'packages/engine-adapter',
  'packages/engineering-runner',
  'packages/engineering-mcp',
  'apps/desktop',
];
for (const p of pkgs) {
  execSync('npx tsc --noEmit -p tsconfig.json', { cwd: path.join(repoRoot, p), stdio: 'inherit' });
}
console.log('TYPECHECK_OK');
