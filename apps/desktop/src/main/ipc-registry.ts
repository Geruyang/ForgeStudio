/**
 * IPC 白名单注册：renderer → 主进程的唯一入口（contracts/src/ipc.ts 冻结）。
 * - sender 校验：只接受主窗口 frame
 * - 凭证/任意命令/文件系统直通一律不暴露
 * - engine 状态同步通道（sendSync）供 status() 使用
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { BrowserWindow, dialog, shell, ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { IPC, RUNNER_INVOKE_TOOLS, MODEL_PROVIDERS, type RunnerInvokeTool } from '@forgedesk/contracts/ipc';
import type { OpResult } from '@forgedesk/contracts/common';
import { ok, fail } from '@forgedesk/contracts/common';
import type { AuthStatusInfo } from '@forgedesk/contracts/engine';
import type { EngineHost } from './engine-host';
import type { RunnerHost } from './runner-host';
import type { SettingsStore } from './settings';
import type { AppPaths } from './paths';
import { writeDiagnostics } from './diagnostics';
import { listProviderSummaries, configureProvider, clearProvider, listProviderModels } from './provider-config';
import { checkForUpdate } from './update-check';
import { setSshCredential, clearSshCredential, listSshCredentialNames } from './ssh-credentials';

export interface IpcContext {
  paths: AppPaths;
  engine: EngineHost;
  runner: RunnerHost;
  settings: SettingsStore;
  getVersion(): string;
  getMainWindow(): BrowserWindow | null;
}

/** 运行时工具调用映射到 runner 控制面路由（与 MCP 七工具一一对应） */
const TOOL_ROUTES: Record<RunnerInvokeTool, { method: 'POST'; path: string }> = {
  'engineering.inspect': { method: 'POST', path: '/api/ops/inspect?wait=true' },
  'engineering.build': { method: 'POST', path: '/api/ops/build?wait=true' },
  'engineering.test': { method: 'POST', path: '/api/ops/test?wait=true' },
  'device.bind': { method: 'POST', path: '/api/ops/device-bind?wait=true' },
  'device.flash': { method: 'POST', path: '/api/ops/device-flash?wait=true' },
  'device.verify': { method: 'POST', path: '/api/ops/device-verify?wait=true' },
  'engineering.export': { method: 'POST', path: '/api/ops/export?wait=true' },
};

export function registerIpc(ctx: IpcContext): void {
  const mainWin = (): BrowserWindow => {
    const w = ctx.getMainWindow();
    if (!w) throw new Error('主窗口未就绪');
    return w;
  };
  /** sender 校验：仅主窗口 */
  const guard = (e: IpcMainInvokeEvent): boolean => e.sender.id === mainWin().webContents.id;
  const wrap = <T>(fn: () => Promise<T> | T): Promise<OpResult<T>> | OpResult<T> => {
    try {
      const v = fn();
      if (v instanceof Promise) {
        return v.then(
          (value) => ok(value),
          (err: unknown) => fail('internal_error', String(err instanceof Error ? err.message : err)),
        );
      }
      return ok(v);
    } catch (err) {
      return fail('internal_error', String(err instanceof Error ? err.message : err));
    }
  };

  // ---- engine ----
  register(IPC.engine.start, async (e, projectRoot: string, options?: { model?: string; resumeThreadId?: string }) => {
    if (!guard(e)) throw new Error('sender 校验失败');
    return ctx.engine.start({ projectRoot, model: options?.model, resumeThreadId: options?.resumeThreadId });
  });
  register(IPC.engine.send, (e, text: string) => {
    if (!ctx.engine.adapter) throw new Error('引擎未启动');
    return ctx.engine.adapter.send(text);
  });
  register(IPC.engine.steer, (e, text: string) => {
    if (!ctx.engine.adapter) throw new Error('引擎未启动');
    return ctx.engine.adapter.steer(text);
  });
  register(IPC.engine.review, (e) => {
    if (!ctx.engine.adapter) throw new Error('代码审阅需要引擎已启动');
    return ctx.engine.adapter.startReview();
  });
  register(IPC.engine.interrupt, (e) => {
    if (!ctx.engine.adapter) throw new Error('引擎未启动');
    return ctx.engine.adapter.interrupt();
  });
  register(IPC.engine.approve, (e, requestId: string, decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel') => {
    if (!ctx.engine.adapter) throw new Error('引擎未启动');
    return ctx.engine.adapter.approve(requestId, decision);
  });
  register(IPC.engine.models, (e) => {
    if (!ctx.engine.adapter) throw new Error('引擎未启动');
    return ctx.engine.adapter.listModels();
  });
  register(IPC.engine.authStatus, async () => {
    if (ctx.engine.adapter) return ctx.engine.adapter.authStatus();
    // 引擎未启动：用随包 CLI 只读探测（codex login status），设置页一打开即可见认证态
    return probeAuthStatus(ctx.paths);
  });

  // ---- session ----
  register(IPC.session.listThreads, () => ctx.engine.sessionStore.listThreads());
  register(IPC.session.loadThread, (e, threadId: string) => ctx.engine.sessionStore.loadThread(threadId));
  register(IPC.session.loadPatch, (e, patchRef: string) => ctx.engine.loadPatch(patchRef));
  // Z1-5 会话管理：本地持久化为准，引擎在线且为当前线程时 best-effort 同步（失败不阻塞持久化结果）
  register(IPC.session.renameThread, async (e, threadId: string, name: string) => {
    const r = await ctx.engine.sessionStore.renameThread(threadId, name);
    if (r.ok) {
      try {
        await ctx.engine.adapter?.renameThread(threadId, name.trim());
      } catch {
        /* 引擎侧同步失败不影响本地持久化 */
      }
    }
    return r;
  });
  register(IPC.session.deleteThread, async (e, threadId: string) => {
    const r = await ctx.engine.sessionStore.deleteThread(threadId);
    if (r.ok) {
      try {
        await ctx.engine.adapter?.deleteThread(threadId);
      } catch {
        /* 引擎侧同步失败不影响本地清理 */
      }
    }
    return r;
  });
  register(IPC.session.compactThread, (e, threadId: string) => {
    if (!ctx.engine.adapter) throw new Error('上下文压缩需要引擎已启动');
    return ctx.engine.adapter.compactThread(threadId);
  });

  // ---- runner（HTTP 代理到唯一权威实例） ----
  register(IPC.runner.listTasks, () => ctx.runner.request('/api/tasks'));
  register(IPC.runner.getTask, (e, taskId: string) => ctx.runner.request(`/api/tasks/${encodeURIComponent(taskId)}`));
  register(IPC.runner.listProfiles, () => ctx.runner.request('/api/profiles'));
  register(IPC.runner.createTask, (e, req: unknown) =>
    ctx.runner.request('/api/tasks', { method: 'POST', body: req }),
  );
  register(IPC.runner.updateAcceptance, (e, taskId: string, items: unknown) =>
    ctx.runner.request(`/api/tasks/${encodeURIComponent(taskId)}/acceptance`, { method: 'POST', body: { items } }),
  );
  register(IPC.runner.manualReview, (e, taskId: string, itemId: string, decision: 'passed' | 'failed', note?: string) =>
    ctx.runner.request(`/api/tasks/${encodeURIComponent(taskId)}/acceptance/${encodeURIComponent(itemId)}/manual-review`, {
      method: 'POST',
      body: { decision, ...(note ? { note } : {}) },
    }),
  );
  register(IPC.runner.invoke, (e, tool: string, input: unknown) => {
    const route = TOOL_ROUTES[tool as RunnerInvokeTool];
    if (!route) throw new Error(`工具不在白名单: ${tool}`);
    return ctx.runner.request(route.path, { method: 'POST', body: input, timeoutMs: 400_000 });
  });
  register(IPC.runner.cancel, (e, operationId: string) =>
    ctx.runner.request(`/api/ops/${encodeURIComponent(operationId)}/cancel`, {
      method: 'POST',
      body: { reason: 'user_stop' },
    }),
  );
  register(IPC.runner.pendingAuthorization, () => ctx.runner.request('/api/pending-authorization'));
  register(IPC.runner.authorize, (e, operationId: string, decision: 'approved' | 'declined', confirmedScope: unknown) =>
    ctx.runner.request('/api/ops/authorize', {
      method: 'POST',
      body: { operationId, decision, confirmedScope },
    }),
  );
  // 契约（ipc.ts listDevices: EnumeratedDevice[]）：HTTP 返回信封 {devices, adapterAvailable, note?}，
  // 在 IPC 边界解包为数组（GUI 走查发现：直传信封会使 DeviceSection devices.map 崩溃卸载整棵树）
  register(IPC.runner.listDevices, async () => {
    const r = (await ctx.runner.request('/api/devices')) as { devices?: unknown };
    return Array.isArray(r?.devices) ? r.devices : [];
  });
  register(IPC.runner.diagnostics, () => ctx.runner.request('/api/diagnostics'));

  // ---- app ----
  register(IPC.app.info, () => ({
    name: 'ForgeStudio' as const,
    version: ctx.getVersion(),
    platform: `${process.platform}-${process.arch}`,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    dataDir: ctx.paths.dataDir,
    homeDir: os.homedir(),
    engineHome: ctx.paths.engineHome,
    engineCliPath: ctx.paths.codexCliPath,
  }));
  register(IPC.app.settingsGet, () => ctx.settings.load());
  register(IPC.app.settingsSet, (e, patch: Record<string, unknown>) => ctx.settings.patch(patch));
  register(IPC.app.openPath, (e, target: string, kind: 'evidence' | 'artifact' | 'export' | 'log' | 'project') =>
    openPathGuarded(ctx, target, kind),
  );
  register(IPC.app.openExternalTerminal, async (e, projectRoot: string) => {
    const settings = await ctx.settings.load();
    const allowed = (settings.recentProjects ?? []).some((p) => samePath(p.projectRoot, projectRoot));
    if (!allowed) throw new Error('项目未登记，拒绝打开终端');
    // 外部终端在产品受控执行边界之外（任务书 §8.2）
    const { spawn } = await import('node:child_process');
    spawn('cmd.exe', ['/d', '/s', '/c', 'start', '""', 'cmd', '/k', `cd /d "${projectRoot}"`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      shell: false,
    }).unref();
  });
  register(IPC.app.exportDiagnostics, () => writeDiagnostics(ctx));
  // 官方登录入口（设置页）：打开中文引导终端并拉起随包 CLI 的官方 login 流程；
  // CODEX_HOME 固定为产品引擎目录——凭证经官方流程写入产品目录，不读取、不复制
  // 既有客户端凭证（任务书 P0-1 冻结决策）。renderer 无参数，命令与目录全部来自
  // 主进程自身解析（ctx.paths），无注入面。
  register(IPC.app.openEngineLogin, () => openEngineLogin(ctx.paths));

  // ---- 多模型提供方（火山方舟/智谱/Kimi/千问/DeepSeek 等；id/baseUrl 只认固定目录，外链白名单） ----
  register(IPC.app.listModelProviders, () => listProviderSummaries(ctx.paths.engineHome, ctx.settings));
  register(IPC.app.configureModelProvider, (e, req: { providerId: string; apiKey: string; defaultModel?: string }) =>
    configureProvider(ctx.paths.engineHome, ctx.settings, req),
  );
  register(IPC.app.clearModelProvider, (e, providerId: string) =>
    clearProvider(ctx.paths.engineHome, ctx.settings, providerId),
  );
  // SSH 板卡凭据（Z3 GUI 链）：值只落 dataDir/ssh-credentials.env，不回显不进日志/诊断
  register(IPC.app.sshCredentialSet, async (e, passwordEnv: string, password: string) => {
    await setSshCredential(ctx.paths.dataDir, passwordEnv, password);
    return { restartRequired: true as const };
  });
  register(IPC.app.sshCredentialClear, async (e, passwordEnv: string) => {
    await clearSshCredential(ctx.paths.dataDir, passwordEnv);
    return { restartRequired: true };
  });
  register(IPC.app.sshCredentialNames, () => listSshCredentialNames(ctx.paths.dataDir));
  // Z2C 更新检查 scaffold：feed URL 来自用户设置；仅比对告知，不下载不安装
  register(IPC.app.checkUpdate, async () => {
    const feedUrl = (await ctx.settings.load()).updateFeedUrl?.trim();
    if (!feedUrl) throw new Error('未配置更新源 URL（设置 → 诊断与关于 → 更新源）');
    return checkForUpdate(ctx.getVersion(), feedUrl);
  });
  register(IPC.app.openProviderConsole, async (e, providerId: string) => {
    const desc = MODEL_PROVIDERS.find((d) => d.id === providerId);
    if (!desc) throw new Error(`未知模型提供方: ${providerId}`);
    // 仅打开固定目录内的控制台地址（https），不接受 renderer 传入的任意 URL
    await shell.openExternal(desc.consoleUrl);
  });
  register(IPC.app.listProviderModels, (e, providerId: string) =>
    listProviderModels(ctx.paths.engineHome, providerId),
  );
  register(IPC.app.ensureProject, async () => {
    const w = mainWin();
    const r = await dialog.showOpenDialog(w, { properties: ['openDirectory', 'dontAddToRecent'] });
    if (r.canceled || !r.filePaths[0]) throw new Error('未选择目录');
    const projectRoot = path.resolve(r.filePaths[0]);
    const name = path.basename(projectRoot);
    const cur = await ctx.settings.load();
    const next = [
      { projectRoot, name, at: new Date().toISOString() },
      ...(cur.recentProjects ?? []).filter((p) => !samePath(p.projectRoot, projectRoot)),
    ].slice(0, 20);
    await ctx.settings.patch({ recentProjects: next } as never);
    return { projectRoot, name };
  });

  // 通用包装：所有 register 内部统一 OpResult
  function register(channel: string, handler: (e: IpcMainInvokeEvent, ...args: never[]) => unknown): void {
    ipcMain.handle(channel, (event, ...args) => wrap(() => handler(event, ...(args as never[]))));
  }
}

/** openPath 前缀白名单：逐 kind 校验，防任意路径打开 */
async function openPathGuarded(
  ctx: IpcContext,
  target: string,
  kind: 'evidence' | 'artifact' | 'export' | 'log' | 'project',
): Promise<void> {
  const p = path.resolve(target);
  const settings = await ctx.settings.load();
  const prefixes: string[] = (() => {
    switch (kind) {
      case 'evidence':
      case 'artifact':
        return [path.join(ctx.paths.dataDir, 'evidence')];
      case 'export':
        return [path.join(ctx.paths.dataDir, 'exports')];
      case 'log':
        return [ctx.paths.dataDir, ctx.paths.sessionStorageDir];
      case 'project':
        return (settings.recentProjects ?? []).map((r) => path.resolve(r.projectRoot));
    }
  })();
  const allowed = prefixes.some((pre) => p === pre || p.startsWith(pre + path.sep));
  if (!allowed) throw new Error(`路径不在允许的 ${kind} 范围内`);
  const err = await shell.openPath(p);
  if (err) throw new Error(`打开失败: ${err}`);
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

// ---------------------------------------------------------------------------
// 模型认证（设置页）
// ---------------------------------------------------------------------------

/** 引擎未启动时的只读认证探测：随包 CLI `codex login status`（CODEX_HOME=产品引擎目录） */
function probeAuthStatus(paths: AppPaths): Promise<AuthStatusInfo> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: AuthStatusInfo) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    import('node:child_process').then(({ execFile }) => {
      execFile(
        paths.codexCliPath,
        ['login', 'status'],
        {
          env: { ...process.env, CODEX_HOME: paths.engineHome },
          timeout: 15_000,
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          const out = `${stdout ?? ''}\n${stderr ?? ''}`;
          if (/api\s*key/i.test(out) && !/not\s+logged/i.test(out)) {
            finish({ mode: 'api_key', ok: true, accountHint: '已配置 API key（引擎未启动，只读探测）' });
          } else if (/chatgpt|logged\s*in/i.test(out) && !/not\s+logged/i.test(out)) {
            finish({ mode: 'chatgpt_account', ok: true, accountHint: 'ChatGPT 账号已登录（引擎未启动，只读探测）' });
          } else if (/not\s+logged/i.test(out)) {
            finish({ mode: 'none', ok: false, accountHint: '未配置——点击「官方登录」在终端完成（ChatGPT 账号或 API key）' });
          } else {
            const reason = err ? `（${String(err instanceof Error ? err.message : err).slice(0, 80)}）` : '';
            finish({ mode: 'none', ok: false, accountHint: `登录态探测未返回明确结果${reason}` });
          }
        },
      );
    }).catch((err) => finish({ mode: 'none', ok: false, accountHint: `探测失败：${String(err).slice(0, 80)}` }));
  });
}

/**
 * 官方登录入口：生成中文引导脚本并在外部终端打开，再进入随包 CLI 的官方 login 交互。
 * 引导脚本一次性写入系统临时目录（UTF-8 无 BOM + chcp 65001 保证中文可读）；
 * 登录完成后用户回设置页点「刷新认证状态」即可点亮就绪。
 */
function openEngineLogin(paths: AppPaths): void {
  const scriptPath = path.join(os.tmpdir(), 'forgestudio-login-guide.cmd');
  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    'title ForgeStudio 模型登录',
    // 关键：CODEX_HOME 在脚本内显式设置——经 start/WindowsTerminal 打开的窗口不保证继承
    // 主进程环境（Win11 默认终端由系统拉起，环境继承链会断，登录曾因此写入错误目录）
    `set "CODEX_HOME=${paths.engineHome}"`,
    'echo.',
    'echo ==============================================',
    'echo   ForgeStudio 模型登录（官方登录流程）',
    'echo ==============================================',
    'echo.',
    'echo   本窗口属于 ForgeStudio 的产品隔离环境（CODEX_HOME）:',
    `echo     ${paths.engineHome}`,
    'echo   不会读取或影响电脑上其他 Codex 安装的登录状态。',
    'echo.',
    'echo   接下来将启动 OpenAI Codex 官方登录（浏览器 ChatGPT 授权）：',
    'echo     按提示在浏览器完成确认即可。',
    'echo.',
    'echo   若要改用 API key：按 Ctrl+C 跳过浏览器流程，然后输入下面这行',
    'echo   并把「你的key」换成自己的 API key 后回车：',
    `echo     "${paths.codexCliPath}" login --api-key 你的key`,
    'echo.',
    'echo   登录成功后，回到 ForgeStudio 设置页点击「刷新认证状态」。',
    'echo ==============================================',
    'echo.',
    'pause',
    `"${paths.codexCliPath}" login`,
    'echo.',
    'echo ==============================================',
    'echo   登录流程已结束。本窗口可以直接关闭。',
    'echo   记得回到 ForgeStudio 设置页点击「刷新认证状态」。',
    'echo ==============================================',
    'pause',
    'exit',
  ];
  fs.writeFileSync(scriptPath, lines.join('\r\n'), 'utf8');
  // start 标题必须用空 '""'（窗口标题由脚本内 title 行设置）：含空格/中文的标题参数
  // 会被 Node 引号包裹成 ""标题""，cmd 将其解析为要打开的文件名而报"找不到文件"（登录按钮报错根因）
  spawn('cmd.exe', ['/d', '/s', '/c', 'start', '""', scriptPath], {
    env: { ...process.env, CODEX_HOME: paths.engineHome },
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    shell: false,
  }).unref();
}
