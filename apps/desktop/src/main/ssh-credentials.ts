/**
 * SSH 板卡凭据存储（Z3 GUI 使用链）：与 provider.env 同保护级别——
 * 键值存 <dataDir>/ssh-credentials.env（KEY=VALUE 逐行），界面只回显"已配置"布尔；
 * RunnerHost 启动服务进程时把全部键注入子进程 env，profile 的 passwordEnv 按名取用。
 * 不进 settings.json、不进诊断导出、不写日志。
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

function credentialsPath(dataDir: string): string {
  return path.join(dataDir, 'ssh-credentials.env');
}

/** 解析 KEY=VALUE（容错跳过空行/注释/畸形行；与 provider.env 同规则） */
export async function readSshCredentials(dataDir: string): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  try {
    const text = await fsp.readFile(credentialsPath(dataDir), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
      if (m) map[m[1]!] = m[2]!.trim();
    }
  } catch {
    /* 不存在视为空 */
  }
  return map;
}

async function writeSshCredentials(dataDir: string, map: Record<string, string>): Promise<void> {
  const text = Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  await fsp.writeFile(credentialsPath(dataDir), text.length > 0 ? text + '\n' : '', 'utf8');
}

/** 变量名白名单校验（防路径注入/伪环境键） */
function validEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/** 设置/更新一条凭据（password 不回显、不落日志） */
export async function setSshCredential(dataDir: string, passwordEnv: string, password: string): Promise<void> {
  if (!validEnvName(passwordEnv)) throw new Error(`凭据变量名不合法: ${passwordEnv}`);
  const value = password.trim();
  if (value.length === 0 || /\r|\n/.test(value)) throw new Error('密码不能为空且不含换行');
  const map = await readSshCredentials(dataDir);
  map[passwordEnv] = value;
  await writeSshCredentials(dataDir, map);
}

/** 清除一条凭据；最后一条清空后删除文件（不残留空文件） */
export async function clearSshCredential(dataDir: string, passwordEnv: string): Promise<void> {
  if (!validEnvName(passwordEnv)) throw new Error(`凭据变量名不合法: ${passwordEnv}`);
  const map = await readSshCredentials(dataDir);
  if (!(passwordEnv in map)) return;
  delete map[passwordEnv];
  if (Object.keys(map).length === 0) {
    await fsp.rm(credentialsPath(dataDir), { force: true });
  } else {
    await writeSshCredentials(dataDir, map);
  }
}

/** 已配置变量名集合（仅名字，供界面"已配置"徽标；不含值） */
export async function listSshCredentialNames(dataDir: string): Promise<string[]> {
  return Object.keys(await readSshCredentials(dataDir));
}
