﻿﻿﻿﻿﻿/**
 * 中文语义标签映射：契约内已有中文标签的直接复用（TASK_STATUS_LABELS_ZH、
 * FAILURE_KIND_LABELS_ZH），契约没有的（引擎状态/审批决定/验收项/操作等）
 * 在此定义——UI 不自行点亮"通过"，状态色也统一由这里给出。
 */
import { FAILURE_KIND_LABELS_ZH, type FailureKind } from '../contracts/common';
import {
  TASK_STATUS_LABELS_ZH,
  type AcceptanceItemStatus,
  type AcceptanceKind,
  type ArtifactType,
  type EvidenceResult,
  type OperationStatus,
  type OperationType,
  type TaskStatus,
} from '../contracts/engineering';
import type {
  ApprovalDecision,
  ApprovalRequestView,
  EngineStatus,
  SteerResult,
} from '../contracts/engine';

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent' | 'violet';

export { FAILURE_KIND_LABELS_ZH, TASK_STATUS_LABELS_ZH };

/** FailureKind → 中文标签；未知类型回退原值（引擎原始错误保留） */
export function failureLabel(kind: string): string {
  return FAILURE_KIND_LABELS_ZH[kind as FailureKind] ?? kind;
}

// ---------------------------------------------------------------- 引擎状态

export const ENGINE_STATUS_LABELS_ZH: Record<EngineStatus, string> = {
  stopped: '未启动',
  starting: '启动中',
  ready: '就绪',
  auth_required: '需要认证',
  error: '引擎异常',
  stopping: '停止中',
};

export const ENGINE_STATUS_TONE: Record<EngineStatus, Tone> = {
  stopped: 'neutral',
  starting: 'info',
  ready: 'ok',
  auth_required: 'warn',
  error: 'danger',
  stopping: 'warn',
};

// -------------------------------------------------------------------- 审批

export const APPROVAL_KIND_LABELS_ZH: Record<ApprovalRequestView['kind'], string> = {
  exec_command: '命令执行',
  apply_patch: '补丁修改',
  mcp_tool: '工程工具调用',
  other: '引擎请求',
};

/** 审批按钮文案（只对 options 中允许的决定显示） */
export const APPROVAL_DECISION_LABELS_ZH: Record<ApprovalDecision, string> = {
  accept: '允许一次',
  acceptForSession: '本会话内允许',
  decline: '拒绝',
  cancel: '不执行',
};

/** 已处理后的结果文案 */
export const APPROVAL_RESOLVED_LABELS_ZH: Record<ApprovalDecision, string> = {
  accept: '已允许',
  acceptForSession: '已允许（本会话）',
  decline: '已拒绝',
  cancel: '已取消',
};

export const APPROVAL_DECISION_TONE: Record<ApprovalDecision, Tone> = {
  accept: 'ok',
  acceptForSession: 'ok',
  decline: 'danger',
  cancel: 'neutral',
};

// ------------------------------------------------------------------ 验收项

export const ACCEPTANCE_STATUS_LABELS_ZH: Record<AcceptanceItemStatus, string> = {
  pending: '待执行',
  running: '执行中',
  passed: '通过',
  failed: '失败',
  stale: '证据过期',
  proposed: '模型提议 · 未采纳',
  not_runnable: '暂不可执行',
};

export const ACCEPTANCE_STATUS_TONE: Record<AcceptanceItemStatus, Tone> = {
  pending: 'neutral',
  running: 'info',
  passed: 'ok',
  failed: 'danger',
  stale: 'warn',
  proposed: 'accent',
  not_runnable: 'neutral',
};

export const ACCEPTANCE_KIND_LABELS_ZH: Record<AcceptanceKind, string> = {
  executable: '可执行',
  manual: '人工确认',
};

// --------------------------------------------------------------------- 操作

export const OPERATION_STATUS_LABELS_ZH: Record<OperationStatus, string> = {
  prepared: '已就绪',
  awaiting_authorization: '待授权',
  authorized: '已授权',
  running: '执行中',
  succeeded: '成功',
  failed: '失败',
  unknown: '结果未知',
  cancelled: '已取消',
};

export const OPERATION_STATUS_TONE: Record<OperationStatus, Tone> = {
  prepared: 'neutral',
  awaiting_authorization: 'violet',
  authorized: 'info',
  running: 'info',
  succeeded: 'ok',
  failed: 'danger',
  unknown: 'warn',
  cancelled: 'neutral',
};

export const OPERATION_TYPE_LABELS_ZH: Record<OperationType, string> = {
  inspect: '环境检查',
  build: '构建',
  test: '测试',
  device_bind: '设备绑定',
  device_flash: '固件烧录',
  device_verify: '设备验证',
  export: '交付导出',
  manual_review: '人工验收',
};

// --------------------------------------------------------------------- 任务

export const TASK_STATUS_TONE: Record<TaskStatus, Tone> = {
  draft: 'neutral',
  running: 'info',
  awaiting_authorization: 'violet',
  verifying: 'info',
  passed: 'ok',
  failed: 'danger',
  interrupted: 'warn',
  needs_attention: 'warn',
};

// --------------------------------------------------------------------- 其他

export const EVIDENCE_RESULT_LABELS_ZH: Record<EvidenceResult, string> = {
  passed: '通过',
  failed: '失败',
  inconclusive: '无法判定',
};

export const EVIDENCE_RESULT_TONE: Record<EvidenceResult, Tone> = {
  passed: 'ok',
  failed: 'danger',
  inconclusive: 'warn',
};

/** steer 未送达原因（SteerResult.reason） */
export const STEER_REASON_LABELS_ZH: Record<NonNullable<SteerResult['reason']>, string> = {
  turn_ended: '当前回合已结束',
  id_mismatch: '回合标识不匹配',
  not_running: '引擎当前未在执行',
};

export const AUTH_MODE_LABELS_ZH: Record<'api_key' | 'chatgpt_account' | 'none', string> = {
  api_key: 'API Key',
  chatgpt_account: 'ChatGPT 账号',
  none: '未配置',
};

export const CHANGE_TYPE_LABELS_ZH: Record<'added' | 'modified' | 'deleted', string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
};

export const CHANGE_TYPE_TONE: Record<'added' | 'modified' | 'deleted', Tone> = {
  added: 'ok',
  modified: 'info',
  deleted: 'danger',
};

export const ARTIFACT_TYPE_LABELS_ZH: Record<ArtifactType, string> = {
  firmware_elf: '固件 ELF',
  firmware_bin: '固件 BIN',
  test_report: '测试报告',
  export_bundle: '交付包',
  other: '其他产物',
};

/** 计划步骤状态（Codex update_plan 投影的常见取值） */
export const PLAN_STEP_LABELS_ZH: Record<string, string> = {
  planned: '计划中',
  in_progress: '进行中',
  completed: '已完成',
};

export const PLAN_STEP_TONE: Record<string, Tone> = {
  planned: 'neutral',
  in_progress: 'info',
  completed: 'ok',
};
