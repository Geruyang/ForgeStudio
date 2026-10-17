﻿﻿﻿// requestKey 幂等测试（M7）：同键同参→原操作（副作用只发生一次）；同键不同参→冲突拒绝；无键→独立操作。
import { describe, expect, it, afterAll } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { BuildOutput, TestOutput } from '@forgedesk/contracts/mcp';
import { makeEngine, expectOk, type EngineFixture } from './helpers/engine.ts';
import { rmForce } from './helpers/fixtures.ts';

const cleanups: string[] = [];
const storages: EngineFixture[] = [];
async function setup(): Promise<EngineFixture> {
  const f = await makeEngine('ok', { sideEffectBuild: true });
  cleanups.push(f.dataDir, f.fx.root, f.fx.profileDir);
  storages.push(f);
  return f;
}
afterAll(async () => {
  for (const f of storages) {
    await f.engine.shutdown(2_000).catch(() => undefined);
    f.storage.close();
  }
  for (const d of cleanups) await rmForce(d);
});

async function sideEffectCount(f: EngineFixture): Promise<number> {
  const file = path.join(f.fx.root, 'side-effect.txt');
  try {
    const content = await fsp.readFile(file, 'utf8');
    return content.trim().split('\n').filter((l) => l.length > 0).length;
  } catch {
    return 0;
  }
}

describe('requestKey 幂等', () => {
  it('同 requestKey 同参数重复 build → 返回原操作，副作用只发生一次（计数器验证）', async () => {
    const f = await setup();
    const args = { taskId: f.taskId, profileRevision: 1, requestKey: 'rk-build-idem-0001' };
    const first = await f.engine.callOperation('build', args, { wait: true });
    const second = await f.engine.callOperation('build', args, { wait: true });
    expect(second.operationId).toBe(first.operationId); // 同一操作
    const out1 = first.result as BuildOutput;
    const out2 = second.result as BuildOutput;
    expect(out2.ok).toBe(true);
    expect(out2.buildId).toBe(out1.buildId); // 结果为原操作结果（不重跑）
    expect(out2.artifactId).toBe(out1.artifactId);
    expect(await sideEffectCount(f)).toBe(1); // 副作用只发生一次
    expect(f.storage.listOperations(f.taskId)).toHaveLength(1);
  });

  it('无 requestKey → 两次调用是两个独立操作（允许修复后重跑）', async () => {
    const f = await setup();
    await f.engine.callOperation('build', { taskId: f.taskId, profileRevision: 1 }, { wait: true });
    await f.engine.callOperation('build', { taskId: f.taskId, profileRevision: 1 }, { wait: true });
    expect(f.storage.listOperations(f.taskId)).toHaveLength(2);
    expect(await sideEffectCount(f)).toBe(2);
  });

  it('同 requestKey 不同参数 → 冲突拒绝（permission_denied），原操作不受影响', async () => {
    const f = await setup();
    const key = 'rk-test-conflict-0001';
    const first = await f.engine.callOperation('test', { taskId: f.taskId, verifierId: `${f.fx.profileId}-smoke`, requestKey: key }, { wait: true });
    expect((first.result as TestOutput).ok).toBe(true);
    const hijack = await f.engine.callOperation('build', { taskId: f.taskId, profileRevision: 1, requestKey: key }, { wait: true });
    const failure = hijack.result as { ok: boolean; kind: string; message: string };
    expect(failure.ok).toBe(false);
    expect(failure.kind).toBe('permission_denied');
    expect(failure.message).toContain('requestKey 冲突');
    // 原操作仍是唯一记录且成功
    const ops = f.storage.listOperations(f.taskId);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.status).toBe('succeeded');
  });

  it('test 幂等：同键重复验收 → 同一 evidence，不重复执行 verifier', async () => {
    const f = await setup();
    const args = { taskId: f.taskId, verifierId: `${f.fx.profileId}-smoke`, requestKey: 'rk-test-idem-00001' };
    const a = await f.engine.callOperation('test', args, { wait: true });
    const b = await f.engine.callOperation('test', args, { wait: true });
    expect(b.operationId).toBe(a.operationId);
    expect((b.result as TestOutput).evidenceId).toBe((a.result as TestOutput).evidenceId);
    expect(f.storage.listEvidence(f.taskId)).toHaveLength(1);
    expect(f.storage.listOperations(f.taskId)).toHaveLength(1);
  });

  it('参数键序不同 / requestKey 不参与 argsDigest → 规范化摘要一致', async () => {
    const f = await setup();
    const key = 'rk-canonical-0000001';
    const a = await f.engine.callOperation('test', { taskId: f.taskId, verifierId: `${f.fx.profileId}-smoke`, requestKey: key }, { wait: true });
    const b = await f.engine.callOperation('test', { verifierId: `${f.fx.profileId}-smoke`, taskId: f.taskId, requestKey: key }, { wait: true });
    expect(b.operationId).toBe(a.operationId); // 键序不同仍命中同一操作
    const out = expectOk(b.result) as BuildOutput | TestOutput;
    expect(out).toBeTruthy();
  });
});
