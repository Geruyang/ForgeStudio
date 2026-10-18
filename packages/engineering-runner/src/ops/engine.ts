/**
 * 操作引擎：状态机执行、requestKey 幂等、七工具实现、设备授权框架、事件总线。
 * 核心不变量：执行器是验收事实的唯一写入者——只有真实执行（命令退出码/输出规则）
 * 才能产生 passed Evidence 并点亮 AcceptanceItem；模型自评/未执行操作永远不点亮。
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { newId, SCHEMA_VERSION } from '@forgedesk/contracts/common';
import type {
  EngineeringTask,
  AcceptanceItem,
  Operation,
  OperationStatus,
  OperationType,
  Evidence,
  Artifact,
  TaskOverview,
} from '@forgedesk/contracts/engineering';
import { computeTaskAcceptance } from '@forgedesk/contracts/engineering';
import type {
  InspectInput,
  InspectOutput,
  BuildInput,
  BuildOutput,
  TestInput,
  TestOutput,
  DeviceBindInput,
  DeviceBindOutput,
  DeviceFlashInput,
  DeviceFlashOutput,
  DeviceVerifyInput,
  DeviceVerifyOutput,
  ExportInput,
  ExportOutput,
  ToolFailure,
} from '@forgedesk/contracts/mcp';
import type {
  CreateTaskRequest,
  PendingAuthorization,
  AuthorizeRequest,
  RunnerEvent,
  RunnerEventType,
  RunnerDiagnostics,
  CancelRequest,
} from '@forgedesk/contracts/runner';
import type { DeviceBinding, EnumeratedDevice } from '@forgedesk/contracts/device';
import type { DeviceAdapter } from '../internal/device-port.ts';
import type { LoadedProfile } from '../../../contracts/src/profile.ts';
import type { Storage } from '../storage/database.ts';
import type { ProfileLoader } from '../profiles/loader.ts';
import {
  captureSourceSnapshot,
  copySnapshotFiles,
  SnapshotLimitError,
} from '../snapshot/source-snapshot.ts';
import { walkFiles, sha256File, sha256Of, canonicalJson, toPosix, matchAny } from '../snapshot/digests.ts';
import { probeToolVersions, isGitAvailable } from '../snapshot/tool-versions.ts';
import { runCommand, type CommandResult } from './command.ts';
import {
  defaultSshTransport,
  buildRemoteCmdline,
  remoteTaskDir,
  collectSshTargets,
  probeSshTarget,
  type SshSession,
  type SshTransport,
} from './ssh-transport.ts';
import type { SshTarget, ProfileCommand } from '../../../contracts/src/profile.ts';
import { assertOperationTransition, isTerminalOperationStatus } from './state-machine.ts';
import { buildArgsDigest } from './keys.ts';
import { buildExportBundle, type ExportManifest } from './exporter.ts';

/** 工具输出联合（七件套） */
export type ToolOutput =
  | InspectOutput
  | BuildOutput
  | TestOutput
  | DeviceBindOutput
  | DeviceFlashOutput
  | DeviceVerifyOutput
  | ExportOutput;

/** 操作调用返回（HTTP 层消费） */
export interface OperationCallResult {
  operationId: string;
  status: OperationStatus;
  result?: ToolOutput | ToolFailure;
}

/** 设备授权等待超时（超时取消意图：副作用未发生 → cancelled） */
export const AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1000;
/** 授权批准后的有效期（同范围免重复确认，§10.3） */
export const AUTHORIZATION_VALID_MS = 60 * 60 * 1000;
/** 构建命令输出上限 */
const BUILD_OUTPUT_LIMIT = 2 * 1024 * 1024;

/** 操作被取消（副作用前/进行中经 AbortSignal） */
export class OperationCancelledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'OperationCancelledError';
  }
}

/** 任务/操作不存在 */
export class NotFoundError extends Error {}
/** 请求非法（HTTP 400 语义） */
export class BadRequestError extends Error {}

/**
 * 合法 verifierId：软件验收必须来自 profile.verifiers（模型不可编造）；
 * 设备串口验收用 "device:" 前缀（由执行器 device.verify 点亮）。
 */
function isValidVerifierId(verifierId: string | undefined, profile: { verifiers: Array<{ verifierId: string }> }): boolean {
  if (!verifierId) return false;
  if (verifierId.startsWith('device:')) return true;
  return profile.verifiers.some((v) => v.verifierId === verifierId);
}

interface PendingEntry {
  pending: PendingAuthorization;
  deviceBindingId?: string;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

interface RunningEntry {
  promise: Promise<ToolOutput | ToolFailure>;
  controller: AbortController;
}

interface ExecContext {
  op: Operation;
  signal: AbortSignal;
  /** 证据目录（绝对路径） */
  logDir: string;
  /** 写日志文件并返回相对引用（evidence/<taskId>/<opId>/<name>） */
  writeLog(name: string, content: string): Promise<string>;
  /** prepared → running（直行操作在副作用前调用） */
  start(): void;
  /** 请求设备授权：prepared → awaiting_authorization →（批准）authorized */
  requestAuthorization(spec: {
    type: PendingAuthorization['type'];
    title: string;
    scopeSummary: string;
    artifactSha256?: string;
    acceptanceDigest?: string;
    deviceBindingId?: string;
  }): Promise<boolean>;
}

export interface OpsEngineOptions {
  dataDir: string;
  storage: Storage;
  profiles: ProfileLoader;
  deviceAdapter?: DeviceAdapter | null;
  runnerVersion?: string;
  /**
   * SSH 远程执行传输（Z3-FZ3B）：profile 命令带 ssh 目标时使用；
   * 缺省为真实 ssh2 传输（密码经目标 passwordEnv 指定的环境变量注入）；测试注入 fake（标注模拟）。
   */
  sshTransport?: SshTransport;
}

export class OpsEngine {
  readonly dataDir: string;
  readonly runnerVersion: string;
  private readonly storage: Storage;
  private readonly profiles: ProfileLoader;
  private readonly deviceAdapter: DeviceAdapter | null;
  private readonly sshTransport: SshTransport;
  private readonly startedAtMs = Date.now();
  private readonly subscribers = new Set<(e: RunnerEvent) => void>();
  private readonly pendingAuths = new Map<string, PendingEntry>();
  private readonly runningOps = new Map<string, RunningEntry>();
  private readonly outputCache = new Map<string, ToolOutput | ToolFailure>();
  private lastError?: string;
  private closed = false;

  constructor(opts: OpsEngineOptions) {
    this.dataDir = opts.dataDir;
    this.storage = opts.storage;
    this.profiles = opts.profiles;
    this.deviceAdapter = opts.deviceAdapter ?? null;
    this.sshTransport = opts.sshTransport ?? defaultSshTransport;
    this.runnerVersion = opts.runnerVersion ?? '0.1.0';
  }

  // ---------------------------------------------------------------------------
  // 事件
  // ---------------------------------------------------------------------------

  emit(type: RunnerEventType, ctx: { taskId?: string; operationId?: string; payload?: unknown } = {}): RunnerEvent {
    const seq = this.storage.insertEvent({
      type,
      taskId: ctx.taskId,
      operationId: ctx.operationId,
      payload: ctx.payload ?? {},
      emittedAt: new Date().toISOString(),
    });
    const event: RunnerEvent = {
      schemaVersion: 1,
      seq,
      type,
      taskId: ctx.taskId,
      operationId: ctx.operationId,
      payload: ctx.payload ?? {},
      emittedAt: new Date().toISOString(),
    };
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        // 订阅方异常不影响事件流
      }
    }
    return event;
  }

  subscribe(fn: (e: RunnerEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  eventsSince(sinceSeq: number): RunnerEvent[] {
    return this.storage.listEvents(sinceSeq);
  }

  // ---------------------------------------------------------------------------
  // 任务与验收
  // ---------------------------------------------------------------------------

  async createTask(req: CreateTaskRequest): Promise<EngineeringTask> {
    const stat = await fsp.stat(req.projectRoot).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      throw new BadRequestError(`项目根目录不存在: ${req.projectRoot}`);
    }
    const loaded = await this.requireProfile(req.profileId);
    for (const item of req.acceptance ?? []) {
      if (item.kind === 'executable') {
        if (!isValidVerifierId(item.verifierId, loaded.profile)) {
          throw new BadRequestError(
            `验收项 "${item.title}" 引用了未知 verifier "${item.verifierId ?? ''}"（验收定义只能来自用户认可的 profile）`,
          );
        }
      }
    }
    const now = new Date().toISOString();
    const task: EngineeringTask = {
      schemaVersion: SCHEMA_VERSION,
      id: newId('task'),
      threadId: req.threadId,
      projectRoot: path.resolve(req.projectRoot),
      profileId: loaded.profile.id,
      profileRevision: loaded.profile.revision,
      title: req.title,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    };
    this.storage.insertTask(task);
    let order = 0;
    for (const item of req.acceptance ?? []) {
      const acc: AcceptanceItem = {
        schemaVersion: SCHEMA_VERSION,
        id: newId('acc'),
        taskId: task.id,
        kind: item.kind,
        verifierId: item.verifierId,
        title: item.title,
        expected: item.expected,
        manualRequired: item.manualRequired,
        status: 'pending',
        required: item.required,
        order: order++,
        createdAt: now,
        updatedAt: now,
      };
      this.storage.insertAcceptanceItem(acc);
    }
    this.emit('task/updated', { taskId: task.id, payload: { task } });
    this.emit('acceptance/updated', { taskId: task.id, payload: { acceptance: this.storage.listAcceptanceItems(task.id) } });
    return task;
  }

  /** 更新验收单（GUI/用户写入；模型只能给 proposed）。passed/failed/running/stale 只能由执行器写。 */
  updateAcceptance(
    taskId: string,
    items: Array<Partial<AcceptanceItem> & { title: string; kind: AcceptanceItem['kind'] }>,
  ): AcceptanceItem[] {
    const task = this.requireTask(taskId);
    const loaded = this.requireProfileSync(task.profileId);
    const existing = new Map(this.storage.listAcceptanceItems(taskId).map((a) => [a.id, a]));
    const allowedInputStatuses: readonly AcceptanceItem['status'][] = ['pending', 'proposed', 'not_runnable'];
    const now = new Date().toISOString();
    const next: AcceptanceItem[] = [];
    const keepIds = new Set<string>();
    let order = 0;
    for (const raw of items) {
      if (raw.status !== undefined && !allowedInputStatuses.includes(raw.status)) {
        throw new BadRequestError(
          `验收项状态 "${raw.status}" 不允许直接写入（passed/failed/stale/running 只能由执行器根据真实执行结果点亮）`,
        );
      }
      if (raw.kind === 'executable') {
        if (!isValidVerifierId(raw.verifierId, loaded.profile)) {
          throw new BadRequestError(`验收项 "${raw.title}" 引用了未知 verifier（验收定义只能来自用户认可的 profile）`);
        }
      }
      const prev = raw.id ? existing.get(raw.id) : undefined;
      if (raw.id) keepIds.add(raw.id);
      next.push({
        schemaVersion: SCHEMA_VERSION,
        id: prev?.id ?? newId('acc'),
        taskId,
        kind: raw.kind,
        verifierId: raw.verifierId ?? prev?.verifierId,
        title: raw.title,
        expected: raw.expected ?? prev?.expected ?? '',
        manualRequired: raw.manualRequired ?? prev?.manualRequired ?? false,
        status: raw.status ?? prev?.status ?? 'pending',
        required: raw.required ?? prev?.required ?? false,
        order: order++,
        // 证据绑定保留（lastEvidenceId 只由执行器更新）
        lastEvidenceId: prev?.lastEvidenceId,
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      });
    }
    this.storage.transaction(() => {
      for (const item of existing.values()) {
        if (!keepIds.has(item.id)) {
          // 全量替换语义：未出现在请求中的条目删除
          this.storage.deleteAcceptanceItem(item.id);
        }
      }
      for (const item of next) {
        if (existing.has(item.id)) this.storage.updateAcceptanceItem(item);
        else this.storage.insertAcceptanceItem(item);
      }
    });
    const acceptance = this.storage.listAcceptanceItems(taskId);
    this.emit('acceptance/updated', { taskId, payload: { acceptance } });
    return acceptance;
  }

  /**
   * 人工验收判定（manual 项专用）：
   * - executable 项拒绝——passed/failed 只能由执行器点亮（防作弊红线，与 updateAcceptance 一致）；
   * - 判定产生 manual_review 操作 + B 级证据（人证）并绑定 lastEvidenceId，证据链完整可审计；
   * - 幂等：状态已是同判定 → no-op 返回（双击/重复请求不追加记录）；
   * - 改判（含回退，如 passed→failed→passed）每次都是新判定事件，requestKey 追加序号保证 UNIQUE 不冲突、审计完整。
   */
  recordManualReview(taskId: string, itemId: string, decision: 'passed' | 'failed', note?: string): AcceptanceItem[] {
    const task = this.requireTask(taskId);
    const item = this.storage.listAcceptanceItems(taskId).find((a) => a.id === itemId);
    if (!item) throw new BadRequestError(`验收项不存在: ${itemId}`);
    if (item.kind !== 'manual') {
      throw new BadRequestError('可执行验收项不能人工点亮——请运行验证器产生证据');
    }
    if (item.status === decision) {
      return this.storage.listAcceptanceItems(taskId);
    }
    const now = new Date().toISOString();
    let requestKey = `manual-review:${itemId}:${decision}`;
    for (let n = 1; this.storage.getOperationByRequestKey(requestKey); n += 1) {
      requestKey = `manual-review:${itemId}:${decision}#${n}`;
    }
    const op: Operation = {
      schemaVersion: SCHEMA_VERSION,
      id: newId('op'),
      requestKey,
      type: 'manual_review',
      taskId: task.id,
      argsDigest: sha256Of(JSON.stringify({ itemId, decision, note: note ?? null })),
      status: 'succeeded',
      createdAt: now,
      endedAt: now,
      resultSummary: `人工验收 → ${decision}${note ? `（${note.slice(0, 80)}）` : ''}`,
    };
    this.storage.insertOperation(op);
    this.emit('operation/updated', { taskId: task.id, operationId: op.id, payload: { operation: op } });

    const evidence: Evidence = {
      schemaVersion: SCHEMA_VERSION,
      id: newId('ev'),
      operationId: op.id,
      taskId: task.id,
      acceptanceItemId: item.id,
      inputDigest: this.storage.latestSnapshot(taskId)?.inputDigest ?? sha256Of('no-snapshot'),
      evidenceLevel: 'B',
      toolVersions: { manualReview: '1' },
      result: decision,
      detail: { decision, note: note ?? null, reviewer: 'local-user', itemTitle: item.title },
      createdAt: now,
    };
    this.storage.insertEvidence(evidence);

    item.status = decision;
    item.lastEvidenceId = evidence.id;
    item.updatedAt = now;
    this.storage.updateAcceptanceItem(item);

    const acceptance = this.storage.listAcceptanceItems(taskId);
    this.emit('evidence/created', { taskId: task.id, operationId: op.id, payload: { evidenceId: evidence.id, result: decision } });
    this.emit('acceptance/updated', { taskId, payload: { acceptance } });
    this.recomputeTaskStatus(task);
    return acceptance;
  }

  listTasks(): EngineeringTask[] {
    return this.storage.listTasks();
  }

  async getOverview(taskId: string): Promise<TaskOverview> {
    const task = this.requireTask(taskId);
    const latestSnapshot = this.storage.latestSnapshot(taskId);
    let hasStaleEvidence = false;
    let currentDigest: string | null = null;
    if (latestSnapshot) {
      // 复核当前输入指纹：不一致（或采集失败）→ 证据过期，验收不点亮
      try {
        const loaded = await this.requireProfile(task.profileId);
        const current = await captureSourceSnapshot({
          taskId,
          projectRoot: task.projectRoot,
          profile: loaded.profile,
          profileFileSha256: loaded.fileSha256,
          toolVersions: latestSnapshot.toolVersions,
        });
        currentDigest = current.inputDigest;
        hasStaleEvidence = current.inputDigest !== latestSnapshot.inputDigest;
      } catch {
        hasStaleEvidence = true;
      }
    }
    // 概览投影（不改写存储）：证据过期时，通过项的绑定摘要失配 → 显示 stale
    const acceptance = this.storage.listAcceptanceItems(taskId).map((item) => {
      if (!hasStaleEvidence || item.status !== 'passed' || !item.lastEvidenceId) return item;
      const ev = this.storage.getEvidence(item.lastEvidenceId);
      if (ev && currentDigest !== null && ev.inputDigest !== currentDigest) {
        return { ...item, status: 'stale' as const };
      }
      return item;
    });
    return {
      ...task,
      acceptance,
      latestSnapshot: latestSnapshot ?? undefined,
      artifacts: this.storage.listArtifacts(taskId),
      operations: this.storage.listOperations(taskId),
      evidence: this.storage.listEvidence(taskId).slice(-50).reverse(),
      hasStaleEvidence,
    };
  }

  /** 工程 profile 枚举（任务向导选择用）；dataDir 内的算 user，其余算 bundled 模板 */
  async listProfiles(): Promise<Array<import('@forgedesk/contracts/runner').ProfileSummary>> {
    const loaded = await this.profiles.list();
    const userPrefix = path.join(this.dataDir, 'profiles') + path.sep;
    return loaded.map((l) => ({
      id: l.profile.id,
      revision: l.profile.revision,
      title: l.profile.title,
      kind: l.profile.kind,
      fileSha256: l.fileSha256,
      source: l.filePath.startsWith(userPrefix) ? ('user' as const) : ('bundled' as const),
      sshTargets: collectSshTargets(l.profile).map((t) => ({
        host: t.host,
        port: t.port,
        username: t.username,
        passwordEnv: t.passwordEnv,
      })),
    }));
  }

  listOperations(taskId: string): Operation[] {
    this.requireTask(taskId);
    return this.storage.listOperations(taskId);
  }

  // ---------------------------------------------------------------------------
  // 操作入口（幂等 + 异步/等待语义）
  // ---------------------------------------------------------------------------

  /**
   * 调用操作工具。
   * - 同 requestKey 同 args → 返回原操作（含已完成状态与结果，不重复副作用）
   * - 同 requestKey 不同 args → 冲突拒绝（permission_denied，不覆盖原操作）
   * - wait=true 等待终态；wait=false 立即返回 operationId+status
   */
  async callOperation(
    type: OperationType,
    args: Record<string, unknown> & { requestKey?: string },
    opts: { wait: boolean },
  ): Promise<OperationCallResult> {
    if (this.closed) throw new BadRequestError('执行器已关闭');
    const taskId = String(args.taskId ?? '');
    const task = this.requireTask(taskId);
    const argsDigest = buildArgsDigest(args);
    const requestKey = typeof args.requestKey === 'string' && args.requestKey.length > 0 ? args.requestKey : undefined;

    if (requestKey) {
      const existing = this.storage.getOperationByRequestKey(requestKey);
      if (existing) {
        if (existing.argsDigest !== argsDigest) {
          // 同键不同参：拒绝，防止偷换参数（原操作不受影响）
          return {
            operationId: existing.id,
            status: existing.status,
            result: {
              ok: false,
              kind: 'permission_denied',
              message: `requestKey 冲突：同键操作已存在且参数不同（原操作 ${existing.id}）`,
              operationId: existing.id,
            },
          };
        }
        // 幂等：返回原操作
        if (isTerminalOperationStatus(existing.status)) {
          const cached = this.outputCache.get(existing.id);
          return {
            operationId: existing.id,
            status: existing.status,
            result:
              cached ??
              ({
                ok: false,
                kind: 'unknown_result',
                message: '原操作已完成，结果缓存不可用（进程重启后请查看操作记录）',
                operationId: existing.id,
              } as ToolFailure),
          };
        }
        const running = this.runningOps.get(existing.id);
        if (opts.wait) {
          if (running) {
            const result = (await running.promise) as ToolOutput | ToolFailure;
            return { operationId: existing.id, status: this.requireOperation(existing.id).status, result };
          }
          return { operationId: existing.id, status: existing.status };
        }
        return { operationId: existing.id, status: existing.status };
      }
    }

    const now = new Date().toISOString();
    const op: Operation = {
      schemaVersion: SCHEMA_VERSION,
      id: newId('op'),
      requestKey: requestKey ?? '',
      type,
      taskId: task.id,
      argsDigest,
      status: 'prepared',
      createdAt: now,
    };
    this.storage.insertOperation(op);
    this.emit('operation/updated', { taskId: task.id, operationId: op.id, payload: { operation: op } });

    const controller = new AbortController();
    const promise = this.execOperation(op, type, args, controller);
    const entry: RunningEntry = { promise, controller };
    this.runningOps.set(op.id, entry);
    const cleanup = () => this.runningOps.delete(op.id);
    promise.then(cleanup, cleanup);

    if (opts.wait) {
      const result = await promise;
      return { operationId: op.id, status: this.requireOperation(op.id).status, result };
    }
    return { operationId: op.id, status: this.requireOperation(op.id).status };
  }

  /** 取消操作：副作用前 → cancelled；进行中 → 请求中止；终态 → 无操作 */
  async cancelOperation(opId: string, _req: CancelRequest): Promise<{ operationId: string; status: OperationStatus; cancelled: boolean }> {
    const op = this.storage.getOperation(opId);
    if (!op) throw new NotFoundError(`操作不存在: ${opId}`);
    if (isTerminalOperationStatus(op.status)) {
      return { operationId: opId, status: op.status, cancelled: false };
    }
    const pending = this.pendingAuths.get(opId);
    if (pending) {
      this.resolvePendingAuth(opId, false, 'cancelled');
      return { operationId: opId, status: this.requireOperation(opId).status, cancelled: true };
    }
    const running = this.runningOps.get(opId);
    if (running) {
      running.controller.abort();
      await running.promise.catch(() => undefined);
    }
    return { operationId: opId, status: this.requireOperation(opId).status, cancelled: true };
  }

  // ---------------------------------------------------------------------------
  // 授权（GUI 卡片 ↔ 执行器）
  // ---------------------------------------------------------------------------

  pendingAuthorizations(): PendingAuthorization[] {
    const now = Date.now();
    for (const [opId, entry] of [...this.pendingAuths.entries()]) {
      if (now >= Date.parse(entry.pending.expiresAt)) {
        // 超时取消意图：副作用未发生 → cancelled
        this.resolvePendingAuth(opId, false, 'timeout');
      }
    }
    return [...this.pendingAuths.values()].map((e) => e.pending);
  }

  /** 授权决定：范围核对（confirmedScope 必须与 PendingAuthorization 一致，否则拒绝） */
  authorize(req: AuthorizeRequest): { ok: true; decision: 'approved' | 'declined' } {
    const entry = this.pendingAuths.get(req.operationId);
    if (!entry) throw new NotFoundError(`待授权操作不存在或已处理: ${req.operationId}`);
    const now = Date.now();
    if (now >= Date.parse(entry.pending.expiresAt)) {
      this.resolvePendingAuth(req.operationId, false, 'timeout');
      throw new BadRequestError('授权已超时（操作已取消意图），请重新发起');
    }
    const scope = req.confirmedScope;
    const mismatches: string[] = [];
    if (scope.taskId !== entry.pending.taskId) mismatches.push('taskId');
    // 烧录（写操作）：设备 + 产物哈希 + 任务 三重核对；绑定/验证：任务范围核对
    if (entry.pending.artifactSha256) {
      if (scope.artifactSha256 !== entry.pending.artifactSha256) mismatches.push('artifactSha256');
      if (entry.deviceBindingId && scope.deviceBindingId !== entry.deviceBindingId) mismatches.push('deviceBindingId');
    }
    if (mismatches.length > 0) {
      throw new BadRequestError(`授权范围不匹配: ${mismatches.join(', ')}（与待授权卡片不一致，拒绝执行）`);
    }
    if (req.decision === 'approved') {
      this.storage.insertAuthorization({
        operationId: req.operationId,
        decision: 'approved',
        deviceBindingId: entry.deviceBindingId,
        artifactSha256: entry.pending.artifactSha256,
        taskId: entry.pending.taskId,
        acceptanceDigest: entry.pending.acceptanceDigest ?? sha256Of(''),
        policyVersion: 1,
        validUntil: new Date(now + AUTHORIZATION_VALID_MS).toISOString(),
        createdAt: new Date(now).toISOString(),
      });
    }
    this.resolvePendingAuth(req.operationId, req.decision === 'approved', req.decision);
    return { ok: true, decision: req.decision };
  }

  private resolvePendingAuth(opId: string, approved: boolean, reason: string): void {
    const entry = this.pendingAuths.get(opId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pendingAuths.delete(opId);
    entry.resolve(approved);
    this.emit('authorization/resolved', {
      taskId: entry.pending.taskId,
      operationId: opId,
      payload: { approved, reason },
    });
  }

  private requestAuthorization(
    op: Operation,
    spec: {
      type: PendingAuthorization['type'];
      title: string;
      scopeSummary: string;
      artifactSha256?: string;
      acceptanceDigest?: string;
      deviceBindingId?: string;
    },
  ): Promise<boolean> {
    this.setOperationStatus(op, 'awaiting_authorization', (o) => {
      o.authorizationRequestedAt = new Date().toISOString();
    });
    const requestedAt = new Date();
    const expiresAt = new Date(requestedAt.getTime() + AUTHORIZATION_TIMEOUT_MS);
    const pending: PendingAuthorization = {
      operationId: op.id,
      taskId: op.taskId,
      type: spec.type,
      title: spec.title,
      scopeSummary: spec.scopeSummary,
      artifactSha256: spec.artifactSha256,
      acceptanceDigest: spec.acceptanceDigest,
      requestedAt: requestedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    const promise = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        // 超时取消意图（副作用未发生 → cancelled）
        this.resolvePendingAuth(op.id, false, 'timeout');
      }, AUTHORIZATION_TIMEOUT_MS);
      this.pendingAuths.set(op.id, {
        pending,
        deviceBindingId: spec.deviceBindingId,
        resolve,
        timer,
      });
    });
    this.emit('authorization/pending', { taskId: op.taskId, operationId: op.id, payload: { pending } });
    return promise;
  }

  // ---------------------------------------------------------------------------
  // 设备枚举与诊断
  // ---------------------------------------------------------------------------

  async listDevices(): Promise<{ devices: EnumeratedDevice[]; adapterAvailable: boolean; note?: string }> {
    if (!this.deviceAdapter) {
      return { devices: [], adapterAvailable: false, note: '设备适配层未注入（设备 Agent C 提供，经 src/internal/device-port.ts 挂点）' };
    }
    try {
      return { devices: await this.deviceAdapter.enumerate(), adapterAvailable: true };
    } catch (error) {
      this.lastError = `设备枚举失败: ${String(error)}`;
      return { devices: [], adapterAvailable: true, note: this.lastError };
    }
  }

  async diagnostics(): Promise<RunnerDiagnostics> {
    const caps = this.deviceAdapter?.capabilities();
    const gitAvailable = await isGitAvailable().catch(() => false);
    return {
      schemaVersion: 1,
      runnerVersion: this.runnerVersion,
      uptimeMs: Date.now() - this.startedAtMs,
      storagePath: this.storage.dbPath,
      storageOk: this.storage.checkHealth(),
      gitAvailable,
      probeRsAvailable: caps?.probeRsAvailable ?? false,
      probeRsPath: caps?.probeRsPath,
      serialPortsAvailable: caps?.serialPortsAvailable ?? false,
      pendingAuthorizations: this.pendingAuths.size,
      lastError: this.lastError,
    };
  }

  // ---------------------------------------------------------------------------
  // 优雅关闭：等待在途操作收尾（超时标记 unknown）
  // ---------------------------------------------------------------------------

  async shutdown(graceMs = 10_000): Promise<void> {
    this.closed = true;
    for (const opId of [...this.pendingAuths.keys()]) {
      this.resolvePendingAuth(opId, false, 'shutdown');
    }
    for (const entry of this.runningOps.values()) {
      entry.controller.abort();
    }
    const inflight = [...this.runningOps.values()].map((e) => e.promise.catch(() => undefined));
    if (inflight.length > 0) {
      await Promise.race([
        Promise.allSettled(inflight),
        new Promise((resolve) => setTimeout(resolve, graceMs)),
      ]);
    }
    // 超时仍未收尾的在途操作标记 unknown（结果未知，不假造成功）
    for (const [opId] of this.runningOps) {
      const op = this.storage.getOperation(opId);
      if (op && !isTerminalOperationStatus(op.status)) {
        this.setOperationStatus(op, 'unknown', (o) => {
          o.endedAt = new Date().toISOString();
          o.failure = { kind: 'unknown_result', message: '执行器关闭时操作未收尾，结果未知' };
        });
      }
    }
    this.runningOps.clear();
  }

  // ---------------------------------------------------------------------------
  // 内部：状态转移与执行
  // ---------------------------------------------------------------------------

  private requireTask(taskId: string): EngineeringTask {
    const task = this.storage.getTask(taskId);
    if (!task) throw new NotFoundError(`任务不存在: ${taskId}`);
    return task;
  }

  private requireOperation(opId: string): Operation {
    const op = this.storage.getOperation(opId);
    if (!op) throw new NotFoundError(`操作不存在: ${opId}`);
    return op;
  }

  private async requireProfile(profileId: string): Promise<LoadedProfile> {
    const loaded = await this.profiles.get(profileId);
    if (!loaded) throw new BadRequestError(`工程 profile 不存在: ${profileId}`);
    return loaded;
  }

  private requireProfileSync(profileId: string): LoadedProfile {
    // 同步路径（事务内）：取缓存；未加载时抛错（调用方需先走异步路径）
    const loaded = this.profiles.getCached(profileId);
    if (!loaded) throw new BadRequestError(`工程 profile 未加载: ${profileId}`);
    return loaded;
  }

  private setOperationStatus(op: Operation, next: OperationStatus, patch?: (o: Operation) => void): Operation {
    const from = this.storage.getOperation(op.id)?.status ?? op.status;
    assertOperationTransition(from, next);
    op.status = next;
    patch?.(op);
    this.storage.updateOperation(op);
    this.emit('operation/updated', { taskId: op.taskId, operationId: op.id, payload: { operation: op } });
    return op;
  }

  private setTaskStatus(task: EngineeringTask, next: EngineeringTask['status']): void {
    if (task.status === next) return;
    task.status = next;
    task.updatedAt = new Date().toISOString();
    this.storage.updateTask(task);
    this.emit('task/updated', { taskId: task.id, payload: { task } });
  }

  private evidenceDir(taskId: string, opId: string): string {
    return path.join(this.dataDir, 'evidence', taskId, opId);
  }

  private async execOperation(
    op: Operation,
    type: OperationType,
    args: Record<string, unknown>,
    controller: AbortController,
  ): Promise<ToolOutput | ToolFailure> {
    await fsp.mkdir(this.evidenceDir(op.taskId, op.id), { recursive: true });
    const logDir = this.evidenceDir(op.taskId, op.id);
    const ctx: ExecContext = {
      op,
      signal: controller.signal,
      logDir,
      writeLog: async (name, content) => {
        await fsp.mkdir(logDir, { recursive: true });
        await fsp.writeFile(path.join(logDir, name), content, 'utf8');
        return toPosix(path.join('evidence', op.taskId, op.id, name));
      },
      start: () => {
        this.setOperationStatus(op, 'running', (o) => {
          o.startedAt = new Date().toISOString();
        });
        const task = this.storage.getTask(op.taskId);
        if (task) this.setTaskStatus(task, 'running');
      },
      requestAuthorization: (spec) => this.requestAuthorization(op, spec),
    };

    try {
      const result = await this.dispatch(type, op, args, ctx);
      this.outputCache.set(op.id, result);
      return result;
    } catch (error) {
      const failure = this.failureFrom(op, error);
      this.outputCache.set(op.id, failure);
      return failure;
    }
  }

  /** 统一失败落状态（终态转移 + failure 记录 + 任务 lastFailure） */
  private failureFrom(op: Operation, error: unknown): ToolFailure {
    const cancelled = error instanceof OperationCancelledError || (op.status === 'running' && this.isAbort(error));
    const current = this.storage.getOperation(op.id) ?? op;
    if (cancelled) {
      if (!isTerminalOperationStatus(current.status)) {
        this.setOperationStatus(current, 'cancelled', (o) => {
          o.endedAt = new Date().toISOString();
          o.failure = { kind: 'permission_denied', message: `操作已取消: ${String((error as Error)?.message ?? error)}` };
        });
      }
      return { ok: false, kind: 'permission_denied', message: '操作已取消（副作用前取消 → cancelled）', operationId: op.id };
    }
    let kind: ToolFailure['kind'] = 'internal_error';
    let entityKind: import('@forgedesk/contracts/common').FailureKind = 'internal_error';
    let message = error instanceof Error ? error.message : String(error);
    let logRef: string | undefined;
    if (error instanceof SnapshotLimitError) {
      kind = 'unknown_result';
      entityKind = 'evidence_stale';
      message = `${error.message}（证据待重验，不假造指纹）`;
    } else if (error instanceof BadRequestError) {
      kind = 'permission_denied';
      entityKind = 'permission_denied';
    } else if (error instanceof NotFoundError) {
      kind = 'permission_denied';
      entityKind = 'permission_denied';
      message = `${message}（对象不存在）`;
    } else if (error instanceof ToolExecError) {
      kind = error.toolKind;
      entityKind = error.entityKind;
      message = error.message;
      logRef = error.logRef;
    }
    if (!isTerminalOperationStatus(current.status)) {
      this.setOperationStatus(current, 'failed', (o) => {
        o.endedAt = new Date().toISOString();
        o.failure = { kind: entityKind, message, logRef };
      });
    }
    const task = this.storage.getTask(op.taskId);
    if (task) {
      task.lastFailure = { kind: entityKind, message, logRef };
      task.updatedAt = new Date().toISOString();
      this.storage.updateTask(task);
      this.emit('task/updated', { taskId: task.id, payload: { task } });
    }
    this.lastError = message;
    return { ok: false, kind, message, detail: logRef, operationId: op.id };
  }

  private isAbort(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
  }

  private async dispatch(
    type: OperationType,
    op: Operation,
    args: Record<string, unknown>,
    ctx: ExecContext,
  ): Promise<ToolOutput> {
    switch (type) {
      case 'inspect':
        return await this.toolInspect(op, args as unknown as InspectInput, ctx);
      case 'build':
        return await this.toolBuild(op, args as unknown as BuildInput, ctx);
      case 'test':
        return await this.toolTest(op, args as unknown as TestInput, ctx);
      case 'export':
        return await this.toolExport(op, args as unknown as ExportInput, ctx);
      case 'device_bind':
        return await this.toolDeviceBind(op, args as unknown as DeviceBindInput, ctx);
      case 'device_flash':
        return await this.toolDeviceFlash(op, args as unknown as DeviceFlashInput, ctx);
      case 'device_verify':
        return await this.toolDeviceVerify(op, args as unknown as DeviceVerifyInput, ctx);
      case 'manual_review':
        // 人工验收不是执行器工具——专用 API recordManualReview 落盘（不经 MCP/GUI 工具白名单）
        throw new BadRequestError('manual_review 走专用人工验收 API（POST /api/tasks/:id/acceptance/:itemId/manual-review）');
    }
  }

  // ---------------------------------------------------------------------------
  // 工具实现：inspect
  // ---------------------------------------------------------------------------

  private async toolInspect(op: Operation, input: InspectInput, ctx: ExecContext): Promise<InspectOutput> {
    ctx.start();
    const task = this.requireTask(input.taskId);
    const loaded = await this.requireProfile(task.profileId);
    const probes = await probeToolVersions(loaded.profile);
    // Z3：远程 SSH 目标探测（TCP 可达 + 密码环境变量；不回显密码值）
    const sshTargets = await Promise.all(collectSshTargets(loaded.profile).map((t) => probeSshTarget(t)));
    const snapshot = this.storage.latestSnapshot(task.id);
    this.setOperationStatus(op, 'succeeded', (o) => {
      o.endedAt = new Date().toISOString();
      const sshDown = sshTargets.filter((t) => !t.reachable || !t.passwordConfigured).length;
      o.resultSummary = `工具链探测完成（缺失 ${probes.filter((p) => !p.available).length} 项` +
        (sshTargets.length > 0 ? `，SSH 目标异常 ${sshDown}/${sshTargets.length}` : '') +
        '）';
    });
    return {
      ok: true,
      operationId: op.id,
      profileId: loaded.profile.id,
      profileRevision: loaded.profile.revision,
      toolchain: probes.map((p) => ({
        tool: p.tool,
        available: p.available,
        version: p.version,
        missingHint: p.missingHint,
      })),
      missing: probes.filter((p) => !p.available).map((p) => p.missingHint ?? p.tool),
      sshTargets,
      currentSnapshot: snapshot
        ? { inputDigest: snapshot.inputDigest, hasGit: snapshot.hasGit, capturedAt: snapshot.capturedAt }
        : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // SSH 远程执行（Z3-FZ3B：Linux SoC 板卡上的构建/验收）
  // ---------------------------------------------------------------------------

  /**
   * B 级快照物化：复制输入到 dataDir/snapshots/<taskId>-<digest8>，快照记录改 B 级并回填路径。
   * 返回快照目录（构建/验收/复核均以该目录为根；源目录漂移由下次操作的新鲜指纹暴露）。
   */
  async #materializeSnapshot(
    task: { id: string; projectRoot: string },
    snapshot: Awaited<ReturnType<typeof captureSourceSnapshot>>,
  ): Promise<string> {
    const dir = path.join(this.dataDir, 'snapshots', `${task.id}-${snapshot.inputDigest.slice(0, 8)}`);
    await copySnapshotFiles(task.projectRoot, snapshot.inputManifest, dir);
    snapshot.evidenceLevel = 'B';
    snapshot.snapshotPath = dir;
    return dir;
  }

  /** 远程执行准备：无 ssh 目标返回 null；有则连接 + 上传任务输入清单到内容寻址目录 */
  async #sshSetup(
    cmd: ProfileCommand,
    task: { id: string; projectRoot: string },
    inputManifest: Array<{ path: string }>,
    inputDigest: string,
    logRefHint: string,
    inputSourceRoot?: string,
  ): Promise<{ session: SshSession; dir: string; target: SshTarget } | null> {
    const target = cmd.ssh;
    if (!target) return null;
    if (inputManifest.length > 2000) {
      throw new ToolExecError(
        'environment_missing',
        'environment_missing',
        `远程工程输入文件过多（${inputManifest.length} > 2000）：板上工程应保持精简输入集`,
        logRefHint,
      );
    }
    const sourceRoot = inputSourceRoot ?? task.projectRoot;
    const session = await this.sshTransport(target);
    const dir = remoteTaskDir(target, task.id, inputDigest);
    const files: Array<{ rel: string; content: Buffer }> = [];
    for (const m of inputManifest) {
      const rel = toPosix(m.path);
      files.push({ rel, content: await fsp.readFile(path.join(sourceRoot, rel)) });
    }
    await session.uploadInputs(dir, files);
    return { session, dir, target };
  }

  /** 远程执行命令（cwd 相对任务目录）；返回结构与本地 runCommand 对齐 */
  async #sshExec(
    remote: { session: SshSession; dir: string },
    cmd: ProfileCommand,
    ctx: ExecContext,
    outputLimitBytes: number,
  ): Promise<CommandResult> {
    const cwd = cmd.cwd ? `${remote.dir}/${cmd.cwd}` : remote.dir;
    return await remote.session.exec({
      cmdline: buildRemoteCmdline(cmd.exe, cmd.args),
      cwd,
      env: cmd.env,
      timeoutMs: cmd.timeoutMs,
      outputLimitBytes,
      signal: ctx.signal,
    });
  }

  // ---------------------------------------------------------------------------
  // 工具实现：build
  // ---------------------------------------------------------------------------

  private async toolBuild(op: Operation, input: BuildInput, ctx: ExecContext): Promise<BuildOutput> {
    const task = this.requireTask(input.taskId);
    const loaded = await this.requireProfile(task.profileId);
    // 显式携带修订号时校验一致性（防陈旧前提）；省略时按当前修订执行（模型友好）
    if (input.profileRevision !== undefined && input.profileRevision !== loaded.profile.revision) {
      throw new BadRequestError(
        `profile 修订不一致（调用方 ${input.profileRevision}，当前 ${loaded.profile.revision}）：构建前提已变化，旧证据待重验`,
      );
    }
    ctx.start();

    // 操作前快照（绑定产物与证据的输入指纹）
    const toolVersions: Record<string, string> = { node: process.version };
    const before = await captureSourceSnapshot({
      taskId: task.id,
      projectRoot: task.projectRoot,
      profile: loaded.profile,
      profileFileSha256: loaded.fileSha256,
      toolVersions,
    });
    // B 级快照构建（任务书 §8.2）：输入复制到内容寻址任务目录，构建/验收从快照执行
    let buildRoot = task.projectRoot;
    if (loaded.profile.buildFromSnapshot) {
      buildRoot = await this.#materializeSnapshot(task, before);
    }
    this.storage.insertSnapshot(before);

    // 构建前生成 buildId（uuid）：产物与固件身份的锚点
    const buildId = randomUUID();
    const cmd = loaded.profile.build;
    const cwd = cmd.cwd ? path.resolve(buildRoot, cmd.cwd) : buildRoot;
    // SSH 目标（Z3-FZ3B）：上传输入 → 板上构建 → 产物取回本地证据管线
    const remote = await this.#sshSetup(cmd, task, before.inputManifest, before.inputDigest, '', buildRoot === task.projectRoot ? undefined : buildRoot);
    const artifactSearchDir = remote ? path.join(ctx.logDir, 'remote-artifacts') : buildRoot;
    let r!: CommandResult;
    let artifactNames: string[] = [];
    try {
      if (remote) {
        r = await this.#sshExec(remote, cmd, ctx, BUILD_OUTPUT_LIMIT);
        if (r.exitCode === 0) {
          artifactNames = await remote.session.downloadGlob(remote.dir, loaded.profile.artifactsGlob, artifactSearchDir);
        }
      } else {
        r = await runCommand({
          exe: cmd.exe,
          args: cmd.args,
          cwd,
          env: cmd.env,
          timeoutMs: cmd.timeoutMs,
          outputLimitBytes: BUILD_OUTPUT_LIMIT,
          signal: ctx.signal,
        });
      }
    } finally {
      if (remote) await remote.session.close().catch(() => undefined);
    }
    const logContent = [
      `# build ${buildId}`,
      `exe: ${cmd.exe} ${cmd.args.join(' ')}`,
      `cwd: ${remote ? `${remote.dir}${cmd.cwd ? '/' + cmd.cwd : ''}（板上 ${remote.target.host}）` : cwd}`,
      `exitCode: ${r.exitCode}`,
      `durationMs: ${r.durationMs}`,
      '--- stdout ---',
      r.stdout,
      '--- stderr ---',
      r.stderr,
      r.truncated ? '(输出超限已截断)' : '',
    ].join('\n');
    const logRef = await ctx.writeLog('build.log', logContent);
    if (r.cancelled) throw new OperationCancelledError('构建命令被取消');
    if (r.spawnError) {
      throw new ToolExecError('environment_missing', 'environment_missing', `构建命令无法启动: ${cmd.exe}（${r.spawnError}）`, logRef);
    }
    if (r.timedOut) {
      throw new ToolExecError('timeout', 'timeout', `构建命令超时（${cmd.timeoutMs}ms，已终止进程树）`, logRef);
    }
    if (r.exitCode !== 0) {
      throw new ToolExecError('internal_error', 'build_failure', `构建失败：退出码 ${r.exitCode}`, logRef);
    }

    // 采集产物（artifactsGlob，确定性取排序后首个命中；远程构建取回名单，本地构建走目录扫描）
    let matches: string[];
    if (remote) {
      matches = [...artifactNames].sort();
    } else {
      const files = await walkFiles(buildRoot, { skipDirNames: ['node_modules', '.git'], maxFiles: 60_000 });
      matches = files.filter((f) => matchAny(f, loaded.profile.artifactsGlob)).sort();
    }
    if (matches.length === 0) {
      throw new ToolExecError('internal_error', 'build_failure', `构建成功但未匹配到产物（artifactsGlob: ${loaded.profile.artifactsGlob.join(', ')}）`, logRef);
    }
    const artifactRel = matches[0]!;
    const artifactAbs = path.join(artifactSearchDir, artifactRel);
    const { sha256, sizeBytes } = await sha256File(artifactAbs);
    const archiveDir = path.join(ctx.logDir, 'artifacts');
    await fsp.mkdir(archiveDir, { recursive: true });
    const artifactBase = path.basename(artifactRel);
    await fsp.copyFile(artifactAbs, path.join(archiveDir, artifactBase));
    const archivedRel = toPosix(path.join('evidence', task.id, op.id, 'artifacts', artifactBase));
    const artifactType: BuildOutput['artifactType'] = artifactBase.toLowerCase().endsWith('.elf')
      ? 'firmware_elf'
      : artifactBase.toLowerCase().endsWith('.bin')
        ? 'firmware_bin'
        : 'other';
    const artifact: Artifact = {
      schemaVersion: SCHEMA_VERSION,
      id: newId('art'),
      taskId: task.id,
      type: artifactType,
      path: artifactAbs,
      archivedPath: archivedRel,
      sha256,
      sizeBytes,
      buildId,
      sourceSnapshotId: before.id,
      createdAt: new Date().toISOString(),
    };
    this.storage.insertArtifact(artifact);

    // 执行后输入指纹复核：变化 → evidence_stale（不为当前状态点亮）。
    // B 级快照构建：复核针对快照目录（快照内容不变 ⇒ 不误报）；源目录漂移由下次操作的新鲜指纹暴露。
    const after = await captureSourceSnapshot({
      taskId: task.id,
      projectRoot: loaded.profile.buildFromSnapshot ? buildRoot : task.projectRoot,
      profile: loaded.profile,
      profileFileSha256: loaded.fileSha256,
      toolVersions,
    });
    this.storage.insertSnapshot(after);
    if (after.inputDigest !== before.inputDigest) {
      throw new ToolExecError(
        'unknown_result',
        'evidence_stale',
        '构建期间输入指纹变化（外部编辑/配置变化）：本次产物不绑定当前状态，请重跑',
        logRef,
      );
    }

    this.storage.transaction(() => {
      const fresh = this.storage.getOperation(op.id) ?? op;
      fresh.artifactId = artifact.id;
      this.storage.updateOperation(fresh);
    });
    this.setOperationStatus(this.storage.getOperation(op.id) ?? op, 'succeeded', (o) => {
      o.endedAt = new Date().toISOString();
      o.resultSummary = `构建成功 ${artifactBase} sha256=${sha256.slice(0, 12)}… buildId=${buildId}`;
    });
    return {
      ok: true,
      operationId: op.id,
      artifactId: artifact.id,
      buildId,
      artifactType,
      artifactPath: artifactAbs,
      artifactSha256: sha256,
      logRef,
      durationMs: r.durationMs,
    };
  }

  // ---------------------------------------------------------------------------
  // 工具实现：test
  // ---------------------------------------------------------------------------

  private async toolTest(op: Operation, input: TestInput, ctx: ExecContext): Promise<TestOutput> {
    const task = this.requireTask(input.taskId);
    const loaded = await this.requireProfile(task.profileId);
    const verifier = loaded.profile.verifiers.find((v) => v.verifierId === input.verifierId);
    if (!verifier) {
      throw new BadRequestError(
        `未知 verifier "${input.verifierId}"：验收定义只能来自用户认可的 profile（模型不可编造验收规则）`,
      );
    }
    ctx.start();

    // 操作前快照：证据绑定输入指纹
    const toolVersions: Record<string, string> = { node: process.version };
    const snapshot = await captureSourceSnapshot({
      taskId: task.id,
      projectRoot: task.projectRoot,
      profile: loaded.profile,
      profileFileSha256: loaded.fileSha256,
      toolVersions,
    });

    const cmd = verifier.command;
    // B 级快照：验收同样从快照执行（内容寻址目录，输入未变则与构建共用同一份）；
    // 物化会回填 snapshot.evidenceLevel/snapshotPath，故在落库前执行
    let verifyRoot = task.projectRoot;
    if (loaded.profile.buildFromSnapshot) {
      verifyRoot = await this.#materializeSnapshot(task, snapshot);
    }
    this.storage.insertSnapshot(snapshot);
    const cwd = cmd.cwd ? path.resolve(verifyRoot, cmd.cwd) : verifyRoot;
    // SSH 目标（Z3-FZ3B）：同一任务目录（内容寻址，输入未变则命中构建时上传的文件）板上验收
    const remote = await this.#sshSetup(
      cmd, task, snapshot.inputManifest, snapshot.inputDigest, '',
      verifyRoot === task.projectRoot ? undefined : verifyRoot,
    );
    let r!: CommandResult;
    try {
      if (remote) {
        r = await this.#sshExec(remote, cmd, ctx, verifier.outputLimitBytes);
      } else {
        r = await runCommand({
          exe: cmd.exe,
          args: cmd.args,
          cwd,
          env: cmd.env,
          timeoutMs: cmd.timeoutMs,
          outputLimitBytes: verifier.outputLimitBytes,
          signal: ctx.signal,
        });
      }
    } finally {
      if (remote) await remote.session.close().catch(() => undefined);
    }
    const logContent = [
      `# verifier ${verifier.verifierId}`,
      `exe: ${cmd.exe} ${cmd.args.join(' ')}`,
      `cwd: ${remote ? `${remote.dir}${cmd.cwd ? '/' + cmd.cwd : ''}（板上 ${remote.target.host}）` : cwd}`,
      `exitCode: ${r.exitCode}`,
      `passExitCode: ${verifier.passExitCode}`,
      `durationMs: ${r.durationMs}`,
      '--- stdout ---',
      r.stdout,
      '--- stderr ---',
      r.stderr,
      r.truncated ? '(输出超限已截断)' : '',
    ].join('\n');
    const logRef = await ctx.writeLog('test.log', logContent);
    if (r.cancelled) throw new OperationCancelledError('验收命令被取消');
    if (r.spawnError) {
      throw new ToolExecError('environment_missing', 'environment_missing', `验收命令无法启动: ${cmd.exe}（${r.spawnError}）`, logRef);
    }

    // 判定：exit code + stdout 规则（verifier 冻结，模型不可改写）
    let result: TestOutput['result'];
    const judgments: Record<string, unknown> = {
      exitCode: r.exitCode,
      exitCodeOk: r.exitCode === verifier.passExitCode,
      stdoutMustContain: verifier.stdoutMustContain.map((s) => ({ needle: s, found: r.stdout.includes(s) })),
      stdoutMustNotContain: verifier.stdoutMustNotContain.map((s) => ({ needle: s, found: r.stdout.includes(s) })),
      timedOut: r.timedOut,
    };
    if (r.timedOut) {
      result = 'inconclusive';
      judgments.reason = '验收命令超时，无法判定';
    } else {
      const exitOk = r.exitCode === verifier.passExitCode;
      const mustContainOk = verifier.stdoutMustContain.every((s) => r.stdout.includes(s));
      const mustNotContainOk = verifier.stdoutMustNotContain.every((s) => !r.stdout.includes(s));
      judgments.exitOk = exitOk;
      judgments.mustContainOk = mustContainOk;
      judgments.mustNotContainOk = mustNotContainOk;
      result = exitOk && mustContainOk && mustNotContainOk ? 'passed' : 'failed';
    }

    // 执行后输入复核：变化 → 证据标 stale（M5：不为当前状态点亮通过）；
    // B 级快照：复核针对快照目录（快照内容不变 ⇒ 不误报），源漂移由下次操作的新鲜指纹暴露
    const after = await captureSourceSnapshot({
      taskId: task.id,
      projectRoot: loaded.profile.buildFromSnapshot ? verifyRoot : task.projectRoot,
      profile: loaded.profile,
      profileFileSha256: loaded.fileSha256,
      toolVersions,
    });
    const inputChanged = after.inputDigest !== snapshot.inputDigest;
    if (inputChanged) this.storage.insertSnapshot(after);

    const artifact = input.artifactId ? this.storage.getArtifact(input.artifactId) : undefined;
    const evidence: Evidence = {
      schemaVersion: SCHEMA_VERSION,
      id: newId('ev'),
      operationId: op.id,
      taskId: task.id,
      inputDigest: snapshot.inputDigest,
      evidenceLevel: 'A',
      artifactDigest: artifact?.sha256,
      artifactId: artifact?.id,
      toolVersions,
      result: inputChanged ? 'inconclusive' : result,
      detail: { ...judgments, verifierId: verifier.verifierId, inputChangedAfterRun: inputChanged },
      logRef,
      createdAt: new Date().toISOString(),
    };

    // 验收项更新：proposed（模型提议未采纳）不得被工具点亮
    const items = this.storage.listAcceptanceItems(task.id).filter(
      (a) => a.verifierId === verifier.verifierId && a.status !== 'proposed',
    );
    const target = items[0];
    if (target) evidence.acceptanceItemId = target.id;
    this.storage.insertEvidence(evidence);
    if (target) {
      const effectiveResult = evidence.result;
      target.status =
        effectiveResult === 'passed' ? 'passed' : effectiveResult === 'failed' ? 'failed' : inputChanged ? 'stale' : target.status;
      target.lastEvidenceId = evidence.id;
      target.updatedAt = new Date().toISOString();
      this.storage.updateAcceptanceItem(target);
      this.emit('acceptance/updated', { taskId: task.id, payload: { acceptance: this.storage.listAcceptanceItems(task.id) } });
    }
    this.emit('evidence/created', { taskId: task.id, operationId: op.id, payload: { evidenceId: evidence.id, result: evidence.result } });

    this.recomputeTaskStatus(task);
    this.setOperationStatus(op, 'succeeded', (o) => {
      o.endedAt = new Date().toISOString();
      o.resultSummary = `验收 ${verifier.verifierId} → ${evidence.result}${inputChanged ? '（输入变化，证据待重验）' : ''}`;
    });
    return {
      ok: true,
      operationId: op.id,
      evidenceId: evidence.id,
      result: evidence.result,
      acceptanceItemId: target?.id,
      detail: evidence.detail,
      logRef,
    };
  }

  /** 证据落库后重算任务状态（通过只能来自 computeTaskAcceptance） */
  private recomputeTaskStatus(task: EngineeringTask): void {
    const acceptance = this.storage.listAcceptanceItems(task.id);
    const latest = this.storage.latestSnapshot(task.id);
    // 任一通过项证据指纹 ≠ 最新快照指纹 → stale
    const stale =
      latest != null &&
      acceptance.some((a) => {
        if (a.status !== 'passed' || !a.lastEvidenceId) return false;
        const ev = this.storage.getEvidence(a.lastEvidenceId);
        return ev != null && ev.inputDigest !== latest.inputDigest;
      });
    const judged = computeTaskAcceptance({ acceptance, stale });
    const current = this.storage.getTask(task.id) ?? task;
    let next: EngineeringTask['status'];
    if (judged.passed) next = 'passed';
    else if (stale) next = current.status === 'passed' ? 'verifying' : current.status;
    else if (acceptance.some((a) => a.required && a.status === 'failed')) next = 'failed';
    else next = 'verifying';
    if (next !== current.status) {
      // 严格走合法转移（verifying→failed、verifying→passed、running→verifying 均合法）
      this.setTaskStatus(current, next);
    }
  }

  // ---------------------------------------------------------------------------
  // 工具实现：export
  // ---------------------------------------------------------------------------

  private async toolExport(op: Operation, input: ExportInput, ctx: ExecContext): Promise<ExportOutput> {
    ctx.start();
    const task = this.requireTask(input.taskId);
    const bundle = await buildExportBundle({ dataDir: this.dataDir, storage: this.storage, task });
    this.setOperationStatus(op, 'succeeded', (o) => {
      o.endedAt = new Date().toISOString();
      o.resultSummary = `交付包已导出: ${bundle.bundlePath}`;
    });
    return { ok: true, operationId: op.id, bundlePath: bundle.bundlePath, manifest: bundle.manifest as unknown };
  }

  // ---------------------------------------------------------------------------
  // 工具实现：device.bind / device.flash / device.verify（本波：前置检查 + 授权语义框架）
  // 硬件动作经 DeviceAdapter（src/internal/device-port.ts 注入点，设备 Agent C 提供）
  // ---------------------------------------------------------------------------

  private requireAdapter(): DeviceAdapter {
    if (!this.deviceAdapter) {
      throw new ToolExecError(
        'environment_missing',
        'environment_missing',
        '设备适配层未注入（设备 Agent C 提供，经 src/internal/device-port.ts 挂点注入后可用）',
      );
    }
    return this.deviceAdapter;
  }

  private async toolDeviceBind(op: Operation, input: DeviceBindInput, ctx: ExecContext): Promise<DeviceBindOutput> {
    const adapter = this.requireAdapter();
    const task = this.requireTask(input.taskId);
    const loaded = await this.requireProfile(task.profileId);
    const device = loaded.profile.device;
    if (!device) {
      throw new ToolExecError('environment_missing', 'environment_missing', `profile "${loaded.profile.id}" 未定义设备配置（kind=${loaded.profile.kind}）`);
    }
    // 前置检查：设备身份必须与 profile 声明一致（VID/PID）
    if (
      input.identity.usbVid !== device.identity.usbVid ||
      input.identity.usbPid !== device.identity.usbPid
    ) {
      throw new BadRequestError(
        `设备身份不匹配：profile 期望 ${device.identity.usbVid}:${device.identity.usbPid}，实际 ${input.identity.usbVid}:${input.identity.usbPid}`,
      );
    }
    const binding = adapter.buildBinding(device, { ...input.identity, source: 'manual' }, input.identityEvidence);
    binding.profileId = loaded.profile.id;
    this.storage.insertBinding(binding);
    this.emit('device/updated', { taskId: task.id, payload: { deviceBindingId: binding.id, confirmedByUser: false } });

    // 授权语义：绑定须用户确认（无可靠序列号时尤其如此）
    const approved = await ctx.requestAuthorization({
      type: 'device_bind',
      title: `确认设备绑定：${binding.chipTarget}`,
      scopeSummary: `设备 ${binding.identity.usbVid}:${binding.identity.usbPid}` +
        (binding.identity.probeSerial ? ` serial=${binding.identity.probeSerial}` : '（无可靠序列号）') +
        `，目标芯片 ${binding.chipTarget}；身份证据：${input.identityEvidence}`,
      deviceBindingId: binding.id,
    });
    if (!approved) {
      this.setOperationStatus(op, 'cancelled', (o) => {
        o.endedAt = new Date().toISOString();
        o.failure = { kind: 'permission_denied', message: '设备绑定未获用户确认（拒绝/超时/取消）' };
      });
      throw new OperationCancelledError('设备绑定未获用户确认');
    }
    this.storage.updateBindingConfirmed(binding.id, true);
    this.emit('device/updated', { taskId: task.id, payload: { deviceBindingId: binding.id, confirmedByUser: true } });
    this.setOperationStatus(op, 'authorized', () => {});
    ctx.start();
    this.setOperationStatus(op, 'succeeded', (o) => {
      o.endedAt = new Date().toISOString();
      o.deviceBindingId = binding.id;
      o.resultSummary = `设备已绑定并确认: ${binding.chipTarget}`;
    });
    return {
      ok: true,
      operationId: op.id,
      deviceBindingId: binding.id,
      chipTarget: binding.chipTarget,
      confirmedByUser: true,
    };
  }

  private async toolDeviceFlash(op: Operation, input: DeviceFlashInput, ctx: ExecContext): Promise<DeviceFlashOutput> {
    const adapter = this.requireAdapter();
    const task = this.requireTask(input.taskId);
    const loaded = await this.requireProfile(task.profileId);
    const device = loaded.profile.device;
    if (!device) throw new ToolExecError('environment_missing', 'environment_missing', `profile "${loaded.profile.id}" 未定义设备配置`);
    const artifact = this.storage.getArtifact(input.artifactId);
    if (!artifact) throw new BadRequestError(`产物不存在: ${input.artifactId}`);
    const binding = this.storage.getBinding(input.deviceBindingId);
    if (!binding) throw new BadRequestError(`设备绑定不存在: ${input.deviceBindingId}`);
    if (!binding.confirmedByUser) {
      throw new BadRequestError('设备绑定未经用户确认，拒绝烧录（先完成 device.bind 授权）');
    }

    // 前置检查（FlashPreflight 语义）
    const stat = await fsp.stat(artifact.path).catch(() => null);
    const digestNow = stat ? (await sha256File(artifact.path)).sha256 : null;
    const blockers: string[] = [];
    if (!stat) blockers.push('产物文件不存在');
    if (digestNow !== artifact.sha256) blockers.push('产物哈希与记录不一致');
    const enumerated = await adapter.enumerate().catch(() => [] as EnumeratedDevice[]);
    const attached = enumerated.some(
      (d) => d.identity.usbVid === binding.identity.usbVid && d.identity.usbPid === binding.identity.usbPid,
    );
    if (!attached) blockers.push('目标设备未连接');
    if (blockers.length > 0) {
      throw new ToolExecError('environment_missing', 'environment_missing', `烧录前置检查未通过: ${blockers.join('；')}`);
    }

    // 授权：同范围有效授权免重复确认；否则生成 PendingAuthorization
    const acceptanceDigest = this.acceptanceDigest(task.id);
    const nowIso = new Date().toISOString();
    const existing = this.storage.findValidAuthorization({
      taskId: task.id,
      deviceBindingId: binding.id,
      artifactSha256: artifact.sha256,
      now: nowIso,
    });
    if (!existing) {
      const approved = await ctx.requestAuthorization({
        type: 'device_flash',
        title: `授权烧录：${binding.chipTarget}`,
        scopeSummary: `设备 ${binding.identity.usbVid}:${binding.identity.usbPid} serial=${binding.identity.probeSerial ?? '无'}，` +
          `产物 ${path.basename(artifact.path)} sha256=${artifact.sha256}，任务 ${task.title}`,
        artifactSha256: artifact.sha256,
        acceptanceDigest,
        deviceBindingId: binding.id,
      });
      if (!approved) {
        this.setOperationStatus(op, 'cancelled', (o) => {
          o.endedAt = new Date().toISOString();
          o.failure = { kind: 'permission_denied', message: '烧录未获用户授权（拒绝/超时/取消）' };
        });
        throw new OperationCancelledError('烧录未获用户授权');
      }
      // 走过 awaiting_authorization → authorized；有效旧授权则直接 prepared → running
      this.setOperationStatus(op, 'authorized', () => {});
    }
    ctx.start();

    // 硬件动作：DeviceAdapter（设备 Agent C 提供）
    const lease = await adapter.acquireExclusive(binding.id, `task:${task.id} op:${op.id}`);
    if (!lease.acquired) {
      throw new ToolExecError('permission_denied', 'permission_denied', `设备被占用（${lease.heldBy ?? '未知持有者'}），拒绝并行烧录`);
    }
    try {
      const outcome = await adapter.flash({
        taskId: task.id,
        artifactPath: artifact.path,
        artifactSha256: artifact.sha256,
        buildId: artifact.buildId,
        binding,
        profile: device,
        workDir: ctx.logDir,
        budgetMs: device.flashBudgetMs,
        signal: ctx.signal,
      });
      // 结束状态：succeeded（工具干净退出）；工具异常由适配器抛出 → failed/unknown 由 failureFrom 落
      this.setOperationStatus(op, 'succeeded', (o) => {
        o.endedAt = new Date().toISOString();
        o.deviceBindingId = binding.id;
        o.resultSummary = `烧录完成: ${outcome.toolSummary}`;
      });
      return {
        ok: true,
        operationId: op.id,
        status: 'succeeded',
        toolReceiptPath: outcome.toolReceiptPath,
        toolSummary: outcome.toolSummary,
        durationMs: outcome.durationMs,
        readbackVerified: outcome.readbackVerified,
      };
    } catch (error) {
      // 烧录非干净结束 → unknown 语义（不自动重试）
      if (!(error instanceof ToolExecError) && !(error instanceof OperationCancelledError)) {
        this.setOperationStatus(op, 'unknown', (o) => {
          o.endedAt = new Date().toISOString();
          o.failure = { kind: 'unknown_result', message: `烧录结果未知: ${String(error)}` };
        });
        throw new ToolExecError('unknown_result', 'unknown_result', `烧录结果未知: ${String(error)}`);
      }
      throw error;
    } finally {
      await adapter.releaseExclusive(binding.id).catch(() => undefined);
    }
  }

  private async toolDeviceVerify(op: Operation, input: DeviceVerifyInput, ctx: ExecContext): Promise<DeviceVerifyOutput> {
    const adapter = this.requireAdapter();
    const task = this.requireTask(input.taskId);
    const loaded = await this.requireProfile(task.profileId);
    const device = loaded.profile.device;
    if (!device) throw new ToolExecError('environment_missing', 'environment_missing', `profile "${loaded.profile.id}" 未定义设备配置`);
    if (!device.serial) throw new ToolExecError('environment_missing', 'environment_missing', 'profile 未定义串口验证协议');
    const binding = this.storage.getBinding(input.deviceBindingId);
    if (!binding) throw new BadRequestError(`设备绑定不存在: ${input.deviceBindingId}`);
    if (!binding.confirmedByUser) throw new BadRequestError('设备绑定未经用户确认，拒绝验证');

    ctx.start();
    const artifact = this.storage.latestArtifact(task.id) ?? undefined;
    const outcome = await adapter.verifySerial({
      taskId: task.id,
      binding,
      profile: device,
      buildId: artifact?.buildId,
      workDir: ctx.logDir,
      budgetMs: device.verifyBudgetMs,
      signal: ctx.signal,
    });
    const exchange = outcome.exchange;
    const result: DeviceVerifyOutput['result'] =
      exchange.responseNonceMatch && exchange.buildIdMatch ? 'passed' : 'failed';
    const evidence: Evidence = {
      schemaVersion: SCHEMA_VERSION,
      id: newId('ev'),
      operationId: op.id,
      taskId: task.id,
      inputDigest: this.storage.latestSnapshot(task.id)?.inputDigest ?? sha256Of('no-snapshot'),
      evidenceLevel: 'A',
      artifactDigest: artifact?.sha256,
      artifactId: artifact?.id,
      toolVersions: { node: process.version },
      result,
      detail: { nonceMatch: exchange.responseNonceMatch, buildIdMatch: exchange.buildIdMatch, buildId: exchange.responseBuildId },
      logRef: outcome.logRef,
      createdAt: new Date().toISOString(),
    };
    this.storage.insertEvidence(evidence);
    // 串口验证绑定到同 verifierId 的验收项（proposed 不点亮）
    const items = this.storage.listAcceptanceItems(task.id).filter(
      (a) => a.verifierId === input.verifierId && a.status !== 'proposed',
    );
    const target = items[0];
    if (target) {
      target.status = result === 'passed' ? 'passed' : 'failed';
      target.lastEvidenceId = evidence.id;
      target.updatedAt = new Date().toISOString();
      this.storage.updateAcceptanceItem(target);
      evidence.acceptanceItemId = target.id;
      this.emit('acceptance/updated', { taskId: task.id, payload: { acceptance: this.storage.listAcceptanceItems(task.id) } });
    }
    this.emit('evidence/created', { taskId: task.id, operationId: op.id, payload: { evidenceId: evidence.id, result } });
    this.recomputeTaskStatus(task);
    this.setOperationStatus(op, 'succeeded', (o) => {
      o.endedAt = new Date().toISOString();
      o.deviceBindingId = binding.id;
      o.resultSummary = `串口验证 → ${result}（nonce=${exchange.responseNonceMatch} buildId=${exchange.buildIdMatch}）`;
    });
    return {
      ok: true,
      operationId: op.id,
      evidenceId: evidence.id,
      result,
      nonceMatch: exchange.responseNonceMatch,
      buildIdMatch: exchange.buildIdMatch,
      buildId: exchange.responseBuildId,
      responsePreview: outcome.responsePreview,
      logRef: outcome.logRef,
    };
  }

  /** 验收单摘要（授权范围的一部分：验收规则变化须重新授权） */
  private acceptanceDigest(taskId: string): string {
    const items = this.storage.listAcceptanceItems(taskId);
    return sha256Of(
      canonicalJson(
        items.map((a) => ({ id: a.id, verifierId: a.verifierId, expected: a.expected, required: a.required, status: a.status })),
      ),
    );
  }
}

/** 工具执行失败：toolKind=MCP 工具层（契约冻结枚举）；entityKind=实体 FailureKind（精确） */
export class ToolExecError extends Error {
  readonly toolKind: ToolFailure['kind'];
  readonly entityKind: import('@forgedesk/contracts/common').FailureKind;
  readonly logRef?: string;
  constructor(toolKind: ToolFailure['kind'], entityKind: import('@forgedesk/contracts/common').FailureKind, message: string, logRef?: string) {
    super(message);
    this.name = 'ToolExecError';
    this.toolKind = toolKind;
    this.entityKind = entityKind;
    this.logRef = logRef;
  }
}

