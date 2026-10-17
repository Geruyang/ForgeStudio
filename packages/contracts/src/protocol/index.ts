/**
 * Codex app-server 协议最小公共层。
 *
 * 说明：完整协议类型计划由锁定版本 CLI 的
 *   `codex app-server generate-ts --out <dir>` 生成到
 *   packages/contracts/src/protocol/codex/（生成代码，不手改）。
 * 本文件只冻结 engine-adapter 必须理解的最小信封与方法名，
 * 保证在生成类型缺失时适配层仍可编译；未列出的方法按未知事件处理。
 * 冻结契约 v1 —— 集成负责人维护。
 */

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 信封（stdio JSONL 每行一个）
// ---------------------------------------------------------------------------

export const JSONRPC_VERSION = '2.0' as const;

export type RpcId = number | string;

export interface RpcRequest<P = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  id?: RpcId; // 缺省为 notification
  method: string;
  params?: P;
}

export interface RpcSuccess<R = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RpcId;
  result: R;
}

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcFailure {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RpcId;
  error: RpcErrorObject;
}

export type RpcMessage = RpcRequest | RpcSuccess | RpcFailure;

// ---------------------------------------------------------------------------
// 客户端 → 服务端 方法（本产品实际使用集）
// ---------------------------------------------------------------------------

export const CLIENT_METHODS = {
  initialize: 'initialize',
  initialized: 'initialized',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  /** 会话重命名（Z1-5；ThreadSetNameParams: { threadId, name }） */
  threadNameSet: 'thread/name/set',
  /** 会话删除（Z1-5；ThreadDeleteParams: { threadId }） */
  threadDelete: 'thread/delete',
  /** 上下文压缩（Z1-5；ThreadCompactStartParams: { threadId }，完成以 thread/compacted 通知为准） */
  threadCompactStart: 'thread/compact/start',
  turnStart: 'turn/start',
  turnSteer: 'turn/steer',
  turnInterrupt: 'turn/interrupt',
  approvalRespond: 'approval/respond', // 以锁定版本 --help / 生成类型复核后的实际名为准
  modelList: 'model/list',
  authStatus: 'getAuthStatus',
} as const;
export type ClientMethod = (typeof CLIENT_METHODS)[keyof typeof CLIENT_METHODS];

/** initialize 请求的 clientInfo：自有身份，不冒充官方客户端 */
export interface ClientInfo {
  name: 'forgedesktop';
  version: string;
}

export interface InitializeParams {
  clientInfo: ClientInfo;
  /** 默认不启用 capabilities.experimentalApi */
  capabilities?: Record<string, never>;
}

// ---------------------------------------------------------------------------
// 服务端 → 客户端 方法/通知（本产品消费集；其余进 unknown-event 限量记录）
// ---------------------------------------------------------------------------

export const SERVER_METHODS = {
  turnCompleted: 'turn/completed',
  // 审批类请求（带 id，必须应答；具体名称以锁定版本生成类型为准）
  execCommandApproval: 'execCommandApproval',
  applyPatchApproval: 'applyPatchApproval',
} as const;
export type ServerMethod = (typeof SERVER_METHODS)[keyof typeof SERVER_METHODS];

/** 审批应答（同 requestId） */
export interface ApprovalResponse {
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel';
}
