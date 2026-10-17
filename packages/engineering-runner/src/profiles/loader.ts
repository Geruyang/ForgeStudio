/**
 * 工程 Profile 加载器：从目录数组加载 *.profile.json（用户数据目录优先、模板目录其次）。
 * - zod 校验（EngineeringProfileSchema 冻结契约）
 * - 缓存文件 sha256（绑定证据：revision/内容变化 ⇒ 旧证据过期）
 * - 文件 mtime 变化时自动重载；非法文件跳过并记录诊断（不阻塞其他 profile）
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { EngineeringProfileSchema, type EngineeringProfile, type LoadedProfile } from '../../../contracts/src/profile.ts';
import { sha256File } from '../snapshot/digests.ts';

interface CacheEntry {
  loaded: LoadedProfile;
  mtimeMs: number;
}

export interface ProfileLoadDiagnostics {
  filePath: string;
  reason: string;
}

export class ProfileLoader {
  private readonly dirs: string[];
  private readonly cache = new Map<string, CacheEntry>();
  private readonly diagnostics: ProfileLoadDiagnostics[] = [];

  constructor(dirs: string[]) {
    // 去重保持顺序（用户数据目录优先）
    this.dirs = [...new Set(dirs.map((d) => path.resolve(d)))];
  }

  /** 扫描目录并重建缓存（保留最近的载入诊断） */
  async reload(): Promise<void> {
    this.cache.clear();
    this.diagnostics.length = 0;
    for (const dir of this.dirs) {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // 目录不存在（模板目录可缺省）
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.profile.json')) continue;
        const filePath = path.join(dir, entry.name);
        try {
          const [raw, stat, { sha256 }] = await Promise.all([
            fsp.readFile(filePath, 'utf8'),
            fsp.stat(filePath),
            sha256File(filePath),
          ]);
          const profile = EngineeringProfileSchema.parse(JSON.parse(raw));
          if (this.cache.has(profile.id)) continue; // 先到先得：用户目录优先于模板目录
          this.cache.set(profile.id, {
            loaded: { profile, filePath, fileSha256: sha256 },
            mtimeMs: stat.mtimeMs,
          });
        } catch (error) {
          this.diagnostics.push({
            filePath,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  /** 获取 profile（mtime 变化自动重载，保证 revision/摘要最新） */
  async get(profileId: string): Promise<LoadedProfile | null> {
    const entry = this.cache.get(profileId);
    if (!entry) {
      await this.reload();
      return this.cache.get(profileId)?.loaded ?? null;
    }
    try {
      const stat = await fsp.stat(entry.loaded.filePath);
      if (stat.mtimeMs !== entry.mtimeMs) {
        await this.reload();
      }
    } catch {
      await this.reload();
    }
    return this.cache.get(profileId)?.loaded ?? null;
  }

  /** 同步取缓存（事务内路径使用；未加载返回 null） */
  getCached(profileId: string): LoadedProfile | null {
    return this.cache.get(profileId)?.loaded ?? null;
  }

  async list(): Promise<LoadedProfile[]> {
    if (this.cache.size === 0) await this.reload();
    return [...this.cache.values()].map((e) => e.loaded);
  }

  /** 最近一次加载的诊断（非法文件列表，不含文件内容） */
  loadDiagnostics(): ProfileLoadDiagnostics[] {
    return [...this.diagnostics];
  }

  get directories(): string[] {
    return [...this.dirs];
  }
}
