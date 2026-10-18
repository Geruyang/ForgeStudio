// @vitest-environment node
// FZ3B make 工程实机验收（Z3 深化）：板上 make 原生构建 + 板上自检验收。
// 同时覆盖 B 级快照 + SSH 组合（profile.buildFromSnapshot=true：上传的是快照内容）。
// 运行条件：FZ3B_PASSWORD 环境变量（host/user 写死自 profile，与板卡记录一致）。
import { describe, expect, it, afterAll } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Storage } from '../src/storage/database.ts';
import { ProfileLoader } from '../src/profiles/loader.ts';
import { OpsEngine } from '../src/ops/engine.ts';
import { makeTmpDir, rmForce } from './helpers/fixtures.ts';

const skip = (process.env.FZ3B_PASSWORD ?? '').length === 0;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const cleanups: string[] = [];
afterAll(async () => {
  for (const d of cleanups) await rmForce(d);
});

describe.skipIf(skip)('FZ3B make 工程（实机：板上构建 + 板上验收 + B 级快照组合）', () => {
  it('make 构建 → fzprobe 自检 → TESTS_PASSED + 板卡身份 → B 级证据落库', async () => {
    const dataDir = await makeTmpDir('data');
    const projDir = path.join(repoRoot, 'engineering', 'fixtures', 'fz3b-make');
    const profileDir = path.join(repoRoot, 'engineering', 'profiles');
    cleanups.push(dataDir);

    const storage = new Storage(dataDir);
    const profiles = new ProfileLoader([profileDir]);
    await profiles.reload();
    const engine = new OpsEngine({ dataDir, storage, profiles });
    const task = await engine.createTask({
      projectRoot: projDir,
      profileId: 'fz3b-make',
      title: 'FZ3B make 工程实机任务',
      acceptance: [
        { kind: 'executable', verifierId: 'fz3b-selftest', title: '板上自检', expected: 'TESTS_PASSED + 板卡身份', manualRequired: false, required: true },
      ],
    });
    const itemId = storage.listAcceptanceItems(task.id)[0]!.id;

    // 构建（板上 make；B 级快照：上传内容 = 快照目录文件）；产物自板上取回到 remote-artifacts
    const build = await engine.callOperation('build', { taskId: task.id, profileRevision: 1 }, { wait: true });
    const buildOut = build.result as { ok: boolean; artifactSha256?: string; artifactPath?: string };
    expect(buildOut.ok, JSON.stringify(build.result)).toBe(true);
    expect(buildOut.artifactPath).toContain('remote-artifacts');
    console.log(`[live] 板上 make 构建成功，产物 sha256=${buildOut.artifactSha256?.slice(0, 16)}…`);

    // 快照记录为 B 级
    const snaps = storage.listSnapshots(task.id);
    const bSnap = snaps.find((s) => s.evidenceLevel === 'B');
    expect(bSnap).toBeDefined();
    expect(bSnap!.snapshotPath).toContain(path.join(dataDir, 'snapshots'));

    // 验收（板上运行 fzprobe）
    const test = await engine.callOperation('test', { taskId: task.id, verifierId: 'fz3b-selftest' }, { wait: true });
    const testOut = test.result as { ok: boolean; result: string; evidenceId: string };
    expect(testOut.ok).toBe(true);
    expect(testOut.result).toBe('passed');
    expect(storage.getAcceptanceItem(itemId)?.status).toBe('passed');
    const evidence = storage.getEvidence(testOut.evidenceId);
    expect(evidence?.result).toBe('passed');

    // 身份证据：verifier 的 stdoutMustContain（KERNEL=/xilinx-v/BOARD_HOST=）已在判定中强制——
    // 验收 passed 即证明板上输出含真实板卡身份（EdgeBoard / 4.14.0-xilinx-v2018.3），不重复扫描日志。
    storage.close();
    await engine.shutdown(2_000);
  }, 300_000);
});
