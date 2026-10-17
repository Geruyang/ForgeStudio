/**
 * 中央会话视图：消息流 + 审批卡 + 引擎错误卡 + 未知事件诊断样本 +
 * 回合状态条 + steer 提示 + 输入区 + 首次运行欢迎引导。
 */
import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/context';
import { TokenUsageBar } from '../components/chat/TokenUsageBar';
import { MessageItem } from '../components/chat/MessageItem';
import { ApprovalCard } from '../components/chat/ApprovalCard';
import { TurnStatusBar } from '../components/chat/TurnStatusBar';
import { Composer, SteerNoticeBanner } from '../components/chat/Composer';
import { ErrorDetail } from '../components/common/ErrorDetail';
import { EmptyState } from '../components/common/EmptyState';
import { ForgeMark } from '../components/brand/Logo';

export function ChatView() {
  const conversation = useAppStore((s) => s.conversation);
  const conversationMode = useAppStore((s) => s.conversationMode);
  const restoredComplete = useAppStore((s) => s.restoredComplete);
  const liveThreadId = useAppStore((s) => s.liveThreadId);
  const threads = useAppStore((s) => s.threads);
  const tasks = useAppStore((s) => s.tasks);
  const startNewConversation = useAppStore((s) => s.startNewConversation);
  const setTaskSetupOpen = useAppStore((s) => s.setTaskSetupOpen);
  const tokenUsage = useAppStore((s) => s.tokenUsage);
  const compactThread = useAppStore((s) => s.compactThread);
  const turnRunning = useAppStore((s) => s.turnRunning);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const msgCount = conversation.messages.length;
  const lastLen = conversation.messages[msgCount - 1]?.text.length ?? 0;

  // 跟随流式输出滚动到底部
  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [msgCount, lastLen]);

  const firstRun = threads.length === 0 && tasks.length === 0 && conversation.messages.length === 0;

  return (
    <div className="chat-col">
      {conversationMode === 'restored' && !restoredComplete && (
        <div className="chat-banner chat-banner--incomplete" style={{ margin: '10px 22px 0' }} role="alert">
          历史不完整：重连期间存在事件缺口，缺失消息不伪造。最近消息仅供参考。
        </div>
      )}
      <SteerNoticeBanner />
      {tokenUsage && <TokenUsageBar usage={tokenUsage} />}
      {liveThreadId && conversation.messages.length > 0 && !turnRunning && (
        <div style={{ margin: '4px 22px 0', textAlign: 'right' }}>
          <button
            type="button"
            className="fd-btn fd-btn--ghost fd-btn--small"
            onClick={() => void compactThread()}
            data-testid="compact-thread-btn"
          >
            压缩上下文
          </button>
        </div>
      )}
      <div className="chat-stream" ref={streamRef}>
        {firstRun ? (
          <div className="chat-empty">
            <EmptyState
              title="欢迎使用 ForgeStudio"
              hint={
                <span>
                  一个把代码、固件和真实测试结果一起交付的工程工作台。
                  <br />
                  三步开始：① 设置中配置 API key / 官方登录（认证后即可选择模型）→ ② 选择项目目录 → ③ 发起会话；也可直接创建一张工程验收单。
                </span>
              }
              actions={
                <>
                  <button type="button" className="fd-btn fd-btn--primary" onClick={() => void startNewConversation()}>
                    选择项目并开始会话
                  </button>
                  <button type="button" className="fd-btn" onClick={() => setTaskSetupOpen('create')}>
                    创建工程任务（验收单向导）
                  </button>
                </>
              }
            />
          </div>
        ) : (
          <>
            {conversation.messages.map((m) => (
              <MessageItem key={m.id} message={m} />
            ))}
            {conversation.approvals.map((a) => (
              <ApprovalCard key={a.approval.requestId} view={a} />
            ))}
            {conversation.errors.map((e) => (
              <div className="error-card" key={e.id}>
                <ErrorDetail kind={e.kind} message={e.message} compact />
                {!e.recoverable && (
                  <div style={{ fontSize: 11, color: '#ff8a87' }}>不可恢复：需要重启引擎或检查认证。</div>
                )}
              </div>
            ))}
            {conversation.unknownCount > 0 && (
              <details className="unknown-card">
                <summary style={{ cursor: 'pointer', color: 'var(--text-faint)', fontSize: 11 }}>
                  未识别引擎事件 {conversation.unknownCount} 条（保留样本 {conversation.unknownSamples.length} 条）
                </summary>
                {conversation.unknownSamples.map((s, i) => (
                  <div key={i} style={{ padding: '2px 8px' }}>
                    <span className="fd-code">{s.method}</span>
                    <span style={{ color: 'var(--text-faint)', fontSize: 11 }}> {s.samplePreview}</span>
                  </div>
                ))}
              </details>
            )}
            {conversation.messages.length === 0 && liveThreadId && (
              <div className="fd-empty" style={{ alignSelf: 'center', margin: 'auto' }}>
                <ForgeMark size={32} />
                <div className="fd-empty__title">会话已就绪</div>
                <div className="fd-empty__hint">在下方输入第一个任务；工程面板可随时创建验收单。</div>
              </div>
            )}
          </>
        )}
      </div>
      <TurnStatusBar />
      <Composer />
    </div>
  );
}
