// M3 must 场景（fixture 级）；集成状态：TODO-INT
// （engine-adapter 的真实 interrupt()/进程管理未交付前：以 transcripts fixture（模拟投影事件流）验证
//   停止语义的投影规则——turn/completed 必须看实际 status、停止有终态、interrupt 只是请求；
//   集成后接真实 adapter 事件流与 dispose/进程树清理验证。）
//
// 场景（任务书 §15.2 M3）：引擎退出、协议不匹配、停止与进程树清理——状态真实，恢复历史缺口可见，
// 停止有终态，不盲重放副作用；§6.1：turn/interrupt 只代表取消请求，等待终态与工程工具收尾后才显示停止。

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINE_EVENT_TYPES } from '@forgedesk/contracts/engine';
import type { EngineEvent, EngineStatus, TurnCompletionStatus } from '@forgedesk/contracts/engine';

const fixturesRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'engineering', 'fixtures', 'transcripts');

function loadTranscript(name: string): EngineEvent[] {
  const text = readFileSync(join(fixturesRoot, name), 'utf8');
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EngineEvent);
}

/** 回合终态判定：必须读取 turn/completed 事件的【实际 status 字段】，事件名本身不蕴含成功（任务书 §6.1） */
function turnOutcome(events: EngineEvent[], turnId: string): TurnCompletionStatus | null {
  let outcome: TurnCompletionStatus | null = null;
  for (const e of events) {
    if (e.type === 'turn/completed' && e.turnId === turnId) outcome = e.status;
  }
  return outcome;
}

/** 引擎状态轨迹（engine/status 事件序列） */
function engineStatusTrail(events: EngineEvent[]): EngineStatus[] {
  return events.filter((e) => e.type === 'engine/status').map((e) => (e.type === 'engine/status' ? e.status : 'stopped'));
}

describe('M3 停止语义（fixture 级）——stop-semantics.jsonl（用户停止回合）', () => {
  const events = loadTranscript('stop-semantics.jsonl');

  it('事件类型合法且 seq 严格递增', () => {
    let prevSeq = 0;
    for (const e of events) {
      expect(ENGINE_EVENT_TYPES).toContain(e.type);
      expect(e.seq).toBeGreaterThan(prevSeq);
      prevSeq = e.seq;
    }
  });

  it('停止有终态：turn/completed(interrupted) 之后才出现 engine/status(stopped)', () => {
    const completedIdx = events.findIndex((e) => e.type === 'turn/completed');
    const stoppedIdx = events.findIndex((e) => e.type === 'engine/status' && e.status === 'stopped');
    expect(completedIdx).toBeGreaterThanOrEqual(0);
    expect(stoppedIdx).toBeGreaterThan(completedIdx); // 先终态、后显示已停止
  });

  it('interrupt 只是取消请求：stopping 之后仍有工具收尾事件，显示层不得提前判定“已停止”', () => {
    const stoppingIdx = events.findIndex((e) => e.type === 'engine/status' && e.status === 'stopping');
    const completedIdx = events.findIndex((e) => e.type === 'turn/completed');
    const tailEvents = events.slice(stoppingIdx + 1, completedIdx);
    expect(stoppingIdx).toBeGreaterThanOrEqual(0);
    expect(tailEvents.length).toBeGreaterThan(0); // stopping 与终态之间存在收尾事件
    // 模拟显示状态机：stopping → “停止中”；turn/completed 到达前不显示“已停止”
    let displayed: 'running' | 'stopping' | 'stopped' = 'running';
    for (const e of events) {
      if (e.type === 'engine/status' && e.status === 'stopping') displayed = 'stopping';
      if (e.type === 'turn/completed') displayed = 'stopped';
    }
    expect(displayed).toBe('stopped'); // 整个事件流结束后才是已停止
    expect(events.slice(0, completedIdx).some((e) => e.type === 'engine/status' && e.status === 'stopped')).toBe(false);
  });

  it('被停止的回合终态是 interrupted，不是 success（不把中断显示成成功）', () => {
    expect(turnOutcome(events, 'turn-0004')).toBe('interrupted');
    expect(turnOutcome(events, 'turn-0004')).not.toBe('success');
  });

  it('该回合只有唯一一个 turn/completed（停止后没有额外的 success 终态）', () => {
    const completions = events.filter((e) => e.type === 'turn/completed');
    expect(completions).toHaveLength(1);
  });

  it('引擎状态轨迹：ready → stopping → stopped', () => {
    expect(engineStatusTrail(events)).toEqual(['ready', 'stopping', 'stopped']);
  });
});

describe('M3 停止语义（fixture 级）——stop-failure.jsonl（回合失败）', () => {
  const events = loadTranscript('stop-failure.jsonl');

  it('turn/completed 事件名之外必须检查实际 status：失败回合不得显示为成功', () => {
    const completed = events.find((e) => e.type === 'turn/completed');
    expect(completed).toBeDefined();
    expect(turnOutcome(events, 'turn-0005')).toBe('failure');
    expect(turnOutcome(events, 'turn-0005')).not.toBe('success');
  });

  it('错误事件先于终态且携带 FailureKind（状态真实可追溯）', () => {
    const errorIdx = events.findIndex((e) => e.type === 'error');
    const completedIdx = events.findIndex((e) => e.type === 'turn/completed');
    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(errorIdx).toBeLessThan(completedIdx);
    const error = events[errorIdx];
    expect(error && error.type === 'error' && error.code).toBe('model_failure');
    expect(error && error.type === 'error' && error.recoverable).toBe(false);
  });
});

describe('M3 停止语义（fixture 级）——approval-stale-generation.jsonl 的连接断开回合', () => {
  it('断连（connection_failure）回合终态为 interrupted，且引擎进入 error 状态（历史缺口可见，不伪造）', () => {
    const events = loadTranscript('approval-stale-generation.jsonl');
    expect(turnOutcome(events, 'turn-0002')).toBe('interrupted');
    expect(engineStatusTrail(events)).toEqual(['ready', 'error', 'ready']);
    // 重连后的新回合正常完成（恢复历史缺口可见，不盲重放旧回合副作用）
    expect(turnOutcome(events, 'turn-0003')).toBe('success');
  });
});

// TODO-INT（集成后）：
// 1. adapter.interrupt() → 真实事件流中出现 stopping/turn/completed(interrupted) 的顺序与终态等待语义；
// 2. 协议不匹配（服务端返回 JSON-RPC error / 非法消息）：error 事件投影 + 状态真实（engine error）；
// 3. dispose() 进程树清理：Job Object 归属与子进程（工具进程）不残留（任务书 §6.1，主进程/runner 联测）；
// 4. 事件重放恢复视图：重启后 seq 缺口标 incomplete，不伪造缺失消息。
