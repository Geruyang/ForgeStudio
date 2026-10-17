/**
 * 摘要、路径匹配与目录遍历工具（快照层与操作层共用）。
 * 不引入第三方依赖：node:crypto / node:fs 实现。
 */
import { createHash, type Hash } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Sha256 } from '@forgedesk/contracts/common';

export function sha256Of(data: string | Buffer): Sha256 {
  return createHash('sha256').update(data).digest('hex');
}

/** 流式计算文件 sha256 与大小（大文件不整体读入内存） */
export async function sha256File(absPath: string): Promise<{ sha256: Sha256; sizeBytes: number }> {
  return await new Promise((resolve, reject) => {
    const hash: Hash = createHash('sha256');
    let size = 0;
    const stream = createReadStream(absPath);
    stream.on('data', (chunk) => {
      const buf = chunk as Buffer;
      hash.update(buf);
      size += buf.length;
    });
    stream.on('end', () => resolve({ sha256: hash.digest('hex'), sizeBytes: size }));
    stream.on('error', reject);
  });
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** 相对路径转 posix 分隔（用于入库与清单） */
export function relPosix(from: string, to: string): string {
  return toPosix(path.relative(from, to));
}

/**
 * 轻量 glob 匹配：支持 **（跨任意层级）、*（单段内）、?（单字符）。
 * 规则：含 '/' 的模式锚定项目根；不含 '/' 的模式按“任意深度的文件名”匹配。
 * 仅覆盖 profile 中实际使用的模式形态，不引入 glob 依赖。
 */
export function matchPath(relPosixPath: string, pattern: string): boolean {
  const anchored = pattern.includes('/');
  const source = pattern
    .split('/')
    .map((seg) =>
      seg === '**'
        ? '.*'
        : seg
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '[^/]*')
            .replace(/\?/g, '[^/]'),
    )
    .join('/');
  const re = new RegExp(`^${source}$`);
  if (anchored) return re.test(relPosixPath);
  const base = relPosixPath.split('/').pop() ?? relPosixPath;
  return re.test(base);
}

export function matchAny(relPosixPath: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchPath(relPosixPath, p));
}

export class WalkLimitError extends Error {}

export interface WalkOptions {
  /** 按目录名跳过（不进入） */
  skipDirNames?: string[];
  maxFiles?: number;
}

/** 枚举 root 下所有文件，返回排序后的相对 posix 路径。符号链接一律跳过。 */
export async function walkFiles(root: string, opts: WalkOptions = {}): Promise<string[]> {
  const skip = new Set(opts.skipDirNames ?? ['node_modules', '.git']);
  const maxFiles = opts.maxFiles ?? 50_000;
  const files: string[] = [];
  const walk = async (dir: string, relDir: string): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        await walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        files.push(rel);
        if (files.length > maxFiles) {
          throw new WalkLimitError(`输入文件数超过上限 ${maxFiles}，拒绝生成不完整指纹`);
        }
      }
    }
  };
  await walk(root, '');
  files.sort();
  return files;
}

/** 稳定序列化（对象键递归排序，忽略 undefined 值键），用于参数摘要与清单规范化 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}
