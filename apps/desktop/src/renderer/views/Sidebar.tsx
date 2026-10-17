﻿﻿﻿/**
 * 左侧栏：新会话入口 + 会话/线程列表（恢复/查看）+ 工程任务列表入口。
 */
import { useAppStore } from '../store/context';
import { Badge } from '../components/common/Badge';
import { formatShortTime, truncate } from '../lib/format';
import { TASK_STATUS_LABELS_ZH, TASK_STATUS_TONE } from '../lib/labels';
import { computeTaskAcceptance } from '../contracts/engineering';

export function Sidebar() {
  const threads = useAppStore((s) => s.threads);
  const activeThreadId = useAppStore((s) => s.activeThreadId);
  const liveThreadId = useAppStore((s) => s.liveThreadId);
  const selectThread = useAppStore((s) => s.selectThread);
  const resumeThread = useAppStore((s) => s.resumeThread);
  const startNewConversation = useAppStore((s) => s.startNewConversation);
  const tasks = useAppStore((s) => s.tasks);
  const activeTaskId = useAppStore((s) => s.activeTaskId);
  const setActiveTask = useAppStore((s) => s.setActiveTask);
  const setTaskSetupOpen = useAppStore((s) => s.setTaskSetupOpen);

  const sorted = [...threads].sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));

  return (
    <aside className="sidebar">
      <div className="sidebar__header">
        <span className="sidebar__title">项目 / 会话</span>
        <button type="button" className="fd-btn fd-btn--small" onClick={() => void startNewConversation()}>
          ＋ 新会话
        </button>
      </div>
      <div className="sidebar__list" role="list" aria-label="会话列表">
        {sorted.length === 0 && (
          <div style={{ padding: '8px 4px', color: 'var(--text-faint)', fontSize: 12 }}>
            暂无会话。选择项目目录后发起第一个任务。
          </div>
        )}
        {sorted.map((t) => {
          const isActive = t.threadId === activeThreadId;
          const isLive = t.threadId === liveThreadId;
          return (
            <div
              key={t.threadId}
              className={`thread-item${isActive ? ' thread-item--active' : ''}`}
              role="listitem"
              data-testid="thread-item"
            >
              <button type="button" className="thread-item__title" style={{ all: 'unset', cursor: 'pointer', width: '100%' }} onClick={() => void selectThread(t.threadId)}>
                <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {truncate(t.title || '(未命名会话)', 40)}
                </span>
              </button>
              <div className="thread-item__meta">
                <span>{formatShortTime(t.lastActivityAt)}</span>
                <span>{t.messageCount} 条消息</span>
                {isLive ? (
                  <Badge tone="ok">当前</Badge>
                ) : !t.complete ? (
                  <Badge tone="warn">历史不完整</Badge>
                ) : null}
              </div>
              <div className="thread-item__actions">
                {!isLive && (
                  <button type="button" className="fd-btn fd-btn--ghost fd-btn--small" onClick={() => void resumeThread(t.threadId)}>
                    恢复会话
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="sidebar__header" style={{ borderTop: '1px solid var(--border)' }}>
        <span className="sidebar__title">工程任务</span>
        <button type="button" className="fd-btn fd-btn--small" onClick={() => setTaskSetupOpen('create')}>
          ＋ 新任务
        </button>
      </div>
      <div className="sidebar__list" style={{ paddingTop: 0 }} role="list" aria-label="任务列表">
        {tasks.length === 0 && (
          <div style={{ padding: '6px 4px 10px', color: 'var(--text-faint)', fontSize: 12 }}>
            尚无工程任务。通过"新任务"创建验收单。
          </div>
        )}
        {tasks.map((t) => {
          const acc = computeTaskAcceptance({ acceptance: t.acceptance, stale: t.hasStaleEvidence });
          const isActive = t.id === activeTaskId;
          return (
            <button
              key={t.id}
              type="button"
              className={`thread-item${isActive ? ' thread-item--active' : ''}`}
              style={{ textAlign: 'left' }}
              role="listitem"
              onClick={() => setActiveTask(t.id)}
              data-testid="task-item"
            >
              <span className="thread-item__title">{truncate(t.title, 40)}</span>
              <span className="thread-item__meta">
                <Badge tone={TASK_STATUS_TONE[t.status]}>{TASK_STATUS_LABELS_ZH[t.status]}</Badge>
                <span>
                  验收 {acc.passedCount}/{acc.requiredTotal}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
