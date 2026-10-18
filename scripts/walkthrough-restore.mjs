/**
 * 走查配置恢复助手（由 gui-walkthrough.mjs 在 Browser.close 前 detached 派生）。
 *
 * 为什么独立进程：Browser.close 的 CDP 响应永远不会回来（浏览器关闭即断连），
 * 父进程在该 await 上挂起、事件循环随之排空并以 0 退出——第 10 步之后的任何
 * 代码（含恢复逻辑）都可能不执行（实测教训，2026-10-19）。恢复动作由本进程兜底：
 * 睡眠等应用退出 → 按快照回填 provider.env / settings.json → 删除快照文件。
 *
 * 用法：node scripts/walkthrough-restore.mjs <snapshot.json>
 * 幂等：key 已在/快照缺失时不做任何事。
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(6000); // 等走查父进程退出与应用落盘完成

const snapPath = process.argv[2];
if (!snapPath || !existsSync(snapPath)) process.exit(0);
let snap;
try {
  snap = JSON.parse(readFileSync(snapPath, 'utf8'));
} catch {
  process.exit(0);
}

const appData = process.env.APPDATA ?? '';
const providerEnvPath = path.join(appData, 'ForgeStudio', 'engine', 'provider.env');
if (snap.deepseekKeyLine && snap.deepseekKeyLine !== 'DEEPSEEK_API_KEY=sk-walkthrough-probe-key-123456') {
  let text = existsSync(providerEnvPath) ? readFileSync(providerEnvPath, 'utf8') : '';
  if (!text.includes('DEEPSEEK_API_KEY=')) {
    if (text.length > 0 && !text.endsWith('\n')) text += '\n';
    writeFileSync(providerEnvPath, text + snap.deepseekKeyLine + '\n', 'utf8');
    console.log('[walkthrough-restore] 已恢复走查前的 DEEPSEEK_API_KEY');
  }
}
if (snap.modelProvider && snap.modelProvider !== 'deepseek') {
  const settingsPath = path.join(appData, 'ForgeStudio', 'settings.json');
  if (existsSync(settingsPath)) {
    try {
      const cur = JSON.parse(readFileSync(settingsPath, 'utf8'));
      if (cur.modelProvider !== snap.modelProvider) {
        cur.modelProvider = snap.modelProvider;
        writeFileSync(settingsPath, JSON.stringify(cur, null, 2), 'utf8');
        console.log(`[walkthrough-restore] 已恢复 settings.modelProvider=${snap.modelProvider}`);
      }
    } catch {}
  }
}
try {
  rmSync(snapPath, { force: true });
} catch {}
