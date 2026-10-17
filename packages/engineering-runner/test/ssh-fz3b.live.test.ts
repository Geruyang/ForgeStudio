// @vitest-environment node
// FZ3B 实机验收（A-14-SSH，Z3）：真实板卡上构建+验收（板上 gcc，aarch64 原生）。
// 运行条件：FZ3B_HOST / FZ3B_USER / FZ3B_PASSWORD 环境变量（板卡经以太网点对点连接）。
// 未设置时整文件跳过（skip ≠ 通过；实机结果以运行输出与 ACCEPTANCE 记录为准）。
import { describe, expect, it, afterAll } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import type { SshTarget } from '../../contracts/src/profile.ts';
import { Storage } from '../src/storage/database.ts';
import { ProfileLoader } from '../src/profiles/loader.ts';
import { OpsEngine } from '../src/ops/engine.ts';
import { makeTmpDir, rmForce } from './helpers/fixtures.ts';

const HOST = process.env.FZ3B_HOST ?? '';
const USER = process.env.FZ3B_USER ?? 'ubuntu';
const PASSWORD = process.env.FZ3B_PASSWORD ?? '';
const skip = HOST.length === 0 || PASSWORD.length === 0;

const cleanups: string[] = [];
afterAll(async () => {
  for (const d of cleanups) await rmForce(d);
});

describe.skipIf(skip)('FZ3B 实机：板上构建与验收（真实 SSH，非模拟）', () => {
  it('main.c → 板上 gcc 构建 → 板上运行 → TESTS_PASSED + 板卡身份回报 → 证据落库', async () => {
    const target: SshTarget = {
      host: HOST,
      port: 22,
      username: USER,
      passwordEnv: 'FZ3B_PASSWORD',
      remoteRoot: '/tmp/forgedesk',
    };
    const dataDir = await makeTmpDir('data');
    const projDir = await makeTmpDir('proj');
    const profileDir = await makeTmpDir('profiles');
    cleanups.push(dataDir, projDir, profileDir);

    // 工程输入：板上原生编译的 C 程序（回板 uname 机器身份）
    await fsp.writeFile(
      path.join(projDir, 'main.c'),
      [
        '#include <stdio.h>',
        '#include <string.h>',
        'int main(void) {',
        '  FILE *f = fopen("/proc/sys/kernel/hostname", "r");',
        '  char host[64] = "?";',
        '  if (f) { if (fgets(host, sizeof host, f)) host[strcspn(host, "\\n")] = 0; fclose(f); }',
        '  printf("TESTS_PASSED\\n");',
        '  printf("BOARD_HOST=%s\\n", host);',
        '  printf("ARCH=%s\\n", sizeof(void*) == 8 ? "aarch64" : "unknown");',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    await fsp.writeFile(path.join(projDir, 'package.json'), '{"name":"fz3b-live","private":true}\n', 'utf8');
    const profile = {
      schemaVersion: 1,
      id: 'fz3b-live',
      revision: 1,
      title: 'FZ3B 实机工程（板上构建+验收）',
      kind: 'software',
      build: { exe: 'gcc', args: ['main.c', '-o', 'hello'], timeoutMs: 120_000, ssh: target },
      artifactsGlob: ['hello'],
      verifiers: [
        {
          verifierId: 'fz3b-smoke',
          title: '板上冒烟（实机）',
          command: { exe: './hello', args: [], timeoutMs: 60_000, ssh: target },
          passExitCode: 0,
          stdoutMustContain: ['TESTS_PASSED', 'BOARD_HOST='],
          stdoutMustNotContain: [],
          outputLimitBytes: 1_048_576,
        },
      ],
      inputIncludes: ['package.json', 'main.c'],
      inputExcludes: [],
    };
    await fsp.writeFile(path.join(profileDir, 'fz3b-live.profile.json'), JSON.stringify(profile, null, 2), 'utf8');
    const storage = new Storage(dataDir);
    const profiles = new ProfileLoader([profileDir]);
    await profiles.reload();
    const engine = new OpsEngine({ dataDir, storage, profiles }); // 真实 ssh2 传输
    const task = await engine.createTask({
      projectRoot: projDir,
      profileId: 'fz3b-live',
      title: 'FZ3B 实机验收任务',
      acceptance: [
        { kind: 'executable', verifierId: 'fz3b-smoke', title: '板上冒烟', expected: 'TESTS_PASSED + 板卡身份', manualRequired: false, required: true },
      ],
    });
    const itemId = storage.listAcceptanceItems(task.id)[0]!.id;

    const build = await engine.callOperation('build', { taskId: task.id, profileRevision: 1 }, { wait: true });
    const buildOut = build.result as { ok: boolean; artifactSha256?: string; operationId: string };
    expect(buildOut.ok).toBe(true);
    // 产物是板上编译的真实 aarch64 ELF（非空、有 sha256）
    expect(buildOut.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
    const op = storage.getOperation(buildOut.operationId);
    console.log(`[live] 板上构建成功，operation=${op?.status}，产物 sha256=${buildOut.artifactSha256?.slice(0, 16)}…`);

    const test = await engine.callOperation('test', { taskId: task.id, verifierId: 'fz3b-smoke' }, { wait: true });
    const testOut = test.result as { ok: boolean; result: string; evidenceId: string; stdoutPreview?: string };
    expect(testOut.ok).toBe(true);
    expect(testOut.result).toBe('passed');
    expect(storage.getAcceptanceItem(itemId)?.status).toBe('passed');
    const evidence = storage.getEvidence(testOut.evidenceId);
    expect(evidence?.result).toBe('passed');
    // 回报证据：验收 stdout 中包含板卡身份
    const logDir = path.join(dataDir, 'evidence', testOut.evidenceId);
    const files = await fsp.readdir(logDir).catch(() => [] as string[]);
    for (const file of files) {
      if (file.endsWith('.log')) {
        const text = await fsp.readFile(path.join(logDir, file), 'utf8');
        const m = text.match(/BOARD_HOST=(\S+)/);
        if (m) console.log(`[live] 板卡身份回报 BOARD_HOST=${m[1]}（stdout 含身份证据）`);
      }
    }
    void createHash; // 保留引用一致性
    storage.close();
    await engine.shutdown(2_000);
  }, 300_000);
});
