/**
 * 自有引擎事件持久化（不写 Codex 内部数据库）。
 *
 * - 每 thread 一个 JSONL 文件（storageDir/sessions/<sanitized>.jsonl），按接收顺序存 EngineEvent；
 * - 写入串行化（每 thread 一条 Promise 链），保证行序与事件序一致；
 * - 写入失败：返回 OpResult 失败并把该 thread 标记为"历史不完整"（listThreads/loadThread 的 complete=false），
 *   绝不假装成功；
 * - 重连/历史缺口（未闭合的 turn、损坏行、seq 回退、写入失败）标 complete=false，不伪造缺失消息；
 * - loadThread() 重建 StoredMessage 列表：delta 合并成最终文本、工具调用归组、patchRefs 收集。
 */
import { appendFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fail, ok } from '@forgedesk/contracts/common';
import type { OpResult, Timestamp } from '@forgedesk/contracts/common';
import type { EngineAdapter, EngineEvent, StoredMessage, ThreadSummary } from '@forgedesk/contracts/engine';

/** 会话文件名清洗：Windows 非法文件名字符统一替换 */
function sanitizeThreadId(threadId: string): string {
  const cleaned = threadId.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return cleaned.length > 0 ? cleaned : 'thread';
}

/** 会话 JSONL 文件路径（导出供工具/测试直接定位） */
export function sessionFilePath(storageDir: string, threadId: string): string {
  return path.join(storageDir, 'sessions', `${sanitizeThreadId(threadId)}.jsonl`);
}

/** loadThread() 的返回：重建的消息视图 + 历史完整性 */
export interface ThreadLoadResult {
  messages: StoredMessage[];
  complete: boolean;
  projectRoot: string;
}

interface SessionMetaRecord {
  kind: 'meta';
  threadId: string;
  /** 会话起始 meta 记录项目根；重命名 meta 不携带（可选） */
  projectRoot?: string;
  /** 用户自定义标题（Z1-5 重命名持久化；缺省回落首条用户消息摘要） */
  title?: string;
  at: Timestamp;
}

interface ThreadAnalysis {
  threadId: string;
  projectRoot: string;
  title: string;
  lastActivityAt: Timestamp;
  messageCount: number;
  complete: boolean;
  events: EngineEvent[];
}

export class EngineSessionStore {
  readonly #storageDir: string;
  readonly #queues = new Map<string, Promise<void>>();
  /** 写入失败过的 thread（in-memory），listThreads 合并为 complete=false */
  readonly #unhealthy = new Map<string, Timestamp>();
  #dirReady: Promise<void> | null = null;

  constructor(options: { storageDir: string }) {
    this.#storageDir = options.storageDir;
  }

  get storageDir(): string {
    return this.#storageDir;
  }

  /**
   * 自动接线：订阅 adapter 事件流持久化。
   * session/started 时写 meta（projectRoot 供 ThreadSummary 使用）。
   * 返回取消订阅函数。append 失败通过 #unhealthy 计入 complete=false。
   */
  attach(adapter: EngineAdapter, options: { projectRoot: string }): () => void {
    return adapter.subscribe((event) => {
      if (event.type === 'session/started') {
        void this.recordSessionStart(event.threadId, options.projectRoot);
        return;
      }
      if (event.threadId) {
        void this.append(event);
      }
    });
  }

  /** 会话元信息（threadId → projectRoot）落盘；重复调用以最后一次为准 */
  async recordSessionStart(threadId: string, projectRoot: string): Promise<OpResult<void>> {
    const record: SessionMetaRecord = {
      kind: 'meta',
      threadId,
      projectRoot,
      at: new Date().toISOString(),
    };
    return this.#appendRecord(threadId, record);
  }

  /** 重命名（Z1-5）：追加 title meta 记录；历史会话与离线状态同样生效 */
  async renameThread(threadId: string, title: string): Promise<OpResult<void>> {
    const name = title.trim();
    if (name.length === 0 || name.length > 120) {
      throw new Error('会话名须为 1-120 个字符');
    }
    const record: SessionMetaRecord = {
      kind: 'meta',
      threadId,
      title: name,
      at: new Date().toISOString(),
    };
    return this.#appendRecord(threadId, record);
  }

  /** 删除（Z1-5）：移除会话文件与不完整标记；不存在视为成功（幂等） */
  async deleteThread(threadId: string): Promise<OpResult<void>> {
    this.#unhealthy.delete(threadId);
    try {
      await rm(sessionFilePath(this.#storageDir, threadId), { force: true });
      return ok(undefined);
    } catch (e) {
      return fail('internal_error', `删除会话文件失败：${String(e)}`);
    }
  }

  /** 按接收顺序追加事件；无 threadId 的事件（如全局 engine/status）不入 thread 文件 */
  async append(event: EngineEvent): Promise<OpResult<void>> {
    if (!event.threadId) return ok(undefined);
    return this.#appendRecord(event.threadId, event);
  }

  /** 列出全部会话摘要（按文件扫描 + 合并写入失败记录） */
  async listThreads(): Promise<ThreadSummary[]> {
    const dir = path.join(this.#storageDir, 'sessions');
    let files: string[] = [];
    try {
      files = await readdir(dir);
    } catch {
      files = [];
    }
    const summaries: ThreadSummary[] = [];
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      let analysis: ThreadAnalysis;
      try {
        analysis = await this.#analyzeFile(path.join(dir, file));
      } catch {
        continue;
      }
      const complete = analysis.complete && !this.#unhealthy.has(analysis.threadId);
      summaries.push({
        threadId: analysis.threadId,
        projectRoot: analysis.projectRoot,
        title: analysis.title,
        lastActivityAt: analysis.lastActivityAt,
        complete,
        messageCount: analysis.messageCount,
      });
    }
    // 只写入失败、文件缺失的 thread：仍要可见，且 complete=false（不假装成功）
    for (const [threadId, at] of this.#unhealthy) {
      if (summaries.some((s) => s.threadId === threadId)) continue;
      summaries.push({
        threadId,
        projectRoot: '',
        title: threadId,
        lastActivityAt: at,
        complete: false,
        messageCount: 0,
      });
    }
    return summaries;
  }

  /** 重建某 thread 的 StoredMessage 视图；complete=false 表示存在历史缺口（不伪造缺失消息） */
  async loadThread(threadId: string): Promise<ThreadLoadResult> {
    const file = sessionFilePath(this.#storageDir, threadId);
    const analysis = await this.#analyzeFile(file, threadId);
    const messages = this.#rebuildMessages(analysis.events);
    const complete = analysis.complete && !this.#unhealthy.has(threadId);
    return { messages, complete, projectRoot: analysis.projectRoot };
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  #ensureDir(): Promise<void> {
    this.#dirReady ??= mkdir(path.join(this.#storageDir, 'sessions'), { recursive: true }).then(
      () => undefined,
      (e: unknown) => {
        // 目录创建失败允许后续重试，不把 rejected promise 永久缓存在实例上
        this.#dirReady = null;
        throw e;
      },
    );
    return this.#dirReady;
  }

  /** 每 thread 串行写队列：保证事件行序与接收序一致 */
  #appendRecord(threadId: string, record: unknown): Promise<OpResult<void>> {
    const job = async (): Promise<OpResult<void>> => {
      try {
        await this.#ensureDir();
        await appendFile(sessionFilePath(this.#storageDir, threadId), JSON.stringify(record) + '\n', 'utf8');
        return ok(undefined);
      } catch (e) {
        const at = new Date().toISOString();
        this.#unhealthy.set(threadId, at);
        const message = e instanceof Error ? e.message : String(e);
        return fail('internal_error', `会话事件写入失败（thread ${threadId}）：${message}`, { occurredAt: at });
      }
    };
    const prev = this.#queues.get(threadId) ?? Promise.resolve();
    const next = prev.then(job, job);
    // 链上吞掉结果，保持队列存活；真实结果返回给调用方
    this.#queues.set(
      threadId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  async #analyzeFile(file: string, threadIdHint?: string): Promise<ThreadAnalysis> {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      raw = '';
    }
    const events: EngineEvent[] = [];
    const metas: SessionMetaRecord[] = [];
    let corruptLines = 0;
    let lastSeq = -1;
    let seqStrictlyIncreasing = true;
    let messageCount = 0;
    let firstUserText: string | undefined;
    let lastActivityAt: Timestamp = '';

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        corruptLines += 1;
        continue;
      }
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as Record<string, unknown>)['kind'] === 'meta'
      ) {
        const rec = parsed as unknown as SessionMetaRecord;
        if (typeof rec.threadId === 'string') {
          metas.push(rec);
        }
        continue;
      }
      const ev = parsed as Partial<EngineEvent> & Record<string, unknown>;
      if (typeof ev['type'] === 'string' && typeof ev['seq'] === 'number') {
        const event = ev as unknown as EngineEvent;
        events.push(event);
        if (event.seq <= lastSeq) seqStrictlyIncreasing = false;
        lastSeq = event.seq;
        if (event.type === 'message/created') {
          messageCount += 1;
          if (firstUserText === undefined && event.role === 'user' && event.text) {
            firstUserText = event.text;
          }
        }
        if (event.type !== 'engine/status') {
          // engine/status 不代表会话活动；其余事件都推进最近活动时间
          lastActivityAt = event.emittedAt ?? lastActivityAt;
        }
        if (event.emittedAt && lastActivityAt === '') lastActivityAt = event.emittedAt;
      } else {
        corruptLines += 1;
      }
    }

    const threadId = metas.at(-1)?.threadId ?? events[0]?.threadId ?? threadIdHint ?? '';
    // 未闭合的 turn = 历史缺口（重连/进程中断），complete=false
    const openTurns = this.#countOpenTurns(events);
    const complete = corruptLines === 0 && seqStrictlyIncreasing && openTurns === 0;
    // projectRoot：最后一个携带非空值的 meta；title：最后一次用户重命名，缺省回落首条用户消息
    const projectRootMeta = [...metas].reverse().find((m) => typeof m.projectRoot === 'string' && m.projectRoot !== '');
    const titleMeta = [...metas].reverse().find((m) => typeof m.title === 'string' && m.title !== '');
    const title = titleMeta?.title ?? (firstUserText ? this.#ellipsis(firstUserText, 60) : threadId);

    return {
      threadId,
      projectRoot: projectRootMeta?.projectRoot ?? '',
      title,
      lastActivityAt,
      messageCount,
      complete,
      events,
    };
  }

  #countOpenTurns(events: EngineEvent[]): number {
    const started = new Map<string, number>();
    const closed = new Set<string>();
    for (const ev of events) {
      if (ev.type === 'turn/started' && ev.turnId) started.set(ev.turnId, ev.seq);
      if (ev.type === 'turn/completed' && ev.turnId) closed.add(ev.turnId);
    }
    let open = 0;
    for (const turnId of started.keys()) {
      if (!closed.has(turnId)) open += 1;
    }
    return open;
  }

  #ellipsis(s: string, max: number): string {
    return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
  }

  /** 事件 → StoredMessage 重建：delta 合并、工具调用归组（挂在产生它的最后一条助手消息上）、patchRefs 收集 */
  #rebuildMessages(events: EngineEvent[]): StoredMessage[] {
    const messages: StoredMessage[] = [];
    const assistantByItemId = new Map<string, number>();
    const callIdToMessage = new Map<string, number>();
    const seenCallIds = new Set<string>();
    let currentTurnLastAssistant: number | null = null;

    const pushMessage = (ev: EngineEvent, role: StoredMessage['role'], text: string): number => {
      messages.push({
        seq: ev.seq,
        threadId: ev.threadId ?? '',
        turnId: ev.turnId,
        role,
        text,
        createdAt: ev.emittedAt,
      });
      return messages.length - 1;
    };

    // 附件（工具/补丁）归属：当前回合内最近一条助手消息；若无则补位空助手消息，不挂到用户消息上
    const targetForAttachments = (ev: EngineEvent): number => {
      if (currentTurnLastAssistant !== null) return currentTurnLastAssistant;
      const idx = pushMessage(ev, 'assistant', '');
      currentTurnLastAssistant = idx;
      return idx;
    };

    for (const ev of events) {
      switch (ev.type) {
        case 'turn/started':
          currentTurnLastAssistant = null;
          break;
        case 'message/created': {
          const idx = pushMessage(ev, ev.role, ev.text ?? '');
          if (ev.role === 'assistant') {
            if (ev.itemId) assistantByItemId.set(ev.itemId, idx);
            currentTurnLastAssistant = idx;
          }
          break;
        }
        case 'message/delta': {
          let idx = ev.itemId ? assistantByItemId.get(ev.itemId) : undefined;
          if (idx === undefined) {
            // 没有前置 created（理论上不应出现）：作为独立助手消息，不丢弃增量
            idx = pushMessage(ev, 'assistant', '');
            if (ev.itemId) assistantByItemId.set(ev.itemId, idx);
          }
          messages[idx].text += ev.delta;
          break;
        }
        case 'tool/called': {
          if (seenCallIds.has(ev.callId)) break;
          seenCallIds.add(ev.callId);
          const idx = targetForAttachments(ev);
          const toolCalls = (messages[idx].toolCalls ??= []);
          toolCalls.push({ callId: ev.callId, tool: ev.tool, preview: ev.argsPreview, isError: false });
          callIdToMessage.set(ev.callId, idx);
          break;
        }
        case 'tool/output': {
          const idx = callIdToMessage.get(ev.callId);
          if (idx === undefined) break;
          const toolCalls = messages[idx].toolCalls;
          const call = toolCalls?.find((c) => c.callId === ev.callId);
          if (call) {
            call.isError = ev.isError;
            if (ev.outputPreview.length > 0) call.preview = ev.outputPreview;
          }
          break;
        }
        case 'patch/applied': {
          const idx = targetForAttachments(ev);
          const patchRefs = (messages[idx].patchRefs ??= []);
          if (!patchRefs.includes(ev.patchRef)) patchRefs.push(ev.patchRef);
          break;
        }
        default:
          break;
      }
    }
    return messages;
  }
}
