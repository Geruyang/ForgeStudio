/**
 * 子进程捕获执行（shell:false，参数数组；无 shell 字符串拼接）。
 * powershell 枚举与 probe-rs 探测共用；烧录 flash 走 device-adapter 的流式落盘版本。
 */
import { spawn } from 'node:child_process';

export interface RunCaptureOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** stdout/stderr 内存捕获上限（全量返回受此限制） */
  maxOutputBytes?: number;
}

export interface RunCaptureResult {
  /** 干净退出且退出码为 0 */
  ok: boolean;
  code: number | null;
  killed: boolean;
  stdout: string;
  stderr: string;
  /** spawn 失败（如找不到可执行文件）时的错误消息 */
  spawnError?: string;
}

export function runCapture(
  exe: string,
  args: string[],
  opts: RunCaptureOptions = {},
): Promise<RunCaptureResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxBytes = opts.maxOutputBytes ?? 2 * 1024 * 1024;
  return new Promise<RunCaptureResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;
    let settled = false;
    let child;
    try {
      child = spawn(exe, args, {
        shell: false,
        windowsHide: true,
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        ok: false,
        code: null,
        killed: false,
        stdout: '',
        stderr: '',
        spawnError: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const append = (target: 'stdout' | 'stderr', chunk: string): void => {
      const cur = target === 'stdout' ? stdout : stderr;
      if (cur.length >= maxBytes) return;
      if (target === 'stdout') stdout = cur + chunk;
      else stderr = cur + chunk;
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => append('stdout', chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => append('stderr', chunk));

    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill();
      } catch {
        /* 进程可能已退出 */
      }
    }, timeoutMs);

    const finish = (code: number | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: !killed && spawnError === undefined && code === 0,
        code,
        killed,
        stdout,
        stderr,
        spawnError,
      });
    };
    child.once('error', (err: Error) => finish(null, err.message));
    child.once('close', (code: number | null) => finish(code));
  });
}
