﻿﻿﻿/**
 * 产物卡：类型 / 哈希 / 大小 / 打开按钮（openPath 白名单 artifact）。
 */
import type { Artifact } from '../../contracts/engineering';
import { useAppStore } from '../../store/context';
import { Badge } from '../common/Badge';
import { ARTIFACT_TYPE_LABELS_ZH } from '../../lib/labels';
import { formatBytes, formatClock, shortSha } from '../../lib/format';

export function ArtifactList({ artifacts }: { artifacts: Artifact[] }) {
  const openArtifact = useAppStore((s) => s.openArtifact);
  return (
    <div className="acceptance" data-testid="artifact-list">
      {artifacts.length === 0 && <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>暂无产物（构建后出现）。</div>}
      {artifacts.map((a) => (
        <div key={a.id} className="artifact-row">
          <div className="artifact-row__head">
            <Badge tone="info">{ARTIFACT_TYPE_LABELS_ZH[a.type]}</Badge>
            <span className="fd-code" style={{ fontSize: 11 }}>
              {shortSha(a.sha256)}
            </span>
            {a.buildId && (
              <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                buildId <span className="fd-code">{a.buildId}</span>
              </span>
            )}
            <span style={{ marginLeft: 'auto' }}>
              <button type="button" className="fd-btn fd-btn--small" onClick={() => void openArtifact(a.path)} title={a.path}>
                打开
              </button>
            </span>
          </div>
          <div className="artifact-row__path" title={a.path}>
            {a.path}
          </div>
          <div className="artifact-row__meta">
            <span>{formatBytes(a.sizeBytes)}</span>
            <span>{formatClock(a.createdAt)}</span>
            {a.archivedPath && <span>已归档</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
