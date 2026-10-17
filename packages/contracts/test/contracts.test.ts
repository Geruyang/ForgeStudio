/**
 * 契约级测试（Agent D 所有；现在即可真实运行）。
 * 覆盖：实体样例 round-trip（TS 类型 + 关键 zod schema）、profile schema 对真实 profile 文件的校验、
 * computeTaskAcceptance 判定、requestKey/argsDigest 字符串工具、MCP_SERVER_INSTRUCTIONS 长度（任务书 §6.2）、
 * 验收单模板与 contracts 的兼容性。
 * 运行：`npx vitest run --root packages/contracts --reporter=basic`（仓库根执行）。
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FAILURE_KINDS,
  FAILURE_KIND_LABELS_ZH,
  SCHEMA_VERSION,
  isSha256,
  newId,
} from '../src/common.ts';
import {
  ACCEPTANCE_ITEM_STATUSES,
  ACCEPTANCE_KINDS,
  OPERATION_STATUSES,
  TASK_STATUSES,
  computeTaskAcceptance,
  type AcceptanceItem,
  type Artifact,
  type EngineeringTask,
  type Evidence,
  type Operation,
  type SourceSnapshot,
  type TurnRecord,
} from '../src/engineering.ts';
import {
  EngineeringProfileSchema,
  ProfileCommandSchema,
  SoftwareVerifierSchema,
} from '../src/profile.ts';
import {
  ENGINEERING_TOOLS,
  MCP_SERVER_INSTRUCTIONS,
  RequestKeySchema,
  TaskIdSchema,
  BuildOutputSchema,
  DeviceBindInputSchema,
  DeviceFlashInputSchema,
  DeviceVerifyOutputSchema,
  ExportOutputSchema,
  InspectInputSchema,
  InspectOutputSchema,
  TestOutputSchema,
  ToolFailureSchema,
} from '../src/mcp-tools.ts';
import { RUNNER_EVENT_TYPES, RUNNER_ROUTES, type RunnerDiagnostics, type RunnerEvent } from '../src/runner-api.ts';

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// ---------------------------------------------------------------------------
// 实体样例（TS 类型层 round-trip）
// ---------------------------------------------------------------------------

const task: EngineeringTask = {
  schemaVersion: SCHEMA_VERSION,
  id: newId('task'),
  threadId: 'th-demo-0001',
  turnId: 'turn-demo-0001',
  projectRoot: 'E:\\work\\sample-tool',
  profileId: 'sample-tool',
  profileRevision: 1,
  title: '修复 sample-tool 空输入崩溃',
  status: 'verifying',
  createdAt: '2026-10-14T06:00:00.000Z',
  updatedAt: '2026-10-14T06:05:00.000Z',
  lastFailure: { kind: 'test_failure', message: '固定验收测试失败', logRef: 'logs/ops/op-demo.log' },
};

const acceptanceItem: AcceptanceItem = {
  schemaVersion: SCHEMA_VERSION,
  id: newId('acc'),
  taskId: task.id,
  kind: 'executable',
  verifierId: 'sample-tool-fixed-acceptance',
  title: '固定验收测试通过',
  expected: 'run-tests.mjs 以退出码 0 结束，stdout 含 TESTS_PASSED 且不含 TEST_FAILED',
  manualRequired: false,
  status: 'pending',
  required: true,
  order: 1,
  createdAt: '2026-10-14T06:00:00.000Z',
  updatedAt: '2026-10-14T06:00:00.000Z',
};

const operation: Operation = {
  schemaVersion: SCHEMA_VERSION,
  id: newId('op'),
  requestKey: 'req-demo-key-00000001',
  type: 'test',
  taskId: task.id,
  argsDigest: sha256Hex('{"verifierId":"sample-tool-fixed-acceptance"}'),
  status: 'succeeded',
  createdAt: '2026-10-14T06:01:00.000Z',
  startedAt: '2026-10-14T06:01:01.000Z',
  endedAt: '2026-10-14T06:01:02.000Z',
  resultSummary: 'TESTS_PASSED',
};

const evidence: Evidence = {
  schemaVersion: SCHEMA_VERSION,
  id: newId('ev'),
  operationId: operation.id,
  taskId: task.id,
  acceptanceItemId: acceptanceItem.id,
  inputDigest: sha256Hex('input-manifest-demo'),
  evidenceLevel: 'A',
  toolVersions: { node: 'v24.21.0' },
  result: 'passed',
  detail: { stdoutTail: 'TESTS_PASSED' },
  createdAt: '2026-10-14T06:01:03.000Z',
  logRef: 'evidence/ev-demo.log',
};

const artifact: Artifact = {
  schemaVersion: SCHEMA_VERSION,
  id: newId('art'),
  taskId: task.id,
  type: 'other',
  path: 'E:\\work\\sample-tool\\build-report.json',
  sha256: sha256Hex('build-report-demo'),
  sizeBytes: 2048,
  buildId: 'build-demo-0001',
  sourceSnapshotId: 'snap-demo-0001',
  createdAt: '2026-10-14T06:00:30.000Z',
};

const snapshot: SourceSnapshot = {
  schemaVersion: SCHEMA_VERSION,
  id: newId('snap'),
  taskId: task.id,
  evidenceLevel: 'A',
  hasGit: false,
  inputDigest: sha256Hex('input-manifest-demo'),
  inputManifest: [
    {
      kind: 'profile_config',
      path: 'sample-tool.profile.json',
      sha256: sha256Hex('profile-demo'),
      sizeBytes: 1024,
    },
  ],
  toolVersions: { node: 'v24.21.0' },
  capturedAt: '2026-10-14T06:00:10.000Z',
};

const turnRecord: TurnRecord = {
  schemaVersion: SCHEMA_VERSION,
  id: newId('turn'),
  taskId: task.id,
  threadId: 'th-demo-0001',
  turnId: 'turn-demo-0001',
  connectionGeneration: 1,
  summary: '修复空输入崩溃（第 1 回合）',
  createdAt: '2026-10-14T06:00:01.000Z',
};

describe('实体样例 round-trip（TS 类型 + JSON 序列化）', () => {
  it('七个核心实体样例 JSON round-trip 后仍满足类型并保留关键字段', () => {
    const taskRt: EngineeringTask = JSON.parse(JSON.stringify(task));
    const accRt: AcceptanceItem = JSON.parse(JSON.stringify(acceptanceItem));
    const opRt: Operation = JSON.parse(JSON.stringify(operation));
    const evRt: Evidence = JSON.parse(JSON.stringify(evidence));
    const artRt: Artifact = JSON.parse(JSON.stringify(artifact));
    const snapRt: SourceSnapshot = JSON.parse(JSON.stringify(snapshot));
    const turnRt: TurnRecord = JSON.parse(JSON.stringify(turnRecord));

    expect(taskRt.id).toBe(task.id);
    expect(taskRt.lastFailure?.kind).toBe('test_failure');
    expect(accRt.verifierId).toBe('sample-tool-fixed-acceptance');
    expect(accRt.status).toBe('pending');
    expect(opRt.requestKey).toBe(operation.requestKey);
    expect(opRt.argsDigest).toBe(operation.argsDigest);
    expect(evRt.inputDigest).toBe(evidence.inputDigest);
    expect(evRt.result).toBe('passed');
    expect(artRt.sha256).toBe(artifact.sha256);
    expect(snapRt.hasGit).toBe(false);
    expect(snapRt.inputManifest[0]?.kind).toBe('profile_config');
    expect(turnRt.connectionGeneration).toBe(1);
  });

  it('RunnerDiagnostics / RunnerEvent 样例 round-trip（无凭证字段可表达）', () => {
    const diagnostics: RunnerDiagnostics = {
      schemaVersion: 1,
      runnerVersion: '0.1.0',
      uptimeMs: 123456,
      storagePath: 'C:\\Users\\dev\\AppData\\Roaming\\ForgeDesk\\storage',
      storageOk: true,
      gitAvailable: false,
      probeRsAvailable: false,
      serialPortsAvailable: false,
      pendingAuthorizations: 0,
    };
    const event: RunnerEvent = {
      schemaVersion: 1,
      seq: 1,
      type: 'diagnostics/updated',
      payload: diagnostics,
      emittedAt: '2026-10-14T06:00:00.000Z',
    };
    const diagRt: RunnerDiagnostics = JSON.parse(JSON.stringify(diagnostics));
    const evRt: RunnerEvent = JSON.parse(JSON.stringify(event));
    expect(diagRt.gitAvailable).toBe(false);
    expect(evRt.type).toBe('diagnostics/updated');
    expect(RUNNER_ROUTES.diagnostics).toBe('GET /api/diagnostics');
  });
});

// ---------------------------------------------------------------------------
// 关键 zod schema round-trip（MCP 七工具）
// ---------------------------------------------------------------------------

describe('MCP 工具 schema round-trip', () => {
  it('engineering.inspect 输入/输出', () => {
    const input = InspectInputSchema.parse({ taskId: task.id, profileId: 'sample-tool' });
    expect(input.taskId).toBe(task.id);

    const output = InspectOutputSchema.parse({
      ok: true,
      operationId: operation.id,
      profileId: 'sample-tool',
      profileRevision: 1,
      toolchain: [{ tool: 'node', available: true, version: 'v24.21.0' }],
      missing: [],
      currentSnapshot: { inputDigest: sha256Hex('m'), hasGit: false, capturedAt: '2026-10-14T06:00:00.000Z' },
    });
    expect(output.currentSnapshot?.inputDigest).toBe(sha256Hex('m'));
  });

  it('engineering.build 输出', () => {
    const output = BuildOutputSchema.parse({
      ok: true,
      operationId: operation.id,
      artifactId: artifact.id,
      buildId: 'build-demo-0001',
      artifactType: 'other',
      artifactPath: 'E:\\work\\sample-tool\\build-report.json',
      artifactSha256: sha256Hex('a'),
      logRef: 'evidence/build-demo.log',
      durationMs: 1500,
    });
    expect(output.artifactType).toBe('other');
  });

  it('engineering.test 输出', () => {
    const output = TestOutputSchema.parse({
      ok: true,
      operationId: operation.id,
      evidenceId: evidence.id,
      result: 'failed',
      detail: { stdoutTail: 'TEST_FAILED 用例失败: T1, T2' },
      logRef: 'evidence/test-demo.log',
    });
    expect(output.result).toBe('failed');
  });

  it('device.bind / device.flash / device.verify / engineering.export', () => {
    const bind = DeviceBindInputSchema.parse({
      taskId: task.id,
      profileId: 'example-embedded-stm32',
      identity: { usbVid: 0x0483, usbPid: 0x3748, probeSerial: 'STM32DEMO0001' },
      identityEvidence: '用户在 GUI 确认 VID/PID 与序列号（首次绑定人工确认）',
    });
    expect(bind.identity.usbVid).toBe(0x0483);

    const flash = DeviceFlashInputSchema.parse({
      taskId: task.id,
      artifactId: artifact.id,
      deviceBindingId: newId('dev'),
      requestKey: 'req-flash-demo-0001',
    });
    expect(flash.requestKey.length).toBeGreaterThanOrEqual(8);

    const verify = DeviceVerifyOutputSchema.parse({
      ok: true,
      operationId: operation.id,
      evidenceId: evidence.id,
      result: 'passed',
      nonceMatch: true,
      buildIdMatch: true,
      buildId: 'build-demo-0001',
      responsePreview: 'BUILDID:build-demo-0001',
      logRef: 'evidence/verify-demo.log',
    });
    expect(verify.buildIdMatch).toBe(true);

    const exp = ExportOutputSchema.parse({
      ok: true,
      operationId: operation.id,
      bundlePath: 'E:\\work\\exports\\task-demo.zip',
      manifest: { schemaVersion: 1 },
    });
    expect(exp.bundlePath.endsWith('.zip')).toBe(true);
  });

  it('工具失败返回与 ID schema 的拒绝路径', () => {
    const failure = ToolFailureSchema.parse({
      ok: false,
      kind: 'environment_missing',
      message: '未安装 probe-rs',
    });
    expect(failure.ok).toBe(false);

    expect(TaskIdSchema.safeParse('task-123').success).toBe(false);
    expect(TaskIdSchema.safeParse(task.id).success).toBe(true);
    expect(TaskIdSchema.safeParse(newId('task')).success).toBe(true);
  });

  it('MCP_SERVER_INSTRUCTIONS ≤512 字符且自含关键语义（任务书 §6.2）；工具名冻结 7 个', () => {
    expect(MCP_SERVER_INSTRUCTIONS.length).toBeGreaterThan(0);
    expect(MCP_SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(512);
    expect(MCP_SERVER_INSTRUCTIONS).toContain('执行器');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('授权');
    expect(ENGINEERING_TOOLS).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// Profile schema 对真实文件的校验
// ---------------------------------------------------------------------------

describe('EngineeringProfileSchema 对真实 profile 文件校验', () => {
  const profileFiles = [
    join(repoRoot, 'engineering', 'profiles', 'forgedesk-self.profile.json'),
    join(repoRoot, 'engineering', 'fixtures', 'software', 'sample-tool', 'sample-tool.profile.json'),
    join(repoRoot, 'engineering', 'fixtures', 'sample-tool', 'forgedesk.profile.json'),
  ];

  for (const file of profileFiles) {
    it(`解析通过：${file.replace(repoRoot + '\\', '')}`, () => {
      const parsed = EngineeringProfileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.kind).toBe('software');
      expect(parsed.verifiers.length).toBeGreaterThan(0);
      for (const v of parsed.verifiers) {
        expect(v.command.exe.length).toBeGreaterThan(0);
        expect(v.command.timeoutMs).toBeGreaterThan(0);
      }
    });
  }

  it('sample-tool verifier 判定规则：passExitCode=0，MustContain TESTS_PASSED，MustNotContain TEST_FAILED', () => {
    const parsed = EngineeringProfileSchema.parse(
      JSON.parse(readFileSync(profileFiles[1]!, 'utf8')),
    );
    const verifier = parsed.verifiers.find((v) => v.verifierId === 'sample-tool-fixed-acceptance');
    expect(verifier).toBeDefined();
    expect(verifier?.passExitCode).toBe(0);
    expect(verifier?.stdoutMustContain).toContain('TESTS_PASSED');
    expect(verifier?.stdoutMustNotContain).toContain('TEST_FAILED');
  });

  it('sample-tool(wordcount) verifier 语义：normal 判 0 退出；empty-crash-repro 判非 0（缺陷复现器）', () => {
    const parsed = EngineeringProfileSchema.parse(
      JSON.parse(readFileSync(profileFiles[2]!, 'utf8')),
    );
    expect(parsed.id).toBe('sample-tool-wordcount');
    const normal = parsed.verifiers.find((v) => v.verifierId === 'wordcount-normal');
    expect(normal?.passExitCode).toBe(0);
    expect(normal?.stdoutMustContain).toContain('words=12');
    expect(normal?.stdoutMustNotContain).toContain('TypeError');

    const repro = parsed.verifiers.find((v) => v.verifierId === 'wordcount-empty-crash-repro');
    expect(repro?.passExitCode).toBe(1); // 非 0 退出 = 复现成功（缺陷仍在）
    expect(repro?.stdoutMustNotContain).toContain('words=0'); // 修复后输出 words=0 时本 verifier 失败
  });

  it('非法 profile 被拒绝（id 格式 / 缺 artifactsGlob）', () => {
    const base = JSON.parse(readFileSync(profileFiles[1]!, 'utf8'));
    expect(EngineeringProfileSchema.safeParse({ ...base, id: 'Bad ID' }).success).toBe(false);
    const { artifactsGlob: _drop, ...withoutGlob } = base;
    expect(EngineeringProfileSchema.safeParse(withoutGlob).success).toBe(false);
  });

  it('ProfileCommandSchema / SoftwareVerifierSchema 默认值与拒绝', () => {
    const cmd = ProfileCommandSchema.parse({ exe: 'node', args: ['run-tests.mjs'], timeoutMs: 60000 });
    expect(cmd.args).toEqual(['run-tests.mjs']);

    const verifier = SoftwareVerifierSchema.parse({
      verifierId: 'v1',
      title: 't',
      command: { exe: 'node', args: [], timeoutMs: 1000 },
    });
    expect(verifier.passExitCode).toBe(0);
    expect(verifier.stdoutMustContain).toEqual([]);
    expect(verifier.stdoutMustNotContain).toEqual([]);

    expect(ProfileCommandSchema.safeParse({ exe: 'node', args: [] }).success).toBe(false); // 缺 timeoutMs
    expect(
      SoftwareVerifierSchema.safeParse({ verifierId: 'v1', title: 't' }).success,
    ).toBe(false); // 缺 command
  });
});

// ---------------------------------------------------------------------------
// computeTaskAcceptance 单元判定（验收唯一入口）
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<AcceptanceItem>): AcceptanceItem {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId('acc'),
    taskId: task.id,
    kind: 'executable',
    title: '项',
    expected: '预期',
    manualRequired: false,
    status: 'pending',
    required: true,
    order: 1,
    createdAt: '2026-10-14T06:00:00.000Z',
    updatedAt: '2026-10-14T06:00:00.000Z',
    ...overrides,
  };
}

describe('computeTaskAcceptance 判定', () => {
  it('必需项全部通过且无 stale → passed', () => {
    const result = computeTaskAcceptance({
      acceptance: [makeItem({ status: 'passed' }), makeItem({ status: 'passed', order: 2 })],
      stale: false,
    });
    expect(result).toEqual({ passed: true, passedCount: 2, requiredTotal: 2, stale: false });
  });

  it('存在 stale 证据 → 不通过（即使必需项全过）', () => {
    const result = computeTaskAcceptance({
      acceptance: [makeItem({ status: 'passed' })],
      stale: true,
    });
    expect(result.passed).toBe(false);
    expect(result.stale).toBe(true);
  });

  it('任一必需项未通过 → 不通过', () => {
    const result = computeTaskAcceptance({
      acceptance: [makeItem({ status: 'passed' }), makeItem({ status: 'failed', order: 2 })],
      stale: false,
    });
    expect(result.passed).toBe(false);
    expect(result.passedCount).toBe(1);
    expect(result.requiredTotal).toBe(2);
  });

  it('非必需项失败不阻断通过', () => {
    const result = computeTaskAcceptance({
      acceptance: [makeItem({ status: 'passed' }), makeItem({ status: 'failed', required: false })],
      stale: false,
    });
    expect(result.passed).toBe(true);
    expect(result.requiredTotal).toBe(1);
  });

  it('无必需项（requiredTotal=0）→ 不通过（边界）', () => {
    const result = computeTaskAcceptance({
      acceptance: [makeItem({ status: 'passed', required: false })],
      stale: false,
    });
    expect(result.passed).toBe(false);
    expect(result.requiredTotal).toBe(0);
  });

  it('模型提议项（proposed）不算通过：必需项为 proposed 时不点亮', () => {
    const result = computeTaskAcceptance({
      acceptance: [makeItem({ status: 'proposed' })],
      stale: false,
    });
    expect(result.passed).toBe(false);
    expect(result.passedCount).toBe(0);
  });

  it('stale + 必需项未过 → 双重不满足', () => {
    const result = computeTaskAcceptance({
      acceptance: [makeItem({ status: 'stale' })],
      stale: true,
    });
    expect(result.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 字符串工具与枚举完整性
// ---------------------------------------------------------------------------

describe('ID / 摘要 / requestKey 字符串工具', () => {
  it('newId 生成带前缀 UUID 且符合 MCP ID schema', () => {
    const id = newId('task');
    expect(id).toMatch(/^task-[0-9a-f-]{36}$/);
    expect(TaskIdSchema.safeParse(id).success).toBe(true);
    expect(newId('op')).toMatch(/^op-[0-9a-f-]{36}$/);
  });

  it('isSha256 校验 64 位小写十六进制', () => {
    const h = sha256Hex('forgedesk');
    expect(isSha256(h)).toBe(true);
    expect(isSha256(h.toUpperCase())).toBe(false);
    expect(isSha256(h.slice(0, 63))).toBe(false);
    expect(isSha256('')).toBe(false);
  });

  it('RequestKeySchema 边界：8~200 字符', () => {
    expect(RequestKeySchema.safeParse('12345678').success).toBe(true);
    expect(RequestKeySchema.safeParse('1234567').success).toBe(false);
    expect(RequestKeySchema.safeParse('k'.repeat(200)).success).toBe(true);
    expect(RequestKeySchema.safeParse('k'.repeat(201)).success).toBe(false);
  });

  it('argsDigest 形状：sha256 十六进制 64 位（contracts 类型可表达）', () => {
    const digest = sha256Hex(JSON.stringify({ verifierId: 'v', artifactId: undefined }));
    expect(typeof operation.argsDigest).toBe('string');
    expect(isSha256(operation.argsDigest)).toBe(true);
    expect(isSha256(digest)).toBe(true);
  });

  it('失败类型与标签完整；状态机枚举包含关键状态', () => {
    for (const kind of FAILURE_KINDS) {
      expect(FAILURE_KIND_LABELS_ZH[kind]?.length).toBeGreaterThan(0);
    }
    expect(FAILURE_KINDS).toContain('evidence_stale');
    expect(TASK_STATUSES).toHaveLength(8);
    expect(OPERATION_STATUSES).toContain('unknown');
    expect(ACCEPTANCE_KINDS).toContain('manual');
    expect(ACCEPTANCE_ITEM_STATUSES).toContain('proposed');
  });
});

// ---------------------------------------------------------------------------
// 验收单模板与 contracts 兼容性
// ---------------------------------------------------------------------------

describe('engineering/acceptance/task-templates.json 兼容性', () => {
  it('两类模板条目字段与 contracts AcceptanceItem / CreateTaskRequest 兼容', () => {
    const templates = JSON.parse(
      readFileSync(join(repoRoot, 'engineering', 'acceptance', 'task-templates.json'), 'utf8'),
    ) as {
      schemaVersion: number;
      templates: Array<{
        templateId: string;
        title: string;
        acceptance: Array<{
          kind: string;
          verifierId?: string;
          title: string;
          expected: string;
          manualRequired: boolean;
          required: boolean;
          order: number;
        }>;
      }>;
    };

    expect(templates.schemaVersion).toBe(1);
    expect(templates.templates.map((t) => t.templateId)).toEqual([
      'software-bugfix',
      'embedded-firmware-verify',
    ]);

    for (const t of templates.templates) {
      for (const item of t.acceptance) {
        expect(ACCEPTANCE_KINDS).toContain(item.kind);
        expect(typeof item.title).toBe('string');
        expect(typeof item.expected).toBe('string');
        expect(typeof item.required).toBe('boolean');
        expect(typeof item.manualRequired).toBe('boolean');
        if (item.kind === 'executable') {
          expect(typeof item.verifierId).toBe('string');
          expect(item.verifierId!.length).toBeGreaterThan(0);
          expect(item.manualRequired).toBe(false);
        } else {
          expect(item.verifierId).toBeUndefined();
          expect(item.manualRequired).toBe(true);
        }
      }
    }

    const software = templates.templates[0]!;
    expect(software.acceptance.map((a) => a.title)).toEqual([
      '构建通过',
      '缺陷复现器由红转绿',
      '无回归（固定验收仍通过）',
      '人工复核代码差异',
    ]);
    expect(software.acceptance.every((a) => a.required)).toBe(true);

    const embedded = templates.templates[1]!;
    expect(embedded.acceptance.map((a) => a.title)).toEqual([
      '构建产物哈希绑定',
      '授权烧录回执',
      '串口 nonce+buildId 响应',
      '人工确认板卡连接',
    ]);
    expect(embedded.acceptance.filter((a) => a.kind === 'manual')).toHaveLength(1);
    expect(embedded.acceptance.filter((a) => a.kind === 'manual')[0]!.manualRequired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 状态机常量完备性（枚举与标签表键严格一致）
// ---------------------------------------------------------------------------

describe('状态机常量完备性', () => {
  it('TASK_STATUSES 与 TASK_STATUS_LABELS_ZH 键集合严格一致', async () => {
    const { TASK_STATUS_LABELS_ZH } = await import('../src/engineering.ts');
    expect(Object.keys(TASK_STATUS_LABELS_ZH).sort()).toEqual([...TASK_STATUSES].sort());
    for (const status of TASK_STATUSES) {
      expect(TASK_STATUS_LABELS_ZH[status].length).toBeGreaterThan(0);
    }
  });

  it('FAILURE_KINDS 与 FAILURE_KIND_LABELS_ZH 键集合严格一致', () => {
    expect(Object.keys(FAILURE_KIND_LABELS_ZH).sort()).toEqual([...FAILURE_KINDS].sort());
  });

  it('OPERATION_STATUSES / OPERATION_TYPES / EVIDENCE_RESULTS / ARTIFACT_TYPES 无重复且非空', async () => {
    const { OPERATION_TYPES, EVIDENCE_RESULTS, ARTIFACT_TYPES } = await import('../src/engineering.ts');
    expect(new Set(OPERATION_STATUSES).size).toBe(OPERATION_STATUSES.length);
    expect(new Set(OPERATION_TYPES).size).toBe(OPERATION_TYPES.length);
    expect(OPERATION_TYPES).toHaveLength(8); // 7 工具操作 + manual_review（人工验收通道）
    expect(new Set(EVIDENCE_RESULTS).size).toBe(EVIDENCE_RESULTS.length);
    expect(new Set(ARTIFACT_TYPES).size).toBe(ARTIFACT_TYPES.length);
  });

  it('runner-api RUNNER_EVENT_TYPES 与 ENGINE_EVENT_TYPES 无重复且非空', async () => {
    const { ENGINE_EVENT_TYPES } = await import('../src/engine.ts');
    expect(new Set(RUNNER_EVENT_TYPES).size).toBe(RUNNER_EVENT_TYPES.length);
    expect(new Set(ENGINE_EVENT_TYPES).size).toBe(ENGINE_EVENT_TYPES.length);
  });
});

// ---------------------------------------------------------------------------
// OpResult 基础行为（common.ts ok/fail）
// ---------------------------------------------------------------------------

describe('OpResult 基础行为', () => {
  it('ok() 包装成功值；fail() 携带 FailureInfo 且可判别', async () => {
    const { ok, fail } = await import('../src/common.ts');
    const good = ok(42);
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.value).toBe(42);

    const bad = fail('environment_missing', '未安装 probe-rs', { detail: 'probe-rs not found', logRef: 'logs/probe.log' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.failure.kind).toBe('environment_missing');
      expect(bad.failure.message).toBe('未安装 probe-rs');
      expect(bad.failure.detail).toBe('probe-rs not found');
      expect(bad.failure.logRef).toBe('logs/probe.log');
      expect(bad.failure.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect(FAILURE_KINDS).toContain('environment_missing');
  });

  it('fail() 可表达全部失败类型（FailureKind 全枚举可构造）', async () => {
    const { fail } = await import('../src/common.ts');
    for (const kind of FAILURE_KINDS) {
      const r = fail(kind, `测试-${kind}`);
      expect(r.ok).toBe(false);
    }
  });
});
