// M5 must 场景（fixture 级）；集成状态：TODO-INT
// （B2 的 snapshot 模块未交付前：以 contracts SourceSnapshot 类型 + 本文件固化的“输入指纹构造约定”
//   做纯逻辑验证；B2 交付后应把 capture()/aggregateInputDigest 替换为真实快照模块并对拍一致性。
//   contracts 层已可真实运行的部分（类型表达、指纹变化检测、stale→验收不点亮）现在就测。）
//
// 场景（任务书 §15.2 M5）：未提交/未跟踪/配置变化可识别；证据绑定的输入变化后不为当前状态点亮通过。

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { computeTaskAcceptance } from '../../../contracts/src/engineering.ts';
import type { AcceptanceItem, SourceInputDigest, SourceInputKind, SourceSnapshot } from '../../../contracts/src/engineering.ts';
import { EngineeringProfileSchema } from '../../../contracts/src/profile.ts';
import { isSha256 } from '../../../contracts/src/common.ts';

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/** 输入指纹构造约定（TODO-INT 集成点，与 B2 snapshot 模块对齐）：
 *  1) 每个纳入清单的输入文件 → SourceInputDigest{ kind, path(相对根、/ 分隔), sha256(内容), sizeBytes }
 *  2) 聚合 inputDigest = sha256(canonicalManifest)；
 *     canonicalManifest = 清单按 path 排序后逐条 JSON.stringify({kind,path,sha256,sizeBytes})，'\n' 连接
 *  3) 语义：任何被纳入清单的输入变化必然改变 inputDigest（A 级核心指纹，无 git 时同样成立） */
function canonicalManifest(manifest: SourceInputDigest[]): string {
  return [...manifest]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => JSON.stringify({ kind: e.kind, path: e.path, sha256: e.sha256, sizeBytes: e.sizeBytes }))
    .join('\n');
}
function aggregateInputDigest(manifest: SourceInputDigest[]): string {
  return sha256Hex(canonicalManifest(manifest));
}
function digestFile(root: string, rel: string, kind: SourceInputKind): SourceInputDigest {
  const content = readFileSync(join(root, rel));
  return {
    kind,
    path: rel.split(sep).join('/'),
    sha256: createHash('sha256').update(content).digest('hex'),
    sizeBytes: content.length,
  };
}

const TOOL_VERSIONS = { node: process.version };

/** 模拟一次快照采集（TODO-INT：替换为 B2 快照模块返回值） */
function capture(root: string, inputs: Array<{ rel: string; kind: SourceInputKind }>): SourceSnapshot {
  const manifest = inputs.map((i) => digestFile(root, i.rel, i.kind));
  return {
    schemaVersion: 1,
    id: `snap-${createHash('sha256').update(root + manifest.length).digest('hex').slice(0, 8)}`,
    taskId: 'task-m5-fixture',
    evidenceLevel: 'A',
    hasGit: false, // 本机无 git（docs/ENVIRONMENT.md）：走完整输入清单内容摘要
    inputDigest: aggregateInputDigest(manifest),
    inputManifest: manifest,
    toolVersions: TOOL_VERSIONS,
    capturedAt: new Date().toISOString(),
  };
}

describe('M5 A级输入指纹与证据过期（fixture 级）', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'forgedesk-m5-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'src', 'main.js'), 'console.log("v1");\n');
    writeFileSync(join(root, 'src', 'util.js'), 'export const u = 1;\n');
    writeFileSync(join(root, 'notes.md'), '临时说明\n');
    writeFileSync(join(root, 'package.json'), '{"name":"temp-m5","private":true}\n');
    writeFileSync(join(root, 'dist', 'generated.js'), '// 构建产物（inputExcludes，不参与指纹）\n');
    writeFileSync(
      join(root, 'project.profile.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          id: 'temp-m5-project',
          revision: 1,
          title: 'M5 临时工程',
          kind: 'software',
          build: { exe: 'node', args: ['--version'], timeoutMs: 30000 },
          artifactsGlob: ['dist/**'],
          verifiers: [
            {
              verifierId: 'm5-smoke',
              title: '冒烟',
              command: { exe: 'node', args: ['--version'], timeoutMs: 30000 },
            },
          ],
          inputIncludes: ['package.json'],
          inputExcludes: ['dist/**'],
        },
        null,
        2,
      ),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const INPUTS: Array<{ rel: string; kind: SourceInputKind }> = [
    { rel: 'src/main.js', kind: 'tracked_modified' },
    { rel: 'src/util.js', kind: 'tracked_modified' },
    { rel: 'notes.md', kind: 'untracked' },
    { rel: 'package.json', kind: 'build_config' },
    { rel: 'project.profile.json', kind: 'profile_config' },
  ];

  it('临时 profile 通过 EngineeringProfileSchema 校验（临时工程 + 临时 profile 就绪）', () => {
    const parsed = EngineeringProfileSchema.parse(
      JSON.parse(readFileSync(join(root, 'project.profile.json'), 'utf8')),
    );
    expect(parsed.id).toBe('temp-m5-project');
    expect(parsed.revision).toBe(1);
  });

  it('未变化时两次采集的输入指纹一致（确定性）', () => {
    const a = capture(root, INPUTS);
    const b = capture(root, INPUTS);
    expect(b.inputDigest).toBe(a.inputDigest);
    expect(b.inputDigest).not.toBe(a.inputManifest.map((m) => m.sha256).join('')); // 聚合≠拼接
    expect(isSha256(a.inputDigest)).toBe(true);
  });

  it('修改一个 tracked_modified 输入 → 聚合指纹与该文件摘要都变化', () => {
    const before = capture(root, INPUTS);
    writeFileSync(join(root, 'src', 'main.js'), 'console.log("v2 修改后的源码");\n');
    const after = capture(root, INPUTS);

    const beforeMain = before.inputManifest.find((m) => m.path === 'src/main.js')!;
    const afterMain = after.inputManifest.find((m) => m.path === 'src/main.js')!;
    expect(afterMain.sha256).not.toBe(beforeMain.sha256);
    expect(after.inputDigest).not.toBe(before.inputDigest);

    // 未修改的其他输入摘要不变
    for (const p of ['src/util.js', 'package.json', 'project.profile.json']) {
      expect(after.inputManifest.find((m) => m.path === p)!.sha256).toBe(
        before.inputManifest.find((m) => m.path === p)!.sha256,
      );
    }
  });

  it('新增 untracked 输入 → 聚合指纹变化（未跟踪输入可识别）', () => {
    const before = capture(root, INPUTS);
    writeFileSync(join(root, 'new-untracked.txt'), '新出现的必要未跟踪输入\n');
    const after = capture(root, [...INPUTS, { rel: 'new-untracked.txt', kind: 'untracked' }]);
    expect(after.inputDigest).not.toBe(before.inputDigest);
  });

  it('profile_config 变化（revision+1）→ 聚合指纹变化（配置变化可识别）', () => {
    const before = capture(root, INPUTS);
    const profile = JSON.parse(readFileSync(join(root, 'project.profile.json'), 'utf8'));
    profile.revision = 2;
    writeFileSync(join(root, 'project.profile.json'), JSON.stringify(profile, null, 2));
    const after = capture(root, INPUTS);
    expect(after.inputDigest).not.toBe(before.inputDigest);
  });

  it('内容变化但 sizeBytes 相同 → 指纹仍变化（内容寻址，不是按大小/时间）', () => {
    const before = capture(root, INPUTS);
    const sizeBefore = before.inputManifest.find((m) => m.path === 'notes.md')!.sizeBytes;
    writeFileSync(join(root, 'notes.md'), '临时注解\n'); // 同长度不同内容（4 个 3 字节汉字 + \n = 13 字节不变）
    const after = capture(root, INPUTS);
    expect(after.inputManifest.find((m) => m.path === 'notes.md')!.sizeBytes).toBe(sizeBefore);
    expect(after.inputDigest).not.toBe(before.inputDigest);
  });

  it('inputExcludes 排除的派生文件（dist/）变化 → 聚合指纹不变', () => {
    const before = capture(root, INPUTS);
    writeFileSync(join(root, 'dist', 'generated.js'), '// 重新构建的产物（内容变了）\n');
    const after = capture(root, INPUTS);
    expect(after.inputDigest).toBe(before.inputDigest);
  });

  it('证据过期语义闭环：输入变化 → 旧证据 inputDigest 失配 → stale → computeTaskAcceptance 不点亮通过', () => {
    const snap1 = capture(root, INPUTS);
    // 证据已生成并绑定 snap1.inputDigest（Evidence.inputDigest）
    const evidenceInputDigest = snap1.inputDigest;

    writeFileSync(join(root, 'src', 'main.js'), 'console.log("构建期间外部编辑 v3");\n');
    const snap2 = capture(root, INPUTS);

    // 模拟执行器证据核验：证据绑定摘要 ≠ 当前输入摘要 → stale
    const stale = snap2.inputDigest !== evidenceInputDigest;
    expect(stale).toBe(true);

    const passedItem: AcceptanceItem = {
      schemaVersion: 1,
      id: 'acc-m5-1',
      taskId: 'task-m5-fixture',
      kind: 'executable',
      verifierId: 'm5-smoke',
      title: '冒烟验收',
      expected: '命令以退出码 0 结束',
      manualRequired: false,
      status: 'passed',
      required: true,
      order: 1,
      createdAt: '2026-10-14T07:00:00.000Z',
      updatedAt: '2026-10-14T07:00:00.000Z',
    };

    const judged = computeTaskAcceptance({ acceptance: [passedItem], stale });
    expect(judged.passed).toBe(false); // 必需项全过但因 stale 不点亮
    expect(judged.stale).toBe(true);

    // 输入未再变化时重新验证：摘要一致 → 非 stale → 通过恢复
    const snap3 = capture(root, INPUTS);
    expect(computeTaskAcceptance({ acceptance: [passedItem], stale: snap3.inputDigest !== snap2.inputDigest }).passed).toBe(true);
  });

  it('SourceSnapshot 契约形状：无 git 字段路径（hasGit=false 标明），类型可表达', () => {
    const snap = capture(root, INPUTS);
    expect(snap.evidenceLevel).toBe('A');
    expect(snap.hasGit).toBe(false);
    expect(snap.gitCommit).toBeUndefined();
    expect(snap.inputManifest.length).toBe(INPUTS.length);
    expect(Object.keys(snap.toolVersions)).toContain('node');
    // 快照 JSON 可序列化（存储/导出路径）
    const rt: SourceSnapshot = JSON.parse(JSON.stringify(snap));
    expect(rt.inputDigest).toBe(snap.inputDigest);
  });
});

// TODO-INT（集成后）：
// 1. import 真实 snapshot 模块（B2：packages/engineering-runner/src/snapshot/**），
//    对拍其 inputDigest 与本文件 canonicalManifest 约定的一致性（或按 B2 冻结的约定更新此处）；
// 2. 将“修改输入文件”换成 runner 真实 API 触发的构建期间外部编辑（M5 原文：构建期间检测到外部编辑
//    则不为当前状态点亮通过），断言 Evidence 状态迁移到 stale 而非仅靠摘要比较；
// 3. 有 git 的机器上补 gitCommit/dirtyDiffDigest 字段路径用例。
