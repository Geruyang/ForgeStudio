/**
 * 测试渲染辅助：注入假桥 + 立即模式事件批量的应用 store。
 */
import { render, type RenderOptions } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { createAppStore, type AppStore, type StoreOptions } from '../../store/store';
import { StoreProvider } from '../../store/context';
import { createMockBridge, type BridgeOverrides, type MockBridge } from './mock-bridge';

export interface TestSetup {
  bridge: MockBridge;
  store: StoreApi<AppStore>;
}

export function makeSetup(overrides: BridgeOverrides = {}, options: StoreOptions = {}): TestSetup {
  const bridge = createMockBridge(overrides);
  const store = createAppStore(bridge, { eventBatching: 'immediate', ...options });
  return { bridge, store };
}

export function renderWithStore(ui: ReactElement, setup: TestSetup, options?: RenderOptions) {
  return render(<StoreProvider store={setup.store}>{ui}</StoreProvider>, options);
}
