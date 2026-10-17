﻿﻿﻿/**
 * Steer 交互：未送达保留输入并提示原因，不自动重发到新回合；送达才清空并显示追加消息。
 */
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ok } from '../contracts/common';
import type { ForgeDeskBridge } from '../contracts/ipc';
import { Composer, SteerNoticeBanner } from '../components/chat/Composer';
import { makeSetup, renderWithStore } from './test-utils/render';

function renderComposer(steerImpl: ForgeDeskBridge['engine']['steer']) {
  const setup = makeSetup({ engine: { steer: steerImpl } });
  const store = setup.store;
  store.setState({
    liveThreadId: 'th-1',
    engineStatus: 'ready',
    turnRunning: true,
    draft: '补充：也修一下空文件场景',
  });
  renderWithStore(
    <>
      <SteerNoticeBanner />
      <Composer />
    </>,
    setup,
  );
  return setup;
}

describe('Steer 执行中追加指令', () => {
  it('未送达（回合已结束）时保留输入并提示原因，绝不调用 engine.send', async () => {
    const setup = renderComposer(async () => ok({ delivered: false, reason: 'turn_ended' }));
    fireEvent.click(screen.getByTestId('steer-btn'));
    await waitFor(() => expect(screen.getByTestId('steer-notice')).toBeInTheDocument());
    // 输入保留
    expect((screen.getByRole('textbox', { name: '追加指令' }) as HTMLTextAreaElement).value).toBe(
      '补充：也修一下空文件场景',
    );
    // 提示原因
    expect(screen.getByText(/当前回合已结束/)).toBeInTheDocument();
    // 不自动重发到新回合
    expect(setup.bridge.calls.some((c) => c.method === 'engine.send')).toBe(false);
  });

  it('ID 不匹配同样保留输入并提示', async () => {
    renderComposer(async () => ok({ delivered: false, reason: 'id_mismatch' }));
    fireEvent.click(screen.getByTestId('steer-btn'));
    await waitFor(() => expect(screen.getByText(/回合标识不匹配/)).toBeInTheDocument());
  });

  it('送达成功才清空输入，并显示追加指令消息', async () => {
    const setup = makeSetup({ engine: { steer: async () => ok({ delivered: true }) } });
    setup.store.setState({
      liveThreadId: 'th-1',
      engineStatus: 'ready',
      turnRunning: true,
      draft: '追加一点',
    });
    renderWithStore(<Composer />, setup);
    fireEvent.click(screen.getByTestId('steer-btn'));
    await waitFor(() => expect((screen.getByRole('textbox', { name: '追加指令' }) as HTMLTextAreaElement).value).toBe(''));
    const msg = setup.store.getState().conversation.messages.at(-1);
    expect(msg?.kind).toBe('steer');
    expect(msg?.text).toBe('追加一点');
  });

  it('用户显式选择"作为新消息发送"才调用 engine.send', async () => {
    const setup = makeSetup({
      engine: {
        steer: async () => ok({ delivered: false, reason: 'not_running' }),
        send: async () => ok({ turnId: 'turn-2' }),
      },
    });
    setup.store.setState({
      liveThreadId: 'th-1',
      engineStatus: 'ready',
      turnRunning: false,
      steerNotice: { reason: 'not_running', text: '晚点再发' },
    });
    renderWithStore(
      <>
        <SteerNoticeBanner />
        <Composer />
      </>,
      setup,
    );
    fireEvent.click(screen.getByRole('button', { name: '作为新消息发送' }));
    await waitFor(() =>
      expect(setup.bridge.calls.some((c) => c.method === 'engine.send' && (c.args[0] as string) === '晚点再发')).toBe(true),
    );
    expect(setup.store.getState().steerNotice).toBeNull();
  });
});
