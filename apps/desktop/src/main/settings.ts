/**
 * 应用设置：dataDir/settings.json 原子读写。
 * 模型 API key 不存这里 —— 存产品 CODEX_HOME/auth.json（引擎正式路径）。
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { AppSettings } from '@forgedesk/contracts/ipc';

const DEFAULTS: AppSettings = {
  uiLanguage: 'zh-CN',
  confirmExitOnDeviceOp: true,
  maxRendererEventQueue: 500,
};

export class SettingsStore {
  #queue: Promise<unknown> = Promise.resolve();
  readonly #file: string;
  #cache: AppSettings | null = null;

  constructor(dataDir: string) {
    this.#file = path.join(dataDir, 'settings.json');
  }

  async load(): Promise<AppSettings> {
    if (this.#cache) return this.#cache;
    try {
      const raw = JSON.parse(await fsp.readFile(this.#file, 'utf8')) as Partial<AppSettings>;
      this.#cache = { ...DEFAULTS, ...raw, recentProjects: raw.recentProjects ?? [] };
    } catch {
      this.#cache = { ...DEFAULTS, recentProjects: [] };
    }
    return this.#cache;
  }

  async patch(p: Partial<AppSettings>): Promise<AppSettings> {
    // 串行化 patch（读-改-写链）：并发调用避免交错覆盖丢更新
    const job = this.#queue.then(async () => {
      const cur = await this.load();
      const next: AppSettings = { ...cur, ...p };
      await this.#write(next);
      this.#cache = next;
      return next;
    });
    this.#queue = job.catch(() => undefined);
    return job;
  }

  /** 原子写：临时文件 + rename，避免半截 JSON */
  async #write(s: AppSettings): Promise<void> {
    await fsp.mkdir(path.dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp-${Date.now()}`;
    await fsp.writeFile(tmp, JSON.stringify(s, null, 2), 'utf8');
    await fsp.rename(tmp, this.#file);
  }
}

/** 扩展字段：最近项目（桥 ensureProject 维护） */
declare module '@forgedesk/contracts/ipc' {
  interface AppSettings {
    recentProjects?: Array<{ projectRoot: string; name: string; at: string }>;
    defaultModel?: string;
  }
}
