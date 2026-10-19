// @vitest-environment node
// STM32F429 网口测试固件实机验收（A-14 部分实证：GCC 构建 → SWD 烧录 + 读回校验）。
// 运行条件：fireDAP（CMSIS-DAP）探针与 STM32F429IG 目标在线；工具链位于
// E:\AiProject\tools-dl（arm-gcc / windows-build-tools / probe-rs，见 profile env）。
// 网口数据通路（ARP/UDP 应答）在本板存在未解板级问题（两种协议栈同样表现），
// 不在本用例宣称——本用例验收的是"新写代码→交叉构建→烧录→读回校验"闭环。
import { describe, expect, it, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import { Storage } from '../src/storage/database.ts';
import { ProfileLoader } from '../src/profiles/loader.ts';
import { OpsEngine } from '../src/ops/engine.ts';
import { makeTmpDir, rmForce } from './helpers/fixtures.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const cleanups: string[] = [];
process.env.FD_KEEP_DATA = "1";
afterAll(async () => {
  for (const d of cleanups) await rmForce(d);
});

const skip = process.env.FD_STM32_LIVE !== '1';

describe.skipIf(skip)('STM32F429 nettest 固件（实机：构建 + SWD 烧录读回校验）', () => {
  it('make 构建（快照内）→ probe-rs download --verify → Finished 判定 → 证据落库', async () => {
    const dataDir = path.join(repoRoot, ".runtime", "stm-live-data");
    const projDir = path.join(repoRoot, 'engineering', 'fixtures', 'stm32f429-nettest');
    const profileDir = path.join(repoRoot, 'engineering', 'profiles');

    fs.mkdirSync(dataDir, { recursive: true });
    const storage = new Storage(dataDir);
    const profiles = new ProfileLoader([profileDir]);
    await profiles.reload();
    const engine = new OpsEngine({ dataDir, storage, profiles });
    const task = await engine.createTask({
      projectRoot: projDir,
      profileId: 'stm32f429-nettest',
      title: 'STM32F429 nettest 实机任务',
      acceptance: [
        { kind: 'executable', verifierId: 'swd-flash-verify', title: 'SWD 烧录读回校验', expected: 'probe-rs Finished + exit 0', manualRequired: false, required: true },
      ],
    });
    const itemId = storage.listAcceptanceItems(task.id)[0]!.id;

    // 构建（快照内 make：GCC + 自写启动/链接/HAL/极简网络栈）
    const build = await engine.callOperation('build', { taskId: task.id, profileRevision: 1 }, { wait: true });
    const buildOut = build.result as { ok: boolean; artifactSha256?: string; artifactPath?: string };
    expect(buildOut.ok, JSON.stringify(build.result)).toBe(true);
    console.log(`[live] 固件构建成功（快照内），elf sha256=${buildOut.artifactSha256?.slice(0, 16)}…`);

    // B 级快照
    const snaps = storage.listSnapshots(task.id);
    expect(snaps.find((s) => s.evidenceLevel === 'B')).toBeDefined();

    // 验收：SWD 烧录 + 读回校验（真实写 flash，verify 比对 ELF 内容）
    const test = await engine.callOperation('test', { taskId: task.id, verifierId: 'swd-flash-verify' }, { wait: true });
    const testOut = test.result as { ok: boolean; result: string; evidenceId: string };
    expect(testOut.ok).toBe(true);
    expect(testOut.result).toBe('passed');
    expect(storage.getAcceptanceItem(itemId)?.status).toBe('passed');
    const evidence = storage.getEvidence(testOut.evidenceId);
    expect(evidence?.result).toBe('passed');
    console.log('[live] SWD 烧录+读回校验 passed（fireDAP CMSIS-DAP，真实写入 STM32F429IG flash）');

    storage.close();
    await engine.shutdown(2_000);
  }, 300_000);
});
