/**
 * token 用量呈现（Z1-3 回归）：
 * - store：usage/updated 置 tokenUsage；session/started 清残留（会话切换不显示旧线程用量）
 * - TokenUsageBar：数字格式化（999 / 1.5k / 250k）、零值分项隐藏、totalTokens=0 整条不渲染
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { EngineEvent, TokenUsageSummary } from '../contracts/engine';
import { createAppStore } from '../store/store';
import { TokenUsageBar, fmtTokens } from '../components/chat/TokenUsageBar';
import { createMockBridge } from './test-utils/mock-bridge';

let seq = 0;
function ev<T extends Omit<EngineEvent, 'seq' | 'connectionGeneration' | 'emittedAt'>>(e: T): EngineEvent {
  seq += 1;
  return { seq, connectionGeneration: 1, emittedAt: '2026-10-17T10:00:00.000Z', ...e } as EngineEvent;
}

const usage = (over: Partial<TokenUsageSummary> = {}): TokenUsageSummary => ({
  totalTokens: 12500,
  inputTokens: 9000,
  cachedInputTokens: 4000,
  outputTokens: 3500,
  reasoningOutputTokens: 1500,
  modelContextWindow: 272000,
  ...over,
});

describe('store：tokenUsage 生命周期', () => {
  it('usage/updated → tokenUsage 更新为事件值', async () => {
    const bridge = createMockBridge();
    const store = createAppStore(bridge, { eventBatching: 'immediate' });
    await store.getState().bootstrap();
    bridge.emitEngineEvent(ev({ type: 'usage/updated', usage: usage() }));
    expect(store.getState().tokenUsage).toEqual(usage());
  });

  it('session/started → 清上一线程用量（修复：切换会话不残留旧值）', async () => {
    const bridge = createMockBridge();
    const store = createAppStore(bridge, { eventBatching: 'immediate' });
    await store.getState().bootstrap();
    bridge.emitEngineEvent(ev({ type: 'usage/updated', usage: usage() }));
    expect(store.getState().tokenUsage).not.toBeNull();
    bridge.emitEngineEvent(ev({ type: 'session/started', threadId: 'th-new' }));
    expect(store.getState().tokenUsage).toBeNull();
  });
});

describe('TokenUsageBar 渲染', () => {
  it('完整字段：入/出/缓存/思考 + 上下文窗口，格式化后展示', () => {
    render(<TokenUsageBar usage={usage()} />);
    const bar = screen.getByTestId('token-usage-bar');
    expect(bar.textContent).toBe('本回合 Token：入 9k · 出 3.5k · 缓存 4k · 思考 1.5k · 上下文窗口 272k');
  });

  it('零值分项与未知窗口不显示', () => {
    render(
      <TokenUsageBar
        usage={usage({ cachedInputTokens: 0, reasoningOutputTokens: 0, modelContextWindow: null })}
      />,
    );
    expect(screen.getByTestId('token-usage-bar').textContent).toBe('本回合 Token：入 9k · 出 3.5k');
  });

  it('totalTokens=0 → 整条不渲染', () => {
    const { container } = render(<TokenUsageBar usage={usage({ totalTokens: 0 })} />);
    expect(container.querySelector('[data-testid="token-usage-bar"]')).toBeNull();
  });

  it('fmtTokens：999→"999"，1500→"1.5k"，100000→"100k"，250000→"250k"', () => {
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(1500)).toBe('1.5k');
    expect(fmtTokens(100000)).toBe('100k');
    expect(fmtTokens(250000)).toBe('250k');
  });
});
