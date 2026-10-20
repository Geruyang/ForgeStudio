/**
 * 薄存储层：node:sqlite（DatabaseSync）单文件 DB（<dataDir>/forgedesk.db），WAL 模式。
 * 只提供纯 CRUD + 事务，不做任何业务判定（状态机/判定在 ops 层）。
 * 日志与产物副本放 dataDir/evidence 文件目录；数据库只存引用与哈希。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type {
  EngineeringTask,
  AcceptanceItem,
  SourceSnapshot,
  Operation,
  Evidence,
  Artifact,
  TurnRecord,
  SourceInputDigest,
} from '@forgedesk/contracts/engineering';
import type { DeviceBinding } from '@forgedesk/contracts/device';
import type { RunnerEvent, RunnerEventType } from '@forgedesk/contracts/runner';
import type { Sha256 } from '@forgedesk/contracts/common';
import { applyMigrations, appliedSchemaVersion, LATEST_MIGRATION_VERSION } from './migrations.ts';

type Row = Record<string, unknown>;

const fromBool = (v: unknown): boolean => Number(v) === 1;
const toBool = (v: boolean): number => (v ? 1 : 0);
const jstr = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));
function jparse<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || v === null) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}
const nnull = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));

/** schema_version 列读取（存储层与代码版本绑定，异常值按 v1 兜底） */
const asVer = (v: unknown): 1 => (Number(v) === 1 ? 1 : 1);

/** 设备授权记录（§10.3 授权范围持久化） */
export interface AuthorizationRecord {
  id?: number;
  operationId: string;
  decision: 'approved' | 'declined';
  deviceBindingId?: string;
  artifactSha256?: string;
  taskId: string;
  acceptanceDigest: string;
  policyVersion: number;
  validUntil: string;
  createdAt: string;
}

export class Storage {
  readonly dbPath: string;
  readonly schemaVersion: number;
  private readonly db: DatabaseSync;
  private txDepth = 0;

  constructor(dataDir: string, opts?: { fileName?: string }) {
    mkdirSync(dataDir, { recursive: true });
    this.dbPath = path.join(dataDir, opts?.fileName ?? 'forgedesk.db');
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    applyMigrations(this.db);
    this.schemaVersion = appliedSchemaVersion(this.db);
    if (this.schemaVersion < LATEST_MIGRATION_VERSION) {
      // MIGRATIONS 全量应用后仍落后即为异常（不静默降级）
      throw new Error(`schema_migrations 落后于代码版本: ${this.schemaVersion} < ${LATEST_MIGRATION_VERSION}`);
    }
  }

  /** 事务（可嵌套计数；最外层失败回滚全部） */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.db.exec('BEGIN');
    this.txDepth += 1;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.txDepth -= 1;
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------------------
  // tasks
  // ---------------------------------------------------------------------------

  private static taskFromRow(row: Row): EngineeringTask {
    return {
      schemaVersion: asVer(row.schema_version),
      id: String(row.id),
      threadId: nnull(row.thread_id) ?? undefined,
      turnId: nnull(row.turn_id) ?? undefined,
      projectRoot: String(row.project_root),
      profileId: String(row.profile_id),
      profileRevision: Number(row.profile_revision),
      title: String(row.title),
      status: row.status as EngineeringTask['status'],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastFailure: jparse<EngineeringTask['lastFailure']>(row.last_failure, undefined),
    };
  }

  insertTask(task: EngineeringTask): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, schema_version, thread_id, turn_id, project_root, profile_id, profile_revision, title, status, created_at, updated_at, last_failure)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.schemaVersion,
        task.threadId ?? null,
        task.turnId ?? null,
        task.projectRoot,
        task.profileId,
        task.profileRevision,
        task.title,
        task.status,
        task.createdAt,
        task.updatedAt,
        jstr(task.lastFailure),
      );
  }

  updateTask(task: EngineeringTask): void {
    this.db
      .prepare(
        `UPDATE tasks SET thread_id = ?, turn_id = ?, profile_revision = ?, status = ?, updated_at = ?, last_failure = ? WHERE id = ?`,
      )
      .run(
        task.threadId ?? null,
        task.turnId ?? null,
        task.profileRevision,
        task.status,
        task.updatedAt,
        jstr(task.lastFailure),
        task.id,
      );
  }

  getTask(id: string): EngineeringTask | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return row ? Storage.taskFromRow(row) : null;
  }

  listTasks(): EngineeringTask[] {
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all() as Row[];
    return rows.map((r) => Storage.taskFromRow(r));
  }

  // ---------------------------------------------------------------------------
  // acceptance items
  // ---------------------------------------------------------------------------

  private static accFromRow(row: Row): AcceptanceItem {
    return {
      schemaVersion: asVer(row.schema_version),
      id: String(row.id),
      taskId: String(row.task_id),
      kind: row.kind as AcceptanceItem['kind'],
      verifierId: nnull(row.verifier_id) ?? undefined,
      title: String(row.title),
      expected: String(row.expected),
      manualRequired: fromBool(row.manual_required),
      status: row.status as AcceptanceItem['status'],
      required: fromBool(row.required),
      order: Number(row.order_index),
      lastEvidenceId: nnull(row.last_evidence_id) ?? undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  insertAcceptanceItem(item: AcceptanceItem): void {
    this.db
      .prepare(
        `INSERT INTO acceptance_items (id, schema_version, task_id, kind, verifier_id, title, expected, manual_required, status, required, order_index, last_evidence_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.schemaVersion,
        item.taskId,
        item.kind,
        item.verifierId ?? null,
        item.title,
        item.expected,
        toBool(item.manualRequired),
        item.status,
        toBool(item.required),
        item.order,
        item.lastEvidenceId ?? null,
        item.createdAt,
        item.updatedAt,
      );
  }

  updateAcceptanceItem(item: AcceptanceItem): void {
    this.db
      .prepare(
        `UPDATE acceptance_items SET kind = ?, verifier_id = ?, title = ?, expected = ?, manual_required = ?, status = ?, required = ?, order_index = ?, last_evidence_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        item.kind,
        item.verifierId ?? null,
        item.title,
        item.expected,
        toBool(item.manualRequired),
        item.status,
        toBool(item.required),
        item.order,
        item.lastEvidenceId ?? null,
        item.updatedAt,
        item.id,
      );
  }

  deleteAcceptanceItems(taskId: string): void {
    this.db.prepare('DELETE FROM acceptance_items WHERE task_id = ?').run(taskId);
  }

  deleteAcceptanceItem(id: string): void {
    this.db.prepare('DELETE FROM acceptance_items WHERE id = ?').run(id);
  }

  getAcceptanceItem(id: string): AcceptanceItem | null {
    const row = this.db.prepare('SELECT * FROM acceptance_items WHERE id = ?').get(id) as Row | undefined;
    return row ? Storage.accFromRow(row) : null;
  }

  listAcceptanceItems(taskId: string): AcceptanceItem[] {
    const rows = this.db
      .prepare('SELECT * FROM acceptance_items WHERE task_id = ? ORDER BY order_index, created_at')
      .all(taskId) as Row[];
    return rows.map((r) => Storage.accFromRow(r));
  }

  // ---------------------------------------------------------------------------
  // source snapshots
  // ---------------------------------------------------------------------------

  private static snapFromRow(row: Row): SourceSnapshot {
    return {
      schemaVersion: asVer(row.schema_version),
      id: String(row.id),
      taskId: String(row.task_id),
      evidenceLevel: row.evidence_level as SourceSnapshot['evidenceLevel'],
      gitCommit: nnull(row.git_commit) ?? undefined,
      gitBranch: nnull(row.git_branch) ?? undefined,
      hasGit: fromBool(row.has_git),
      dirtyDiffDigest: nnull(row.dirty_diff_digest) ?? undefined,
      untrackedDigest: nnull(row.untracked_digest) ?? undefined,
      inputDigest: String(row.input_digest) as Sha256,
      inputManifest: jparse<SourceInputDigest[]>(row.input_manifest, []),
      snapshotPath: nnull(row.snapshot_path) ?? undefined,
      toolVersions: jparse<Record<string, string>>(row.tool_versions, {}),
      capturedAt: String(row.captured_at),
    };
  }

  insertSnapshot(snap: SourceSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO source_snapshots (id, schema_version, task_id, evidence_level, git_commit, git_branch, has_git, dirty_diff_digest, untracked_digest, input_digest, input_manifest, snapshot_path, tool_versions, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snap.id,
        snap.schemaVersion,
        snap.taskId,
        snap.evidenceLevel,
        snap.gitCommit ?? null,
        snap.gitBranch ?? null,
        toBool(snap.hasGit),
        snap.dirtyDiffDigest ?? null,
        snap.untrackedDigest ?? null,
        snap.inputDigest,
        JSON.stringify(snap.inputManifest),
        snap.snapshotPath ?? null,
        JSON.stringify(snap.toolVersions),
        snap.capturedAt,
      );
  }

  getSnapshot(id: string): SourceSnapshot | null {
    const row = this.db.prepare('SELECT * FROM source_snapshots WHERE id = ?').get(id) as Row | undefined;
    return row ? Storage.snapFromRow(row) : null;
  }

  listSnapshots(taskId: string): SourceSnapshot[] {
    const rows = this.db
      .prepare('SELECT * FROM source_snapshots WHERE task_id = ? ORDER BY captured_at')
      .all(taskId) as Row[];
    return rows.map((r) => Storage.snapFromRow(r));
  }

  latestSnapshot(taskId: string): SourceSnapshot | null {
    const rows = this.db
      .prepare('SELECT * FROM source_snapshots WHERE task_id = ? ORDER BY captured_at DESC LIMIT 1')
      .all(taskId) as Row[];
    return rows.length > 0 ? Storage.snapFromRow(rows[0]) : null;
  }

  // ---------------------------------------------------------------------------
  // operations
  // ---------------------------------------------------------------------------

  private static opFromRow(row: Row): Operation {
    return {
      schemaVersion: asVer(row.schema_version),
      id: String(row.id),
      requestKey: nnull(row.request_key) ?? '',
      type: row.type as Operation['type'],
      taskId: String(row.task_id),
      argsDigest: String(row.args_digest),
      status: row.status as Operation['status'],
      deviceBindingId: nnull(row.device_binding_id) ?? undefined,
      artifactId: nnull(row.artifact_id) ?? undefined,
      createdAt: String(row.created_at),
      startedAt: nnull(row.started_at) ?? undefined,
      endedAt: nnull(row.ended_at) ?? undefined,
      authorizationRequestedAt: nnull(row.authorization_requested_at) ?? undefined,
      failure: jparse<Operation['failure']>(row.failure, undefined),
      resultSummary: nnull(row.result_summary) ?? undefined,
    };
  }

  insertOperation(op: Operation): void {
    this.db
      .prepare(
        `INSERT INTO operations (id, schema_version, request_key, type, task_id, args_digest, status, device_binding_id, artifact_id, created_at, started_at, ended_at, authorization_requested_at, failure, result_summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        op.id,
        op.schemaVersion,
        // 空串统一落 NULL：SQLite UNIQUE 索引允许多个 NULL，避免无键操作互相冲突
        op.requestKey || null,
        op.type,
        op.taskId,
        op.argsDigest,
        op.status,
        op.deviceBindingId ?? null,
        op.artifactId ?? null,
        op.createdAt,
        op.startedAt ?? null,
        op.endedAt ?? null,
        op.authorizationRequestedAt ?? null,
        jstr(op.failure),
        op.resultSummary ?? null,
      );
  }

  updateOperation(op: Operation): void {
    this.db
      .prepare(
        `UPDATE operations SET status = ?, device_binding_id = ?, artifact_id = ?, started_at = ?, ended_at = ?, authorization_requested_at = ?, failure = ?, result_summary = ? WHERE id = ?`,
      )
      .run(
        op.status,
        op.deviceBindingId ?? null,
        op.artifactId ?? null,
        op.startedAt ?? null,
        op.endedAt ?? null,
        op.authorizationRequestedAt ?? null,
        jstr(op.failure),
        op.resultSummary ?? null,
        op.id,
      );
  }

  getOperation(id: string): Operation | null {
    const row = this.db.prepare('SELECT * FROM operations WHERE id = ?').get(id) as Row | undefined;
    return row ? Storage.opFromRow(row) : null;
  }

  getOperationByRequestKey(requestKey: string): Operation | null {
    const row = this.db.prepare('SELECT * FROM operations WHERE request_key = ?').get(requestKey) as
      | Row
      | undefined;
    return row ? Storage.opFromRow(row) : null;
  }

  listOperations(taskId: string): Operation[] {
    const rows = this.db
      .prepare('SELECT * FROM operations WHERE task_id = ? ORDER BY created_at')
      .all(taskId) as Row[];
    return rows.map((r) => Storage.opFromRow(r));
  }

  // ---------------------------------------------------------------------------
  // evidence
  // ---------------------------------------------------------------------------

  private static evFromRow(row: Row): Evidence {
    return {
      schemaVersion: asVer(row.schema_version),
      id: String(row.id),
      operationId: String(row.operation_id),
      taskId: String(row.task_id),
      acceptanceItemId: nnull(row.acceptance_item_id) ?? undefined,
      inputDigest: String(row.input_digest),
      evidenceLevel: row.evidence_level as Evidence['evidenceLevel'],
      artifactDigest: nnull(row.artifact_digest) ?? undefined,
      artifactId: nnull(row.artifact_id) ?? undefined,
      toolVersions: jparse<Record<string, string>>(row.tool_versions, {}),
      result: row.result as Evidence['result'],
      detail: jparse<unknown>(row.detail, null),
      logRef: nnull(row.log_ref) ?? undefined,
      artifactRefs: jparse<string[] | undefined>(row.artifact_refs, undefined),
      createdAt: String(row.created_at),
    };
  }

  insertEvidence(ev: Evidence): void {
    this.db
      .prepare(
        `INSERT INTO evidence (id, schema_version, operation_id, task_id, acceptance_item_id, input_digest, evidence_level, artifact_digest, artifact_id, tool_versions, result, detail, log_ref, artifact_refs, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ev.id,
        ev.schemaVersion,
        ev.operationId,
        ev.taskId,
        ev.acceptanceItemId ?? null,
        ev.inputDigest,
        ev.evidenceLevel,
        ev.artifactDigest ?? null,
        ev.artifactId ?? null,
        JSON.stringify(ev.toolVersions),
        ev.result,
        jstr(ev.detail),
        ev.logRef ?? null,
        jstr(ev.artifactRefs),
        ev.createdAt,
      );
  }

  getEvidence(id: string): Evidence | null {
    const row = this.db.prepare('SELECT * FROM evidence WHERE id = ?').get(id) as Row | undefined;
    return row ? Storage.evFromRow(row) : null;
  }

  listEvidence(taskId: string): Evidence[] {
    const rows = this.db
      .prepare('SELECT * FROM evidence WHERE task_id = ? ORDER BY created_at')
      .all(taskId) as Row[];
    return rows.map((r) => Storage.evFromRow(r));
  }

  // ---------------------------------------------------------------------------
  // device bindings
  // ---------------------------------------------------------------------------

  private static bindFromRow(row: Row): DeviceBinding {
    return {
      schemaVersion: asVer(row.schema_version),
      id: String(row.id),
      profileId: String(row.profile_id),
      identity: jparse<DeviceBinding['identity']>(row.identity, {
        usbVid: 0,
        usbPid: 0,
        source: 'manual',
      }),
      chipTarget: String(row.chip_target),
      serialPort: nnull(row.serial_port) ?? undefined,
      identityEvidence: String(row.identity_evidence),
      confirmedByUser: fromBool(row.confirmed_by_user),
      createdAt: String(row.created_at),
    };
  }

  insertBinding(binding: DeviceBinding): void {
    this.db
      .prepare(
        `INSERT INTO device_bindings (id, schema_version, profile_id, identity, chip_target, serial_port, identity_evidence, confirmed_by_user, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        binding.id,
        binding.schemaVersion,
        binding.profileId,
        JSON.stringify(binding.identity),
        binding.chipTarget,
        binding.serialPort ?? null,
        binding.identityEvidence,
        toBool(binding.confirmedByUser),
        binding.createdAt,
      );
  }

  updateBindingConfirmed(id: string, confirmedByUser: boolean): void {
    this.db
      .prepare('UPDATE device_bindings SET confirmed_by_user = ? WHERE id = ?')
      .run(toBool(confirmedByUser), id);
  }

  getBinding(id: string): DeviceBinding | null {
    const row = this.db.prepare('SELECT * FROM device_bindings WHERE id = ?').get(id) as Row | undefined;
    return row ? Storage.bindFromRow(row) : null;
  }

  listBindings(): DeviceBinding[] {
    const rows = this.db.prepare('SELECT * FROM device_bindings ORDER BY created_at').all() as Row[];
    return rows.map((r) => Storage.bindFromRow(r));
  }

  // ---------------------------------------------------------------------------
  // artifacts
  // ---------------------------------------------------------------------------

  private static artFromRow(row: Row): Artifact {
    return {
      schemaVersion: asVer(row.schema_version),
      id: String(row.id),
      taskId: String(row.task_id),
      type: row.type as Artifact['type'],
      path: String(row.path),
      archivedPath: nnull(row.archived_path) ?? undefined,
      sha256: String(row.sha256),
      sizeBytes: Number(row.size_bytes),
      buildId: nnull(row.build_id) ?? undefined,
      sourceSnapshotId: String(row.source_snapshot_id),
      createdAt: String(row.created_at),
    };
  }

  insertArtifact(artifact: Artifact): void {
    this.db
      .prepare(
        `INSERT INTO artifacts (id, schema_version, task_id, type, path, archived_path, sha256, size_bytes, build_id, source_snapshot_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id,
        artifact.schemaVersion,
        artifact.taskId,
        artifact.type,
        artifact.path,
        artifact.archivedPath ?? null,
        artifact.sha256,
        artifact.sizeBytes,
        artifact.buildId ?? null,
        artifact.sourceSnapshotId,
        artifact.createdAt,
      );
  }

  getArtifact(id: string): Artifact | null {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Row | undefined;
    return row ? Storage.artFromRow(row) : null;
  }

  listArtifacts(taskId: string): Artifact[] {
    const rows = this.db
      .prepare('SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at')
      .all(taskId) as Row[];
    return rows.map((r) => Storage.artFromRow(r));
  }

  latestArtifact(taskId: string): Artifact | null {
    const rows = this.db
      .prepare('SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at DESC LIMIT 1')
      .all(taskId) as Row[];
    return rows.length > 0 ? Storage.artFromRow(rows[0]) : null;
  }

  // ---------------------------------------------------------------------------
  // turn records
  // ---------------------------------------------------------------------------

  insertTurnRecord(record: TurnRecord): void {
    this.db
      .prepare(
        `INSERT INTO turn_records (id, schema_version, task_id, thread_id, turn_id, connection_generation, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.schemaVersion,
        record.taskId,
        record.threadId,
        record.turnId,
        record.connectionGeneration,
        record.summary,
        record.createdAt,
      );
  }

  listTurnRecords(taskId: string): TurnRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM turn_records WHERE task_id = ? ORDER BY created_at')
      .all(taskId) as Row[];
    return rows.map((r) => {
      return {
        schemaVersion: asVer(r.schema_version),
        id: String(r.id),
        taskId: String(r.task_id),
        threadId: String(r.thread_id),
        turnId: String(r.turn_id),
        connectionGeneration: Number(r.connection_generation),
        summary: String(r.summary),
        createdAt: String(r.created_at),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // events（runner 事件：seq 自增，SSE 重放来源）
  // ---------------------------------------------------------------------------

  insertEvent(input: {
    type: RunnerEventType;
    taskId?: string;
    operationId?: string;
    payload: unknown;
    emittedAt: string;
  }): number {
    const result = this.db
      .prepare('INSERT INTO events (type, task_id, operation_id, payload, emitted_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.type, input.taskId ?? null, input.operationId ?? null, JSON.stringify(input.payload), input.emittedAt);
    return Number(result.lastInsertRowid);
  }

  listEvents(sinceSeq: number, limit = 5000): RunnerEvent[] { // R2-BUG6 修复：上限 1000→5000（长时间断线重连不丢失事件）
    const rows = this.db
      .prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?')
      .all(sinceSeq, limit) as Row[];
    return rows.map((r) => ({
      schemaVersion: 1,
      seq: Number(r.seq),
      type: String(r.type) as RunnerEventType,
      taskId: nnull(r.task_id) ?? undefined,
      operationId: nnull(r.operation_id) ?? undefined,
      payload: jparse<unknown>(r.payload, null),
      emittedAt: String(r.emitted_at),
    }));
  }

  latestEventSeq(): number {
    const row = this.db.prepare('SELECT MAX(seq) AS s FROM events').get() as { s: number | null } | undefined;
    return Number(row?.s ?? 0);
  }

  // ---------------------------------------------------------------------------
  // authorizations（设备授权范围持久化，§10.3）
  // ---------------------------------------------------------------------------

  insertAuthorization(record: AuthorizationRecord): void {
    this.db
      .prepare(
        `INSERT INTO authorizations (operation_id, decision, device_binding_id, artifact_sha256, task_id, acceptance_digest, policy_version, valid_until, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.operationId,
        record.decision,
        record.deviceBindingId ?? null,
        record.artifactSha256 ?? null,
        record.taskId,
        record.acceptanceDigest,
        record.policyVersion,
        record.validUntil,
        record.createdAt,
      );
  }

  /** 查找仍有效的授权（approved + 范围一致 + 未到期） */
  findValidAuthorization(scope: {
    taskId: string;
    deviceBindingId?: string;
    artifactSha256?: string;
    /** BUG4 修复：验收规则变化须重新授权——查询时同时匹配 acceptance_digest */
    acceptanceDigest?: string;
    now: string;
  }): AuthorizationRecord | null {
    const rows = this.db
      .prepare(
        `SELECT * FROM authorizations
         WHERE decision = 'approved' AND task_id = ? AND device_binding_id IS ?
           AND artifact_sha256 IS ? AND valid_until > ?
           ${scope.acceptanceDigest ? 'AND acceptance_digest = ?' : ''}
         ORDER BY id DESC LIMIT 1`,
      )
      .all(
        ...(scope.acceptanceDigest
          ? [scope.taskId, scope.deviceBindingId ?? null, scope.artifactSha256 ?? null, scope.now, scope.acceptanceDigest]
          : [scope.taskId, scope.deviceBindingId ?? null, scope.artifactSha256 ?? null, scope.now]),
      ) as Row[];
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: Number(r.id),
      operationId: String(r.operation_id),
      decision: 'approved',
      deviceBindingId: nnull(r.device_binding_id) ?? undefined,
      artifactSha256: nnull(r.artifact_sha256) ?? undefined,
      taskId: String(r.task_id),
      acceptanceDigest: String(r.acceptance_digest),
      policyVersion: Number(r.policy_version),
      validUntil: String(r.valid_until),
      createdAt: String(r.created_at),
    };
  }

  // ---------------------------------------------------------------------------
  // kv（游标等辅助数据）
  // ---------------------------------------------------------------------------

  setKv(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, new Date().toISOString());
  }

  getKv(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }

  deleteKv(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }

  listKv(prefix: string): Array<{ key: string; value: string }> {
    const rows = this.db
      .prepare('SELECT key, value FROM kv WHERE key LIKE ? ORDER BY key')
      .all(`${prefix}%`) as Row[];
    return rows.map((r) => ({ key: String(r.key), value: String(r.value) }));
  }

  /** 供诊断读取存储健康（不暴露连接细节） */
  checkHealth(): boolean {
    try {
      const row = this.db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as Row;
      return Number(row.c) > 0;
    } catch {
      return false;
    }
  }
}
