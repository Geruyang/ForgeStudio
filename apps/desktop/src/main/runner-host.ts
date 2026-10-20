/**
 * Runner 宿主：utilityProcess 启动唯一权威执行器实例；
 * 主进程经 loopback HTTP（Bearer Token）代理全部 bridge runner.* 调用；
 * MCP 桥接进程与主进程连的是同一实例（任务书 §6.2）。
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { utilityProcess, type UtilityProcess } from 'electron';
import {
  RUNNER_DISCOVERY_FILE,
  type RunnerDiscovery,
  type RunnerEvent,
} from '@forgedesk/contracts/runner';

export interface RunnerHostOptions {
  dataDir: string;
  runnerServicePath: string;  /** 随包工程 profile 模板目录（只读；作为第二 profile 目录传给 runner） */
  bundledProfilesDir?: string;
  /** 启动等待发现文件的时限 */
  startupTimeoutMs?: number;
  /** SSH 板卡凭据（Z3 GUI 链）：注入 runner 子进程 env（profile 的 passwordEnv 按名取用） */
  sshCredentialEnv?: Record<string, string>;
  onEvent: (event: RunnerEvent) => void;
  onExited: (code: number) => void;
}

export class RunnerHost {
  readonly dataDir: string;
  #proc: UtilityProcess | null = null;
  #discovery: RunnerDiscovery | null = null;
  #sseAbort: AbortController | null = null;
  #exited = false;

  constructor(private readonly opts: RunnerHostOptions) {
    this.dataDir = opts.dataDir;
  }

  get ready(): boolean {
    return this.#discovery !== null;
  }

  get discovery(): RunnerDiscovery | null {
    return this.#discovery;
  }

  /** 启动服务进程并等待发现文件（runner 写出端口与令牌） */
  async start(): Promise<RunnerDiscovery> {
    if (this.#discovery) return this.#discovery;
    this.#exited = false;
    this.#sseAbort = new AbortController();
    await fsp.rm(path.join(this.dataDir, RUNNER_DISCOVERY_FILE), { force: true }).catch(() => undefined);
    this.#proc = utilityProcess.fork(
      this.opts.runnerServicePath,
      [
        '--fd-runner-data-dir',
        this.dataDir,
        ...(this.opts.bundledProfilesDir ? ['--fd-bundled-profiles', this.opts.bundledProfilesDir] : []),
      ],
      {
        serviceName: 'forgedesk-runner',
        // SSH 板卡凭据随进程 env 注入（值不落日志/诊断；utilityProcess env 缺省继承本进程）
        ...(this.opts.sshCredentialEnv && Object.keys(this.opts.sshCredentialEnv).length > 0
          ? { env: { ...process.env, ...this.opts.sshCredentialEnv } }
          : {}),
      },
    );
    this.#proc.on('exit', (code) => {
      this.#exited = true;
      this.#discovery = null;
      this.opts.onExited(code ?? -1);
    });
    const timeout = this.opts.startupTimeoutMs ?? 20_000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const d = await this.#readDiscovery();
      if (d) {
        this.#discovery = d;
        this.#connectEvents();
        return d;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`runner 服务未在 ${timeout}ms 内就绪（发现文件缺失）`);
  }

  async #readDiscovery(): Promise<RunnerDiscovery | null> {
    try {
      const raw = JSON.parse(
        await fsp.readFile(path.join(this.dataDir, RUNNER_DISCOVERY_FILE), 'utf8'),
      ) as RunnerDiscovery;
      if (raw && typeof raw.port === 'number' && typeof raw.token === 'string') return raw;
    } catch {
      /* 未就绪 */
    }
    return null;
  }

  /** 控制面请求（自动附带 Bearer Token；仅 127.0.0.1） */
  async request<T>(pathname: string, init?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<T> {
    const d = this.#requireDiscovery();
    const res = await fetch(`http://127.0.0.1:${d.port}${pathname}`, {
      method: init?.method ?? 'GET',
      headers: {
        authorization: `Bearer ${d.token}`,
        ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init?.timeoutMs ?? 120_000),
    });
    return (await res.json()) as T;
  }

  /** 订阅 SSE 事件流：断线自动重连（带 since 游标防全量重放丢最新事件） */
  #lastEventSeq = 0; // BUG6 修复：跟踪最新已收 seq，重连时从断点续传
  #connectEvents(): void {
    const d = this.#requireDiscovery();
    const run = async (): Promise<void> => {
      while (!this.#exited && !this.#sseAbort?.signal.aborted) {
        try {
          const url = this.#lastEventSeq > 0
            ? `http://127.0.0.1:${d.port}/api/events?since=${this.#lastEventSeq}`
            : `http://127.0.0.1:${d.port}/api/events`;
          const res = await fetch(url, {
            headers: { authorization: `Bearer ${d.token}`, accept: 'text/event-stream' },
            signal: this.#sseAbort?.signal,
          });
          if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const frame = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              for (const line of frame.split('\n')) {
                if (line.startsWith('id:')) {
                  /* BUG6 修复：跟踪 SSE 事件 id（=数据库 seq）用于断线重连的 since 游标 */
                  const seq = Number(line.slice(3).trim());
                  if (Number.isFinite(seq) && seq > this.#lastEventSeq) this.#lastEventSeq = seq;
                }
                if (line.startsWith('data:')) {
                  try {
                    this.opts.onEvent(JSON.parse(line.slice(5)) as RunnerEvent);
                  } catch {
                    /* 忽略坏帧 */
                  }
                }
              }
            }
          }
        } catch {
          if (this.#exited || this.#sseAbort?.signal.aborted) return;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    };
    void run();
  }

  /** 优雅停止：断开订阅并结束服务进程（发现文件由 runner 侧清理或下次启动覆盖） */
  async stop(): Promise<void> {
    this.#exited = true;
    this.#sseAbort?.abort();
    this.#discovery = null;
    this.#proc?.kill();
    this.#proc = null;
  }

  #requireDiscovery(): RunnerDiscovery {
    if (!this.#discovery) throw new Error('runner 未就绪');
    return this.#discovery;
  }
}
