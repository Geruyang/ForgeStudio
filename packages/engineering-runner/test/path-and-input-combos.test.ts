// should 场景（任务书 §15.2「中文、空格等更多路径组合」+「多种未跟踪/二进制/大工程输入组合」）：
// 中文+空格目录/文件名下：真实构建/验收全链、快照清单与指纹变化检测；二进制与多文件工程的指纹稳定性。
// 边界：本机 os.tmpdir() 为 ASCII 前缀，组合语义由 rootName/文件名注入；非 Windows 组合未测（记限制）。
import { describe, expect, it, afterAll } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import type { BuildOutput, TestOutput } from '@forgedesk/contracts/mcp';
import { makeEngine, expectOk, type EngineFixture } from './helpers/engine.ts';
import { makeTmpDir, rmForce } from './helpers/fixtures.ts';
import { EngineeringProfileSchema } from '../../contracts/src/profile.ts';
import { captureSourceSnapshot } from '../src/snapshot/source-snapshot.ts';

const cleanups: string[] = [];
async function makeEngineTracked(variant: 'ok', rootName: string): Promise<EngineFixture> {
  const f = await makeEngine(variant, { rootName });
  cleanups.push(f.dataDir, f.fx.root, f.fx.profileDir);
  return f;
}
afterAll(async () => {
  for (const d of cleanups) await rmForce(d);
});

/** 最小软件 profile（快照组合测试用：无构建/验收依赖，仅指纹扫描） */
async function writeMinimalProfile(profileDir: string, id: string): Promise<void> {
  const profile = {
    schemaVersion: 1,
    id,
    revision: 1,
    title: `combo fixture ${id}`,
    kind: 'software',
    build: { exe: 'node', args: ['build.mjs'], timeoutMs: 60_000 },
    artifactsGlob: ['build-report.json'],
    verifiers: [],
    inputIncludes: ['package.json'],
    inputExcludes: [],
  };
  await fsp.writeFile(path.join(profileDir, `${id}.profile.json`), JSON.stringify(profile, null, 2), 'utf8');
}

async function loadProfile(profileDir: string, id: string) {
  return EngineeringProfileSchema.parse(JSON.parse(await fsp.readFile(path.join(profileDir, `${id}.profile.json`), 'utf8')));
}

describe('should：中文与空格路径组合（真实执行）', () => {
  const ROOT_NAME = '工程 甲 组 件'; // 中文 + 连续空格

  it('中文+空格目录下：构建成功、产物与日志落盘、操作 succeeded', async () => {
    const f = await makeEngineTracked('ok', ROOT_NAME);
    expect(f.fx.root).toContain(ROOT_NAME);
    const output = expectOk(
      (await f.engine.callOperation('build', { taskId: f.taskId, profileRevision: 1 }, { wait: true })).result,
    ) as BuildOutput;
    expect(output.ok).toBe(true);
    await fsp.access(path.join(f.dataDir, output.logRef));
    const op = f.storage.getOperation(output.operationId);
    expect(op?.status).toBe('succeeded');
  });

  it('中文+空格目录下：固定验收通过、证据与验收项点亮（verifier 以该目录为 cwd 执行）', async () => {
    const f = await makeEngineTracked('ok', ROOT_NAME);
    const result = await f.engine.callOperation(
      'test',
      { taskId: f.taskId, verifierId: `${f.fx.profileId}-smoke` },
      { wait: true },
    );
    const output = expectOk(result.result) as TestOutput;
    expect(output.result).toBe('passed');
    const evidence = f.storage.getEvidence(output.evidenceId);
    expect(evidence?.result).toBe('passed');
    expect(f.storage.getAcceptanceItem(f.acceptanceItemId)?.status).toBe('passed');
  });

  it('中文+空格文件名进入输入清单（posix 路径），内容变化→指纹变化', async () => {
    const base = await makeTmpDir('proj');
    cleanups.push(base);
    const root = path.join(base, '样例 工程');
    await fsp.mkdir(path.join(root, '源 码 目录'), { recursive: true });
    await fsp.writeFile(path.join(root, 'package.json'), '{"name":"zh-path","private":true}\n', 'utf8');
    await fsp.writeFile(path.join(root, '源 码 目录', '主程序.js'), 'console.log("中文内容 v1");\n', 'utf8');
    const profileDir = await makeTmpDir('profiles');
    cleanups.push(profileDir);
    await writeMinimalProfile(profileDir, 'zh-path');
    const profile = await loadProfile(profileDir, 'zh-path');
    const a = await captureSourceSnapshot({ taskId: 'task-zh-path', projectRoot: root, profile });
    expect(a.inputManifest.map((m) => m.path)).toContain('源 码 目录/主程序.js');
    expect(a.inputManifest.every((m) => !m.path.includes('\\'))).toBe(true);
    await fsp.writeFile(path.join(root, '源 码 目录', '主程序.js'), 'console.log("中文内容 v2 修改");\n', 'utf8');
    const b = await captureSourceSnapshot({ taskId: 'task-zh-path', projectRoot: root, profile });
    expect(b.inputDigest).not.toBe(a.inputDigest);
  });
});

describe('should：输入组合扩展（二进制 / 多文件工程）', () => {
  it('二进制文件（含 0x00-0xFF）纳入清单，单字节翻转→指纹变化', async () => {
    const base = await makeTmpDir('proj');
    cleanups.push(base);
    const root = path.join(base, 'combo');
    await fsp.mkdir(root, { recursive: true });
    await fsp.writeFile(path.join(root, 'package.json'), '{"name":"combo","private":true}\n', 'utf8');
    const bin = Buffer.alloc(4096);
    for (let i = 0; i < bin.length; i++) bin[i] = i % 256;
    await fsp.writeFile(path.join(root, 'asset.bin'), bin);
    const profileDir = await makeTmpDir('profiles');
    cleanups.push(profileDir);
    await writeMinimalProfile(profileDir, 'combo');
    const profile = await loadProfile(profileDir, 'combo');
    const a = await captureSourceSnapshot({ taskId: 'task-combo', projectRoot: root, profile });
    const entry = a.inputManifest.find((m) => m.path === 'asset.bin');
    expect(entry?.sha256).toBe(createHash('sha256').update(bin).digest('hex'));
    bin[2048] = bin[2048]! ^ 0xff;
    await fsp.writeFile(path.join(root, 'asset.bin'), bin);
    const b = await captureSourceSnapshot({ taskId: 'task-combo', projectRoot: root, profile });
    expect(b.inputDigest).not.toBe(a.inputDigest);
  });

  it('200 文件 + 深层嵌套工程：两次采集清单与指纹完全一致（确定性）', async () => {
    const base = await makeTmpDir('proj');
    cleanups.push(base);
    const root = path.join(base, 'large-tree');
    await fsp.mkdir(root, { recursive: true });
    await fsp.writeFile(path.join(root, 'package.json'), '{"name":"large","private":true}\n', 'utf8');
    for (let i = 0; i < 200; i++) {
      const deep = path.join(root, `pkg${i}`, 'a', 'b', 'c');
      await fsp.mkdir(deep, { recursive: true });
      await fsp.writeFile(path.join(deep, `f${i}.js`), `export const v${i} = ${i};\n`, 'utf8');
    }
    const profileDir = await makeTmpDir('profiles');
    cleanups.push(profileDir);
    await writeMinimalProfile(profileDir, 'large');
    const profile = await loadProfile(profileDir, 'large');
    const a = await captureSourceSnapshot({ taskId: 'task-large', projectRoot: root, profile });
    expect(a.inputManifest.filter((m) => m.path.startsWith('pkg'))).toHaveLength(200);
    const b = await captureSourceSnapshot({ taskId: 'task-large', projectRoot: root, profile });
    expect(b.inputDigest).toBe(a.inputDigest);
    expect(b.inputManifest.map((m) => m.path)).toEqual(a.inputManifest.map((m) => m.path));
  });
});
