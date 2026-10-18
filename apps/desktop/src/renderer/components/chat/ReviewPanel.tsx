/**
 * 代码审阅面板（Z4 可选 1）：把 review/start 发起的审阅回合从消息流中提起，
 * 以结构化面板呈现——状态 / 审阅报告 / 涉及文件 / 工具调用统计。
 * 数据源为 conversation.reviews（本会话内发起的审阅）与对应 turnId 的消息；
 * 协议（vendored codex 0.162.1）无独立审阅注释结构与 decision 服务端请求，
 * 面板不虚构协议不存在的能力；重启恢复的历史会话不含审阅标记（报告仍在消息流）。
 */
import { useState } from 'react';
import { useAppStore } from '../../store/context';
import type { ReviewTurnState, UiMessage } from '../../lib/events';
import { formatClock } from '../../lib/format';
import { StatusChip } from '../common/Badge';
import { PatchCard } from './PatchCard';

/** 与 MessageItem 一致的巨型文本折叠阈值（防撑爆 DOM） */
const LONG_TEXT_FOLD = 4000;
const FOLD_PREVIEW = 2000;

const STATUS_VIEW: Record<ReviewTurnState['status'], { label: string; tone: 'info' | 'ok' | 'danger' | 'warn' }> = {
  running: { label: '审阅中', tone: 'info' },
  success: { label: '审阅完成', tone: 'ok' },
  failure: { label: '审阅失败', tone: 'danger' },
  interrupted: { label: '已中断', tone: 'warn' },
};

export function ReviewPanel() {
  const reviews = useAppStore((s) => s.conversation.reviews);
  const messages = useAppStore((s) => s.conversation.messages);
  if (reviews.length === 0) return null;
  // 最新在前；审阅频率低，全量平铺不过度设计
  const ordered = [...reviews].reverse();
  return (
    <div style={{ margin: '10px 22px 0' }} data-testid="review-panel">
      {ordered.map((r, i) => (
        <ReviewCard key={r.turnId} review={r} messages={messages} defaultOpen={i === 0} />
      ))}
      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 4 }}>
        面板仅收录本会话内发起的审阅；重启恢复的历史审阅内容请查看会话消息流。
      </div>
    </div>
  );
}

function ReviewCard({
  review,
  messages,
  defaultOpen,
}: {
  review: ReviewTurnState;
  messages: UiMessage[];
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const view = STATUS_VIEW[review.status];
  const turnMessages = messages.filter((m) => m.turnId === review.turnId);
  const report = turnMessages
    .filter((m) => m.role === 'assistant' && m.text.trim().length > 0)
    .map((m) => m.text)
    .join('\n\n');
  const patches = turnMessages.flatMap((m) => m.patches);
  const toolCount = turnMessages.reduce((n, m) => n + m.toolCalls.length, 0);
  const files = new Map<string, 'added' | 'modified' | 'deleted'>();
  for (const p of patches) for (const f of p.files) files.set(f.path, f.changeType);

  return (
    <div className="panel__section" style={{ padding: '8px 12px' }} data-testid={`review-card-${review.status}`}>
      <div className="device-row__head" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          className="fd-btn fd-btn--ghost fd-btn--small"
          onClick={() => setOpen((v) => !v)}
          data-testid="review-toggle-btn"
        >
          {open ? '收起' : '展开'}
        </button>
        <span className="device-row__name">代码审阅</span>
        <StatusChip tone={view.tone} pulse={review.status === 'running'}>
          {view.label}
        </StatusChip>
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{formatClock(review.startedAt)}</span>
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
          工具调用 {toolCount} 次{files.size > 0 ? ` · 涉及 ${files.size} 个文件` : ''}
        </span>
      </div>
      {review.status === 'failure' && review.detail && (
        <div className="device-row__meta" style={{ color: 'var(--danger)' }}>
          {review.detail}
        </div>
      )}
      {open && (
        <div style={{ marginTop: 6 }}>
          {report.length > 0 ? (
            <ReviewReport text={report} />
          ) : (
            <div className="device-row__meta" style={{ color: 'var(--text-faint)' }}>
              {review.status === 'running' ? '审阅进行中，报告将在回合结束后呈现。' : '（无文本报告）'}
            </div>
          )}
          {patches.length > 0 && (
            <div style={{ marginTop: 6 }}>
              {patches.map((p, i) => (
                <PatchCard key={p.patchRef + i} patch={p} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 审阅报告正文：与 MessageItem 同阈值的折叠预览（巨型报告不撑爆 DOM） */
function ReviewReport({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const foldable = text.length > LONG_TEXT_FOLD;
  const shown = foldable && !expanded ? text.slice(0, FOLD_PREVIEW) : text;
  return (
    <div className="msg__body">
      {shown}
      {foldable && !expanded && (
        <button
          type="button"
          className="fd-btn fd-btn--ghost fd-btn--small"
          style={{ display: 'block', marginTop: 6 }}
          data-testid="review-expand-btn"
          onClick={() => setExpanded(true)}
        >
          展开全部（共 {text.length} 字符，已省略 {text.length - FOLD_PREVIEW}）
        </button>
      )}
    </div>
  );
}
