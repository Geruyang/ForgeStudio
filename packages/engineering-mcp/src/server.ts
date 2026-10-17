/**
 * MCP stdio 服务器（手写实现，不加依赖）：
 * - JSON-RPC 2.0，换行分隔消息（MCP stdio 传输）
 * - initialize（回显协议版本、capabilities.tools、serverInfo、instructions=contracts MCP_SERVER_INSTRUCTIONS）
 * - notifications/initialized 等通知不应答
 * - tools/list（七工具，手写 JSON Schema）；tools/call（zod 校验 → 桥接 runner → content:[{type:'text'}]）
 * - 未知方法 → JSON-RPC 错误 -32601；参数非法 → -32602
 */
import type { EngineeringToolName, ToolFailure } from '@forgedesk/contracts/mcp';
import {
  InspectInputSchema,
  BuildInputSchema,
  TestInputSchema,
  DeviceBindInputSchema,
  DeviceFlashInputSchema,
  DeviceVerifyInputSchema,
  ExportInputSchema,
  MCP_SERVER_INSTRUCTIONS,
} from '@forgedesk/contracts/mcp';
import type { ZodTypeAny } from 'zod';
import { MCP_TOOLS } from './tools.ts';
import type { RunnerBridge } from './bridge.ts';

export const MCP_SERVER_NAME = 'forgedesk-engineering';
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

/** 工具名 → zod 输入校验 schema（契约冻结） */
const TOOL_INPUT_SCHEMA: Record<EngineeringToolName, ZodTypeAny> = {
  'engineering.inspect': InspectInputSchema,
  'engineering.build': BuildInputSchema,
  'engineering.test': TestInputSchema,
  'device.bind': DeviceBindInputSchema,
  'device.flash': DeviceFlashInputSchema,
  'device.verify': DeviceVerifyInputSchema,
  'engineering.export': ExportInputSchema,
};

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpServerOptions {
  bridge: RunnerBridge;
  version?: string;
  /** 工具调用的整体预算（桥接/HTTP 卡死保护） */
  callTimeoutMs?: number;
}

export interface McpServer {
  /** 处理一条消息；通知（无 id）返回 null */
  handleMessage(message: unknown): Promise<JsonRpcResponse | null>;
}

export function createMcpServer(opts: McpServerOptions): McpServer {
  const version = opts.version ?? '0.1.0';
  const callTimeoutMs = opts.callTimeoutMs ?? 600_000;

  const respond = (id: number | string | null, result: unknown): JsonRpcResponse => ({
    jsonrpc: '2.0',
    id,
    result,
  });
  const respondError = (
    id: number | string | null,
    code: number,
    message: string,
    data?: unknown,
  ): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message, data } });

  async function handleToolsCall(id: number | string | null, params: unknown): Promise<JsonRpcResponse> {
    const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
    const name = p.name;
    if (typeof name !== 'string' || !(name in TOOL_INPUT_SCHEMA)) {
      return respondError(id, -32602, `未知工具: ${String(name)}`, {
        supported: Object.keys(TOOL_INPUT_SCHEMA),
      });
    }
    const toolName = name as EngineeringToolName;
    const args = (p.arguments ?? {}) as Record<string, unknown>;
    const parsed = TOOL_INPUT_SCHEMA[toolName].safeParse(args);
    if (!parsed.success) {
      return respondError(
        id,
        -32602,
        `工具参数不合法: ${parsed.error.errors.map((e) => `${e.path.join('.')} ${e.message}`).join('; ')}`,
      );
    }
    // 桥接 runner：等待操作终态；失败 → isError:true + ToolFailure JSON（不崩进程）
    const bridged = await Promise.race([
      opts.bridge.callTool(toolName, args),
      new Promise<ToolFailure>((resolve) =>
        setTimeout(
          () => resolve({ ok: false, kind: 'timeout', message: '工具调用超时（runner 未在预算内返回）' }),
          callTimeoutMs,
        ),
      ),
    ]);
    if (!bridged.ok) {
      // 连接层失败（未到达工具执行）
      return respond(id, {
        content: [{ type: 'text', text: JSON.stringify(bridged, null, 2) }],
        isError: true,
      });
    }
    const body = bridged.body as { result?: unknown; status?: unknown };
    const result = body?.result;
    if (result === undefined) {
      // 异步语义下应始终 wait=true；防御：无结果视为未知
      return respond(id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              kind: 'unknown_result',
              message: 'runner 返回无结果（操作未完成或响应异常）',
            } satisfies ToolFailure),
          },
        ],
        isError: true,
      });
    }
    const isToolFailure =
      typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === false;
    return respond(id, {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      ...(isToolFailure ? { isError: true } : {}),
    });
  }

  return {
    async handleMessage(message: unknown): Promise<JsonRpcResponse | null> {
      if (message === null || typeof message !== 'object' || Array.isArray(message)) {
        return respondError(null, -32600, '无效的 JSON-RPC 消息');
      }
      const msg = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
      const id = typeof msg.id === 'number' || typeof msg.id === 'string' ? msg.id : null;
      const method = typeof msg.method === 'string' ? msg.method : '';
      if (method === '') {
        return id === null ? null : respondError(id, -32600, '缺少 method');
      }
      // 通知（无 id）：initialized / cancelled 等静默处理
      if (msg.id === undefined) {
        return null;
      }
      switch (method) {
        case 'initialize': {
          const params = (msg.params ?? {}) as { protocolVersion?: unknown };
          const protocolVersion =
            typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL_VERSION;
          return respond(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: MCP_SERVER_NAME, version },
            instructions: MCP_SERVER_INSTRUCTIONS,
          });
        }
        case 'ping':
          return respond(id, {});
        case 'tools/list':
          return respond(id, {
            tools: MCP_TOOLS.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          });
        case 'tools/call':
          return await handleToolsCall(id, msg.params);
        default:
          return respondError(id, -32601, `未知方法: ${method}`);
      }
    },
  };
}
