﻿﻿﻿/**
 * 停止按钮两段式：点击 → stopping（禁用重复点击）→ turn/completed(interrupted) 才显示已停止。
 */
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ok } from '../contracts/common';
import { TurnStatusBar } from '../components/chat/TurnStatusBar';
import { makeSetup, renderWithStore } from './test-utils/render';

describe('停止按钮两段式', () => {
  it('执行中点击停止 → stopping 中间态禁用；收到 turn/completed(interrupted) → 显示已停止', async () => {
    const setup = makeSetup({ engine: { interrupt: async () => ok(undefined) } });
    const store = setup.store;
    store.setState({ liveThreadId: 'th-1', engineStatus: 'ready', turnRunning: true, stopPhase: 'idle' });
    renderWithStore(<TurnStatusBar />, setup);

    const stopBtn = screen.getByTestId('stop-btn');
    expect(stopBtn).toHaveTextContent('停止');
    fireEvent.click(stopBtn);
    await waitFor(() => expect(store.getState().stopPhase).toBe('stopping'));
    expect(screen.getByTestId('stop-btn')).toBeDisabled();
    expect(screen.getByTestId('stop-btn')).toHaveTextContent('停止中…');

    // 引擎确认中断（终态事件）后才算停止
    store.getState().applyEngineEvent({
      seq: 1,
      connectionGeneration: 1,
      emittedAt: '2026-10-14T10:00:00.000Z',
      type: 'turn/completed',
      turnId: 't1',
      status: 'interrupted',
    });
    await waitFor(() => expect(store.getState().turnRunning).toBe(false));
    expect(screen.getByText('已停止')).toBeInTheDocument();
    // 已停止后不再显示停止按钮
    expect(screen.queryByTestId('stop-btn')).not.toBeInTheDocument();
  });

  it('stopping 期间重复点击不再触发 interrupt', async () => {
    let interruptCalls = 0;
    const setup = makeSetup({
      engine: {
        interrupt: async () => {
          interruptCalls += 1;
          return ok(undefined);
        },
      },
    });
    const store = setup.store;
    store.setState({ turnRunning: true, stopPhase: 'stopping' });
    renderWithStore(<TurnStatusBar />, setup);
    expect(screen.getByTestId('stop-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('stop-btn'));
    await Promise.resolve();
    expect(interruptCalls).toBe(0);
  });
});
