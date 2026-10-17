// 构建与验收执行测试（真实 node 子进程）：
// 成功构建采集产物 / 失败退出码 / stdout 关键字判定 / 前后指纹变化→evidence_stale / proposed 不被点亮。
import { describe, expect, it, afterAll } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { BuildOutput, TestOutput } from '@forgedesk/contracts/mcp';
import { makeEngine, expectOk, type EngineFixture } from './helpers/engine.ts';
import { rmForce } from './helpers/fixtures.ts';

const fixtures: Array<() => Promise<void>> = [];
async function tracked<T>(p: Promise<T>): Promise<T> {
  const fixture = await p;
  return fixture;
}
void tracked;

const cleanups: string[] = [];
async function makeEngineTracked(...args: Parameters<typeof makeEngine>): Promise<EngineFixture> {
  const f = await makeEngine(...args);
  cleanups.push(f.dataDir, f.fx.root, f.fx.profileDir);
  fixtures.push(async () => {
    f.storage.close();
    await f.engine.shutdown(2_000);
  });
  return f;
}
afterAll(async () => {
  for (const close of fixtures) await close();
  for (const d of cleanups) await rmForce(d);
});

describe('engineering.build（真实执行）', () => {
  it('成功构建：产物采集（sha256/归档副本/build.log），操作 succeeded', async () => {
    const f = await makeEngineTracked('ok');
    const output = expectOk((await f.engine.callOperation('build', { taskId: f.taskId, profileRevision: 1 }, { wait: true })).result) as BuildOutput;
    expect(output.ok).toBe(true);
    expect(output.buildId).toMatch(/^[0-9a-f-]{36}$/);
    expect(output.artifactType).toBe('other');
    // 产物归档副本与日志真实落盘
    const archived = path.join(f.dataDir, output.logRef, '..', 'artifacts', path.basename(output.artifactPath));
    await fsp.access(archived);
    await fsp.access(path.join(f.dataDir, output.logRef));
    // 产物登记
    const artifact = f.storage.getArtifact(output.artifactId);
    expect(artifact?.sha256).toBe(output.artifactSha256);
    expect(artifact?.buildId).toBe(output.buildId);
    const op = f.storage.getOperation(output.operationId);
    expect(op?.status).toBe('succeeded');
  });

  it('构建失败（退出码 1）→ kind internal_error（实体 build_failure），不产出产物', async () => {
    const f = await makeEngineTracked('build-fail');
    const result = await f.engine.callOperation('build', { taskId: f.taskId, profileRevision: 1 }, { wait: true });
    expect(result.result && (result.result as { ok?: unknown }).ok).toBe(false);
    const failure = result.result as { kind: string; message: string };
    expect(failure.message).toContain('构建失败');
    const op = f.storage.getOperation(result.operationId);
    expect(op?.status).toBe('failed');
    expect(op?.failure?.kind).toBe('build_failure');
    expect(f.storage.listArtifacts(f.taskId)).toHaveLength(0);
  });

  it('构建期间输入变化（mutate 工程）→ evidence_stale：产物不绑定当前状态', async () => {
    const f = await makeEngineTracked('mutate');
    const result = await f.engine.callOperation('build', { taskId: f.taskId, profileRevision: 1 }, { wait: true });
    const failure = result.result as { ok: boolean; kind: string };
    expect(failure.ok).toBe(false);
    expect(failure.kind).toBe('unknown_result'); // 工具层 kind
    const op = f.storage.getOperation(result.operationId);
    expect(op?.failure?.kind).toBe('evidence_stale'); // 实体层精确 kind
    expect(op?.status).toBe('failed');
    // 前后两次快照都留痕（复核证据）
    expect(f.storage.listSnapshots(f.taskId).length).toBeGreaterThanOrEqual(2);
  });

  it('profileRevision 不一致 → 拒绝构建（旧证据待重验语义）', async () => {
    const f = await makeEngineTracked('ok');
    const result = await f.engine.callOperation('build', { taskId: f.taskId, profileRevision: 99 }, { wait: true });
    const failure = result.result as { ok: boolean; message: string };
    expect(failure.ok).toBe(false);
    expect(failure.message).toContain('profile 修订不一致');
  });
});

describe('engineering.test（固定验收执行）', () => {
  it('验收通过：Evidence passed + AcceptanceItem 点亮 + 任务判定 passed（真实执行）', async () => {
    const f = await makeEngineTracked('ok');
    // 先构建（测试依赖产物可选；此处直接跑 verifier）
    const result = await f.engine.callOperation('test', { taskId: f.taskId, verifierId: `${f.fx.profileId}-smoke` }, { wait: true });
    const output = result.result as TestOutput;
    expect(output.ok).toBe(true);
    expect(output.result).toBe('passed');
    expect(output.acceptanceItemId).toBe(f.acceptanceItemId);
    const evidence = f.storage.getEvidence(output.evidenceId);
    expect(evidence?.result).toBe('passed');
    expect(evidence?.inputDigest).toMatch(/^[0-9a-f]{64}$/);
    const item = f.storage.getAcceptanceItem(f.acceptanceItemId);
    expect(item?.status).toBe('passed');
    expect(item?.lastEvidenceId).toBe(output.evidenceId);
    // 任务通过（必需项全过且证据未过期）
    const task = f.storage.getTask(f.taskId);
    expect(task?.status).toBe('passed');
    const overview = await f.engine.getOverview(f.taskId);
    expect(overview.hasStaleEvidence).toBe(false);
  });

  it('验收失败（退出码 1 + TEST_FAILED）→ Evidence failed，任务 failed', async () => {
    const f = await makeEngineTracked('build-fail');
    const result = await f.engine.callOperation('test', { taskId: f.taskId, verifierId: `${f.fx.profileId}-smoke` }, { wait: true });
    const output = result.result as TestOutput;
    expect(output.result).toBe('failed');
    const item = f.storage.getAcceptanceItem(f.acceptanceItemId);
    expect(item?.status).toBe('failed');
    expect(f.storage.getTask(f.taskId)?.status).toBe('failed');
  });

  it('stdoutMustContain / stdoutMustNotContain 判定规则生效', async () => {
    const f = await makeEngineTracked('keywords');
    const result = await f.engine.callOperation('test', { taskId: f.taskId, verifierId: 'kw-verifier' }, { wait: true });
    expect((result.result as TestOutput).result).toBe('passed'); // passExitCode=2 + HAS_MARKER + 无 FORBIDDEN

    // 负例：改写 verifier 输出包含 FORBIDDEN → 失败（mustNotContain）
    await fsp.writeFile(
      path.join(f.fx.root, 'run-tests.mjs'),
      "console.log('HAS_MARKER');\nconsole.log('FORBIDDEN');\nprocess.exit(2);\n",
      'utf8',
    );
    const r2 = await f.engine.callOperation('test', { taskId: f.taskId, verifierId: 'kw-verifier' }, { wait: true });
    // 注意：修改 run-tests.mjs 改变了输入 → 本轮证据采集在修改之后，判定基于新输入仍应失败
    expect((r2.result as TestOutput).result).toBe('failed');
  });

  it('proposed（模型提议未采纳）验收项不得被工具点亮', async () => {
    const f = await makeEngineTracked('ok');
    const verifierId = `${f.fx.profileId}-smoke`;
    // 用户把验收单替换为：采纳项 + 模型提议项（proposed）
    f.engine.updateAcceptance(f.taskId, [
      { id: f.acceptanceItemId, kind: 'executable', verifierId, title: '冒烟验收（用户采纳）', expected: 'x', required: true },
      { kind: 'executable', verifierId, title: '模型自评项（未采纳）', expected: 'x', required: false, status: 'proposed' },
    ]);
    const items = f.storage.listAcceptanceItems(f.taskId);
    const proposed = items.find((i) => i.status === 'proposed');
    expect(proposed).toBeDefined();
    const result = await f.engine.callOperation('test', { taskId: f.taskId, verifierId }, { wait: true });
    const output = result.result as TestOutput;
    expect(output.result).toBe('passed');
    // 点亮的是采纳项，不是 proposed
    expect(f.storage.getAcceptanceItem(output.acceptanceItemId!)?.status).toBe('passed');
    expect(f.storage.getAcceptanceItem(proposed!.id)?.status).toBe('proposed');
  });

  it('未知 verifier（模型编造验收）→ permission_denied，不产生 Evidence', async () => {
    const f = await makeEngineTracked('ok');
    const result = await f.engine.callOperation('test', { taskId: f.taskId, verifierId: 'made-up-by-model' }, { wait: true });
    const failure = result.result as { ok: boolean; kind: string };
    expect(failure.ok).toBe(false);
    expect(failure.kind).toBe('permission_denied');
    expect(f.storage.listEvidence(f.taskId)).toHaveLength(0);
  });
});
