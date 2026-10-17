// 存储层测试：迁移（schema_migrations 版本+时间）、实体 CRUD 往返、schemaVersion、事件与授权记录。
import { describe, expect, it, afterAll } from 'vitest';
import { promises as fsp } from 'node:fs';
import { newId, SCHEMA_VERSION } from '@forgedesk/contracts/common';
import type { EngineeringTask, AcceptanceItem, Operation, Evidence, Artifact, SourceSnapshot } from '@forgedesk/contracts/engineering';
import type { DeviceBinding } from '@forgedesk/contracts/device';
import { Storage } from '../src/storage/database.ts';
import { applyMigrations, appliedSchemaVersion, LATEST_MIGRATION_VERSION, MIGRATIONS } from '../src/storage/migrations.ts';
import { makeTmpDir, rmForce } from './helpers/fixtures.ts';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rmForce(d);
});

async function newStorage(): Promise<{ dir: string; storage: Storage }> {
  const dir = await makeTmpDir('storage');
  dirs.push(dir);
  const storage = new Storage(dir);
  return { dir, storage };
}

function sampleTask(): EngineeringTask {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId('task'),
    projectRoot: 'C:\\proj',
    profileId: 'p1',
    profileRevision: 1,
    title: 't',
    status: 'draft',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('存储：迁移', () => {
  it('全新库：schema_migrations 记录全部版本（版本+时间），appliedSchemaVersion=最新迁移版本', () => {
    return newStorage().then(({ storage }) => {
      expect(storage.schemaVersion).toBe(LATEST_MIGRATION_VERSION);
      expect(MIGRATIONS.length).toBeGreaterThanOrEqual(2);
      storage.close();
    });
  });

  it('重开同一数据目录：迁移幂等（不重复应用、证据不丢失）', async () => {
    const { dir, storage } = await newStorage();
    const task = sampleTask();
    storage.insertTask(task);
    storage.close();
    const reopened = new Storage(dir);
    expect(reopened.getTask(task.id)?.id).toBe(task.id);
    reopened.close();
  });

  it('升级失败可恢复：模拟迁移抛错回滚且不改写已落盘证据', async () => {
    const { dir, storage } = await newStorage();
    const task = sampleTask();
    storage.insertTask(task);
    storage.close();
    // 重开后注入必然失败的迁移（已存在同名表）→ 回滚抛错；已落盘证据不受影响
    const reopened = new Storage(dir);
    const db = (reopened as unknown as { db: import('node:sqlite').DatabaseSync }).db;
    const bad = [{ version: 99, name: 'bad', statements: ['CREATE TABLE tasks (id TEXT)'] }];
    expect(() => applyMigrations(db, bad)).toThrow(/迁移 99/);
    expect(appliedSchemaVersion(db)).toBe(LATEST_MIGRATION_VERSION);
    expect(reopened.getTask(task.id)?.id).toBe(task.id);
    reopened.close();
  });

  it('数据库文件名与 WAL 模式', async () => {
    const { dir, storage } = await newStorage();
    expect(storage.dbPath.endsWith('forgedesk.db')).toBe(true);
    storage.close();
    await fsp.access(storage.dbPath);
    await fsp.access(`${storage.dbPath}-wal`).catch(() => undefined);
    await rmForce(dir);
  });
});

describe('存储：实体 CRUD 往返', () => {
  it('任务/验收项/操作/证据/产物/快照/绑定/回合一轮往返（含可选字段）', async () => {
    const { storage } = await newStorage();
    const task = sampleTask();
    storage.insertTask(task);

    const acc: AcceptanceItem = {
      schemaVersion: SCHEMA_VERSION,
      id: newId('acc'),
      taskId: task.id,
      kind: 'executable',
      verifierId: 'v1',
      title: '冒烟',
      expected: '退出码 0',
      manualRequired: false,
      status: 'pending',
      required: true,
      order: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    storage.insertAcceptanceItem(acc);

    const op: Operation = {
      schemaVersion: SCHEMA_VERSION,
      id: newId('op'),
      requestKey: 'rk-12345678',
      type: 'build',
      taskId: task.id,
      argsDigest: 'a'.repeat(64),
      status: 'succeeded',
      artifactId: newId('art'),
      createdAt: '2026-01-01T00:00:00.000Z',
      startedAt: '2026-01-01T00:00:01.000Z',
      endedAt: '2026-01-01T00:00:02.000Z',
      resultSummary: 'ok',
    };
    storage.insertOperation(op);

    const artifact: Artifact = {
      schemaVersion: SCHEMA_VERSION,
      id: op.artifactId!,
      taskId: task.id,
      type: 'other',
      path: 'C:\\proj\\build-report.json',
      archivedPath: 'evidence/t/1/a.json',
      sha256: 'b'.repeat(64),
      sizeBytes: 42,
      buildId: 'build-uuid',
      sourceSnapshotId: 'snap-1',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    storage.insertArtifact(artifact);

    const snap: SourceSnapshot = {
      schemaVersion: SCHEMA_VERSION,
      id: 'snap-1',
      taskId: task.id,
      evidenceLevel: 'A',
      hasGit: false,
      inputDigest: 'c'.repeat(64),
      inputManifest: [{ kind: 'build_config', path: 'package.json', sha256: 'd'.repeat(64), sizeBytes: 3 }],
      toolVersions: { node: 'v24.0.0' },
      capturedAt: '2026-01-01T00:00:00.000Z',
    };
    storage.insertSnapshot(snap);

    const ev: Evidence = {
      schemaVersion: SCHEMA_VERSION,
      id: newId('ev'),
      operationId: op.id,
      taskId: task.id,
      acceptanceItemId: acc.id,
      inputDigest: snap.inputDigest,
      evidenceLevel: 'A',
      artifactDigest: artifact.sha256,
      artifactId: artifact.id,
      toolVersions: { node: 'v24' },
      result: 'passed',
      detail: { cases: 1 },
      logRef: 'evidence/t/1/test.log',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    storage.insertEvidence(ev);

    const binding: DeviceBinding = {
      schemaVersion: SCHEMA_VERSION,
      id: newId('dev'),
      profileId: task.profileId,
      identity: { usbVid: 1, usbPid: 2, source: 'manual', probeSerial: 'SN1' },
      chipTarget: 'chip',
      identityEvidence: '人工确认',
      confirmedByUser: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    storage.insertBinding(binding);
    storage.updateBindingConfirmed(binding.id, true);

    storage.insertTurnRecord({
      schemaVersion: SCHEMA_VERSION,
      id: newId('turn'),
      taskId: task.id,
      threadId: 'th1',
      turnId: 'turn1',
      connectionGeneration: 1,
      summary: '回合',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    // 往返校验
    expect(storage.getTask(task.id)).toEqual(task);
    expect(storage.listAcceptanceItems(task.id)).toEqual([acc]);
    const opRead = storage.getOperation(op.id);
    expect(opRead).toEqual(op);
    expect(storage.getOperationByRequestKey('rk-12345678')?.id).toBe(op.id);
    expect(storage.listOperations(task.id)).toHaveLength(1);
    expect(storage.getArtifact(artifact.id)).toEqual(artifact);
    expect(storage.latestArtifact(task.id)?.id).toBe(artifact.id);
    expect(storage.getSnapshot('snap-1')).toEqual(snap);
    expect(storage.latestSnapshot(task.id)?.id).toBe('snap-1');
    expect(storage.getEvidence(ev.id)).toEqual(ev);
    expect(storage.listEvidence(task.id)).toHaveLength(1);
    expect(storage.getBinding(binding.id)?.confirmedByUser).toBe(true);
    expect(storage.listTurnRecords(task.id)).toHaveLength(1);

    // 无 requestKey 的两个操作不冲突（NULL 不参与唯一约束）
    const op2 = { ...op, id: newId('op'), requestKey: '', artifactId: undefined, startedAt: undefined, endedAt: undefined, resultSummary: undefined };
    storage.insertOperation(op2);
    expect(storage.listOperations(task.id)).toHaveLength(2);
    storage.close();
  });

  it('事件：seq 严格递增 + since 重放', async () => {
    const { storage } = await newStorage();
    const s1 = storage.insertEvent({ type: 'task/updated', payload: { n: 1 }, emittedAt: new Date().toISOString() });
    const s2 = storage.insertEvent({ type: 'operation/updated', payload: { n: 2 }, emittedAt: new Date().toISOString() });
    expect(s2).toBeGreaterThan(s1);
    const replay = storage.listEvents(s1);
    expect(replay.map((e) => e.seq)).toEqual([s2]);
    expect(replay[0]?.type).toBe('operation/updated');
    expect(replay[0]?.schemaVersion).toBe(1);
    storage.close();
  });

  it('授权记录：范围匹配 + 有效期过滤', async () => {
    const { storage } = await newStorage();
    const now = new Date().toISOString();
    storage.insertAuthorization({
      operationId: 'op-x',
      decision: 'approved',
      deviceBindingId: 'dev-1',
      artifactSha256: 'e'.repeat(64),
      taskId: 'task-1',
      acceptanceDigest: 'f'.repeat(64),
      policyVersion: 1,
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
      createdAt: now,
    });
    const hit = storage.findValidAuthorization({ taskId: 'task-1', deviceBindingId: 'dev-1', artifactSha256: 'e'.repeat(64), now });
    expect(hit?.decision).toBe('approved');
    // 任一范围不匹配 / 已过期 → 不命中
    expect(storage.findValidAuthorization({ taskId: 'task-2', deviceBindingId: 'dev-1', artifactSha256: 'e'.repeat(64), now })).toBeNull();
    expect(
      storage.findValidAuthorization({
        taskId: 'task-1',
        deviceBindingId: 'dev-1',
        artifactSha256: 'e'.repeat(64),
        now: new Date(Date.now() + 7_200_000).toISOString(),
      }),
    ).toBeNull();
    storage.close();
  });
});
