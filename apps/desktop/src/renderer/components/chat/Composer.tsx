/**
 * 底部输入框：发送 / 执行中追加指令（steer） / 停止。
 * - 回合执行中变"追加指令"模式：送达成功清空，未送达保留输入并提示（store 处理）；
 * - 停止按钮与状态条同源：stopping 中间态禁用，turn/completed(interrupted) 后显示已停止。
 */
import { useEffect, useRef } from 'react';
import { useAppStore } from '../../store/context';
import { STEER_REASON_LABELS_ZH } from '../../lib/labels';

export function Composer() {
  const draft = useAppStore((s) => s.draft);
  const setDraft = useAppStore((s) => s.setDraft);
  const sendDraft = useAppStore((s) => s.sendDraft);
  const steerDraft = useAppStore((s) => s.steerDraft);
  const turnRunning = useAppStore((s) => s.turnRunning);
  const engineStatus = useAppStore((s) => s.engineStatus);
  const liveThreadId = useAppStore((s) => s.liveThreadId);
  const stop = useAppStore((s) => s.stop);
  const stopPhase = useAppStore((s) => s.stopPhase);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const live = engineStatus === 'ready' && liveThreadId !== null;
  const canSend = live && draft.trim().length > 0;

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [draft]);

  return (
    <div className="composer">
      <div className="composer__row">
        <textarea
          ref={taRef}
          className="composer__input"
          value={draft}
          placeholder={
            turnRunning
              ? '回合执行中——输入内容将作为追加指令（steer）送达当前回合…'
              : live
                ? '描述任务，Enter 发送，Shift+Enter 换行…'
                : '先在左侧开始或恢复一个会话…'
          }
          disabled={!live}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (canSend) void (turnRunning ? steerDraft() : sendDraft());
            }
          }}
          aria-label={turnRunning ? '追加指令' : '消息输入'}
        />
        <div className="composer__actions">
          {turnRunning ? (
            <button
              type="button"
              className="fd-btn fd-btn--primary"
              disabled={!canSend}
              onClick={() => void steerDraft()}
              data-testid="steer-btn"
            >
              追加指令
            </button>
          ) : (
            <button
              type="button"
              className="fd-btn fd-btn--primary"
              disabled={!canSend}
              onClick={() => void sendDraft()}
              data-testid="send-btn"
            >
              发送
            </button>
          )}
          {turnRunning && (
            <button
              type="button"
              className="fd-btn fd-btn--danger"
              disabled={stopPhase === 'stopping'}
              onClick={() => void stop()}
              data-testid="composer-stop-btn"
            >
              {stopPhase === 'stopping' ? '停止中…' : '停止'}
            </button>
          )}
        </div>
      </div>
      <div className="composer__hint">
        {turnRunning
          ? '追加指令仅送达当前回合（SteerResult.delivered=true 才算送达），不会自动发起新回合。'
          : '发送后模型可执行受控工具；关键操作需审批，设备操作需独立授权。'}
      </div>
    </div>
  );
}

/** steer 未送达提示条：保留输入、说明原因、由用户决定是否发到新回合 */
export function SteerNoticeBanner() {
  const notice = useAppStore((s) => s.steerNotice);
  const sendFromNotice = useAppStore((s) => s.sendFromNotice);
  const dismiss = useAppStore((s) => s.dismissSteerNotice);
  const turnRunning = useAppStore((s) => s.turnRunning);
  if (!notice) return null;
  const reasonText = notice.reason ? STEER_REASON_LABELS_ZH[notice.reason] : '回合已结束或标识不匹配';
  return (
    <div className="steer-banner" role="alert" data-testid="steer-notice">
      <span>追加指令未送达：{reasonText}</span>
      <span className="chat-banner__spacer" />
      {turnRunning ? (
        <span style={{ fontSize: 11 }}>回合再次执行中，请在输入框确认后重试追加</span>
      ) : (
        <button type="button" className="fd-btn fd-btn--small" onClick={() => void sendFromNotice()}>
          作为新消息发送
        </button>
      )}
      <button type="button" className="fd-btn fd-btn--ghost fd-btn--small" onClick={dismiss}>
        忽略
      </button>
    </div>
  );
}
