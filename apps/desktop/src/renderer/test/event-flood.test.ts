﻿﻿﻿/**
 * 事件洪峰：缓冲有界（淘汰可替代中间投影并计数），审批请求与回合终态不丢弃。
 */
import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../contracts/engine';
import { EventBatcher, isDroppableEngineEvent } from '../lib/events';
import { createAppStore } from '../store/store';
import { createMockBridge } from './test-utils/mock-bridge';

let seq = 0;
function ev<T extends Omit<EngineEvent, 'seq' | 'connectionGeneration' | 'emittedAt'>>(e: T): EngineEvent {
  seq += 1;
  return { seq, connectionGeneration: 1, emittedAt: '2026-10-14T10:00:00.000Z', ...e } as EngineEvent;
}

describe('EventBatcher 有界缓冲', () => {
  it('超限淘汰最旧的可替代投影并计数', () => {
    const flushed: EngineEvent[] = [];
    let dropped = 0;
    const batcher = new EventBatcher<EngineEvent>(
      (items) => flushed.push(...items),
      { maxQueue: 10, isDroppable: isDroppableEngineEvent, onDropped: () => (dropped += 1), schedule: () => () => undefined },
    );
    for (let i = 0; i < 100; i++) batcher.push(ev({ type: 'message/delta', delta: `d${i}` }));
    batcher.flushPending();
    // 容量 10：淘汰 90 条 delta，最终只剩最后 10 条
    expect(dropped).toBe(90);
    expect(flushed.length).toBe(10);
    expect(flushed[0]).toMatchObject({ type: 'message/delta', delta: 'd90' });
  });

  it('审批/终态事件永不淘汰：队列全是关键事件时整体冲刷背压', () => {
    const flushed: EngineEvent[] = [];
    const batcher = new EventBatcher<EngineEvent>(
      (items) => flushed.push(...items),
      { maxQueue: 5, isDroppable: isDroppableEngineEvent, schedule: () => () => undefined },
    );
    for (let i = 0; i < 20; i++) {
      batcher.push(ev({ type: 'approval/requested', approval: { requestId: `r${i}`, connectionGeneration: 1, kind: 'exec_command', summary: 'x', options: ['accept'] } }));
    }
    batcher.flushPending();
    expect(flushed.length).toBe(20);
    expect(flushed.filter((e) => e.type === 'approval/requested').length).toBe(20);
  });
});

describe('store 事件洪峰集成', () => {
  it('delta 洪峰下审批与回合终态不丢，丢弃计数增长', async () => {
    const pending: Array<() => void> = [];
    const bridge = createMockBridge();
    const store = createAppStore(bridge, {
      eventBatching: {
        maxQueue: 64,
        schedule: (fn) => {
          pending.push(fn);
          return () => undefined;
        },
      },
    });
    await store.getState().bootstrap(); // 订阅 engine 事件

    // 洪峰：2000 条 delta 中穿插审批与终态
    for (let i = 0; i < 2000; i++) {
      bridge.emitEngineEvent(ev({ type: 'message/delta', delta: `chunk-${i};` }));
      if (i === 500 || i === 1500) {
        bridge.emitEngineEvent(
          ev({
            type: 'approval/requested',
            approval: { requestId: `req-${i}`, connectionGeneration: 1, kind: 'exec_command', summary: 'cargo build', options: ['accept', 'decline'] },
          }),
        );
      }
    }
    bridge.emitEngineEvent(ev({ type: 'message/created', role: 'assistant', text: '最终消息' }));
    bridge.emitEngineEvent(ev({ type: 'turn/completed', turnId: 't1', status: 'interrupted' }));

    // 手动冲刷（deferred 调度）
    for (const fn of [...pending]) fn();

    const s = store.getState();
    // 两条审批全部保留
    expect(s.conversation.approvals.map((a) => a.approval.requestId).sort()).toEqual(['req-1500', 'req-500']);
    // 回合终态保留
    expect(s.conversation.turnStatus).toBe('interrupted');
    // 最终文本由终值消息替代，不因 delta 丢失误码
    expect(s.conversation.messages.some((m) => m.text === '最终消息')).toBe(true);
    // 中间投影被淘汰且计数
    expect(s.droppedEvents).toBeGreaterThan(1000);
    store.getState().destroy();
  });
});
