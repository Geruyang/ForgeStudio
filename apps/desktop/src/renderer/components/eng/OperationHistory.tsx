﻿﻿﻿/**
 * 操作历史：七类操作（inspect/build/test/device_bind/device_flash/device_verify/export）
 * + 状态 + 耗时；失败展示 FailureKind 中文标签（能看出失败阶段）。
 */
import type { Operation, TaskOverview } from '../../contracts/engineering';
import { Badge } from '../common/Badge';
import { OPERATION_STATUS_LABELS_ZH, OPERATION_STATUS_TONE, OPERATION_TYPE_LABELS_ZH, failureLabel } from '../../lib/labels';
import { formatDuration, formatClock } from '../../lib/format';
import { useAppStore } from '../../store/context';

function opDuration(op: Operation): number | undefined {
  if (!op.startedAt || !op.endedAt) return undefined;
  const ms = new Date(op.endedAt).getTime() - new Date(op.startedAt).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

export function OperationHistory({ task }: { task: TaskOverview }) {
  const cancelOperation = useAppStore((s) => s.cancelOperation);
  const ops = [...task.operations].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  return (
    <div className="acceptance" data-testid="operation-history">
      {ops.length === 0 && <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>暂无操作记录。</div>}
      {ops.slice(0, 30).map((op) => {
        const cancellable = op.status === 'prepared' || op.status === 'awaiting_authorization' || op.status === 'authorized';
        return (
          <div key={op.id} className="op-item">
            <span className="op-item__type">{OPERATION_TYPE_LABELS_ZH[op.type]}</span>
            <Badge tone={OPERATION_STATUS_TONE[op.status]}>{OPERATION_STATUS_LABELS_ZH[op.status]}</Badge>
            {op.failure ? (
              <span className="op-item__summary" title={op.failure.message} style={{ color: '#ff8a87' }}>
                {failureLabel(op.failure.kind)}：{op.failure.message}
              </span>
            ) : (
              <span className="op-item__summary" title={op.resultSummary}>
                {op.resultSummary ?? ''}
              </span>
            )}
            <span className="op-item__time">
              {formatClock(op.startedAt ?? op.createdAt)} · {formatDuration(opDuration(op))}
            </span>
            {cancellable && (
              <button type="button" className="fd-btn fd-btn--ghost fd-btn--small" onClick={() => void cancelOperation(op.id)}>
                取消
              </button>
            )}
          </div>
        );
      })}
      {ops.length > 30 && <div style={{ color: 'var(--text-faint)', fontSize: 11 }}>仅显示最近 30 条，共 {ops.length} 条。</div>}
    </div>
  );
}
