// 快照层测试：内容变化→digest 变化、inputIncludes/Excludes 生效、超限→采集失败（待重验）、profile 摘要参与指纹。
import { describe, expect, it, afterAll } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { EngineeringProfileSchema } from '../../contracts/src/profile.ts';
import {
  captureSourceSnapshot,
  SnapshotLimitError,
  SNAPSHOT_MAX_FILE_BYTES,
  digestManifest,
} from '../src/snapshot/source-snapshot.ts';
import { writeFixtureProject, makeTmpDir, rmForce } from './helpers/fixtures.ts';

const cleanups: string[] = [];
afterAll(async () => {
  for (const d of cleanups) await rmForce(d);
});

async function loadProfile(file: string) {
  const raw = await fsp.readFile(file, 'utf8');
  return EngineeringProfileSchema.parse(JSON.parse(raw));
}

describe('A 级输入指纹', () => {
  it('未变化时两次采集 digest 一致；修改内容 → digest 变化（内容寻址）', async () => {
    const fx = await writeFixtureProject('ok');
    cleanups.push(fx.root, fx.profileDir);
    const profile = await loadProfile(fx.profileFile);
    const a = await captureSourceSnapshot({ taskId: 'task-snap', projectRoot: fx.root, profile });
    const b = await captureSourceSnapshot({ taskId: 'task-snap', projectRoot: fx.root, profile });
    expect(b.inputDigest).toBe(a.inputDigest);
    expect(a.hasGit).toBe(false); // 临时目录无 git → 内容清单回退
    expect(a.evidenceLevel).toBe('A');

    await fsp.writeFile(path.join(fx.root, 'src', 'main.js'), 'console.log("v2 编辑");\n', 'utf8');
    const c = await captureSourceSnapshot({ taskId: 'task-snap', projectRoot: fx.root, profile });
    expect(c.inputDigest).not.toBe(a.inputDigest);
  });

  it('inputIncludes 强制纳入（即使被排除规则命中）；inputExcludes 排除派生文件', async () => {
    const fx = await writeFixtureProject('ok');
    cleanups.push(fx.root, fx.profileDir);
    const profile = await loadProfile(fx.profileFile);
    const snap = await captureSourceSnapshot({ taskId: 'task-snap', projectRoot: fx.root, profile });
    const paths = snap.inputManifest.map((m) => m.path);
    // includes 生效
    expect(paths).toContain('package.json');
    expect(paths).toContain('build.mjs');
    expect(paths).toContain('run-tests.mjs');
    // 默认排除（node_modules/dist/.git 等）与 inputExcludes（build-report.json）不进清单
    expect(paths).not.toContain('build-report.json');
    await fsp.mkdir(path.join(fx.root, 'node_modules', 'pkg'), { recursive: true });
    await fsp.writeFile(path.join(fx.root, 'node_modules', 'pkg', 'x.js'), 'x', 'utf8');
    const snap2 = await captureSourceSnapshot({ taskId: 'task-snap', projectRoot: fx.root, profile });
    expect(snap2.inputDigest).toBe(snap.inputDigest); // node_modules 变化不影响指纹
  });

  it('单文件超过 16MB → SnapshotLimitError（采集失败→证据待重验，不假造）', async () => {
    const fx = await writeFixtureProject('ok');
    cleanups.push(fx.root, fx.profileDir);
    const profile = await loadProfile(fx.profileFile);
    const big = Buffer.alloc(SNAPSHOT_MAX_FILE_BYTES + 1, 65);
    await fsp.writeFile(path.join(fx.root, 'src', 'big.bin'), big);
    await expect(
      captureSourceSnapshot({ taskId: 'task-snap', projectRoot: fx.root, profile }),
    ).rejects.toBeInstanceOf(SnapshotLimitError);
  });

  it('profile 文件摘要参与聚合指纹：revision 变化 → 指纹变化（旧证据过期判定输入包含 profile 摘要）', async () => {
    const fx = await writeFixtureProject('ok');
    cleanups.push(fx.root, fx.profileDir);
    const profile = await loadProfile(fx.profileFile);
    const withA = await captureSourceSnapshot({ taskId: 'task-snap', projectRoot: fx.root, profile, profileFileSha256: 'a'.repeat(64) });
    const withA2 = await captureSourceSnapshot({ taskId: 'task-snap', projectRoot: fx.root, profile, profileFileSha256: 'a'.repeat(64) });
    const withB = await captureSourceSnapshot({ taskId: 'task-snap', projectRoot: fx.root, profile, profileFileSha256: 'b'.repeat(64) });
    expect(withA2.inputDigest).toBe(withA.inputDigest);
    expect(withB.inputDigest).not.toBe(withA.inputDigest);
  });

  it('digestManifest 规范化：清单排序后聚合，路径序变化不影响', () => {
    const m = [
      { kind: 'untracked' as const, path: 'b.txt', sha256: '1'.repeat(64), sizeBytes: 1 },
      { kind: 'lockfile' as const, path: 'a.txt', sha256: '2'.repeat(64), sizeBytes: 2 },
    ];
    expect(digestManifest([...m].reverse())).toBe(digestManifest(m));
    expect(digestManifest(m)).toMatch(/^[0-9a-f]{64}$/);
  });
});
