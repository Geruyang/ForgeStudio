/**
 * 自动更新通道（Z2C 完整实现）：electron-updater generic provider。
 * - 更新源 = settings.updateFeedUrl 指向的 latest.yml 所在 URL（发布物规范见 BUILD.md）；
 * - 「检查更新」升级为完整链：检查 → 下载（差分 blockmap）→ 校验 SHA-256 → 用户确认后 quitAndInstall；
 * - 未签名安装包：electron-updater 在 Windows 上对未签名包默认仍可安装（发布侧须自证哈希，
 *   latest.yml 的 sha256 与 UI 展示一致）；签名证书到位后自动启用强校验；
 * - 全部状态经 IPC 回 renderer（progress/downloaded/error），不阻塞 UI。
 */
import { autoUpdater } from 'electron-updater';
import { shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';

export interface UpdaterState {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  version?: string;
  progress?: { percent: number; bytesPerSecond: number; transferred: number; total: number };
  error?: string;
  releaseNotes?: string;
}

type Broadcast = (state: UpdaterState) => void;

let wired = false;
let currentState: UpdaterState = { status: 'idle' };

export function updaterState(): UpdaterState {
  return currentState;
}

/** 事件接线（app ready 后调用一次）；broadcast 推送到 renderer */
export function wireAutoUpdater(broadcast: Broadcast): void {
  if (wired) return;
  wired = true;
  autoUpdater.autoDownload = false; // 下载须用户触发（受控语义）
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;

  const set = (s: UpdaterState) => {
    currentState = s;
    broadcast(s);
  };

  autoUpdater.on('checking-for-update', () => set({ status: 'checking' }));
  autoUpdater.on('update-available', (i) =>
    set({ status: 'available', version: i.version, releaseNotes: typeof i.releaseNotes === 'string' ? i.releaseNotes : undefined }),
  );
  autoUpdater.on('update-not-available', () => set({ status: 'not-available', version: undefined }));
  autoUpdater.on('download-progress', (p) =>
    set({
      status: 'downloading',
      progress: { percent: p.percent, bytesPerSecond: p.bytesPerSecond, transferred: p.transferred, total: p.total },
    }),
  );
  autoUpdater.on('update-downloaded', (i) => set({ status: 'downloaded', version: i.version }));
  autoUpdater.on('error', (e) => set({ status: 'error', error: e.message }));
}

function requireFeedUrl(feedUrl: string | undefined): string {
  const url = (feedUrl ?? '').trim();
  if (!url) throw new Error('未配置更新源 URL（设置 → 诊断与关于 → 更新源，指向 latest.yml）');
  return url;
}

/** 检查更新（feed = latest.yml 地址） */
export async function checkUpdates(feedUrl: string | undefined): Promise<void> {
  const url = requireFeedUrl(feedUrl);
  // generic provider：setFeedURL 接受目录 URL 或 latest.yml 全路径（后者取目录）
  const dir = url.endsWith('.yml') ? url.slice(0, url.lastIndexOf('/')) : url;
  autoUpdater.setFeedURL({ provider: 'generic', url: dir });
  await autoUpdater.checkForUpdates();
}

/** 下载（available 后用户触发；差分下载走 blockmap） */
export async function downloadUpdate(): Promise<void> {
  await autoUpdater.downloadUpdate();
}

/** 安装（downloaded 后用户确认触发；退出并运行安装器） */
export function quitAndInstall(): void {
  autoUpdater.quitAndInstall(false, true);
}

/** 打开下载页（无签名提示下的人工核对路径） */
export async function openReleasePage(url: string): Promise<void> {
  await shell.openExternal(url);
}

export type UpdaterEvent = IpcMainInvokeEvent;
