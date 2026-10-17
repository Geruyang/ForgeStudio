/**
 * 诊断导出：应用/引擎/runner 状态汇总为 JSON 落盘。
 * 不含凭证：输出前对疑似密钥模式做遮蔽（与 QA M1 凭证扫描器同语义）。
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { CodexEngineAdapter } from '@forgedesk/engine-adapter';
import type { IpcContext } from './ipc-registry';

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /(api[_-]?key["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
  /(bearer\s+)[A-Za-z0-9._-]{16,}/gi,
];

function redact(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(p, '$1[REDACTED]');
  return out;
}

export async function writeDiagnostics(ctx: IpcContext): Promise<{ path: string }> {
  const dir = path.join(ctx.paths.dataDir, 'diagnostics');
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const runnerDiag = ctx.runner
    .request('/api/diagnostics')
    .catch((err: unknown) => ({ error: String(err) }));
  let engineStderrTail = '';
  try {
    const log = path.join(ctx.paths.sessionStorageDir, 'engine-stderr.log');
    const raw = await fsp.readFile(log, 'utf8');
    engineStderrTail = redact(raw.slice(-16 * 1024));
  } catch {
    engineStderrTail = '（无引擎 stderr 日志）';
  }
  // 未识别事件 method 名样本（跨会话环形保留）：排查协议演进/新通知类型的关键线索
  const adapter = ctx.engine.adapter;
  const unknownEvents =
    adapter instanceof CodexEngineAdapter
      ? { methodSamples: adapter.unknownMethodSamples(), stats: adapter.unknownEventStats() }
      : { methodSamples: [], stats: { retained: 0, dropped: 0 } };
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    app: {
      version: ctx.getVersion(),
      platform: `${process.platform}-${process.arch}`,
      electron: process.versions.electron,
      node: process.versions.node,
      dataDir: ctx.paths.dataDir,
      engineHome: ctx.paths.engineHome,
      codexCliPath: ctx.paths.codexCliPath,
      isDev: ctx.paths.isDev,
    },
    engine: { status: ctx.engine.status, unknownEvents },
    runner: await runnerDiag,
    engineStderrTail,
  };
  const file = path.join(dir, `diagnostics-${stamp}.json`);
  await fsp.writeFile(file, JSON.stringify(report, null, 2), 'utf8');
  return { path: file };
}
