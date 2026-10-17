﻿﻿﻿﻿﻿/**
 * 验收单列表：kind 图标（可执行 ▶ / 人工 ✋）+ 状态徽标 + 通过标准；
 * proposed（模型提议）需用户采纳；可执行项提供"运行验证"；
 * "通过/未通过"判定只由 contracts.computeTaskAcceptance 输出驱动。
 */
import { computeTaskAcceptance, type AcceptanceItem, type TaskOverview } from '../../contracts/engineering';
import { useAppStore } from '../../store/context';
import { Badge, StatusChip } from '../common/Badge';
import { ACCEPTANCE_KIND_LABELS_ZH, ACCEPTANCE_STATUS_LABELS_ZH, ACCEPTANCE_STATUS_TONE } from '../../lib/labels';

function KindIcon({ kind }: { kind: AcceptanceItem['kind'] }) {
  return kind === 'executable' ? (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-label={ACCEPTANCE_KIND_LABELS_ZH[kind]} role="img">
      <path d="M4 2.5v11l9-5.5-9-5.5Z" fill="currentColor" style={{ color: 'var(--cyan)' }} />
    </svg>
  ) : (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-label={ACCEPTANCE_KIND_LABELS_ZH[kind]} role="img">
      <path
        d="M8 2c-1.1 0-2 .9-2 2v3.2L4.4 5.6a1.4 1.4 0 0 0-2 2L6 13a3.5 3.5 0 0 0 2.8 1.4h1.4A3.8 3.8 0 0 0 14 10.6V7c0-1.1-.9-2-2-2s-2 .9-2 2v.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        style={{ color: 'var(--warn)' }}
      />
    </svg>
  );
}

export function AcceptanceList({ task }: { task: TaskOverview }) {
  const runVerifier = useAppStore((s) => s.runVerifier);
  const busyTools = useAppStore((s) => s.busyTools);
  const adoptAcceptanceItem = useAppStore((s) => s.adoptAcceptanceItem);
  const removeAcceptanceItem = useAppStore((s) => s.removeAcceptanceItem);
  const resolveManualReview = useAppStore((s) => s.resolveManualReview);
  const setTaskSetupOpen = useAppStore((s) => s.setTaskSetupOpen);

  const judge = computeTaskAcceptance({ acceptance: task.acceptance, stale: task.hasStaleEvidence });
  const sorted = [...task.acceptance].sort((a, b) => a.order - b.order);

  return (
    <div className="acceptance" data-testid="acceptance-list">
      <div className="acceptance__summary">
        <span data-testid="acceptance-judge">
          <StatusChip tone={judge.passed ? 'ok' : judge.stale ? 'warn' : 'neutral'}>
            {judge.passed ? '验收通过' : judge.stale ? '证据过期，需重新验证' : '验收未通过'}
          </StatusChip>
        </span>
        <span className="acceptance__count">
          必需项 {judge.passedCount}/{judge.requiredTotal} 通过
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <button type="button" className="fd-btn fd-btn--ghost fd-btn--small" onClick={() => setTaskSetupOpen('acceptance')}>
            调整验收单
          </button>
        </span>
      </div>
      {sorted.length === 0 && <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>尚未定义验收项。</div>}
      {sorted.map((item) => {
        const busy = item.verifierId ? busyTools.includes(`test:${item.verifierId}`) : false;
        return (
          <div key={item.id} className="acc-item" data-acc-status={item.status}>
            <div className="acc-item__head">
              <KindIcon kind={item.kind} />
              <Badge tone="neutral">{ACCEPTANCE_KIND_LABELS_ZH[item.kind]}</Badge>
              <span className="acc-item__title">{item.title}</span>
              <Badge tone={ACCEPTANCE_STATUS_TONE[item.status]}>{ACCEPTANCE_STATUS_LABELS_ZH[item.status]}</Badge>
              {item.required ? <Badge tone="accent">必需</Badge> : <Badge tone="neutral">可选</Badge>}
            </div>
            <div className="acc-item__expected">通过标准：{item.expected}</div>
            {item.verifierId && (
              <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                verifier <span className="fd-code">{item.verifierId}</span>
              </div>
            )}
            <div className="acc-item__actions">
              {item.kind === 'manual' && (
                <>
                  <button
                    type="button"
                    className="fd-btn fd-btn--small"
                    onClick={() => {
                      // 人工验收通过走二次确认（误触保护；不通过可随时改判重记）
                      if (window.confirm(`确认人工验收通过？\n\n「${item.title}」\n通过后将写入操作历史与证据链（B 级人证）。`)) {
                        void resolveManualReview(task.id, item.id, 'passed');
                      }
                    }}
                    data-testid="manual-pass-btn"
                  >
                    确认通过
                  </button>
                  <button
                    type="button"
                    className="fd-btn fd-btn--ghost fd-btn--small"
                    onClick={() => void resolveManualReview(task.id, item.id, 'failed')}
                    data-testid="manual-fail-btn"
                  >
                    标记不通过
                  </button>
                </>
              )}
              {item.kind === 'executable' && item.verifierId && item.status !== 'proposed' && (
                <button
                  type="button"
                  className="fd-btn fd-btn--small"
                  disabled={busy}
                  onClick={() => void runVerifier(task.id, item.verifierId, item.title)}
                  data-testid="run-verifier"
                >
                  {busy ? '验证中…' : '运行验证'}
                </button>
              )}
              {item.status === 'proposed' && (
                <>
                  <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>模型提议，未采纳前不计入验收</span>
                  <button type="button" className="fd-btn fd-btn--small" onClick={() => void adoptAcceptanceItem(task.id, item)}>
                    采纳
                  </button>
                </>
              )}
              <button type="button" className="fd-btn fd-btn--ghost fd-btn--small" onClick={() => void removeAcceptanceItem(task.id, item)}>
                移除
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
