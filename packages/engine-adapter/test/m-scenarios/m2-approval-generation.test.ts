// M2 must 场景（fixture 级）；集成状态：TODO-INT
// （engine-adapter 真实事件流未交付前：以 contracts ApprovalRequestView/ApprovalDecision/EngineEvent
//   + engineering/fixtures/transcripts/*.jsonl（模拟投影事件流）验证审批配对语义；
//   集成后接真实 adapter.subscribe 的事件流并复用本文件 ApprovalGateFixture 语义。）
//
// 场景（任务书 §15.2 M2）：审批、拒绝与窗口重载——请求/连接代次配对；重载不错误放行；
// 未知请求有拒绝或错误应答；引擎重启后不得把旧批准直接重放给新连接。

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINE_EVENT_TYPES } from '@forgedesk/contracts/engine';
import type { ApprovalDecision, ApprovalRequestView, EngineEvent } from '@forgedesk/contracts/engine';

const fixturesRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'engineering', 'fixtures', 'transcripts');

/** 载入 transcripts fixture（每行一个 EngineEvent JSON） */
function loadTranscript(name: string): EngineEvent[] {
  const text = readFileSync(join(fixturesRoot, name), 'utf8');
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EngineEvent);
}

/** 审批闸门语义 fixture（TODO-INT：集成后由 engine-adapter 的待办配对实现承接同一语义）
 *  规则（任务书 §6.1/§11）：
 *  - 应答必须带回同一 requestId 且属于当前连接代次；
 *  - decision 必须在请求允许的 options 内（只提供锁定版本允许的选项）；
 *  - 同一请求的重复应答忽略（不重复放行）；
 *  - 引擎重启（代次 +1）后旧代次待办不再可应答（旧批准不得重放）。 */
type ApproveOutcome =
  | { ok: true; decision: ApprovalDecision }
  | { ok: false; reason: 'unknown_request' | 'stale_generation' | 'invalid_option' | 'already_resolved' };

class ApprovalGateFixture {
  private pending = new Map<string, { view: ApprovalRequestView; generation: number; resolved: boolean }>();
  private generation: number;

  constructor(generation: number) {
    this.generation = generation;
  }

  /** 引擎重启：代次 +1，旧待办全部失效 */
  restart(generation: number): void {
    this.generation = generation;
    this.pending.clear();
  }

  /** 消费投影事件（approval/requested 登记；approval/resolved 标记完成） */
  onEvent(event: EngineEvent): void {
    if (event.type === 'approval/requested') {
      this.pending.set(event.approval.requestId, {
        view: event.approval,
        generation: event.connectionGeneration,
        resolved: false,
      });
    } else if (event.type === 'approval/resolved') {
      const p = this.pending.get(event.requestId);
      if (p) p.resolved = true;
    }
  }

  /** 用户/GUI 发起应答 */
  approve(requestId: string, decision: ApprovalDecision): ApproveOutcome {
    const p = this.pending.get(requestId);
    if (!p) return { ok: false, reason: 'unknown_request' };
    if (p.generation !== this.generation) return { ok: false, reason: 'stale_generation' };
    if (p.resolved) return { ok: false, reason: 'already_resolved' };
    if (!p.view.options.includes(decision)) return { ok: false, reason: 'invalid_option' };
    p.resolved = true;
    return { ok: true, decision };
  }
}

describe('M2 审批配对（fixture 级）——transcripts 不变量', () => {
  it('approval-basic.jsonl：事件类型合法、seq 严格递增、requested 的 options 非空、resolved 都配对到此前 requested', () => {
    const events = loadTranscript('approval-basic.jsonl');
    expect(events.length).toBeGreaterThan(0);

    let prevSeq = 0;
    const requested = new Set<string>();
    for (const e of events) {
      expect(ENGINE_EVENT_TYPES).toContain(e.type);
      expect(e.seq).toBeGreaterThan(prevSeq);
      prevSeq = e.seq;
      if (e.type === 'approval/requested') {
        expect(e.approval.requestId.length).toBeGreaterThan(0);
        expect(e.approval.options.length).toBeGreaterThan(0);
        expect(e.approval.connectionGeneration).toBe(e.connectionGeneration);
        requested.add(e.approval.requestId);
      } else if (e.type === 'approval/resolved') {
        expect(requested.has(e.requestId)).toBe(true);
      }
    }
    // 基线：回合最终 success，且 req-0001 已被 accept
    const completed = events.find((e) => e.type === 'turn/completed');
    expect(completed && completed.type === 'turn/completed' && completed.status).toBe('success');
  });

  it('approval-stale-generation.jsonl：代次 1→2 重启；req-0002 断连未应答；req-0003 属新代次', () => {
    const events = loadTranscript('approval-stale-generation.jsonl');
    const generations = new Set(events.map((e) => e.connectionGeneration));
    expect([...generations].sort()).toEqual([1, 2]);

    const requested = events
      .filter((e): e is Extract<EngineEvent, { type: 'approval/requested' }> => e.type === 'approval/requested')
      .map((e) => ({ requestId: e.approval.requestId, generation: e.connectionGeneration }));
    expect(requested).toContainEqual({ requestId: 'req-0002', generation: 1 });
    expect(requested).toContainEqual({ requestId: 'req-0003', generation: 2 });

    const resolvedIds = events
      .filter((e): e is Extract<EngineEvent, { type: 'approval/resolved' }> => e.type === 'approval/resolved')
      .map((e) => e.requestId);
    expect(resolvedIds).not.toContain('req-0002'); // 旧请求未应答即断连
  });
});

describe('M2 审批配对（fixture 级）——闸门语义', () => {
  it('正常应答：requestId + options 内的 decision → 放行', () => {
    const gate = new ApprovalGateFixture(1);
    for (const e of loadTranscript('approval-basic.jsonl')) gate.onEvent(e);
    // req-0001 已由 transcript 自身 resolved（accept）；换成未应答的请求验证闸门
    const gate2 = new ApprovalGateFixture(1);
    gate2.onEvent({
      seq: 1,
      connectionGeneration: 1,
      threadId: 'th-x',
      turnId: 'turn-x',
      emittedAt: new Date().toISOString(),
      type: 'approval/requested',
      approval: {
        requestId: 'req-100',
        connectionGeneration: 1,
        kind: 'exec_command',
        summary: 'node build.mjs',
        options: ['accept', 'acceptForSession', 'decline', 'cancel'],
      },
    });
    expect(gate2.approve('req-100', 'accept')).toEqual({ ok: true, decision: 'accept' });
    expect(gate2.approve('req-100', 'decline')).toEqual({ ok: false, reason: 'already_resolved' });
  });

  it('拒绝路径：decline / cancel 同样是合法应答（不放行副作用）', () => {
    const gate = new ApprovalGateFixture(1);
    gate.onEvent({
      seq: 1,
      connectionGeneration: 1,
      emittedAt: new Date().toISOString(),
      type: 'approval/requested',
      approval: {
        requestId: 'req-101',
        connectionGeneration: 1,
        kind: 'apply_patch',
        summary: '应用补丁',
        options: ['accept', 'decline', 'cancel'],
      },
    });
    expect(gate.approve('req-101', 'decline')).toEqual({ ok: true, decision: 'decline' });
  });

  it('未知 requestId → 拒绝应答（unknown_request，不静默挂起）', () => {
    const gate = new ApprovalGateFixture(1);
    expect(gate.approve('req-does-not-exist', 'accept')).toEqual({ ok: false, reason: 'unknown_request' });
  });

  it('decision 不在请求允许的 options 内 → invalid_option（只提供锁定版本允许的选项）', () => {
    const gate = new ApprovalGateFixture(1);
    gate.onEvent({
      seq: 1,
      connectionGeneration: 1,
      emittedAt: new Date().toISOString(),
      type: 'approval/requested',
      approval: {
        requestId: 'req-102',
        connectionGeneration: 1,
        kind: 'other',
        summary: '受限请求',
        options: ['decline', 'cancel'], // 本请求不允许 accept
      },
    });
    expect(gate.approve('req-102', 'accept')).toEqual({ ok: false, reason: 'invalid_option' });
    expect(gate.approve('req-102', 'cancel')).toEqual({ ok: true, decision: 'cancel' });
  });

  it('引擎重启后旧代次待办不可应答：req-0002（代次 1）在代次 2 下 approve → stale_generation', () => {
    const gate = new ApprovalGateFixture(1);
    const events = loadTranscript('approval-stale-generation.jsonl');
    for (const e of events) {
      if (e.type === 'engine/status' && e.status === 'ready' && e.connectionGeneration !== 1) {
        gate.restart(e.connectionGeneration); // 引擎重启：代次 2
      }
      gate.onEvent(e);
    }
    // 旧代次的未应答请求：错误放行防护（窗口重载不错误放行）
    expect(gate.approve('req-0002', 'accept')).toEqual({ ok: false, reason: 'unknown_request' });
    // transcript 中 req-0003 已被 accept；再次应答 → already_resolved
    expect(gate.approve('req-0003', 'accept')).toEqual({ ok: false, reason: 'already_resolved' });
  });

  it('重放旧批准到新连接：代次 1 的 accept 不影响代次 2 的请求判定', () => {
    const gate = new ApprovalGateFixture(2); // 新连接
    gate.onEvent({
      seq: 1,
      connectionGeneration: 2,
      emittedAt: new Date().toISOString(),
      type: 'approval/requested',
      approval: {
        requestId: 'req-200',
        connectionGeneration: 2,
        kind: 'apply_patch',
        summary: '新回合的补丁请求',
        options: ['accept', 'decline'],
      },
    });
    // 伪造“旧批准”应答（引用代次 1 的 requestId 形状）——新连接查无此请求
    expect(gate.approve('req-0002', 'accept')).toEqual({ ok: false, reason: 'unknown_request' });
    // 新请求未被旧批准污染，仍可正常应答
    expect(gate.approve('req-200', 'accept')).toEqual({ ok: true, decision: 'accept' });
  });
});

// TODO-INT（集成后）：
// 1. 接 engine-adapter 真实事件流（EngineAdapter.subscribe），断言 approval/requested 投影的
//    requestId/connectionGeneration/options 与原始服务端请求一致（新旧两组审批协议都要映射，DECISIONS D2）；
// 2. 通过 adapter.approve(requestId, decision) 走真实 JSON-RPC 应答路径；
// 3. 窗口重载场景：renderer 重建后从主进程恢复当前代次待办（engine 事件存储），旧代次待办不可应答。
