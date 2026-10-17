/**
 * stdio 传输挂接：换行分隔 JSON（MCP stdio 约定）。
 * 每行一条 JSON-RPC 消息；响应单行写回 stdout；解析失败回 -32700。
 */
import * as readline from 'node:readline';
import type { McpServer } from './server.ts';

export function attachStdio(
  server: McpServer,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): () => void {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const write = (message: unknown): void => {
    output.write(`${JSON.stringify(message)}\n`);
  };
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '解析错误：不是合法 JSON' } });
      return;
    }
    void server
      .handleMessage(parsed)
      .then((response) => {
        if (response !== null) write(response);
      })
      .catch((error: unknown) => {
        write({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: `内部错误: ${error instanceof Error ? error.message : String(error)}` },
        });
      });
  });
  return () => rl.close();
}
