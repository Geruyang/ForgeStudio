﻿﻿﻿﻿﻿﻿﻿/**
 * 验收面板：各状态渲染 + 过期徽标；通过/未通过判定由 contracts.computeTaskAcceptance 驱动。
 */
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { computeTaskAcceptance } from '../contracts/engineering';
import { ok } from '../contracts/common';
import { AcceptanceList } from '../components/eng/AcceptanceList';
import { makeAcceptance, makeTaskOverview } from './test-utils/fixtures';
import { makeSetup, renderWithStore } from './test-utils/render';

function renderAcceptance(
  items: ReturnType<typeof makeAcceptance>[],
  hasStaleEvidence = false,
) {
  const task = makeTaskOverview({ id: 'task-1', acceptance: items, hasStaleEvidence });
  const setup = makeSetup();
  setup.store.setState({ tasks: [task], activeTaskId: 'task-1' });
  renderWithStore(<AcceptanceList task={task} />, setup);
  return { setup, task };
}

describe('验收面板 AcceptanceList', () => {
  it('渲染各状态：待执行/通过/失败/证据过期/模型提议', () => {
    renderAcceptance([
      makeAcceptance({ id: 'acc-1', taskId: 'task-1', title: '构建通过', status: 'pending', order: 1 }),
      makeAcceptance({ id: 'acc-2', taskId: 'task-1', title: '固定测试', status: 'passed', order: 2 }),
      makeAcceptance({ id: 'acc-3', taskId: 'task-1', title: '串口验证', status: 'failed', order: 3 }),
      makeAcceptance({ id: 'acc-4', taskId: 'task-1', title: '烧录回执', status: 'stale', order: 4 }),
      makeAcceptance({ id: 'acc-5', taskId: 'task-1', title: '模型新提议', status: 'proposed', order: 5 }),
    ]);
    expect(screen.getByText('待执行')).toBeInTheDocument();
    expect(screen.getAllByText('通过').length).toBeGreaterThan(0);
    expect(screen.getByText('失败')).toBeInTheDocument();
    expect(screen.getByText('证据过期')).toBeInTheDocument();
    expect(screen.getByText('模型提议 · 未采纳')).toBeInTheDocument();
  });

  it('必需项全部通过且证据未过期 → 验收通过（computeTaskAcceptance 驱动）', () => {
    const items = [
      makeAcceptance({ id: 'acc-1', taskId: 'task-1', status: 'passed', required: true, order: 1 }),
      makeAcceptance({ id: 'acc-2', taskId: 'task-1', status: 'passed', required: true, order: 2 }),
      makeAcceptance({ id: 'acc-3', taskId: 'task-1', status: 'pending', required: false, order: 3 }),
    ];
    const judge = computeTaskAcceptance({ acceptance: items, stale: false });
    expect(judge).toMatchObject({ passed: true, passedCount: 2, requiredTotal: 2, stale: false });
    renderAcceptance(items, false);
    expect(screen.getByTestId('acceptance-judge')).toHaveTextContent('验收通过');
    expect(screen.getByText('必需项 2/2 通过')).toBeInTheDocument();
  });

  it('有必需项未通过 → 验收未通过', () => {
    const items = [
      makeAcceptance({ id: 'acc-1', taskId: 'task-1', status: 'passed', required: true, order: 1 }),
      makeAcceptance({ id: 'acc-2', taskId: 'task-1', status: 'failed', required: true, order: 2 }),
    ];
    expect(computeTaskAcceptance({ acceptance: items, stale: false }).passed).toBe(false);
    renderAcceptance(items);
    expect(screen.getByTestId('acceptance-judge')).toHaveTextContent('验收未通过');
  });

  it('即使全部通过，hasStaleEvidence=true → 显示证据过期徽标且不点亮通过', () => {
    const items = [makeAcceptance({ id: 'acc-1', taskId: 'task-1', status: 'passed', required: true, order: 1 })];
    const judge = computeTaskAcceptance({ acceptance: items, stale: true });
    expect(judge.passed).toBe(false);
    expect(judge.stale).toBe(true);
    renderAcceptance(items, true);
    expect(screen.getByTestId('acceptance-judge')).toHaveTextContent('证据过期，需重新验证');
  });

  it('模型提议项需人工采纳：提供采纳按钮且标注不计入验收', () => {
    renderAcceptance([
      makeAcceptance({ id: 'acc-1', taskId: 'task-1', title: '提议项', status: 'proposed', order: 1 }),
    ]);
    expect(screen.getByRole('button', { name: '采纳' })).toBeInTheDocument();
    expect(screen.getByText(/未采纳前不计入验收/)).toBeInTheDocument();
  });

  it('可执行项带 verifierId 才显示"运行验证"', () => {
    renderAcceptance([
      makeAcceptance({ id: 'acc-1', taskId: 'task-1', kind: 'executable', verifierId: 'software.build-pass', order: 1 }),
      makeAcceptance({ id: 'acc-2', taskId: 'task-1', kind: 'manual', manualRequired: true, order: 2 }),
    ]);
    expect(screen.getAllByTestId('run-verifier').length).toBe(1);
  });

  it('manual 项渲染人工验收按钮：确认通过走 confirm 二次确认，标记不通过直接调用', () => {
    const items = [
      makeAcceptance({ id: 'acc-m', taskId: 'task-1', kind: 'manual', manualRequired: true, title: '人工检查', status: 'pending', required: true, order: 1 }),
    ];
    const task = makeTaskOverview({ id: 'task-1', acceptance: items });
    const setup = makeSetup({
      runner: { manualReview: async () => ok(items) },
    });
    setup.store.setState({ tasks: [task], activeTaskId: 'task-1' });
    renderWithStore(<AcceptanceList task={task} />, setup);

    const passBtn = screen.getByTestId('manual-pass-btn');
    const failBtn = screen.getByTestId('manual-fail-btn');

    // confirm 拒绝 → 不调用
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(passBtn);
    expect(setup.bridge.calls.filter((c) => c.method === 'runner.manualReview')).toHaveLength(0);

    // confirm 确认 → manualReview(taskId, itemId, 'passed')
    confirmSpy.mockReturnValue(true);
    fireEvent.click(passBtn);
    const manualCalls = setup.bridge.calls.filter((c) => c.method === 'runner.manualReview');
    expect(manualCalls).toHaveLength(1);
    expect(manualCalls[0].args.slice(0, 3)).toEqual(['task-1', 'acc-m', 'passed']);

    // 标记不通过 → 不走 confirm，直接判定 failed
    confirmSpy.mockClear();
    fireEvent.click(failBtn);
    const manualCalls2 = setup.bridge.calls.filter((c) => c.method === 'runner.manualReview');
    expect(manualCalls2).toHaveLength(2);
    expect(manualCalls2[1].args.slice(0, 3)).toEqual(['task-1', 'acc-m', 'failed']);
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  // ---- 验收单全量替换语义回归（毁单缺陷防护：runner updateAcceptance 未提交的项会被删除） ----
  function acceptancePayloadOf(setup: ReturnType<typeof makeSetup>) {
    const call = setup.bridge.calls.find((c) => c.method === 'runner.updateAcceptance');
    return call ? (call.args[1] as Array<Record<string, unknown>>) : null;
  }

  it('追加验收项：payload 为全量（现有项带 id 保留状态 + 新项）——只传增量会删光其余项', async () => {
    const existing = [
      makeAcceptance({ id: 'acc-1', taskId: 'task-1', title: '构建', status: 'passed', required: true, order: 1 }),
      makeAcceptance({ id: 'acc-2', taskId: 'task-1', title: '测试', status: 'failed', required: true, order: 2 }),
    ];
    const task = makeTaskOverview({ id: 'task-1', acceptance: existing });
    const setup = makeSetup({ runner: { updateAcceptance: async () => ok(existing) } });
    setup.store.setState({ tasks: [task], activeTaskId: 'task-1' });
    await setup.store.getState().addAcceptanceItems('task-1', [
      { kind: 'manual', title: '新项', expected: '标准', manualRequired: true, required: true },
    ]);
    const payload = acceptancePayloadOf(setup);
    expect(payload).not.toBeNull();
    expect(payload).toHaveLength(3);
    // 现有项带 id 且不传 status（由 runner 保留真实状态，passed 等不可直接写入）
    expect(payload?.[0]).toMatchObject({ id: 'acc-1', title: '构建' });
    expect(payload?.[0]).not.toHaveProperty('status');
    expect(payload?.[1]).toMatchObject({ id: 'acc-2', title: '测试' });
    // 新项不带 id
    expect(payload?.[2]).toMatchObject({ kind: 'manual', title: '新项' });
    expect(payload?.[2]).not.toHaveProperty('id');
  });

  it('移除验收项：payload 为除被删项外的全部现有项（不再依赖 runner 不消费的 remove 字段）', async () => {
    const existing = [
      makeAcceptance({ id: 'acc-1', taskId: 'task-1', title: '构建', status: 'passed', order: 1 }),
      makeAcceptance({ id: 'acc-2', taskId: 'task-1', title: '测试', status: 'pending', order: 2 }),
    ];
    const task = makeTaskOverview({ id: 'task-1', acceptance: existing });
    const setup = makeSetup({ runner: { updateAcceptance: async () => ok([existing[0]]) } });
    setup.store.setState({ tasks: [task], activeTaskId: 'task-1' });
    await setup.store.getState().removeAcceptanceItem('task-1', existing[1]);
    const payload = acceptancePayloadOf(setup);
    expect(payload).toHaveLength(1);
    expect(payload?.[0]).toMatchObject({ id: 'acc-1', title: '构建' });
    expect(JSON.stringify(payload)).not.toContain('remove');
  });

  it('采纳提议项：payload 为全量 + 该项 status=pending、required=true', async () => {
    const existing = [
      makeAcceptance({ id: 'acc-1', taskId: 'task-1', title: '既有', status: 'passed', order: 1 }),
      makeAcceptance({ id: 'acc-p', taskId: 'task-1', title: '提议', status: 'proposed', required: false, order: 2 }),
    ];
    const task = makeTaskOverview({ id: 'task-1', acceptance: existing });
    const setup = makeSetup({ runner: { updateAcceptance: async () => ok(existing) } });
    setup.store.setState({ tasks: [task], activeTaskId: 'task-1' });
    await setup.store.getState().adoptAcceptanceItem('task-1', existing[1]);
    const payload = acceptancePayloadOf(setup);
    expect(payload).toHaveLength(2);
    expect(payload?.[0]).toMatchObject({ id: 'acc-1' });
    expect(payload?.[0]).not.toHaveProperty('status');
    expect(payload?.[1]).toMatchObject({ id: 'acc-p', status: 'pending', required: true });
  });
});
