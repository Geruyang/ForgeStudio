// M5 must 场景（分两层；依赖标注见下）。
//
// 场景（任务书 §15.2 M5）：A级输入与证据过期——未提交/未跟踪/配置变化可识别；
// 构建期间检测到外部编辑则不为当前状态点亮通过。
//
// 【A 层：真实现，现在即可运行】依赖 Agent B2 的 src/snapshot/source-snapshot.ts（已交付）：
//   临时工程 → 真实 build 通过 → 修改输入文件 → 同任务再次采集快照 →
//   inputDigest 变化 + 证据绑定摘要失配 → computeTaskAcceptance stale 不点亮。
// 【B 层：待集成执行】依赖 Agent B2 的 runner HTTP 服务（createRunnerService / src/index.ts，未交付）：
//   同任务再 inspect/build → GET /api/tasks/:id 断言 hasStaleEvidence=true（证据过期而非点亮）。
//   B2 服务层交付后本 describe 自动解除 skip（动态 import 失败时记录错误信息并跳过）。

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeTaskAcceptance } from '../../../contracts/src/engineering.ts';
import type { AcceptanceItem, SourceSnapshot } from '../../../contracts/src/engineering.ts';
import { EngineeringProfileSchema } from '../../../contracts/src/profile.ts';
import { captureSourceSnapshot } from '../../src/snapshot/source-snapshot.ts';

// ---------------------------------------------------------------------------
// B 层依赖探测（B2 createRunnerService 未交付前 import 失败 → 记录并 skip）
// ---------------------------------------------------------------------------

type RunnerServiceModule = {
  createRunnerService?: (options: { dataDir: string }) => Promise<{
    close?: () => Promise<void>;
    stop?: () => Promise<void>;
    dispose?: () => Promise<void>;
  }>;
};
let runnerService: RunnerServiceModule | null = null;
let runnerImportError = '';
try {
  runnerService = (await import('../../src/index.ts')) as RunnerServiceModule;
  if (typeof runnerService.createRunnerService !== 'function') {
    runnerImportError = 'src/index.ts 已存在但未导出 createRunnerService（B2 服务层未交付）';
  }
} catch (error) {
  runnerImportError = String(error);
}

// ---------------------------------------------------------------------------
// A 层：临时工程 + B2 真实快照模块
// ---------------------------------------------------------------------------

let projectRoot: string;
let profileRaw: Record<string, unknown>;

const PROFILE = {
  schemaVersion: 1,
  id: 'm5-evidence-stale',
  revision: 1,
  title: 'M5 证据过期临时工程',
  kind: 'software',
  build: { exe: 'node', args: ['-e', 'require("node:fs").writeFileSync("build/out.txt","ok")'], timeoutMs: 30000 },
  artifactsGlob: ['build/out.txt'],
  verifiers: [
    {
      verifierId: 'm5-smoke',
      title: '冒烟验收',
      command: { exe: 'node', args: ['--version'], timeoutMs: 30000 },
      passExitCode: 0,
    },
  ],
  inputIncludes: ['project.profile.json'],
  inputExcludes: ['build/**'],
};

async function capture(): Promise<SourceSnapshot> {
  return captureSourceSnapshot({
    taskId: 'task-m5-evidence-stale',
    projectRoot,
    profile: EngineeringProfileSchema.parse(profileRaw),
  });
}

describe('M5 A级输入指纹与证据过期（A 层：B2 snapshot 真实现）', () => {
  beforeAll(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'forgedesk-m5-evstale-'));
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    mkdirSync(join(projectRoot, 'build'), { recursive: true });
    writeFileSync(join(projectRoot, 'src', 'main.js'), 'console.log("v1");\n');
    writeFileSync(join(projectRoot, 'build', 'out.txt'), '');
    profileRaw = { ...PROFILE };
    writeFileSync(join(projectRoot, 'project.profile.json'), JSON.stringify(profileRaw, null, 2));
  });

  afterAll(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('临时工程构建通过（真实执行 build 命令，退出码 0 + artifactsGlob 命中）', () => {
    const r = spawnSync(PROFILE.build.exe, PROFILE.build.args, { cwd: projectRoot, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const out = spawnSync('node', ['-e', 'process.stdout.write(require("node:fs").readFileSync("build/out.txt","utf8"))'], { cwd: projectRoot, encoding: 'utf8' });
    expect(out.stdout).toBe('ok');
  });

  it('未变化时两次采集 inputDigest 一致（确定性）', async () => {
    const a = await capture();
    const b = await capture();
    expect(b.inputDigest).toBe(a.inputDigest);
  });

  it('修改输入文件 → 同任务再采集：inputDigest 变化且该文件摘要变化（输入变化可识别）', async () => {
    const before = await capture();
    // 构建期间外部编辑（M5 原文场景）
    writeFileSync(join(projectRoot, 'src', 'main.js'), 'console.log("v2 构建期间被外部编辑");\n');
    const after = await capture();

    expect(after.inputDigest).not.toBe(before.inputDigest);
    const beforeMain = before.inputManifest.find((m) => m.path === 'src/main.js');
    const afterMain = after.inputManifest.find((m) => m.path === 'src/main.js');
    expect(afterMain?.sha256).not.toBe(beforeMain?.sha256);
  });

  it('证据过期闭环：旧证据 inputDigest 失配 → stale → 必需项全过也不点亮通过', async () => {
    // 证据在输入修改前生成并绑定当时的 inputDigest（Evidence.inputDigest）
    writeFileSync(join(projectRoot, 'src', 'main.js'), 'console.log("v3");\n');
    const snapEvidence = await capture();
    const evidenceInputDigest = snapEvidence.inputDigest;

    // 之后输入再次变化（证据未重新生成）
    writeFileSync(join(projectRoot, 'src', 'main.js'), 'console.log("v4 输入又变了");\n');
    const current = await capture();
    const stale = current.inputDigest !== evidenceInputDigest;
    expect(stale).toBe(true);

    const passedItem: AcceptanceItem = {
      schemaVersion: 1,
      id: 'acc-m5-evstale-1',
      taskId: 'task-m5-evidence-stale',
      kind: 'executable',
      verifierId: 'm5-smoke',
      title: '冒烟验收',
      expected: '退出码 0',
      manualRequired: false,
      status: 'passed',
      required: true,
      order: 1,
      createdAt: '2026-10-14T07:00:00.000Z',
      updatedAt: '2026-10-14T07:00:00.000Z',
    };
    const judged = computeTaskAcceptance({ acceptance: [passedItem], stale });
    expect(judged.passed).toBe(false);
    expect(judged.stale).toBe(true);
  });

  it('重新验证后 stale 解除：输入不再变化时摘要一致 → 通过恢复', async () => {
    const a = await capture();
    const staleAfter = (await capture()).inputDigest !== a.inputDigest;
    expect(computeTaskAcceptance({
      acceptance: [
        {
          schemaVersion: 1,
          id: 'acc-m5-evstale-2',
          taskId: 'task-m5-evidence-stale',
          kind: 'executable',
          verifierId: 'm5-smoke',
          title: '冒烟验收',
          expected: '退出码 0',
          manualRequired: false,
          status: 'passed',
          required: true,
          order: 1,
          createdAt: '2026-10-14T07:00:00.000Z',
          updatedAt: '2026-10-14T07:00:00.000Z',
        },
      ],
      stale: staleAfter,
    }).passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B 层：待集成执行（B2 createRunnerService / HTTP 服务交付后自动解除 skip）
// ---------------------------------------------------------------------------

describe.skipIf(!runnerService?.createRunnerService)('M5 hasStaleEvidence（B 层：runner 服务真实现）', () => {
  it('同任务 build 过 → 修改输入 → 再 inspect → GET /api/tasks/:id 断言 hasStaleEvidence=true 而非点亮', async () => {
    // 真实流程（按 B2 交付签名）：createRunnerService({dataDir}) → discovery 读端口 →
    //   POST /api/tasks → build（过）→ test（点亮）→ 修改输入 → GET /api/tasks/:id：
    //   hasStaleEvidence === true 且通过项呈现 stale（不点亮通过）。
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync: readText } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dataDir = mkdtempSync(join(tmpdir(), 'forgedesk-m5-int-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'forgedesk-m5-proj-'));
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'src', 'main.js'), 'console.log("v1");\n');
    const profileDir = join(dataDir, 'profiles');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, 'm5-int.profile.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'm5-int',
        revision: 1,
        title: 'M5 集成临时工程',
        kind: 'software',
        build: { exe: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 30000 },
        artifactsGlob: ['no-artifact.never'],
        verifiers: [{ verifierId: 'm5-smoke', title: '冒烟', command: { exe: 'node', args: ['--version'], timeoutMs: 30000 } }],
        inputIncludes: ['src/main.js'],
        inputExcludes: [],
      }),
      'utf8',
    );
    try {
      const service = await runnerService!.createRunnerService!({ dataDir });
      const discovery = JSON.parse(readText(join(dataDir, 'runner-discovery.json'), 'utf8'));
      const base = `http://127.0.0.1:${discovery.port}`;
      const auth = { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json' };
      const post = async (path: string, body: unknown): Promise<any> =>
        (await fetch(`${base}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) })).json();
      const get = async (path: string): Promise<any> => (await fetch(`${base}${path}`, { headers: auth })).json();

      const task = await post('/api/tasks', {
        projectRoot,
        profileId: 'm5-int',
        title: 'M5 集成',
        acceptance: [{ kind: 'executable', verifierId: 'm5-smoke', title: '冒烟', expected: '退出码 0', manualRequired: false, required: true }],
      });
      // 验收先真实通过（build 不需要产物成功——此处直接跑 verifier 点亮）
      const test1 = await post('/api/ops/test?wait=true', { taskId: task.id, verifierId: 'm5-smoke' });
      expect(test1.result?.result).toBe('passed');
      let overview = await get(`/api/tasks/${task.id}`);
      expect(overview.hasStaleEvidence).toBe(false);
      expect(overview.acceptance[0].status).toBe('passed');

      // 构建期间外部编辑：修改输入文件 → 指纹失配
      writeFileSync(join(projectRoot, 'src', 'main.js'), 'console.log("v2 构建期间被外部编辑");\n');
      await post('/api/ops/inspect?wait=true', { taskId: task.id, profileId: 'm5-int' });
      overview = await get(`/api/tasks/${task.id}`);
      expect(overview.hasStaleEvidence).toBe(true);
      // 通过项不点亮：概览呈现 stale（存储保留原状态，重验后恢复）
      expect(['stale', 'passed']).toContain(overview.acceptance[0].status);
      expect(overview.acceptance[0].status).toBe('stale');
      await service.close?.();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

if (!runnerService?.createRunnerService) {
  it('【依赖状态记录】B2 createRunnerService 未交付，B 层用例已跳过', () => {
    console.log(`[M5-B] runner 服务模块加载失败（预期，待 B2 交付）：${runnerImportError.slice(0, 200)}`);
    expect(runnerImportError.length).toBeGreaterThan(0);
  });
}

// TODO-INT（B2 交付后）：
// 1. 按 B2 实际的 createRunnerService 签名与发现机制（FD_RUNNER_DATA_DIR/runner-discovery.json）补全
//    B 层用例：POST /api/tasks → POST /api/ops/build（过）→ 修改输入 → POST /api/ops/inspect →
//    GET /api/tasks/:id 断言 hasStaleEvidence === true 且 acceptance 不点亮（status 变 stale）；
// 2. 构建期间外部编辑场景走 runner 真实构建流程（A 层此处以"再采集"近似）。
