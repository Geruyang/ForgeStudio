// SSH 远程执行（Z3-FZ3B）fixture 级测试：FakeSshSession 模拟板卡（标注模拟，非实机）。
// 验证：输入清单上传 → 板上构建/验收 → 产物取回进入本地证据管线 → 内容寻址目录复用。
import { describe, expect, it, afterAll } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import type { SshTarget, ProfileCommand } from '../../contracts/src/profile.ts';
import { Storage } from '../src/storage/database.ts';
import { ProfileLoader } from '../src/profiles/loader.ts';
import { OpsEngine } from '../src/ops/engine.ts';
import type { SshSession, SshExecArgs } from '../src/ops/ssh-transport.ts';
import { remoteTaskDir } from '../src/ops/ssh-transport.ts';
import { makeTmpDir, rmForce } from './helpers/fixtures.ts';

const cleanups: string[] = [];
afterAll(async () => {
  for (const d of cleanups) await rmForce(d);
});

const TARGET: SshTarget = {
  host: '192.0.2.10',
  port: 22,
  username: 'board',
  passwordEnv: 'FD_TEST_SSH_PASSWORD',
  remoteRoot: '/tmp/forgedesk-test',
};

/** 模拟板卡：记录上传与执行；gcc → 产物；./hello → TESTS_PASSED（全部内存模拟） */
class FakeSshSession implements SshSession {
  readonly kind = 'fixture' as const;
  readonly uploads: Array<{ dir: string; files: string[] }> = [];
  readonly execs: Array<{ cwd: string; cmdline: string }> = [];
  readonly remoteFiles = new Map<string, Buffer>();

  async exec(args: SshExecArgs) {
    this.execs.push({ cwd: args.cwd, cmdline: args.cmdline });
    if (args.cmdline.includes('gcc')) {
      this.remoteFiles.set(`${args.cwd}/hello`, Buffer.from('FZ3B-FAKE-ARTIFACT-v1\n', 'utf8'));
      return { exitCode: 0, stdout: 'BOARD_GCC_OK\n', stderr: '', truncated: false, timedOut: false, cancelled: false, durationMs: 5 };
    }
    if (args.cmdline.includes('./hello')) {
      return { exitCode: 0, stdout: 'TESTS_PASSED\nBOARD:fake\n', stderr: '', truncated: false, timedOut: false, cancelled: false, durationMs: 3 };
    }
    return { exitCode: 127, stdout: '', stderr: 'command not found', truncated: false, timedOut: false, cancelled: false, durationMs: 1 };
  }

  async uploadInputs(remoteDir: string, files: Array<{ rel: string; content: Buffer }>) {
    for (const f of files) this.remoteFiles.set(`${remoteDir}/${f.rel}`, f.content);
    this.uploads.push({ dir: remoteDir, files: files.map((f) => f.rel) });
  }

  async downloadGlob(remoteDir: string, globs: string[], localDir: string) {
    const names: string[] = [];
    for (const [k, v] of this.remoteFiles) {
      if (!k.startsWith(`${remoteDir}/`)) continue;
      const name = k.slice(remoteDir.length + 1);
      if (!name.includes('/') && globs.some((g) => new RegExp(`^${g.replace(/\*/g, '.*')}$`).test(name))) {
        await fsp.mkdir(localDir, { recursive: true });
        await fsp.writeFile(path.join(localDir, name), v);
        names.push(name);
      }
    }
    return names;
  }

  async close() {}
}

function sshCommand(exe: string, args: string[]): ProfileCommand {
  return { exe, args, timeoutMs: 60_000, ssh: TARGET };
}

async function makeSshEngine(fake: FakeSshSession) {
  const dataDir = await makeTmpDir('data');
  const projDir = await makeTmpDir('proj');
  const profileDir = await makeTmpDir('profiles');
  cleanups.push(dataDir, projDir, profileDir);
  await fsp.writeFile(path.join(projDir, 'package.json'), '{"name":"fz3b-fixture","private":true}\n', 'utf8');
  await fsp.writeFile(path.join(projDir, 'main.c'), '#include <stdio.h>\nint main(void){printf("TESTS_PASSED\\n");}\n', 'utf8');
  const profile = {
    schemaVersion: 1,
    id: 'fz3b-ssh-fixture',
    revision: 1,
    title: 'FZ3B 板上工程（fixture 模拟）',
    kind: 'software',
    build: sshCommand('gcc', ['main.c', '-o', 'hello']),
    artifactsGlob: ['hello'],
    verifiers: [
      {
        verifierId: 'fz3b-smoke',
        title: '板上冒烟',
        command: sshCommand('./hello', []),
        passExitCode: 0,
        stdoutMustContain: ['TESTS_PASSED'],
        stdoutMustNotContain: [],
        outputLimitBytes: 1_048_576,
      },
    ],
    inputIncludes: ['package.json', 'main.c'],
    inputExcludes: [],
  };
  await fsp.writeFile(path.join(profileDir, 'fz3b-ssh-fixture.profile.json'), JSON.stringify(profile, null, 2), 'utf8');
  const storage = new Storage(dataDir);
  const profiles = new ProfileLoader([profileDir]);
  await profiles.reload();
  const engine = new OpsEngine({ dataDir, storage, profiles, sshTransport: async () => fake });
  const task = await engine.createTask({
    projectRoot: projDir,
    profileId: 'fz3b-ssh-fixture',
    title: 'FZ3B fixture 任务',
    acceptance: [
      { kind: 'executable', verifierId: 'fz3b-smoke', title: '板上冒烟', expected: 'TESTS_PASSED', manualRequired: false, required: true },
    ],
  });
  const items = storage.listAcceptanceItems(task.id);
  return { engine, storage, taskId: task.id, itemId: items[0]!.id };
}

describe('SSH 远程执行（fixture 模拟板卡，非实机）', () => {
  it('板上构建 + 板上验收全链：上传清单、产物取回落证据、验收项点亮', async () => {
    const fake = new FakeSshSession();
    const f = await makeSshEngine(fake);

    const build = await f.engine.callOperation('build', { taskId: f.taskId, profileRevision: 1 }, { wait: true });
    const buildOut = build.result as { ok: boolean; artifactSha256?: string; artifactPath?: string };
    expect(buildOut.ok).toBe(true);
    // 产物为板上取回的模拟内容（sha256 一致）
    const expectSha = createHash('sha256').update('FZ3B-FAKE-ARTIFACT-v1\n', 'utf8').digest('hex');
    expect(buildOut.artifactSha256).toBe(expectSha);

    const test = await f.engine.callOperation('test', { taskId: f.taskId, verifierId: 'fz3b-smoke' }, { wait: true });
    const testOut = test.result as { ok: boolean; result: string; evidenceId: string };
    expect(testOut.ok).toBe(true);
    expect(testOut.result).toBe('passed');
    expect(f.storage.getAcceptanceItem(f.itemId)?.status).toBe('passed');
    const evidence = f.storage.getEvidence(testOut.evidenceId);
    expect(evidence?.result).toBe('passed');

    // 上传了完整输入清单（package.json + main.c）
    const lastUpload = fake.uploads.at(-1)!;
    expect(lastUpload.files).toContain('package.json');
    expect(lastUpload.files).toContain('main.c');
    // 构建与验收使用同一内容寻址目录（输入未变免重传歧义）
    const dirs = new Set(fake.execs.map((e) => e.cwd));
    expect(dirs.size).toBe(1);
    expect(fake.uploads.length).toBe(2); // 每操作前各上传一次（幂等覆盖，同一目录）
    f.storage.close();
    await f.engine.shutdown(2_000);
  });

  it('验收失败路径：板上命令退出非 0 → failed（不点亮）', async () => {
    const fake = new FakeSshSession();
    fake.exec = async (args: SshExecArgs) => {
      void args;
      return { exitCode: 1, stdout: 'BOARD_ERROR\n', stderr: 'boom', truncated: false, timedOut: false, cancelled: false, durationMs: 2 };
    };
    const f = await makeSshEngine(fake);
    const test = await f.engine.callOperation('test', { taskId: f.taskId, verifierId: 'fz3b-smoke' }, { wait: true });
    const testOut = test.result as { ok: boolean; result: string };
    expect(testOut.result).toBe('failed');
    expect(f.storage.getAcceptanceItem(f.itemId)?.status).not.toBe('passed');
    f.storage.close();
    await f.engine.shutdown(2_000);
  });

  it('远程目录命名：remoteRoot/<taskId>-<digest 前 8 位>（内容寻址）', () => {
    const dir = remoteTaskDir(TARGET, 'task-abc', '0123456789abcdef');
    expect(dir).toBe('/tmp/forgedesk-test/task-abc-01234567');
  });
});
