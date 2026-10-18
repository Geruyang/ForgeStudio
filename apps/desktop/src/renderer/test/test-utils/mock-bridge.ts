﻿﻿﻿﻿﻿﻿/**
 * 测试专用 ForgeDeskBridge 假实现（只在测试文件中创建/注入）：
 * - 全部方法可按分区覆写，未覆写方法返回"测试桥未配置"失败（不假造成功）；
 * - engine/runner 事件可脚本化推送（emitEngineEvent / emitRunnerEvent）；
 * - 每次调用按序记录到 calls，供交互断言。
 */
import { fail } from '../../contracts/common';
import type { EngineEvent, EngineStatus } from '../../contracts/engine';
import type { ForgeDeskBridge } from '../../contracts/ipc';
import type { RunnerEvent } from '../../contracts/runner';

export interface BridgeCall {
  method: string;
  args: unknown[];
}

export interface MockBridge extends ForgeDeskBridge {
  /** 全部桥方法调用记录（按序），供断言 */
  calls: BridgeCall[];
  /** 向已订阅的 engine 事件回调推送事件 */
  emitEngineEvent(event: EngineEvent): void;
  /** 向已订阅的 runner 事件回调推送事件 */
  emitRunnerEvent(event: RunnerEvent): void;
  /** engine.status() 的同步返回值（默认 stopped） */
  setEngineStatus(status: EngineStatus): void;
}

/** 各分区可选择性覆写；未覆写的方法返回"测试桥未配置"失败 */
export type BridgeOverrides = {
  engine?: Partial<ForgeDeskBridge['engine']>;
  session?: Partial<ForgeDeskBridge['session']>;
  runner?: Partial<ForgeDeskBridge['runner']>;
  app?: Partial<ForgeDeskBridge['app']>;
};

type AnyFn = (...args: never[]) => unknown;

function recordCalls<T extends Record<string, AnyFn>>(calls: BridgeCall[], section: string, impls: T): T {
  const out = {} as Record<string, AnyFn>;
  for (const key of Object.keys(impls)) {
    const fn = impls[key];
    out[key] = ((...args: never[]) => {
      calls.push({ method: `${section}.${key}`, args: args as unknown[] });
      return fn(...args);
    }) as AnyFn;
  }
  return out as T;
}

const unconfigured = () => fail('internal_error', '测试桥未配置该方法');

export function createMockBridge(overrides: BridgeOverrides = {}): MockBridge {
  const calls: BridgeCall[] = [];
  let engineStatus: EngineStatus = 'stopped';
  const engineSubs = new Set<(e: EngineEvent) => void>();
  const runnerSubs = new Set<(e: RunnerEvent) => void>();

  const engineDefaults: ForgeDeskBridge['engine'] = {
    start: async () => unconfigured(),
    send: async () => unconfigured(),
    steer: async () => unconfigured(),
    interrupt: async () => unconfigured(),
    review: async () => unconfigured(),
    approve: async () => unconfigured(),
    models: async () => unconfigured(),
    authStatus: async () => unconfigured(),
    status: () => engineStatus,
    onEvent: (cb) => {
      engineSubs.add(cb);
      return () => {
        engineSubs.delete(cb);
      };
    },
  };

  const sessionDefaults: ForgeDeskBridge['session'] = {
    listThreads: async () => unconfigured(),
    loadThread: async () => unconfigured(),
    loadPatch: async () => unconfigured(),
    renameThread: async () => unconfigured(),
    deleteThread: async () => unconfigured(),
    compactThread: async () => unconfigured(),
  };

  const runnerDefaults: ForgeDeskBridge['runner'] = {
    listTasks: async () => unconfigured(),
    getTask: async () => unconfigured(),
    listProfiles: async () => unconfigured(),
    createTask: async () => unconfigured(),
    updateAcceptance: async () => unconfigured(),
    manualReview: async () => unconfigured(),
    invoke: async () => unconfigured(),
    cancel: async () => unconfigured(),
    pendingAuthorization: async () => unconfigured(),
    authorize: async () => unconfigured(),
    listDevices: async () => unconfigured(),
    diagnostics: async () => unconfigured(),
    onEvent: (cb) => {
      runnerSubs.add(cb);
      return () => {
        runnerSubs.delete(cb);
      };
    },
  };

  const appDefaults: ForgeDeskBridge['app'] = {
    info: () => {
      throw new Error('测试桥未配置 app.info');
    },
    settingsGet: () => {
      throw new Error('测试桥未配置 app.settingsGet');
    },
    settingsSet: async () => {
      throw new Error('测试桥未配置 app.settingsSet');
    },
    openPath: async () => unconfigured(),
    openExternalTerminal: async () => unconfigured(),
    exportDiagnostics: async () => unconfigured(),
    checkUpdate: async () => unconfigured(),
    sshCredentialSet: async () => unconfigured(),
    sshCredentialClear: async () => unconfigured(),
    sshCredentialNames: async () => unconfigured(),
    updaterDownload: async () => unconfigured(),
    updaterInstall: async () => unconfigured(),
    updaterState: async () => unconfigured(),
    onUpdaterEvent: () => () => undefined,
    ensureProject: async () => unconfigured(),
    openEngineLogin: async () => unconfigured(),
    listModelProviders: async () => unconfigured(),
    configureModelProvider: async () => unconfigured(),
    clearModelProvider: async () => unconfigured(),
    openProviderConsole: async () => unconfigured(),
    listProviderModels: async () => unconfigured(),
  };

  const bridge: ForgeDeskBridge = {
    engine: recordCalls(calls, 'engine', { ...engineDefaults, ...overrides.engine } as ForgeDeskBridge['engine']),
    session: recordCalls(calls, 'session', { ...sessionDefaults, ...overrides.session } as ForgeDeskBridge['session']),
    runner: recordCalls(calls, 'runner', { ...runnerDefaults, ...overrides.runner } as ForgeDeskBridge['runner']),
    app: recordCalls(calls, 'app', { ...appDefaults, ...overrides.app } as ForgeDeskBridge['app']),
  };

  return {
    ...bridge,
    calls,
    emitEngineEvent(event: EngineEvent) {
      for (const cb of [...engineSubs]) cb(event);
    },
    emitRunnerEvent(event: RunnerEvent) {
      for (const cb of [...runnerSubs]) cb(event);
    },
    setEngineStatus(status: EngineStatus) {
      engineStatus = status;
    },
  };
}
