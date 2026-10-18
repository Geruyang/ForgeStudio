// inspect 的 SSH 目标探测（Z3）：可达/不可达端口 + 密码环境变量配置状态（不回显值）。
import { describe, expect, it, afterAll } from 'vitest';
import * as net from 'node:net';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { Storage } from '../src/storage/database.ts';
import { ProfileLoader } from '../src/profiles/loader.ts';
import { OpsEngine } from '../src/ops/engine.ts';
import { collectSshTargets, probeSshTarget } from '../src/ops/ssh-transport.ts';
import { makeTmpDir, rmForce } from './helpers/fixtures.ts';

const cleanups: string[] = [];
afterAll(async () => {
  for (const d of cleanups) await rmForce(d);
});

/** 起一个真实本地 TCP 监听（模拟 SSH 端口），返回端口；close() 关闭 */
async function listenPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer();
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
  const addr = server.address() as net.AddressInfo;
  return {
    port: addr.port,
    close: () => new Promise((res) => server.close(() => res())),
  };
}

async function closedPort(): Promise<number> {
  const s = await listenPort();
  await s.close();
  return s.port; // 刚释放的端口：大概率连接被拒
}

describe('probeSshTarget（真实 TCP）', () => {
  it('可达端口 → reachable=true；密码未配置如实报告', async () => {
    const srv = await listenPort();
    try {
      process.env['FD_PROBE_TEST_PW'] = 'x';
      const r = await probeSshTarget({ host: '127.0.0.1', port: srv.port, username: 'u', passwordEnv: 'FD_PROBE_TEST_PW', remoteRoot: '/tmp/x' });
      expect(r.reachable).toBe(true);
      expect(r.passwordConfigured).toBe(true);
      delete process.env['FD_PROBE_TEST_PW'];
      const r2 = await probeSshTarget({ host: '127.0.0.1', port: srv.port, username: 'u', passwordEnv: 'FD_PROBE_TEST_PW', remoteRoot: '/tmp/x' });
      expect(r2.passwordConfigured).toBe(false);
      expect(r2.detail).toContain('FD_PROBE_TEST_PW');
    } finally {
      await srv.close();
    }
  });

  it('不可达端口 → reachable=false + detail（不虚报）', async () => {
    const port = await closedPort();
    const r = await probeSshTarget({ host: '127.0.0.1', port, username: 'u', passwordEnv: 'FD_PROBE_TEST_PW_X', remoteRoot: '/tmp/x' });
    expect(r.reachable).toBe(false);
    expect(r.detail).toBeTruthy();
  }, 10_000);
});

describe('collectSshTargets（profile 去重）', () => {
  it('build 与 verifier 同目标去重为一条；不同目标各自保留', () => {
    const t = (host: string) => ({ host, port: 22, username: 'u', passwordEnv: 'P', remoteRoot: '/tmp' });
    const profile = {
      schemaVersion: 1 as const,
      id: 'x', revision: 1, title: 'x', kind: 'software' as const,
      build: { exe: 'make', args: [], timeoutMs: 1000, ssh: t('a') },
      artifactsGlob: ['*'],
      verifiers: [
        { verifierId: 'v1', title: 'v', command: { exe: './x', args: [], timeoutMs: 1000, ssh: t('a') }, passExitCode: 0, stdoutMustContain: [], stdoutMustNotContain: [], outputLimitBytes: 1024 },
        { verifierId: 'v2', title: 'v', command: { exe: './x', args: [], timeoutMs: 1000, ssh: t('b') }, passExitCode: 0, stdoutMustContain: [], stdoutMustNotContain: [], outputLimitBytes: 1024 },
      ],
      inputIncludes: [], inputExcludes: [],
    };
    const targets = collectSshTargets(profile as never);
    expect(targets.map((x) => x.host).sort()).toEqual(['a', 'b']);
  });
});

describe('inspect 集成：SSH 目标探测进入工具链报告', () => {
  it('inspect 输出 sshTargets（可达/密码状态），resultSummary 含 SSH 统计', async () => {
    const srv = await listenPort();
    const dataDir = await makeTmpDir('data');
    const projDir = await makeTmpDir('proj');
    const profileDir = await makeTmpDir('profiles');
    cleanups.push(dataDir, projDir, profileDir);
    await fsp.writeFile(path.join(projDir, 'package.json'), '{"name":"p","private":true}');
    process.env['FD_PROBE_TEST_PW'] = 'x';
    const profile = {
      schemaVersion: 1, id: 'inspect-ssh', revision: 1, title: 'x', kind: 'software',
      build: { exe: 'make', args: [], timeoutMs: 5000, ssh: { host: '127.0.0.1', port: srv.port, username: 'u', passwordEnv: 'FD_PROBE_TEST_PW', remoteRoot: '/tmp/x' } },
      artifactsGlob: ['out'], verifiers: [],
      inputIncludes: ['package.json'], inputExcludes: [],
    };
    await fsp.writeFile(path.join(profileDir, 'inspect-ssh.profile.json'), JSON.stringify(profile));
    const storage = new Storage(dataDir);
    const profiles = new ProfileLoader([profileDir]);
    await profiles.reload();
    const engine = new OpsEngine({ dataDir, storage, profiles });
    const task = await engine.createTask({ projectRoot: projDir, profileId: 'inspect-ssh', title: 't', acceptance: [] });
    const r = await engine.callOperation('inspect', { taskId: task.id }, { wait: true });
    const out = r.result as { ok: boolean; sshTargets: Array<{ host: string; reachable: boolean; passwordConfigured: boolean }> };
    expect(out.ok).toBe(true);
    expect(out.sshTargets).toHaveLength(1);
    expect(out.sshTargets[0]).toMatchObject({ host: '127.0.0.1', reachable: true, passwordConfigured: true });
    const op = storage.getOperation(r.operationId);
    expect(op?.resultSummary).toContain('SSH 目标异常 0/1');
    delete process.env['FD_PROBE_TEST_PW'];
    // listProfiles 摘要带目标（不含密码字段值）
    const summaries = await engine.listProfiles();
    expect(summaries.find((s) => s.id === 'inspect-ssh')?.sshTargets).toMatchObject([{ host: '127.0.0.1', username: 'u' }]);
    storage.close();
    await engine.shutdown(1_000);
    await srv.close();
  });
});
