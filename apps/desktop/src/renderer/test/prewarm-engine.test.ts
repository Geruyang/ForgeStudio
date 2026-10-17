/**
 * 引擎预热（认证即可用）：认证就绪（官方登录或 provider key）即启动引擎，
 * 免选目录/免开会话——打开客户端即可选模型、发消息（D15）。
 */
import { describe, expect, it } from 'vitest';
import { ok } from '../contracts/common';
import type { AppInfo, AppSettings, ModelProviderSummary } from '../contracts/ipc';
import { makeSetup } from './test-utils/render';

const appInfo: AppInfo = {
  name: 'ForgeStudio',
  version: '0.1.0',
  platform: 'win32',
  electronVersion: '30.0.0',
  nodeVersion: '20.0.0',
  dataDir: 'C:\\Users\\tester\\AppData\\Roaming\\ForgeStudio',
  homeDir: 'C:\\Users\\tester',
  engineHome: 'C:\\Users\\tester\\AppData\\Roaming\\ForgeStudio\\engine',
  engineCliPath: 'C:\\Program Files\\ForgeStudio\\resources\\engine\\codex\\bin\\codex.exe',
};

const settings = (over: Partial<AppSettings> = {}): AppSettings => ({
  uiLanguage: 'zh-CN',
  confirmExitOnDeviceOp: true,
  maxRendererEventQueue: 500,
  ...over,
});

const providers = (configured: boolean): ModelProviderSummary[] => [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    envKey: 'DEEPSEEK_API_KEY',
    modelHint: 'deepseek-chat',
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    officialLogin: false,
    keyConfigured: configured,
    active: configured,
    planNote: '',
  },
];

/** bootstrap 全链可用的基础 mock（认证形态按用例覆写） */
function baseMocks(over: {
  authOk: boolean;
  getSettings?: () => AppSettings;
  start?: () => Promise<ReturnType<typeof ok<{ threadId: string; generation: number }>>>;
}) {
  return {
    engine: {
      authStatus: async () =>
        ok(
          over.authOk
            ? { mode: 'chatgpt_account' as const, ok: true, accountHint: 'tester@example.com' }
            : { mode: 'none' as const, ok: false },
        ),
      models: async () => ok([{ id: 'gpt-5' }]),
      start: over.start ?? (async () => ok({ threadId: 't1', generation: 1 })),
    },
    session: { listThreads: async () => ok([]) },
    runner: {
      listTasks: async () => ok([]),
      listDevices: async () => ok([]),
      pendingAuthorization: async () => ok([]),
    },
    app: {
      info: async () => appInfo,
      settingsGet: async () => (over.getSettings ?? settings)(),
      listModelProviders: async () => ok(providers(false)),
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const startCalls = (bridge: ReturnType<typeof makeSetup>['bridge']) =>
  bridge.calls.filter((c) => c.method === 'engine.start');

describe('prewarmEngine 认证即可用（免选目录/免开会话）', () => {
  it('官方登录（无 provider key）→ bootstrap 即预热引擎，cwd 兜底 homeDir，并同步 project', async () => {
    // start 挂起直到放行：验证 bootstrap 内 refreshAuth 触发 + 尾部触发只 start 一次
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const setup = makeSetup(
      baseMocks({ authOk: true, start: async () => ((await gate), ok({ threadId: 't1', generation: 1 })) }),
    );
    await setup.store.getState().bootstrap();
    // refreshAuth 触发的预热已同步记录 start；bootstrap 尾部触发被 in-flight 守卫拦截
    expect(startCalls(setup.bridge)).toHaveLength(1);
    expect(startCalls(setup.bridge)[0].args[0]).toBe('C:\\Users\\tester'); // 无最近项目 → homeDir
    release();
    await flush();
    const s = setup.store.getState();
    expect(s.project?.root).toBe('C:\\Users\\tester');
    expect(s.project?.name).toBe('tester'); // 顶栏显示项目名
  });

  it('同 tick 重复调用幂等：只 start 一次', async () => {
    const setup = makeSetup(baseMocks({ authOk: true }));
    // 直调场景需先具备 bootstrap 拉到的状态（appInfo/认证）
    setup.store.setState({ appInfo, authStatus: { mode: 'chatgpt_account', ok: true } });
    const p1 = setup.store.getState().prewarmEngine();
    const p2 = setup.store.getState().prewarmEngine();
    await Promise.all([p1, p2]);
    expect(startCalls(setup.bridge)).toHaveLength(1);
  });

  it('最近项目优先于 homeDir 作为预热 cwd', async () => {
    const setup = makeSetup(
      baseMocks({
        authOk: true,
        getSettings: () =>
          settings({ recentProjects: [{ projectRoot: 'E:\\proj-a', name: 'proj-a', at: '2026-01-01T00:00:00Z' }] }),
      }),
    );
    await setup.store.getState().bootstrap();
    await flush();
    expect(startCalls(setup.bridge)[0].args[0]).toBe('E:\\proj-a');
    expect(setup.store.getState().project?.name).toBe('proj-a');
  });

  it('未认证（官方登录与 provider key 均无）→ 不预热', async () => {
    const setup = makeSetup(baseMocks({ authOk: false }));
    await setup.store.getState().bootstrap();
    await flush();
    expect(startCalls(setup.bridge)).toHaveLength(0);
  });

  it('引擎已在运行（非 stopped）→ 不重复 start', async () => {
    const setup = makeSetup(baseMocks({ authOk: true }));
    setup.bridge.setEngineStatus('ready');
    await setup.store.getState().prewarmEngine();
    expect(startCalls(setup.bridge)).toHaveLength(0);
  });

  it('刚配好 provider key（configureModelProvider 成功）→ 立即预热', async () => {
    let configured = false;
    const setup = makeSetup({
      ...baseMocks({ authOk: false }),
      app: {
        info: async () => appInfo,
        settingsGet: async () => settings(),
        listModelProviders: async () => ok(providers(configured)),
        configureModelProvider: async () => {
          configured = true;
          return ok(undefined);
        },
        listProviderModels: async () => ok(['deepseek-chat']),
      },
    });
    await setup.store.getState().bootstrap(); // 未认证不预热
    expect(startCalls(setup.bridge)).toHaveLength(0);
    const r = await setup.store.getState().configureModelProvider({ providerId: 'deepseek', apiKey: 'sk-x' });
    expect(r).toBe(true);
    // prewarmEngine 在 configureModelProvider 内同步调用，start 调用记录已生成
    expect(startCalls(setup.bridge)).toHaveLength(1);
    expect(startCalls(setup.bridge)[0].args[0]).toBe('C:\\Users\\tester');
  });

  it('预热线程不绑定模型（防陈旧 defaultModel 致线程 systemError）', async () => {
    const setup = makeSetup(
      baseMocks({
        authOk: true,
        getSettings: () => settings({ defaultModel: 'deepseek-chat' }), // 陈旧残留
      }),
    );
    await setup.store.getState().bootstrap();
    await flush();
    expect(startCalls(setup.bridge)).toHaveLength(1);
    // 只传 root，无 options.model——线程交给引擎默认模型
    expect(startCalls(setup.bridge)[0].args).toHaveLength(1);
  });

  it('引擎就绪时 selectModel → 同 root 以新模型重建线程并重置会话', async () => {
    const setup = makeSetup(baseMocks({ authOk: true }));
    await setup.store.getState().bootstrap();
    await flush();
    expect(startCalls(setup.bridge)).toHaveLength(1); // 预热
    setup.store.setState({
      project: { root: 'C:\\Users\\tester', name: 'tester' },
      liveThreadId: 'old-thread',
      conversationMode: 'live',
    });
    setup.bridge.setEngineStatus('ready');
    await setup.store.getState().selectModel('gpt-5.6-sol');
    const calls = startCalls(setup.bridge);
    expect(calls).toHaveLength(2); // 预热 + 模型切换重建
    expect(calls[1].args[0]).toBe('C:\\Users\\tester');
    expect((calls[1].args[1] as { model?: string })?.model).toBe('gpt-5.6-sol');
    const s = setup.store.getState();
    expect(s.liveThreadId).toBe('t1'); // 重建后的新线程（mock start 返回 t1）
    expect(s.selectedModel).toBe('gpt-5.6-sol');
    expect(s.conversationMode).toBe('live');
  });

  it('回合进行中 selectModel 不重启引擎（防打断）', async () => {
    const setup = makeSetup(baseMocks({ authOk: true }));
    await setup.store.getState().bootstrap();
    await flush();
    setup.store.setState({ project: { root: 'C:\\Users\\tester', name: 'tester' }, turnRunning: true });
    setup.bridge.setEngineStatus('ready');
    await setup.store.getState().selectModel('gpt-5.6-sol');
    expect(startCalls(setup.bridge)).toHaveLength(1); // 仅预热，未因切换重建
  });
});
