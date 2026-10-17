/**
 * SSH 远程执行传输（Z3-FZ3B）：Linux SoC 板卡上的构建/验收命令执行。
 *
 * - SshSession：exec（超时/取消/输出上限，语义对齐 ops/command.ts 的 CommandResult）+
 *   uploadInputs（任务输入清单上传）+ downloadGlob（产物取回）。
 * - 真实实现基于 ssh2（密码经环境变量注入，不落盘不进日志）；测试注入 FakeSshSession（标注模拟）。
 * - 远程命令行组装：exe/args 来自冻结的 profile（用户认可），非模型拼接；单引号转义防注入。
 */
import type { SshTarget } from '../../../contracts/src/profile.ts';
import type { CommandResult } from './command.ts';

export interface SshExecArgs {
  cmdline: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  outputLimitBytes: number;
  signal?: AbortSignal;
}

export interface SshSession {
  /** 远程执行（cwd 内执行；返回结构与本地 runCommand 对齐） */
  exec(args: SshExecArgs): Promise<CommandResult>;
  /** 上传任务输入（相对路径 → 内容；覆盖写，幂等） */
  uploadInputs(remoteDir: string, files: Array<{ rel: string; content: Buffer }>): Promise<void>;
  /** 按 glob（仅支持 basename 级 `*`）从 remoteDir 取回文件到本地目录，返回相对路径列表 */
  downloadGlob(remoteDir: string, globs: string[], localDir: string): Promise<string[]>;
  close(): Promise<void>;
  readonly kind: 'real' | 'fixture';
}

/** 传输工厂：按 target 建会话（ops 引擎注入；测试用 fake） */
export type SshTransport = (target: SshTarget) => Promise<SshSession>;

/** 单引号转义：组装远程命令行（exe/args 来自冻结 profile，非模型输入） */
export function quoteRemote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function buildRemoteCmdline(exe: string, args: readonly string[]): string {
  return [exe, ...args].map(quoteRemote).join(' ');
}

/** 任务远程目录：remoteRoot/<taskId>-<inputDigest 前 8 位>（内容寻址，同输入免重传） */
export function remoteTaskDir(target: SshTarget, taskId: string, inputDigest: string): string {
  const root = target.remoteRoot.replace(/\/+$/, '');
  return `${root}/${taskId}-${inputDigest.slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// 真实实现（ssh2）
// ---------------------------------------------------------------------------

import { Client, type SFTPWrapper } from 'ssh2';

export class Ssh2Session implements SshSession {
  readonly kind = 'real' as const;
  readonly #conn: Client;
  readonly #sftp: SFTPWrapper;

  private constructor(conn: Client, sftp: SFTPWrapper) {
    this.#conn = conn;
    this.#sftp = sftp;
  }

  static async connect(target: SshTarget): Promise<Ssh2Session> {
    const password = process.env[target.passwordEnv];
    if (!password) {
      throw new Error(`SSH 密码未配置（环境变量 ${target.passwordEnv}）——板卡凭据经环境注入，不落 profile`);
    }
    const conn = new Client();
    const connReady = new Promise<void>((resolve, reject) => {
      conn.on('ready', () => resolve()).on('error', (e: Error) => reject(e));
    });
    conn.connect({
      host: target.host,
      port: target.port,
      username: target.username,
      password,
      readyTimeout: 15_000,
      keepaliveInterval: 10_000,
    });
    await connReady;
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      conn.sftp((err, s) => (err ? reject(err) : resolve(s)));
    });
    return new Ssh2Session(conn, sftp);
  }

  async exec(args: SshExecArgs): Promise<CommandResult> {
    const startedAt = Date.now();
    const envPrefix = Object.entries(args.env ?? {})
      .map(([k, v]) => `${k}=${quoteRemote(v)}`)
      .join(' ');
    const cmdline = `cd ${quoteRemote(args.cwd)} && ${envPrefix ? `${envPrefix} ` : ''}${args.cmdline}`;
    return await new Promise<CommandResult>((resolve) => {
      this.#conn.exec(cmdline, (err, stream) => {
        if (err) {
          resolve({
            exitCode: null, stdout: '', stderr: String(err), truncated: false, timedOut: false,
            cancelled: false, durationMs: Date.now() - startedAt, spawnError: String(err), spawnErrorKind: 'other',
          });
          return;
        }
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let truncated = false;
        let timedOut = false;
        let cancelled = false;
        let settled = false;
        const limit = args.outputLimitBytes > 0 ? args.outputLimitBytes : 2 * 1024 * 1024;
        const collect = (chunks: Buffer[], setter: (b: number) => void, bytes: number, chunk: Buffer): number => {
          let total = bytes;
          if (total >= limit) {
            truncated = true;
            return total;
          }
          if (total + chunk.length > limit) {
            chunks.push(chunk.subarray(0, limit - total));
            total = limit;
            truncated = true;
            return total;
          }
          chunks.push(chunk);
          total += chunk.length;
          return total;
        };
        stream.on('data', (chunk: Buffer) => {
          stdoutBytes = collect(stdoutChunks, () => {}, stdoutBytes, chunk);
        });
        stream.stderr.on('data', (chunk: Buffer) => {
          stderrBytes = collect(stderrChunks, () => {}, stderrBytes, chunk);
        });
        const timer = setTimeout(() => {
          timedOut = true;
          stream.close();
        }, args.timeoutMs);
        const onAbort = () => {
          cancelled = true;
          stream.close();
        };
        if (args.signal?.aborted) onAbort();
        else args.signal?.addEventListener('abort', onAbort, { once: true });
        const finish = (exitCode: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          args.signal?.removeEventListener('abort', onAbort);
          resolve({
            exitCode: cancelled || timedOut ? null : (exitCode ?? -1),
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
            truncated, timedOut, cancelled,
            durationMs: Date.now() - startedAt,
          });
        };
        stream.on('exit', (code: number | null) => finish(code));
        stream.on('close', () => finish(null));
      });
    });
  }

  async uploadInputs(remoteDir: string, files: Array<{ rel: string; content: Buffer }>): Promise<void> {
    await this.#mkdirp(remoteDir);
    for (const f of files) {
      const dest = `${remoteDir}/${f.rel}`;
      const parent = dest.slice(0, dest.lastIndexOf('/'));
      if (parent !== remoteDir) await this.#mkdirp(parent);
      await new Promise<void>((resolve, reject) => {
        this.#sftp.writeFile(dest, f.content, {}, (err) => (err ? reject(err) : resolve()));
      });
    }
  }

  async downloadGlob(remoteDir: string, globs: string[], localDir: string): Promise<string[]> {
    const entries = await new Promise<Array<{ filename: string; attrs: { size: number } }>>((resolve, reject) => {
      this.#sftp.readdir(remoteDir, (err, list) => (err ? reject(err) : resolve(list)));
    });
    const matches: string[] = [];
    for (const e of entries) {
      if (!globs.some((g) => globMatch(g, e.filename))) continue;
      const content = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const rs = this.#sftp.createReadStream(`${remoteDir}/${e.filename}`);
        rs.on('data', (c: Buffer) => chunks.push(c));
        rs.on('error', reject);
        rs.on('end', () => resolve(Buffer.concat(chunks)));
      });
      const { writeFile, mkdir } = await import('node:fs/promises');
      const path = await import('node:path');
      await mkdir(localDir, { recursive: true });
      await writeFile(path.join(localDir, e.filename), content);
      matches.push(e.filename);
    }
    return matches;
  }

  async #mkdirp(remoteDir: string): Promise<void> {
    // 板上 mkdir -p（经 exec 通道；目录路径由 runner 构造，无用户输入拼接）。
    // 实测（FZ3B/OpenSSH 7.6）：SFTP 通道并存时 exec 流的 close 事件可能无限延迟，
    // exit 事件正常到达——两者先到先析，另加兜底超时防悬挂。
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(fallback);
        resolve();
      };
      const fallback = setTimeout(done, 10_000);
      this.#conn.exec(`mkdir -p ${quoteRemote(remoteDir)}`, (err, stream) => {
        if (err) return done();
        stream.on('exit', () => done());
        stream.on('close', () => done());
        stream.on('error', () => done());
      });
    });
  }

  async close(): Promise<void> {
    this.#sftp.end();
    this.#conn.end();
  }
}

/** basename 级 glob（`*` 通配；不支持目录递归——产物均为任务目录顶层文件） */
export function globMatch(pattern: string, name: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(name);
}

/** 默认传输：真实 ssh2 会话 */
export const defaultSshTransport: SshTransport = (target) => Ssh2Session.connect(target);
