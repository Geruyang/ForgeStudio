/**
 * ErrorBoundary（Z4 安全加固）回归：渲染层组件抛异常 → 错误页呈现 + 重新加载恢复。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from '../components/common/ErrorBoundary';

/** 简单爆炸：always throws */
function AlwaysBomb(): never {
  throw new Error('永远爆炸');
}

describe('ErrorBoundary：渲染异常不白屏', () => {
  const origError = console.error;
  beforeEach(() => { console.error = () => undefined; });
  afterEach(() => { console.error = origError; });

  it('子组件抛异常 → 错误页呈现（含技术详情 + 重新加载按钮）', () => {
    render(
      <ErrorBoundary>
        <AlwaysBomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText('界面出现异常')).toBeInTheDocument();
    expect(screen.getByTestId('error-boundary-reload')).toBeInTheDocument();
    expect(screen.queryByTestId('normal-content')).not.toBeInTheDocument();
  });

  it('正常子组件 → 直接透传', () => {
    render(
      <ErrorBoundary>
        <div data-testid="normal-content">正常</div>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('normal-content')).toBeInTheDocument();
    expect(screen.queryByText('界面出现异常')).not.toBeInTheDocument();
  });

  it('错误页 → 卸载后重渲染正常内容（换页/恢复路径）', () => {
    const r1 = render(
      <ErrorBoundary>
        <AlwaysBomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText('界面出现异常')).toBeInTheDocument();
    console.error = origError;
    r1.unmount();

    const r2 = render(
      <ErrorBoundary>
        <div data-testid="normal-content">恢复</div>
      </ErrorBoundary>,
    );
    expect(r2.getByTestId('normal-content')).toBeInTheDocument();
    expect(r2.queryByText('界面出现异常')).not.toBeInTheDocument();
  });
});
