/**
 * ForgeDesk 工程 MCP 工具契约（任务书 §9）：七个工具，输入输出 schema 冻结。
 * 名称必须与 config.toml enabled_tools 及服务端公开名称一致。
 * 冻结契约 v1 —— 集成负责人维护。
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// 公共字段
// ---------------------------------------------------------------------------

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 格式错误');
export const TaskIdSchema = z.string().regex(/^task-[0-9a-f-]{36}$/);
export const OperationIdSchema = z.string().regex(/^op-[0-9a-f-]{36}$/);
export const ArtifactIdSchema = z.string().regex(/^art-[0-9a-f-]{36}$/);
export const DeviceBindingIdSchema = z.string().regex(/^dev-[0-9a-f-]{36}$/);
export const RequestKeySchema = z.string().min(8).max(200);

/** 工具通用失败返回（所有 tools/call 都可能返回） */
export const ToolFailureSchema = z.object({
  ok: z.literal(false),
  kind: z.enum([
    'environment_missing',
    'connection_failure',
    'permission_denied',
    'timeout',
    'unknown_result',
    'internal_error',
  ]),
  message: z.string(),
  detail: z.string().optional(),
  operationId: OperationIdSchema.optional(),
});
export type ToolFailure = z.infer<typeof ToolFailureSchema>;

// ---------------------------------------------------------------------------
// engineering.inspect —— 工具链状态、缺失项、当前快照
// ---------------------------------------------------------------------------

export const InspectInputSchema = z.object({
  taskId: TaskIdSchema,
  profileId: z.string().min(1),
});
export type InspectInput = z.infer<typeof InspectInputSchema>;

export const InspectOutputSchema = z.object({
  ok: z.literal(true),
  operationId: OperationIdSchema,
  profileId: z.string(),
  profileRevision: z.number().int().nonnegative(),
  toolchain: z.array(
    z.object({
      tool: z.string(),
      available: z.boolean(),
      version: z.string().optional(),
      missingHint: z.string().optional(),
    }),
  ),
  missing: z.array(z.string()),
  currentSnapshot: z
    .object({
      inputDigest: Sha256Schema,
      hasGit: z.boolean(),
      capturedAt: z.string(),
    })
    .optional(),
});
export type InspectOutput = z.infer<typeof InspectOutputSchema>;

// ---------------------------------------------------------------------------
// engineering.build —— 受控构建
// ---------------------------------------------------------------------------

export const BuildInputSchema = z.object({
  taskId: TaskIdSchema,
  /** 调用方持有的 profile 修订号；省略时按任务当前修订执行（模型调用无需预查修订——
   * 实测 codex 对缺失必填参数会发起 elicitation 征询，产品首发未启用即被拒） */
  profileRevision: z.number().int().nonnegative().optional(),
});
export type BuildInput = z.infer<typeof BuildInputSchema>;

export const BuildOutputSchema = z.object({
  ok: z.literal(true),
  operationId: OperationIdSchema,
  artifactId: ArtifactIdSchema,
  buildId: z.string(),
  artifactType: z.enum(['firmware_elf', 'firmware_bin', 'test_report', 'other']),
  artifactPath: z.string(),
  artifactSha256: Sha256Schema,
  logRef: z.string(),
  durationMs: z.number().int().nonnegative(),
});
export type BuildOutput = z.infer<typeof BuildOutputSchema>;

// ---------------------------------------------------------------------------
// engineering.test —— 固定验收执行
// ---------------------------------------------------------------------------

export const TestInputSchema = z.object({
  taskId: TaskIdSchema,
  verifierId: z.string().min(1),
  artifactId: ArtifactIdSchema.optional(),
  /** 由调用方（GUI/MCP）传入的请求去重键 */
  requestKey: RequestKeySchema.optional(),
});
export type TestInput = z.infer<typeof TestInputSchema>;

export const TestOutputSchema = z.object({
  ok: z.literal(true),
  operationId: OperationIdSchema,
  evidenceId: z.string(),
  result: z.enum(['passed', 'failed', 'inconclusive']),
  acceptanceItemId: z.string().optional(),
  detail: z.unknown(),
  logRef: z.string().optional(),
});
export type TestOutput = z.infer<typeof TestOutputSchema>;

// ---------------------------------------------------------------------------
// device.bind —— 绑定设备身份
// ---------------------------------------------------------------------------

export const DeviceBindInputSchema = z.object({
  taskId: TaskIdSchema,
  profileId: z.string().min(1),
  /** 用户选择的设备身份（来自 GUI 确认或此前绑定） */
  identity: z.object({
    usbVid: z.number().int().nonnegative(),
    usbPid: z.number().int().nonnegative(),
    probeSerial: z.string().optional(),
    chipTarget: z.string().optional(),
    serialPort: z.string().optional(),
  }),
  identityEvidence: z.string().min(1),
});
export type DeviceBindInput = z.infer<typeof DeviceBindInputSchema>;

export const DeviceBindOutputSchema = z.object({
  ok: z.literal(true),
  operationId: OperationIdSchema,
  deviceBindingId: DeviceBindingIdSchema,
  chipTarget: z.string(),
  confirmedByUser: z.boolean(),
});
export type DeviceBindOutput = z.infer<typeof DeviceBindOutputSchema>;

// ---------------------------------------------------------------------------
// device.flash —— 授权烧录
// ---------------------------------------------------------------------------

export const DeviceFlashInputSchema = z.object({
  taskId: TaskIdSchema,
  artifactId: ArtifactIdSchema,
  deviceBindingId: DeviceBindingIdSchema,
  requestKey: RequestKeySchema,
});
export type DeviceFlashInput = z.infer<typeof DeviceFlashInputSchema>;

export const DeviceFlashOutputSchema = z.object({
  ok: z.literal(true),
  operationId: OperationIdSchema,
  status: z.enum(['succeeded', 'failed', 'unknown']),
  toolReceiptPath: z.string(),
  toolSummary: z.string(),
  durationMs: z.number().int().nonnegative(),
  /** 烧录后读回校验（工具支持时） */
  readbackVerified: z.boolean().optional(),
});
export type DeviceFlashOutput = z.infer<typeof DeviceFlashOutputSchema>;

// ---------------------------------------------------------------------------
// device.verify —— 串口身份与行为验证
// ---------------------------------------------------------------------------

export const DeviceVerifyInputSchema = z.object({
  taskId: TaskIdSchema,
  verifierId: z.string().min(1),
  deviceBindingId: DeviceBindingIdSchema,
});
export type DeviceVerifyInput = z.infer<typeof DeviceVerifyInputSchema>;

export const DeviceVerifyOutputSchema = z.object({
  ok: z.literal(true),
  operationId: OperationIdSchema,
  evidenceId: z.string(),
  result: z.enum(['passed', 'failed', 'inconclusive']),
  nonceMatch: z.boolean(),
  buildIdMatch: z.boolean(),
  buildId: z.string().optional(),
  responsePreview: z.string(),
  logRef: z.string().optional(),
});
export type DeviceVerifyOutput = z.infer<typeof DeviceVerifyOutputSchema>;

// ---------------------------------------------------------------------------
// engineering.export —— 交付包导出（含版本与证据，排除密钥）
// ---------------------------------------------------------------------------

export const ExportInputSchema = z.object({
  taskId: TaskIdSchema,
});
export type ExportInput = z.infer<typeof ExportInputSchema>;

export const ExportOutputSchema = z.object({
  ok: z.literal(true),
  operationId: OperationIdSchema,
  bundlePath: z.string(),
  manifest: z.unknown(), // 导出清单（带 schemaVersion）
});
export type ExportOutput = z.infer<typeof ExportOutputSchema>;

// ---------------------------------------------------------------------------
// 工具注册表（名称冻结）
// ---------------------------------------------------------------------------

export const ENGINEERING_TOOLS = [
  'engineering.inspect',
  'engineering.build',
  'engineering.test',
  'device.bind',
  'device.flash',
  'device.verify',
  'engineering.export',
] as const;
export type EngineeringToolName = (typeof ENGINEERING_TOOLS)[number];

/** 工具实现签名（engineering-mcp 与 runner 都遵守） */
export interface ToolHandlerMap {
  'engineering.inspect': (input: InspectInput) => Promise<InspectOutput | ToolFailure>;
  'engineering.build': (input: BuildInput) => Promise<BuildOutput | ToolFailure>;
  'engineering.test': (input: TestInput) => Promise<TestOutput | ToolFailure>;
  'device.bind': (input: DeviceBindInput) => Promise<DeviceBindOutput | ToolFailure>;
  'device.flash': (input: DeviceFlashInput) => Promise<DeviceFlashOutput | ToolFailure>;
  'device.verify': (input: DeviceVerifyInput) => Promise<DeviceVerifyOutput | ToolFailure>;
  'engineering.export': (input: ExportInput) => Promise<ExportOutput | ToolFailure>;
}

/** MCP 服务器初始化 instructions 前 512 字符须自含：工具用途、验收只由执行器判定、设备授权规则 */
export const MCP_SERVER_INSTRUCTIONS = [
  'ForgeDesk 工程工具服务。提供 engineering.inspect/build/test、device.bind/flash/verify、engineering.export。',
  '验收状态只能由工程执行器根据真实执行结果判定；模型自评不点亮验收。',
  '设备写入（flash）需要执行器核验的用户授权（指定设备+产物哈希+任务范围）；授权范围变化须重新确认。',
  '所有操作带 requestKey 去重；重复请求返回原操作状态。',
].join('');
