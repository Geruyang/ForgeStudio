// Profile 加载器测试：目录数组加载、zod 校验、fileSha256 缓存、revision 变化检测、非法文件诊断。
import { describe, expect, it, afterAll } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { ProfileLoader } from '../src/profiles/loader.ts';
import { captureSourceSnapshot } from '../src/snapshot/source-snapshot.ts';
import { EngineeringProfileSchema } from '../../contracts/src/profile.ts';
import { writeFixtureProject, makeTmpDir, rmForce } from './helpers/fixtures.ts';

const cleanups: string[] = [];
afterAll(async () => {
  for (const d of cleanups) await rmForce(d);
});

describe('ProfileLoader', () => {
  it('从目录数组加载 *.profile.json 并 zod 校验；fileSha256 缓存', async () => {
    const fx = await writeFixtureProject('ok');
    cleanups.push(fx.root, fx.profileDir);
    const loader = new ProfileLoader([fx.profileDir]);
    const loaded = await loader.get(fx.profileId);
    expect(loaded).not.toBeNull();
    expect(loaded!.profile.id).toBe(fx.profileId);
    expect(loaded!.profile.revision).toBe(1);
    expect(loaded!.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await loader.list()).map((l) => l.profile.id)).toContain(fx.profileId);
  });

  it('非法 profile 跳过并记录诊断（不阻塞其他文件）', async () => {
    const dir = await makeTmpDir('profiles-bad');
    cleanups.push(dir);
    await fsp.writeFile(path.join(dir, 'bad.profile.json'), '{ not json', 'utf8');
    await fsp.writeFile(
      path.join(dir, 'wrong-rev.profile.json'),
      JSON.stringify({ schemaVersion: 1, id: 'wrong-rev', revision: -1, title: 'x', kind: 'software', build: { exe: 'node', args: [], timeoutMs: 1000 }, artifactsGlob: ['*'], verifiers: [] }),
      'utf8',
    );
    const loader = new ProfileLoader([dir]);
    expect(await loader.get('wrong-rev')).toBeNull();
    expect(loader.loadDiagnostics().length).toBe(2);
  });

  it('先到先得：用户目录优先于模板目录（同 id）', async () => {
    const userDir = await makeTmpDir('profiles-user');
    const tplDir = await makeTmpDir('profiles-tpl');
    cleanups.push(userDir, tplDir);
    const mk = async (dir: string, marker: string) => {
      await fsp.writeFile(
        path.join(dir, 'dup.profile.json'),
        JSON.stringify({ schemaVersion: 1, id: 'dup', revision: 1, title: marker, kind: 'software', build: { exe: 'node', args: ['--version'], timeoutMs: 1000 }, artifactsGlob: ['*'], verifiers: [], inputIncludes: [], inputExcludes: [] }),
        'utf8',
      );
    };
    await mk(userDir, 'user');
    await mk(tplDir, 'template');
    const loader = new ProfileLoader([userDir, tplDir]);
    expect((await loader.get('dup'))!.profile.title).toBe('user');
  });

  it('profile 文件变化（revision+1）→ 缓存刷新 + 旧输入指纹过期', async () => {
    const fx = await writeFixtureProject('ok');
    cleanups.push(fx.root, fx.profileDir);
    const loader = new ProfileLoader([fx.profileDir]);
    const before = (await loader.get(fx.profileId))!;
    const snap1 = await captureSourceSnapshot({ taskId: 't', projectRoot: fx.root, profile: before.profile, profileFileSha256: before.fileSha256 });
    // 修改 profile：revision 2
    const edited = { ...before.profile, revision: 2 };
    await fsp.writeFile(before.filePath, JSON.stringify(edited, null, 2), 'utf8');
    // 等 mtime 变化可见（同一毫秒写入可能相同；主动 bump）
    await new Promise((r) => setTimeout(r, 20));
    const after = await loader.get(fx.profileId);
    expect(after!.profile.revision).toBe(2);
    expect(after!.fileSha256).not.toBe(before.fileSha256);
    const snap2 = await captureSourceSnapshot({ taskId: 't', projectRoot: fx.root, profile: after!.profile, profileFileSha256: after!.fileSha256 });
    expect(snap2.inputDigest).not.toBe(snap1.inputDigest);
    // 契约 schema 校验
    expect(() => EngineeringProfileSchema.parse(after!.profile)).not.toThrow();
  });
});
