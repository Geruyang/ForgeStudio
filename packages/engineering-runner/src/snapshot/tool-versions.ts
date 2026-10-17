/**
 * 工具版本清单：node 版本、构建命令 exe 版本探测（--version 尝试）。
 * 版本探测失败不阻塞采集（available=false 标明），但绝不虚报版本号。
 */
import { spawn } from 'node:child_process';
import type { EngineeringProfile } from '../../../contracts/src/profile.ts';

const PROBE_ENV: Record<string, string> = {};
for (const name of ['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']) {
  const value = process.env[name];
  if (value !== undefined) PROBE_ENV[name] = value;
}

interface ProbeResult {
  available: boolean;
  version?: string;
  notFound?: boolean;
}

/** 运行 `exe --version`，超时 5s；ENOENT → 未安装 */
function probeVersion(exe: string, args: string[] = ['--version'], timeoutMs = 5_000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args, {
        env: PROBE_ENV,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve({ available: false, notFound: true });
      return;
    }
    let out = '';
    let settled = false;
    const finish = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ available: true }); // 可执行但 --version 无响应：不算缺失，版本未知
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    child.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(code === 'ENOENT' ? { available: false, notFound: true } : { available: false });
    });
    child.on('close', (code) => {
      // 版本取首个非空行（跨工具通用：git version x / vX.y.z / rust probe-rs x.y.z）
      const firstLine = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
      void code;
      finish({ available: true, version: firstLine || undefined });
    });
  });
}

export interface ToolVersionProbe {
  tool: string;
  available: boolean;
  version?: string;
  missingHint?: string;
}

/** 探测工程工具链：node / git / probe-rs / 构建命令 exe */
export async function probeToolVersions(profile?: EngineeringProfile): Promise<ToolVersionProbe[]> {
  const probes: Array<{ tool: string; exe?: string; args?: string[]; hint: string }> = [
    { tool: 'node', hint: 'Node.js 未安装或不在 PATH' },
    { tool: 'git', exe: 'git', hint: 'git 未安装（将回退内容清单指纹，hasGit=false）' },
    { tool: 'probe-rs', exe: 'probe-rs', hint: 'probe-rs 未安装（设备烧录不可用）' },
  ];
  if (profile) {
    probes.push({
      tool: `build:${profile.build.exe}`,
      exe: profile.build.exe,
      args: ['--version'],
      hint: `构建命令 ${profile.build.exe} 不可用`,
    });
  }
  const results: ToolVersionProbe[] = [];
  for (const p of probes) {
    if (p.tool === 'node') {
      // node 自身无需再起进程探测
      results.push({ tool: 'node', available: true, version: process.version });
      continue;
    }
    if (!p.exe) continue;
    const r = await probeVersion(p.exe, p.args ?? ['--version']);
    results.push({
      tool: p.tool,
      available: r.available,
      version: r.version,
      missingHint: r.available ? undefined : p.hint,
    });
  }
  return results;
}

/** git 是否可用（独立探测入口，供诊断使用） */
export async function isGitAvailable(): Promise<boolean> {
  const r = await probeVersion('git', ['--version']);
  return r.available;
}
