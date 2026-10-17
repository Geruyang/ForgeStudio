/**
 * 工具调用卡：名称 + 状态（运行中/成功/失败/未知），
 * 参数预览与输出预览可展开（默认折叠，输出错误时默认展开）。
 */
import { useState } from 'react';
import type { ToolCallView } from '../../lib/events';
import { Badge } from '../common/Badge';

export function ToolCard({ call }: { call: ToolCallView }) {
  const [open, setOpen] = useState(call.isError === true);
  const state =
    call.outputPreview === undefined
      ? { tone: 'info' as const, label: '执行中' }
      : call.isError
        ? { tone: 'danger' as const, label: '失败' }
        : { tone: 'ok' as const, label: '完成' };

  return (
    <div className="tool-card" data-call-id={call.callId}>
      <button type="button" className="tool-card__head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="tool-card__name">{call.tool}</span>
        <span className="tool-card__state">
          <Badge tone={state.tone}>{state.label}</Badge>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        </span>
      </button>
      {open && (
        <div className="tool-card__body">
          <div>
            <div className="tool-card__label">参数</div>
            <pre className="fd-pre">{call.argsPreview || '（无参数预览）'}</pre>
          </div>
          {call.outputPreview !== undefined && (
            <div>
              <div className="tool-card__label">输出{call.isError ? '（错误）' : ''}</div>
              <pre className="fd-pre">{call.outputPreview || '（无输出）'}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
