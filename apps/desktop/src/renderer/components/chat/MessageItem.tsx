import { useState } from 'react';
import type { ToolCallView, UiMessage } from '../../lib/events';
import { ToolCard } from './ToolCard';
import { PlanCard } from './PlanCard';
import { PatchCard } from './PatchCard';

/** 超过此长度的非流式文本折叠渲染（防巨型输出撑爆 DOM/卡顿；流式期间不折叠） */
const LONG_TEXT_FOLD = 4000;
const FOLD_PREVIEW = 2000;

export function MessageItem({ message }: { message: UiMessage }) {
  const isUser = message.role === 'user';
  const planCalls = message.toolCalls.filter((c) => /(^|[^a-z])plan/i.test(c.tool));
  const planCallIds = new Set(planCalls.map((c) => c.callId));
  const [expanded, setExpanded] = useState(false);
  const foldable = !message.streaming && !isUser && message.text.length > LONG_TEXT_FOLD;
  const shownText = foldable && !expanded
    ? message.text.slice(0, FOLD_PREVIEW)
    : message.text;
  return (
    <div className={`msg msg--${message.role}`} data-role={message.role}>
      <div className="msg__role">
        {isUser ? (message.kind === 'steer' ? '用户 · 追加指令' : '用户') : 'ForgeStudio 引擎'}
        {message.kind === 'steer' && <span className="msg__tag" style={{ marginLeft: 8 }}>执行中追加</span>}
      </div>
      {(message.text || !message.toolCalls.length) && (
        <div className={`msg__body${message.streaming ? ' msg__body--streaming' : ''}`}>
          {shownText || (message.streaming ? '' : '（无文本输出）')}
          {foldable && !expanded && (
            <button
              type="button"
              className="fd-btn fd-btn--ghost fd-btn--small"
              style={{ display: 'block', marginTop: 6 }}
              data-testid="msg-expand-btn"
              onClick={() => setExpanded(true)}
            >
              展开全部（共 {message.text.length} 字符，已省略 {message.text.length - FOLD_PREVIEW}）
            </button>
          )}
        </div>
      )}
      {message.reasoning && message.reasoning.trim().length > 0 && <ReasoningBlock text={message.reasoning} />}
      {message.toolCalls.map((call) =>
        planCallIds.has(call.callId) ? <PlanCard key={call.callId} call={call} /> : <ToolCard key={call.callId} call={call} />,
      )}
      {message.patches.map((patch, i) => (
        <PatchCard key={patch.patchRef + i} patch={patch} />
      ))}
    </div>
  );
}

function ReasoningBlock({ text }: { text: string }) {
  return (
    <details className="msg__reasoning">
      <summary style={{ cursor: 'pointer', color: 'var(--text-faint)', fontSize: 12 }}>
        思考过程（{text.length} 字符）
      </summary>
      <pre className="fd-pre" style={{ marginTop: 6 }}>{text}</pre>
    </details>
  );
}

export type { ToolCallView };
