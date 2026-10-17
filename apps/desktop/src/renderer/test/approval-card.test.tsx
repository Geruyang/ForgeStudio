﻿﻿﻿/**
 * 审批卡：选项映射（只显示请求允许的选项）与回调；缺失选项不渲染对应按钮。
 */
import { screen, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApprovalCard } from '../components/chat/ApprovalCard';
import type { ApprovalDecision, ApprovalRequestView } from '../contracts/engine';
import { makeSetup, renderWithStore } from './test-utils/render';

function approvalView(partial: { requestId: string; options: ApprovalDecision[] }): ApprovalRequestView {
  return {
    connectionGeneration: 1,
    kind: 'exec_command',
    summary: 'cargo build --release',
    ...partial,
  };
}

function renderApproval(options: ApprovalDecision[]) {
  const setup = makeSetup();
  renderWithStore(
    <ApprovalCard view={{ approval: approvalView({ requestId: 'req-1', options }), resolved: false }} />,
    setup,
  );
  return setup;
}

describe('ApprovalCard 审批卡', () => {
  it('只渲染请求允许的选项按钮', () => {
    renderApproval(['accept', 'decline']);
    expect(screen.getByRole('button', { name: '允许一次' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '拒绝' })).toBeInTheDocument();
    // 未提供的选项不出现
    expect(screen.queryByRole('button', { name: '本会话内允许' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '不执行' })).not.toBeInTheDocument();
  });

  it('选项全部缺失时没有可用决定按钮', () => {
    renderApproval([]);
    expect(screen.queryByRole('button', { name: '允许一次' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '拒绝' })).not.toBeInTheDocument();
  });

  it('点击决定调用 engine.approve(requestId, decision)', async () => {
    const setup = renderApproval(['accept', 'acceptForSession', 'decline', 'cancel']);
    fireEvent.click(screen.getByRole('button', { name: '本会话内允许' }));
    await Promise.resolve();
    const call = setup.bridge.calls.find((c) => c.method === 'engine.approve');
    expect(call).toBeDefined();
    expect(call?.args).toEqual(['req-1', 'acceptForSession']);
  });

  it('拒绝走 decline 决定', async () => {
    const setup = renderApproval(['decline']);
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    await Promise.resolve();
    expect(setup.bridge.calls.find((c) => c.method === 'engine.approve')?.args).toEqual(['req-1', 'decline']);
  });

  it('已处理的审批呈只读结果', () => {
    const setup = makeSetup();
    renderWithStore(
      <ApprovalCard
        view={{
          approval: approvalView({ requestId: 'req-2', options: ['decline'] }),
          resolved: true,
          decision: 'decline',
        }}
      />,
      setup,
    );
    expect(screen.getByText(/已拒绝/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '拒绝' })).not.toBeInTheDocument();
  });
});
