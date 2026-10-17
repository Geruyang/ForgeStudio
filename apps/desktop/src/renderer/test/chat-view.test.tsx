/**
 * 首次运行欢迎引导 + 会话消息流渲染（用户/助手气泡、流式合并、恢复态不完整提示）。
 */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChatView } from '../views/ChatView';
import { makeSetup, renderWithStore } from './test-utils/render';

describe('ChatView 会话视图', () => {
  it('首次运行（无会话/无任务/无消息）显示欢迎引导', () => {
    const setup = makeSetup();
    renderWithStore(<ChatView />, setup);
    expect(screen.getByText('欢迎使用 ForgeStudio')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /选择项目并开始会话/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /创建工程任务/ })).toBeInTheDocument();
  });

  it('恢复的历史不完整时显示不完整横幅（不伪造缺失消息）', () => {
    const setup = makeSetup();
    setup.store.setState({
      conversationMode: 'restored',
      restoredComplete: false,
      threads: [{ threadId: 'th-1', projectRoot: 'E:\\proj', title: '历史会话', lastActivityAt: '2026-10-14T09:00:00Z', complete: false, messageCount: 3 }],
    });
    renderWithStore(<ChatView />, setup);
    expect(screen.getByText(/历史不完整/)).toBeInTheDocument();
  });

  it('用户/助手气泡与流式光标状态渲染', () => {
    const setup = makeSetup();
    setup.store.getState().applyEngineEvent({
      seq: 1,
      connectionGeneration: 1,
      emittedAt: '2026-10-14T10:00:00.000Z',
      type: 'message/created',
      role: 'user',
      text: '修复空输入崩溃',
    });
    setup.store.getState().applyEngineEvent({
      seq: 2,
      connectionGeneration: 1,
      emittedAt: '2026-10-14T10:00:01.000Z',
      type: 'message/delta',
      delta: '正在定位…',
    });
    renderWithStore(<ChatView />, setup);
    expect(screen.getByText('修复空输入崩溃')).toBeInTheDocument();
    expect(screen.getByText('正在定位…')).toBeInTheDocument();
    expect(screen.getByText(/ForgeStudio 引擎/)).toBeInTheDocument();
  });
});
