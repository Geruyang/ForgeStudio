#!/usr/bin/env node
/**
 * ForgeDesk engine-adapter 测试 fixture：脚本化的 app-server 协议对端进程。
 *
 * 【fixture 协议进程，非模型调用】——仅用于以真实 spawn 驱动 engine-adapter 的
 * 进程/JSONL/握手/审批/投影行为验证；不进行任何模型推理。
 *
 * 配置（优先级：FD_FIXTURE_CONFIG_FILE 环境变量指向的 JSON 文件 > FD_FIXTURE_CONFIG JSON 字符串）：
 *   scenario: 'basic' | 'approval' | 'steer' | 'interrupt' | 'patches' | 'unknown-flood' | 'die-midturn' | 'slow-delta' | 'resume'
 *   initializeBehavior: 'ok' | 'error' | 'hang' | 'slow'（握手成功/失败/挂起/慢响应）
 *   threadStartBehavior: 'ok' | 'error'
 *   threadId / turnId / authMode(null|'apikey'|'chatgpt') / models[]
 *   turnStatus: 'completed' | 'failed' | 'interrupted'（basic 场景的回合终态）
 *   approvalMethod: 服务端审批请求方法名（legacy/v2/未知/禁用项均可）
 *   approvalRequestId: 审批请求使用的 JSON-RPC id
 *   steerBehavior: 'ok' | 'error-mismatch' | 'error-ended' | 'slow'
 *   interruptBehavior: 'ok' | 'hang'
 *   delayMs / unknownEventCount / exitCode / emitThreadStarted / errorNotification
 *
 * 接收到的每条消息以 JSONL 追加到 FD_FIXTURE_RX_LOG 指向的文件（供测试断言应答 id / 决定值）。
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

const configPath = process.env.FD_FIXTURE_CONFIG_FILE;
let config = {};
if (configPath && existsSync(configPath)) {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} else if (process.env.FD_FIXTURE_CONFIG) {
  config = JSON.parse(process.env.FD_FIXTURE_CONFIG);
}

const C = {
  scenario: config.scenario ?? 'basic',
  initializeBehavior: config.initializeBehavior ?? 'ok',
  threadStartBehavior: config.threadStartBehavior ?? 'ok',
  threadId: config.threadId ?? 'th-fixture-0001',
  turnId: config.turnId ?? 'tu-fixture-0001',
  authMode: config.authMode ?? null,
  models: config.models ?? [{ id: 'gpt-5-codex-fixture', displayName: 'GPT-5 Codex (fixture)' }],
  turnStatus: config.turnStatus ?? 'completed',
  approvalMethod: config.approvalMethod ?? 'execCommandApproval',
  approvalRequestId: config.approvalRequestId ?? 'req-100',
  steerBehavior: config.steerBehavior ?? 'ok',
  interruptBehavior: config.interruptBehavior ?? 'ok',
  delayMs: config.delayMs ?? 800,
  unknownEventCount: config.unknownEventCount ?? 500,
  exitCode: config.exitCode ?? 3,
  emitThreadStarted: config.emitThreadStarted ?? true,
  errorNotification: config.errorNotification ?? false,
  tokenUsage: config.tokenUsage ?? false,
};

const rxLog = process.env.FD_FIXTURE_RX_LOG ?? null;
const JSONRPC = '2.0';
const threadId = C.threadId;
const turnId = C.turnId;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
function logRx(parsed) {
  if (!rxLog) return;
  try {
    appendFileSync(rxLog, JSON.stringify({ at: Date.now(), msg: parsed }) + '\n', 'utf8');
  } catch {
    /* 日志失败不影响协议 */
  }
}
function sendResponse(id, result) {
  send({ jsonrpc: JSONRPC, id, result });
}
function sendError(id, code, message) {
  send({ jsonrpc: JSONRPC, id, error: { code, message } });
}
function notify(method, params) {
  send({ jsonrpc: JSONRPC, method, params });
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- 对象构造（与 codex 0.162.1 生成类型同形，字段取最小充分集） ----

function threadObj(id) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: '',
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: 'v2',
    modelProvider: 'openai',
    model: null,
    reasoningEffort: null,
    createdAt: now,
    updatedAt: now,
    recencyAt: now,
    status: 'idle',
    path: null,
    cwd: process.cwd(),
    cliVersion: '0.162.1-fixture',
    originator: null,
    source: 'app_server',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function userMessageItem(text) {
  return { type: 'userMessage', id: 'item-user-1', clientId: null, content: [{ type: 'text', text, text_elements: [] }] };
}

function turnObj(status, items, error = null) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: turnId,
    rootTurnId: turnId,
    items: items.slice(),
    itemsView: 'complete',
    status,
    error,
    startedAt: now,
    completedAt: status === 'inProgress' ? null : now,
    durationMs: status === 'inProgress' ? null : 1200,
  };
}

function turnError(message) {
  return { message, codexErrorInfo: 'internalServerError', additionalDetails: null, misalignment: null };
}

// ---- 回合脚本状态 ----

let turnActive = false;
let steerDelivered = false;
let approvalResolve = null;

function waitForApprovalResponse(id) {
  return new Promise((resolve) => {
    approvalResolve = { id: String(id), resolve };
    // 看门狗：适配层未应答时也推进脚本，避免悬挂（测试可因此失败并暴露问题）
    setTimeout(() => {
      if (approvalResolve && approvalResolve.id === String(id)) {
        approvalResolve = null;
        resolve({ watchdog: true });
      }
    }, 15000);
  });
}

function itemStarted(item) {
  notify('item/started', { item, threadId, turnId, startedAtMs: Date.now() });
}
function itemCompleted(item) {
  notify('item/completed', { item, threadId, turnId, completedAtMs: Date.now() });
}
function delta(itemId, text) {
  notify('item/agentMessage/delta', { threadId, turnId, itemId, delta: text });
}

function completeTurn(status, errorMessage) {
  if (!turnActive) return;
  turnActive = false;
  const items = [userMessageItem(lastUserText), agentMessageItem].filter(Boolean);
  notify('turn/completed', { threadId, turn: turnObj(status, items, errorMessage ? turnError(errorMessage) : null) });
}

let lastUserText = '(fixture turn)';
let agentMessageItem = null;

function approvalParamsFor(method) {
  switch (method) {
    case 'execCommandApproval':
      return {
        conversationId: threadId,
        callId: 'call-1',
        approvalId: null,
        command: ['npm', 'test'],
        cwd: 'E:\\proj',
        reason: '运行测试',
        parsedCmd: [],
      };
    case 'applyPatchApproval':
      return {
        conversationId: threadId,
        callId: 'call-2',
        fileChanges: {
          'src/a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-a\n+b\n', move_path: null },
        },
        reason: '修改文件',
        grantRoot: null,
      };
    case 'item/commandExecution/requestApproval':
      return {
        kind: 'command',
        threadId,
        turnId,
        itemId: 'item-cmd-1',
        startedAtMs: Date.now(),
        approvalId: null,
        environmentId: null,
        reason: '需要网络访问',
        command: 'npm test',
        cwd: 'E:\\proj',
        commandActions: [],
      };
    case 'item/fileChange/requestApproval':
      return { threadId, turnId, itemId: 'item-fc-1', startedAtMs: Date.now(), reason: '文件修改审批', grantRoot: null };
    case 'item/permissions/requestApproval':
      return {
        threadId,
        turnId,
        itemId: 'item-perm-1',
        startedAtMs: Date.now(),
        environmentId: null,
        cwd: 'E:\\proj',
        reason: '申请额外文件系统权限',
        permissions: { network: { enabled: true }, fileSystem: { read: ['E:\\proj\\extra'], write: null, entries: null } },
      };
    case 'item/tool/requestUserInput':
      return {
        threadId,
        turnId,
        itemId: 'item-ui-1',
        questions: [],
        isBlocking: true,
        autoResolutionMs: null,
      };
    case 'mcpServer/elicitation/request':
      return {
        threadId,
        turnId: null,
        serverName: 'fixture-mcp',
        mode: 'form',
        _meta: null,
        message: 'fixture elicitation（首发应拒绝）',
        requestedSchema: { type: 'object', properties: {} },
      };
    default:
      // 未知服务端请求：适配层必须按协议拒绝而不是挂起
      return { fixture: 'unknown-server-request' };
  }
}

async function sendApprovalRequest(method) {
  const id = C.approvalRequestId;
  send({ jsonrpc: JSONRPC, id, method, params: approvalParamsFor(method) });
  return waitForApprovalResponse(id);
}

// ---- 各场景回合脚本（fixture 协议进程，非模型调用） ----

async function runTurnScript() {
  switch (C.scenario) {
    case 'basic': {
      await sleep(30);
      itemStarted(userMessageItem(lastUserText)); // 与 turn/started.items 同 id：考验去重
      // reasoning 摘要增量（v2/ReasoningSummaryTextDeltaNotification 同形）
      notify('item/reasoning/summaryTextDelta', { threadId, turnId, itemId: 'rs-1', delta: '先分析需求，', summaryIndex: 0 });
      notify('item/reasoning/summaryTextDelta', { threadId, turnId, itemId: 'rs-1', delta: '再执行命令。', summaryIndex: 0 });
      // 工具调用：commandExecution item 完整生命周期（started → completed）
      const cmdItem = {
        type: 'commandExecution',
        id: 'item-cmd-basic',
        pluginId: null,
        scriptPath: null,
        command: 'npm test',
        cwd: 'E:\\proj',
        processId: null,
        source: 'shell',
        status: 'inProgress',
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      };
      itemStarted(cmdItem);
      cmdItem.status = 'completed';
      cmdItem.aggregatedOutput = 'fixture: 3 passed';
      cmdItem.exitCode = 0;
      cmdItem.durationMs = 300;
      itemCompleted(cmdItem);
      agentMessageItem = { type: 'agentMessage', id: 'msg-1', text: '', phase: null, memoryCitation: null, delivery: null, questions: null };
      itemStarted(agentMessageItem);
      delta('msg-1', '你好，');
      delta('msg-1', '这是 ');
      delta('msg-1', 'fixture 增量输出。');
      agentMessageItem.text = '你好，这是 fixture 增量输出。';
      itemCompleted(agentMessageItem);
      if (C.errorNotification) {
        notify('error', {
          error: turnError('fixture: 模拟模型调用失败'),
          willRetry: false,
          threadId,
          turnId,
        });
      }
      if (C.tokenUsage) {
        // v2/ThreadTokenUsageUpdatedNotification 原形：total 为线程累计口径
        notify('thread/tokenUsage/updated', {
          threadId,
          turnId,
          tokenUsage: {
            total: {
              totalTokens: 12500,
              inputTokens: 9000,
              cachedInputTokens: 4000,
              cacheWriteInputTokens: 200,
              outputTokens: 3500,
              reasoningOutputTokens: 1500,
            },
            last: {
              totalTokens: 3500,
              inputTokens: 2000,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              outputTokens: 1500,
              reasoningOutputTokens: 500,
            },
            modelContextWindow: 272000,
          },
        });
      }
      if (C.turnStatus === 'failed') {
        completeTurn('failed', 'fixture: 模拟上游失败');
      } else {
        completeTurn(C.turnStatus, null);
      }
      return;
    }
    case 'slow-delta': {
      // 慢增量流：每 delayMs（默认 60ms）一条 delta，考验增量不丢失与批处理窗口
      await sleep(30);
      agentMessageItem = { type: 'agentMessage', id: 'msg-1', text: '', phase: null, memoryCitation: null, delivery: null, questions: null };
      itemStarted(agentMessageItem);
      let full = '';
      for (let i = 1; i <= 5; i++) {
        const piece = `片段${i}；`;
        delta('msg-1', piece);
        full += piece;
        await sleep(C.delayMs && C.delayMs < 30 ? 30 : Math.min(C.delayMs, 120));
      }
      agentMessageItem.text = full;
      itemCompleted(agentMessageItem);
      completeTurn(C.turnStatus, null);
      return;
    }
    case 'approval': {
      await sleep(30);
      agentMessageItem = { type: 'agentMessage', id: 'msg-1', text: '', phase: null, memoryCitation: null, delivery: null, questions: null };
      itemStarted(agentMessageItem);
      await sendApprovalRequest(C.approvalMethod);
      delta('msg-1', '审批已应答，');
      delta('msg-1', '继续执行。');
      agentMessageItem.text = '审批已应答，继续执行。';
      itemCompleted(agentMessageItem);
      completeTurn('completed', null);
      return;
    }
    case 'steer': {
      await sleep(30);
      agentMessageItem = { type: 'agentMessage', id: 'msg-1', text: '', phase: null, memoryCitation: null, delivery: null, questions: null };
      itemStarted(agentMessageItem);
      delta('msg-1', '等待 steer 中……');
      // 保持活动回合，等待 turn/steer（或超时兜底完成）
      await sleep(12000);
      if (turnActive) completeTurn(C.turnStatus, null);
      return;
    }
    case 'interrupt': {
      await sleep(30);
      agentMessageItem = { type: 'agentMessage', id: 'msg-1', text: '', phase: null, memoryCitation: null, delivery: null, questions: null };
      itemStarted(agentMessageItem);
      delta('msg-1', '等待中断……');
      await sleep(12000);
      if (turnActive) completeTurn(C.turnStatus, null);
      return;
    }
    case 'patches': {
      await sleep(30);
      const fileChangeItem = {
        type: 'fileChange',
        id: 'item-fc-1',
        changes: [
          { path: 'src/a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old\n+new\n' },
          { path: 'src/b.ts', kind: { type: 'add' }, diff: '--- /dev/null\n+++ b/src/b.ts\n@@ -0,0 +1 @@\n+hello\n' },
        ],
        status: 'inProgress',
      };
      itemStarted(fileChangeItem);
      notify('item/fileChange/patchUpdated', {
        threadId,
        turnId,
        itemId: 'item-fc-1',
        changes: fileChangeItem.changes,
      });
      const diff =
        'diff --git a/src/a.ts b/src/a.ts\n' +
        '--- a/src/a.ts\n' +
        '+++ b/src/a.ts\n' +
        '@@ -1 +1 @@\n' +
        '-old\n' +
        '+new\n';
      notify('turn/diff/updated', { threadId, turnId, diff });
      // 同内容重复推送：适配层应按内容去重，不重复投影
      notify('turn/diff/updated', { threadId, turnId, diff });
      fileChangeItem.status = 'completed';
      itemCompleted(fileChangeItem);
      completeTurn('completed', null);
      return;
    }
    case 'unknown-flood': {
      await sleep(30);
      for (let i = 0; i < C.unknownEventCount; i++) {
        notify(`fixture/unknownEvent/${i}`, { index: i, payload: 'x'.repeat(64) });
      }
      completeTurn('completed', null);
      return;
    }
    case 'die-midturn': {
      await sleep(30);
      agentMessageItem = { type: 'agentMessage', id: 'msg-1', text: '', phase: null, memoryCitation: null, delivery: null, questions: null };
      itemStarted(agentMessageItem);
      delta('msg-1', '进程即将退出……');
      await sleep(50);
      process.exit(C.exitCode);
      return;
    }
    case 'resume':
    default:
      return;
  }
}

// ---- 请求分派 ----

function handleInitialize(msg) {
  if (C.initializeBehavior === 'error') {
    sendError(msg.id, -32000, 'fixture: initialize rejected');
    return;
  }
  if (C.initializeBehavior === 'hang') return;
  const respond = () =>
    sendResponse(msg.id, {
      userAgent: 'codex-fixture/0.162.1 (fixture 协议进程，非模型调用)',
      codexHome: process.env.CODEX_HOME ?? '',
      platformFamily: 'windows',
      platformOs: 'windows',
    });
  if (C.initializeBehavior === 'slow') setTimeout(respond, C.delayMs);
  else respond();
}

function handleThreadStart(msg) {
  if (C.threadStartBehavior === 'error') {
    sendError(msg.id, -32000, 'fixture: thread/start rejected');
    return;
  }
  sendResponse(msg.id, threadObj(threadId));
  if (C.emitThreadStarted) {
    notify('thread/started', { thread: threadObj(threadId) });
  }
}

function handleThreadResume(msg) {
  const id = msg.params && typeof msg.params.threadId === 'string' ? msg.params.threadId : threadId;
  sendResponse(msg.id, threadObj(id));
}

function handleTurnStart(msg) {
  const input = msg.params?.input;
  lastUserText = Array.isArray(input) && input[0] && typeof input[0].text === 'string' ? input[0].text : '(empty input)';
  sendResponse(msg.id, turnObj('inProgress', [userMessageItem(lastUserText)]));
  notify('turn/started', { threadId, turn: turnObj('inProgress', [userMessageItem(lastUserText)]) });
  turnActive = true;
  void runTurnScript();
}

function handleSteer(msg) {
  switch (C.steerBehavior) {
    case 'error-mismatch':
      sendError(msg.id, -32000, 'fixture: expected turn id mismatch（回合 ID 不匹配）');
      if (turnActive) {
        setTimeout(() => completeTurn(C.turnStatus, null), 100);
      }
      return;
    case 'error-ended':
      sendError(msg.id, -32000, 'fixture: turn already ended');
      if (turnActive) {
        setTimeout(() => completeTurn(C.turnStatus, null), 100);
      }
      return;
    case 'slow':
      setTimeout(() => {
        sendResponse(msg.id, {});
        steerDelivered = true;
        delta('msg-1', 'steer 追加内容已送达。');
        completeTurn(C.turnStatus, null);
      }, C.delayMs);
      return;
    default:
      sendResponse(msg.id, {});
      steerDelivered = true;
      if (C.scenario === 'steer') {
        delta('msg-1', 'steer 追加内容已送达。');
        completeTurn(C.turnStatus, null);
      }
      return;
  }
}

function handleInterrupt(msg) {
  if (C.interruptBehavior === 'hang') return; // 不应答：驱动侧靠超时/终态测试
  sendResponse(msg.id, {});
  if (turnActive) {
    completeTurn('interrupted', null);
  }
}

function dispatch(msg) {
  logRx(msg);
  if (typeof msg.method === 'string') {
    switch (msg.method) {
      case 'initialize':
        handleInitialize(msg);
        return;
      case 'initialized':
        return;
      case 'thread/start':
        handleThreadStart(msg);
        return;
      case 'thread/resume':
        handleThreadResume(msg);
        return;
      case 'turn/start':
        handleTurnStart(msg);
        return;
      case 'turn/steer':
        handleSteer(msg);
        return;
      case 'turn/interrupt':
        handleInterrupt(msg);
        return;
      case 'thread/name/set': {
        const name = String(msg.params?.name ?? '');
        sendResponse(msg.id, {});
        notify('thread/name/updated', { threadId: msg.params?.threadId ?? threadId, name });
        return;
      }
      case 'thread/delete':
        sendResponse(msg.id, {});
        notify('thread/deleted', { threadId: msg.params?.threadId ?? threadId });
        return;
      case 'review/start':
        sendResponse(msg.id, {});
        return;
      case 'thread/compact/start':
        sendResponse(msg.id, {});
        notify('thread/compacted', {
          threadId: msg.params?.threadId ?? threadId,
          turnId: msg.params?.turnId ?? turnId,
        });
        return;
      case 'model/list':
        sendResponse(msg.id, { data: C.models, nextCursor: null });
        return;
      case 'getAuthStatus':
        sendResponse(msg.id, {
          authMethod: C.authMode,
          authToken: null,
          requiresOpenaiAuth: C.authMode === null,
        });
        return;
      default:
        sendError(msg.id, -32601, `fixture: method not found: ${msg.method}`);
        return;
    }
  }
  // 应答（带 id、无 method）：审批请求的响应
  if (msg.id !== undefined && msg.id !== null && approvalResolve && approvalResolve.id === String(msg.id)) {
    const resolve = approvalResolve.resolve;
    approvalResolve = null;
    resolve({ response: msg });
  }
}

// ---- stdin 分帧 ----

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      dispatch(JSON.parse(line));
    } catch (e) {
      process.stderr.write(`fixture: 无法解析输入行：${String(e)}\n`);
    }
  }
});
process.stdin.on('close', () => {
  setTimeout(() => process.exit(0), 100);
});
process.stdin.on('end', () => {
  setTimeout(() => process.exit(0), 100);
});

// 看门狗：避免测试异常时遗留孤儿进程
setTimeout(() => process.exit(0), 120000).unref?.();

process.stderr.write('fixture app-server: started（fixture 协议进程，非模型调用）\n');
