// @vitest-environment node
// FZ3B 多文件 C 工程 + 板上单元测试实机验收（Z4 可选 3）：
// 板上 make 原生构建（ringbuf 模块 + minunit 框架多文件编译）→ 板上运行单元测试
// （8 用例 PASS + 板卡身份）→ B 级证据落库。运行条件：FZ3B_PASSWORD 环境变量。
import { describe, expect, it, afterAll } from 'vitest';
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

describe.skipIf(skip)('FZ3B 多文件 C 工程 + 板上单元测试（实机）', () => {
  it('make 多文件构建 → 板上单测 8 用例 → UNIT_TESTS_PASSED + 板卡身份 → B 级证据落库', async () => {
    const dataDir = await makeTmpDir('data');
    const projDir = path.join(repoRoot, 'engineering', 'fixtures', 'fz3b-unit');
    const profileDir = path.join(repoRoot, 'engineering', 'profiles');
    cleanups.push(dataDir);

    const storage = new Storage(dataDir);
    const profiles = new ProfileLoader([profileDir]);
    await profiles.reload();
    const engine = new OpsEngine({ dataDir, storage, profiles });
    const task = await engine.createTask({
      projectRoot: projDir,
      profileId: 'fz3b-unit',
      title: 'FZ3B 单元测试工程实机任务',
      acceptance: [
        { kind: 'executable', verifierId: 'fz3b-unittest', title: '板上单元测试', expected: '8 用例全过 + 板卡身份', manualRequired: false, required: true },
      ],
    });
    const itemId = storage.listAcceptanceItems(task.id)[0]!.id;

    // 构建（板上 make：test/ringbuf/minunit 多文件编译链接）
    const build = await engine.callOperation('build', { taskId: task.id, profileRevision: 1 }, { wait: true });
    const buildOut = build.result as { ok: boolean; artifactSha256?: string; artifactPath?: string };
    expect(buildOut.ok, JSON.stringify(build.result)).toBe(true);
    expect(buildOut.artifactPath).toContain('remote-artifacts');
    console.log(`[live] 板上多文件构建成功，产物 sha256=${buildOut.artifactSha256?.slice(0, 16)}…`);

    // B 级快照（buildFromSnapshot）
    const snaps = storage.listSnapshots(task.id);
    expect(snaps.find((s) => s.evidenceLevel === 'B')).toBeDefined();

    // 验收（板上运行单元测试；stdoutMustContain 强制 RUN=8/FAILED=0/UNIT_TESTS_PASSED/板卡身份）
    const test = await engine.callOperation('test', { taskId: task.id, verifierId: 'fz3b-unittest' }, { wait: true });
    const testOut = test.result as { ok: boolean; result: string; evidenceId: string };
    expect(testOut.ok).toBe(true);
    expect(testOut.result).toBe('passed');
    expect(storage.getAcceptanceItem(itemId)?.status).toBe('passed');
    const evidence = storage.getEvidence(testOut.evidenceId);
    expect(evidence?.result).toBe('passed');
    // 输出形态证据（逐用例 PASS 行 + 总结），供记录
    console.log('[live] 板上单测证据 result=passed（RUN=8 FAILED=0 UNIT_TESTS_PASSED 由 stdoutMustContain 强制）');

    storage.close();
    await engine.shutdown(2_000);
  }, 300_000);
});
