import type { ToolCallView, UiMessage } from '../../lib/events';
import { ToolCard } from './ToolCard';
import { PlanCard } from './PlanCard';
import { PatchCard } from './PatchCard';

export function MessageItem({ message }: { message: UiMessage }) {
  const isUser = message.role === 'user';
  const planCalls = message.toolCalls.filter((c) => /(^|[^a-z])plan/i.test(c.tool));
  const planCallIds = new Set(planCalls.map((c) => c.callId));
  return (
    <div className={`msg msg--${message.role}`} data-role={message.role}>
      <div className="msg__role">
        {isUser ? (message.kind === 'steer' ? '用户 · 追加指令' : '用户') : 'ForgeStudio 引擎'}
        {message.kind === 'steer' && <span className="msg__tag" style={{ marginLeft: 8 }}>执行中追加</span>}
      </div>
      {(message.text || !message.toolCalls.length) && (
        <div className={`msg__body${message.streaming ? ' msg__body--streaming' : ''}`}>
          {message.text || (message.streaming ? '' : '（无文本输出）')}
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
