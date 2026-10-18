/**
 * MessageItem 长文本折叠（深度审查 D7）：巨型助手输出防 DOM 爆炸；
 * 流式中不折叠；用户消息不折叠；展开按钮恢复全文。
 */
import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MessageItem } from '../components/chat/MessageItem';
import type { UiMessage } from '../lib/events';

const msg = (over: Partial<UiMessage>): UiMessage => ({
  role: 'assistant',
  seq: 1,
  at: '2026-10-18T10:00:00.000Z',
  text: '',
  toolCalls: [],
  patches: [],
  streaming: false,
  ...over,
} as UiMessage);

describe('MessageItem：长文本折叠', () => {
  it('超过 4000 字符的非流式助手消息 → 折叠预览 + 展开按钮；点击后全文', () => {
    const long = 'x'.repeat(9000);
    const { container } = render(<MessageItem message={msg({ text: long })} />);
    const body = container.querySelector('.msg__body')!;
    expect(body.textContent!.length).toBeLessThan(3000); // 折叠为预览
    const btn = screen.getByTestId('msg-expand-btn');
    expect(btn.textContent).toContain('9000');
    fireEvent.click(btn);
    expect(container.querySelector('.msg__body')!.textContent!.length).toBeGreaterThan(8500);
  });

  it('流式中与用户消息不折叠', () => {
    const long = 'y'.repeat(9000);
    const { container: c1 } = render(<MessageItem message={msg({ text: long, streaming: true })} />);
    expect(c1.querySelector('.msg__body')!.textContent!.length).toBeGreaterThan(8500);
    expect(screen.queryByTestId('msg-expand-btn')).not.toBeInTheDocument();
    const { container: c2 } = render(<MessageItem message={msg({ role: 'user', text: long })} />);
    expect(c2.querySelector('.msg__body')!.textContent!.length).toBeGreaterThan(8500);
  });

  it('短消息无折叠按钮', () => {
    render(<MessageItem message={msg({ text: '正常长度' })} />);
    expect(screen.queryByTestId('msg-expand-btn')).not.toBeInTheDocument();
  });
});
