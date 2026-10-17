/**
 * ForgeDesk 公共类型：ID、版本、失败类型、通用结果。
 * 冻结契约 v1 —— 由集成负责人维护；并行 Agent 不得修改本文件。
 */

/** 所有持久化实体与导出清单的 schema 版本 */
export const SCHEMA_VERSION = 1 as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

/** 带版本的持久化基类 */
export interface Versioned {
  schemaVersion: SchemaVersion;
}

// ---------------------------------------------------------------------------
// ID（字符串前缀 + UUID，禁止 COM 号等易变值充当永久身份）
// ---------------------------------------------------------------------------

export type TaskId = string; // task-<uuid>
export type AcceptanceItemId = string; // acc-<uuid>
export type OperationId = string; // op-<uuid>
export type EvidenceId = string; // ev-<uuid>
export type ArtifactId = string; // art-<uuid>
export type DeviceBindingId = string; // dev-<uuid>
export type TurnRecordId = string; // turn-<uuid>

/** 生成带前缀的 UUID */
export function newId(prefix: string): string {
  const uuid = crypto.randomUUID();
  return `${prefix}-${uuid}`;
}

// ---------------------------------------------------------------------------
// 失败类型（任务书 §11：环境缺失、模型失败、构建失败、测试失败、连接失败、
// 权限拒绝、操作超时、结果未知、证据过期）
// ---------------------------------------------------------------------------

export const FAILURE_KINDS = [
  'environment_missing',
  'model_failure',
  'build_failure',
  'test_failure',
  'connection_failure',
  'permission_denied',
  'timeout',
  'unknown_result',
  'evidence_stale',
  'internal_error',
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

export const FAILURE_KIND_LABELS_ZH: Record<FailureKind, string> = {
  environment_missing: '环境缺失',
  model_failure: '模型失败',
  build_failure: '构建失败',
  test_failure: '测试失败',
  connection_failure: '连接失败',
  permission_denied: '权限拒绝',
  timeout: '操作超时',
  unknown_result: '结果未知',
  evidence_stale: '证据过期',
  internal_error: '内部错误',
};

/** 统一失败结构：必须能定位到原始日志 */
export interface FailureInfo {
  kind: FailureKind;
  message: string; // 中文优先说明
  detail?: string; // 引擎/工具原始（英文）错误保留
  logRef?: string; // 原始日志文件相对路径
  occurredAt: string; // ISO-8601
}

/** 操作成功/失败统一返回 */
export type OpResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: FailureInfo };

export function ok<T>(value: T): OpResult<T> {
  return { ok: true, value };
}

export function fail(kind: FailureKind, message: string, extra?: Partial<FailureInfo>): OpResult<never> {
  return {
    ok: false,
    failure: {
      kind,
      message,
      detail: extra?.detail,
      logRef: extra?.logRef,
      occurredAt: extra?.occurredAt ?? new Date().toISOString(),
    },
  };
}

/** ISO-8601 时间戳别名 */
export type Timestamp = string;

/** SHA-256 摘要（64 位十六进制小写） */
export type Sha256 = string;

export function isSha256(v: string): boolean {
  return /^[0-9a-f]{64}$/.test(v);
}
