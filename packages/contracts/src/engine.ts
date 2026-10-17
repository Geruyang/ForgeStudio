/**
 * ForgeDesk 引擎契约：EngineAdapter 接口与事件投影。
 * engine-adapter 负责 Codex app-server stdio JSONL 的实际接入；
 * 主进程与 renderer 只消费本文件定义的投影事件，不接触原始协议。
 * 冻结契约 v1 —— 集成负责人维护。
 */
import type { FailureKind, Sha256, Timestamp } from './common.ts';

// ---------------------------------------------------------------------------
// EngineAdapter（主进程持有的唯一引擎入口；renderer 经 IPC 白名单调用）
// ---------------------------------------------------------------------------

export type EngineStatus =
  | 'stopped' // 未启动
  | 'starting' // 子进程启动、初始化中
  | 'ready' // 握手完成，可会话
  | 'auth_required' // 需要登录/凭证
  | 'error' // 不可用（附 detail）
  | 'stopping';

/** 引擎连接代次：每次子进程启动 +1；审批/待办按代次配对 */
export type ConnectionGeneration = number;

export interface EngineStartOptions {
  projectRoot: string;
  /** 覆盖 model/list 选择的模型 ID */
  model?: string;
  /** 恢复既有线程 */
  resumeThreadId?: string;
}

export interface EngineModelInfo {
  id: string;
  displayName?: string;
}

export interface AuthStatusInfo {
  mode: 'api_key' | 'chatgpt_account' | 'none';
  /** 供 UI 展示的说明，不含令牌本身 */
  accountHint?: string;
  ok: boolean;
}

/** 审批选项（只提供锁定版本请求中允许的选项） */
export type ApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel';

export interface ApprovalRequestView {
  /** 协议请求 ID：应答必须带回同一 ID */
  requestId: string;
  connectionGeneration: ConnectionGeneration;
  kind: 'exec_command' | 'apply_patch' | 'mcp_tool' | 'other';
  /** 人可读摘要（命令/补丁预览） */
  summary: string;
  /** 允许的选项 */
  options: ApprovalDecision[];
  detail?: unknown;
}

export interface SteerResult {
  delivered: boolean;
  /** false：回合已结束或 ID 不匹配；输入保留由用户发到新回合 */
  reason?: 'turn_ended' | 'id_mismatch' | 'not_running';
}

export interface EngineAdapter {
  /** 启动 app-server 子进程并完成 initialize/initialized */
  start(options: EngineStartOptions): Promise<{ threadId: string; generation: number }>;
  /** 发起新回合 */
  send(text: string): Promise<{ turnId: string }>;
  /** 执行中追加指令；绑定当前 expectedTurnId，失败不静默重发 */
  steer(text: string): Promise<SteerResult>;
  /** 取消当前回合（turn/interrupt）：仅请求，等待终态事件 */
  interrupt(): Promise<void>;
  /** 应答服务端审批请求（同 requestId、同代次） */
  approve(requestId: string, decision: ApprovalDecision): Promise<void>;
  /** 模型列表（真实 model/list 返回） */
  listModels(): Promise<EngineModelInfo[]>;
  /** 认证状态 */
  authStatus(): Promise<AuthStatusInfo>;
  /**
   * 会话重命名（引擎侧同步，best-effort；Z1-5）。仅当引擎就绪且 threadId 为当前线程时下发
   * thread/name/set，否则静默跳过——持久化由 SessionStore.renameThread 负责（对历史会话同样有效）。
   */
  renameThread(threadId: string, name: string): Promise<void>;
  /**
   * 会话删除（引擎侧同步，best-effort；Z1-5）。仅当前线程时下发 thread/delete；
   * 本地会话文件清理由 SessionStore.deleteThread 负责。
   */
  deleteThread(threadId: string): Promise<void>;
  /**
   * 代码审阅（Z2B-2 预留）：当前线程内 inline 启动 review/start；审阅项以事件流回流，
   * 完整审阅面板（独立视图/decision 应答 UI）待后续——接口先行保证引擎能力就绪。
   */
  startReview(): Promise<void>;
  /**
   * 上下文压缩（Z1-5）：下发 thread/compact/start；完成以 session/compacted 事件
   * （thread/compacted 通知投影）为准，本方法返回仅代表请求受理。
   */
  compactThread(threadId: string): Promise<void>;
  /** 结束进程；先取消活动回合 */
  dispose(): Promise<void>;
  /** 事件订阅 */
  subscribe(listener: (event: EngineEvent) => void): () => void;
  /** 当前代次 */
  readonly generation: ConnectionGeneration;
  /** 当前状态 */
  readonly status: EngineStatus;
}

// ---------------------------------------------------------------------------
// EngineEvent —— 引擎原始事件到产品事件的一次投影
// ---------------------------------------------------------------------------

export const ENGINE_EVENT_TYPES = [
  'engine/status',
  'session/started',
  'session/compacted',
  'turn/started',
  'turn/completed',
  'usage/updated',
  'message/created',
  'message/delta',
  'reasoning/delta',
  'tool/called',
  'tool/output',
  'patch/applied',
  'approval/requested',
  'approval/resolved',
  'error',
  'unknown-event',
] as const;
export type EngineEventType = (typeof ENGINE_EVENT_TYPES)[number];

/** 事件基础字段：按序持久化，重连缺口标 incomplete，不伪造缺失消息 */
export interface EngineEventBase {
  /** 本产品事件序号（按接收顺序严格递增） */
  seq: number;
  connectionGeneration: ConnectionGeneration;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  emittedAt: Timestamp;
}

export type TurnCompletionStatus = 'success' | 'failure' | 'interrupted';

/** Token 用量（thread/tokenUsage/updated 投影；数字均为累计口径） */
export interface TokenUsageSummary {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  /** 模型上下文窗口（未知为 null） */
  modelContextWindow: number | null;
}

export type EngineEvent =
  | (EngineEventBase & { type: 'engine/status'; status: EngineStatus; detail?: string })
  | (EngineEventBase & { type: 'session/started'; threadId: string })
  | (EngineEventBase & { type: 'session/compacted'; threadId: string })
  | (EngineEventBase & { type: 'turn/started'; turnId: string; inputPreview: string })
  | (EngineEventBase & {
      type: 'turn/completed';
      turnId: string;
      status: TurnCompletionStatus; // turn/completed 事件名之外必须检查实际 status
      detail?: string;
    })
  | (EngineEventBase & { type: 'usage/updated'; usage: TokenUsageSummary })
  | (EngineEventBase & { type: 'message/created'; role: 'assistant' | 'user'; text?: string })
  | (EngineEventBase & { type: 'message/delta'; delta: string })
  | (EngineEventBase & { type: 'reasoning/delta'; delta: string })
  | (EngineEventBase & {
      type: 'tool/called';
      callId: string;
      tool: string;
      /** 截断后的参数预览（不无限膨胀上下文） */
      argsPreview: string;
    })
  | (EngineEventBase & {
      type: 'tool/output';
      callId: string;
      /** 截断后的输出预览 */
      outputPreview: string;
      isError: boolean;
    })
  | (EngineEventBase & {
      type: 'patch/applied';
      /** 变更文件清单 */
      files: Array<{ path: string; changeType: 'added' | 'modified' | 'deleted' }>;
      /** 差异摘要引用（完整 patch 存储后的引用 ID） */
      patchRef: string;
      additions?: number;
      deletions?: number;
    })
  | (EngineEventBase & { type: 'approval/requested'; approval: ApprovalRequestView })
  | (EngineEventBase & { type: 'approval/resolved'; requestId: string; decision: ApprovalDecision })
  | (EngineEventBase & { type: 'error'; code: FailureKind; message: string; recoverable: boolean })
  /** 未知事件限量记录（上限条数由适配层实现，不使窗口崩溃） */
  | (EngineEventBase & { type: 'unknown-event'; method: string; samplePreview: string });

// ---------------------------------------------------------------------------
// 会话持久化投影（自有事件存储；启动时恢复视图）
// ---------------------------------------------------------------------------

export interface ThreadSummary {
  threadId: string;
  projectRoot: string;
  title: string;
  lastActivityAt: Timestamp;
  /** 历史是否完整（重连缺口时为 false） */
  complete: boolean;
  /** 消息数（自有事件存储计数） */
  messageCount: number;
}

/** 一条已落盘的渲染用消息（恢复视图用） */
export interface StoredMessage {
  seq: number;
  threadId: string;
  turnId?: string;
  role: 'user' | 'assistant';
  /** delta 合并后的最终文本 */
  text: string;
  /** 该消息内的工具调用摘要 */
  toolCalls?: Array<{ callId: string; tool: string; preview: string; isError: boolean }>;
  /** 该回合内的补丁引用 */
  patchRefs?: string[];
  createdAt: Timestamp;
}
