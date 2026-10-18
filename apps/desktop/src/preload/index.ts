/**
 * preload：最小白名单桥（contextBridge）。
 * 只暴露 contracts/src/ipc.ts 冻结的方法；sandbox=true 下无 Node 能力。
 */
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, RUNNER_INVOKE_TOOLS, type RunnerInvokeTool } from '@forgedesk/contracts/ipc';
import type { OpResult } from '@forgedesk/contracts/common';
import type { EngineEvent, EngineStatus } from '@forgedesk/contracts/engine';
import type { RunnerEvent } from '@forgedesk/contracts/runner';

const invoke = <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>;

/**
 * 主进程 register() 对全部通道统一包 OpResult；契约将 app.info/settingsGet/settingsSet
 * 声明为裸值（人体工学桥面）——此三处在 preload 解包，失败转 throw 由调用方 catch。
 */
const invokeUnwrapped = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
  const r = (await ipcRenderer.invoke(channel, ...args)) as OpResult<T>;
  if (!r.ok) throw new Error(r.failure?.message ?? `${channel} 调用失败`);
  return r.value;
};

contextBridge.exposeInMainWorld('forgedesk', {
  engine: {
    start: (projectRoot: string, options?: { model?: string; resumeThreadId?: string }) =>
      invoke(IPC.engine.start, projectRoot, options),
    send: (text: string) => invoke(IPC.engine.send, text),
    steer: (text: string) => invoke(IPC.engine.steer, text),
    interrupt: () => invoke(IPC.engine.interrupt),
    review: () => invoke(IPC.engine.review),
    approve: (requestId: string, decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel') =>
      invoke(IPC.engine.approve, requestId, decision),
    models: () => invoke(IPC.engine.models),
    authStatus: () => invoke(IPC.engine.authStatus),
    status: (): EngineStatus => ipcRenderer.sendSync(IPC.engine.status) as EngineStatus,
    onEvent: (cb: (event: EngineEvent) => void) => {
      const listener = (_e: unknown, event: EngineEvent) => cb(event);
      ipcRenderer.on(IPC.engine.event, listener);
      return () => ipcRenderer.removeListener(IPC.engine.event, listener);
    },
  },
  session: {
    listThreads: () => invoke(IPC.session.listThreads),
    loadThread: (threadId: string) => invoke(IPC.session.loadThread, threadId),
    loadPatch: (patchRef: string) => invoke(IPC.session.loadPatch, patchRef),
    renameThread: (threadId: string, name: string) => invoke(IPC.session.renameThread, threadId, name),
    deleteThread: (threadId: string) => invoke(IPC.session.deleteThread, threadId),
    compactThread: (threadId: string) => invoke(IPC.session.compactThread, threadId),
  },
  runner: {
    listTasks: () => invoke(IPC.runner.listTasks),
    getTask: (taskId: string) => invoke(IPC.runner.getTask, taskId),
    listProfiles: () => invoke(IPC.runner.listProfiles),
    createTask: (req: unknown) => invoke(IPC.runner.createTask, req),
    updateAcceptance: (taskId: string, items: unknown) => invoke(IPC.runner.updateAcceptance, taskId, items),
    manualReview: (taskId: string, itemId: string, decision: 'passed' | 'failed', note?: string) =>
      invoke(IPC.runner.manualReview, taskId, itemId, decision, note),
    invoke: (tool: RunnerInvokeTool, input: unknown) => {
      if (!RUNNER_INVOKE_TOOLS.includes(tool)) {
        return Promise.resolve({ ok: false, failure: { kind: 'permission_denied', message: `工具不在白名单: ${tool}` } });
      }
      return invoke(IPC.runner.invoke, tool, input);
    },
    cancel: (operationId: string) => invoke(IPC.runner.cancel, operationId),
    pendingAuthorization: () => invoke(IPC.runner.pendingAuthorization),
    authorize: (
      operationId: string,
      decision: 'approved' | 'declined',
      confirmedScope: { deviceBindingId?: string; artifactSha256?: string; taskId: string },
    ) => invoke(IPC.runner.authorize, operationId, decision, confirmedScope),
    listDevices: () => invoke(IPC.runner.listDevices),
    diagnostics: () => invoke(IPC.runner.diagnostics),
    onEvent: (cb: (event: RunnerEvent) => void) => {
      const listener = (_e: unknown, event: RunnerEvent) => cb(event);
      ipcRenderer.on(IPC.runner.event, listener);
      return () => ipcRenderer.removeListener(IPC.runner.event, listener);
    },
  },
  app: {
    info: () => invokeUnwrapped(IPC.app.info),
    settingsGet: () => invokeUnwrapped(IPC.app.settingsGet),
    settingsSet: (patch: Record<string, unknown>) => invokeUnwrapped(IPC.app.settingsSet, patch),
    openPath: (p: string, kind: 'evidence' | 'artifact' | 'export' | 'log' | 'project') =>
      invoke(IPC.app.openPath, p, kind),
    openExternalTerminal: (projectRoot: string) => invoke(IPC.app.openExternalTerminal, projectRoot),
    exportDiagnostics: () => invoke(IPC.app.exportDiagnostics),
    ensureProject: () => invoke(IPC.app.ensureProject),
    /** 打开中文引导终端并进入随包 CLI 官方登录（无参数） */
    openEngineLogin: () => invoke(IPC.app.openEngineLogin),
    listModelProviders: () => invoke(IPC.app.listModelProviders),
    configureModelProvider: (req: { providerId: string; apiKey: string; defaultModel?: string }) =>
      invoke(IPC.app.configureModelProvider, req),
    clearModelProvider: (providerId: string) => invoke(IPC.app.clearModelProvider, providerId),
    checkUpdate: () => invoke(IPC.app.checkUpdate),
    sshCredentialSet: (passwordEnv: string, password: string) => invoke(IPC.app.sshCredentialSet, passwordEnv, password),
    sshCredentialClear: (passwordEnv: string) => invoke(IPC.app.sshCredentialClear, passwordEnv),
    sshCredentialNames: () => invoke(IPC.app.sshCredentialNames),
    openProviderConsole: (providerId: string) => invoke(IPC.app.openProviderConsole, providerId),
    listProviderModels: (providerId: string) => invoke(IPC.app.listProviderModels, providerId),
  },
});
