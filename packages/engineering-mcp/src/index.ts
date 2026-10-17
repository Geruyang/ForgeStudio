/**
 * @forgedesk/engineering-mcp —— 工程工具 MCP stdio 服务。
 * 七工具（contracts 冻结）经 runner 控制协议桥接到唯一权威执行器实例。
 */
export { createMcpServer, MCP_SERVER_NAME, DEFAULT_PROTOCOL_VERSION, type McpServer, type McpServerOptions, type JsonRpcResponse } from './server.ts';
export { attachStdio } from './stdio.ts';
export { RunnerBridge, type RunnerBridgeOptions, type BridgeOk } from './bridge.ts';
export { MCP_TOOLS, TOOL_ROUTE, type McpToolDefinition, type JsonSchemaLiteral } from './tools.ts';
