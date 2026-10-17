/**
 * 应用外壳：三栏 + 底部停靠 + 侧滑差异面板 + 弹窗层。
 * - 生产注入 window.forgedesk；桥缺失时呈现引导（不白屏）；
 * - bootstrap 拉取设置/线程/任务/设备/认证/模型并订阅事件；
 * - beforeunload：有进行中设备操作且开关开启时提示（确认对话框由主进程承接）。
 */
import { useEffect, useRef, useState } from 'react';
import { getBridge } from './bridge/bridge';
import { createAppStore } from './store/store';
import { StoreProvider, useAppStore, useStoreApi } from './store/context';
import { TopBar } from './views/TopBar';
import { Sidebar } from './views/Sidebar';
import { ChatView } from './views/ChatView';
import { EngineeringPanel } from './views/EngineeringPanel';
import { BottomDock } from './views/BottomDock';
import { GlobalBanners } from './views/GlobalBanners';
import { DiffPanel } from './views/DiffPanel';
import { SettingsView } from './views/SettingsView';
import { TaskWizard } from './views/TaskWizard';
import { ConfirmDialog } from './components/common/ConfirmDialog';
import { ToastHost } from './components/common/ToastHost';
import { ForgeMark } from './components/brand/Logo';

export function App() {
  const [store, setStore] = useState<ReturnType<typeof createAppStore> | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const bridge = getBridge();
      const s = createAppStore(bridge, {
        // 补丁全文通道（主进程从引擎存储 patches/ 目录读取，防路径穿越校验在主进程）
        patchContent: async (patchRef) => {
          const r = await bridge.session.loadPatch(patchRef);
          return r.ok ? r.value.text : null;
        },
      });
      setStore(s);
      return () => s.getState().destroy();
    } catch (err) {
      setBridgeError(String(err instanceof Error ? err.message : err));
      return undefined;
    }
  }, []);

  if (bridgeError || !store) {
    return (
      <div className="app--nobridge" style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
        <div className="fd-empty">
          <ForgeMark size={40} />
          <div className="fd-empty__title">ForgeStudio 桥不可用</div>
          <div className="fd-empty__hint">{bridgeError ?? '正在连接主进程…'}</div>
        </div>
      </div>
    );
  }

  return (
    <StoreProvider store={store}>
      <AppShell />
    </StoreProvider>
  );
}

function AppShell() {
  const storeApi = useStoreApi();
  const confirm = useAppStore((s) => s.confirm);
  const requestConfirm = useAppStore((s) => s.requestConfirm);
  const closeConfirm = useAppStore((s) => s.closeConfirm);
  const bootedRef = useRef(false);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    void storeApi.getState().bootstrap();
  }, [storeApi]);

  // 窗口关闭语义：有进行中设备操作（烧录/待授权）且开关开启时，交给主进程确认
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      const s = storeApi.getState();
      if (!s.settings?.confirmExitOnDeviceOp) return;
      const deviceBusy =
        s.turnRunning ||
        s.pendingAuths.length > 0 ||
        s.tasks.some((t) =>
          t.operations.some(
            (o) =>
              (o.type === 'device_flash' || o.type === 'device_verify') &&
              (o.status === 'running' || o.status === 'awaiting_authorization' || o.status === 'authorized'),
          ),
        );
      if (!deviceBusy) return;
      e.preventDefault();
      e.returnValue =
        '有正在执行的设备操作（烧录/验证/待授权）。关闭窗口可能留下无管理的硬件任务，确定要退出吗？';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [storeApi]);

  return (
    <div className="app">
      <TopBar />
      <Sidebar />
      <section style={{ gridArea: 'chat', display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        <GlobalBanners />
        <ChatView />
      </section>
      <EngineeringPanel />
      <BottomDock />
      <DiffPanel />
      <SettingsView />
      <TaskWizard />
      <ToastHost />
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          danger={confirm.danger}
          confirmText={confirm.confirmText}
          onConfirm={() => {
            confirm.onConfirm();
            closeConfirm();
          }}
          onCancel={closeConfirm}
        />
      )}
    </div>
  );
}
