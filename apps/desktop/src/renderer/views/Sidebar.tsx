/**
 * 左侧栏：新会话入口 + 会话列表（搜索/重命名/删除/恢复）+ 工程任务列表入口。
 */
import { useState } from 'react';
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
  const renameThread = useAppStore((s) => s.renameThread);
  const deleteThread = useAppStore((s) => s.deleteThread);
  const tasks = useAppStore((s) => s.tasks);
  const activeTaskId = useAppStore((s) => s.activeTaskId);
  const setActiveTask = useAppStore((s) => s.setActiveTask);
  const setTaskSetupOpen = useAppStore((s) => s.setTaskSetupOpen);

  // Z1-5 会话管理：搜索（标题/项目根子串，不区分大小写）、行内重命名、两步删除确认
  const [search, setSearch] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const keyword = search.trim().toLowerCase();
  const visible = threads
    .filter(
      (t) =>
        keyword.length === 0 ||
        (t.title ?? '').toLowerCase().includes(keyword) ||
        (t.projectRoot ?? '').toLowerCase().includes(keyword),
    )
    .sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));

  const commitRename = (threadId: string) => {
    const name = renameDraft.trim();
    setRenamingId(null);
    if (name.length > 0) void renameThread(threadId, name);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar__header">
        <span className="sidebar__title">项目 / 会话</span>
        <button type="button" className="fd-btn fd-btn--small" onClick={() => void startNewConversation()}>
          ＋ 新会话
        </button>
      </div>
      {threads.length > 0 && (
        <div style={{ padding: '4px 10px 6px' }}>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索会话…"
            aria-label="搜索会话"
            data-testid="thread-search"
            style={{ width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '4px 8px' }}
          />
        </div>
      )}
      <div className="sidebar__list" role="list" aria-label="会话列表">
        {threads.length === 0 && (
          <div style={{ padding: '8px 4px', color: 'var(--text-faint)', fontSize: 12 }}>
            暂无会话。选择项目目录后发起第一个任务。
          </div>
        )}
        {threads.length > 0 && visible.length === 0 && (
          <div style={{ padding: '8px 4px', color: 'var(--text-faint)', fontSize: 12 }} data-testid="thread-search-empty">
            没有匹配「{search.trim()}」的会话。
          </div>
        )}
        {visible.map((t) => {
          const isActive = t.threadId === activeThreadId;
          const isLive = t.threadId === liveThreadId;
          const isRenaming = renamingId === t.threadId;
          const isConfirmingDelete = confirmDeleteId === t.threadId;
          return (
            <div
              key={t.threadId}
              className={`thread-item${isActive ? ' thread-item--active' : ''}`}
              role="listitem"
              data-testid="thread-item"
            >
              {isRenaming ? (
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(t.threadId);
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                  onBlur={() => commitRename(t.threadId)}
                  aria-label="会话重命名输入"
                  data-testid="thread-rename-input"
                  maxLength={120}
                  style={{ width: '100%', fontSize: 12, padding: '2px 6px' }}
                />
              ) : (
                <button type="button" className="thread-item__title" style={{ all: 'unset', cursor: 'pointer', width: '100%' }} onClick={() => void selectThread(t.threadId)}>
                  <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {truncate(t.title || '(未命名会话)', 40)}
                  </span>
                </button>
              )}
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
                {!isRenaming && (
                  <button
                    type="button"
                    className="fd-btn fd-btn--ghost fd-btn--small"
                    onClick={() => {
                      setRenamingId(t.threadId);
                      setRenameDraft(t.title ?? '');
                      setConfirmDeleteId(null);
                    }}
                    aria-label={`重命名会话 ${t.title ?? ''}`}
                    data-testid="thread-rename-btn"
                  >
                    重命名
                  </button>
                )}
                {isConfirmingDelete ? (
                  <>
                    <button
                      type="button"
                      className="fd-btn fd-btn--small"
                      onClick={() => {
                        setConfirmDeleteId(null);
                        void deleteThread(t.threadId);
                      }}
                      data-testid="thread-delete-confirm"
                    >
                      确认删除
                    </button>
                    <button
                      type="button"
                      className="fd-btn fd-btn--ghost fd-btn--small"
                      onClick={() => setConfirmDeleteId(null)}
                      data-testid="thread-delete-cancel"
                    >
                      取消
                    </button>
                  </>
                ) : (
                  !isRenaming && (
                    <button
                      type="button"
                      className="fd-btn fd-btn--ghost fd-btn--small"
                      onClick={() => setConfirmDeleteId(t.threadId)}
                      aria-label={`删除会话 ${t.title ?? ''}`}
                      data-testid="thread-delete-btn"
                    >
                      删除
                    </button>
                  )
                )}
                {!isLive && !isRenaming && !isConfirmingDelete && (
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
