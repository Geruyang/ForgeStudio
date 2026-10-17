/**
 * 烧录执行（Agent C，任务书 §8.3/§9/§11 M9 语义）：
 * - 执行 profile.flashCommand（exe+args 数组，${artifact} 占位替换为产物绝对路径）；
 *   shell:false、windowsHide:true、cwd=workDir
 * - 预算 profile/budgetMs：超时 → taskkill /PID <pid> /T /F 杀整棵进程树 →
 *   无干净退出码 → 结果 unknown（超时不证明设备停止），不自动重试
 * - 回执：stdout/stderr 全量落盘 <workDir>/flash-receipt-<ts>.log
 * - 结果分类：exit 0 → succeeded（有 readbackCommand 则执行并 readbackVerified）；
 *   非 0（≤255 常规退出码）→ failed；code=null（信号终止）或 >255（NTSTATUS 异常
 *   终止，如 0xC0000005 访问违例）→ 进程崩溃 → unknown
 * - AbortSignal：工具未启动 → cancelled（无副作用）；已启动 → 不强杀烧录进程，
 *   记录"烧录中取消请求，等待工具自然结束"，仍按真实退出结果归类
 * 本机无板卡：真实命令不可用 → 结构化失败（environment_missing）；测试经虚拟烧录工具 fixture。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { finished } from 'node:stream/promises';
import type { DeviceFlashArgs, FlashOutcome } from '@forgedesk/contracts';
import { DeviceCancelledError, DeviceOperationError } from './errors';

/** profile 兼容形态：契约 DeviceProfile（flashCommand/flashBudgetMs/readbackCommand）+ 可选 id */
export type FlashProfile = {
  chipTarget: string;
  flashCommand: { exe: string; args: string[]; cwd?: string; env?: Record<string, string>; timeoutMs?: number };
  flashBudgetMs?: number;
  readbackCommand?: { exe: string; args: string[]; cwd?: string; env?: Record<string, string>; timeoutMs?: number };
};

/** Windows NTSTATUS 异常退出码下界（0xC0000005=3221225477 等；常规退出码 0-255） */
const NTSTATUS_EXIT_FLOOR = 256;

type FlashProcessResult =
  | { kind: 'spawn_error'; error: Error }
  | { kind: 'exited'; code: number | null; signal: NodeJS.Signals | null };

function shortToken(len: number): string {
  return Math.random().toString(16).slice(2, 2 + len).padEnd(len, '0');
}

function fileStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

/**
 * Windows 进程树终止（§11：不能只杀父进程留下子进程）。
 * taskkill 为系统 .exe，可 shell:false 直启；非 Windows 回退 child.kill()。
 */
function killProcessTree(child: ChildProcess): void {
  if (process.platform === 'win32' && typeof child.pid === 'number') {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      return;
    } catch {
      // taskkill 启动失败回退 kill()
    }
  }
  try {
    child.kill();
  } catch {
    /* 进程可能已退出 */
  }
}

/** 烧录主流程：成功返回 FlashOutcome；失败/超时/崩溃抛 DeviceOperationError；启动前取消抛 DeviceCancelledError */
export async function runFlash(args: DeviceFlashArgs): Promise<FlashOutcome> {
  const profile = args.profile as unknown as FlashProfile;
  const cmd = profile.flashCommand;
  const artifactAbs = path.resolve(args.artifactPath);
  const budgetMs = args.budgetMs > 0 ? args.budgetMs : profile.flashBudgetMs ?? 300_000;

  if (args.signal?.aborted) {
    throw new DeviceCancelledError('before_start', '烧录在命令启动前被取消（无副作用）');
  }
  let artifactSize = 0;
  try {
    artifactSize = (await stat(artifactAbs)).size;
  } catch {
    throw new DeviceOperationError({
      status: 'failed',
      kind: 'environment_missing',
      reason: 'artifact_missing',
      message: `烧录产物不存在：${artifactAbs}`,
    });
  }
  if (args.signal?.aborted) {
    throw new DeviceCancelledError('before_start', '烧录在命令启动前被取消（无副作用）');
  }
  await mkdir(args.workDir, { recursive: true });

  const startMs = Date.now();
  const startedAt = new Date(startMs);
  const receiptPath = path.join(
    args.workDir,
    `flash-receipt-${fileStamp(startedAt)}-${shortToken(6)}.log`,
  );
  const receipt = createWriteStream(receiptPath, { encoding: 'utf8' });
  const write = (s: string): void => {
    receipt.write(s);
  };
  write('=== ForgeDesk 烧录工具回执 ===\n');
  write(`taskId: ${args.taskId}\nbindingId: ${args.binding.id}\nchipTarget: ${profile.chipTarget}\n`);
  write(`artifact: ${artifactAbs} (${artifactSize} bytes)\nartifactSha256: ${args.artifactSha256}\n`);
  write(`expectedBuildId: ${args.buildId ?? '(未提供)'}\n`);

  const finalArgs = cmd.args.map((a) => a.replaceAll('${artifact}', artifactAbs));
  const cmdEnv: NodeJS.ProcessEnv = { ...process.env };
  const envKeys: string[] = [];
  for (const [k, v] of Object.entries(cmd.env ?? {})) {
    cmdEnv[k] = v.replaceAll('${artifact}', artifactAbs);
    envKeys.push(k); // 只记录键名，不落盘环境值（防泄漏凭证）
  }
  const cwd = cmd.cwd && path.isAbsolute(cmd.cwd) ? cmd.cwd : args.workDir;
  write(`command: ${cmd.exe} ${finalArgs.join(' ')}\ncwd: ${cwd}\n`);
  write(`startedAt: ${startedAt.toISOString()}\nbudgetMs: ${budgetMs}\n`);
  write(`envKeys: ${envKeys.length > 0 ? envKeys.join(',') : '(无)'}\n`);
  write('--- 工具输出（[stdout]/[stderr] 行级标记，全量落盘） ---\n');

  // 行级标记器：全量落盘 + 内存尾部（摘要用）
  let stdoutLineCount = 0;
  let stderrLineCount = 0;
  let stdoutTail = '';
  const makeTagger = (tag: 'stdout' | 'stderr'): ((chunk: string, flush: boolean) => void) => {
    let buf = '';
    return (chunk: string, flush: boolean) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        write(`[${tag}] ${line}\n`);
        if (tag === 'stdout') {
          stdoutLineCount += 1;
          stdoutTail = (stdoutTail + line + '\n').slice(-400);
        } else {
          stderrLineCount += 1;
        }
      }
      if (flush && buf.length > 0) {
        write(`[${tag}] ${buf}\n`);
        if (tag === 'stdout') stdoutLineCount += 1;
        else stderrLineCount += 1;
        buf = '';
      }
    };
  };
  const tagOut = makeTagger('stdout');
  const tagErr = makeTagger('stderr');

  const finalize = async (exitNote: string): Promise<void> => {
    tagOut('', true);
    tagErr('', true);
    write(exitNote);
    write(`endedAt: ${new Date().toISOString()}\ndurationMs: ${Date.now() - startMs}\n`);
    receipt.end();
    await finished(receipt);
  };
  const summaryOf = (exitDesc: string): string => {
    const tail = stdoutTail.trim();
    const last = tail.length > 0 ? (tail.split(/\r?\n/).pop() ?? '') : '';
    const snip = last.length > 200 ? `${last.slice(0, 200)}…` : last;
    return `${exitDesc}；stdout ${stdoutLineCount} 行 / stderr ${stderrLineCount} 行${snip ? `；末行: ${snip}` : ''}`;
  };

  let killedByBudget = false;
  let spawnSucceeded = false;
  let abortAfterStart = false;
  let child: ChildProcess;
  try {
    child = spawn(cmd.exe, finalArgs, {
      cwd,
      env: cmdEnv,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finalize(`--- spawn 同步失败：${message}（无副作用） ---\n`);
    throw new DeviceOperationError({
      status: 'failed',
      kind: 'environment_missing',
      reason: 'tool_missing',
      message: `烧录工具无法启动：${message}`,
      logRef: receiptPath,
      outcome: { toolReceiptPath: receiptPath, toolSummary: '烧录工具启动失败', durationMs: Date.now() - startMs },
    });
  }

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => tagOut(chunk, false));
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => tagErr(chunk, false));

  const result = await new Promise<FlashProcessResult>((resolve) => {
    let settled = false;
    const settle = (r: FlashProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(budgetTimer);
      resolve(r);
    };
    const budgetTimer = setTimeout(() => {
      killedByBudget = true;
      write(`\n--- 烧录预算超时（${budgetMs}ms）：taskkill /T /F 终止进程树 → 无干净退出码 → unknown 语义，不自动重试 ---\n`);
      killProcessTree(child);
    }, budgetMs);
    child.once('spawn', () => {
      spawnSucceeded = true;
    });
    child.once('error', (err: Error) => settle({ kind: 'spawn_error', error: err }));
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) =>
      settle({ kind: 'exited', code, signal }),
    );
    if (args.signal) {
      const onAbort = (): void => {
        if (spawnSucceeded) {
          abortAfterStart = true;
          write(
            '\n--- 烧录中取消请求：不强杀烧录进程（是否可取消由工具能力决定），等待工具自然结束 ---\n',
          );
        }
        // 启动前 abort 已在入口拦截；此处到达但未 spawn 的极端窗口按启动后处理（保守）
      };
      args.signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  const durationMs = Date.now() - startMs;

  if (result.kind === 'spawn_error') {
    const message = result.error.message;
    await finalize(`--- spawn 失败：${message} ---\n`);
    throw new DeviceOperationError({
      status: spawnSucceeded ? 'unknown' : 'failed',
      kind: spawnSucceeded ? 'unknown_result' : 'environment_missing',
      reason: spawnSucceeded ? 'abnormal_termination' : 'tool_missing',
      message: spawnSucceeded
        ? `烧录进程启动后异常终止：${message}（无干净退出码 → unknown 语义，不自动重试）`
        : `烧录工具无法启动（找不到 ${cmd.exe} 或启动失败）：${message}`,
      logRef: receiptPath,
      outcome: {
        toolReceiptPath: receiptPath,
        toolSummary: spawnSucceeded ? '烧录进程异常终止' : '烧录工具启动失败',
        durationMs,
      },
    });
  }

  const { code, signal } = result;

  if (killedByBudget) {
    await finalize(`--- 结果：预算超时终止，exitCode=${code} signal=${signal ?? 'null'} → unknown ---\n`);
    throw new DeviceOperationError({
      status: 'unknown',
      kind: 'timeout',
      reason: 'budget_timeout',
      message: `烧录预算超时（${budgetMs}ms）：进程树被终止，无干净退出码 → 结果 unknown，不自动重试`,
      detail: `exitCode=${code} signal=${signal ?? 'null'}`,
      logRef: receiptPath,
      outcome: {
        toolReceiptPath: receiptPath,
        toolSummary: `预算超时（${budgetMs}ms）进程树被终止`,
        durationMs,
      },
    });
  }

  if (code === 0) {
    // 读回校验（profile 提供时）
    let readbackVerified: boolean | undefined;
    const readback = profile.readbackCommand;
    if (readback) {
      if (args.signal?.aborted) {
        write('\n--- readback 跳过：已请求取消 ---\n');
      } else {
        const rbArgs = readback.args.map((a) => a.replaceAll('${artifact}', artifactAbs));
        const rbEnv: NodeJS.ProcessEnv = { ...process.env };
        for (const [k, v] of Object.entries(readback.env ?? {})) {
          rbEnv[k] = v.replaceAll('${artifact}', artifactAbs);
        }
        write(`\n--- 烧录后读回校验：${readback.exe} ${rbArgs.join(' ')} ---\n`);
        const rb = await runAuxCapture(readback.exe, rbArgs, {
          timeoutMs: readback.timeoutMs ?? 120_000,
          cwd: readback.cwd && path.isAbsolute(readback.cwd) ? readback.cwd : cwd,
          env: rbEnv,
        });
        for (const line of rb.stdout.split(/\r?\n/)) if (line.length > 0) write(`[readback:stdout] ${line}\n`);
        for (const line of rb.stderr.split(/\r?\n/)) if (line.length > 0) write(`[readback:stderr] ${line}\n`);
        readbackVerified = rb.ok;
        write(
          `readback: exitCode=${rb.code}${rb.killed ? '（超时被终止）' : ''} readbackVerified=${readbackVerified}\n`,
        );
      }
    }
    const abortNote = abortAfterStart ? '（烧录中取消请求：未强杀，按工具自然结束的真实结果归类）' : '';
    await finalize(`--- 结果：退出码 0 → 烧录成功${abortNote} ---\n`);
    const outcome: FlashOutcome = {
      toolReceiptPath: receiptPath,
      toolSummary: summaryOf('退出码 0，烧录成功'),
      durationMs,
    };
    if (readbackVerified !== undefined) outcome.readbackVerified = readbackVerified;
    return outcome;
  }

  if (code !== null && code >= NTSTATUS_EXIT_FLOOR) {
    // 异常退出码（Windows NTSTATUS 崩溃，如访问违例 0xC0000005）：工具未报告结果 → unknown
    await finalize(`--- 结果：异常退出码 ${code}（NTSTATUS 崩溃，signal=${signal ?? 'null'}）→ unknown ---\n`);
    throw new DeviceOperationError({
      status: 'unknown',
      kind: 'unknown_result',
      reason: 'abnormal_termination',
      message: `烧录进程崩溃（异常退出码 ${code}，无干净退出码）→ 结果 unknown，不自动重试`,
      logRef: receiptPath,
      outcome: {
        toolReceiptPath: receiptPath,
        toolSummary: summaryOf('进程崩溃（异常退出码）'),
        durationMs,
      },
    });
  }

  if (code !== null) {
    await finalize(`--- 结果：退出码 ${code} → 烧录失败（确定性失败） ---\n`);
    throw new DeviceOperationError({
      status: 'failed',
      kind: 'build_failure',
      reason: 'tool_nonzero_exit',
      message: `烧录工具退出码 ${code}（确定性失败，不自动重试）`,
      logRef: receiptPath,
      outcome: {
        toolReceiptPath: receiptPath,
        toolSummary: summaryOf(`退出码 ${code}`),
        durationMs,
      },
    });
  }

  // code === null 且非预算超时：信号终止/外部杀死（Windows 罕见）→ unknown
  await finalize(`--- 结果：无退出码（signal=${signal ?? 'null'}）→ unknown ---\n`);
  throw new DeviceOperationError({
    status: 'unknown',
    kind: 'unknown_result',
    reason: 'abnormal_termination',
    message: `烧录进程异常终止（无干净退出码，signal=${signal ?? 'null'}）→ 结果 unknown，不自动重试`,
    logRef: receiptPath,
    outcome: {
      toolReceiptPath: receiptPath,
      toolSummary: summaryOf('异常终止'),
      durationMs,
    },
  });
}

/** 读回命令捕获（spawn 失败按非 0 处理；不落全量盘，仅回执摘要） */
async function runAuxCapture(
  exe: string,
  args: string[],
  opts: { timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<{ ok: boolean; code: number | null; killed: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    let stdout = '';
    let stderr = '';
    let killed = false;
    try {
      child = spawn(exe, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, code: -1, killed: false, stdout: '', stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-64 * 1024);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-64 * 1024);
    });
    const timer = setTimeout(() => {
      killed = true;
      killProcessTree(child);
    }, opts.timeoutMs);
    let settled = false;
    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: !killed && code === 0, code, killed, stdout, stderr });
    };
    child.once('error', () => settle(-1));
    child.once('close', (code: number | null) => settle(code));
  });
}

