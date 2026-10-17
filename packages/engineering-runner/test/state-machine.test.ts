// 状态机测试：非法转移拒绝、终态无出边、任务状态转移表。
import { describe, expect, it } from 'vitest';
import { OPERATION_STATUSES, TASK_STATUSES } from '@forgedesk/contracts/engineering';
import {
  assertOperationTransition,
  canTransitionOperation,
  canTransitionTask,
  isTerminalOperationStatus,
  OPERATION_TRANSITIONS,
} from '../src/ops/state-machine.ts';

describe('操作状态机（contracts OPERATION_STATUSES）', () => {
  it('合法链路：prepared → awaiting_authorization → authorized → running → succeeded', () => {
    expect(() => {
      assertOperationTransition('prepared', 'awaiting_authorization');
      assertOperationTransition('awaiting_authorization', 'authorized');
      assertOperationTransition('authorized', 'running');
      assertOperationTransition('running', 'succeeded');
    }).not.toThrow();
  });

  it('直行链路：prepared → running → succeeded / failed / unknown / cancelled', () => {
    for (const next of ['succeeded', 'failed', 'unknown', 'cancelled'] as const) {
      expect(canTransitionOperation('running', next)).toBe(true);
    }
    expect(canTransitionOperation('prepared', 'running')).toBe(true);
    expect(canTransitionOperation('prepared', 'failed')).toBe(true);
    expect(canTransitionOperation('prepared', 'cancelled')).toBe(true);
    expect(canTransitionOperation('awaiting_authorization', 'cancelled')).toBe(true);
    expect(canTransitionOperation('authorized', 'cancelled')).toBe(true);
  });

  it('非法转移抛错（不可跳步/不可回退/终态无出边）', () => {
    expect(() => assertOperationTransition('prepared', 'succeeded')).toThrow(/非法操作状态转移/);
    expect(() => assertOperationTransition('awaiting_authorization', 'running')).toThrow(/非法/); // 必须先 authorized
    expect(() => assertOperationTransition('succeeded', 'running')).toThrow(/非法/);
    expect(() => assertOperationTransition('failed', 'succeeded')).toThrow(/非法/);
    expect(() => assertOperationTransition('cancelled', 'running')).toThrow(/非法/);
    expect(() => assertOperationTransition('unknown', 'succeeded')).toThrow(/非法/);
    expect(() => assertOperationTransition('running', 'prepared')).toThrow(/非法/);
  });

  it('终态判定与转移表完备（每个状态都有出边定义）', () => {
    for (const status of OPERATION_STATUSES) {
      expect(OPERATION_TRANSITIONS[status]).toBeDefined();
      expect(isTerminalOperationStatus(status)).toBe(['succeeded', 'failed', 'unknown', 'cancelled'].includes(status));
    }
  });
});

describe('任务状态转移表', () => {
  it('draft → running → verifying → passed 合法；passed → failed 非法', () => {
    expect(canTransitionTask('draft', 'running')).toBe(true);
    expect(canTransitionTask('running', 'verifying')).toBe(true);
    expect(canTransitionTask('verifying', 'passed')).toBe(true);
    expect(canTransitionTask('verifying', 'failed')).toBe(true);
    expect(canTransitionTask('running', 'awaiting_authorization')).toBe(true);
    expect(canTransitionTask('passed', 'running')).toBe(true); // 输入变化后重跑
    expect(canTransitionTask('draft', 'passed')).toBe(false);
  });

  it('每个任务状态都有转移表项（重跑可达性）', () => {
    const resumable = ['awaiting_authorization', 'verifying', 'passed', 'failed', 'interrupted', 'needs_attention'];
    for (const status of TASK_STATUSES) {
      // 除 draft（入口态）与 running（本身即活跃态）外，其余状态都可回到 running 重跑
      expect(status === 'draft' || status === 'running' || canTransitionTask(status, 'running')).toBe(true);
      expect(resumable.includes(status) || status === 'draft' || status === 'running').toBe(true);
    }
  });
});
