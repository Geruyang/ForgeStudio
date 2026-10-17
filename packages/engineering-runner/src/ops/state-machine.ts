/**
 * 操作状态机（contracts OPERATION_STATUSES，任务书 §11）。
 * prepared → awaiting_authorization → authorized → running
 *          → succeeded / failed / unknown；副作用前取消为 cancelled。
 * 非法转移一律抛错（ops 层绝不静默改状态）。
 */
import type { OperationStatus, TaskStatus } from '@forgedesk/contracts/engineering';

/** 操作状态合法转移表（前置检查失败可在任意非终态落 failed） */
export const OPERATION_TRANSITIONS: Readonly<Record<OperationStatus, readonly OperationStatus[]>> = {
  prepared: ['awaiting_authorization', 'running', 'failed', 'cancelled'],
  awaiting_authorization: ['authorized', 'failed', 'cancelled'],
  authorized: ['running', 'failed', 'cancelled'],
  running: ['succeeded', 'failed', 'unknown', 'cancelled'],
  succeeded: [],
  failed: [],
  unknown: [],
  cancelled: [],
};

/** 任务状态合法转移表（draft → running → awaiting_authorization/verifying → 终态；终态可被新操作唤醒重跑） */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  draft: ['running', 'needs_attention'],
  running: ['awaiting_authorization', 'verifying', 'passed', 'failed', 'interrupted', 'needs_attention'],
  awaiting_authorization: ['running', 'verifying', 'failed', 'interrupted', 'needs_attention'],
  verifying: ['running', 'passed', 'failed', 'interrupted', 'needs_attention'],
  passed: ['running'], // 输入变化后重跑：通过态可回到 running（由执行器驱动，不由模型）
  failed: ['running', 'needs_attention'],
  interrupted: ['running', 'needs_attention'],
  needs_attention: ['running', 'failed', 'interrupted'],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function canTransitionOperation(from: OperationStatus, to: OperationStatus): boolean {
  return OPERATION_TRANSITIONS[from].includes(to);
}

export function assertOperationTransition(from: OperationStatus, to: OperationStatus): void {
  if (from === to) return; // 幂等更新（同状态写同状态允许，不产生事件重复问题）
  if (!canTransitionOperation(from, to)) {
    throw new Error(`非法操作状态转移: ${from} → ${to}`);
  }
}

export function isTerminalOperationStatus(status: OperationStatus): boolean {
  return OPERATION_TRANSITIONS[status].length === 0;
}
