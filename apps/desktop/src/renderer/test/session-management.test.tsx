/**
 * 会话管理（Z1-5）：store 侧 rename/delete/compact 动作与事件、Sidebar 搜索/重命名/删除交互。
 */
import { screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ThreadSummary } from '../contracts/engine';
import { Sidebar } from '../views/Sidebar';
import { makeSetup, renderWithStore } from './test-utils/render';
import { ok } from '../contracts/common';

/** 按方法名取调用参数列表（mock-bridge 的 calls 为扁平数组） */
const argsOf = (calls: Array<{ method: string; args: unknown[] }>, method: string): unknown[][] =>
  calls.filter((c) => c.method === method).map((c) => c.args);

const thread = (over: Partial<ThreadSummary> = {}): ThreadSummary => ({
  threadId: 'th-1',
  projectRoot: 'E:\\proj\\alpha',
  title: '修复空指针问题',
  lastActivityAt: '2026-10-17T10:00:00.000Z',
  complete: true,
  messageCount: 5,
  ...over,
});

describe('store：会话管理动作', () => {
  it('renameThread：调用桥并刷新列表（新标题出现）', async () => {
    const setup = makeSetup({
      session: {
        listThreads: async () => ok([thread({ title: '新名字' })]),
        renameThread: async () => ok(undefined),
      },
    });
    const rename = vi.spyOn(setup.bridge.session, 'renameThread');
    await setup.store.getState().renameThread('th-1', '新名字');
    expect(rename).toHaveBeenCalledWith('th-1', '新名字');
    expect(setup.store.getState().threads.map((t) => t.title)).toContain('新名字');
  });

  it('deleteThread：删除活动会话 → 清空会话视图（activeThreadId/liveThreadId 置空、消息清零）', async () => {
    const setup = makeSetup({
      session: { listThreads: async () => ok([]), deleteThread: async () => ok(undefined) },
    });
    setup.store.setState({
      threads: [thread()],
      activeThreadId: 'th-1',
      liveThreadId: 'th-1',
      conversationMode: 'live',
      conversation: {
        currentTurnId: null,
        turnStatus: 'idle',
        turnDetail: null,
        messages: [
          { seq: 1, role: 'user', text: 'hello', at: '2026-10-17T10:00:00.000Z' },
        ],
        unknownSamples: [],
      } as never,
    });
    await setup.store.getState().deleteThread('th-1');
    const s = setup.store.getState();
    expect(s.activeThreadId).toBeNull();
    expect(s.liveThreadId).toBeNull();
    expect(s.conversationMode).toBe('empty');
    expect(s.conversation.messages).toHaveLength(0);
    expect(s.threads).toHaveLength(0);
  });

  it('deleteThread：删除非活动会话 → 当前会话视图不受影响', async () => {
    const setup = makeSetup({
      session: { listThreads: async () => ok([thread({ threadId: 'th-live' })]), deleteThread: async () => ok(undefined) },
    });
    setup.store.setState({
      threads: [thread({ threadId: 'th-live' }), thread({ threadId: 'th-other' })],
      activeThreadId: 'th-live',
      liveThreadId: 'th-live',
      conversationMode: 'live',
    });
    await setup.store.getState().deleteThread('th-other');
    const s = setup.store.getState();
    expect(s.activeThreadId).toBe('th-live');
    expect(s.threads.map((t) => t.threadId)).toEqual(['th-live']);
  });

  it('compactThread：无进行中会话 → 不调用桥；有会话 → 以 liveThreadId 调用', async () => {
    const setup = makeSetup({ session: { compactThread: async () => ok(undefined) } });
    const compact = vi.spyOn(setup.bridge.session, 'compactThread');
    await setup.store.getState().compactThread();
    expect(compact).not.toHaveBeenCalled();

    setup.store.setState({ liveThreadId: 'th-1' });
    await setup.store.getState().compactThread();
    expect(compact).toHaveBeenCalledWith('th-1');
  });

  it('session/compacted 事件 → terminal 出现压缩完成行', async () => {
    const setup = makeSetup();
    await setup.store.getState().bootstrap();
    setup.bridge.emitEngineEvent({
      seq: 1,
      connectionGeneration: 1,
      emittedAt: '2026-10-17T10:00:00.000Z',
      type: 'session/compacted',
      threadId: 'th-1',
    } as never);
    expect(setup.store.getState().terminal.some((l) => l.text.includes('上下文压缩完成'))).toBe(true);
  });
});

describe('Sidebar：搜索 / 重命名 / 删除交互', () => {
  it('搜索：按标题子串过滤；无结果显示空态', () => {
    const setup = makeSetup();
    setup.store.setState({
      threads: [thread(), thread({ threadId: 'th-2', title: '串口驱动适配', projectRoot: 'E:\\proj\\beta' })],
    });
    renderWithStore(<Sidebar />, setup);
    expect(screen.getAllByTestId('thread-item')).toHaveLength(2);
    fireEvent.change(screen.getByTestId('thread-search'), { target: { value: '串口' } });
    expect(screen.getAllByTestId('thread-item')).toHaveLength(1);
    expect(screen.getByTestId('thread-item')).toHaveTextContent('串口驱动适配');
    fireEvent.change(screen.getByTestId('thread-search'), { target: { value: '不存在的关键词' } });
    expect(screen.getByTestId('thread-search-empty')).toBeInTheDocument();
  });

  it('重命名：点击按钮 → 行内输入 → Enter 提交调用 store 动作', async () => {
    const setup = makeSetup({
      session: { renameThread: async () => ok(undefined), listThreads: async () => ok([]) },
    });
    setup.store.setState({ threads: [thread()] });
    renderWithStore(<Sidebar />, setup);
    fireEvent.click(screen.getByTestId('thread-rename-btn'));
    const input = screen.getByTestId('thread-rename-input');
    expect((input as HTMLInputElement).value).toBe('修复空指针问题');
    fireEvent.change(input, { target: { value: '改名为部署问题' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await vi.waitFor(() =>
      expect(argsOf(setup.bridge.calls, 'session.renameThread')).toContainEqual(['th-1', '改名为部署问题']),
    );
  });

  it('删除：两步确认 → 调用 store 动作；取消不删除', async () => {
    const setup = makeSetup({
      session: { deleteThread: async () => ok(undefined), listThreads: async () => ok([]) },
    });
    setup.store.setState({ threads: [thread()] });
    renderWithStore(<Sidebar />, setup);
    fireEvent.click(screen.getByTestId('thread-delete-btn'));
    expect(argsOf(setup.bridge.calls, 'session.deleteThread')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('thread-delete-confirm'));
    await vi.waitFor(() => expect(argsOf(setup.bridge.calls, 'session.deleteThread')).toContainEqual(['th-1']));

    // 取消路径
    fireEvent.click(screen.getByTestId('thread-delete-btn'));
    fireEvent.click(screen.getByTestId('thread-delete-cancel'));
    expect(screen.queryByTestId('thread-delete-confirm')).not.toBeInTheDocument();
  });
});
