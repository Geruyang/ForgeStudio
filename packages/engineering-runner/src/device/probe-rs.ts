/**
 * probe-rs CLI 探测与命令构造辅助（薄封装，非烧录权威——profile.flashCommand 才是权威）。
 * - 探测：注入目录优先，其次 PATH；仅认 probe-rs.exe（Windows）——.cmd/.bat 经 spawn 直启会
 *   被 Node 拒绝（EINVAL），不纳入探测
 * - 版本：spawn "<path> --version"，超时 5s
 */
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { runCapture } from './run-capture';

export interface ProbeRsInfo {
  available: boolean;
  path?: string;
  version?: string;
  error?: string;
}

export interface DetectProbeRsOptions {
  /** 显式安装路径（probe-rs.exe 绝对路径；优先于 PATH 搜索） */
  explicitPath?: string;
  extraDirs?: string[];
  /** 注入 PATH 字符串（测试用；缺省用 process.env.PATH） */
  pathEnv?: string;
  timeoutMs?: number;
}

function probeRsCandidateNames(): string[] {
  return process.platform === 'win32' ? ['probe-rs.exe'] : ['probe-rs'];
}

export function findProbeRsInDirs(dirs: string[]): string | undefined {
  const names = probeRsCandidateNames();
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        if (existsSync(full)) return full;
      } catch {
        // 目录不可读：跳过
      }
    }
  }
  return undefined;
}

export function searchDirsForProbeRs(opts: DetectProbeRsOptions): string[] {
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? '';
  return [...(opts.extraDirs ?? []), ...pathEnv.split(path.delimiter)];
}

export async function detectProbeRs(opts: DetectProbeRsOptions = {}): Promise<ProbeRsInfo> {
  // 显式路径优先（用户指定安装位置）；否则 PATH + 注入目录搜索
  const explicit = opts.explicitPath;
  const found =
    explicit && existsSync(explicit)
      ? explicit
      : findProbeRsInDirs(searchDirsForProbeRs(opts));
  if (!found) return { available: false };
  const res = await runCapture(found, ['--version'], { timeoutMs: opts.timeoutMs ?? 5_000 });
  if (res.code === 0 && res.stdout.trim().length > 0) {
    return { available: true, path: found, version: res.stdout.trim().split(/\r?\n/)[0] };
  }
  return {
    available: false,
    path: found,
    error: `probe-rs --version 失败（code=${res.code}${res.killed ? '，超时' : ''}）`,
  };
}

/** 构造 probe-rs download 命令形态（候选；${artifact} 由 flash 执行时替换） */
export function buildProbeRsDownloadCommand(opts: { chipTarget: string; probeRsPath?: string }): {
  exe: string;
  args: string[];
} {
  return {
    exe: opts.probeRsPath ?? 'probe-rs',
    args: ['download', '--chip', opts.chipTarget, '${artifact}'],
  };
}

/** 构造 probe-rs verify（读回）命令形态 */
export function buildProbeRsVerifyCommand(opts: { chipTarget: string; probeRsPath?: string }): {
  exe: string;
  args: string[];
} {
  return {
    exe: opts.probeRsPath ?? 'probe-rs',
    args: ['verify', '--chip', opts.chipTarget, '${artifact}'],
  };
}
