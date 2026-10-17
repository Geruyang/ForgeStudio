/**
 * 存储迁移（schemaVersion=1）。
 * - 迁移记录表 schema_migrations(version, name, applied_at)：版本+时间
 * - 每个迁移在独立事务中执行：失败即回滚，不污染已落盘的证据事实；下次启动重放
 * - 所有实体表带 schema_version 列
 */
import type { DatabaseSync } from 'node:sqlite';

export const RUNNER_SCHEMA_VERSION = 1;

export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema-v1',
    statements: [
      `CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        thread_id TEXT,
        turn_id TEXT,
        project_root TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        profile_revision INTEGER NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_failure TEXT
      )`,
      `CREATE TABLE acceptance_items (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        verifier_id TEXT,
        title TEXT NOT NULL,
        expected TEXT NOT NULL,
        manual_required INTEGER NOT NULL,
        status TEXT NOT NULL,
        required INTEGER NOT NULL,
        order_index INTEGER NOT NULL,
        last_evidence_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX acceptance_task_idx ON acceptance_items(task_id)`,
      `CREATE TABLE source_snapshots (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        task_id TEXT NOT NULL,
        evidence_level TEXT NOT NULL,
        git_commit TEXT,
        git_branch TEXT,
        has_git INTEGER NOT NULL,
        dirty_diff_digest TEXT,
        untracked_digest TEXT,
        input_digest TEXT NOT NULL,
        input_manifest TEXT NOT NULL,
        snapshot_path TEXT,
        tool_versions TEXT NOT NULL,
        captured_at TEXT NOT NULL
      )`,
      `CREATE INDEX snapshot_task_idx ON source_snapshots(task_id, captured_at)`,
      `CREATE TABLE operations (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        request_key TEXT,
        type TEXT NOT NULL,
        task_id TEXT NOT NULL,
        args_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        device_binding_id TEXT,
        artifact_id TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        authorization_requested_at TEXT,
        failure TEXT,
        result_summary TEXT
      )`,
      `CREATE UNIQUE INDEX operations_request_key_uidx ON operations(request_key)`,
      `CREATE INDEX operations_task_idx ON operations(task_id, created_at)`,
      `CREATE TABLE evidence (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        operation_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        acceptance_item_id TEXT,
        input_digest TEXT NOT NULL,
        evidence_level TEXT NOT NULL,
        artifact_digest TEXT,
        artifact_id TEXT,
        tool_versions TEXT NOT NULL,
        result TEXT NOT NULL,
        detail TEXT,
        log_ref TEXT,
        artifact_refs TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX evidence_task_idx ON evidence(task_id, created_at)`,
      `CREATE TABLE device_bindings (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        profile_id TEXT NOT NULL,
        identity TEXT NOT NULL,
        chip_target TEXT NOT NULL,
        serial_port TEXT,
        identity_evidence TEXT NOT NULL,
        confirmed_by_user INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        path TEXT NOT NULL,
        archived_path TEXT,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        build_id TEXT,
        source_snapshot_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX artifacts_task_idx ON artifacts(task_id, created_at)`,
      `CREATE TABLE turn_records (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        task_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        connection_generation INTEGER NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 2,
    name: 'events-and-authorizations',
    statements: [
      // runner 事件（SSE 重放来源，seq 自增）
      `CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        task_id TEXT,
        operation_id TEXT,
        payload TEXT NOT NULL,
        emitted_at TEXT NOT NULL
      )`,
      // 设备授权范围持久化（§10.3：授权范围与有效期）
      `CREATE TABLE authorizations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        device_binding_id TEXT,
        artifact_sha256 TEXT,
        task_id TEXT NOT NULL,
        acceptance_digest TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        valid_until TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX authorizations_scope_idx ON authorizations(task_id, device_binding_id, artifact_sha256)`,
    ],
  },
];

/** 最新迁移版本（迁移版本独立于实体 schemaVersion） */
export const LATEST_MIGRATION_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/** 应用迁移：逐个事务执行并记录。重复调用幂等（已应用的跳过）；失败回滚不破坏已应用版本。 */
export function applyMigrations(db: DatabaseSync, migrations: Migration[] = MIGRATIONS): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`,
  );
  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{
    version: number;
  }>;
  const applied = new Set(appliedRows.map((r) => Number(r.version)));
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    // 独立事务：失败整体回滚，不改写已有证据事实，下次启动可重放
    db.exec('BEGIN');
    try {
      for (const statement of migration.statements) {
        db.exec(statement);
      }
      db
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`迁移 ${migration.version}(${migration.name}) 失败，已回滚: ${String(error)}`);
    }
  }
}

/** 当前已应用的最高版本（供诊断与测试） */
export function appliedSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as
    | { v: number | null }
    | undefined;
  return Number(row?.v ?? 0);
}
