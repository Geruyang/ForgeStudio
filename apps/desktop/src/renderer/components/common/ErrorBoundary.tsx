/**
 * 全局 React 错误边界（Z4 安全加固）：渲染层任何组件抛异常时呈现可恢复的错误页
 * 而非整窗白屏。错误详情折叠呈现（技术信息不吓用户，但可诊断）；
 * 「重新加载」按钮恢复到初始视图（不清数据——数据在主进程 SQLite，不受渲染层影响）。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: string;
  resetKey: number;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, info: '', resetKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // 仅本地呈现，不上报（无遥测）；componentStack 供诊断
    this.setState({ info: errorInfo.componentStack ?? '' });
    console.error('[ErrorBoundary]', error.message, errorInfo.componentStack);
  }

  private handleReload = () => {
    // React 错误边界重置：必须通过 key 变化强制卸载重建子树（单纯清 error 不够——
    // React 内部已标记该子树出错，不会重新渲染；key 变更使子树全新挂载）
    this.setState((s) => ({ error: null, info: '', resetKey: s.resetKey + 1 }));
  };

  override render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 48, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <h2 style={{ color: 'var(--danger, #ff6b6b)' }}>界面出现异常</h2>
          <p style={{ color: 'var(--text-faint, #999)', maxWidth: 480, textAlign: 'center' }}>
            渲染层组件抛出了异常。工程数据（任务/证据/设置）保存在本地数据库，不受影响。
            点击重新加载恢复界面。
          </p>
          <details style={{ maxWidth: 600 }}>
            <summary style={{ cursor: 'pointer', color: 'var(--text-faint)', fontSize: 12 }}>
              技术详情（{this.state.error.message}）
            </summary>
            <pre className="fd-pre" style={{ fontSize: 11, marginTop: 8, maxHeight: 200, overflow: 'auto' }}>
              {this.state.info}
            </pre>
          </details>
          <button
            type="button"
            className="fd-btn fd-btn--primary"
            onClick={this.handleReload}
            data-testid="error-boundary-reload"
          >
            重新加载
          </button>
        </div>
      );
    }
    return <div key={this.state.resetKey}>{this.props.children}</div>;
  }
}
