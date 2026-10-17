﻿﻿﻿﻿/**
 * 引擎事件投影（纯函数）：EngineEvent 流 → 对话流 UI 状态。
 * - message/reasoning delta 合并进"当前助手消息"，由调用方按帧/时间窗批量应用；
 * - 未知事件只记有限样本，计数不设限（洪峰不崩）；
 * - "通过"等业务判定不在此层（由 contracts computeTaskAcceptance 驱动）。
 */
import type {
  ApprovalDecision,
  ApprovalRequestView,
  EngineEvent,
  StoredMessage,
} from '../contracts/engine';
import type { FailureKind } from '../contracts/common';

export const DEFAULT_MAX_UNKNOWN_SAMPLES = 8;

export interface ToolCallView {
  callId: string;
  tool: string;
  argsPreview: string;
  outputPreview?: string;
  isError?: boolean;
}

export interface PatchView {
  patchRef: string;
  files: Array<{ path: string; changeType: 'added' | 'modified' | 'deleted' }>;
  additions?: number;
  deletions?: number;
}

export interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  /** steer 追加指令与普通发送在 UI 上区分展示 */
  kind?: 'send' | 'steer';
  text: string;
  reasoning?: string;
  toolCalls: ToolCallView[];
  patches: PatchView[];
  streaming: boolean;
  turnId?: string;
  at: string;
}

export interface ErrorEventView {
  id: string;
  kind: FailureKind;
  message: string;
  recoverable: boolean;
}

export interface ApprovalView {
  approval: ApprovalRequestView;
  resolved: boolean;
  decision?: ApprovalDecision;
}

export interface ConversationState {
  messages: UiMessage[];
  approvals: ApprovalView[];
  errors: ErrorEventView[];
  unknownCount: number;
  unknownSamples: Array<{ method: string; samplePreview: string }>;
  currentTurnId: string | null;
  turnStatus: 'running' | 'success' | 'failure' | 'interrupted' | null;
  turnDetail: string | null;
}

export function emptyConversation(): ConversationState {
  return {
    messages: [],
    approvals: [],
    errors: [],
    unknownCount: 0,
    unknownSamples: [],
    currentTurnId: null,
    turnStatus: null,
    turnDetail: null,
  };
}

/** 确保末尾存在助手消息（克隆末尾，保证不可变更新） */
function ensureAssistantTail(
  state: ConversationState,
  seq: number,
  itemId: string | undefined,
  turnId: string | undefined,
  emittedAt: string,
): ConversationState {
  const last = state.messages[state.messages.length - 1];
  if (last && last.role === 'assistant') {
    const tail = { ...last };
    return { ...state, messages: [...state.messages.slice(0, -1), tail] };
  }
  const msg: UiMessage = {
    id: itemId ?? `assistant-${seq}`,
    role: 'assistant',
    text: '',
    toolCalls: [],
    patches: [],
    streaming: true,
    turnId,
    at: emittedAt,
  };
  return { ...state, messages: [...state.messages, msg] };
}

function appendDelta(
  state: ConversationState,
  event: EngineEvent & { delta: string },
  field: 'text' | 'reasoning',
): ConversationState {
  const withTail = ensureAssistantTail(state, event.seq, event.itemId, event.turnId, event.emittedAt);
  const messages = withTail.messages;
  const last = messages[messages.length - 1];
  const updated: UiMessage =
    field === 'text'
      ? { ...last, text: last.text + event.delta, streaming: true }
      : { ...last, reasoning: (last.reasoning ?? '') + event.delta, streaming: true };
  return { ...withTail, messages: [...messages.slice(0, -1), updated] };
}

/**
 * 引擎事件 → 对话状态（唯一投影入口，纯函数，供 store 与测试共用）。
 * engine/status 不在此处理（store 层直接消费）。
 */
export function applyEngineEventToConversation(
  state: ConversationState,
  event: EngineEvent,
  maxUnknownSamples: number = DEFAULT_MAX_UNKNOWN_SAMPLES,
): ConversationState {
  switch (event.type) {
    case 'engine/status':
      return state;
    case 'session/started':
      return state;
    case 'session/compacted':
      // 压缩完成提示走 store 层 terminal；不改变会话消息流（历史已由引擎摘要化，重载后为压缩视图）
      return state;
    case 'usage/updated':
      // token 用量由 store 层 AppState 持有（非会话消息流），此处直接跳过不进样本
      return state;
    case 'turn/started':
      return { ...state, currentTurnId: event.turnId, turnStatus: 'running', turnDetail: null };
    case 'turn/completed':
      return {
        ...state,
        currentTurnId: event.turnId,
        turnStatus: event.status,
        turnDetail: event.detail ?? null,
        messages: state.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
      };
    case 'message/created': {
      if (event.role === 'user') {
        const text = event.text ?? '';
        const idx = state.messages.findIndex(
          (m) => m.role === 'user' && ((event.turnId && m.turnId === event.turnId) || m.id === event.itemId),
        );
        if (idx >= 0) {
          const messages = [...state.messages];
          messages[idx] = { ...messages[idx], text: text || messages[idx].text, streaming: false };
          return { ...state, messages };
        }
        const msg: UiMessage = {
          id: event.itemId ?? `user-${event.seq}`,
          role: 'user',
          kind: 'send',
          text,
          toolCalls: [],
          patches: [],
          streaming: false,
          turnId: event.turnId,
          at: event.emittedAt,
        };
        return { ...state, messages: [...state.messages, msg] };
      }
      // assistant
      const existing = state.messages.findIndex((m) => m.id === event.itemId);
      if (existing >= 0) {
        const messages = [...state.messages];
        messages[existing] = { ...messages[existing], text: event.text ?? messages[existing].text };
        return { ...state, messages };
      }
      const msg: UiMessage = {
        id: event.itemId ?? `assistant-${event.seq}`,
        role: 'assistant',
        text: event.text ?? '',
        toolCalls: [],
        patches: [],
        streaming: true,
        turnId: event.turnId,
        at: event.emittedAt,
      };
      return { ...state, messages: [...state.messages, msg] };
    }
    case 'message/delta':
      return appendDelta(state, event, 'text');
    case 'reasoning/delta':
      return appendDelta(state, event, 'reasoning');
    case 'tool/called': {
      const withTail = ensureAssistantTail(state, event.seq, event.itemId, event.turnId, event.emittedAt);
      const messages = withTail.messages;
      const last = messages[messages.length - 1];
      const call: ToolCallView = { callId: event.callId, tool: event.tool, argsPreview: event.argsPreview };
      const updated = { ...last, toolCalls: [...last.toolCalls, call] };
      return { ...withTail, messages: [...messages.slice(0, -1), updated] };
    }
    case 'tool/output': {
      const messages = state.messages.map((m) => {
        const idx = m.toolCalls.findIndex((c) => c.callId === event.callId);
        if (idx < 0) return m;
        const toolCalls = [...m.toolCalls];
        toolCalls[idx] = { ...toolCalls[idx], outputPreview: event.outputPreview, isError: event.isError };
        return { ...m, toolCalls };
      });
      return { ...state, messages };
    }
    case 'patch/applied': {
      const withTail = ensureAssistantTail(state, event.seq, event.itemId, event.turnId, event.emittedAt);
      const messages = withTail.messages;
      const last = messages[messages.length - 1];
      const patch: PatchView = {
        patchRef: event.patchRef,
        files: event.files,
        additions: event.additions,
        deletions: event.deletions,
      };
      const updated = { ...last, patches: [...last.patches, patch] };
      return { ...withTail, messages: [...messages.slice(0, -1), updated] };
    }
    case 'approval/requested': {
      if (state.approvals.some((a) => a.approval.requestId === event.approval.requestId)) {
        return state;
      }
      return { ...state, approvals: [...state.approvals, { approval: event.approval, resolved: false }] };
    }
    case 'approval/resolved': {
      const approvals = state.approvals.map((a) =>
        a.approval.requestId === event.requestId ? { ...a, resolved: true, decision: event.decision } : a,
      );
      return { ...state, approvals };
    }
    case 'error': {
      const err: ErrorEventView = {
        id: `err-${event.seq}`,
        kind: event.code,
        message: event.message,
        recoverable: event.recoverable,
      };
      return { ...state, errors: [...state.errors, err] };
    }
    case 'unknown-event': {
      const samples =
        state.unknownSamples.length < maxUnknownSamples
          ? [...state.unknownSamples, { method: event.method, samplePreview: event.samplePreview }]
          : state.unknownSamples;
      return { ...state, unknownCount: state.unknownCount + 1, unknownSamples: samples };
    }
    default:
      return state;
  }
}

/** 恢复视图：StoredMessage[]（已落盘的合并结果）→ 对话状态 */
export function storedToConversation(messages: StoredMessage[]): ConversationState {
  const state = emptyConversation();
  const sorted = [...messages].sort((a, b) => a.seq - b.seq);
  state.messages = sorted.map((m) => ({
    id: `stored-${m.seq}`,
    role: m.role,
    kind: 'send' as const,
    text: m.text,
    toolCalls: (m.toolCalls ?? []).map((tc) => ({
      callId: tc.callId,
      tool: tc.tool,
      argsPreview: tc.preview,
      outputPreview: tc.preview,
      isError: tc.isError,
    })),
    patches: (m.patchRefs ?? []).map((patchRef) => ({ patchRef, files: [] as PatchView['files'] })),
    streaming: false,
    turnId: m.turnId,
    at: m.createdAt,
  }));
  return state;
}

/** steer 送达后，把追加指令作为用户消息显示（真实送达才调用） */
export function appendSteerMessage(state: ConversationState, text: string, at: string): ConversationState {
  const msg: UiMessage = {
    id: `steer-${state.messages.length}-${at}`,
    role: 'user',
    kind: 'steer',
    text,
    toolCalls: [],
    patches: [],
    streaming: false,
    at,
  };
  return { ...state, messages: [...state.messages, msg] };
}

// ---------------------------------------------------------------------------
// 事件批量器：delta/事件洪峰按帧（rAF）或 ~50ms 时间窗合并渲染
// ---------------------------------------------------------------------------

export interface BatcherOptions<T = unknown> {
  /** 无 requestAnimationFrame 时的回退窗口（毫秒），默认 50 */
  intervalMs?: number;
  /**
   * 队列上限：达到后按丢弃策略腾位（默认 500）。
   * 有可丢弃项时淘汰最旧的中间投影并计数；无可丢弃项时立即整体冲刷——
   * 审批请求、回合终态等关键事件永不丢弃（任务书 §7）。
   */
  maxQueue?: number;
  /** 判定是否为可替代的 UI 中间投影（洪峰下可淘汰并计数） */
  isDroppable?: (item: T) => boolean;
  /** 每淘汰一条中间投影调用一次（累计丢弃计数由调用方维护） */
  onDropped?: (item: T) => void;
  /** 调度器可注入（测试用）；默认 rAF，缺省回退 setTimeout(intervalMs) */
  schedule?: (fn: () => void) => () => void;
  now?: () => number;
}

/**
 * 可替代的 UI 中间投影：流式 delta 与未知事件样本。
 * 最终文本由 turn 末尾的 message/created 终值替代，洪峰下可丢弃；
 * approval/*、turn/completed、patch/applied、error 等关键事件不在其中。
 */
export function isDroppableEngineEvent(event: EngineEvent): boolean {
  return event.type === 'message/delta' || event.type === 'reasoning/delta' || event.type === 'unknown-event';
}

export function defaultBatcherSchedule(intervalMs: number): (fn: () => void) => () => void {
  return (fn: () => void) => {
    if (typeof requestAnimationFrame === 'function') {
      const id = requestAnimationFrame(fn);
      return () => cancelAnimationFrame(id);
    }
    const id = setTimeout(fn, intervalMs);
    return () => clearTimeout(id);
  };
}

export class EventBatcher<T> {
  private queue: T[] = [];
  private cancel: (() => void) | null = null;
  private readonly intervalMs: number;
  private maxQueue: number;
  private readonly scheduleFn: (fn: () => void) => () => void;
  private readonly nowFn: () => number;
  private readonly droppable: ((item: T) => boolean) | null;
  private readonly onDropped: ((item: T) => void) | null;

  constructor(private readonly flush: (items: T[]) => void, options: BatcherOptions<T> = {}) {
    this.intervalMs = options.intervalMs ?? 50;
    this.maxQueue = options.maxQueue ?? 500;
    this.scheduleFn = options.schedule ?? defaultBatcherSchedule(this.intervalMs);
    this.nowFn = options.now ?? (() => Date.now());
    this.droppable = options.isDroppable ?? null;
    this.onDropped = options.onDropped ?? null;
  }

  push(item: T): void {
    if (this.queue.length >= this.maxQueue) {
      if (!this.makeRoom()) {
        // 没有可丢弃项：整体冲刷做背压，绝不丢关键事件
        this.doFlush();
      }
    }
    this.queue.push(item);
    if (this.queue.length === 1) {
      this.cancel = this.scheduleFn(() => {
        this.cancel = null;
        this.doFlush();
      });
    }
  }

  /** 淘汰最旧的可替代中间投影；无可淘汰项返回 false */
  private makeRoom(): boolean {
    if (!this.droppable) return false;
    const idx = this.queue.findIndex((i) => this.droppable!(i));
    if (idx < 0) return false;
    const [evicted] = this.queue.splice(idx, 1);
    this.onDropped?.(evicted);
    return true;
  }

  /** 运行期调整队列上限（设置中的 maxRendererEventQueue 加载后同步） */
  setMaxQueue(max: number): void {
    if (Number.isFinite(max) && max > 0) this.maxQueue = Math.floor(max);
  }

  /** 立即冲刷（销毁前调用，保证不丢事件） */
  flushPending(): void {
    if (this.cancel) {
      this.cancel();
      this.cancel = null;
    }
    this.doFlush();
  }

  private doFlush(): void {
    if (this.queue.length === 0) return;
    const items = this.queue;
    this.queue = [];
    this.flush(items);
  }

  dispose(): void {
    if (this.cancel) {
      this.cancel();
      this.cancel = null;
    }
    this.queue = [];
  }

  get pendingCount(): number {
    return this.queue.length;
  }
}
