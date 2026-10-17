﻿﻿﻿/**
 * 测试夹具：契约实体的最小合法构造（真实形状，不伪造状态）。
 */
import type {
  AcceptanceItem,
  AcceptanceItemStatus,
  Artifact,
  ArtifactType,
  EvidenceLevel,
  Operation,
  OperationStatus,
  OperationType,
  SourceSnapshot,
  TaskOverview,
  TaskStatus,
} from '../../contracts/engineering';

const NOW = '2026-10-14T10:00:00.000Z';

export function makeAcceptance(partial: Partial<AcceptanceItem> & { id: string; taskId: string }): AcceptanceItem {
  return {
    schemaVersion: 1,
    kind: 'executable',
    title: '验收项',
    expected: '通过标准',
    manualRequired: false,
    status: 'pending',
    required: true,
    order: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...partial,
  };
}

export function makeOperation(
  partial: Partial<Operation> & { id: string; taskId: string; type: OperationType; status: OperationStatus },
): Operation {
  return {
    schemaVersion: 1,
    requestKey: `rk-${partial.id ?? 'op'}`,
    argsDigest: '0'.repeat(64),
    createdAt: NOW,
    ...partial,
  };
}

export function makeArtifact(partial: Partial<Artifact> & { id: string; taskId: string }): Artifact {
  return {
    schemaVersion: 1,
    type: 'firmware_bin' as ArtifactType,
    path: `E:\\proj\\out\\${partial.id}.bin`,
    sha256: 'a'.repeat(64),
    sizeBytes: 2048,
    sourceSnapshotId: 'snap-1',
    createdAt: NOW,
    ...partial,
  };
}

export function makeSnapshot(partial: Partial<SourceSnapshot> = {}): SourceSnapshot {
  return {
    schemaVersion: 1,
    id: 'snap-1',
    taskId: 'task-1',
    evidenceLevel: 'A' as EvidenceLevel,
    hasGit: true,
    gitCommit: 'c0ffee',
    gitBranch: 'main',
    inputDigest: 'b'.repeat(64),
    inputManifest: [],
    toolVersions: { node: '22.0.0' },
    capturedAt: NOW,
    ...partial,
  };
}

export function makeTaskOverview(partial: Partial<TaskOverview> & { id: string }): TaskOverview {
  return {
    schemaVersion: 1,
    profileId: 'sample-tool',
    profileRevision: 1,
    title: '示例工程任务',
    status: 'running' as TaskStatus,
    projectRoot: 'E:\\proj',
    createdAt: NOW,
    updatedAt: NOW,
    acceptance: [],
    artifacts: [],
    operations: [],
    evidence: [],
    hasStaleEvidence: false,
    ...partial,
  };
}

export type { AcceptanceItemStatus };
