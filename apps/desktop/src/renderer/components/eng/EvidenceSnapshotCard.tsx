﻿﻿﻿/**
 * 证据卡：输入指纹（inputDigest 前 12 位）、证据级别 A/B、结果与过期状态。
 * 数据来自 TaskOverview.latestSnapshot + hasStaleEvidence（契约未提供 Evidence 实体列表，
 * 结果以验收项状态与 computeTaskAcceptance 的判定为准，不在 UI 自行点亮）。
 */
import { computeTaskAcceptance, type TaskOverview } from '../../contracts/engineering';
import { Badge, StatusChip } from '../common/Badge';
import { formatShortTime } from '../../lib/format';

export function EvidenceSnapshotCard({ task }: { task: TaskOverview }) {
  const snap = task.latestSnapshot;
  const judge = computeTaskAcceptance({ acceptance: task.acceptance, stale: task.hasStaleEvidence });
  const result = task.hasStaleEvidence
    ? { tone: 'warn' as const, label: '证据过期 · 需重新验证' }
    : judge.passed
      ? { tone: 'ok' as const, label: '证据有效 · 验收通过' }
      : { tone: 'neutral' as const, label: judge.requiredTotal === 0 ? '暂无必需验收项' : '验证未完成' };

  return (
    <div className="device-row" data-testid="evidence-card">
      <div className="device-row__head">
        <span className="device-row__name">证据快照</span>
        <span>
          <StatusChip tone={result.tone}>{result.label}</StatusChip>
        </span>
      </div>
      {snap ? (
        <div className="device-row__meta" style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <span>
            级别 <Badge tone={snap.evidenceLevel === 'B' ? 'info' : 'accent'}>{snap.evidenceLevel} 级</Badge>
          </span>
          <span>
            inputDigest <span className="fd-code" title={snap.inputDigest}>{snap.inputDigest.slice(0, 12)}…</span>
          </span>
          <span>git {snap.hasGit ? (snap.gitCommit ?? `${snap.gitBranch ?? '?'}`) : '（非 git 工程）'}</span>
          <span>采集 {formatShortTime(snap.capturedAt)}</span>
        </div>
      ) : (
        <div className="device-row__meta">尚未采集输入指纹（先运行环境检查/构建）。</div>
      )}
      {snap && (
        <div className="device-row__meta" style={{ fontSize: 11 }}>
          {snap.evidenceLevel === 'B'
            ? 'B 级：证据绑定任务专属输入快照内容（构建/验收从快照执行，产物独立归档）。'
            : 'A 级：模型可写范围内的输入变化可被检测，但不构成防篡改保证。'}
        </div>
      )}
      {snap && Object.keys(snap.toolVersions).length > 0 && (
        <div className="device-row__meta" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {Object.entries(snap.toolVersions).map(([tool, ver]) => (
            <span key={tool}>
              {tool}=<span className="fd-code">{ver}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
