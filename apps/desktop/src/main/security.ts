/**
 * 安全基线（Electron 官方安全建议 + 任务书 §12.2）：
 * - 渲染进程 sandbox + contextIsolation + 禁用 nodeIntegration
 * - CSP；开发态放行 Vite HMR
 * - 导航与窗口打开锁定
 * - IPC sender 校验
 */
import type { Session, WebContents, App } from 'electron';

export const CSP_PROD = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
].join('; ');

export const CSP_DEV = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:5173",
  "style-src 'self' 'unsafe-inline' http://localhost:5173",
  "img-src 'self' data: http://localhost:5173",
  "connect-src 'self' ws://localhost:5173 http://localhost:5173",
].join('; ');

export function installSecurityPolicies(session: Session, isDev: boolean): void {
  const csp = isDev ? CSP_DEV : CSP_PROD;
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}

export function lockNavigation(app: App, wc: WebContents, devServerUrl: string | null): void {
  const allowSelf = (target: string): boolean => {
    if (devServerUrl && target === devServerUrl) return true;
    return target.startsWith('file://');
  };
  wc.on('will-navigate', (event, url) => {
    if (!allowSelf(url)) event.preventDefault();
  });
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}
