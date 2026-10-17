// K-3 解除后的真实 git 仓库路径回归（Z0-4，2026-10-17）：
// 仓库自身 git init 后，工作树内的任务项目根 → probeGit 命中 → 快照记录 gitCommit/dirtyDiffDigest。
// 可移植性：非 git 检出环境（如纯 zip 解包）自动 skipIf，不虚报。
import { describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { EngineeringProfileSchema } from '../../contracts/src/profile.ts';
import { captureSourceSnapshot, probeGit } from '../src/snapshot/source-snapshot.ts';
import { isSha256 } from '../../contracts/src/common.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../');
const fixturesRoot = path.join(repoRoot, 'engineering', 'fixtures');
const profileFile = path.join(repoRoot, 'engineering', 'profiles', 'example-embedded-stm32.profile.json');

const probe = await probeGit(fixturesRoot);

describe.skipIf(probe === null)('A 级证据 git 路径（真实工作树内）', () => {
  it('probeGit：工作树内目录 → hasGit=true，commit 为 40 位十六进制、branch 为真值', () => {
    expect(probe).not.toBeNull();
    expect(probe!.commit ?? '').toMatch(/^[0-9a-f]{40}$/);
    expect(typeof probe!.branch).toBe('string');
    expect(probe!.branch!.length).toBeGreaterThan(0);
  });

  it('captureSourceSnapshot：仓库内 fixture → hasGit=true，gitCommit/gitBranch/dirtyDiffDigest 落快照', async () => {
    const raw = await fsp.readFile(profileFile, 'utf8');
    const profile = EngineeringProfileSchema.parse(JSON.parse(raw));
    const snap = await captureSourceSnapshot({
      taskId: 'task-z0-git-probe',
      projectRoot: path.join(fixturesRoot, 'software', 'sample-tool'),
      profile,
    });
    expect(snap.hasGit).toBe(true);
    expect(snap.gitCommit ?? '').toMatch(/^[0-9a-f]{40}$/);
    expect(snap.gitBranch).toBeTruthy();
    expect(snap.dirtyDiffDigest === undefined || isSha256(snap.dirtyDiffDigest)).toBe(true);
    expect(snap.untrackedDigest === undefined || isSha256(snap.untrackedDigest)).toBe(true);
    expect(snap.evidenceLevel).toBe('A');
  });
});
