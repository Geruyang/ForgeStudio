/**
 * ForgeDesk 工程实体：任务、验收项、源码快照、操作、证据、设备绑定、产物。
 * 依据任务书 §8.1 数据模型；冻结契约 v1 —— 集成负责人维护。
 */
import type {
  SchemaVersion,
  TaskId,
  AcceptanceItemId,
  OperationId,
  EvidenceId,
  ArtifactId,
  DeviceBindingId,
  TurnRecordId,
  Timestamp,
  Sha256,
  FailureKind,
} from './common.ts';

// ---------------------------------------------------------------------------
// 任务状态机（任务书 §11）：
// draft → running → awaiting_authorization / verifying
//       → passed / failed / interrupted / needs_attention
// ---------------------------------------------------------------------------

export const TASK_STATUSES = [
  'draft',
  'running',
  'awaiting_authorization',
  'verifying',
  'passed',
  'failed',
  'interrupted',
  'needs_attention',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS_ZH: Record<TaskStatus, string> = {
  draft: '未运行',
  running: '执行中',
  awaiting_authorization: '需要人工确认',
  verifying: '验证中',
  passed: '通过',
  failed: '失败',
  interrupted: '已中断',
  needs_attention: '需要人工确认',
};

// ---------------------------------------------------------------------------
// 操作状态机（任务书 §11）：
// prepared → awaiting_authorization → authorized → running
//          → succeeded / failed / unknown；副作用前取消为 cancelled
// ---------------------------------------------------------------------------

export const OPERATION_STATUSES = [
  'prepared',
  'awaiting_authorization',
  'authorized',
  'running',
  'succeeded',
  'failed',
  'unknown',
  'cancelled',
] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export const OPERATION_TYPES = [
  'inspect',
  'build',
  'test',
  'device_bind',
  'device_flash',
  'device_verify',
  'export',
  'manual_review',
] as const;
export type OperationType = (typeof OPERATION_TYPES)[number];

// ---------------------------------------------------------------------------
// EngineeringTask —— 执行器是唯一写入者
// ---------------------------------------------------------------------------

export interface EngineeringTask {
  schemaVersion: SchemaVersion;
  id: TaskId;
  /** 关联的引擎会话线程（可为空：纯工程任务） */
  threadId?: string;
  /** Codex turn 标识（绑定证据到本轮请求） */
  turnId?: string;
  /** 项目根目录（绝对路径） */
  projectRoot: string;
  /** 工程档案（profile）修订号 */
  profileId: string;
  profileRevision: number;
  title: string;
  status: TaskStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** 最近一次失败信息 */
  lastFailure?: { kind: FailureKind; message: string; logRef?: string };
}

// ---------------------------------------------------------------------------
// AcceptanceItem —— 验收单条目；用户/模板写入，模型只允许提议（未采纳状态）
// ---------------------------------------------------------------------------

export const ACCEPTANCE_KINDS = [
  'executable', // 可执行检查（verifierId 必填）
  'manual', // 人工确认项
] as const;
export type AcceptanceKind = (typeof ACCEPTANCE_KINDS)[number];

export const ACCEPTANCE_ITEM_STATUSES = [
  'pending',
  'running',
  'passed',
  'failed',
  'stale', // 证据过期，需重新验证
  'proposed', // 模型提议，未经用户采纳
  'not_runnable', // 前置失败，暂不可执行
] as const;
export type AcceptanceItemStatus = (typeof ACCEPTANCE_ITEM_STATUSES)[number];

export interface AcceptanceItem {
  schemaVersion: SchemaVersion;
  id: AcceptanceItemId;
  taskId: TaskId;
  kind: AcceptanceKind;
  /** verifierId 指向 engineering/acceptance/ 中的固定验收定义；评分规则不可由模型改写 */
  verifierId?: string;
  title: string;
  expected: string; // 用户可读的通过标准
  manualRequired: boolean;
  status: AcceptanceItemStatus;
  required: boolean;
  order: number;
  /** 最近一次证据 ID */
  lastEvidenceId?: EvidenceId;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ---------------------------------------------------------------------------
// SourceSnapshot —— A 级为输入指纹；B 级才含冻结副本路径（T3，首发不启用）
// ---------------------------------------------------------------------------

export type EvidenceLevel = 'A' | 'B';

export const SOURCE_INPUT_KINDS = [
  'tracked_modified', // 已跟踪文件的未提交修改
  'untracked', // 必要未跟踪输入
  'lockfile', // 锁文件
  'build_config', // 构建配置
  'acceptance_config', // 验收配置
  'profile_config', // 工程 profile
] as const;
export type SourceInputKind = (typeof SOURCE_INPUT_KINDS)[number];

export interface SourceInputDigest {
  kind: SourceInputKind;
  /** 相对项目根路径 */
  path: string;
  sha256: Sha256;
  sizeBytes: number;
}

export interface SourceSnapshot {
  schemaVersion: SchemaVersion;
  id: string; // snap-<uuid>
  taskId: TaskId;
  evidenceLevel: EvidenceLevel;
  /** git 可用时记录；无 git 工程为空并在 hasGit=false 标明 */
  gitCommit?: string;
  gitBranch?: string;
  hasGit: boolean;
  /** 暂存+未暂存修改（含二进制与删除）的聚合摘要 */
  dirtyDiffDigest?: Sha256;
  /** 必要未跟踪输入的聚合摘要 */
  untrackedDigest?: Sha256;
  /** 全部输入清单聚合摘要（A 级核心指纹） */
  inputDigest: Sha256;
  inputManifest: SourceInputDigest[];
  /** B 级快照目录（未启用时为空） */
  snapshotPath?: string;
  /** 工具版本清单：tool → version */
  toolVersions: Record<string, string>;
  capturedAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Operation —— 带请求去重键，重复 requestKey 返回原操作
// ---------------------------------------------------------------------------

export interface Operation {
  schemaVersion: SchemaVersion;
  id: OperationId;
  /** 请求去重键：连接代次+调用方+业务键 的规范化哈希 */
  requestKey: string;
  type: OperationType;
  taskId: TaskId;
  /** 规范化参数摘要（防止同键不同参） */
  argsDigest: Sha256;
  status: OperationStatus;
  /** 设备操作绑定的设备 */
  deviceBindingId?: DeviceBindingId;
  /** 关联产物 */
  artifactId?: ArtifactId;
  createdAt: Timestamp;
  startedAt?: Timestamp;
  endedAt?: Timestamp;
  /** 等待授权的开始时间（超时取消意图） */
  authorizationRequestedAt?: Timestamp;
  failure?: { kind: FailureKind; message: string; logRef?: string };
  /** 结束后的摘要文本 */
  resultSummary?: string;
}

// ---------------------------------------------------------------------------
// Evidence —— 验证器判定，执行器唯一落盘
// ---------------------------------------------------------------------------

export const EVIDENCE_RESULTS = ['passed', 'failed', 'inconclusive'] as const;
export type EvidenceResult = (typeof EVIDENCE_RESULTS)[number];

export interface Evidence {
  schemaVersion: SchemaVersion;
  id: EvidenceId;
  operationId: OperationId;
  taskId: TaskId;
  acceptanceItemId?: AcceptanceItemId;
  inputDigest: Sha256;
  evidenceLevel: EvidenceLevel;
  /** 产物哈希（固件/测试对象） */
  artifactDigest?: Sha256;
  artifactId?: ArtifactId;
  toolVersions: Record<string, string>;
  result: EvidenceResult;
  /** 结构化判定细节（JSON 字符串或对象） */
  detail: unknown;
  /** 原始日志引用（evidence 目录内相对路径） */
  logRef?: string;
  /** 附加产物文件引用 */
  artifactRefs?: string[];
  createdAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Artifact —— 构建产物（ELF/BIN/测试报告等）
// ---------------------------------------------------------------------------

export const ARTIFACT_TYPES = ['firmware_elf', 'firmware_bin', 'test_report', 'export_bundle', 'other'] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export interface Artifact {
  schemaVersion: SchemaVersion;
  id: ArtifactId;
  taskId: TaskId;
  type: ArtifactType;
  /** 产物绝对路径（采集时位置） */
  path: string;
  /** 归档副本相对路径（evidence 存储内，防产物被清理后证据失联） */
  archivedPath?: string;
  sha256: Sha256;
  sizeBytes: number;
  /** 构建标识：构建前生成，固件可通过测试命令返回 */
  buildId?: string;
  sourceSnapshotId: string;
  createdAt: Timestamp;
}

// ---------------------------------------------------------------------------
// TurnRecord —— 本产品自有的回合记录（绑定任务与证据到引擎回合）
// ---------------------------------------------------------------------------

export interface TurnRecord {
  schemaVersion: SchemaVersion;
  id: TurnRecordId;
  taskId: TaskId;
  threadId: string;
  turnId: string;
  /** 引擎连接代次 */
  connectionGeneration: number;
  summary: string;
  createdAt: Timestamp;
}

/** 任务聚合视图（GUI 工程面板直接消费） */
export interface TaskOverview extends EngineeringTask {
  acceptance: AcceptanceItem[];
  latestSnapshot?: SourceSnapshot;
  artifacts: Artifact[];
  operations: Operation[];
  /** 证据列表（按时间倒序，最多 50 条） */
  evidence: Evidence[];
  hasStaleEvidence: boolean;
}

/**
 * 证据有效性判定（任务书 §8.2）：
 * 可显示"通过" = 真实执行成功 且 输出满足验收规则 且 证据绑定输入仍匹配 且 必需项全部完成。
 * 该函数是唯一判定入口；UI 不允许自行点亮通过状态。
 */
export function computeTaskAcceptance(task: {
  acceptance: AcceptanceItem[];
  stale: boolean;
}): { passed: boolean; passedCount: number; requiredTotal: number; stale: boolean } {
  const required = task.acceptance.filter((a) => a.required);
  const passedCount = required.filter((a) => a.status === 'passed').length;
  const allPassed = required.length > 0 && passedCount === required.length;
  return { passed: allPassed && !task.stale, passedCount, requiredTotal: required.length, stale: task.stale };
}
