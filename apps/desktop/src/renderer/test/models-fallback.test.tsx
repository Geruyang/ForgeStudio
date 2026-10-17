/**
 * 认证即可选模型（refreshModels 回退链）：
 * 引擎 model/list 优先 → 已配置 key 的激活提供方直拉 /models → 空列表（预期态不报错）。
 */
import { describe, expect, it } from 'vitest';
import { ok, fail } from '../contracts/common';
import type { ModelProviderSummary } from '../contracts/ipc';
import { makeSetup } from './test-utils/render';

const providers = (active?: Partial<ModelProviderSummary>): ModelProviderSummary[] => {
  const base: ModelProviderSummary = {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    envKey: 'DEEPSEEK_API_KEY',
    modelHint: 'deepseek-chat',
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    officialLogin: false,
    keyConfigured: false,
    active: false,
    planNote: '',
    ...active,
  };
  return [
    { ...base, id: 'openai', label: 'OpenAI', envKey: 'OPENAI_API_KEY' },
    base,
  ];
};

describe('refreshModels 回退链（认证即可选模型）', () => {
  it('引擎不可用且未配置 key → 空列表且不弹错误', async () => {
    const setup = makeSetup({
      engine: { models: async () => fail('internal_error', '引擎未启动') },
      app: { listModelProviders: async () => ok(providers()) },
    });
    await setup.store.getState().refreshModelProviders();
    await setup.store.getState().refreshModels();
    expect(setup.store.getState().models).toEqual([]);
    const t = setup.store.getState().toast;
    expect(t === null || t?.kind !== 'error').toBe(true);
  });

  it('引擎不可用但激活提供方已配 key → 直拉 /models 填充；preferred=settings.defaultModel', async () => {
    const setup = makeSetup({
      engine: { models: async () => fail('internal_error', '引擎未启动') },
      app: {
        listModelProviders: async () => ok(providers({ keyConfigured: true, active: true })),
        listProviderModels: async () => ok(['deepseek-chat', 'deepseek-reasoner']),
      },
    });
    setup.store.setState({ settings: { uiLanguage: 'zh-CN', defaultModel: 'deepseek-reasoner' } as never });
    await setup.store.getState().refreshModelProviders();
    await setup.store.getState().refreshModels();
    const s = setup.store.getState();
    expect(s.models.map((m) => m.id)).toEqual(['deepseek-chat', 'deepseek-reasoner']);
    expect(s.selectedModel).toBe('deepseek-reasoner'); // 尊重既有默认
  });

  it('无默认模型时取 provider 列表首项', async () => {
    const setup = makeSetup({
      engine: { models: async () => fail('internal_error', '引擎未启动') },
      app: {
        listModelProviders: async () => ok(providers({ keyConfigured: true, active: true })),
        listProviderModels: async () => ok(['deepseek-chat']),
      },
    });
    await setup.store.getState().refreshModelProviders();
    await setup.store.getState().refreshModels();
    expect(setup.store.getState().selectedModel).toBe('deepseek-chat');
  });

  it('引擎可用 → 直接用引擎列表（不经 provider）', async () => {
    let providerCalled = false;
    const setup = makeSetup({
      engine: { models: async () => ok([{ id: 'gpt-5' }, { id: 'gpt-5-mini' }]) },
      app: {
        listModelProviders: async () => ok(providers({ keyConfigured: true, active: true })),
        listProviderModels: async () => {
          providerCalled = true;
          return ok(['deepseek-chat']);
        },
      },
    });
    await setup.store.getState().refreshModelProviders();
    await setup.store.getState().refreshModels();
    expect(setup.store.getState().models.map((m) => m.id)).toEqual(['gpt-5', 'gpt-5-mini']);
    expect(providerCalled).toBe(false);
  });
});
