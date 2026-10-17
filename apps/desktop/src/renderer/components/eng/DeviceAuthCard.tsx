﻿﻿﻿/**
 * 设备授权卡（紫色系，与引擎审批卡的琥珀色系明确区分）。
 * PendingAuthorization：显式范围摘要（设备 + 产物哈希 + 任务 + 过期时间），
 * 批准/拒绝时必须回传与待授权一致的 confirmedScope。
 */
import type { PendingAuthorization } from '../../contracts/runner';
import { useAppStore } from '../../store/context';
import { Badge } from '../common/Badge';
import { OPERATION_TYPE_LABELS_ZH } from '../../lib/labels';
import { formatClock } from '../../lib/format';

export function DeviceAuthCard({ pending }: { pending: PendingAuthorization }) {
  const authorizeDevice = useAppStore((s) => s.authorizeDevice);
  const expired = new Date(pending.expiresAt).getTime() < Date.now();
  return (
    <div className="device-auth-card" data-testid="device-auth-card" data-operation-id={pending.operationId}>
      <div className="device-auth-card__head">
        设备操作待授权 · {OPERATION_TYPE_LABELS_ZH[pending.type]}
      </div>
      <div className="device-auth-card__note">
        设备授权独立于引擎审批：批准即允许对指定设备执行该次操作，拒绝不产生副作用。
      </div>
      <div className="device-auth-card__scope">
        <div>{pending.title}</div>
        <div style={{ color: 'var(--text-dim)', marginTop: 4 }}>{pending.scopeSummary}</div>
        <div className="device-auth-card__meta" style={{ marginTop: 6 }} data-testid="device-auth-scope">
          <span>
            任务 <span className="fd-code">{pending.taskId}</span>
          </span>
          {pending.artifactSha256 && (
            <span>
              产物哈希 <span className="fd-code">{pending.artifactSha256.slice(0, 12)}…</span>
            </span>
          )}
          <span>
            过期 <span className="fd-code">{formatClock(pending.expiresAt)}</span>
            {expired ? '（已过期，将自动取消）' : ''}
          </span>
        </div>
      </div>
      <div className="device-auth-card__actions">
        <button
          type="button"
          className="fd-btn fd-btn--primary fd-btn--small"
          disabled={expired}
          onClick={() => void authorizeDevice(pending.operationId, 'approved')}
          data-testid="device-auth-approve"
        >
          批准
        </button>
        <button
          type="button"
          className="fd-btn fd-btn--danger fd-btn--small"
          onClick={() => void authorizeDevice(pending.operationId, 'declined')}
          data-testid="device-auth-decline"
        >
          拒绝
        </button>
        {expired && <Badge tone="warn">已过期</Badge>}
      </div>
    </div>
  );
}
