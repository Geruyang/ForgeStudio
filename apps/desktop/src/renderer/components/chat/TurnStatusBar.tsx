/**
 * 回合状态条：执行中 / 成功 / 失败 / 中断；停止按钮两段式
 * （stopping 中间态 → turn/completed(interrupted) 才显示已停止，期间禁用重复点击）。
 */
import type { ConversationState } from '../../lib/events';
import { useAppStore } from '../../store/context';
import { Badge } from '../common/Badge';

export function TurnStatusBar() {
  const turnStatus = useAppStore((s) => s.conversation.turnStatus);
  const turnRunning = useAppStore((s) => s.turnRunning);
  const stopPhase = useAppStore((s) => s.stopPhase);
  const stop = useAppStore((s) => s.stop);
  const turnDetail = useAppStore((s) => s.conversation.turnDetail);

  if (!turnRunning) {
    // 回合结束后保留最后一次状态；无回合时不渲染
    if (turnStatus === null || turnStatus === 'running') return null;
    const done =
      turnStatus === 'success'
        ? { tone: 'ok' as const, label: '回合成功' }
        : turnStatus === 'failure'
          ? { tone: 'danger' as const, label: '回合失败' }
          : { tone: 'warn' as const, label: '已停止' };
    return (
      <div className="chat-banner" role="status">
        <Badge tone={done.tone}>{done.label}</Badge>
        {turnDetail && <span>{turnDetail}</span>}
      </div>
    );
  }

  return (
    <div className="chat-banner" role="status">
      <span className="fd-chip fd-chip--pulse">
        <span className="fd-chip__dot" style={{ background: '#5aa2f0' }} />
        执行中
      </span>
      <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
        {stopPhase === 'stopping' ? '正在停止，等待引擎确认…' : '可在下方输入框追加指令'}
      </span>
      <span className="chat-banner__spacer" />
      <button
        type="button"
        className="fd-btn fd-btn--danger fd-btn--small"
        onClick={() => void stop()}
        disabled={stopPhase === 'stopping'}
        data-testid="stop-btn"
      >
        {stopPhase === 'stopping' ? '停止中…' : '停止'}
      </button>
    </div>
  );
}

export type { ConversationState };
