/**
 * 路径解析：开发态与安装态统一入口。
 * 引擎 CODEX_HOME 独立于 %USERPROFILE%\.codex（任务书 §6.2 隔离基线）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';

const thisDir = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根（dev）；prod 下该值无意义，勿使用 */
export const repoRootDev = path.resolve(thisDir, '..', '..', '..', '..');

export interface AppPaths {
  isDev: boolean;
  /** 产品数据目录（数据库、证据、导出、设置） */
  dataDir: string;
  /** 产品专属引擎 CODEX_HOME */
  engineHome: string;
  /** 会话/补丁存储目录（engine-adapter） */
  sessionStorageDir: string;
  /** vendored Codex CLI 主程序 */
  codexCliPath: string;
  /** runner 服务 bundle（utilityProcess 加载） */
  runnerServicePath: string;
  /** MCP 桥 bundle（codex 按产品 config.toml 拉起） */
  mcpBridgePath: string;
  /** 随包工程 profile 模板目录（只读） */
  bundledProfilesDir: string;
  /** 主程序可执行文件（prod = ForgeDesk.exe；dev = electron.exe） */
  selfExePath: string;
}

export function resolveAppPaths(): AppPaths {
  const isDev = !app.isPackaged;
  if (isDev) {
    const dataDir = path.join(repoRootDev, '.runtime', 'app-data');
    return {
      isDev,
      dataDir,
      engineHome: path.join(dataDir, 'engine'),
      sessionStorageDir: path.join(dataDir, 'engine-sessions'),
      codexCliPath: path.join(repoRootDev, 'tools', 'vendored', 'codex', 'bin', 'codex.exe'),
      runnerServicePath: path.join(repoRootDev, 'apps', 'desktop', 'dist', 'runner', 'service.cjs'),
      mcpBridgePath: path.join(repoRootDev, 'apps', 'desktop', 'dist', 'bridge', 'mcp-bridge.cjs'),
      bundledProfilesDir: path.join(repoRootDev, 'engineering', 'profiles'),
      selfExePath: process.execPath,
    };
  }
  const resources = process.resourcesPath;
  const dataDir = app.getPath('userData');
  return {
    isDev,
    dataDir,
    engineHome: path.join(dataDir, 'engine'),
    sessionStorageDir: path.join(dataDir, 'engine-sessions'),
    codexCliPath: path.join(resources, 'engine', 'codex', 'bin', 'codex.exe'),
    runnerServicePath: path.join(resources, 'fd-runner', 'service.cjs'),
    mcpBridgePath: path.join(resources, 'fd-bridge', 'mcp-bridge.cjs'),
    bundledProfilesDir: path.join(resources, 'engineering', 'profiles'),
    selfExePath: process.execPath,
  };
}
