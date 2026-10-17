// M7 must 场景（fixture 级）；集成状态：TODO-INT
// （B2 的 requestKey 规范化实现未交付前：先固化“键构造约定”并以内存注册表 fixture 验证幂等语义——
//   重复 requestKey 返回原操作、不重复发起相同副作用、同键不同参判冲突；
//   B2 交付后把 buildRequestKey/canonicalJson 替换为真实规范化实现并对拍。
//   contracts 层（RequestKeySchema、Operation.argsDigest 类型表达）现在就真实运行。）
//
// 场景（任务书 §15.2 M7）：连续点击与重复 requestKey → 返回原操作/状态，不重复发起相同副作用。

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import { newId } from '../../../contracts/src/common.ts';
import type { Operation, OperationType } from '../../../contracts/src/engineering.ts';
import { RequestKeySchema } from '../../../contracts/src/mcp-tools.ts';

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/** requestKey 构造约定（TODO-INT 集成点，与 B2 规范化实现对齐）：
 *  requestKey = sha256(canonicalJson({ generation, caller, businessKey }))
 *  - generation：引擎/执行器连接代次（重启后旧键不复用）
 *  - caller：调用方（'gui' | 'mcp'）
 *  - businessKey：业务键（taskId+工具名+参数语义等） */
type Caller = 'gui' | 'mcp';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function buildRequestKey(generation: number, caller: Caller, businessKey: string): string {
  return sha256Hex(canonicalJson({ generation, caller, businessKey }));
}

/** argsDigest 构造约定：sha256(canonicalJson(args))——同键必须同参的参数摘要 */
function buildArgsDigest(args: unknown): string {
  return sha256Hex(canonicalJson(args));
}

/** 执行器幂等语义的内存 fixture（TODO-INT：替换为 B2 OperationStore/ops 实现） */
type SubmitSpec = {
  requestKey: string;
  argsDigest: string;
  type: OperationType;
  taskId: string;
};
type SubmitResult =
  | { status: 'created'; op: Operation }
  | { status: 'duplicate'; op: Operation }
  | { status: 'conflict'; existing: Operation };

class OperationRegistryFixture {
  private byKey = new Map<string, Operation>();
  /** 已发起副作用次数（创建才计 1；重复请求不重复发起） */
  readonly effects = { count: 0 };

  submit(spec: SubmitSpec): SubmitResult {
    const existing = this.byKey.get(spec.requestKey);
    if (existing) {
      if (existing.argsDigest !== spec.argsDigest) {
        return { status: 'conflict', existing }; // 同键不同参：拒绝，防止偷换参数
      }
      return { status: 'duplicate', op: existing }; // 幂等：返回原操作
    }
    const op: Operation = {
      schemaVersion: 1,
      id: newId('op'),
      requestKey: spec.requestKey,
      type: spec.type,
      taskId: spec.taskId,
      argsDigest: spec.argsDigest,
      status: 'prepared',
      createdAt: new Date().toISOString(),
    };
    this.byKey.set(spec.requestKey, op);
    this.effects.count += 1;
    return { status: 'created', op };
  }
}

describe('M7 requestKey 幂等（fixture 级）——键构造约定', () => {
  it('相同输入（代次/调用方/业务键）→ 相同 requestKey（确定性）', () => {
    const a = buildRequestKey(1, 'gui', 'task-1|device.flash|art-1');
    const b = buildRequestKey(1, 'gui', 'task-1|device.flash|art-1');
    expect(b).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('业务键 / 调用方 / 连接代次任一变化 → requestKey 变化', () => {
    const base = buildRequestKey(1, 'gui', 'task-1|device.flash|art-1');
    expect(buildRequestKey(1, 'gui', 'task-2|device.flash|art-1')).not.toBe(base); // 业务键变化
    expect(buildRequestKey(1, 'mcp', 'task-1|device.flash|art-1')).not.toBe(base); // 调用方变化（GUI 与 MCP 不互相命中）
    expect(buildRequestKey(2, 'gui', 'task-1|device.flash|art-1')).not.toBe(base); // 代次变化（引擎重启后旧键不复用）
  });

  it('requestKey 满足 contracts RequestKeySchema（8~200 字符）', () => {
    const key = buildRequestKey(3, 'mcp', 'task-x|engineering.test|verifier-1');
    expect(RequestKeySchema.safeParse(key).success).toBe(true);
    // 人工构造的合规键同样可表达
    expect(RequestKeySchema.safeParse('rk-12345678').success).toBe(true);
  });

  it('argsDigest：参数键序不同/undefined 缺省等价；不同参数不同摘要；为合法 sha256', () => {
    const d1 = buildArgsDigest({ verifierId: 'v1', artifactId: 'art-1' });
    const d2 = buildArgsDigest({ artifactId: 'art-1', verifierId: 'v1' }); // 键序不同
    const d3 = buildArgsDigest({ verifierId: 'v1', artifactId: 'art-1', extra: undefined });
    expect(d2).toBe(d1);
    expect(d3).toBe(d1);
    expect(buildArgsDigest({ verifierId: 'v1', artifactId: 'art-2' })).not.toBe(d1);
    expect(d1).toMatch(/^[0-9a-f]{64}$/);

    // contracts Operation 类型可表达（round-trip）
    const op: Operation = {
      schemaVersion: 1,
      id: newId('op'),
      requestKey: buildRequestKey(1, 'gui', 'task-1|engineering.test|v1'),
      type: 'test',
      taskId: 'task-1',
      argsDigest: d1,
      status: 'succeeded',
      createdAt: new Date().toISOString(),
    };
    const rt: Operation = JSON.parse(JSON.stringify(op));
    expect(rt.requestKey).toBe(op.requestKey);
    expect(rt.argsDigest).toBe(d1);
  });
});

describe('M7 requestKey 幂等（fixture 级）——重复请求返回原操作', () => {
  it('连续点击（同键同参提交两次）→ 只创建一次操作、副作用只发起一次', () => {
    const registry = new OperationRegistryFixture();
    const key = buildRequestKey(1, 'gui', 'task-1|device.flash|art-1');
    const digest = buildArgsDigest({ taskId: 'task-1', artifactId: 'art-1', deviceBindingId: 'dev-1' });

    const first = registry.submit({ requestKey: key, argsDigest: digest, type: 'device_flash', taskId: 'task-1' });
    const second = registry.submit({ requestKey: key, argsDigest: digest, type: 'device_flash', taskId: 'task-1' });

    expect(first.status).toBe('created');
    expect(second.status).toBe('duplicate');
    if (second.status === 'duplicate') {
      expect(second.op.id).toBe(first.status === 'created' ? first.op.id : '');
    }
    expect(registry.effects.count).toBe(1); // 不重复发起相同副作用
  });

  it('MCP 与 GUI 各自发起（同业务内容）→ 键不同 → 两个独立操作', () => {
    const registry = new OperationRegistryFixture();
    const businessKey = 'task-1|engineering.test|verifier-1';
    const digest = buildArgsDigest({ verifierId: 'verifier-1' });
    const guiKey = buildRequestKey(1, 'gui', businessKey);
    const mcpKey = buildRequestKey(1, 'mcp', businessKey);

    const a = registry.submit({ requestKey: guiKey, argsDigest: digest, type: 'test', taskId: 'task-1' });
    const b = registry.submit({ requestKey: mcpKey, argsDigest: digest, type: 'test', taskId: 'task-1' });

    expect(a.status).toBe('created');
    expect(b.status).toBe('created');
    expect(registry.effects.count).toBe(2); // 不同键：两次真实调用（防误吞）
  });

  it('同键不同参（argsDigest 不一致）→ 冲突拒绝，不覆盖原操作', () => {
    const registry = new OperationRegistryFixture();
    const key = buildRequestKey(1, 'gui', 'task-1|device.flash|art-1');
    const first = registry.submit({
      requestKey: key,
      argsDigest: buildArgsDigest({ artifactId: 'art-1' }),
      type: 'device_flash',
      taskId: 'task-1',
    });
    const hijack = registry.submit({
      requestKey: key,
      argsDigest: buildArgsDigest({ artifactId: 'art-EVIL' }),
      type: 'device_flash',
      taskId: 'task-1',
    });

    expect(first.status).toBe('created');
    expect(hijack.status).toBe('conflict');
    expect(registry.effects.count).toBe(1);
  });

  it('连接代次变化后重复旧键 → 不命中旧操作（不会把旧批准/旧操作重放到新连接）', () => {
    const registry = new OperationRegistryFixture();
    const businessKey = 'task-1|device.flash|art-1';
    const digest = buildArgsDigest({ artifactId: 'art-1' });
    const gen1 = buildRequestKey(1, 'gui', businessKey);
    const gen2 = buildRequestKey(2, 'gui', businessKey);

    registry.submit({ requestKey: gen1, argsDigest: digest, type: 'device_flash', taskId: 'task-1' });
    const replay = registry.submit({ requestKey: gen2, argsDigest: digest, type: 'device_flash', taskId: 'task-1' });

    expect(replay.status).toBe('created'); // 新代次是新操作，不是旧操作的“重放”
    expect(registry.effects.count).toBe(2);
  });
});

// TODO-INT（集成后）：
// 1. 用 B2 的真实 requestKey 规范化实现替换 buildRequestKey/canonicalJson，并对拍：约定键与实现键一致，
//    或在此处固化差异（差异需集成负责人确认哪边为准）；
// 2. 经 runner 控制协议连续 POST /api/ops/device-flash（同 requestKey）断言返回同一 operationId
//    与操作状态，而非新副作用；
// 3. T2 实机开放后补充烧录去重实机用例（M7 的 T2 部分）。

// ---------------------------------------------------------------------------
// 集成版（待集成执行；依赖：Agent B2 的 runner HTTP 服务 createRunnerService —— 未交付时自动 skip）
// B2 交付后 skip 解除，本块经真实 runner 服务验证：同 requestKey 连发两次 build →
//   两次返回同一 operationId；副作用计数=1（GET /api/tasks/:id/operations 恰有一条 build 操作）。
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

describe.skipIf(!runnerService?.createRunnerService)('M7 requestKey 幂等（集成版：真实 runner 服务）', () => {
  it('同 requestKey 连发两次 build → 两次返回同 operationId、副作用计数=1', async () => {
    // 真实流程（按 B2 交付签名）：createRunnerService({dataDir}) → discovery 读端口 → POST /api/tasks（临时工程）→
    //   相同 requestKey 连续两次 POST /api/ops/build（body 相同）→ 两次 operationId 相同 →
    //   GET /api/tasks/:id/operations 中 build 操作恰 1 条（副作用只发起一次）→
    //   对照组：不同 requestKey → 新操作、计数+1。
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync: readText } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dataDir = mkdtempSync(join(tmpdir(), 'forgedesk-m7-int-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'forgedesk-m7-proj-'));
    writeFileSync(join(projectRoot, 'main.js'), 'console.log("m7");\n');
    const profileDir = join(dataDir, 'profiles');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, 'm7-int.profile.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'm7-int',
        revision: 1,
        title: 'M7 集成临时工程',
        kind: 'software',
        build: { exe: 'node', args: ['-e', 'require("node:fs").appendFileSync("count.txt","1\\n")'], timeoutMs: 30000 },
        artifactsGlob: ['count.txt'],
        verifiers: [],
        inputIncludes: ['main.js'],
        inputExcludes: ['count.txt'],
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

      const task = await post('/api/tasks', { projectRoot, profileId: 'm7-int', title: 'M7 集成' });
      const body = { taskId: task.id, profileRevision: 1, requestKey: 'm7-int-build-key-001' };
      const first = await post('/api/ops/build?wait=true', body);
      const second = await post('/api/ops/build?wait=true', body);
      expect(second.operationId).toBe(first.operationId);
      expect(first.result?.ok).toBe(true);
      expect(second.result?.ok).toBe(true);
      // 副作用计数：build 命令追加 count.txt 一行（幂等 → 恰 1 行）
      const ops = await get(`/api/tasks/${task.id}/operations`);
      expect(ops.filter((o: any) => o.type === 'build')).toHaveLength(1);
      expect(readText(join(projectRoot, 'count.txt'), 'utf8').trim().split('\n')).toHaveLength(1);

      // 对照组：不同 requestKey → 新操作、副作用 +1
      const third = await post('/api/ops/build?wait=true', { ...body, requestKey: 'm7-int-build-key-002' });
      expect(third.operationId).not.toBe(first.operationId);
      const ops2 = await get(`/api/tasks/${task.id}/operations`);
      expect(ops2.filter((o: any) => o.type === 'build')).toHaveLength(2);
      expect(readText(join(projectRoot, 'count.txt'), 'utf8').trim().split('\n')).toHaveLength(2);
      await service.close?.();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

if (!runnerService?.createRunnerService) {
  it('【依赖状态记录】B2 createRunnerService 未交付，集成版用例已跳过', () => {
    console.log(`[M7-INT] runner 服务模块加载失败（预期，待 B2 交付）：${runnerImportError.slice(0, 200)}`);
    expect(runnerImportError.length).toBeGreaterThan(0);
  });
}
