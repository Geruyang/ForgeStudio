/**
 * D-12a 根修回归：背靠背验证下 SSE 事件风暴触发多个并发 getTask，
 * 响应乱序回达时旧快照不得覆盖新状态（数据层正确、UI 停留旧值的竞态）。
 * 修复语义：同任务单飞（在途合并为一次收尾拉取）+ updatedAt 单调防御。
 */
import { describe, expect, it, vi } from 'vitest';
import type { TaskOverview } from '../contracts/engineering';
import { ok } from '../contracts/common';
import { makeSetup } from './test-utils/render';

const task = (updatedAt: string, status: 'in_progress' | 'passed'): TaskOverview => ({
  schemaVersion: 1,
  id: 'task-1',
  projectRoot: 'E:\\proj',
  profileId: 'fixture-ok',
  profileRevision: 1,
  title: '背靠背验证任务',
  status: 'in_progress',
  createdAt: '2026-10-17T10:00:00.000Z',
  updatedAt,
  acceptance:
    status === 'passed'
      ? [
          {
            schemaVersion: 1,
            id: 'item-1',
            taskId: 'task-1',
            kind: 'executable',
            verifierId: 'fixture-ok-smoke',
            title: '冒烟验收',
            expected: '通过',
            status: 'passed',
            manualRequired: false,
            required: true,
            createdAt: updatedAt,
            updatedAt,
          },
        ]
      : [],
} as unknown as TaskOverview);

/** 受控延迟的 getTask：返回 (resolve值, 延迟ms) 序列 */
function deferredGetTask(sequence: Array<{ value: TaskOverview; delayMs: number }>) {
  let i = 0;
  return () => {
    const step = sequence[Math.min(i, sequence.length - 1)]!;
    i += 1;
    return new Promise((resolve) => setTimeout(() => resolve(ok(step.value)), step.delayMs)) as never;
  };
}

describe('D-12a：refreshTask 竞态修复', () => {
  it('事件风暴（5 连发）：单飞合并，恰两次 GET，终态为新状态', async () => {
    const getTask = vi.fn(
      deferredGetTask([
        { value: task('2026-10-17T10:00:01.000Z', 'in_progress'), delayMs: 30 },
        { value: task('2026-10-17T10:00:09.000Z', 'passed'), delayMs: 0 },
      ]),
    );
    const setup = makeSetup({ runner: { getTask: getTask as never } });
    setup.store.setState({ tasks: [task('2026-10-17T10:00:00.000Z', 'in_progress')] });

    // 背靠背：第一发在途期间连发 4 次（SSE 风暴形态）
    const p0 = setup.store.getState().refreshTask('task-1');
    void setup.store.getState().refreshTask('task-1');
    void setup.store.getState().refreshTask('task-1');
    void setup.store.getState().refreshTask('task-1');
    void setup.store.getState().refreshTask('task-1');
    await p0;
    await vi.waitFor(() => {
      const t = setup.store.getState().tasks.find((x) => x.id === 'task-1');
      expect(t?.acceptance[0]?.status).toBe('passed');
    });
    // 单飞：第一次 + 收尾一次 = 恰好 2 次请求
    expect(getTask).toHaveBeenCalledTimes(2);
  });

  it('乱序防御：迟到的旧快照（updatedAt 更早）不覆盖已应用的新状态', async () => {
    // 先应用新状态，再让一个响应携带更早的 updatedAt（跨链乱序形态）
    const getTask = vi.fn(
      deferredGetTask([
        { value: task('2026-10-17T10:00:09.000Z', 'passed'), delayMs: 10 },
        { value: task('2026-10-17T10:00:02.000Z', 'in_progress'), delayMs: 0 },
      ]),
    );
    const setup = makeSetup({ runner: { getTask: getTask as never } });
    const p1 = setup.store.getState().refreshTask('task-1');
    void setup.store.getState().refreshTask('task-1'); // 触发第二次（旧数据）拉取
    await p1;
    await vi.waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
    const t = setup.store.getState().tasks.find((x) => x.id === 'task-1');
    expect(t?.acceptance[0]?.status).toBe('passed'); // 旧快照被 updatedAt 防御拒绝
  });

  it('串行先后调用仍按序应用（正常路径无回归）', async () => {
    const getTask = vi.fn(
      deferredGetTask([
        { value: task('2026-10-17T10:00:01.000Z', 'in_progress'), delayMs: 0 },
        { value: task('2026-10-17T10:00:05.000Z', 'passed'), delayMs: 0 },
      ]),
    );
    const setup = makeSetup({ runner: { getTask: getTask as never } });
    await setup.store.getState().refreshTask('task-1');
    await setup.store.getState().refreshTask('task-1');
    const t = setup.store.getState().tasks.find((x) => x.id === 'task-1');
    expect(t?.acceptance[0]?.status).toBe('passed');
  });
});
