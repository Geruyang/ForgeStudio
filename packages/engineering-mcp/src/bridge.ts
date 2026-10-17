/**
 * Runner HTTP 桥接：按发现文件（runner-discovery.json）连接 runner 控制面。
 * - 发现文件不存在 → 最多等 startup_timeout_sec（默认 20s，MCP config 约定）
 * - runner 不可用 / 非 200 → 返回结构化 ToolFailure（不崩进程）
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { RUNNER_DISCOVERY_FILE, type RunnerDiscovery } from '@forgedesk/contracts/runner';
import type { EngineeringToolName, ToolFailure } from '@forgedesk/contracts/mcp';
import { TOOL_ROUTE } from './tools.ts';

export interface RunnerBridgeOptions {
  /** runner 数据目录（发现文件所在；缺省取 FD_RUNNER_DATA_DIR 环境变量） */
  dataDir?: string;
  startupTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
}

const FAILURE_KINDS: readonly ToolFailure['kind'][] = [
  'environment_missing',
  'connection_failure',
  'permission_denied',
  'timeout',
  'unknown_result',
  'internal_error',
];

function asFailureKind(v: unknown): ToolFailure['kind'] | undefined {
  return typeof v === 'string' && (FAILURE_KINDS as readonly string[]).includes(v)
    ? (v as ToolFailure['kind'])
    : undefined;
}

export interface BridgeOk {
  ok: true;
  /** runner 操作调用响应体：{operationId, status, result?} */
  body: unknown;
}

export class RunnerBridge {
  private readonly dataDir: string | undefined;
  private readonly startupTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private discovery: RunnerDiscovery | null = null;

  constructor(opts: RunnerBridgeOptions = {}) {
    this.dataDir = opts.dataDir ?? process.env['FD_RUNNER_DATA_DIR'];
    this.startupTimeoutMs = opts.startupTimeoutMs ?? 20_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.pollIntervalMs = opts.pollIntervalMs ?? 200;
  }

  discoveryPath(): string | undefined {
    return this.dataDir ? path.join(this.dataDir, RUNNER_DISCOVERY_FILE) : undefined;
  }

  /** 读取发现文件（不存在返回 null） */
  private async readDiscovery(): Promise<RunnerDiscovery | null> {
    const p = this.discoveryPath();
    if (!p) return null;
    try {
      const raw = await fsp.readFile(p, 'utf8');
      const parsed = JSON.parse(raw) as RunnerDiscovery;
      if (typeof parsed.port === 'number' && typeof parsed.token === 'string') return parsed;
      return null;
    } catch {
      return null;
    }
  }

  /** 等待发现文件就绪（最多 startupTimeoutMs） */
  async ensureDiscovery(): Promise<RunnerDiscovery | null> {
    if (this.discovery) return this.discovery;
    const deadline = Date.now() + this.startupTimeoutMs;
    for (;;) {
      const found = await this.readDiscovery();
      if (found) {
        this.discovery = found;
        return found;
      }
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  /** 失配时丢弃缓存（下次调用重新等待/读取） */
  invalidate(): void {
    this.discovery = null;
  }

  /**
   * 调用工具：转发到 runner HTTP（?wait=true 等待操作终态）。
   * 网络失败/超时 → connection_failure；HTTP 非 200 → 按 body.kind 映射。
   */
  async callTool(tool: EngineeringToolName, args: Record<string, unknown>): Promise<BridgeOk | ToolFailure> {
    const discovery = await this.ensureDiscovery();
    if (!discovery) {
      return {
        ok: false,
        kind: 'connection_failure',
        message: 'runner 发现文件不可用（未就绪或已退出）：无法连接工程执行器',
      };
    }
    const route = TOOL_ROUTE[tool];
    let response: Response;
    try {
      response = await this.fetchImpl(`http://127.0.0.1:${discovery.port}${route}?wait=true`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${discovery.token}`,
          host: `127.0.0.1:${discovery.port}`,
        },
        body: JSON.stringify(args),
      });
    } catch (error) {
      // runner 已死：丢弃发现缓存（下次等待新实例）
      this.invalidate();
      return {
        ok: false,
        kind: 'connection_failure',
        message: `连接 runner 失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const text = await response.text().catch(() => '');
    let body: unknown = undefined;
    try {
      body = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (response.status === 200) {
      return { ok: true, body };
    }
    const b = (body ?? {}) as Record<string, unknown>;
    return {
      ok: false,
      kind: asFailureKind(b.kind) ?? (response.status === 401 ? 'permission_denied' : 'internal_error'),
      message: typeof b.message === 'string' ? b.message : `runner HTTP ${response.status}`,
      operationId: typeof b.operationId === 'string' ? b.operationId : undefined,
    };
  }
}
