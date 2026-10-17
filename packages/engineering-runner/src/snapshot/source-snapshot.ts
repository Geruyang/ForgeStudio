/**
 * A 级输入指纹（evidenceLevel:'A'，任务书 §8.2 / M5）。
 * - git 运行时探测：spawn 'git'（ENOENT → hasGit=false，不虚报）
 * - 有 git：gitCommit + dirtyDiffDigest（status --porcelain + diff HEAD 聚合）+ untrackedDigest，
 *   inputManifest = 显式配置类输入 + 未提交修改（tracked_modified）+ 未跟踪输入（untracked），
 *   干净且已跟踪的源码由 gitCommit 锁定，不重复入清单
 * - 无 git：完整输入清单内容摘要回退（全部文件入清单），hasGit=false 标明
 * - 采集规则：profile.inputIncludes 必含（优先于排除规则）+ 默认源码树，
 *   排除 inputExcludes 与 node_modules/dist/release/.runtime/日志产物等派生文件
 * - 限额：单文件 16MB、总清单 20000 文件；超限 → SnapshotLimitError（采集失败→证据待重验，不假造）
 * - inputDigest = 清单规范化排序后的 sha256（附加 profile 文件摘要行：
 *   profile revision 变化 ⇒ 输入指纹变化 ⇒ 旧证据过期）
 */
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { newId, SCHEMA_VERSION } from '@forgedesk/contracts/common';
import type { SourceInputDigest, SourceInputKind, SourceSnapshot } from '@forgedesk/contracts/engineering';
import type { EngineeringProfile } from '../../../contracts/src/profile.ts';
import {
  matchAny,
  matchPath,
  sha256File,
  sha256Of,
  toPosix,
  walkFiles,
  WalkLimitError,
} from './digests.ts';

/** 默认排除：确认不参与构建的派生目录与日志产物（git 元数据目录一并排除） */
export const DEFAULT_INPUT_EXCLUDES: readonly string[] = [
  'node_modules/**',
  'dist/**',
  'release/**',
  '.runtime/**',
  'out/**',
  'coverage/**',
  '*.log',
  '*.tmp',
];

const SNAPSHOT_SKIP_DIRS: readonly string[] = [
  'node_modules',
  'dist',
  'release',
  '.runtime',
  'out',
  'coverage',
  '.git',
];

/** 快照采集限额（任务书 §8.2：超限拒绝生成不完整指纹） */
export const SNAPSHOT_MAX_FILE_BYTES = 16 * 1024 * 1024; // 单文件 16MB
export const SNAPSHOT_MAX_MANIFEST_FILES = 20_000; // 总清单 20000 文件
const SNAPSHOT_WALK_HARD_CAP = 60_000; // 目录遍历安全上限（防符号链接风暴/异常工程）

/** 快照采集失败（超限等）→ 证据待重验，不假造指纹 */
export class SnapshotLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotLimitError';
  }
}

const LOCKFILE_RE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/i;
const ACCEPTANCE_DIR_RE = /(^|\/)acceptance\//i;
const PROFILE_FILE_RE = /\.profile\.json$/i;
const BUILD_CONFIG_RE =
  /(^|\/)(tsconfig[^/]*\.json|vite\.config\.[cm]?[jt]s|webpack[^/]*\.[cm]?[jt]s|rollup[^/]*\.[cm]?[jt]s|esbuild[^/]*\.[cm]?[jt]s|\.eslintrc[^/]*|CMakeLists\.txt|Makefile|meson\.build|build\.ninja|[^/]*\.cmake)$/i;

export interface GitProbe {
  hasGit: true;
  commit?: string;
  branch?: string;
  porcelain: string;
  diffHead: string;
  modifiedPaths: string[];
  untrackedPaths: string[];
}

/** 最小环境（仅 PATH/SYSTEMROOT 等），探测子进程不透传宿主环境 */
const MINIMAL_SPAWN_ENV: Record<string, string> = {};
for (const name of ['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']) {
  const value = process.env[name] ?? process.env[name.toLowerCase()] ?? process.env[name.toUpperCase()];
  if (value !== undefined) MINIMAL_SPAWN_ENV[name] = value;
}

interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGit(
  cwd: string,
  args: string[],
  timeoutMs = 10_000,
): Promise<GitRunResult | null> {
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd,
        env: MINIMAL_SPAWN_ENV,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve(null);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: GitRunResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ code: 124, stdout, stderr });
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
      if (stdout.length > 1_000_000) child.kill();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
      if (stderr.length > 1_000_000) child.kill();
    });
    child.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(code === 'ENOENT' ? null : { code: -1, stdout, stderr: String(error) });
    });
    child.on('close', (code) => {
      finish({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** git 探测：二进制缺失（ENOENT）或不在工作树内 → null（调用方置 hasGit=false） */
export async function probeGit(projectRoot: string): Promise<GitProbe | null> {
  const inside = await runGit(projectRoot, ['rev-parse', '--is-inside-work-tree']);
  if (!inside || inside.code !== 0 || inside.stdout.trim() !== 'true') return null;
  const [headR, branchR, statusR, diffR] = await Promise.all([
    runGit(projectRoot, ['rev-parse', 'HEAD']),
    runGit(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
    runGit(projectRoot, ['status', '--porcelain']),
    runGit(projectRoot, ['diff', 'HEAD']),
  ]);
  const head = headR;
  const branch = branchR;
  const status = statusR;
  const diff = diffR;
  const porcelain = status && status.code === 0 ? status.stdout : '';
  const modifiedPaths: string[] = [];
  const untrackedPaths: string[] = [];
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    const raw = line.slice(3);
    const target = (raw.split(' -> ').pop() ?? raw).replace(/^"|"$/g, '');
    if (xy === '??') untrackedPaths.push(target);
    else modifiedPaths.push(target);
  }
  return {
    hasGit: true,
    commit: head && head.code === 0 ? head.stdout.trim() || undefined : undefined,
    branch: branch && branch.code === 0 ? branch.stdout.trim() || undefined : undefined,
    porcelain,
    diffHead: diff && diff.code === 0 ? diff.stdout : '',
    modifiedPaths,
    untrackedPaths,
  };
}

function heuristicKind(relPosix: string): SourceInputKind | null {
  const base = relPosix.split('/').pop() ?? relPosix;
  if (LOCKFILE_RE.test(base)) return 'lockfile';
  if (ACCEPTANCE_DIR_RE.test(relPosix)) return 'acceptance_config';
  if (PROFILE_FILE_RE.test(base)) return 'profile_config';
  if (BUILD_CONFIG_RE.test(relPosix)) return 'build_config';
  return null;
}

/** inputDigest：清单按路径字节序排序后逐行(kind\tpath\tsha256\tsize)聚合；可选附加 profile 摘要行 */
export function digestManifest(manifest: SourceInputDigest[], profileFileSha256?: string): string {
  const lines = [...manifest]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((m) => `${m.kind}\t${m.path}\t${m.sha256}\t${m.sizeBytes}`);
  if (profileFileSha256) lines.push(`profile\t${profileFileSha256}`);
  return sha256Of(lines.join('\n'));
}

export interface CaptureSnapshotArgs {
  taskId: string;
  projectRoot: string;
  profile: EngineeringProfile;
  toolVersions?: Record<string, string>;
  /** profile 文件内容摘要：参与聚合指纹（revision 变化 ⇒ 指纹变化 ⇒ 旧证据过期） */
  profileFileSha256?: string;
}

/** 采集 A 级源码快照（不落库；持久化由操作层负责）。超限抛 SnapshotLimitError。 */
export async function captureSourceSnapshot(args: CaptureSnapshotArgs): Promise<SourceSnapshot> {
  const projectRoot = args.projectRoot;
  const git = await probeGit(projectRoot);
  const excludes = [...DEFAULT_INPUT_EXCLUDES, ...args.profile.inputExcludes];
  const includes = args.profile.inputIncludes;
  const statusMap = new Map<string, 'modified' | 'untracked'>();
  if (git) {
    for (const p of git.modifiedPaths) statusMap.set(toPosix(p), 'modified');
    for (const p of git.untrackedPaths) statusMap.set(toPosix(p), 'untracked');
  }

  let rels: string[];
  try {
    rels = await walkFiles(projectRoot, {
      skipDirNames: [...SNAPSHOT_SKIP_DIRS],
      maxFiles: SNAPSHOT_WALK_HARD_CAP,
    });
  } catch (error) {
    if (error instanceof WalkLimitError) {
      throw new SnapshotLimitError(`无法生成 A 级输入指纹：${error.message}`);
    }
    throw error;
  }

  const manifest: SourceInputDigest[] = [];
  const seen = new Set<string>();
  const consider = async (rel: string, directInclude: boolean): Promise<void> => {
    const posixRel = toPosix(rel);
    if (seen.has(posixRel)) return;
    const absPath = path.join(projectRoot, posixRel);
    let stat;
    try {
      stat = await fsp.stat(absPath);
    } catch {
      return;
    }
    if (!stat.isFile()) return;
    if (stat.size > SNAPSHOT_MAX_FILE_BYTES) {
      throw new SnapshotLimitError(
        `输入文件 ${posixRel} 大小 ${stat.size} 超过单文件上限 ${SNAPSHOT_MAX_FILE_BYTES}，拒绝生成不完整指纹`,
      );
    }
    if (manifest.length >= SNAPSHOT_MAX_MANIFEST_FILES) {
      throw new SnapshotLimitError(`输入清单超过 ${SNAPSHOT_MAX_MANIFEST_FILES} 文件上限，拒绝生成不完整指纹`);
    }
    const { sha256, sizeBytes } = await sha256File(absPath);
    const kind =
      heuristicKind(posixRel) ??
      (statusMap.get(posixRel) === 'modified'
        ? 'tracked_modified'
        : statusMap.get(posixRel) === 'untracked'
          ? 'untracked'
          : directInclude
            ? 'build_config'
            : 'untracked');
    manifest.push({ kind, path: posixRel, sha256, sizeBytes });
    seen.add(posixRel);
  };

  for (const rel of rels) {
    if (matchAny(rel, includes)) {
      await consider(rel, true);
      continue;
    }
    if (matchAny(rel, excludes)) continue;
    if (git) {
      // 有 git：干净且已跟踪的非配置文件由 gitCommit 锁定，不重复入清单；
      // 配置类显式输入与未提交修改/未跟踪输入必入清单
      if (heuristicKind(rel)) {
        await consider(rel, false);
      } else if (statusMap.has(rel)) {
        await consider(rel, false);
      }
    } else {
      // 无 git：完整输入清单内容摘要回退
      await consider(rel, false);
    }
  }
  // inputIncludes 必含：直接路径即使在排除目录中也强制纳入（必含优先于排除）
  for (const inc of includes) {
    if (/[*?]/.test(inc)) continue;
    await consider(inc, true);
  }

  if (manifest.length > SNAPSHOT_MAX_MANIFEST_FILES) {
    throw new SnapshotLimitError(`输入清单超过 ${SNAPSHOT_MAX_MANIFEST_FILES} 文件上限，拒绝生成不完整指纹`);
  }

  manifest.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const inputDigest = digestManifest(manifest, args.profileFileSha256);

  let dirtyDiffDigest: string | undefined;
  let untrackedDigest: string | undefined;
  if (git) {
    dirtyDiffDigest = sha256Of(`${git.porcelain}\n---diff-head---\n${git.diffHead}`);
    const untrackedLines = manifest
      .filter((m) => m.kind === 'untracked')
      .map((m) => `${m.path}\t${m.sha256}`);
    untrackedDigest = sha256Of(untrackedLines.sort().join('\n'));
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId('snap'),
    taskId: args.taskId,
    evidenceLevel: 'A',
    gitCommit: git?.commit,
    gitBranch: git?.branch,
    hasGit: git !== null,
    dirtyDiffDigest,
    untrackedDigest,
    inputDigest,
    inputManifest: manifest,
    toolVersions: args.toolVersions ?? {},
    capturedAt: new Date().toISOString(),
  };
}

/** matchPath 再导出，供操作层 glob 产物复用 */
export { matchPath };
