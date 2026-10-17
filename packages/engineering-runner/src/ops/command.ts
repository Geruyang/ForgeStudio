/**
 * 受控命令执行器：exe + args 数组（shell:false，禁止拼接任意 shell 字符串）。
 * - 环境白名单：PATH/SYSTEMROOT/SYSTEMDRIVE/TEMP/TMP/COMSPEC/PATHEXT + profile env（不做通配透传）
 * - windowsHide:true；cwd 可设（相对项目根）
 * - timeoutMs 超时 → taskkill /PID /T /F 杀进程树
 * - 输出字节上限截断（保留前 outputLimitBytes 字节，truncated 标记）
 * - AbortSignal 取消 → 杀进程树 → cancelled（副作用前/进行中取消均如此标记）
 */
import { spawn, type ChildProcess } from 'node:child_process';

/** 命令环境白名单（不含任何宿主凭证变量） */
export const COMMAND_ENV_WHITELIST: readonly string[] = [
  'PATH',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'TEMP',
  'TMP',
  'COMSPEC',
  'PATHEXT',
];

export function buildCommandEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of COMMAND_ENV_WHITELIST) {
    const value = process.env[name] ?? process.env[name.toLowerCase()] ?? process.env[name.toUpperCase()];
    if (value !== undefined) env[name] = value;
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    env[key] = value;
  }
  return env;
}

/** Windows 杀进程树（taskkill /PID <pid> /T /F）；非 Windows 回退 child.kill */
async function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => resolve());
      killer.on('close', () => resolve());
      killer.on('spawn', () => resolve());
      setTimeout(resolve, 3_000); // 兜底：taskkill 卡死也不阻塞
    });
  } else {
    child.kill('SIGKILL');
  }
}

export interface RunCommandArgs {
  exe: string;
  args: readonly string[];
  /** 工作目录（绝对路径；缺省继承当前进程） */
  cwd?: string;
  /** 附加环境（键=值，覆盖白名单同名项） */
  env?: Record<string, string>;
  timeoutMs: number;
  /** 输出上限字节（stdout 与 stderr 各自上限） */
  outputLimitBytes: number;
  signal?: AbortSignal;
}

export interface CommandResult {
  /** 退出码；被杀/启动失败为 null */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  /** 启动失败（如 ENOENT） */
  spawnError?: string;
  spawnErrorKind?: 'not_found' | 'other';
  durationMs: number;
}

const DEFAULT_OUTPUT_LIMIT = 2 * 1024 * 1024;

export async function runCommand(args: RunCommandArgs): Promise<CommandResult> {
  const outputLimit = args.outputLimitBytes > 0 ? args.outputLimitBytes : DEFAULT_OUTPUT_LIMIT;
  const startedAt = Date.now();
  return await new Promise<CommandResult>((resolve) => {
    let child: ChildProcess;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const result = (exitCode: number | null, extra?: Partial<CommandResult>): CommandResult => ({
      exitCode,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
      truncated,
      timedOut,
      cancelled,
      durationMs: Date.now() - startedAt,
      ...extra,
    });

    try {
      child = spawn(args.exe, [...args.args], {
        cwd: args.cwd,
        env: buildCommandEnv(args.env),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve(result(null, { spawnError: String(error), spawnErrorKind: 'other' }));
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null, extra?: Partial<CommandResult>) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      args.signal?.removeEventListener('abort', onAbort);
      resolve(result(exitCode, extra));
    };

    const onAbort = () => {
      cancelled = true;
      void killTree(child).finally(() => finish(null));
    };
    if (args.signal?.aborted) {
      // 副作用尚未发生：直接取消，不启动进程
      resolve({
        exitCode: null,
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: false,
        cancelled: true,
        durationMs: Date.now() - startedAt,
      });
      return;
    }
    args.signal?.addEventListener('abort', onAbort);

    timer = setTimeout(() => {
      timedOut = true;
      void killTree(child).finally(() => finish(null));
    }, args.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= outputLimit) {
        truncated = true;
        return;
      }
      if (stdoutBytes + chunk.length > outputLimit) {
        stdoutChunks.push(chunk.subarray(0, outputLimit - stdoutBytes));
        stdoutBytes = outputLimit;
        truncated = true;
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= outputLimit) {
        truncated = true;
        return;
      }
      if (stderrBytes + chunk.length > outputLimit) {
        stderrChunks.push(chunk.subarray(0, outputLimit - stderrBytes));
        stderrBytes = outputLimit;
        truncated = true;
        return;
      }
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
    });
    child.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(null, {
        spawnError: String(error),
        spawnErrorKind: code === 'ENOENT' ? 'not_found' : 'other',
      });
    });
    child.on('close', (code) => {
      finish(code ?? (timedOut || cancelled ? null : -1));
    });
  });
}
