#!/usr/bin/env node
// fixture 模拟测试——非实机验收。
// 虚拟烧录工具：模拟 probe-rs/ST-Link 等烧录工具的行为（本机无板卡）。
// 用法：
//   node virtual-flash-tool.mjs --artifact <产物路径> --state <stateDir> [--build-id <id>]
//        [--fail] [--crash] [--hang <ms>] [--hang-with-child <ms>] [--no-build-id] [--verify]
// 行为：
//   默认      读产物计算 sha256 → 写 <state>/device-firmware.json（模拟板内固件状态）→ exit 0
//   --verify  读回校验：对比 <state>/device-firmware.json 与产物 sha256 → VERIFY_OK / exit 1
//   --fail    打印错误 → exit 1（确定性失败，不写状态）
//   --crash   模拟进程崩溃：exit 3221225477（0xC0000005 访问违例形态，无干净退出码）
//   --hang    挂起 <ms>（配合烧录预算超时 → taskkill 树杀 → unknown）
//   --hang-with-child  同上，且 spawn 一个孙进程一起挂并写 <state>/virtual-child.pid
//                      （验证 taskkill /T /F 杀整棵进程树，不只杀父进程）
import { createHash } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

function argValue(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}
const has = (name) => process.argv.includes(name);

const artifactPath = argValue('--artifact');
const stateDir = argValue('--state');

function failUsage(msg) {
  console.error(`[virtual-flash-tool] 参数错误：${msg}`);
  process.exit(64);
}
if (!artifactPath || !stateDir) failUsage('--artifact 与 --state 必填');

const firmwareStatePath = path.join(stateDir, 'device-firmware.json');

async function sha256OfFile(p) {
  const buf = await readFile(p);
  return createHash('sha256').update(buf).digest('hex');
}

async function main() {
  try {
    await stat(artifactPath);
  } catch {
    console.error(`[virtual-flash-tool] 产物不存在：${artifactPath}`);
    process.exit(65);
  }

  if (has('--verify')) {
    // 读回校验模式（readbackCommand 用）
    let state;
    try {
      state = JSON.parse(await readFile(firmwareStatePath, 'utf8'));
    } catch {
      console.error('[virtual-flash-tool] VERIFY_FAIL: 板内无固件状态');
      process.exit(1);
    }
    const actual = await sha256OfFile(artifactPath);
    if (state.sha256 === actual) {
      console.log(`VERIFY_OK sha256=${actual}`);
      process.exit(0);
    }
    console.error(`VERIFY_FAIL: 板内 ${state.sha256} != 产物 ${actual}`);
    process.exit(1);
  }

  console.log(`[virtual-flash-tool] target: virtual-stm32f103`);
  console.log(`[virtual-flash-tool] erasing... done`);
  console.log(`[virtual-flash-tool] programming ${artifactPath} ...`);

  if (has('--crash')) {
    console.log('[virtual-flash-tool] flashing... ');
    // 模拟访问违例崩溃（Windows NTSTATUS 形态大退出码；父进程归类 unknown）
    process.exit(3221225477);
  }

  const hangMs = Number(argValue('--hang') ?? argValue('--hang-with-child') ?? '0');
  if (hangMs > 0) {
    if (has('--hang-with-child')) {
      // 孙进程：长驻等待（验证 /T 树杀）
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 60000)'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      await writeFile(path.join(stateDir, 'virtual-child.pid'), String(child.pid), 'utf8');
      console.log(`[virtual-flash-tool] spawned helper pid=${child.pid}, hanging ${hangMs}ms`);
    }
    // 挂起（烧录进行中；被预算超时 taskkill → 父进程按 unknown 归类；自然结束则继续）
    await new Promise((r) => setTimeout(r, hangMs));
  }

  if (has('--fail')) {
    console.error('[virtual-flash-tool] ERROR: flash verify failed (scripted failure)');
    process.exit(1);
  }

  const sha = await sha256OfFile(artifactPath);
  const buildId = has('--no-build-id') ? undefined : (argValue('--build-id') ?? `build-${sha.slice(0, 12)}`);
  const state = {
    schemaVersion: 1,
    sha256: sha,
    buildId,
    supportsBuildIdEcho: !has('--no-build-id'),
    flashedAt: new Date().toISOString(),
  };
  await writeFile(firmwareStatePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  console.log(`[virtual-flash-tool] Flash OK sha256=${sha} buildId=${buildId ?? '(none)'}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[virtual-flash-tool] unexpected: ${err && err.message}`);
  process.exit(70);
});
