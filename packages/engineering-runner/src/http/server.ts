/**
 * HTTP 控制面（node:http，无框架）：
 * - 监听 127.0.0.1 随机端口；Bearer Token 校验（401 统一拒绝，不回显 token）
 * - Host 头只允许 127.0.0.1/localhost（防 DNS 重绑定）
 * - 路由按 contracts RUNNER_ROUTES 全量实现；未知路由 404、方法不符 405
 * - 操作路由：默认异步返回 operationId；?wait=true 等待终态（MCP 桥接使用）
 * - SSE /api/events：?since=seq 重放 + 实时推送（text/event-stream）
 */
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { URL } from 'node:url';
import { z } from 'zod';
import type { RunnerEvent } from '@forgedesk/contracts/runner';
import {
  CreateTaskRequestSchema,
  AcceptanceUpdateSchema,
  ManualReviewSchema,
  CancelRequestSchema,
  AuthorizeRequestSchema,
  OP_ROUTES,
  OperationInputSchema,
} from './request-schemas.ts';
import { OpsEngine, NotFoundError, BadRequestError } from '../ops/engine.ts';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const SSE_HEARTBEAT_MS = 15_000;

export interface RunnerHttpOptions {
  engine: OpsEngine;
  token: string;
  port?: number;
}

export interface RunnerHttpServer {
  server: http.Server;
  port: number;
  close(): Promise<void>;
}

function tokensEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const hostname = hostHeader.split(':')[0].trim().toLowerCase();
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

interface HttpErrorBody {
  ok: false;
  kind: 'permission_denied' | 'internal_error';
  message: string;
}

export async function createRunnerHttp(opts: RunnerHttpOptions): Promise<RunnerHttpServer> {
  const { engine, token } = opts;
  const sseClients = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({ ok: false, kind: 'internal_error', message } satisfies HttpErrorBody));
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    // Host 头只允许回环地址
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ok: false,
          kind: 'permission_denied',
          message: 'Host 非法（只允许 127.0.0.1/localhost）',
        } satisfies HttpErrorBody),
      );
      return;
    }

    // Bearer Token 校验（401 统一拒绝；不回显 token）
    const auth = req.headers.authorization ?? '';
    const presented = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
    if (!presented || !tokensEqual(presented, token)) {
      res.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'www-authenticate': 'Bearer',
      });
      res.end(JSON.stringify({ ok: false, kind: 'permission_denied', message: '鉴权失败' } satisfies HttpErrorBody));
      return;
    }

    // 路由解析：已知路径方法不符 → 405；未知 → 404
    const route = resolveRoute(pathname);
    if (route === null) {
      sendError(res, new NotFoundError(`未知路由: ${method} ${pathname}`));
      return;
    }
    if (!(route.methods as readonly string[]).includes(method)) {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: route.methods.join(', ') });
      res.end(JSON.stringify({ ok: false, kind: 'permission_denied', message: '方法不允许' } satisfies HttpErrorBody));
      return;
    }

    // SSE 事件流（GET /api/events）
    if (route.name === 'events') {
      handleSse(req, res, url);
      return;
    }

    if (method === 'GET') {
      switch (route.name) {
        case 'health':
          sendJson(res, 200, { ok: true, uptimeMs: Date.now() });
          return;
        case 'listTasks': {
          // 契约（ipc.ts listTasks: TaskOverview[]）：列表返回完整概览。
          // 修复：此前仅返回存储层瘦条目（缺 acceptance/operations/artifacts/hasStaleEvidence），
          // renderer asTaskOverview 校验会把所有任务滤掉——真实应用任务列表恒空（GUI 走查发现）。
          const tasks = engine.listTasks();
          const overviews = await Promise.all(
            tasks.map(async (t) => {
              try {
                return await engine.getOverview(t.id);
              } catch {
                return t; // 单任务概览组装失败时回退瘦条目，不拖垮整个列表
              }
            }),
          );
          sendJson(res, 200, overviews);
          return;
        }
        case 'getTask':
          try {
            sendJson(res, 200, await engine.getOverview(route.taskId));
          } catch (error) {
            sendError(res, error);
          }
          return;
        case 'listOperations':
          try {
            sendJson(res, 200, engine.listOperations(route.taskId));
          } catch (error) {
            sendError(res, error);
          }
          return;
        case 'pendingAuthorization':
          sendJson(res, 200, engine.pendingAuthorizations());
          return;
        case 'devices':
          sendJson(res, 200, await engine.listDevices());
          return;
        case 'profiles':
          sendJson(res, 200, await engine.listProfiles());
          return;
        case 'diagnostics':
          sendJson(res, 200, await engine.diagnostics());
          return;
      }
      return;
    }

    // POST
    const body = await readJsonBody(req, res);
    if (body === undefined) return; // 已应答
    switch (route.name) {
      case 'listTasks': {
        try {
          const input = CreateTaskRequestSchema.parse(body);
          sendJson(res, 201, await engine.createTask(input));
        } catch (error) {
          sendZodOrError(res, error);
        }
        return;
      }
      case 'updateAcceptance': {
        try {
          const input = AcceptanceUpdateSchema.parse(body);
          sendJson(res, 200, engine.updateAcceptance(route.taskId, input.items));
        } catch (error) {
          sendZodOrError(res, error);
        }
        return;
      }
      case 'manualReview': {
        try {
          const input = ManualReviewSchema.parse(body);
          sendJson(res, 200, engine.recordManualReview(route.taskId, route.itemId, input.decision, input.note));
        } catch (error) {
          sendZodOrError(res, error);
        }
        return;
      }
      case 'op': {
        try {
          const input = OperationInputSchema(route.opType).parse(body);
          const wait = url.searchParams.get('wait') === 'true';
          const result = await engine.callOperation(route.opType, input as Record<string, unknown>, { wait });
          sendJson(res, 200, result);
        } catch (error) {
          sendZodOrError(res, error);
        }
        return;
      }
      case 'cancel': {
        try {
          const input = CancelRequestSchema.parse(body);
          sendJson(res, 200, await engine.cancelOperation(route.operationId, input));
        } catch (error) {
          sendZodOrError(res, error);
        }
        return;
      }
      case 'authorize': {
        try {
          const input = AuthorizeRequestSchema.parse(body);
          sendJson(res, 200, engine.authorize(input));
        } catch (error) {
          sendZodOrError(res, error);
        }
        return;
      }
    }
  }

  /** 路由表：未知路径 null；已知路径返回允许方法（405 判定依据） */
  function resolveRoute(pathname: string):
    | null
    | { name: 'health'; methods: ['GET'] }
    | { name: 'listTasks'; methods: ['GET', 'POST'] }
    | { name: 'getTask'; methods: ['GET']; taskId: string }
    | { name: 'updateAcceptance'; methods: ['POST']; taskId: string }
    | { name: 'manualReview'; methods: ['POST']; taskId: string; itemId: string }
    | { name: 'listOperations'; methods: ['GET']; taskId: string }
    | { name: 'op'; methods: ['POST']; opType: import('@forgedesk/contracts/engineering').OperationType }
    | { name: 'cancel'; methods: ['POST']; operationId: string }
    | { name: 'pendingAuthorization'; methods: ['GET'] }
    | { name: 'authorize'; methods: ['POST'] }
    | { name: 'devices'; methods: ['GET'] }
    | { name: 'profiles'; methods: ['GET'] }
    | { name: 'events'; methods: ['GET'] }
    | { name: 'diagnostics'; methods: ['GET'] } {
    if (pathname === '/health') return { name: 'health', methods: ['GET'] };
    if (pathname === '/api/tasks') return { name: 'listTasks', methods: ['GET', 'POST'] };
    const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskMatch) return { name: 'getTask', methods: ['GET'], taskId: decodeURIComponent(taskMatch[1]) };
    const acceptanceMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/acceptance$/);
    if (acceptanceMatch) return { name: 'updateAcceptance', methods: ['POST'], taskId: decodeURIComponent(acceptanceMatch[1]) };
    const manualReviewMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/acceptance\/([^/]+)\/manual-review$/);
    if (manualReviewMatch)
      return {
        name: 'manualReview',
        methods: ['POST'],
        taskId: decodeURIComponent(manualReviewMatch[1]),
        itemId: decodeURIComponent(manualReviewMatch[2]),
      };
    const opsMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/operations$/);
    if (opsMatch) return { name: 'listOperations', methods: ['GET'], taskId: decodeURIComponent(opsMatch[1]) };
    const opRoute = OP_ROUTES[pathname];
    if (opRoute) return { name: 'op', methods: ['POST'], opType: opRoute.type };
    const cancelMatch = pathname.match(/^\/api\/ops\/([^/]+)\/cancel$/);
    if (cancelMatch) return { name: 'cancel', methods: ['POST'], operationId: decodeURIComponent(cancelMatch[1]) };
    if (pathname === '/api/pending-authorization') return { name: 'pendingAuthorization', methods: ['GET'] };
    if (pathname === '/api/ops/authorize') return { name: 'authorize', methods: ['POST'] };
    if (pathname === '/api/devices') return { name: 'devices', methods: ['GET'] };
    if (pathname === '/api/profiles') return { name: 'profiles', methods: ['GET'] };
    if (pathname === '/api/events') return { name: 'events', methods: ['GET'] };
    if (pathname === '/api/diagnostics') return { name: 'diagnostics', methods: ['GET'] };
    return null;
  }

  function handleSse(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const sinceRaw = Number(url.searchParams.get('since') ?? '0');
    const since = Number.isFinite(sinceRaw) && sinceRaw >= 0 ? sinceRaw : 0;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    sseClients.add(res);
    const write = (event: RunnerEvent) => {
      res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    // 先重放 since 之后的事件，再接实时流
    for (const event of engine.eventsSince(since)) {
      write(event);
    }
    const unsubscribe = engine.subscribe(write);
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, SSE_HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      sseClients.delete(res);
    });
  }

  function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  function sendError(res: http.ServerResponse, error: unknown): void {
    if (error instanceof NotFoundError) {
      sendJson(res, 404, { ok: false, kind: 'permission_denied', message: error.message } satisfies HttpErrorBody);
      return;
    }
    if (error instanceof BadRequestError) {
      sendJson(res, 400, { ok: false, kind: 'permission_denied', message: error.message } satisfies HttpErrorBody);
      return;
    }
    sendJson(res, 500, {
      ok: false,
      kind: 'internal_error',
      message: error instanceof Error ? error.message : String(error),
    } satisfies HttpErrorBody);
  }

  function sendZodOrError(res: http.ServerResponse, error: unknown): void {
    if (error instanceof z.ZodError) {
      sendJson(res, 400, {
        ok: false,
        kind: 'permission_denied',
        message: `请求参数不合法: ${error.errors.map((e) => `${e.path.join('.')} ${e.message}`).join('; ')}`,
      } satisfies HttpErrorBody);
      return;
    }
    sendError(res, error);
  }

  async function readJsonBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<unknown | undefined> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, kind: 'permission_denied', message: '请求体过大' } satisfies HttpErrorBody));
        return undefined;
      }
      chunks.push(buf);
    }
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      sendError(res, new BadRequestError('请求体不是合法 JSON'));
      return undefined;
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('监听地址异常');
  }

  return {
    server,
    port: address.port,
    close: async () => {
      for (const res of sseClients) {
        res.end();
      }
      sseClients.clear();
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
