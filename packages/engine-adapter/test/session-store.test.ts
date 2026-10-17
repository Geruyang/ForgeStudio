// EngineSessionStore 测试：事件按序落盘、loadThread 重放重建 StoredMessage（delta 合并 /
// toolCalls 聚合 / patchRefs）、listThreads 摘要、历史缺口 complete=false、写入失败不崩溃。
// 对端为 test/fixtures/fake-app-server.mjs（fixture 协议进程，非模型调用）。

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CodexEngineAdapter, EngineSessionStore, sessionFilePath } from '../src/index';

const fixtureServer = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-app-server.mjs');

interface StoreHarness {
  root: string;
  storageDir: string;
  adapter: CodexEngineAdapter;
  store: EngineSessionStore;
  sessionFile: string;
  cleanup(): Promise<void>;
}

function createStoreHarness(config: Record<string, unknown>, threadId: string): StoreHarness {
  const root = mkdtempSync(join(tmpdir(), 'forgedesk-store-'));
  const storageDir = join(root, 'storage');
  const adapter = new CodexEngineAdapter({
    codexCliPath: process.execPath,
    cliArgs: [fixtureServer],
    codexHome: join(root, 'codex-home'),
    storageDir,
    projectRoot: root,
    omitEnvKeys: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    extraEnv: { FD_FIXTURE_CONFIG: JSON.stringify({ authMode: 'apikey', ...config, threadId }) },
    requestTimeoutMs: 8000,
  });
  const store = new EngineSessionStore({ storageDir });
  return {
    root,
    storageDir,
    adapter,
    store,
    sessionFile: sessionFilePath(storageDir, threadId),
    cleanup: async () => {
      try {
        await adapter.dispose();
      } catch {
        /* 已停止 */
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const cleanups: Array<() => Promise<void>> = [];
function track(h: StoreHarness): StoreHarness {
  cleanups.push(h.cleanup);
  return h;
}
afterEach(async () => {
  for (const fn of cleanups.splice(0)) {
    try {
      await fn();
    } catch {
      /* 清理失败不阻塞 */
    }
  }
});

/** 轮询等待会话文件包含指定内容（事件异步落盘） */
async function waitFileContains(file: string, needle: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(file) && readFileSync(file, 'utf8').includes(needle)) return;
    if (Date.now() > deadline) throw new Error(`等待会话文件包含 "${needle}" 超时`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('SessionStore 重放重建（真实子进程事件流）', () => {
  it('basic 回合：loadThread 重建 StoredMessage（用户消息、delta 合并文本、toolCalls 聚合）；complete=true', async () => {
    const THREAD_ID = 'th-store-1';
    const h = track(createStoreHarness({ scenario: 'basic' }, THREAD_ID));
    h.store.attach(h.adapter, { projectRoot: h.root });
    await h.adapter.start({ projectRoot: h.root });
    await h.adapter.send('帮我运行测试并汇报');
    await waitFileContains(h.sessionFile, 'turn/completed');
    // 最后一条事件（completed）之后可能还有 engine/status 未落盘，稍等队列排空
    await new Promise((r) => setTimeout(r, 120));

    const result = await h.store.loadThread(THREAD_ID);
    expect(result.complete).toBe(true);
    expect(result.projectRoot).toBe(h.root);

    // 消息重建：用户消息 + 助手消息（delta 合并后的最终文本）
    const user = result.messages.find((m) => m.role === 'user');
    expect(user?.text).toBe('帮我运行测试并汇报');
    const assistant = result.messages.find((m) => m.role === 'assistant' && m.text.length > 0);
    expect(assistant?.text).toBe('你好，这是 fixture 增量输出。');

    // 工具调用聚合（本回合工具先于 agentMessage 到达：挂在回合内补位助手消息上）
    const toolCall = result.messages.flatMap((m) => m.toolCalls ?? []).find((c) => c.callId === 'item-cmd-basic');
    expect(toolCall).toMatchObject({ tool: 'commandExecution', isError: false });
    expect(toolCall?.preview).toContain('fixture: 3 passed');

    // 消息按事件 seq 有序
    for (let i = 1; i < result.messages.length; i++) {
      expect(result.messages[i]!.seq).toBeGreaterThan(result.messages[i - 1]!.seq);
    }
  });

  it('listThreads：标题取首条用户消息、messageCount、complete', async () => {
    const THREAD_ID = 'th-store-2';
    const h = track(createStoreHarness({ scenario: 'basic' }, THREAD_ID));
    h.store.attach(h.adapter, { projectRoot: h.root });
    await h.adapter.start({ projectRoot: h.root });
    await h.adapter.send('这是用于标题的较长用户输入内容');
    await waitFileContains(h.sessionFile, 'turn/completed');
    await new Promise((r) => setTimeout(r, 120));

    const threads = await h.store.listThreads();
    const summary = threads.find((t) => t.threadId === THREAD_ID);
    expect(summary).toBeDefined();
    expect(summary!.title).toContain('这是用于标题的较长用户输入内容');
    expect(summary!.complete).toBe(true);
    // message/created 计数：user ×1 + assistant ×1
    expect(summary!.messageCount).toBe(2);
    expect(summary!.projectRoot).toBe(h.root);
    expect(typeof summary!.lastActivityAt).toBe('string');
  });

  it('重连缺口：回合未闭合（进程中途退出）→ loadThread/listThreads complete=false，不伪造终态', async () => {
    const THREAD_ID = 'th-store-3';
    const h = track(createStoreHarness({ scenario: 'die-midturn' }, THREAD_ID));
    h.store.attach(h.adapter, { projectRoot: h.root });
    await h.adapter.start({ projectRoot: h.root });
    await h.adapter.send('会中途断掉的回合');
    await waitFileContains(h.sessionFile, 'turn/started');
    // 等进程退出 + 落盘排空
    await new Promise((r) => setTimeout(r, 400));

    const result = await h.store.loadThread(THREAD_ID);
    expect(result.complete).toBe(false); // 未闭合 turn = 历史缺口
    // 已落盘的部分仍可重建（用户消息存在），但不出现伪造的 turn/completed
    expect(result.messages.some((m) => m.role === 'user')).toBe(true);

    const summary = (await h.store.listThreads()).find((t) => t.threadId === THREAD_ID);
    expect(summary?.complete).toBe(false);
  });
});

describe('SessionStore 写入失败（不崩溃）', () => {
  it('storageDir 不可写：append 返回失败、thread 标记不完整，进程不崩溃', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgedesk-store-bad-'));
    // 用一个普通文件冒充 storageDir → sessions 子目录创建必然失败
    const fakeDir = join(root, 'storage');
    writeFileSync(fakeDir, 'not-a-directory', 'utf8');
    const store = new EngineSessionStore({ storageDir: fakeDir });

    const appended = await store.append({
      seq: 1,
      connectionGeneration: 1,
      threadId: 'th-bad-1',
      type: 'turn/started',
      turnId: 'tu-1',
      inputPreview: 'x',
      emittedAt: new Date().toISOString(),
    });
    expect(appended.ok).toBe(false);

    // 不崩溃：listThreads 仍可调用，该 thread complete=false
    const threads = await store.listThreads();
    const summary = threads.find((t) => t.threadId === 'th-bad-1');
    expect(summary?.complete).toBe(false);

    const loaded = await store.loadThread('th-bad-1');
    expect(loaded.complete).toBe(false);
    expect(loaded.messages).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});
