/**
 * MCP 桥入口：codex 按产品 CODEX_HOME/config.toml 以
 * `ForgeDesk.exe <mcp-bridge.cjs>`（ELECTRON_RUN_AS_NODE=1）拉起本进程。
 * 读发现文件连 runner 控制面，代理七工具（无状态；重启不产生第二个设备所有者）。
 */
import { createMcpServer, attachStdio, RunnerBridge } from '@forgedesk/engineering-mcp';

async function main(): Promise<void> {
  const dataDir = process.env.FD_RUNNER_DATA_DIR;
  if (!dataDir) {
    process.stderr.write('[fd-mcp-bridge] 缺少 FD_RUNNER_DATA_DIR 环境变量\n');
    process.exit(1);
  }
  // 发现文件等待逻辑内置于 RunnerBridge（20s 轮询，runner 未就绪时结构化失败不崩进程）
  const bridge = new RunnerBridge({ dataDir });
  const server = createMcpServer({ bridge });
  attachStdio(server);
}

void main().catch((err: unknown) => {
  process.stderr.write(`[fd-mcp-bridge] 启动失败: ${String(err)}\n`);
  process.exit(1);
});
