/**
 * Store 的 React 绑定：Context + selector hook。
 * App 生产路径注入 getBridge() 创建的 store；测试注入 createAppStore(createTestBridge(...))。
 */
import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import type { AppStore } from './store';

const StoreContext = createContext<StoreApi<AppStore> | null>(null);

export function StoreProvider({
  store,
  children,
}: {
  store: StoreApi<AppStore>;
  children: ReactNode;
}) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useAppStore<T>(selector: (state: AppStore) => T): T {
  const store = useContext(StoreContext);
  if (!store) {
    throw new Error('缺少 StoreProvider：请通过 <StoreProvider store={...}> 提供应用状态');
  }
  return useStore(store, selector);
}

/** 读取 store 的命令式入口（事件回调/异步流程中取最新状态） */
export function useStoreApi(): StoreApi<AppStore> {
  const store = useContext(StoreContext);
  if (!store) {
    throw new Error('缺少 StoreProvider：请通过 <StoreProvider store={...}> 提供应用状态');
  }
  return store;
}
