// B 级快照证据（任务书 §8.2 B 级 / P0-6）：构建/验收从任务专属输入快照执行、产物独立、
// 构建期间的源目录外部编辑不再误报 evidence_stale（复核针对快照）；源漂移由下次操作暴露。
import { describe, expect, it, afterAll } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { Storage } from '../src/storage/database.ts';
import { ProfileLoader } from '../src/profiles/loader.ts';
import { OpsEngine } from '../src/ops/engine.ts';
import { makeTmpDir, rmForce } from './helpers/fixtures.ts';

const cleanups: string[] = [];
afterAll(async () => {
  for (const d of cleanups) await rmForce(d);
});

/** 构建/验收都回显自身 cwd 与读到的源内容（验证"从快照执行"与内容隔离） */
const BUILD_ECHO = `import { writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(root, 'src', 'main.js'), 'utf8');
writeFileSync(join(root, 'build-report.json'), JSON.stringify({ ok: true, src, root }) + '\\n');
console.log('BUILD_OK');
`;
const VERIFY_ECHO = `import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const report = JSON.parse(readFileSync(join(root, 'build-report.json'), 'utf8'));
console.log('CWD=' + root);
console.log('SRC=' + report.src.trim());
console.log(report.ok ? 'TESTS_PASSED' : 'TEST_FAILED');
`;

async function makeBEngine(variant: 'plain' | 'mutate-during-build') {
  const dataDir = await makeTmpDir('data');
  const projDir = await makeTmpDir('proj');
  const profileDir = await makeTmpDir('profiles');
  cleanups.push(dataDir, projDir, profileDir);

  await fsp.mkdir(path.join(projDir, 'src'), { recursive: true });
  await fsp.writeFile(path.join(projDir, 'src', 'main.js'), 'console.log("v1");\n', 'utf8');
  await fsp.writeFile(path.join(projDir, 'package.json'), '{"name":"b-snap","private":true}\n', 'utf8');
  await fsp.writeFile(path.join(projDir, 'build.mjs'), BUILD_ECHO, 'utf8');
  await fsp.writeFile(path.join(projDir, 'run-tests.mjs'), VERIFY_ECHO, 'utf8');
  if (variant === 'mutate-during-build') {
    // 构建期间修改【源】目录的输入（B 级应不受影响：构建读的是快照副本）
    await fsp.writeFile(
      path.join(projDir, 'build.mjs'),
      BUILD_ECHO.replace(
        "console.log('BUILD_OK');",
        `import { appendFileSync } from 'node:fs';
appendFileSync(join(root, '..', '..', 'MUTATE_MARKER'), '');
// 直接改【源目录】（root 的上级链之外，用绝对路径写回）
appendFileSync(${JSON.stringify(path.join(projDir, 'src', 'main.js'))}, '// externally mutated\\n');
console.log('BUILD_OK');`,
      ),
      'utf8',
    );
  }
  const profile = {
    schemaVersion: 1,
    id: 'b-snap-fixture',
    revision: 1,
    title: 'B 级快照 fixture',
    kind: 'software',
    build: { exe: 'node', args: ['build.mjs'], timeoutMs: 60_000 },
    artifactsGlob: ['build-report.json'],
    verifiers: [
      {
        verifierId: 'b-snap-smoke',
        title: '快照内验收',
        command: { exe: 'node', args: ['run-tests.mjs'], timeoutMs: 30_000 },
        passExitCode: 0,
        stdoutMustContain: ['TESTS_PASSED'],
        stdoutMustNotContain: [],
        outputLimitBytes: 1_048_576,
      },
    ],
    inputIncludes: ['package.json', 'build.mjs', 'run-tests.mjs', 'src/main.js'],
    inputExcludes: ['build-report.json'],
    buildFromSnapshot: true,
  };
  await fsp.writeFile(path.join(profileDir, 'b-snap-fixture.profile.json'), JSON.stringify(profile, null, 2), 'utf8');
  const storage = new Storage(dataDir);
  const profiles = new ProfileLoader([profileDir]);
  await profiles.reload();
  const engine = new OpsEngine({ dataDir, storage, profiles });
  const task = await engine.createTask({
    projectRoot: projDir,
    profileId: 'b-snap-fixture',
    title: `B级-${variant}`,
    acceptance: [
      { kind: 'executable', verifierId: 'b-snap-smoke', title: '快照冒烟', expected: 'TESTS_PASSED', manualRequired: false, required: true },
    ],
  });
  const itemId = storage.listAcceptanceItems(task.id)[0]!.id;
  return { engine, storage, dataDir, projDir, taskId: task.id, itemId };
}

describe('B 级快照构建（fixture 级）', () => {
  it('构建/验收从快照目录执行：evidenceLevel=B、snapshotPath 落库、产物位于快照目录、验收读到的源=v1', async () => {
    const f = await makeBEngine('plain');
    const build = await f.engine.callOperation('build', { taskId: f.taskId, profileRevision: 1 }, { wait: true });
    const buildOut = build.result as { ok: boolean; artifactPath: string; operationId: string };
    expect(buildOut.ok, JSON.stringify(build.result)).toBe(true);
    // 产物在快照目录（dataDir/snapshots/<taskId>-<digest8>/build-report.json）
    expect(buildOut.artifactPath).toContain(path.join(f.dataDir, 'snapshots'));

    const snaps = f.storage.listSnapshots(f.taskId);
    const bSnap = snaps.find((s) => s.evidenceLevel === 'B');
    expect(bSnap).toBeDefined();
    expect(bSnap!.snapshotPath).toContain(path.join(f.dataDir, 'snapshots'));

    const test = await f.engine.callOperation('test', { taskId: f.taskId, verifierId: 'b-snap-smoke' }, { wait: true });
    const testOut = test.result as { ok: boolean; result: string };
    expect(testOut.result).toBe('passed');
    expect(f.storage.getAcceptanceItem(f.itemId)?.status).toBe('passed');
    f.storage.close();
    await f.engine.shutdown(2_000);
  });

  it('构建期间源目录被外部编辑：B 级不受影响（不误报 evidence_stale），产物内容绑定快照 v1', async () => {
    const f = await makeBEngine('mutate-during-build');
    const build = await f.engine.callOperation('build', { taskId: f.taskId, profileRevision: 1 }, { wait: true });
    const buildOut = build.result as { ok: boolean; artifactSha256: string };
    expect(buildOut.ok, JSON.stringify(build.result)).toBe(true);
    // 源目录已被构建脚本改掉（v1 → 追加 mutated）
    const mutated = await fsp.readFile(path.join(f.projDir, 'src', 'main.js'), 'utf8');
    expect(mutated).toContain('externally mutated');
    // 快照目录内仍是 v1（隔离生效）
    const snaps = f.storage.listSnapshots(f.taskId).filter((s) => s.evidenceLevel === 'B');
    const snapDir = snaps[0]!.snapshotPath!;
    const snapMain = await fsp.readFile(path.join(snapDir, 'src', 'main.js'), 'utf8');
    expect(snapMain).toBe('console.log("v1");\n');
    // 验收在 mutated 源之后：新快照（内容不同 → 不同目录，无 build-report）→ 验收失败，
    // 不为已漂移的源状态点亮（M5 语义保持：B 级隔离的是构建，不是证据时效）
    const test = await f.engine.callOperation('test', { taskId: f.taskId, verifierId: 'b-snap-smoke' }, { wait: true });
    const testOut = test.result as { ok: boolean; result: string };
    expect(testOut.result).toBe('failed');
    expect(f.storage.getAcceptanceItem(f.itemId)?.status).not.toBe('passed');
    f.storage.close();
    await f.engine.shutdown(2_000);
  });
});
