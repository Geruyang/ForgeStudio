// @vitest-environment node
// fz3b-semantic-video-search（用户真实项目）板上验证（Z3 深化）：PS 用户态组件在板上编译 + 自检。
// 项目：https://github.com/Geruyang/fz3b-semantic-video-search（vendored 至 engineering/fixtures/fz3b-svs）
// 运行条件：FZ3B_PASSWORD 环境变量 + 板卡可达。
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

describe.skipIf(skip)('fz3b-svs 用户项目（实机：板上编译 + 自检）', () => {
  it('PS 组件板上构建（read_clock/mjpeg_source/NEON native）→ 自检验收 → B 级证据', async () => {
    const dataDir = await makeTmpDir('data');
    cleanups.push(dataDir);
    const projDir = path.join(repoRoot, 'engineering', 'fixtures', 'fz3b-svs');
    const profileDir = path.join(repoRoot, 'engineering', 'profiles');

    const storage = new Storage(dataDir);
    const profiles = new ProfileLoader([profileDir]);
    await profiles.reload();
    const engine = new OpsEngine({ dataDir, storage, profiles });
    const task = await engine.createTask({
      projectRoot: projDir,
      profileId: 'fz3b-svs',
      title: 'fz3b-svs 用户项目实机验证',
      acceptance: [
        { kind: 'executable', verifierId: 'fz3b-svs-selftest', title: '板上自检', expected: 'TESTS_PASSED', manualRequired: false, required: true },
      ],
    });
    const itemId = storage.listAcceptanceItems(task.id)[0]!.id;

    const build = await engine.callOperation('build', { taskId: task.id, profileRevision: 1 }, { wait: true });
    const buildOut = build.result as { ok: boolean; artifactSha256?: string };
    if (!buildOut.ok) {
      const detail = (build.result as { detail?: string }).detail;
      if (detail) {
        try { console.log('--- build.log ---'); console.log(await (await import('node:fs/promises')).readFile(path.join(dataDir, detail), 'utf8')); } catch (e) { console.log('log 不可读:', String(e)); }
      }
    }
    expect(buildOut.ok, JSON.stringify(build.result).slice(0, 400)).toBe(true);
    console.log(`[live] 用户项目板上构建成功（read_clock sha256=${buildOut.artifactSha256?.slice(0, 16)}…）`);

    const test = await engine.callOperation('test', { taskId: task.id, verifierId: 'fz3b-svs-selftest' }, { wait: true });
    const testOut = test.result as { ok: boolean; result: string; evidenceId: string };
    expect(testOut.ok).toBe(true);
    expect(testOut.result).toBe('passed');
    expect(storage.getAcceptanceItem(itemId)?.status).toBe('passed');
    expect(storage.getEvidence(testOut.evidenceId)?.result).toBe('passed');
    console.log('[live] 板上自检 passed（构建完整性 + 权限语义判定）');
    storage.close();
    await engine.shutdown(2_000);
  }, 420_000);
});
