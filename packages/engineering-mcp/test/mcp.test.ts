// MCP 服务测试：initialize 握手、tools/list 七工具 JSON Schema 与 zod 双向对齐、
// tools/call 端到端（真起 in-process runner service）、桥接重试与失败不崩进程。
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { PassThrough } from 'node:stream';
import { promises as fsp } from 'node:fs';
import { ENGINEERING_TOOLS, MCP_SERVER_INSTRUCTIONS, type EngineeringToolName } from '@forgedesk/contracts/mcp';
import * as contractSchemas from '@forgedesk/contracts/mcp';
import { z } from 'zod';
import { createMcpServer, MCP_SERVER_NAME } from '../src/server.ts';
import { attachStdio } from '../src/stdio.ts';
import { RunnerBridge } from '../src/bridge.ts';
import { MCP_TOOLS } from '../src/tools.ts';
// 端到端：in-process runner service（工程执行器同仓 workspace，测试用相对导入）
import { createRunnerService, type RunnerService } from '../../engineering-runner/src/index-service.ts';

const cleanups: string[] = [];
const services: RunnerService[] = [];
afterAll(async () => {
  for (const s of services) await s.close();
  for (const d of cleanups) await fsp.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

// ---------------------------------------------------------------------------
// 双向对齐：手写 JSON Schema vs 契约 zod schema（抽样实例双向校验）
// ---------------------------------------------------------------------------

/** 迷你 JSON Schema 校验器（覆盖本包手写 schema 用到的子集：type/required/properties/pattern/minimum/minLength/maxLength/enum） */
function validate(schema: unknown, value: unknown, path = '$'): string[] {
  const errors: string[] = [];
  if (typeof schema !== 'object' || schema === null) return errors;
  const s = schema as Record<string, unknown>;
  if (s.type === 'object' && typeof s.properties === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`${path}: 期望 object`);
      return errors;
    }
    const obj = value as Record<string, unknown>;
    for (const key of (s.required as string[] | undefined) ?? []) {
      if (!(key in obj) || obj[key] === undefined) errors.push(`${path}.${key}: 缺少必填字段`);
    }
    for (const [key, sub] of Object.entries(s.properties as Record<string, unknown>)) {
      if (obj[key] !== undefined) errors.push(...validate(sub, obj[key], `${path}.${key}`));
    }
    return errors;
  }
  if (s.type === 'integer' || s.type === 'number') {
    const ok = s.type === 'integer' ? Number.isInteger(value) : typeof value === 'number';
    if (!ok) {
      errors.push(`${path}: 期望 ${String(s.type)}`);
      return errors;
    }
    if (s.minimum !== undefined && (value as number) < (s.minimum as number)) errors.push(`${path}: 小于 minimum`);
    return errors;
  }
  if (s.type === 'string') {
    if (typeof value !== 'string') {
      errors.push(`${path}: 期望 string`);
      return errors;
    }
    if (s.pattern !== undefined && !new RegExp(s.pattern as string).test(value)) errors.push(`${path}: 不匹配 pattern`);
    if (s.minLength !== undefined && value.length < (s.minLength as number)) errors.push(`${path}: 短于 minLength`);
    if (s.maxLength !== undefined && value.length > (s.maxLength as number)) errors.push(`${path}: 长于 maxLength`);
    return errors;
  }
  if (s.type === 'boolean' && typeof value !== 'boolean') errors.push(`${path}: 期望 boolean`);
  return errors;
}

/** 每工具抽样：合法实例（zod 与 JSON Schema 都接受）+ 非法变体（都拒绝） */
const TASK_ID = 'task-3f2c1a5b-8d4e-4f5a-8b6c-2d1e0f9a8b7c';
const SAMPLES: Record<EngineeringToolName, { valid: unknown[]; invalid: unknown[] }> = {
  'engineering.inspect': {
    valid: [{ taskId: TASK_ID, profileId: 'sample-tool' }],
    invalid: [{ profileId: 'x' }, { taskId: 'task-bad', profileId: 'x' }, { taskId: TASK_ID }],
  },
  'engineering.build': {
    // D18 起 profileRevision 可选（模型可不带），缺省合法；非法样本只覆盖缺 taskId 与非法 revision
    valid: [{ taskId: TASK_ID, profileRevision: 3 }, { taskId: TASK_ID }],
    invalid: [{}, { taskId: TASK_ID, profileRevision: -1 }, { taskId: TASK_ID, profileRevision: 1.5 }],
  },
  'engineering.test': {
    valid: [
      { taskId: TASK_ID, verifierId: 'v1' },
      { taskId: TASK_ID, verifierId: 'v1', artifactId: 'art-3f2c1a5b-8d4e-4f5a-8b6c-2d1e0f9a8b7c', requestKey: 'rk-12345678' },
    ],
    invalid: [{ taskId: TASK_ID }, { taskId: TASK_ID, verifierId: 'v1', requestKey: 'short' }],
  },
  'device.bind': {
    valid: [
      {
        taskId: TASK_ID,
        profileId: 'p',
        identity: { usbVid: 1, usbPid: 2 },
        identityEvidence: '丝印核对',
      },
    ],
    invalid: [
      { taskId: TASK_ID, profileId: 'p', identity: { usbVid: 1 }, identityEvidence: 'x' },
      { taskId: TASK_ID, profileId: 'p', identity: { usbVid: -1, usbPid: 2 }, identityEvidence: 'x' },
      { taskId: TASK_ID, profileId: 'p', identity: { usbVid: 1, usbPid: 2 } },
    ],
  },
  'device.flash': {
    valid: [
      {
        taskId: TASK_ID,
        artifactId: 'art-3f2c1a5b-8d4e-4f5a-8b6c-2d1e0f9a8b7c',
        deviceBindingId: 'dev-3f2c1a5b-8d4e-4f5a-8b6c-2d1e0f9a8b7c',
        requestKey: 'rk-12345678',
      },
    ],
    invalid: [
      { taskId: TASK_ID, artifactId: 'art-x', deviceBindingId: 'dev-x', requestKey: 'rk-12345678' },
      { taskId: TASK_ID, artifactId: 'art-3f2c1a5b-8d4e-4f5a-8b6c-2d1e0f9a8b7c', deviceBindingId: 'dev-3f2c1a5b-8d4e-4f5a-8b6c-2d1e0f9a8b7c' },
    ],
  },
  'device.verify': {
    valid: [
      { taskId: TASK_ID, verifierId: 'device:serial', deviceBindingId: 'dev-3f2c1a5b-8d4e-4f5a-8b6c-2d1e0f9a8b7c' },
    ],
    invalid: [{ taskId: TASK_ID, verifierId: 'v' }, { taskId: TASK_ID, deviceBindingId: 'dev-x' }],
  },
  'engineering.export': {
    valid: [{ taskId: TASK_ID }],
    invalid: [{}, { taskId: 'nope' }],
  },
};

const ZOD_SCHEMA: Record<EngineeringToolName, z.ZodTypeAny> = {
  'engineering.inspect': contractSchemas.InspectInputSchema,
  'engineering.build': contractSchemas.BuildInputSchema,
  'engineering.test': contractSchemas.TestInputSchema,
  'device.bind': contractSchemas.DeviceBindInputSchema,
  'device.flash': contractSchemas.DeviceFlashInputSchema,
  'device.verify': contractSchemas.DeviceVerifyInputSchema,
  'engineering.export': contractSchemas.ExportInputSchema,
};

describe('tools/list：七工具与 JSON Schema ↔ zod 双向对齐', () => {
  it('七个工具全部注册（名称冻结）且带 description/inputSchema', () => {
    expect(MCP_TOOLS.map((t) => t.name)).toEqual([...ENGINEERING_TOOLS]);
    for (const tool of MCP_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(4);
      expect(tool.inputSchema.type).toBe('object');
      expect(Array.isArray(tool.inputSchema.required)).toBe(true);
    }
  });

  for (const tool of MCP_TOOLS) {
    describe(`${tool.name} 对齐`, () => {
      const samples = SAMPLES[tool.name];
      for (const [i, sample] of samples.valid.entries()) {
        it(`合法实例 #${i}：zod 与 JSON Schema 都接受`, () => {
          expect(ZOD_SCHEMA[tool.name].safeParse(sample).success).toBe(true);
          expect(validate(tool.inputSchema, sample)).toEqual([]);
        });
      }
      for (const [i, sample] of samples.invalid.entries()) {
        it(`非法实例 #${i}：zod 与 JSON Schema 都拒绝`, () => {
          expect(ZOD_SCHEMA[tool.name].safeParse(sample).success).toBe(false);
          expect(validate(tool.inputSchema, sample).length).toBeGreaterThan(0);
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 协议层：initialize / 未知方法 / 通知静默
// ---------------------------------------------------------------------------

describe('JSON-RPC 协议（内存流）', () => {
  const server = createMcpServer({ bridge: new RunnerBridge({ startupTimeoutMs: 1 }) });

  it('initialize 握手：回显协议版本、capabilities.tools、serverInfo、instructions', async () => {
    const res = await server.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    });
    expect(res?.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: MCP_SERVER_NAME, version: expect.any(String) },
      instructions: MCP_SERVER_INSTRUCTIONS,
    });
    // instructions 前 512 字符自含验收规则说明
    expect(MCP_SERVER_INSTRUCTIONS).toContain('模型自评不点亮验收');
  });

  it('notifications/initialized 不应答；未知方法 -32601；非法消息 -32600', async () => {
    expect(await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const unknown = await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'resources/list' });
    expect(unknown?.error?.code).toBe(-32601);
    const bad = await server.handleMessage('not-an-object');
    expect(bad?.error?.code).toBe(-32600);
  });

  it('tools/call 未知工具 / 参数非法 → -32602', async () => {
    const unknownTool = await server.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope', arguments: {} } });
    expect(unknownTool?.error?.code).toBe(-32602);
    const badArgs = await server.handleMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'engineering.build', arguments: { taskId: 'bad' } },
    });
    expect(badArgs?.error?.code).toBe(-32602);
  });

  it('stdio 挂接：换行 JSON 请求/响应 + 解析错误 -32700', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    attachStdio(server, input, output);
    const lines: string[] = [];
    output.on('data', (chunk: Buffer) => lines.push(...chunk.toString('utf8').split('\n').filter((l) => l.length > 0)));
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' })}\n`);
    input.write('not json\n');
    await new Promise((r) => setTimeout(r, 150));
    expect(lines.some((l) => l.includes('"id":7') && l.includes('"result"'))).toBe(true);
    expect(lines.some((l) => l.includes('-32700'))).toBe(true);
    input.end();
  });
});

// ---------------------------------------------------------------------------
// 端到端：真起 in-process runner service → MCP tools/call 全链路
// ---------------------------------------------------------------------------

describe('tools/call 端到端（in-process runner）', () => {
  let service: RunnerService;
  let bridge: RunnerBridge;
  let server: ReturnType<typeof createMcpServer>;
  let taskId: string;
  const verifierId = 'e2e-smoke';
  const profileId = 'e2e-proj';

  beforeAll(async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'forgedesk-mcp-e2e-'));
    cleanups.push(dir);
    const projectRoot = path.join(dir, 'proj');
    await fsp.mkdir(projectRoot, { recursive: true });
    await fsp.writeFile(path.join(projectRoot, 'main.js'), 'console.log("e2e");\n', 'utf8');
    const profileDir = path.join(dir, 'profiles');
    await fsp.mkdir(profileDir, { recursive: true });
    await fsp.writeFile(
      path.join(profileDir, `${profileId}.profile.json`),
      JSON.stringify({
        schemaVersion: 1,
        id: profileId,
        revision: 1,
        title: 'E2E 工程',
        kind: 'software',
        build: { exe: 'node', args: ['-e', 'require("node:fs").writeFileSync("out.txt","ok")'], timeoutMs: 30000 },
        artifactsGlob: ['out.txt'],
        verifiers: [
          { verifierId, title: '冒烟', command: { exe: 'node', args: ['--version'], timeoutMs: 30000 } },
        ],
        inputIncludes: ['main.js'],
        inputExcludes: ['out.txt'],
      }),
      'utf8',
    );
    service = await createRunnerService({ dataDir: dir, profileDirs: [profileDir] });
    services.push(service);
    // 建任务
    const res = await fetch(`http://127.0.0.1:${service.port}/api/tasks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${service.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectRoot,
        profileId,
        title: 'E2E',
        acceptance: [{ kind: 'executable', verifierId, title: '冒烟', expected: '退出码 0', manualRequired: false, required: true }],
      }),
    });
    taskId = ((await res.json()) as { id: string }).id;
    bridge = new RunnerBridge({ dataDir: dir, startupTimeoutMs: 5_000 });
    server = createMcpServer({ bridge });
  });

  it('发现文件就绪 → tools/list → engineering.inspect 成功（content text JSON）', async () => {
    const list = await server.handleMessage({ jsonrpc: '2.0', id: 10, method: 'tools/list' });
    const tools = (list?.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual([...ENGINEERING_TOOLS]);

    const call = await server.handleMessage({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'engineering.inspect', arguments: { taskId, profileId } },
    });
    const result = call?.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.type).toBe('text');
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.ok).toBe(true);
    expect(parsed.profileId).toBe(profileId);
    expect(Array.isArray(parsed.toolchain)).toBe(true);
  });

  it('engineering.build + engineering.test 全链路（验收由执行器点亮）', async () => {
    const build = await callTool(server, 'engineering.build', { taskId, profileRevision: 1 });
    expect(build.ok).toBe(true);
    expect(build.artifactId).toMatch(/^art-/);
    const test = await callTool(server, 'engineering.test', { taskId, verifierId });
    expect(test.ok).toBe(true);
    expect(test.result).toBe('passed');
  });

  it('工具失败（未知 verifier）→ isError:true + ToolFailure JSON', async () => {
    const res = await server.handleMessage({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: 'engineering.test', arguments: { taskId, verifierId: 'no-such-verifier' } },
    });
    const result = res?.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    const failure = JSON.parse(result.content[0]!.text);
    expect(failure.ok).toBe(false);
    expect(failure.kind).toBe('permission_denied');
    expect(failure.operationId).toMatch(/^op-/);
  });

  it('runner 不可用 → 结构化 connection_failure，不崩进程', async () => {
    const badBridge = new RunnerBridge({ dataDir: 'Z:/definitely/not/exist'.replace(/\//g, '\\'), startupTimeoutMs: 300 });
    const badServer = createMcpServer({ bridge: badBridge });
    const res = await badServer.handleMessage({
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: { name: 'engineering.inspect', arguments: { taskId, profileId } },
    });
    const result = res?.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    const failure = JSON.parse(result.content[0]!.text);
    expect(failure.kind).toBe('connection_failure');
  });

  it('发现文件等待：startup 窗口内就绪（写入延迟后可用）', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'forgedesk-mcp-wait-'));
    cleanups.push(dir);
    const bridge = new RunnerBridge({ dataDir: dir, startupTimeoutMs: 3_000, pollIntervalMs: 100 });
    const discovery = { schemaVersion: 1, port: 1, token: 't', pid: process.pid, startedAt: new Date().toISOString() };
    // 800ms 后写入发现文件 → ensureDiscovery 应等待并命中
    setTimeout(() => {
      void fsp.writeFile(path.join(dir, 'runner-discovery.json'), JSON.stringify(discovery), 'utf8');
    }, 800);
    const found = await bridge.ensureDiscovery();
    expect(found?.port).toBe(1);
  });
});

async function callTool(server: ReturnType<typeof createMcpServer>, name: EngineeringToolName, args: unknown): Promise<any> {
  const res = await server.handleMessage({
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 1e6),
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const result = res?.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text);
}
