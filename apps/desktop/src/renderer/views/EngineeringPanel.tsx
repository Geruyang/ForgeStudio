﻿﻿﻿﻿﻿﻿﻿/**
 * 工程交付面板（右栏）：任务卡（状态徽标 + 验收进度）→ 运行验证按钮
 * （检查/构建/导出）→ 设备授权卡 → 验收单 → 证据 → 设备 → 操作历史 → 产物。
 */
import { computeTaskAcceptance, type TaskOverview } from '../contracts/engineering';
import { useAppStore } from '../store/context';
import { Badge, StatusChip } from '../components/common/Badge';
import { Collapse } from '../components/common/Collapse';
import { EmptyState } from '../components/common/EmptyState';
import { AcceptanceList } from '../components/eng/AcceptanceList';
import { OperationHistory } from '../components/eng/OperationHistory';
import { EvidenceSnapshotCard } from '../components/eng/EvidenceSnapshotCard';
import { ArtifactList } from '../components/eng/ArtifactList';
import { DeviceSection } from '../components/eng/DeviceSection';
import { DeviceAuthCard } from '../components/eng/DeviceAuthCard';
import {
  TASK_STATUS_LABELS_ZH,
  TASK_STATUS_TONE,
  failureLabel,
} from '../lib/labels';
import { shortSha } from '../lib/format';

export function EngineeringPanel() {
  const tasks = useAppStore((s) => s.tasks);
  const activeTaskId = useAppStore((s) => s.activeTaskId);
  const devices = useAppStore((s) => s.devices);
  const pendingAuths = useAppStore((s) => s.pendingAuths);
  const busyTools = useAppStore((s) => s.busyTools);
  const runInspect = useAppStore((s) => s.runInspect);
  const runBuild = useAppStore((s) => s.runBuild);
  const runExport = useAppStore((s) => s.runExport);
  const setTaskSetupOpen = useAppStore((s) => s.setTaskSetupOpen);

  const task = tasks.find((t) => t.id === activeTaskId) ?? null;

  if (!task) {
    return (
      <aside className="panel">
        <div style={{ margin: 'auto', padding: 24 }}>
          <EmptyState
            title="工程交付面板"
            hint="没有工程任务时这里为空。创建验收单后，可查看验收状态、证据、产物与设备。"
            actions={
              <button type="button" className="fd-btn fd-btn--primary" onClick={() => setTaskSetupOpen('create')}>
                创建工程任务
              </button>
            }
          />
        </div>
      </aside>
    );
  }

  const judge = computeTaskAcceptance({ acceptance: task.acceptance, stale: task.hasStaleEvidence });
  const taskPendingAuths = pendingAuths.filter((p) => p.taskId === task.id);
  // 绑定计数与 DeviceSection 同源（device_bind 成功去重）
  const boundCount = new Set(
    task.operations
      .filter((o) => o.type === 'device_bind' && o.status === 'succeeded' && o.deviceBindingId)
      .map((o) => o.deviceBindingId),
  ).size;

  return (
    <aside className="panel">
      <div className="panel__task-head">
        <div className="panel__task-meta">
          <StatusChip tone={TASK_STATUS_TONE[task.status]}>{TASK_STATUS_LABELS_ZH[task.status]}</StatusChip>
          <span className="acceptance__count">
            验收 {judge.passedCount}/{judge.requiredTotal}
          </span>
          <Badge tone="neutral">profile {task.profileId} rev{task.profileRevision}</Badge>
        </div>
        <div className="panel__task-name">{task.title}</div>
        <div className="panel__task-meta">
          <span className="fd-code" style={{ fontSize: 10 }}>
            {task.id}
          </span>
        </div>
        <div className="panel__task-actions">
          <button
            type="button"
            className="fd-btn fd-btn--small"
            disabled={busyTools.includes('inspect')}
            onClick={() => void runInspect(task)}
            data-testid="inspect-btn"
          >
            {busyTools.includes('inspect') ? '检查中…' : '环境检查'}
          </button>
          <button
            type="button"
            className="fd-btn fd-btn--small"
            disabled={busyTools.includes('build')}
            onClick={() => void runBuild(task)}
            data-testid="build-btn"
          >
            {busyTools.includes('build') ? '构建中…' : '构建'}
          </button>
          <button
            type="button"
            className="fd-btn fd-btn--small"
            disabled={busyTools.includes('export')}
            onClick={() => void runExport(task)}
            data-testid="export-btn"
          >
            {busyTools.includes('export') ? '导出中…' : '导出交付包'}
          </button>
        </div>
        {task.lastFailure && (
          <div className="panel__row" style={{ color: '#ff8a87' }}>
            <Badge tone="danger">{failureLabel(task.lastFailure.kind)}</Badge>
            <span className="panel__row-value">{task.lastFailure.message}</span>
          </div>
        )}
      </div>

      {taskPendingAuths.length > 0 && (
        <section className="panel__section">
          {taskPendingAuths.map((p) => (
            <DeviceAuthCard key={p.operationId} pending={p} />
          ))}
        </section>
      )}

      <section className="panel__section">
        <div className="panel__section-title">验收单</div>
        <AcceptanceList task={task} />
      </section>

      <section className="panel__section">
        <div className="panel__section-title">证据</div>
        <EvidenceSnapshotCard task={task} />
      </section>

      {/* 功能分类叠放：设备/操作历史为低频区块，默认收起（标题携带计数，需要时展开） */}
      <section className="panel__section">
        <Collapse
          summary={
            <span className="panel__section-title" style={{ display: 'inline' }}>
              设备{boundCount > 0 ? `（已绑定 ${boundCount}）` : ''}
            </span>
          }
        >
          <DeviceSection task={task} devices={devices} />
        </Collapse>
      </section>

      <section className="panel__section">
        <Collapse
          summary={
            <span className="panel__section-title" style={{ display: 'inline' }}>
              操作历史（{task.operations.length}）
            </span>
          }
          defaultOpen={task.operations.some((o) => o.status === 'running' || o.status === 'awaiting_authorization')}
        >
          <OperationHistory task={task} />
        </Collapse>
      </section>

      <section className="panel__section">
        <div className="panel__section-title">产物</div>
        <ArtifactList artifacts={task.artifacts} />
        {task.latestSnapshot && (
          <div className="panel__row" style={{ fontSize: 11 }}>
            <span className="panel__row-label">输入指纹</span>
            <span className="fd-code" title={task.latestSnapshot.inputDigest}>
              {shortSha(task.latestSnapshot.inputDigest)}
            </span>
          </div>
        )}
      </section>
    </aside>
  );
}
