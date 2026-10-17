﻿﻿﻿﻿/**
 * ForgeDesk renderer 桥：
 * 生产环境只经 window.forgedesk（preload 白名单注入，唯一通道）调用主进程。
 * 测试用可编程假桥在 test/test-utils/mock-bridge.ts —— 产品代码路径不引用。
 */
import type { ForgeDeskBridge } from '../contracts/ipc';

export function getBridge(): ForgeDeskBridge {
  if (typeof window === 'undefined' || !window.forgedesk) {
    throw new Error('window.forgedesk 桥不可用：请在 ForgeStudio 桌面环境（Electron 主进程 + preload）中打开本界面');
  }
  return window.forgedesk;
}
