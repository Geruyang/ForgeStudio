/**
 * ForgeDesk 主进程入口。
 * - ELECTRON_RUN_AS_NODE + --fd-mcp-bridge 时退化为 MCP 桥进程（codex 按产品 config.toml 拉起）
 * - 正常模式：窗口（sandbox+contextIsolation+白名单 preload）、runner 服务、引擎宿主、IPC 注册
 * - 关闭语义：最小化/关闭/退出分开；有进行中设备操作时确认（设置开关）
 */
import path from 'node:path';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog } from 'electron';
import { resolveAppPaths, type AppPaths } from './paths';
import { SettingsStore } from './settings';
import { RunnerHost } from './runner-host';
import { readSshCredentials, setSshCredential, clearSshCredential, listSshCredentialNames } from './ssh-credentials';
import { EngineHost } from './engine-host';
import { registerIpc, type IpcContext } from './ipc-registry';
import { installSecurityPolicies, lockNavigation } from './security';
import { IPC } from '@forgedesk/contracts/ipc';

// 安装态数据目录规范化（产品名 ForgeStudio）：Electron 默认按包名（@forgedesk/desktop）派生
// userData，在 ready 前固定为规范路径；并一次性迁移旧 ForgeDesk 数据目录
// （rename 保留任务/验收证据/引擎配置与登录态；迁移失败不阻塞启动，以新目录全新开始）。
if (app.isPackaged) {
  const appData = app.getPath('appData');
  const userDataDir = path.join(appData, 'ForgeStudio');
  const legacyDir = path.join(appData, 'ForgeDesk');
  try {
    if (!fs.existsSync(userDataDir) && fs.existsSync(legacyDir)) {
      fs.renameSync(legacyDir, userDataDir);
      console.log('[main] 旧版数据目录已迁移: ForgeDesk -> ForgeStudio');
    }
  } catch (err) {
    console.warn('[main] 旧版数据目录迁移失败（以新目录启动）:', err);
  }
  app.setPath('userData', userDataDir);
}

// 单实例：第二个实例聚焦既有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let ctx: IpcContext | null = null;
let runnerHost: RunnerHost | null = null;
let engineHost: EngineHost | null = null;
let settingsStore: SettingsStore | null = null;
let paths: AppPaths | null = null;
let quitting = false;

const DEV_SERVER_URL = process.env.FD_DEV_SERVER_URL ?? null;
const thisFileDir = path.dirname(fileURLToPath(import.meta.url));

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

async function bootstrap(): Promise<void> {
  paths = resolveAppPaths();
  await fsp.mkdir(paths.dataDir, { recursive: true });
  await fsp.mkdir(paths.engineHome, { recursive: true });
  await fsp.mkdir(path.join(paths.dataDir, 'profiles'), { recursive: true });

  settingsStore = new SettingsStore(paths.dataDir);
  await settingsStore.load();

  // runner：唯一权威执行器实例（utilityProcess + 发现文件）
  runnerHost = new RunnerHost({
    dataDir: paths.dataDir,
    runnerServicePath: paths.runnerServicePath,
    bundledProfilesDir: paths.bundledProfilesDir,
    // SSH 板卡凭据随启动注入（Z3 GUI 链；凭据更新后需重启应用生效——如实语义）
    sshCredentialEnv: await readSshCredentials(paths.dataDir),
    onEvent: (event) => mainWindow?.webContents.send(IPC.runner.event, event),
    onExited: (code) => {
      // runner 崩溃：界面显示不可用，不拖死普通编码会话（任务书 §6.2）
      mainWindow?.webContents.send(IPC.engine.event, {
        seq: Date.now(),
        connectionGeneration: 0,
        type: 'engine/status',
        status: 'error',
        detail: `工程执行器已退出（code=${code}）`,
        emittedAt: new Date().toISOString(),
      });
    },
  });

  // 引擎宿主：MCP 桥经自进程（ELECTRON_RUN_AS_NODE）复用随包运行时；
  // 多提供方（火山方舟/智谱/Kimi/千问/DeepSeek）运行时配置在每次引擎启动前解析
  engineHost = new EngineHost({
    codexCliPath: paths.codexCliPath,
    engineHome: paths.engineHome,
    sessionStorageDir: paths.sessionStorageDir,
    mcpBridge: {
      command: paths.selfExePath,
      args: [paths.mcpBridgePath],
      env: { ELECTRON_RUN_AS_NODE: '1', FD_RUNNER_DATA_DIR: paths.dataDir },
    },
    getRuntimeProvider: async () => {
      const { resolveRuntimeProvider } = await import('./provider-config');
      const p = paths;
      if (!p) throw new Error('路径未初始化');
      return resolveRuntimeProvider(p.engineHome, settingsStore!);
    },
    onEvent: (event) => mainWindow?.webContents.send(IPC.engine.event, event),
  });

  ctx = {
    paths,
    engine: engineHost,
    runner: runnerHost,
    settings: settingsStore,
    getVersion: () => app.getVersion(),
    getMainWindow: () => mainWindow,
  };
  registerIpc(ctx);
  // engine.status() 同步通道（sendSync 白名单唯一成员，载荷极小）
  const { ipcMain } = await import('electron');
  ipcMain.on(IPC.engine.status, (event) => {
    event.returnValue = engineHost?.status ?? 'stopped';
  });

  await runnerHost.start().catch((err: unknown) => {
    // runner 起不来不阻塞窗口；界面按不可用呈现并给出诊断
    console.error('[forgedesk] runner 启动失败:', err);
  });

  createWindow(paths);
}

function createWindow(p: AppPaths): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#111418',
    title: 'ForgeStudio',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(thisFileDir, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  installSecurityPolicies(mainWindow.webContents.session, p.isDev);
  lockNavigation(app, mainWindow.webContents, DEV_SERVER_URL);

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', (event) => {
    if (quitting) return;
    // 关闭语义：设备操作进行中时确认（renderer beforeunload 提示之外的兜底）
    void handleCloseConfirm(event);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (DEV_SERVER_URL) {
    void mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(thisFileDir, '..', 'renderer', 'index.html'));
  }
}

async function handleCloseConfirm(event: Electron.Event): Promise<void> {
  const settings = await settingsStore?.load();
  if (!settings?.confirmExitOnDeviceOp || !runnerHost?.ready) return;
  try {
    const pending = await runnerHost.request<Array<unknown>>('/api/pending-authorization');
    if (!Array.isArray(pending) || pending.length === 0) return;
  } catch {
    return; // runner 不可达时不阻塞关闭
  }
  const choice = dialog.showMessageBoxSync(mainWindow!, {
    type: 'warning',
    title: 'ForgeStudio',
    message: '有正在等待授权的设备操作。关闭窗口可能留下无管理的硬件任务，确定要退出吗？',
    buttons: ['退出', '取消'],
    defaultId: 1,
    cancelId: 1,
  });
  if (choice === 1) event.preventDefault();
}

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', (event) => {
  // 优雅收尾：先引擎后 runner（runner 内部等待在途操作安全收尾）
  event.preventDefault();
  void (async () => {
    try {
      await engineHost?.dispose();
    } finally {
      await runnerHost?.stop();
      app.exit(0);
    }
  })();
});

app.whenReady().then(bootstrap).catch((err) => {
  console.error('[forgedesk] 启动失败:', err);
  dialog.showErrorBox('ForgeStudio 启动失败', String(err instanceof Error ? err.message : err));
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
