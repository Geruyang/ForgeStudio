/**
 * 代码审阅面板（Z4 可选 1）回归：
 * - 投影：startReview 置待归属标记 → turn/started 归属审阅回合 → turn/completed 更新终态；
 *   用户发送的回合不被误标；startReview 失败清除标记。
 * - 面板：状态徽标 / 报告正文 / 涉及文件（补丁卡）呈现；无审阅不渲染。
 */
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import type { EngineEvent } from '../contracts/engine';
import { ok } from '../contracts/common';
import { createAppStore } from '../store/store';
import { ReviewPanel } from '../components/chat/ReviewPanel';
import { makeSetup, renderWithStore } from './test-utils/render';

let seq = 0;
function ev<T extends Omit<EngineEvent, 'seq' | 'connectionGeneration' | 'emittedAt'>>(e: T): EngineEvent {
  seq += 1;
  return { seq, connectionGeneration: 1, emittedAt: '2026-10-18T20:00:00.000Z', threadId: 'th-1', ...e } as EngineEvent;
}

async function setupLive() {
  const setup = makeSetup({
    engine: {
      review: async () => ok(undefined),
      send: async () => ok({ turnId: 't-ok' }),
    },
  });
  await setup.store.getState().bootstrap();
  setup.store.setState({ liveThreadId: 'th-1' });
  return setup;
}

describe('审阅回合归属（投影）', () => {
  it('startReview → 下一个 turn/started 归属审阅；turn/completed 更新终态', async () => {
    const { store, bridge } = await setupLive();
    await store.getState().startReview();
    expect(store.getState().conversation.reviewPending).toBe(true);
    bridge.emitEngineEvent(ev({ type: 'turn/started', turnId: 't-r', inputPreview: 'review' }));
    expect(store.getState().conversation.reviewPending).toBe(false);
    let review = store.getState().conversation.reviews[0]!;
    expect(review.turnId).toBe('t-r');
    expect(review.status).toBe('running');
    bridge.emitEngineEvent(ev({ type: 'turn/completed', turnId: 't-r', status: 'success' }));
    review = store.getState().conversation.reviews[0]!;
    expect(review.status).toBe('success');
  });

  it('用户发送的回合不归属审阅（待归属标记被清除）', async () => {
    const setup = await setupLive();
    const { store, bridge } = setup;
    await store.getState().startReview();
    store.setState({ draft: '普通提问' });
    await store.getState().sendDraft();
    expect(store.getState().conversation.reviewPending).toBe(false);
    bridge.emitEngineEvent(ev({ type: 'turn/started', turnId: 't-user', inputPreview: '普通提问' }));
    expect(store.getState().conversation.reviews).toHaveLength(0);
  });

  it('startReview 桥失败 → 清除标记；后续回合不误标', async () => {
    const setup = makeSetup(); // review 未配置 → 测试桥失败
    setup.store.setState({ liveThreadId: 'th-1' });
    await setup.store.getState().startReview();
    expect(setup.store.getState().conversation.reviewPending).toBe(false);
    setup.bridge.emitEngineEvent(ev({ type: 'turn/started', turnId: 't-x', inputPreview: '' }));
    expect(setup.store.getState().conversation.reviews).toHaveLength(0);
  });
});

describe('ReviewPanel 渲染', () => {
  it('完成的审阅：状态徽标 + 报告正文 + 补丁卡（涉及文件）', async () => {
    const { store, bridge } = await setupLive();
    await store.getState().startReview();
    bridge.emitEngineEvent(ev({ type: 'turn/started', turnId: 't-rev', inputPreview: 'review' }));
    bridge.emitEngineEvent(ev({ type: 'message/delta', turnId: 't-rev', delta: '审阅结论：两处问题，见补丁。' }));
    bridge.emitEngineEvent(
      ev({
        type: 'patch/applied',
        turnId: 't-rev',
        files: [{ path: 'src/a.ts', changeType: 'modified' }],
        patchRef: 'patch-g1-1',
        additions: 3,
        deletions: 1,
      }),
    );
    bridge.emitEngineEvent(ev({ type: 'turn/completed', turnId: 't-rev', status: 'success' }));

    renderWithStore(<ReviewPanel />, { bridge, store });
    expect(screen.getByTestId('review-panel')).toBeInTheDocument();
    expect(screen.getByText('审阅完成')).toBeInTheDocument();
    expect(screen.getByText('审阅结论：两处问题，见补丁。')).toBeInTheDocument();
    expect(screen.getByText('代码修改 · 1 个文件')).toBeInTheDocument();
    expect(screen.getByTestId('review-card-success')).toBeInTheDocument();
  });

  it('运行中的审阅：徽标「审阅中」+ 提示文案；不显示报告', async () => {
    const { store, bridge } = await setupLive();
    await store.getState().startReview();
    bridge.emitEngineEvent(ev({ type: 'turn/started', turnId: 't-rev2', inputPreview: 'review' }));
    renderWithStore(<ReviewPanel />, { bridge, store });
    expect(screen.getByText('审阅中')).toBeInTheDocument();
    expect(screen.getByText('审阅进行中，报告将在回合结束后呈现。')).toBeInTheDocument();
  });

  it('失败的审阅：徽标「审阅失败」+ 失败详情', async () => {
    const { store, bridge } = await setupLive();
    await store.getState().startReview();
    bridge.emitEngineEvent(ev({ type: 'turn/started', turnId: 't-rev3', inputPreview: 'review' }));
    bridge.emitEngineEvent(ev({ type: 'turn/completed', turnId: 't-rev3', status: 'failure', detail: '引擎内部错误（模拟）' }));
    renderWithStore(<ReviewPanel />, { bridge, store });
    expect(screen.getByText('审阅失败')).toBeInTheDocument();
    expect(screen.getByText('引擎内部错误（模拟）')).toBeInTheDocument();
  });

  it('无审阅 → 不渲染面板', () => {
    const setup = makeSetup();
    const r = renderWithStore(<ReviewPanel />, setup);
    expect(r.queryByTestId('review-panel')).not.toBeInTheDocument();
  });
});
