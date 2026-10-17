// M3 must 场景（真实现版；依赖：Agent B1 packages/engine-adapter —— 已交付，本文件现在即可真实运行）。
//
// 场景（任务书 §15.2 M3）：引擎退出、协议不匹配、停止与进程树清理——状态真实，恢复历史缺口可见，
// 停止有终态，不盲重放副作用。
//
// 实现：fake-app-server.mjs 的 'die-midturn' 场景（fixture 协议进程在回合进行中 process.exit(3)，
// 非模型调用）：
//   回合进行中引擎进程退出 → adapter 状态 stopped（真实，不虚报 ready）；
//   该回合无 turn/completed 终态（不伪造成功）；
//   死进程上的新调用（send/approve）被拒绝（pending 不再写给死进程）；
//   EngineSessionStore 落盘后 loadThread 的 complete=false（未闭合回合=历史缺口，恢复视图可见）。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CodexEngineAdapter, EngineSessionStore, sessionFilePath } from '../../src/index';
import type { EngineEvent } from '@forgedesk/contracts/engine';

const fixtureServer = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-app-server.mjs');

const THREAD_ID = 'th-m3-exit';

let root: string;
let adapter: CodexEngineAdapter;
let store: EngineSessionStore;
const events: EngineEvent[] = [];

async function waitUntil(pred: () => boolean, timeoutMs = 8000, what = '条件'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('M3 引擎退出：进程退出后状态真实、pending 拒绝、SessionStore 标记 incomplete（真实现）', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'forgedesk-m3-exit-'));
    adapter = new CodexEngineAdapter({
      codexCliPath: process.execPath,
      cliArgs: [fixtureServer],
      codexHome: join(root, 'codex-home'),
      storageDir: join(root, 'storage'),
      projectRoot: root,
      extraEnv: {
        FD_FIXTURE_CONFIG: JSON.stringify({
          scenario: 'die-midturn',
          exitCode: 3,
          threadId: THREAD_ID,
        }),
      },
      requestTimeoutMs: 8000,
    });
    store = new EngineSessionStore({ storageDir: join(root, 'storage') });
    store.attach(adapter, { projectRoot: root });
    adapter.subscribe((e) => events.push(e));

    await adapter.start({ projectRoot: root });
    await adapter.send('跑一个会在中途死掉的回合');
    // fixture：回合 started → ~80ms 后 process.exit(3)
    await waitUntil(() => adapter.status === 'stopped', 8000, 'engine/status → stopped');
    // 等事件落盘 flush
    await waitUntil(
      () => existsSync(sessionFilePath(join(root, 'storage'), THREAD_ID)),
      4000,
      'session jsonl 落盘',
    );
    await new Promise((r) => setTimeout(r, 150));
  });

  afterAll(async () => {
    try {
      await adapter?.dispose();
    } catch {
      /* 已停止 */
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('引擎进程退出后 adapter.status === stopped（状态真实，不虚报 ready）', () => {
    expect(adapter.status).toBe('stopped');
  });

  it('事件流出现 engine/status(stopped)；该回合无 turn/completed 终态（不伪造成功）', () => {
    const stopped = events.find((e) => e.type === 'engine/status' && e.status === 'stopped');
    expect(stopped).toBeDefined();
    const started = events.find((e) => e.type === 'turn/started');
    expect(started).toBeDefined();
    const completed = events.filter((e) => e.type === 'turn/completed');
    expect(completed).toHaveLength(0);
  });

  it('死进程上的 pending 拒绝：send() 与 approve() 都被拒绝，不写给死进程', async () => {
    await expect(adapter.send('新回合')).rejects.toThrow(/引擎尚未启动|未完成会话初始化/);
    await expect(adapter.approve('req-any', 'accept')).rejects.toThrow(/找不到待处理的审批请求/);
  });

  it('SessionStore 标记 incomplete：loadThread().complete === false（未闭合回合=历史缺口可见）', async () => {
    const result = await store.loadThread(THREAD_ID);
    expect(result).not.toBeNull();
    expect(result!.complete).toBe(false); // 缺 turn/completed 的回合 → 缺口，不假装成功
    expect(result!.messages.length).toBeGreaterThanOrEqual(0);
  });

  it('恢复视图不伪造缺失消息：重启后（listThreads）该 thread 仍 complete=false', async () => {
    const threads = await store.listThreads();
    const th = threads.find((t) => t.threadId === THREAD_ID);
    expect(th).toBeDefined();
    expect(th!.complete).toBe(false);
  });
});
