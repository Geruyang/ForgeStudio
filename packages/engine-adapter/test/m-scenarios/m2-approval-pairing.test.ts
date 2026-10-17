// M2 must 场景（真实现版；依赖：Agent B1 packages/engine-adapter —— 已交付，本文件现在即可真实运行）。
//
// 场景（任务书 §15.2 M2）：审批、拒绝与窗口重载——请求/连接代次配对；重载不错误放行；
// 未知请求有拒绝或错误应答；引擎重启后不得把旧批准直接重放给新连接。
//
// 实现：以 fake-app-server.mjs（fixture 协议进程，非模型调用）为对端，真实 spawn 走完整
// JSONL 握手与审批路径（产品路径：主进程持有同一 adapter 实例，重启 = 同实例 start()，代次 +1）：
//   代次 1：发起回合 → 服务端审批请求 req-pair-gen1（generation=1）到达 → 不应答，dispose() 关闭引擎；
//   代次 2：同实例 start() 重启（generation=2）→ 新回合发起前，对旧 requestId 应答必须被拒绝
//           （entry.generation=1 ≠ 当前 2，旧批准不得重放给新连接，无副作用）；
//   新代次审批到达（generation=2）→ 正常应答成功 → 回合 success（新代次未被旧代次污染）。
//
// fixture 依赖：packages/engine-adapter/test/fixtures/fake-app-server.mjs（scenario 'approval'）。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CodexEngineAdapter } from '../../src/index';
import type { EngineEvent } from '@forgedesk/contracts/engine';

const fixtureServer = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-app-server.mjs');

let root: string;
let adapter: CodexEngineAdapter;

/** 事件收集 + 条件等待（轮询） */
class EventLog {
  readonly events: EngineEvent[] = [];

  async wait(pred: (e: EngineEvent) => boolean, timeoutMs = 8000): Promise<EngineEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error(`等待事件超时（${timeoutMs}ms）；已收到：${this.events.map((e) => e.type).join(', ')}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

const log = new EventLog();

function freshAdapter(config: Record<string, unknown>): CodexEngineAdapter {
  return new CodexEngineAdapter({
    codexCliPath: process.execPath,
    cliArgs: [fixtureServer],
    codexHome: join(root, 'codex-home'),
    storageDir: join(root, 'storage'),
    projectRoot: root,
    extraEnv: { FD_FIXTURE_CONFIG: JSON.stringify(config) },
    requestTimeoutMs: 8000,
  });
}

describe('M2 审批配对：跨 generation 重启引擎，旧 requestId 应答必须不生效（真实现）', () => {
  let start1: { threadId: string; generation: number };
  let start2: { threadId: string; generation: number };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'forgedesk-m2-pair-'));
    adapter = freshAdapter({
      scenario: 'approval',
      approvalMethod: 'execCommandApproval',
      approvalRequestId: 'req-pair-gen1',
      threadId: 'th-m2-pair',
      authMode: 'apikey', // fixture 认证就绪 → adapter 状态 ready（非 auth_required）
    });
    adapter.subscribe((e) => log.events.push(e));

    // ---- 代次 1：审批请求到达后不应答，直接关闭引擎（模拟引擎重启） ----
    start1 = await adapter.start({ projectRoot: root });
    await adapter.send('请运行测试');
    await log.wait((e) => e.type === 'approval/requested' && e.approval.requestId === 'req-pair-gen1');
    await adapter.dispose();

    // ---- 代次 2：同实例重启（产品路径），此时尚未发起新回合 ----
    start2 = await adapter.start({ projectRoot: root });
  });

  afterAll(async () => {
    try {
      await adapter?.dispose();
    } catch {
      /* 已停止 */
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('代次 1 审批请求到达：requestId 与事件 connectionGeneration 一致', () => {
    const e = log.events.find(
      (ev): ev is Extract<EngineEvent, { type: 'approval/requested' }> => ev.type === 'approval/requested',
    );
    expect(e).toBeDefined();
    expect(e!.approval.requestId).toBe('req-pair-gen1');
    expect(e!.approval.connectionGeneration).toBe(start1.generation);
    expect(start1.generation).toBe(1);
  });

  it('引擎重启后（代次 2）：旧 requestId（代次 1 的 entry）应答被拒绝且无副作用', async () => {
    expect(adapter.status).toBe('ready');
    expect(start2.generation).toBe(start1.generation + 1);

    // 旧代次 entry 仍登记（generation=1），当前代次 2 → 拒绝；审批未被放行
    await expect(adapter.approve('req-pair-gen1', 'accept')).rejects.toThrow(/旧批准不得重放|代次/);
    // 拒绝后该 entry 保留（未被删除），重复应答仍拒绝、不会在第 2 次成功
    await expect(adapter.approve('req-pair-gen1', 'accept')).rejects.toThrow(/旧批准不得重放|代次/);
  });

  it('未知 requestId 拒绝应答（不静默挂起）', async () => {
    await expect(adapter.approve('req-does-not-exist', 'accept')).rejects.toThrow(/找不到待处理的审批请求/);
  });

  it('新代次审批正常工作：新回合审批到达（generation=2）→ 应答成功 → 回合 success', async () => {
    await adapter.send('请再次运行测试');
    const req = await log.wait(
      (e) =>
        e.type === 'approval/requested' &&
        e.approval.connectionGeneration === start2.generation,
    );
    expect(req.type).toBe('approval/requested');

    await adapter.approve((req as Extract<EngineEvent, { type: 'approval/requested' }>).approval.requestId, 'accept');
    const completed = await log.wait(
      (e) => e.type === 'turn/completed' && e.connectionGeneration === start2.generation,
    );
    expect(completed.type === 'turn/completed' && completed.status).toBe('success');
  });
});
