﻿﻿﻿// 导出交付包测试：产物与 manifest 完整、证据日志副本、不含凭证模式（含 runner 令牌）。
import { describe, expect, it, afterAll } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { BuildOutput, ExportOutput, TestOutput } from '@forgedesk/contracts/mcp';
import { makeEngine, expectOk, type EngineFixture } from './helpers/engine.ts';
import { rmForce } from './helpers/fixtures.ts';

const cleanups: string[] = [];
const fixtures: EngineFixture[] = [];
async function setup(): Promise<EngineFixture> {
  const f = await makeEngine('ok');
  cleanups.push(f.dataDir, f.fx.root, f.fx.profileDir);
  fixtures.push(f);
  return f;
}
afterAll(async () => {
  for (const f of fixtures) {
    await f.engine.shutdown(2_000).catch(() => undefined);
    f.storage.close();
  }
  for (const d of cleanups) await rmForce(d);
});

/** 凭证样式扫描（与 M1 场景同源正则；交付包必须零命中） */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /OPENAI_API_KEY\s*[=:]/i,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\b(?:api[_-]?key|apikey|secret|password|access[_-]?token|auth[_-]?token|token)\b\s*[:=]\s*["'][^"']{8,}["']/i,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];

async function listFiles(root: string, base = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(path.join(root, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

describe('engineering.export', () => {
  it('交付包完整：manifest（schemaVersion/任务/验收/快照/操作/证据/产物+哈希）+ 产物副本 + 证据日志副本', async () => {
    const f = await setup();
    const build = expectOk((await f.engine.callOperation('build', { taskId: f.taskId, profileRevision: 1 }, { wait: true })).result) as BuildOutput;
    expect(build.ok).toBe(true);
    const test = expectOk((await f.engine.callOperation('test', { taskId: f.taskId, verifierId: `${f.fx.profileId}-smoke` }, { wait: true })).result) as TestOutput;
    expect(test.result).toBe('passed');

    const exported = expectOk((await f.engine.callOperation('export', { taskId: f.taskId }, { wait: true })).result) as ExportOutput;
    expect(exported.ok).toBe(true);
    const manifest = exported.manifest as {
      schemaVersion: number;
      task: { id: string };
      acceptance: unknown[];
      snapshot?: { inputDigest: string; inputManifest: unknown[] };
      operations: unknown[];
      evidence: Array<{ id: string; logRef?: string }>;
      artifacts: Array<{ sha256: string; bundleFile?: string }>;
      files: Array<{ path: string; sha256: string; sizeBytes: number }>;
    };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.task.id).toBe(f.taskId);
    expect(manifest.acceptance).toHaveLength(1);
    expect(manifest.snapshot?.inputManifest?.length).toBeGreaterThan(0);
    expect(manifest.operations.length).toBe(3); // build + test + export
    expect(manifest.evidence).toHaveLength(1);
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]?.sha256).toBe(build.artifactSha256);
    // 文件真实存在：manifest / 产物副本 / 证据日志副本
    const files = await listFiles(exported.bundlePath);
    expect(files).toContain('manifest.json');
    expect(files.some((p) => p.startsWith('artifacts/'))).toBe(true);
    expect(files.some((p) => p.startsWith(`evidence/${f.taskId}/`) && p.endsWith('test.log'))).toBe(true);
    // files 清单哈希与实际文件一致（抽产物副本）
    for (const entry of manifest.files) {
      await fsp.access(path.join(exported.bundlePath, entry.path));
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('不含凭证：交付包全部文件扫描零命中（OPENAI_API_KEY / sk- / Bearer / ghp_ / AKIA / JWT）', async () => {
    const f = await setup();
    expectOk((await f.engine.callOperation('build', { taskId: f.taskId, profileRevision: 1 }, { wait: true })).result);
    const exported = expectOk((await f.engine.callOperation('export', { taskId: f.taskId }, { wait: true })).result) as ExportOutput;
    const files = await listFiles(exported.bundlePath);
    expect(files.length).toBeGreaterThan(0);
    for (const rel of files) {
      const content = await fsp.readFile(path.join(exported.bundlePath, rel), 'utf8').catch(() => Buffer.alloc(0));
      const text = content.toString('utf8');
      for (const re of CREDENTIAL_PATTERNS) {
        expect({ file: rel, hit: re.source, matched: re.test(text) }, `文件 ${rel} 命中凭证模式 ${re.source}`).toEqual({
          file: rel,
          hit: re.source,
          matched: false,
        });
      }
    }
  });
});
