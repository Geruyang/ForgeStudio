/**
 * Codex app-server stdio JSONL 适配层 —— EngineAdapter 实现（contracts/src/engine.ts 冻结契约）。
 *
 * 职责边界：
 * - 进程层：直接 spawn `codex app-server`（可执行文件路径 + ['app-server']，不经 shell），
 *   显式设置 CODEX_HOME 隔离用户主目录配置；JSONL 分帧（大行缓冲上限 + 超限丢弃），stderr 仅限额收集作诊断。
 * - 握手层：initialize（clientInfo.name='forgedesktop'，默认不启用 capabilities.experimentalApi）
 *   → 等 result → initialized 通知 → thread/start 或 thread/resume。
 * - 回合层：turn/start / turn/steer（必带 expectedTurnId，失败不静默重发）/ turn/interrupt（仅请求，等待终态事件）。
 * - 审批层：新旧两组服务端请求都处理（execCommandApproval / applyPatchApproval /
 *   item/commandExecution/requestApproval / item/fileChange/requestApproval / item/permissions/requestApproval），
 *   应答同一 id、校验连接代次；不支持的服务端请求立即按协议拒绝，绝不静默挂起。
 * - 投影层：服务端通知映射为 EngineEvent（严格递增 seq、connectionGeneration、threadId/turnId/itemId、emittedAt）；
 *   未知事件限量记录（100 条样本 + 丢弃计数），不使调用方崩溃。
 * - 防崩层：argsPreview/outputPreview 截断 2000 字符；patch 全文落盘 storageDir/patches/ 后以 patchRef 引用。
 *
 * 本文件不读取 %USERPROFILE%\.codex，不把令牌写入日志（getAuthStatus 强制 includeToken=false）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import type {
  ApprovalDecision,
  ApprovalRequestView,
  AuthStatusInfo,
  ConnectionGeneration,
  EngineAdapter,
  EngineEvent,
  EngineModelInfo,
  EngineStartOptions,
  EngineStatus,
  SteerResult,
  TurnCompletionStatus,
} from '@forgedesk/contracts/engine';
import type { FailureKind, Timestamp } from '@forgedesk/contracts/common';
import { CLIENT_METHODS, JSONRPC_VERSION } from '@forgedesk/contracts/protocol';
import type { RpcId } from '@forgedesk/contracts/protocol';

/** 客户端版本：与 package.json version 保持同步（运行时读文件不可靠，见打包布局） */
const CLIENT_VERSION = '0.1.0';

/** 单条消息/参数预览截断上限（字符） */
const PREVIEW_LIMIT = 2000;
/** 未知事件最多保留的样本条数；超出部分只计数（任务书 §6.2：限量记录不崩溃） */
const UNKNOWN_EVENT_SAMPLE_LIMIT = 200;
/** 未知事件 method 名环形样本上限（诊断导出用；跨会话保留，不随 reset 清空） */
const UNKNOWN_METHOD_NAME_LIMIT = 30;
/** stderr 诊断收集上限（字符） */
const STDERR_LIMIT = 32 * 1024;
/** stderr 落盘文件轮转上限（字节）：超过则重写，避免日志无限增长 */
const STDERR_LOG_ROTATE_BYTES = 5 * 1024 * 1024;
/** 单行 JSONL 缓冲上限（字符）：超限视为协议异常，丢弃该行直到下一个换行 */
const MAX_LINE_CHARS = 32 * 1024 * 1024;
/** 默认单请求超时（毫秒） */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** 默认增量批处理窗口（毫秒） */
const DEFAULT_DELTA_BATCH_MS = 50;

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

export interface CodexEngineAdapterOptions {
  /** codex 可执行文件绝对路径（直接 spawn，不经 shell） */
  codexCliPath: string;
  /** 引擎隔离 CODEX_HOME（绝不指向 %USERPROFILE%\.codex） */
  codexHome: string;
  /** 产品数据目录：patch 全文落盘（patches/ 子目录） */
  storageDir: string;
  /** 缺省项目根（start() 未显式给 projectRoot 时使用） */
  projectRoot?: string;
  /**
   * spawn 参数，默认 ['app-server']。
   * 测试用 node + fixture 脚本路径替代（fixture 协议进程，非模型调用）。
   */
  cliArgs?: string[];
  /** 追加/覆盖子进程环境变量 */
  extraEnv?: Record<string, string>;
  /** 从继承环境中剔除的键（如 OPENAI_API_KEY，避免测试环境凭证泄漏进引擎） */
  omitEnvKeys?: string[];
  /** JSON-RPC 请求默认超时（毫秒） */
  requestTimeoutMs?: number;
  /**
   * 增量批处理窗口（毫秒），默认 50。
   * 仅当 onBatchedDelta 提供时生效；subscribe 事件流始终逐条发出，事件不丢失。
   */
  deltaBatchMs?: number;
  /**
   * 可选的增量批回调：每 deltaBatchMs 聚合一次 message/delta 与 reasoning/delta
   * （按 itemId 合并文本），供消费方做节流渲染；不提供则完全不影响事件流。
   */
  onBatchedDelta?: (batch: DeltaBatchItem[]) => void;
}

/** 一次增量批：按 itemId 合并后的增量文本 */
export interface DeltaBatchItem {
  kind: 'message' | 'reasoning';
  itemId: string;
  text: string;
  threadId?: string;
  turnId?: string;
}

/** initialize 响应的服务端信息 */
export interface EngineServerInfo {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

/** patch 全文落盘文件路径（patchRef → 文件） */
export function patchFilePath(storageDir: string, patchRef: string): string {
  return path.join(storageDir, 'patches', `${patchRef}.patch`);
}

// ---------------------------------------------------------------------------
// 内部错误类型（调用方按 name 分类处理）
// ---------------------------------------------------------------------------

class EngineConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineConnectionError';
  }
}
class EngineTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineTimeoutError';
  }
}
class EngineRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'EngineRpcError';
  }
}
class EngineProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineProtocolError';
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 硬截断（上限字符，含边界），保证预览不无限膨胀 */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type ProjectedEvent = DistributiveOmit<EngineEvent, 'seq' | 'connectionGeneration' | 'emittedAt'>;

/** 递归截断 detail 中的长字符串（深度受限），避免审批 detail 携带巨型 diff 进入事件流 */
function truncateStringsDeep(value: unknown, max: number, depth = 0): unknown {
  if (depth > 4) return truncate(typeof value === 'string' ? value : JSON.stringify(value) ?? '', max);
  if (typeof value === 'string') return truncate(value, max);
  if (Array.isArray(value)) return value.map((v) => truncateStringsDeep(v, max, depth + 1));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncateStringsDeep(v, max, depth + 1);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// 协议分帧与信封
// ---------------------------------------------------------------------------

/** 宽容的 JSON-RPC 信封：真实 app-server 与 fixture 都满足；字段缺失按未知消息处理 */
const RpcWireSchema = z
  .object({
    jsonrpc: z.unknown().optional(),
    method: z.string().optional(),
    id: z.union([z.number(), z.string(), z.null()]).optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number(),
        message: z.string(),
        data: z.unknown().optional(),
      })
      .optional(),
  })
  .passthrough();

/** 从 turn/start 或 thread/start 的 result 中尽力取出 id（真实协议返回 Turn/Thread，fixture 同形） */
function pickIdFromResult(result: unknown, ...keys: string[]): string | undefined {
  if (!isRecord(result)) return undefined;
  for (const key of keys) {
    const v = result[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function extractThreadId(result: unknown): string | undefined {
  return pickIdFromResult(result, 'id') ?? pickIdFromResult(isRecord(result) ? result['thread'] : undefined, 'id');
}

function extractTurnId(result: unknown): string | undefined {
  return pickIdFromResult(result, 'id') ?? pickIdFromResult(isRecord(result) ? result['turn'] : undefined, 'id');
}

/** 统一 diff 文本 → 文件清单（git 风格 ---/+++ 头） */
function parseUnifiedDiffFiles(diff: string): Array<{ path: string; changeType: 'added' | 'modified' | 'deleted' }> {
  const out: Array<{ path: string; changeType: 'added' | 'modified' | 'deleted' }> = [];
  let pendingOld: string | null = null;
  for (const raw of diff.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('--- ')) {
      pendingOld = line.slice(4).split('\t')[0]?.trim() ?? null;
    } else if (line.startsWith('+++ ')) {
      const newP = line.slice(4).split('\t')[0]?.trim() ?? '';
      const oldP = pendingOld;
      pendingOld = null;
      const oldIsDev = oldP === '/dev/null';
      const newIsDev = newP === '/dev/null';
      let p: string;
      let changeType: 'added' | 'modified' | 'deleted';
      if (oldIsDev && !newIsDev) {
        p = newP.replace(/^b\//, '');
        changeType = 'added';
      } else if (newIsDev && !oldIsDev) {
        p = (oldP ?? '').replace(/^a\//, '');
        changeType = 'deleted';
      } else {
        p = newP.replace(/^b\//, '');
        changeType = 'modified';
      }
      if (p && p !== '/dev/null' && !out.some((f) => f.path === p)) out.push({ path: p, changeType });
    }
  }
  return out;
}

function diffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const raw of diff.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

// ---------------------------------------------------------------------------
// 服务端请求（审批）参数的宽松校验
// ---------------------------------------------------------------------------

const ExecCommandApprovalParamsSchema = z
  .object({
    conversationId: z.union([z.string(), z.number()]).optional(),
    callId: z.string().optional(),
    approvalId: z.string().nullable().optional(),
    command: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    reason: z.string().nullable().optional(),
  })
  .passthrough();

const ApplyPatchApprovalParamsSchema = z
  .object({
    conversationId: z.union([z.string(), z.number()]).optional(),
    callId: z.string().optional(),
    fileChanges: z.record(z.unknown()).optional(),
    reason: z.string().nullable().optional(),
    grantRoot: z.string().nullable().optional(),
  })
  .passthrough();

const CommandExecutionRequestApprovalParamsSchema = z
  .object({
    threadId: z.string().optional(),
    turnId: z.string().optional(),
    itemId: z.string().optional(),
    kind: z.string().optional(),
    command: z.string().nullable().optional(),
    cwd: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
  })
  .passthrough();

const FileChangeRequestApprovalParamsSchema = z
  .object({
    threadId: z.string().optional(),
    turnId: z.string().optional(),
    itemId: z.string().optional(),
    reason: z.string().nullable().optional(),
    grantRoot: z.string().nullable().optional(),
  })
  .passthrough();

const PermissionsRequestApprovalParamsSchema = z
  .object({
    threadId: z.string().optional(),
    turnId: z.string().optional(),
    itemId: z.string().optional(),
    reason: z.string().nullable().optional(),
    cwd: z.string().nullable().optional(),
    permissions: z
      .object({
        network: z.unknown().nullable().optional(),
        fileSystem: z.unknown().nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// 主适配器
// ---------------------------------------------------------------------------

interface PendingRequest {
  method: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface PendingApproval {
  /** 服务端请求的原始 JSON-RPC id（应答必须带回同一 id） */
  id: RpcId;
  method: string;
  /** 收到该请求时的连接代次：引擎重启后旧批准不得重放 */
  generation: ConnectionGeneration;
  view: ApprovalRequestView;
  rawParams: unknown;
}

/** 已知但首发不消费、静默丢弃的通知（不占用未知事件样本配额，避免高频状态类通知刷屏）。
 * 注意：thread/tokenUsage/updated 已投影为 usage/updated 事件（D19），不在此列。 */
const IGNORED_NOTIFICATIONS = new Set([
  'thread/name/updated',
  'thread/prediction/updated',
  'thread/queue/changed',
  'thread/settings/updated',
  'thread/attachment/updated',
  'thread/goal/updated',
  'thread/goal/cleared',
  'thread/environment/connected',
  'thread/environment/disconnected',
  'thread/compacted',
  'fs/changed',
  'process/exited',
  'process/outputDelta',
  'command/exec/outputDelta',
  'item/commandExecution/outputDelta',
  'item/commandExecution/terminalInteraction',
  'item/fileChange/outputDelta',
  'hook/started',
  'hook/completed',
  'rawResponseItem/completed',
  'rawResponse/completed',
  'item/autoApprovalReview/started',
  'item/autoApprovalReview/completed',
  'autoApprovalReview/strictReviewRequired',
  'item/mcpToolCall/progress',
  'mcpServer/startupStatus/updated',
  'mcpServer/oauthLogin/completed',
  'model/rerouted',
  'model/verification',
  'turn/plan/updated',
  'item/plan/delta',
  // 0.162.1 实测新增的状态类噪音（不影响会话投影；实测会以"未识别事件"刷屏）
  'remoteControl/status/changed',
  'account/rateLimits/updated',
  'warning',
  'deprecationNotice',
  'configWarning',
  'guardianWarning',
]);

export class CodexEngineAdapter implements EngineAdapter {
  readonly #options: CodexEngineAdapterOptions;
  readonly #listeners = new Set<(event: EngineEvent) => void>();

  #proc: ChildProcess | null = null;
  #procFailed = false;
  #connected = false;
  #status: EngineStatus = 'stopped';
  #generation: ConnectionGeneration = 0;
  #seqCounter = 0;
  #nextRequestId = 0;
  #patchCounter = 0;

  #threadId: string | null = null;
  #activeTurnId: string | null = null;
  #lastTurnId: string | null = null;
  #activeProjectRoot: string | null = null;
  #serverInfo: EngineServerInfo | null = null;

  readonly #pending = new Map<string, PendingRequest>();
  /** 已收到的服务端审批请求：引擎重启后旧条目按代次拒绝重放 */
  readonly #pendingApprovals = new Map<string, PendingApproval>();

  readonly #emittedUserMessageIds = new Set<string>();
  readonly #sessionAnnounced = new Set<string>();
  readonly #turnPatchFiles = new Map<string, Map<string, 'added' | 'modified' | 'deleted'>>();
  readonly #lastTurnDiffHash = new Map<string, string>();

  #unknownSamples = 0;
  #unknownDropped = 0;
  /** 最近未识别通知的 method 名（去重、环形上限），供诊断导出 */
  readonly #unknownMethodNames: string[] = [];

  // stdout 分帧状态
  #decoder = new StringDecoder('utf8');
  #lineBuf = '';
  #discardUntilNewline = false;

  // stderr 限额诊断
  #stderrTail = '';
  /** stderr 落盘写队列（串行，防交错）；文件为 storageDir/engine-stderr.log */
  #stderrQueue: Promise<void> = Promise.resolve();

  // 增量批处理（可选 onBatchedDelta）
  #deltaBuffer: EngineEvent[] = [];
  #deltaFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: CodexEngineAdapterOptions) {
    this.#options = options;
  }

  // ---- 只读状态（契约 + 少量扩展） ----

  get generation(): ConnectionGeneration {
    return this.#generation;
  }

  get status(): EngineStatus {
    return this.#status;
  }

  /** 最近一次 start() 使用的项目根（恢复会话视图等场景使用） */
  get projectRoot(): string | undefined {
    return this.#activeProjectRoot ?? this.#options.projectRoot ?? undefined;
  }

  /** initialize 握手返回的服务端信息；未完成握手时为 null */
  get serverInfo(): EngineServerInfo | null {
    return this.#serverInfo;
  }

  /** 未知事件限量统计：保留样本数 + 丢弃计数 */
  unknownEventStats(): { retained: number; dropped: number } {
    return { retained: this.#unknownSamples, dropped: this.#unknownDropped };
  }

  /** 最近未识别通知的 method 名（去重样本，诊断导出用） */
  unknownMethodSamples(): string[] {
    return [...this.#unknownMethodNames];
  }

  /** stderr 诊断尾巴（限额收集，仅供排障，不含令牌） */
  stderrTail(): string {
    return this.#stderrTail;
  }

  // ---- 事件订阅 ----

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // ---- 生命周期 ----

  async start(options: EngineStartOptions): Promise<{ threadId: string; generation: number }> {
    // 重建连接：先停旧进程（旧审批按代次保留，重启后不可重放）
    if (this.#proc && this.#connected) {
      await this.#stopProcess('start() 重建连接前关闭旧引擎进程');
    }
    this.#generation += 1;
    const gen = this.#generation;
    const projectRoot = options.projectRoot ?? this.#options.projectRoot ?? process.cwd();
    this.#activeProjectRoot = projectRoot;
    this.#resetSessionState();
    this.#setStatus('starting');

    try {
      this.#spawnProcess();
      // 握手：initialize → initialized → thread/start|resume
      const initResult = await this.#sendRequest(CLIENT_METHODS.initialize, {
        clientInfo: { name: 'forgedesktop', title: null, version: CLIENT_VERSION },
        // 默认不启用 capabilities.experimentalApi（首发决策 D5）
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      if (!isRecord(initResult)) {
        throw new EngineProtocolError('initialize 响应格式异常：result 不是对象');
      }
      this.#serverInfo = {
        userAgent: typeof initResult['userAgent'] === 'string' ? (initResult['userAgent'] as string) : '',
        codexHome: typeof initResult['codexHome'] === 'string' ? (initResult['codexHome'] as string) : '',
        platformFamily: typeof initResult['platformFamily'] === 'string' ? (initResult['platformFamily'] as string) : '',
        platformOs: typeof initResult['platformOs'] === 'string' ? (initResult['platformOs'] as string) : '',
      };
      await this.#sendNotification(CLIENT_METHODS.initialized);

      const modelOverride =
        typeof options.model === 'string' && options.model.length > 0 ? { model: options.model } : {};
      let threadId: string | undefined;
      if (options.resumeThreadId) {
        const resumed = await this.#sendRequest(CLIENT_METHODS.threadResume, {
          threadId: options.resumeThreadId,
          cwd: projectRoot,
          ...modelOverride,
        });
        threadId = extractThreadId(resumed);
      } else {
        const started = await this.#sendRequest(CLIENT_METHODS.threadStart, {
          cwd: projectRoot,
          ...modelOverride,
        });
        threadId = extractThreadId(started);
      }
      if (!threadId) {
        throw new EngineProtocolError(`${options.resumeThreadId ? 'thread/resume' : 'thread/start'} 响应缺少 threadId`);
      }
      this.#threadId = threadId;

      // 认证探测：未登录/无 key 时状态置 auth_required（不虚报 ready）
      let authed: boolean;
      try {
        authed = (await this.#fetchAuthStatus()).ok;
      } catch {
        authed = true; // 探测失败不阻塞会话，后续 authStatus() 会重新上报
      }
      this.#emitSessionStarted(threadId);
      this.#setStatus(authed ? 'ready' : 'auth_required');
      return { threadId, generation: gen };
    } catch (e) {
      await this.#stopProcess('握手失败，关闭引擎进程');
      this.#setStatus('error', errMsg(e));
      throw e;
    }
  }

  async dispose(): Promise<void> {
    if (!this.#proc) return;
    await this.#stopProcess('dispose() 主动关闭');
  }

  // ---- 回合 ----

  async send(text: string): Promise<{ turnId: string }> {
    const threadId = this.#requireThread();
    const input = [{ type: 'text', text, text_elements: [] }];
    const result = await this.#sendRequest(CLIENT_METHODS.turnStart, { threadId, input });
    let turnId = extractTurnId(result);
    if (!turnId) {
      turnId = await this.#waitForTurnStarted();
    }
    if (!turnId) {
      throw new EngineProtocolError('turn/start 响应缺少 turnId 且未观察到 turn/started');
    }
    if (this.#activeTurnId == null) this.#activeTurnId = turnId;
    return { turnId };
  }

  async steer(text: string): Promise<SteerResult> {
    if (!this.#threadId || !this.#connected) {
      return { delivered: false, reason: 'not_running' };
    }
    if (!this.#activeTurnId) {
      // 回合已结束或从未开始：不静默重发，输入由用户发到新回合
      return { delivered: false, reason: this.#lastTurnId ? 'turn_ended' : 'not_running' };
    }
    const input = [{ type: 'text', text, text_elements: [] }];
    try {
      await this.#sendRequest(CLIENT_METHODS.turnSteer, {
        threadId: this.#threadId,
        input,
        expectedTurnId: this.#activeTurnId,
      });
      return { delivered: true };
    } catch (e) {
      if (e instanceof EngineTimeoutError) {
        // 无法确认送达：按不可插入处理（回合已结束或响应过慢），输入保留给用户
        return { delivered: false, reason: 'turn_ended' };
      }
      if (e instanceof EngineConnectionError) {
        return { delivered: false, reason: 'not_running' };
      }
      if (e instanceof EngineRpcError) {
        const reason = /mismatch|expected/i.test(e.message) ? 'id_mismatch' : 'turn_ended';
        return { delivered: false, reason };
      }
      throw e;
    }
  }

  async interrupt(): Promise<void> {
    if (!this.#threadId || !this.#connected || !this.#activeTurnId) return;
    // 仅发出请求；停止以服务端终态事件（turn/completed interrupted）为准，不本地虚标
    await this.#sendRequest(CLIENT_METHODS.turnInterrupt, {
      threadId: this.#threadId,
      turnId: this.#activeTurnId,
    });
  }

  // ---- 审批 ----

  async approve(requestId: string, decision: ApprovalDecision): Promise<void> {
    const entry = this.#pendingApprovals.get(requestId);
    if (!entry) {
      throw new EngineProtocolError(`找不到待处理的审批请求 ${requestId}（可能已应答或不存在）`);
    }
    if (entry.generation !== this.#generation) {
      throw new EngineProtocolError(
        `审批请求 ${requestId} 属于连接代次 ${entry.generation}，当前代次为 ${this.#generation}；引擎已重启，旧批准不得重放给新连接`,
      );
    }
    const response = this.#approvalResponseFor(entry.method, decision, entry.rawParams);
    if (response.error) {
      await this.#writeLine({ jsonrpc: JSONRPC_VERSION, id: entry.id, error: response.error });
    } else {
      await this.#writeLine({ jsonrpc: JSONRPC_VERSION, id: entry.id, result: response.result });
    }
    this.#pendingApprovals.delete(requestId);
    this.#emitEvent({
      type: 'approval/resolved',
      requestId,
      decision,
      threadId: this.#threadId ?? undefined,
    });
  }

  // ---- 模型与认证 ----

  async listModels(): Promise<EngineModelInfo[]> {
    const models: EngineModelInfo[] = [];
    let cursor: string | null = null;
    // 分页拉取（防 cursor 异常循环，上限 20 页）
    for (let page = 0; page < 20; page++) {
      const result = await this.#sendRequest(CLIENT_METHODS.modelList, cursor ? { cursor } : {});
      if (!isRecord(result) || !Array.isArray(result['data'])) break;
      for (const m of result['data']) {
        if (isRecord(m) && typeof m['id'] === 'string') {
          models.push({
            id: m['id'] as string,
            displayName: typeof m['displayName'] === 'string' ? (m['displayName'] as string) : undefined,
          });
        }
      }
      const next = result['nextCursor'];
      if (typeof next !== 'string' || next.length === 0) break;
      cursor = next;
    }
    return models;
  }

  async authStatus(): Promise<AuthStatusInfo> {
    return this.#fetchAuthStatus();
  }

  /** getAuthStatus 强制 includeToken=false：不把令牌带进内存/日志/事件 */
  async #fetchAuthStatus(): Promise<AuthStatusInfo> {
    const result = await this.#sendRequest(CLIENT_METHODS.authStatus, { includeToken: false, refreshToken: false });
    const authMethod = isRecord(result) ? result['authMethod'] : undefined;
    // requiresOpenaiAuth=false：当前是自定义 provider（env_key 自持凭证），无需 OpenAI 认证——
    // 0.162.1 实测此时 authMethod=null，误判 none 会把引擎卡在 auth_required（输入框被禁用）
    const providerSelfAuthed = isRecord(result) && result['requiresOpenaiAuth'] === false;
    const mode: AuthStatusInfo['mode'] =
      authMethod === 'apikey' ||
      authMethod === 'personalAccessToken' ||
      authMethod === 'bedrockApiKey' ||
      authMethod === 'bedrockAccessKeys' ||
      authMethod === 'headers'
        ? 'api_key'
        : authMethod === 'chatgpt' || authMethod === 'chatgptAuthTokens' || authMethod === 'agentIdentity'
          ? 'chatgpt_account'
          : providerSelfAuthed
            ? 'api_key'
            : 'none';
    const hint: Record<AuthStatusInfo['mode'], string> = {
      api_key: providerSelfAuthed && authMethod == null ? '模型提供方 API Key 已配置' : 'API Key 已配置',
      chatgpt_account: 'ChatGPT 账号已登录',
      none: '未配置凭证',
    };
    return { mode, accountHint: hint[mode], ok: mode !== 'none' };
  }

  // ---------------------------------------------------------------------------
  // 进程与分帧
  // ---------------------------------------------------------------------------

  #spawnProcess(): void {
    const env: NodeJS.ProcessEnv = { ...process.env, ...(this.#options.extraEnv ?? {}) };
    for (const key of this.#options.omitEnvKeys ?? []) delete env[key];
    // 显式隔离 CODEX_HOME，且始终最后设置，防止被 extraEnv 覆盖
    env['CODEX_HOME'] = this.#options.codexHome;

    const proc = spawn(this.#options.codexCliPath, this.#options.cliArgs ?? ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    });
    this.#proc = proc;
    this.#procFailed = false;
    this.#connected = true;
    this.#decoder = new StringDecoder('utf8');
    this.#lineBuf = '';
    this.#discardUntilNewline = false;
    this.#stderrTail = '';

    proc.stdout?.on('data', (chunk: Buffer) => this.#onStdoutChunk(chunk));
    proc.stderr?.on('data', (chunk: Buffer) => this.#onStderrChunk(chunk));
    proc.on('exit', (code, signal) => this.#onExit(code, signal));
    proc.on('error', (err) => this.#onSpawnError(err));
  }

  #onStderrChunk(chunk: Buffer): void {
    const text = chunk.toString('utf8');
    const merged = this.#stderrTail + text;
    this.#stderrTail = merged.length > STDERR_LIMIT ? merged.slice(merged.length - STDERR_LIMIT) : merged;
    if (text.length > 0) void this.#persistStderr(text);
  }

  /** stderr 只作诊断：落盘 storageDir/engine-stderr.log，超 5MB 轮转（重写） */
  #persistStderr(text: string): void {
    const file = path.join(this.#options.storageDir, 'engine-stderr.log');
    this.#stderrQueue = this.#stderrQueue
      .then(async () => {
        await mkdir(path.dirname(file), { recursive: true });
        let size = 0;
        try {
          size = (await stat(file)).size;
        } catch {
          /* 文件尚不存在 */
        }
        if (size + Buffer.byteLength(text, 'utf8') > STDERR_LOG_ROTATE_BYTES) {
          await writeFile(file, text, 'utf8');
        } else {
          await appendFile(file, text, 'utf8');
        }
      })
      .catch(() => {
        /* 诊断日志写入失败不影响协议与事件流 */
      });
  }

  #onStdoutChunk(chunk: Buffer): void {
    this.#lineBuf += this.#decoder.write(chunk);
    if (this.#discardUntilNewline) {
      const nl = this.#lineBuf.indexOf('\n');
      if (nl < 0) {
        // 仍在丢弃超限行残余；整体长度仍设硬上限防无限增长
        if (this.#lineBuf.length > MAX_LINE_CHARS) this.#lineBuf = '';
        return;
      }
      this.#lineBuf = this.#lineBuf.slice(nl + 1);
      this.#discardUntilNewline = false;
    }
    let idx: number;
    while (!this.#discardUntilNewline && (idx = this.#lineBuf.indexOf('\n')) >= 0) {
      const line = this.#lineBuf.slice(0, idx);
      this.#lineBuf = this.#lineBuf.slice(idx + 1);
      const trimmed = line.trim();
      if (trimmed.length > 0) this.#handleLine(trimmed);
      if (this.#lineBuf.length > MAX_LINE_CHARS) {
        this.#lineBuf = '';
        this.#discardUntilNewline = true;
        this.#emitEvent({
          type: 'error',
          code: 'internal_error',
          message: `单行 JSONL 超过缓冲上限 ${MAX_LINE_CHARS} 字符，已丢弃该行后续内容`,
          recoverable: true,
          threadId: this.#threadId ?? undefined,
        });
        break;
      }
    }
  }

  #handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.#emitEvent({
        type: 'error',
        code: 'internal_error',
        message: `引擎输出行不是合法 JSON（长度 ${line.length}），已丢弃该行`,
        recoverable: true,
        threadId: this.#threadId ?? undefined,
      });
      return;
    }
    const wire = RpcWireSchema.safeParse(parsed);
    if (!wire.success) {
      this.#recordUnknown('(unparseable-envelope)', line);
      return;
    }
    const { method, id, params, result, error } = wire.data;
    if (typeof method === 'string') {
      if (id !== undefined && id !== null) {
        this.#handleServerRequest(id, method, params);
      } else {
        this.#handleNotification(method, params);
      }
      return;
    }
    if ((result !== undefined || error !== undefined) && id !== undefined && id !== null) {
      this.#handleResponse(id, result, error);
      return;
    }
    this.#recordUnknown('(unclassified)', line);
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.#connected = false;
    this.#activeTurnId = null;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new EngineConnectionError(`引擎进程已退出（code=${code}, signal=${signal ?? ''}）`));
    }
    this.#pending.clear();
    // 意外退出也冲刷增量批，保证 onBatchedDelta 不丢最后一窗
    if (this.#deltaFlushTimer != null) {
      clearTimeout(this.#deltaFlushTimer);
      this.#deltaFlushTimer = null;
    }
    this.#flushDeltaBatch();
    this.#setStatus('stopped', `引擎进程退出（code=${code ?? 'null'}）`);
  }

  #onSpawnError(err: Error): void {
    this.#procFailed = true;
    this.#connected = false;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new EngineConnectionError(`引擎进程启动失败：${err.message}`));
    }
    this.#pending.clear();
    if (this.#status !== 'stopping' && this.#status !== 'stopped') {
      this.#setStatus('error', `引擎进程启动失败：${err.message}`);
    }
  }

  async #stopProcess(reason: string): Promise<void> {
    const proc = this.#proc;
    if (!proc) return;
    this.#setStatus('stopping', reason);
    // 先请求取消活动回合（短暂等待应答；失败不阻塞关闭）
    if (this.#activeTurnId && this.#connected && this.#threadId) {
      try {
        await this.#sendRequest(
          CLIENT_METHODS.turnInterrupt,
          { threadId: this.#threadId, turnId: this.#activeTurnId },
          1500,
        );
      } catch {
        /* 尽力而为 */
      }
    }
    const exited = proc.exitCode !== null || proc.signalCode !== null || this.#procFailed;
    if (!exited) {
      const closed = new Promise<void>((resolve) => proc.once('close', () => resolve()));
      try {
        if (process.platform === 'win32' && typeof proc.pid === 'number') {
            // Windows：taskkill /T 杀整棵进程树（引擎派生的工具子进程不残留），/F 强制
            void spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
              stdio: 'ignore',
              windowsHide: true,
            });
          } else {
          proc.kill('SIGKILL');
        }
      } catch {
        /* 已退出 */
      }
      await Promise.race([closed, delay(3000)]);
    }
    this.#connected = false;
    this.#activeTurnId = null;
    this.#flushDeltaBatch();
    if (this.#deltaFlushTimer != null) {
      clearTimeout(this.#deltaFlushTimer);
      this.#deltaFlushTimer = null;
    }
    this.#setStatus('stopped', reason);
    this.#proc = null;
    this.#procFailed = false;
  }

  #requireThread(): string {
    if (!this.#connected || !this.#threadId) {
      throw new EngineConnectionError('引擎尚未启动或未完成会话初始化');
    }
    return this.#threadId;
  }

  // ---------------------------------------------------------------------------
  // JSON-RPC 请求通道
  // ---------------------------------------------------------------------------

  async #sendRequest(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.#connected || !this.#proc?.stdin) {
      throw new EngineConnectionError('引擎进程未运行');
    }
    const id = ++this.#nextRequestId;
    const key = String(id);
    const timeout = timeoutMs ?? this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const payload =
      params === undefined
        ? { jsonrpc: JSONRPC_VERSION, id, method }
        : { jsonrpc: JSONRPC_VERSION, id, method, params };
    try {
      await this.#writeLine(payload);
    } catch (e) {
      throw new EngineConnectionError(`请求 ${method} 写入失败：${errMsg(e)}`);
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(key);
        reject(new EngineTimeoutError(`请求 ${method} 超时（${timeout}ms）未收到响应`));
      }, timeout);
      this.#pending.set(key, { method, timer, resolve, reject });
    });
  }

  async #sendNotification(method: string, params?: unknown): Promise<void> {
    try {
      const payload =
        params === undefined ? { jsonrpc: JSONRPC_VERSION, method } : { jsonrpc: JSONRPC_VERSION, method, params };
      await this.#writeLine(payload);
    } catch {
      /* 通知失败不致命；后续请求/事件会暴露连接问题 */
    }
  }

  #writeLine(msg: unknown): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const stdin = this.#proc?.stdin;
      if (!stdin || !this.#connected) {
        reject(new EngineConnectionError('引擎进程未运行'));
        return;
      }
      stdin.write(JSON.stringify(msg) + '\n', (err) =>
        err ? reject(new EngineConnectionError(`stdin 写入失败：${err.message}`)) : resolve(),
      );
    });
  }

  #handleResponse(id: RpcId, result: unknown, error: { code: number; message: string; data?: unknown } | undefined): void {
    const pending = this.#pending.get(String(id));
    if (!pending) return; // 迟到/未登记的响应：忽略（不伪造、不崩溃）
    clearTimeout(pending.timer);
    this.#pending.delete(String(id));
    if (error) {
      pending.reject(new EngineRpcError(error.code, `${pending.method} 调用失败（code ${error.code}）: ${error.message}`, error.data));
    } else {
      pending.resolve(result);
    }
  }

  /** 等待下一个 turn/started 通知（send() 的响应缺少 turnId 时的回退；微任务间隙内不会错过事件） */
  #waitForTurnStarted(): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve) => {
      const finish = (turnId: string | undefined) => {
        this.#listeners.delete(onEvent);
        clearTimeout(timer);
        resolve(turnId);
      };
      const onEvent = (event: EngineEvent) => {
        if (event.type === 'turn/started') finish(event.turnId);
      };
      this.#listeners.add(onEvent);
      const timer = setTimeout(
        () => finish(undefined),
        this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      );
    });
  }

  // ---------------------------------------------------------------------------
  // 服务端请求（审批 + 不支持项拒绝）
  // ---------------------------------------------------------------------------

  #handleServerRequest(id: RpcId, method: string, params: unknown): void {
    const threadIdFrom = (p: Record<string, unknown>): string | undefined =>
      typeof p['threadId'] === 'string'
        ? p['threadId']
        : typeof p['conversationId'] === 'string' || typeof p['conversationId'] === 'number'
          ? String(p['conversationId'])
          : undefined;

    switch (method) {
      case 'execCommandApproval': {
        const parsed = ExecCommandApprovalParamsSchema.safeParse(params);
        if (!parsed.success) {
          this.#rejectServerRequest(id, -32602, 'execCommandApproval 参数无效');
          return;
        }
        const p = parsed.data;
        const command = Array.isArray(p.command) ? p.command.join(' ') : '(未提供命令)';
        const summary = `执行命令审批：${command}${p.cwd ? `（工作目录：${p.cwd}）` : ''}${p.reason ? `；原因：${p.reason}` : ''}`;
        this.#registerApproval(id, method, 'exec_command', summary, params, {
          threadId: threadIdFrom(p as Record<string, unknown>),
          detail: truncateStringsDeep(params, PREVIEW_LIMIT),
        });
        return;
      }
      case 'applyPatchApproval': {
        const parsed = ApplyPatchApprovalParamsSchema.safeParse(params);
        if (!parsed.success) {
          this.#rejectServerRequest(id, -32602, 'applyPatchApproval 参数无效');
          return;
        }
        const p = parsed.data;
        const files = p.fileChanges ? Object.keys(p.fileChanges) : [];
        const summary = `文件修改审批：${files.length} 个文件${files.length > 0 ? `（${files.slice(0, 5).join('、')}${files.length > 5 ? ' 等' : ''}）` : ''}${p.reason ? `；原因：${p.reason}` : ''}`;
        this.#registerApproval(id, method, 'apply_patch', summary, params, {
          threadId: threadIdFrom(p as Record<string, unknown>),
          detail: truncateStringsDeep(params, PREVIEW_LIMIT),
        });
        return;
      }
      case 'item/commandExecution/requestApproval': {
        const parsed = CommandExecutionRequestApprovalParamsSchema.safeParse(params);
        if (!parsed.success) {
          this.#rejectServerRequest(id, -32602, 'item/commandExecution/requestApproval 参数无效');
          return;
        }
        const p = parsed.data;
        const command = typeof p.command === 'string' ? p.command : '(未提供命令)';
        const summary = `执行命令审批：${command}${p.cwd ? `（工作目录：${p.cwd}）` : ''}${p.reason ? `；原因：${p.reason}` : ''}`;
        this.#registerApproval(id, method, 'exec_command', summary, params, {
          threadId: typeof p.threadId === 'string' ? p.threadId : undefined,
          turnId: typeof p.turnId === 'string' ? p.turnId : undefined,
          itemId: typeof p.itemId === 'string' ? p.itemId : undefined,
          detail: truncateStringsDeep(params, PREVIEW_LIMIT),
        });
        return;
      }
      case 'item/fileChange/requestApproval': {
        const parsed = FileChangeRequestApprovalParamsSchema.safeParse(params);
        if (!parsed.success) {
          this.#rejectServerRequest(id, -32602, 'item/fileChange/requestApproval 参数无效');
          return;
        }
        const p = parsed.data;
        const summary = `文件修改审批${p.reason ? `：${p.reason}` : '（服务端未给出原因）'}${p.grantRoot ? `；会话内授权写入目录：${p.grantRoot}` : ''}`;
        this.#registerApproval(id, method, 'apply_patch', summary, params, {
          threadId: typeof p.threadId === 'string' ? p.threadId : undefined,
          turnId: typeof p.turnId === 'string' ? p.turnId : undefined,
          itemId: typeof p.itemId === 'string' ? p.itemId : undefined,
          detail: truncateStringsDeep(params, PREVIEW_LIMIT),
        });
        return;
      }
      case 'item/permissions/requestApproval': {
        const parsed = PermissionsRequestApprovalParamsSchema.safeParse(params);
        if (!parsed.success) {
          this.#rejectServerRequest(id, -32602, 'item/permissions/requestApproval 参数无效');
          return;
        }
        const p = parsed.data;
        const summary = `权限申请审批${p.reason ? `：${p.reason}` : '（服务端申请额外权限）'}`;
        this.#registerApproval(id, method, 'other', summary, params, {
          threadId: typeof p.threadId === 'string' ? p.threadId : undefined,
          turnId: typeof p.turnId === 'string' ? p.turnId : undefined,
          itemId: typeof p.itemId === 'string' ? p.itemId : undefined,
          detail: truncateStringsDeep(params, PREVIEW_LIMIT),
        });
        return;
      }
      case 'item/tool/requestUserInput': {
        // 首发不启用用户输入回填：立即按协议拒绝，不能静默挂起
        this.#rejectServerRequest(id, -32603, '首发版本未启用用户输入回填，已自动取消');
        this.#emitEvent({
          type: 'error',
          code: 'permission_denied',
          message: '服务端请求 item/tool/requestUserInput，首发版本未启用，已自动拒绝',
          recoverable: true,
          threadId: this.#threadId ?? undefined,
        });
        return;
      }
      case 'mcpServer/elicitation/request': {
        // codex 把 MCP 工具调用确认包装为 elicitation 表单（_meta.codex_approval_kind=mcp_tool_call，
        // 实测 schema 为空对象——同意与否由 action 表达）。转成产品既有审批卡，由用户决定；
        // 其他来源的 elicitation 首发不支持，按协议 decline。
        const meta = isRecord(params) && isRecord(params['_meta']) ? params['_meta'] : {};
        const isToolCall = meta['codex_approval_kind'] === 'mcp_tool_call';
        if (isToolCall) {
          const displays = Array.isArray(meta['tool_params_display']) ? meta['tool_params_display'] : [];
          const argsPreview = displays
            .map((d) => {
              const r = isRecord(d) ? d : {};
              const name = typeof r['display_name'] === 'string' ? r['display_name'] : '?';
              const value = String(r['value'] ?? '').slice(0, 80);
              return `${name}=${value}`;
            })
            .join('，');
          const message = isRecord(params) && typeof params['message'] === 'string' ? params['message'] : '允许 MCP 工具调用？';
          const serverName = isRecord(params) && typeof params['serverName'] === 'string' ? params['serverName'] : 'mcp';
          this.#registerApproval(id, method, 'mcp_tool', `${serverName} · ${message}${argsPreview ? `\n参数：${argsPreview}` : ''}`, params, {
            threadId: isRecord(params) && typeof params['threadId'] === 'string' ? params['threadId'] : undefined,
            turnId: isRecord(params) && typeof params['turnId'] === 'string' ? params['turnId'] : undefined,
          });
        } else {
          void this.#writeLine({
            jsonrpc: JSONRPC_VERSION,
            id,
            result: { action: 'decline', content: null, _meta: null },
          });
          this.#emitEvent({
            type: 'error',
            code: 'permission_denied',
            message: '服务端请求 mcpServer/elicitation/request（非工具确认类），首发版本未启用，已自动拒绝',
            recoverable: true,
            threadId: this.#threadId ?? undefined,
          });
        }
        return;
      }
      default: {
        // 未知服务端请求：返回协议允许的 MethodNotFound 错误，绝不静默挂起
        this.#rejectServerRequest(id, -32601, `Method not supported by forgedesktop adapter: ${method}`);
        this.#recordUnknown(method, JSON.stringify(params ?? null));
      }
    }
  }

  #rejectServerRequest(id: RpcId, code: number, message: string): void {
    void this.#writeLine({ jsonrpc: JSONRPC_VERSION, id, error: { code, message } }).catch(() => {
      /* 连接已断时忽略；等待方会因连接错误收尾 */
    });
  }

  #registerApproval(
    id: RpcId,
    method: string,
    kind: ApprovalRequestView['kind'],
    summary: string,
    rawParams: unknown,
    extra: { threadId?: string; turnId?: string; itemId?: string; detail?: unknown },
  ): void {
    const requestId = String(id);
    const view: ApprovalRequestView = {
      requestId,
      connectionGeneration: this.#generation,
      kind,
      summary: truncate(summary, PREVIEW_LIMIT),
      // 请求未携带选项限制信息时提供全部四种决定；应答仍按协议映射为对应决定值
      options: ['accept', 'acceptForSession', 'decline', 'cancel'],
      detail: extra.detail,
    };
    this.#pendingApprovals.set(requestId, { id, method, generation: this.#generation, view, rawParams });
    this.#emitEvent({
      type: 'approval/requested',
      approval: view,
      threadId: extra.threadId ?? this.#threadId ?? undefined,
      turnId: extra.turnId,
      itemId: extra.itemId,
    });
  }

  /** 审批决定 → 各协议方法的应答体（legacy ReviewDecision / v2 *Decision / permissions 响应） */
  #approvalResponseFor(
    method: string,
    decision: ApprovalDecision,
    rawParams: unknown,
  ): { result?: unknown; error?: { code: number; message: string } } {
    switch (method) {
      case 'execCommandApproval':
      case 'applyPatchApproval': {
        // legacy：ReviewDecision = 'approved' | 'approved_for_session' | { denied } | 'abort' | ...
        const legacy =
          decision === 'accept'
            ? 'approved'
            : decision === 'acceptForSession'
              ? 'approved_for_session'
              : decision === 'decline'
                ? { denied: { rejection: '用户拒绝了该操作' } }
                : 'abort';
        return { result: { decision: legacy } };
      }
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        // v2：CommandExecution/FileChangeApprovalDecision 直接同名词
        return { result: { decision } };
      case 'item/permissions/requestApproval': {
        if (decision === 'decline' || decision === 'cancel') {
          return { error: { code: -32000, message: '用户拒绝了权限请求' } };
        }
        // 同意：按请求内容原样授予（我们不扩展权限范围），accept→本回合，acceptForSession→会话
        const req = (isRecord(rawParams) && isRecord(rawParams['permissions']) ? rawParams['permissions'] : {}) as Record<
          string,
          unknown
        >;
        const granted: Record<string, unknown> = {};
        if (req['network'] != null) granted['network'] = req['network'];
        if (req['fileSystem'] != null) granted['fileSystem'] = req['fileSystem'];
        return { result: { permissions: granted, scope: decision === 'acceptForSession' ? 'session' : 'turn' } };
      }
      case 'mcpServer/elicitation/request': {
        // MCP 工具调用确认（schema 为空对象）：accept 表达同意，_meta.persist 表达"本会话内允许"
        if (decision === 'accept' || decision === 'acceptForSession') {
          return {
            result: {
              action: 'accept',
              content: {},
              _meta: decision === 'acceptForSession' ? { persist: 'session' } : null,
            },
          };
        }
        return { result: { action: 'decline', content: null, _meta: null } };
      }
      default:
        return { error: { code: -32601, message: `未知审批方法 ${method}` } };
      }
  }

  // ---------------------------------------------------------------------------
  // 通知投影
  // ---------------------------------------------------------------------------

  #handleNotification(method: string, params: unknown): void {
    try {
      this.#project(method, params);
    } catch (e) {
      // 投影内部异常不使调用方崩溃：降级为 error 事件
      this.#emitEvent({
        type: 'error',
        code: 'internal_error',
        message: `通知 ${method} 投影失败：${errMsg(e)}`,
        recoverable: true,
        threadId: this.#threadId ?? undefined,
      });
    }
  }

  #project(method: string, params: unknown): void {
    const p = isRecord(params) ? params : {};
    switch (method) {
      case 'thread/started': {
        const thread = isRecord(p['thread']) ? p['thread'] : undefined;
        const threadId = thread && typeof thread['id'] === 'string' ? (thread['id'] as string) : undefined;
        if (threadId && threadId === this.#threadId) this.#emitSessionStarted(threadId);
        return;
      }
      case 'thread/tokenUsage/updated': {
        // ThreadTokenUsageUpdatedNotification：total/last 均为 TokenUsageBreakdown——
        // 投影为 usage/updated（total 为线程累计口径），UI 呈现 token 用量
        const tu = isRecord(p['tokenUsage']) ? p['tokenUsage'] : undefined;
        const total = tu && isRecord(tu['total']) ? tu['total'] : undefined;
        const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
        if (total) {
          const ctxWin = tu && typeof tu['modelContextWindow'] === 'number' ? tu['modelContextWindow'] : null;
          this.#emitEvent({
            type: 'usage/updated',
            usage: {
              totalTokens: num(total['totalTokens']),
              inputTokens: num(total['inputTokens']),
              cachedInputTokens: num(total['cachedInputTokens']),
              outputTokens: num(total['outputTokens']),
              reasoningOutputTokens: num(total['reasoningOutputTokens']),
              modelContextWindow: ctxWin,
            },
            threadId: this.#str(p['threadId']) ?? this.#threadId ?? undefined,
            turnId: this.#str(p['turnId']) ?? undefined,
          });
        }
        return;
      }
      case 'thread/status/changed': {
        // ThreadStatus: notLoaded | idle | active | systemError（v2/ThreadStatusChangedNotification）。
        // systemError 是线程级错误：投影 error 事件；连接仍可用，不虚报引擎进程死亡（engine/status 不变）。
        const status = isRecord(p['status']) ? p['status'] : undefined;
        if (status?.['type'] === 'systemError') {
          this.#emitEvent({
            type: 'error',
            code: 'model_failure',
            message: '引擎线程进入 systemError 状态（thread/status/changed），会话不可继续',
            recoverable: false,
            threadId: this.#str(p['threadId']) ?? this.#threadId ?? undefined,
          });
        }
        return;
      }
      case 'turn/started':
        this.#projectTurnStarted(p);
        return;
      case 'turn/completed':
        this.#projectTurnCompleted(p);
        return;
      case 'item/started':
        this.#projectItemStarted(p);
        return;
      case 'item/completed':
        this.#projectItemCompleted(p);
        return;
      case 'item/agentMessage/delta': {
        const threadId = this.#str(p['threadId']);
        const turnId = this.#str(p['turnId']);
        const itemId = this.#str(p['itemId']);
        const delta = this.#str(p['delta']) ?? '';
        if (!itemId) {
          this.#recordUnknown(method, JSON.stringify(params ?? null));
          return;
        }
        this.#emitDelta('message/delta', truncate(delta, PREVIEW_LIMIT), threadId, turnId, itemId);
        return;
      }
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        const threadId = this.#str(p['threadId']);
        const turnId = this.#str(p['turnId']);
        const itemId = this.#str(p['itemId']);
        const delta = this.#str(p['delta']) ?? '';
        this.#emitDelta('reasoning/delta', truncate(delta, PREVIEW_LIMIT), threadId, turnId, itemId);
        return;
      }
      case 'turn/diff/updated': {
        const threadId = this.#str(p['threadId']);
        const turnId = this.#str(p['turnId']);
        const diff = this.#str(p['diff']);
        if (!turnId || diff === undefined) {
          this.#recordUnknown(method, JSON.stringify(params ?? null));
          return;
        }
        const hash = createHash('sha256').update(diff).digest('hex');
        if (this.#lastTurnDiffHash.get(turnId) === hash) return; // 内容未变，不重复投影
        this.#lastTurnDiffHash.set(turnId, hash);
        void this.#emitPatchApplied(threadId, turnId, undefined, diff);
        return;
      }
      case 'item/fileChange/patchUpdated': {
        const threadId = this.#str(p['threadId']);
        const turnId = this.#str(p['turnId']);
        const itemId = this.#str(p['itemId']);
        const changes = Array.isArray(p['changes']) ? p['changes'] : [];
        if (!turnId || changes.length === 0) {
          this.#recordUnknown(method, JSON.stringify(params ?? null));
          return;
        }
        const files: Array<{ path: string; changeType: 'added' | 'modified' | 'deleted' }> = [];
        const diffs: string[] = [];
        const state = this.#turnPatchFiles.get(turnId) ?? new Map<string, 'added' | 'modified' | 'deleted'>();
        this.#turnPatchFiles.set(turnId, state);
        for (const c of changes) {
          if (!isRecord(c)) continue;
          const filePath = this.#str(c['path']);
          const kind = isRecord(c['kind']) ? c['kind']['type'] : undefined;
          if (!filePath || (kind !== 'add' && kind !== 'delete' && kind !== 'update')) continue;
          const changeType = kind === 'add' ? 'added' : kind === 'delete' ? 'deleted' : 'modified';
          state.set(filePath, changeType);
          files.push({ path: filePath, changeType });
          const diff = this.#str(c['diff']);
          if (diff !== undefined) diffs.push(diff);
        }
        if (files.length === 0) {
          this.#recordUnknown(method, JSON.stringify(params ?? null));
          return;
        }
        void this.#emitPatchApplied(threadId, turnId, itemId, diffs.join('\n'), files);
        return;
      }
      case 'error': {
        const threadId = this.#str(p['threadId']);
        const turnId = this.#str(p['turnId']);
        const willRetry = p['willRetry'] === true;
        const err = isRecord(p['error']) ? p['error'] : undefined;
        const message = err && typeof err['message'] === 'string' ? err['message'] : '(服务端错误通知无消息)';
        this.#emitEvent({
          type: 'error',
          code: this.#failureKindFromMessage(message),
          message: truncate(message, PREVIEW_LIMIT),
          recoverable: willRetry,
          threadId,
          turnId,
        });
        return;
      }
      case 'serverRequest/resolved': {
        // 服务端自行解决（如超时）：移除待答条目，不伪造 approval/resolved
        const requestId = p['requestId'];
        if (typeof requestId === 'string' || typeof requestId === 'number') {
          this.#pendingApprovals.delete(String(requestId));
        }
        return;
      }
      default: {
        if (IGNORED_NOTIFICATIONS.has(method)) return;
        this.#recordUnknown(method, JSON.stringify(params ?? null));
      }
    }
  }

  #str(v: unknown): string | undefined {
    return typeof v === 'string' ? v : undefined;
  }

  #failureKindFromMessage(message: string): FailureKind {
    if (/unauthorized|401|auth|login|api.?key|token/i.test(message)) return 'permission_denied';
    if (/connection|network|timeout|timed out|stream|dns|offline|unreachable/i.test(message)) return 'connection_failure';
    return 'model_failure';
  }

  #projectTurnStarted(p: Record<string, unknown>): void {
    const threadId = this.#str(p['threadId']);
    const turn = isRecord(p['turn']) ? p['turn'] : undefined;
    if (!threadId || !turn || typeof turn['id'] !== 'string') {
      this.#recordUnknown('turn/started', JSON.stringify(p));
      return;
    }
    const turnId = turn['id'];
    if (turn['status'] === 'inProgress' || turn['status'] == null) this.#activeTurnId = turnId;
    this.#lastTurnId = turnId;

    // 输入预览：turn.items 中的 userMessage 文本
    let inputPreview = '';
    let userItemId: string | undefined;
    const items = Array.isArray(turn['items']) ? turn['items'] : [];
    for (const item of items) {
      if (!isRecord(item) || item['type'] !== 'userMessage') continue;
      userItemId = typeof item['id'] === 'string' ? (item['id'] as string) : undefined;
      const content = Array.isArray(item['content']) ? item['content'] : [];
      for (const c of content) {
        if (isRecord(c) && c['type'] === 'text' && typeof c['text'] === 'string') {
          inputPreview = c['text'] as string;
          break;
        }
      }
      break;
    }
    this.#emitEvent({
      type: 'turn/started',
      turnId,
      inputPreview: truncate(inputPreview, PREVIEW_LIMIT),
      threadId,
    });
    if (userItemId && !this.#emittedUserMessageIds.has(userItemId)) {
      this.#emittedUserMessageIds.add(userItemId);
      this.#emitEvent({
        type: 'message/created',
        role: 'user',
        text: truncate(inputPreview, PREVIEW_LIMIT),
        threadId,
        turnId,
        itemId: userItemId,
      });
    }
  }

  #projectTurnCompleted(p: Record<string, unknown>): void {
    const threadId = this.#str(p['threadId']);
    const turn = isRecord(p['turn']) ? p['turn'] : undefined;
    if (!threadId || !turn || typeof turn['id'] !== 'string') {
      this.#recordUnknown('turn/completed', JSON.stringify(p));
      return;
    }
    const turnId = turn['id'];
    const rawStatus = turn['status'];
    // 必须检查实际 status：不把失败/中断显示成成功；异常状态一律按失败处理
    let status: TurnCompletionStatus;
    let detail: string | undefined;
    if (rawStatus === 'completed') {
      status = 'success';
    } else if (rawStatus === 'failed') {
      status = 'failure';
    } else if (rawStatus === 'interrupted') {
      status = 'interrupted';
    } else {
      status = 'failure';
      detail = `turn/completed 携带非终态 status=${String(rawStatus)}，按失败处理`;
    }
    const err = isRecord(turn['error']) ? turn['error'] : undefined;
    const errorMessage = err && typeof err['message'] === 'string' ? err['message'] : undefined;
    if (errorMessage) detail = detail ? `${detail}；${errorMessage}` : errorMessage;

    if (this.#activeTurnId === turnId) this.#activeTurnId = null;
    this.#lastTurnId = turnId;
    this.#turnPatchFiles.delete(turnId);
    this.#lastTurnDiffHash.delete(turnId);

    this.#emitEvent({ type: 'turn/completed', turnId, status, detail, threadId });
  }

  #projectItemStarted(p: Record<string, unknown>): void {
    const threadId = this.#str(p['threadId']);
    const turnId = this.#str(p['turnId']);
    const item = isRecord(p['item']) ? p['item'] : undefined;
    if (!item) {
      this.#recordUnknown('item/started', JSON.stringify(p));
      return;
    }
    const itemId = typeof item['id'] === 'string' ? (item['id'] as string) : undefined;
    const type = item['type'];
    switch (type) {
      case 'userMessage': {
        let text = '';
        const content = Array.isArray(item['content']) ? item['content'] : [];
        for (const c of content) {
          if (isRecord(c) && c['type'] === 'text' && typeof c['text'] === 'string') {
            text = c['text'] as string;
            break;
          }
        }
        if (itemId && !this.#emittedUserMessageIds.has(itemId)) {
          this.#emittedUserMessageIds.add(itemId);
          this.#emitEvent({
            type: 'message/created',
            role: 'user',
            text: truncate(text, PREVIEW_LIMIT),
            threadId,
            turnId,
            itemId,
          });
        }
        return;
      }
      case 'agentMessage': {
        const text = typeof item['text'] === 'string' ? (item['text'] as string) : '';
        this.#emitEvent({
          type: 'message/created',
          role: 'assistant',
          text: truncate(text, PREVIEW_LIMIT),
          threadId,
          turnId,
          itemId,
        });
        return;
      }
      case 'commandExecution': {
        const command = typeof item['command'] === 'string' ? (item['command'] as string) : '';
        this.#emitEvent({
          type: 'tool/called',
          callId: itemId ?? '(no-id)',
          tool: 'commandExecution',
          argsPreview: truncate(command, PREVIEW_LIMIT),
          threadId,
          turnId,
          itemId,
        });
        return;
      }
      case 'fileChange': {
        const changes = Array.isArray(item['changes']) ? item['changes'] : [];
        const summary = changes
          .map((c) => (isRecord(c) && typeof c['path'] === 'string' ? (c['path'] as string) : '(未知路径)'))
          .join('、');
        this.#emitEvent({
          type: 'tool/called',
          callId: itemId ?? '(no-id)',
          tool: 'fileChange',
          argsPreview: truncate(`修改文件：${summary || '(未提供清单)'}`, PREVIEW_LIMIT),
          threadId,
          turnId,
          itemId,
        });
        return;
      }
      case 'mcpToolCall': {
        const server = typeof item['server'] === 'string' ? (item['server'] as string) : 'unknown-server';
        const tool = typeof item['tool'] === 'string' ? (item['tool'] as string) : 'unknown-tool';
        this.#emitEvent({
          type: 'tool/called',
          callId: itemId ?? '(no-id)',
          tool: `${server}/${tool}`,
          argsPreview: truncate(this.#safeJson(item['arguments']), PREVIEW_LIMIT),
          threadId,
          turnId,
          itemId,
        });
        return;
      }
      case 'dynamicToolCall': {
        const tool = typeof item['tool'] === 'string' ? (item['tool'] as string) : 'unknown-tool';
        this.#emitEvent({
          type: 'tool/called',
          callId: itemId ?? '(no-id)',
          tool,
          argsPreview: truncate(this.#safeJson(item['arguments']), PREVIEW_LIMIT),
          threadId,
          turnId,
          itemId,
        });
        return;
      }
      case 'webSearch': {
        const query = typeof item['query'] === 'string' ? (item['query'] as string) : '';
        this.#emitEvent({
          type: 'tool/called',
          callId: itemId ?? '(no-id)',
          tool: 'webSearch',
          argsPreview: truncate(query, PREVIEW_LIMIT),
          threadId,
          turnId,
          itemId,
        });
        return;
      }
      default:
        // reasoning / plan / 其他 item 类型：已知通知，首发不投影
        return;
    }
  }

  #projectItemCompleted(p: Record<string, unknown>): void {
    const threadId = this.#str(p['threadId']);
    const turnId = this.#str(p['turnId']);
    const item = isRecord(p['item']) ? p['item'] : undefined;
    if (!item) {
      this.#recordUnknown('item/completed', JSON.stringify(p));
      return;
    }
    const itemId = typeof item['id'] === 'string' ? (item['id'] as string) : undefined;
    const type = item['type'];
    switch (type) {
      case 'commandExecution': {
        const status = item['status'];
        const exitCode = typeof item['exitCode'] === 'number' ? item['exitCode'] : null;
        const output = typeof item['aggregatedOutput'] === 'string' ? (item['aggregatedOutput'] as string) : '';
        const isError = status === 'failed' || status === 'declined' || (exitCode !== null && exitCode !== 0);
        const suffix = exitCode !== null ? `（exitCode=${exitCode}）` : '';
        this.#emitEvent({
          type: 'tool/output',
          callId: itemId ?? '(no-id)',
          outputPreview: truncate(output + suffix, PREVIEW_LIMIT),
          isError,
          threadId,
          turnId,
          itemId,
        });
        return;
      }
      case 'fileChange': {
        const status = item['status'];
        const isError = status === 'failed' || status === 'declined';
        this.#emitEvent({
          type: 'tool/output',
          callId: itemId ?? '(no-id)',
          outputPreview: truncate(`fileChange status=${String(status ?? '')}`, PREVIEW_LIMIT),
          isError,
          threadId,
          turnId,
          itemId,
        });
        return;
      }
      case 'mcpToolCall': {
        const isError = item['error'] != null || item['status'] === 'failed';
        this.#emitEvent({
          type: 'tool/output',
          callId: itemId ?? '(no-id)',
          outputPreview: truncate(this.#safeJson(item['result'] ?? item['error']), PREVIEW_LIMIT),
          isError,
          threadId,
          turnId,
          itemId,
        });
        return;
      }
      case 'dynamicToolCall': {
        const isError = item['success'] === false || item['status'] === 'failed';
        this.#emitEvent({
          type: 'tool/output',
          callId: itemId ?? '(no-id)',
          outputPreview: truncate(this.#safeJson(item['contentItems'] ?? item['status']), PREVIEW_LIMIT),
          isError,
          threadId,
          turnId,
          itemId,
        });
        return;
      }
      case 'functionCallOutput': {
        this.#emitEvent({
          type: 'tool/output',
          callId: itemId ?? '(no-id)',
          outputPreview: truncate(this.#safeJson(item['output']), PREVIEW_LIMIT),
          isError: false,
          threadId,
          turnId,
          itemId,
        });
        return;
      }
      case 'agentMessage':
      case 'userMessage':
      default:
        return;
    }
  }

  #safeJson(v: unknown): string {
    if (typeof v === 'string') return v;
    try {
      return JSON.stringify(v) ?? '';
    } catch {
      return '';
    }
  }

  #emitSessionStarted(threadId: string): void {
    const key = `${this.#generation}:${threadId}`;
    if (this.#sessionAnnounced.has(key)) return;
    this.#sessionAnnounced.add(key);
    this.#emitEvent({ type: 'session/started', threadId });
  }

  /** patch 全文落盘 → patch/applied 事件（patchRef 引用落盘文件） */
  async #emitPatchApplied(
    threadId: string | undefined,
    turnId: string,
    itemId: string | undefined,
    diff: string,
    explicitFiles?: Array<{ path: string; changeType: 'added' | 'modified' | 'deleted' }>,
  ): Promise<void> {
    const files =
      explicitFiles ??
      ((): Array<{ path: string; changeType: 'added' | 'modified' | 'deleted' }> => {
        const state = this.#turnPatchFiles.get(turnId);
        if (state && state.size > 0) {
          return Array.from(state.entries()).map(([path, changeType]) => ({ path, changeType }));
        }
        return parseUnifiedDiffFiles(diff);
      })();
    const patchRef = `patch-g${this.#generation}-${++this.#patchCounter}`;
    try {
      const dir = path.join(this.#options.storageDir, 'patches');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `${patchRef}.patch`), diff, 'utf8');
    } catch (e) {
      // 落盘失败不伪造 patchRef：发可恢复错误事件，跳过本次 patch/applied
      this.#emitEvent({
        type: 'error',
        code: 'internal_error',
        message: `补丁全文落盘失败：${errMsg(e)}`,
        recoverable: true,
        threadId,
        turnId,
        itemId,
      });
      return;
    }
    const stats = diffStats(diff);
    this.#emitEvent({
      type: 'patch/applied',
      files,
      patchRef,
      additions: stats.additions,
      deletions: stats.deletions,
      threadId,
      turnId,
      itemId,
    });
  }

  /** 未知事件限量记录：最多 100 条样本，超出只计丢弃数；method 名另存环形样本供诊断导出 */
  #recordUnknown(method: string, sample: string): void {
    const names = this.#unknownMethodNames;
    if (!names.includes(method)) {
      names.push(method);
      if (names.length > UNKNOWN_METHOD_NAME_LIMIT) names.shift();
    }
    if (this.#unknownSamples < UNKNOWN_EVENT_SAMPLE_LIMIT) {
      this.#unknownSamples += 1;
      this.#emitEvent({
        type: 'unknown-event',
        method,
        samplePreview: truncate(sample, PREVIEW_LIMIT),
        threadId: this.#threadId ?? undefined,
      });
    } else {
      this.#unknownDropped += 1;
    }
  }

  #resetSessionState(): void {
    this.#threadId = null;
    this.#activeTurnId = null;
    this.#lastTurnId = null;
    this.#serverInfo = null;
    this.#emittedUserMessageIds.clear();
    this.#turnPatchFiles.clear();
    this.#lastTurnDiffHash.clear();
    this.#unknownSamples = 0;
    this.#unknownDropped = 0;
  }

  #setStatus(next: EngineStatus, detail?: string): void {
    if (this.#status === next) return;
    this.#status = next;
    this.#emitEvent({
      type: 'engine/status',
      status: next,
      detail,
      threadId: this.#threadId ?? undefined,
    });
  }

  #emitEvent(e: ProjectedEvent): EngineEvent {
    const event = {
      ...e,
      seq: ++this.#seqCounter,
      connectionGeneration: this.#generation,
      emittedAt: new Date().toISOString() as Timestamp,
    } as EngineEvent;
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        /* 消费方异常不中断投影 */
      }
    }
    return event;
  }

  /** 增量事件：先逐条进 subscribe 流（不丢失），再可选进入 onBatchedDelta 批缓冲 */
  #emitDelta(kind: 'message/delta' | 'reasoning/delta', delta: string, threadId: string | undefined, turnId: string | undefined, itemId: string | undefined): void {
    const event = this.#emitEvent({ type: kind, delta, threadId, turnId, itemId });
    if (!this.#options.onBatchedDelta) return;
    this.#deltaBuffer.push(event);
    if (this.#deltaFlushTimer == null) {
      this.#deltaFlushTimer = setTimeout(() => this.#flushDeltaBatch(), this.#options.deltaBatchMs ?? DEFAULT_DELTA_BATCH_MS);
    }
  }

  /** 冲刷增量批：按 类型+itemId 合并文本后交给 onBatchedDelta（消费方异常不中断投影） */
  #flushDeltaBatch(): void {
    this.#deltaFlushTimer = null;
    const buffered = this.#deltaBuffer;
    this.#deltaBuffer = [];
    const callback = this.#options.onBatchedDelta;
    if (buffered.length === 0 || !callback) return;
    const merged = new Map<string, DeltaBatchItem>();
    for (const ev of buffered) {
      if (ev.type !== 'message/delta' && ev.type !== 'reasoning/delta') continue;
      const key = `${ev.type}:${ev.itemId ?? ''}`;
      const entry: DeltaBatchItem =
        merged.get(key) ?? {
          kind: ev.type === 'message/delta' ? 'message' : 'reasoning',
          itemId: ev.itemId ?? '',
          text: '',
          threadId: ev.threadId,
          turnId: ev.turnId,
        };
      entry.text += ev.delta;
      merged.set(key, entry);
    }
    try {
      callback([...merged.values()]);
    } catch {
      /* 消费方回调异常不中断投影 */
    }
  }
}
