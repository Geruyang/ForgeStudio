﻿﻿﻿/**
 * 引擎审批卡：琥珀色系（与设备授权卡的紫色系明确区分）。
 * 只渲染 approval.options 中允许的决定按钮——选项缺失时不显示对应按钮；
 * 处理后只读展示结果，等待 approval/resolved 事件落地。
 */
import type { ApprovalDecision, ApprovalRequestView } from '../../contracts/engine';
import {
  APPROVAL_DECISION_LABELS_ZH,
  APPROVAL_KIND_LABELS_ZH,
  APPROVAL_RESOLVED_LABELS_ZH,
} from '../../lib/labels';
import { useAppStore } from '../../store/context';
import type { ApprovalView } from '../../lib/events';
import { Badge } from '../common/Badge';

export function ApprovalCard({ view }: { view: ApprovalView }) {
  const approve = useAppStore((s) => s.approve);
  const { approval } = view;

  if (view.resolved) {
    return (
      <div className="approval-card approval-card--resolved" data-request-id={approval.requestId}>
        <div className="approval-card__resolved">
          <Badge tone="neutral">{APPROVAL_KIND_LABELS_ZH[approval.kind]}</Badge>
          <span>
            审批已处理 · {view.decision ? APPROVAL_RESOLVED_LABELS_ZH[view.decision] : '已处理'}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="approval-card" data-request-id={approval.requestId}>
      <div className="approval-card__head">
        需要人工确认 · {APPROVAL_KIND_LABELS_ZH[approval.kind]}
      </div>
      <div className="approval-card__summary">{approval.summary}</div>
      <div className="approval-card__actions">
        {approval.options.map((decision) => (
          <button
            key={decision}
            type="button"
            className={`fd-btn ${decision === 'decline' ? 'fd-btn--danger' : decision === 'accept' || decision === 'acceptForSession' ? 'fd-btn--primary' : 'fd-btn--ghost'}`}
            onClick={() => void approve(approval.requestId, decision)}
          >
            {APPROVAL_DECISION_LABELS_ZH[decision]}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
        请求 {approval.requestId} · 连接代次 {approval.connectionGeneration}
      </div>
    </div>
  );
}
