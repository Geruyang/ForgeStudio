/**
 * Runner 服务入口：createRunnerService({dataDir, port?, token?})。
 * 组装 存储 / Profile 加载 / 操作引擎 / HTTP 控制面，写出发现文件；
 * main 进程与测试共用（命令行入口由集成负责人打包）。
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RUNNER_DISCOVERY_FILE, type RunnerDiscovery } from '@forgedesk/contracts/runner';
import { Storage } from './storage/database.ts';
import { ProfileLoader } from './profiles/loader.ts';
import { OpsEngine } from './ops/engine.ts';
import { createRunnerHttp, type RunnerHttpServer } from './http/server.ts';
import type { DeviceAdapterInjection } from './internal/device-port.ts';

export interface RunnerServiceOptions extends DeviceAdapterInjection {
  /** 数据目录（数据库、evidence、exports、发现文件所在） */
  dataDir: string;
  /** 固定端口（缺省随机）；测试可指定 */
  port?: number;
  /** 固定令牌（缺省每启动随机）；测试可指定 */
  token?: string;
  /** profile 目录（用户数据目录优先、模板目录其次；缺省 <dataDir>/profiles） */
  profileDirs?: string[];
  /** 优雅关闭等待在途操作的宽限（毫秒） */
  shutdownGraceMs?: number;
}

export interface RunnerService {
  port: number;
  token: string;
  dataDir: string;
  discoveryPath: string;
  storage: Storage;
  engine: OpsEngine;
  profiles: ProfileLoader;
  http: RunnerHttpServer;
  close(): Promise<void>;
}

export async function createRunnerService(opts: RunnerServiceOptions): Promise<RunnerService> {
  const dataDir = path.resolve(opts.dataDir);
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(path.join(dataDir, 'evidence'), { recursive: true });

  const token = opts.token ?? randomUUID();
  const storage = new Storage(dataDir);
  const profileDirs = opts.profileDirs ?? [path.join(dataDir, 'profiles')];
  const profiles = new ProfileLoader(profileDirs);
  await profiles.reload();

  const engine = new OpsEngine({ dataDir, storage, profiles, deviceAdapter: opts.deviceAdapter ?? null });
  const httpServer = await createRunnerHttp({ engine, token, port: opts.port });

  // 发现文件：runner 就绪后写出，供 MCP 桥接进程读取端口与令牌
  const discovery: RunnerDiscovery = {
    schemaVersion: 1,
    port: httpServer.port,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  const discoveryPath = path.join(dataDir, RUNNER_DISCOVERY_FILE);
  await fsp.writeFile(discoveryPath, JSON.stringify(discovery, null, 2), 'utf8');
  engine.emit('runner/ready', { payload: { port: httpServer.port, pid: process.pid } });

  let closed = false;
  return {
    port: httpServer.port,
    token,
    dataDir,
    discoveryPath,
    storage,
    engine,
    profiles,
    http: httpServer,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // 优雅关闭：关端口 → 等待在途操作安全收尾（超时标记 unknown）→ 关存储 → 清发现文件
      await httpServer.close();
      await engine.shutdown(opts.shutdownGraceMs ?? 10_000);
      storage.close();
      await fsp.rm(discoveryPath, { force: true }).catch(() => undefined);
    },
  };
}
