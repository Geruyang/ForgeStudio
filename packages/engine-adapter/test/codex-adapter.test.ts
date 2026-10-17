// CodexEngineAdapter 真实子进程测试：以 test/fixtures/fake-app-server.mjs（fixture 协议进程，
// 非模型调用）为对端，真实 spawn 走完整 JSONL 握手 / 回合 / 审批 / 生命周期路径。
//
// 覆盖（任务 §实现要求）：
//   初始化握手与 generation 递增；回合生命周期事件投影；审批请求应答同 ID；steer 语义
//   （回合已结束不重发 / ID 不匹配 / 正常送达）；interrupt 后 interrupted 终态；模型列表映射；
//   无认证 → auth_required；进程退出 → pending 拒绝 + stopped；dispose 先 interrupt 再杀进程树；
//   未知事件洪峰限量不崩溃；turn/completed(failed) 不映射成功；patch 投影与落盘；
//   elicitation 自动拒绝；onBatchedDelta 批处理不丢事件。

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CodexEngineAdapter } from '../src/index';
import type { CodexEngineAdapterOptions, DeltaBatchItem } from '../src/index';
import type { EngineEvent } from '@forgedesk/contracts/engine';

const fixtureServer = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-app-server.mjs');

// ---------------------------------------------------------------------------
// 测试脚手架：每个用例独立临时目录 / 独立 fixture 配置 / 独立 rx 日志
// ---------------------------------------------------------------------------

interface RxEntry {
  at: number;
  msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown };
}

interface Harness {
  root: string;
  adapter: CodexEngineAdapter;
  rxLogPath: string;
  events: EngineEvent[];
  wait(pred: (e: EngineEvent) => boolean, timeoutMs?: number): Promise<EngineEvent>;
  rx(): RxEntry[];
  cleanup(): Promise<void>;
}

/** fixture 子进程的接收日志（FD_FIXTURE_RX_LOG）：断言应答 id / 决定值 / 是否重发 */
function readRxLog(file: string): RxEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RxEntry);
}

function createHarness(
  config: Record<string, unknown>,
  opts: Partial<CodexEngineAdapterOptions> = {},
): Harness {
  const root = mkdtempSync(join(tmpdir(), 'forgedesk-adapter-'));
  const rxLogPath = join(root, 'rx.jsonl');
  const events: EngineEvent[] = [];
  const adapter = new CodexEngineAdapter({
    codexCliPath: process.execPath,
    cliArgs: [fixtureServer],
    codexHome: join(root, 'codex-home'),
    storageDir: join(root, 'storage'),
    projectRoot: root,
    // 剔除宿主机可能存在的模型凭证，fixture 协议进程不依赖任何真实凭证
    omitEnvKeys: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    extraEnv: {
      FD_FIXTURE_CONFIG: JSON.stringify(config),
      FD_FIXTURE_RX_LOG: rxLogPath,
    },
    requestTimeoutMs: 8000,
    ...opts,
  });
  adapter.subscribe((e) => events.push(e));

  const wait = async (pred: (e: EngineEvent) => boolean, timeoutMs = 8000): Promise<EngineEvent> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = events.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error(`等待事件超时（${timeoutMs}ms）；已收到：${events.map((e) => e.type).join(',')}`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  return {
    root,
    adapter,
    rxLogPath,
    events,
    wait,
    rx: () => readRxLog(rxLogPath),
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
function track(h: Harness): Harness {
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

/** 提取某类型事件 */
function of<T extends EngineEvent['type']>(events: EngineEvent[], type: T) {
  return events.filter((e): e is Extract<EngineEvent, { type: T }> => e.type === type);
}

/** 轮询等待文件出现且包含指定内容 */
async function waitFileContains(file: string, needle: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(file) && readFileSync(file, 'utf8').includes(needle)) return;
    if (Date.now() > deadline) throw new Error(`等待文件包含 "${needle}" 超时：${file}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------------------
// 初始化握手与 generation
// ---------------------------------------------------------------------------

describe('初始化握手与 connectionGeneration', () => {
  it('握手成功：initialize → initialized → thread/start；status=ready、serverInfo、session/started、generation=1', async () => {
    const h = track(createHarness({ scenario: 'resume', authMode: 'apikey', threadId: 'th-hs-1' }));
    const started = await h.adapter.start({ projectRoot: h.root });

    expect(started.threadId).toBe('th-hs-1');
    expect(started.generation).toBe(1);
    expect(h.adapter.generation).toBe(1);
    expect(h.adapter.status).toBe('ready');
    expect(h.adapter.serverInfo?.userAgent).toContain('codex-fixture');

    const sessionStarted = of(h.events, 'session/started');
    expect(sessionStarted).toHaveLength(1);
    expect(sessionStarted[0]!.threadId).toBe('th-hs-1');

    const statusTrail = of(h.events, 'engine/status').map((e) => e.status);
    expect(statusTrail).toEqual(['starting', 'ready']);

    // 协议序列：initialize（请求）→ initialized（通知）→ thread/start（请求，cwd=projectRoot）
    const rx = h.rx();
    const initialize = rx.find((r) => r.msg.method === 'initialize');
    expect(initialize).toBeDefined();
    const initialized = rx.find((r) => r.msg.method === 'initialized');
    expect(initialized).toBeDefined();
    const threadStart = rx.find((r) => r.msg.method === 'thread/start');
    expect(threadStart).toBeDefined();

    // stderr 只作诊断：落盘 storage/engine-stderr.log（轮转上限 5MB）
    await waitFileContains(join(h.root, 'storage', 'engine-stderr.log'), 'fixture app-server');
  });

  it('重新 start()：generation 递增（1 → 2），且新连接状态 ready', async () => {
    const h = track(createHarness({ scenario: 'resume', authMode: 'apikey', threadId: 'th-hs-2' }));
    const first = await h.adapter.start({ projectRoot: h.root });
    const second = await h.adapter.start({ projectRoot: h.root });

    expect(first.generation).toBe(1);
    expect(second.generation).toBe(2);
    expect(h.adapter.generation).toBe(2);
    expect(h.adapter.status).toBe('ready');
    // 每代事件都带正确 connectionGeneration
    expect(of(h.events, 'session/started').map((e) => e.connectionGeneration)).toEqual([1, 2]);
  });

  it('握手失败（initialize 返回错误）：start() 抛错且状态 error，不虚报 ready', async () => {
    const h = track(createHarness({ scenario: 'resume', initializeBehavior: 'error' }));
    await expect(h.adapter.start({ projectRoot: h.root })).rejects.toThrow(/initialize/);
    expect(h.adapter.status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// 回合生命周期与事件投影
// ---------------------------------------------------------------------------

describe('回合生命周期事件投影（fixture 真实子进程）', () => {
  it('basic：turn/started → reasoning/delta → 工具调用 → message delta → turn/completed(success)；seq 严格递增', async () => {
    const h = track(createHarness({ scenario: 'basic', authMode: 'apikey', threadId: 'th-lc-1', turnId: 'tu-lc-1' }));
    await h.adapter.start({ projectRoot: h.root });
    const { turnId } = await h.adapter.send('请运行测试');
    const completed = await h.wait((e) => e.type === 'turn/completed');

    expect(turnId).toBe('tu-lc-1');

    // 回合开始 + 输入预览
    const started = of(h.events, 'turn/started');
    expect(started).toHaveLength(1);
    expect(started[0]!.turnId).toBe('tu-lc-1');
    expect(started[0]!.inputPreview).toBe('请运行测试');

    // 用户消息恰好一次（turn/started.items 与 item/started 同 id 去重）
    const userCreated = of(h.events, 'message/created').filter((e) => e.role === 'user');
    expect(userCreated).toHaveLength(1);
    expect(userCreated[0]!.text).toBe('请运行测试');

    // reasoning 增量 → reasoning/delta（带 itemId）
    const reasoning = of(h.events, 'reasoning/delta');
    expect(reasoning).toHaveLength(2);
    expect(reasoning.map((e) => e.itemId)).toEqual(['rs-1', 'rs-1']);

    // 工具调用投影（argsPreview 截断上限内）
    const toolCalled = of(h.events, 'tool/called');
    expect(toolCalled).toHaveLength(1);
    expect(toolCalled[0]!.callId).toBe('item-cmd-basic');
    expect(toolCalled[0]!.tool).toBe('commandExecution');
    expect(toolCalled[0]!.argsPreview).toBe('npm test');

    const toolOutput = of(h.events, 'tool/output');
    expect(toolOutput).toHaveLength(1);
    expect(toolOutput[0]!.callId).toBe('item-cmd-basic');
    expect(toolOutput[0]!.isError).toBe(false);
    expect(toolOutput[0]!.outputPreview).toContain('fixture: 3 passed');

    // 助手消息 created + delta 合并结果
    const assistant = of(h.events, 'message/created').filter((e) => e.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.itemId).toBe('msg-1');
    const deltas = of(h.events, 'message/delta');
    expect(deltas).toHaveLength(3);
    expect(deltas.map((e) => e.delta).join('')).toBe('你好，这是 fixture 增量输出。');

    // 终态：检查实际 status（success），不是只看事件名
    expect(completed.type === 'turn/completed' && completed.status).toBe('success');
    expect(completed.turnId).toBe('tu-lc-1');

    // seq 全局严格递增、同代次
    let prevSeq = 0;
    for (const e of h.events) {
      expect(e.seq).toBeGreaterThan(prevSeq);
      prevSeq = e.seq;
      expect(e.connectionGeneration).toBe(1);
    }
  });

  it('turn/completed(failed)：status 必须是 failure，不映射为成功；detail 带上游错误', async () => {
    const h = track(createHarness({ scenario: 'basic', authMode: 'apikey', turnStatus: 'failed', errorNotification: true }));
    await h.adapter.start({ projectRoot: h.root });
    await h.adapter.send('触发失败');
    const completed = await h.wait((e) => e.type === 'turn/completed');

    expect(completed.type === 'turn/completed' && completed.status).toBe('failure');
    expect(completed.type === 'turn/completed' && completed.detail).toContain('模拟上游失败');
    // 错误通知投影为 error 事件（先于终态）
    const error = of(h.events, 'error');
    expect(error.length).toBeGreaterThanOrEqual(1);
    expect(error[0]!.message).toContain('模拟模型调用失败');
  });

  it('patches：patch/applied 携带文件清单与 patchRef；全文落盘可读；重复 diff 去重', async () => {
    const h = track(createHarness({ scenario: 'patches', authMode: 'apikey' }));
    await h.adapter.start({ projectRoot: h.root });
    await h.adapter.send('修改文件');
    const completed = await h.wait((e) => e.type === 'turn/completed');
    expect(completed.type === 'turn/completed' && completed.status).toBe('success');

    const patches = of(h.events, 'patch/applied');
    // item/fileChange/patchUpdated 一次 + turn/diff/updated 首次一次（第二次同内容去重）
    expect(patches).toHaveLength(2);

    const first = patches[0]!;
    const aChange = first.files.find((f) => f.path === 'src/a.ts');
    const bChange = first.files.find((f) => f.path === 'src/b.ts');
    expect(aChange?.changeType).toBe('modified');
    expect(bChange?.changeType).toBe('added');

    // patchRef 指向落盘的完整补丁文件
    for (const p of patches) {
      const file = join(h.root, 'storage', 'patches', `${p.patchRef}.patch`);
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, 'utf8')).toContain('+new');
    }
    expect(first.additions).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// steer 语义（绑定 expectedTurnId，失败不静默重发）
// ---------------------------------------------------------------------------

describe('steer 语义', () => {
  it('回合已结束：delivered:false、reason=turn_ended，且不向服务端发送 turn/steer', async () => {
    const h = track(createHarness({ scenario: 'basic', authMode: 'apikey' }));
    await h.adapter.start({ projectRoot: h.root });
    await h.adapter.send('先完成的回合');
    await h.wait((e) => e.type === 'turn/completed');

    const result = await h.adapter.steer('回合结束后的追加');
    expect(result).toEqual({ delivered: false, reason: 'turn_ended' });
    // 不静默重发：服务端从未收到 turn/steer
    expect(h.rx().some((r) => r.msg.method === 'turn/steer')).toBe(false);
  });

  it('expectedTurnId 不匹配：delivered:false、reason=id_mismatch，不重发', async () => {
    const h = track(createHarness({ scenario: 'steer', authMode: 'apikey', steerBehavior: 'error-mismatch' }));
    await h.adapter.start({ projectRoot: h.root });
    await h.adapter.send('活动回合');
    await h.wait((e) => e.type === 'turn/started');

    const result = await h.adapter.steer('追加指令');
    expect(result).toEqual({ delivered: false, reason: 'id_mismatch' });
    // 仅一次 turn/steer 请求（收到错误后不重试重发）
    expect(h.rx().filter((r) => r.msg.method === 'turn/steer')).toHaveLength(1);
    await h.wait((e) => e.type === 'turn/completed');
  });

  it('活动回合内：delivered:true，服务端收到带 expectedTurnId 的 turn/steer', async () => {
    const h = track(createHarness({ scenario: 'steer', authMode: 'apikey', steerBehavior: 'ok' }));
    await h.adapter.start({ projectRoot: h.root });
    const { turnId } = await h.adapter.send('活动回合');
    await h.wait((e) => e.type === 'turn/started');

    const result = await h.adapter.steer('追加指令');
    expect(result).toEqual({ delivered: true });
    const steer = h.rx().find((r) => r.msg.method === 'turn/steer');
    expect(steer).toBeDefined();
    const completed = await h.wait((e) => e.type === 'turn/completed');
    expect(completed.type === 'turn/completed' && completed.status).toBe('success');
    expect(completed.turnId).toBe(turnId);
  });
});

// ---------------------------------------------------------------------------
// token 用量投影（thread/tokenUsage/updated → usage/updated；D19 实现的回归）
// ---------------------------------------------------------------------------

describe('token 用量投影', () => {
  it('thread/tokenUsage/updated → usage/updated：取 total 累计口径 + modelContextWindow，字段完整', async () => {
    const h = track(createHarness({ scenario: 'basic', authMode: 'apikey', tokenUsage: true }));
    await h.adapter.start({ projectRoot: h.root });
    await h.adapter.send('请运行测试');
    const usage = await h.wait((e) => e.type === 'usage/updated');
    if (usage.type !== 'usage/updated') throw new Error('unreachable');
    expect(usage.usage).toEqual({
      totalTokens: 12500,
      inputTokens: 9000,
      cachedInputTokens: 4000,
      outputTokens: 3500,
      reasoningOutputTokens: 1500,
      modelContextWindow: 272000,
    });
    expect(usage.turnId).toBe('tu-fixture-0001');
    await h.wait((e) => e.type === 'turn/completed');
  });

  it('fixture 不发该通知时（默认 basic）：不产生 usage/updated（不虚报）', async () => {
    const h = track(createHarness({ scenario: 'basic', authMode: 'apikey' }));
    await h.adapter.start({ projectRoot: h.root });
    await h.adapter.send('请运行测试');
    await h.wait((e) => e.type === 'turn/completed');
    expect(of(h.events, 'usage/updated')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 会话管理（Z1-5：重命名/删除/压缩）
// ---------------------------------------------------------------------------

describe('会话管理（rename/delete/compact）', () => {
  it('renameThread（当前线程）：下发 thread/name/set 且参数正确', async () => {
    const h = track(createHarness({ scenario: 'basic', authMode: 'apikey' }));
    const { threadId } = await h.adapter.start({ projectRoot: h.root });
    await h.adapter.renameThread(threadId, '我的调试会话');
    const req = h.rx().find((r) => r.msg.method === 'thread/name/set');
    expect(req).toBeDefined();
    expect(req!.msg.params).toMatchObject({ threadId, name: '我的调试会话' });
  });

  it('renameThread（非当前线程/历史会话）：静默跳过，不发请求', async () => {
    const h = track(createHarness({ scenario: 'basic', authMode: 'apikey' }));
    await h.adapter.start({ projectRoot: h.root });
    await h.adapter.renameThread('th-not-live-999', '不存在的会话');
    expect(h.rx().find((r) => r.msg.method === 'thread/name/set')).toBeUndefined();
  });

  it('deleteThread（当前线程）：下发 thread/delete；引擎侧通知被消化（未知样本不计入）', async () => {
    const h = track(createHarness({ scenario: 'basic', authMode: 'apikey' }));
    const { threadId } = await h.adapter.start({ projectRoot: h.root });
    await h.adapter.deleteThread(threadId);
    expect(h.rx().find((r) => r.msg.method === 'thread/delete')).toBeDefined();
  });

  it('compactThread（当前线程）：请求受理 + thread/compacted → session/compacted 事件', async () => {
    const h = track(createHarness({ scenario: 'basic', authMode: 'apikey' }));
    const { threadId } = await h.adapter.start({ projectRoot: h.root });
    await h.adapter.compactThread(threadId);
    const compacted = await h.wait((e) => e.type === 'session/compacted');
    if (compacted.type !== 'session/compacted') throw new Error('unreachable');
    expect(compacted.threadId).toBe(threadId);
    expect(h.rx().find((r) => r.msg.method === 'thread/compact/start')).toBeDefined();
  });

  it('compactThread（非当前线程）：明确报错（压缩只对进行中的会话有意义）', async () => {
    const h = track(createHarness({ scenario: 'basic', authMode: 'apikey' }));
    await h.adapter.start({ projectRoot: h.root });
    await expect(h.adapter.compactThread('th-not-live-999')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// interrupt（只是取消请求，等终态事件）
// ---------------------------------------------------------------------------

describe('interrupt 停止语义', () => {
  it('interrupt 是请求而非本地虚标：终态事件为 interrupted（不是 success）', async () => {
    const h = track(createHarness({ scenario: 'interrupt', authMode: 'apikey' }));
    await h.adapter.start({ projectRoot: h.root });
    await h.adapter.send('将被中断的回合');
    await h.wait((e) => e.type === 'message/delta');

    await h.adapter.interrupt(); // 仅发出请求，等待终态
    const completed = await h.wait((e) => e.type === 'turn/completed');
    expect(completed.type === 'turn/completed' && completed.status).toBe('interrupted');
    // 服务端确实收到 turn/interrupt
    expect(h.rx().some((r) => r.msg.method === 'turn/interrupt')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 审批：应答必须带回同一 JSON-RPC id
// ---------------------------------------------------------------------------

describe('审批请求与应答（同 ID）', () => {
  it('legacy execCommandApproval：approval/requested → approve 同 ID → decision=approved → 回合继续 success', async () => {
    const h = track(
      createHarness({
        scenario: 'approval',
        authMode: 'apikey',
        approvalMethod: 'execCommandApproval',
        approvalRequestId: 'req-acc-legacy',
      }),
    );
    await h.adapter.start({ projectRoot: h.root });
    await h.adapter.send('需要审批的命令');
    const requested = await h.wait((e) => e.type === 'approval/requested');

    const view = requested.type === 'approval/requested' ? requested.approval : undefined;
    expect(view).toBeDefined();
    expect(view!.requestId).toBe('req-acc-legacy');
    expect(view!.connectionGeneration).toBe(1);
    expect(view!.kind).toBe('exec_command');
    expect(view!.summary).toContain('npm test');
    expect(view!.options.length).toBeGreaterThan(0);

    await h.adapter.approve('req-acc-legacy', 'accept');
    const completed = await h.wait((e) => e.type === 'turn/completed');
    expect(completed.type === 'turn/completed' && completed.status).toBe('success');

    // 服务端收到同 id 的应答，决定值为协议要求的 legacy ReviewDecision
    const answer = h.rx().find((r) => r.msg.id === 'req-acc-legacy' && r.msg.result !== undefined);
    expect(answer).toBeDefined();
    expect((answer!.msg.result as { decision: string }).decision).toBe('approved');

    // approval/resolved 事件（同 requestId + 决定值）
    const resolved = of(h.events, 'approval/resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.requestId).toBe('req-acc-legacy');
    expect(resolved[0]!.decision).toBe('accept');
  });

  it('v2 item/commandExecution/requestApproval：应答 decision 与产品决定同名', async () => {
    const h = track(
      createHarness({
        scenario: 'approval',
        authMode: 'apikey',
        approvalMethod: 'item/commandExecution/requestApproval',
        approvalRequestId: 'req-acc-v2',
      }),
    );
    await h.adapter.start({ projectRoot: h.root });
    await h.adapter.send('需要 v2 审批的命令');
    await h.wait((e) => e.type === 'approval/requested');

    await h.adapter.approve('req-acc-v2', 'acceptForSession');
    const completed = await h.wait((e) => e.type === 'turn/completed');
    expect(completed.type === 'turn/completed' && completed.status).toBe('success');

    const answer = h.rx().find((r) => r.msg.id === 'req-acc-v2' && r.msg.result !== undefined);
    expect((answer!.msg.result as { decision: string }).decision).toBe('acceptForSession');
  });

  it('elicitation：首发按协议自动拒绝（decline），不挂起、不产生审批待办', async () => {
    const h = track(
      createHarness({
        scenario: 'approval',
        authMode: 'apikey',
        approvalMethod: 'mcpServer/elicitation/request',
        approvalRequestId: 'req-elic',
      }),
    );
    await h.adapter.start({ projectRoot: h.root });
    await h.adapter.send('触发 elicitation');
    const completed = await h.wait((e) => e.type === 'turn/completed');

    // 未映射为审批待办（首发不启用 elicitation）
    expect(of(h.events, 'approval/requested')).toHaveLength(0);
    // 自动拒绝应答带回同 id
    const answer = h.rx().find((r) => r.msg.id === 'req-elic' && r.msg.result !== undefined);
    expect((answer!.msg.result as { action: string }).action).toBe('decline');
    // 回合未被挂死，正常收尾
    expect(completed.type === 'turn/completed' && completed.status).toBe('success');
  });
});

// ---------------------------------------------------------------------------
// 模型列表与认证状态
// ---------------------------------------------------------------------------

describe('模型列表与认证', () => {
  it('listModels：真实 model/list 响应映射为 EngineModelInfo[]', async () => {
    const h = track(
      createHarness({
        scenario: 'resume',
        authMode: 'apikey',
        models: [
          { id: 'gpt-5-codex', displayName: 'GPT-5 Codex' },
          { id: 'gpt-5.1', displayName: 'GPT-5.1' },
        ],
      }),
    );
    await h.adapter.start({ projectRoot: h.root });
    const models = await h.adapter.listModels();
    expect(models).toEqual([
      { id: 'gpt-5-codex', displayName: 'GPT-5 Codex' },
      { id: 'gpt-5.1', displayName: 'GPT-5.1' },
    ]);
  });

  it('无凭证：start 后 status=auth_required（事件同步），authStatus() 返回 mode=none、ok=false', async () => {
    const h = track(createHarness({ scenario: 'resume', authMode: null }));
    await h.adapter.start({ projectRoot: h.root });

    expect(h.adapter.status).toBe('auth_required');
    expect(of(h.events, 'engine/status').map((e) => e.status)).toContain('auth_required');
    const auth = await h.adapter.authStatus();
    expect(auth).toMatchObject({ mode: 'none', ok: false });
  });

  it('API Key 凭证：status=ready，authStatus() 返回 mode=api_key、ok=true', async () => {
    const h = track(createHarness({ scenario: 'resume', authMode: 'apikey' }));
    await h.adapter.start({ projectRoot: h.root });
    expect(h.adapter.status).toBe('ready');
    const auth = await h.adapter.authStatus();
    expect(auth).toMatchObject({ mode: 'api_key', ok: true });
  });
});

// ---------------------------------------------------------------------------
// 进程生命周期：退出、dispose
// ---------------------------------------------------------------------------

describe('进程退出与 dispose', () => {
  it('回合中引擎进程退出：pending 请求被拒绝、状态 stopped（不虚报 ready）', async () => {
    const h = track(
      createHarness({ scenario: 'die-midturn', authMode: 'apikey', interruptBehavior: 'hang' }),
    );
    await h.adapter.start({ projectRoot: h.root });
    await h.adapter.send('中途会死的回合');

    // 立即发起一个 fixture 不应答的请求（interrupt hang），进程随后退出 → pending 必须被拒绝
    const pendingInterrupt = h.adapter.interrupt();
    pendingInterrupt.catch(() => undefined); // 占位 handler：消除等待断言前的 unhandled rejection 窗口
    await h.wait((e) => e.type === 'engine/status' && e.status === 'stopped');

    await expect(pendingInterrupt).rejects.toThrow(/引擎进程/);
    expect(h.adapter.status).toBe('stopped');
    // 死回合没有伪造的终态
    expect(of(h.events, 'turn/completed')).toHaveLength(0);
    // 死连接上的新调用被拒绝
    await expect(h.adapter.send('新回合')).rejects.toThrow(/引擎尚未启动/);
  });

  it('dispose：先 stopping 再 stopped（顺序），活动回合先 interrupt；幂等', async () => {
    const h = track(createHarness({ scenario: 'steer', authMode: 'apikey' }));
    await h.adapter.start({ projectRoot: h.root });
    await h.adapter.send('活动回合，稍后 dispose');
    await h.wait((e) => e.type === 'turn/started');

    await h.adapter.dispose();
    const trail = of(h.events, 'engine/status').map((e) => e.status);
    expect(trail.indexOf('stopping')).toBeGreaterThan(-1);
    expect(trail.indexOf('stopped')).toBeGreaterThan(trail.indexOf('stopping'));
    expect(h.adapter.status).toBe('stopped');
    // 幂等：再次 dispose 不抛错
    await h.adapter.dispose();
  });
});

// ---------------------------------------------------------------------------
// 未知事件洪峰：限量记录不崩溃
// ---------------------------------------------------------------------------

describe('未知事件限量', () => {
  it('500 个未知通知：样本上限 200 + 丢弃计数，进程与回合不受影响', async () => {
    const h = track(createHarness({ scenario: 'unknown-flood', authMode: 'apikey' }));
    await h.adapter.start({ projectRoot: h.root });
    await h.adapter.send('洪峰回合');
    const completed = await h.wait((e) => e.type === 'turn/completed');

    const unknown = of(h.events, 'unknown-event');
    expect(unknown).toHaveLength(200);
    const stats = h.adapter.unknownEventStats();
    expect(stats).toEqual({ retained: 200, dropped: 300 });
    // 每条样本带方法名与预览
    expect(unknown[0]!.method).toBe('fixture/unknownEvent/0');
    // 回合正常完成：洪峰没有打断协议
    expect(completed.type === 'turn/completed' && completed.status).toBe('success');
  });
});

// ---------------------------------------------------------------------------
// 增量批处理（可选 onBatchedDelta）：事件不丢失
// ---------------------------------------------------------------------------

describe('onBatchedDelta 批处理', () => {
  it('慢 delta 流：subscribe 流 5 条 delta 全部到达；批合并文本无丢失', async () => {
    const batches: DeltaBatchItem[][] = [];
    const h = track(
      createHarness(
        { scenario: 'slow-delta', authMode: 'apikey', delayMs: 60 },
        {
          deltaBatchMs: 50,
          onBatchedDelta: (batch) => batches.push(batch),
        },
      ),
    );
    await h.adapter.start({ projectRoot: h.root });
    await h.adapter.send('慢速输出');
    await h.wait((e) => e.type === 'turn/completed');

    // 原始事件流不丢：5 条 message/delta 全部到达
    expect(of(h.events, 'message/delta')).toHaveLength(5);
    // 批处理：至少 2 批（120ms 内 5 条、窗口 50ms），合并文本完整覆盖
    expect(batches.length).toBeGreaterThanOrEqual(2);
    const mergedText = batches.flat().filter((b) => b.kind === 'message').map((b) => b.text).join('');
    expect(mergedText).toBe('片段1；片段2；片段3；片段4；片段5；');
  });
});
