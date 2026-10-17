/**
 * ForgeDesk Runner 控制协议（主进程 ↔ 工程执行器 唯一权威实例）。
 * 传输：loopback HTTP（127.0.0.1，随机端口 + 每启动随机 Bearer Token），
 * 只暴露受限路由；MCP 桥接进程与 GUI 都通过本协议调用同一权威实例。
 * 冻结契约 v1 —— 集成负责人维护。
 */

/** 环境变量约定（主进程派生 runner 时注入） */
export const RUNNER_ENV_PORT = 'FD_RUNNER_PORT';
export const RUNNER_ENV_TOKEN = 'FD_RUNNER_TOKEN';
export const RUNNER_ENV_DATA_DIR = 'FD_RUNNER_DATA_DIR';
/** 发现文件：runner 就绪后写出，供 MCP 桥接进程读取端口与令牌 */
export const RUNNER_DISCOVERY_FILE = 'runner-discovery.json';

export interface RunnerDiscovery {
  schemaVersion: 1;
  port: number;
  token: string;
  pid: number;
  startedAt: string;
}

// ---------------------------------------------------------------------------
// 路由清单（全部 POST 体为 JSON；鉴权失败统一 401）
// ---------------------------------------------------------------------------

export const RUNNER_ROUTES = {
  health: 'GET /health',
  // 任务与证据（GUI 面板读取）
  listTasks: 'GET /api/tasks',
  getTask: 'GET /api/tasks/:id',
  createTask: 'POST /api/tasks',
  updateAcceptance: 'POST /api/tasks/:id/acceptance',
  /** 人工验收判定（仅 kind=manual 项；executable 保持执行器独占，防作弊红线不变） */
  manualReview: 'POST /api/tasks/:id/acceptance/:itemId/manual-review',
  listOperations: 'GET /api/tasks/:id/operations',
  /** 工程 profile 枚举（任务向导选择用） */
  listProfiles: 'GET /api/profiles',
  // 操作调用（GUI 与 MCP 桥共用；与 MCP 工具一一对应）
  opInspect: 'POST /api/ops/inspect',
  opBuild: 'POST /api/ops/build',
  opTest: 'POST /api/ops/test',
  opDeviceBind: 'POST /api/ops/device-bind',
  opDeviceFlash: 'POST /api/ops/device-flash',
  opDeviceVerify: 'POST /api/ops/device-verify',
  opExport: 'POST /api/ops/export',
  opCancel: 'POST /api/ops/:id/cancel',
  // 设备授权（引擎审批之外，独立由 GUI 处理）
  pendingAuthorization: 'GET /api/pending-authorization',
  authorize: 'POST /api/ops/authorize',
  // 设备枚举
  listDevices: 'GET /api/devices',
  // 事件流（SSE）：自 since 起推送状态变化
  events: 'GET /api/events',
  // 诊断
  diagnostics: 'GET /api/diagnostics',
} as const;

// ---------------------------------------------------------------------------
// 请求/响应类型
// ---------------------------------------------------------------------------

/** 工程 profile 摘要（任务向导选择用） */
export interface ProfileSummary {
  id: string;
  revision: number;
  title: string;
  kind: 'software' | 'embedded';
  /** profile 文件内容摘要（绑定证据） */
  fileSha256: string;
  /** 来源目录标识 */
  source: 'user' | 'bundled';
}

export interface CreateTaskRequest {
  projectRoot: string;
  profileId: string;
  title: string;
  threadId?: string;
  /** 初始验收项（用户从模板选择；模型提议项走 proposed 状态另行接口） */
  acceptance?: Array<{
    kind: 'executable' | 'manual';
    verifierId?: string;
    title: string;
    expected: string;
    manualRequired: boolean;
    required: boolean;
  }>;
}

export interface CancelRequest {
  reason: 'user_stop' | 'timeout' | 'shutdown';
}

/** 待授权操作投影（GUI 卡片渲染） */
export interface PendingAuthorization {
  operationId: string;
  taskId: string;
  type: 'device_bind' | 'device_flash' | 'device_verify';
  title: string;
  /** 人可读范围描述：目标设备、产物、验收规则 */
  scopeSummary: string;
  artifactSha256?: string;
  acceptanceDigest?: string;
  requestedAt: string;
  /** 超过该时限自动取消意图（副作用未发生时） */
  expiresAt: string;
}

export interface AuthorizeRequest {
  operationId: string;
  decision: 'approved' | 'declined';
  /** 用户确认的范围，必须与 PendingAuthorization 一致 */
  confirmedScope: {
    deviceBindingId?: string;
    artifactSha256?: string;
    taskId: string;
  };
}

// ---------------------------------------------------------------------------
// Runner 事件流（SSE data 均为 RunnerEvent JSON）
// ---------------------------------------------------------------------------

export const RUNNER_EVENT_TYPES = [
  'runner/ready',
  'task/updated',
  'acceptance/updated',
  'operation/updated',
  'authorization/pending',
  'authorization/resolved',
  'evidence/created',
  'device/updated',
  'diagnostics/updated',
] as const;
export type RunnerEventType = (typeof RUNNER_EVENT_TYPES)[number];

export interface RunnerEvent {
  schemaVersion: 1;
  seq: number; // 严格递增
  type: RunnerEventType;
  taskId?: string;
  operationId?: string;
  payload: unknown;
  emittedAt: string;
}

/** 诊断信息（不包含凭证） */
export interface RunnerDiagnostics {
  schemaVersion: 1;
  runnerVersion: string;
  uptimeMs: number;
  storagePath: string;
  storageOk: boolean;
  gitAvailable: boolean;
  probeRsAvailable: boolean;
  probeRsPath?: string;
  serialPortsAvailable: boolean;
  activeDeviceLock?: string;
  pendingAuthorizations: number;
  lastError?: string;
}
