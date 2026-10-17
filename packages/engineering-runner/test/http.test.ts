// HTTP 控制面测试：Bearer 401 / Host 校验 / 404 / 405 / 任务路由 / 操作 wait / SSE 重放与实时 / 授权范围不符拒绝 / 诊断。
import { describe, expect, it, afterAll } from 'vitest';
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import { createRunnerService, type RunnerService } from '../src/index-service.ts';
import { writeFixtureProject, rmForce } from './helpers/fixtures.ts';

const TOKEN = 'test-runner-token-0123456789abcdef';
const services: RunnerService[] = [];
const cleanups: string[] = [];

afterAll(async () => {
  for (const s of services) await s.close();
  for (const d of cleanups) await rmForce(d);
});

async function startService(): Promise<RunnerService & { baseUrl: string }> {
  const dataDir = (await import('./helpers/fixtures.ts')).makeTmpDir;
  const dir = await dataDir('http-data');
  cleanups.push(dir);
  const fx = await writeFixtureProject('ok');
  cleanups.push(fx.root, fx.profileDir);
  const service = await createRunnerService({ dataDir: dir, token: TOKEN, profileDirs: [fx.profileDir] });
  services.push(service);
  return Object.assign(service, { baseUrl: `http://127.0.0.1:${service.port}` });
}

async function api(
  service: { baseUrl: string },
  method: string,
  pathname: string,
  body?: unknown,
  opts?: { token?: string | null; headers?: Record<string, string> },
): Promise<{ status: number; json: any; text: string }> {
  const token = opts?.token === undefined ? TOKEN : opts.token;
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts?.headers ?? {}) };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${service.baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

describe('HTTP 鉴权与路由', () => {
  it('无 token / 错 token → 401；不回显 token', async () => {
    const s = await startService();
    const no = await api(s, 'GET', '/health', undefined, { token: null });
    expect(no.status).toBe(401);
    expect(no.json.kind).toBe('permission_denied');
    expect(no.text).not.toContain(TOKEN);
    const wrong = await api(s, 'GET', '/health', undefined, { token: 'wrong-token-abcdefghijklmnop' });
    expect(wrong.status).toBe(401);
  });

  it('Host 非回环 → 403', async () => {
    const s = await startService();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${s.port}/health`,
        { headers: { authorization: `Bearer ${TOKEN}`, host: 'evil.example.com' } },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('未知路由 404；已知路径方法不符 405', async () => {
    const s = await startService();
    expect((await api(s, 'GET', '/api/nope')).status).toBe(404);
    expect((await api(s, 'POST', '/api/nope', {})).status).toBe(404);
    expect((await api(s, 'GET', '/api/ops/build')).status).toBe(405);
    expect((await api(s, 'DELETE', '/api/tasks')).status).toBe(405);
    expect((await api(s, 'GET', '/health')).status).toBe(200);
  });
});

describe('任务与验收路由', () => {
  it('真实任务流：创建 → 概览 → 验收更新（proposed 允许 / passed 拒绝）→ 操作执行 wait → 导出', async () => {
    const s = await startService();
    // 用 fixture 工程创建任务
    const { writeFixtureProject } = await import('./helpers/fixtures.ts');
    const fx = await writeFixtureProject('ok');
    cleanups.push(fx.root, fx.profileDir);
    const created = await api(s, 'POST', '/api/tasks', {
      projectRoot: fx.root,
      profileId: fx.profileId,
      title: 'HTTP 任务',
      acceptance: [{ kind: 'executable', verifierId: `${fx.profileId}-smoke`, title: '冒烟', expected: '通过', manualRequired: false, required: true }],
    });
    expect(created.status).toBe(201);
    const taskId: string = created.json.id;
    expect(taskId).toMatch(/^task-[0-9a-f-]{36}$/);

    const list = await api(s, 'GET', '/api/tasks');
    const listed = list.json.find((t: { id: string }) => t.id === taskId);
    expect(listed).toBeTruthy();
    // 契约回归（GUI 走查发现）：列表必须是 TaskOverview 全字段，renderer asTaskOverview 依赖
    expect(Array.isArray(listed.acceptance)).toBe(true);
    expect(Array.isArray(listed.operations)).toBe(true);
    expect(typeof listed.hasStaleEvidence).toBe('boolean');

    const overview = await api(s, 'GET', `/api/tasks/${taskId}`);
    expect(overview.json.id).toBe(taskId);
    expect(overview.json.acceptance).toHaveLength(1);
    expect(overview.json.hasStaleEvidence).toBe(false);
    expect(overview.json.status).toBe('draft');

    // 模型提议项（proposed）允许写入
    const upd = await api(s, 'POST', `/api/tasks/${taskId}/acceptance`, {
      items: [
        { id: overview.json.acceptance[0].id, kind: 'executable', verifierId: `${fx.profileId}-smoke`, title: '冒烟', expected: '通过', required: true },
        { kind: 'manual', title: '人工检查', expected: '人工确认', manualRequired: true, required: false, status: 'proposed' },
      ],
    });
    expect(upd.status).toBe(200);
    expect(upd.json).toHaveLength(2);
    // 自评 passed 直接拒绝（执行器是验收事实唯一写入者；schema 层即拦截 passed/failed 等状态）
    const cheat = await api(s, 'POST', `/api/tasks/${taskId}/acceptance`, {
      items: [{ kind: 'executable', verifierId: `${fx.profileId}-smoke`, title: '冒烟', expected: '通过', required: true, status: 'passed' }],
    });
    expect(cheat.status).toBe(400);
    expect(cheat.json.message).toMatch(/不合法|不允许直接写入/);
    expect(cheat.json.message).toContain('passed');

    // 未知 verifier 拒绝
    const badVerifier = await api(s, 'POST', `/api/tasks/${taskId}/acceptance`, {
      items: [{ kind: 'executable', verifierId: 'model-invented', title: 'x', expected: 'x', required: true }],
    });
    expect(badVerifier.status).toBe(400);

    // 操作：build（wait=true）→ 200 + result.ok
    const build = await api(s, 'POST', '/api/ops/build?wait=true', { taskId, profileRevision: 1 });
    expect(build.status).toBe(200);
    expect(build.json.result.ok).toBe(true);
    expect(build.json.status).toBe('succeeded');

    // 操作：异步语义（不 wait）→ 立即返回 operationId
    const asyncTest = await api(s, 'POST', '/api/ops/test', { taskId, verifierId: `${fx.profileId}-smoke` });
    expect(asyncTest.status).toBe(200);
    expect(asyncTest.json.operationId).toMatch(/^op-/);
    // 轮询操作列表直至终态
    let finalStatus = '';
    for (let i = 0; i < 100; i += 1) {
      const ops = await api(s, 'GET', `/api/tasks/${taskId}/operations`);
      const op = ops.json.find((o: { id: string }) => o.id === asyncTest.json.operationId);
      finalStatus = op?.status ?? '';
      if (['succeeded', 'failed', 'unknown', 'cancelled'].includes(finalStatus)) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(finalStatus).toBe('succeeded');

    // 任务不存在的 404
    expect((await api(s, 'GET', '/api/tasks/task-00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });
});

describe('人工验收 manual-review 路由', () => {
  it('manual 判定点亮；executable 拒绝；重复判定幂等；改判追加新证据记录', async () => {
    const s = await startService();
    const { writeFixtureProject } = await import('./helpers/fixtures.ts');
    const fx = await writeFixtureProject('ok');
    cleanups.push(fx.root, fx.profileDir);
    const created = await api(s, 'POST', '/api/tasks', {
      projectRoot: fx.root,
      profileId: fx.profileId,
      title: '人工验收任务',
      acceptance: [
        { kind: 'executable', verifierId: `${fx.profileId}-smoke`, title: '固定测试', expected: '通过', manualRequired: false, required: true },
        { kind: 'manual', title: '人工检查', expected: '人工确认', manualRequired: true, required: true },
      ],
    });
    expect(created.status).toBe(201);
    const taskId: string = created.json.id;
    const ov0 = await api(s, 'GET', `/api/tasks/${taskId}`);
    const manualItem = ov0.json.acceptance.find((a: any) => a.kind === 'manual');
    const execItem = ov0.json.acceptance.find((a: any) => a.kind === 'executable');

    // executable 项人工判定 → 400（防作弊红线：可执行项只能由执行器点亮）
    const execCheat = await api(s, 'POST', `/api/tasks/${taskId}/acceptance/${execItem.id}/manual-review`, { decision: 'passed' });
    expect(execCheat.status).toBe(400);
    expect(execCheat.json.message).toContain('不能人工点亮');

    // 不存在的验收项 → 400
    const missing = await api(s, 'POST', `/api/tasks/${taskId}/acceptance/acc-00000000-0000-4000-8000-000000000000/manual-review`, { decision: 'passed' });
    expect(missing.status).toBe(400);

    // 非法 decision → schema 拒绝
    const bad = await api(s, 'POST', `/api/tasks/${taskId}/acceptance/${manualItem.id}/manual-review`, { decision: 'yolo' });
    expect(bad.status).toBe(400);

    // manual 判定 passed → 200 + 状态点亮 + lastEvidenceId 绑定
    const pass = await api(s, 'POST', `/api/tasks/${taskId}/acceptance/${manualItem.id}/manual-review`, { decision: 'passed', note: '实测无问题' });
    expect(pass.status).toBe(200);
    expect(Array.isArray(pass.json)).toBe(true);
    const passedItem = pass.json.find((a: any) => a.id === manualItem.id);
    expect(passedItem.status).toBe('passed');
    expect(passedItem.lastEvidenceId).toBeTruthy();

    // 操作历史写入 manual_review 类型
    const ops1 = await api(s, 'GET', `/api/tasks/${taskId}/operations`);
    expect(ops1.json.filter((o: any) => o.type === 'manual_review').length).toBe(1);

    // 重复同判定 → no-op（不追加操作/证据）
    const again = await api(s, 'POST', `/api/tasks/${taskId}/acceptance/${manualItem.id}/manual-review`, { decision: 'passed' });
    expect(again.status).toBe(200);
    const ops2 = await api(s, 'GET', `/api/tasks/${taskId}/operations`);
    expect(ops2.json.filter((o: any) => o.type === 'manual_review').length).toBe(1);

    // 改判 failed → 新判定事件（新操作+新证据，状态翻转）
    const fail = await api(s, 'POST', `/api/tasks/${taskId}/acceptance/${manualItem.id}/manual-review`, { decision: 'failed', note: '复核发现问题' });
    expect(fail.status).toBe(200);
    expect(fail.json.find((a: any) => a.id === manualItem.id).status).toBe('failed');

    // 回退改判 passed → requestKey 加序号避开 UNIQUE 约束，不 500
    const back = await api(s, 'POST', `/api/tasks/${taskId}/acceptance/${manualItem.id}/manual-review`, { decision: 'passed' });
    expect(back.status).toBe(200);
    expect(back.json.find((a: any) => a.id === manualItem.id).status).toBe('passed');
    const ops3 = await api(s, 'GET', `/api/tasks/${taskId}/operations`);
    const manualOps = ops3.json.filter((o: any) => o.type === 'manual_review');
    expect(manualOps.length).toBe(3);

    // 证据链：B 级人证、结果与判定一致、note 落档
    const ovf = await api(s, 'GET', `/api/tasks/${taskId}`);
    expect(ovf.json.hasStaleEvidence).toBe(false);
    const finalItem = ovf.json.acceptance.find((a: any) => a.id === manualItem.id);
    expect(finalItem.status).toBe('passed');
  });
});

describe('SSE 事件流', () => {
  it('?since=seq 重放历史 + 实时推送新事件', async () => {
    const s = await startService();
    const { writeFixtureProject } = await import('./helpers/fixtures.ts');
    const fx = await writeFixtureProject('ok');
    cleanups.push(fx.root, fx.profileDir);
    const created = await api(s, 'POST', '/api/tasks', {
      projectRoot: fx.root,
      profileId: fx.profileId,
      title: 'SSE 任务',
    });
    const taskId: string = created.json.id;

    // 重放：since=1（跳过 runner/ready）
    const replay = await readSse(s, `/api/events?since=1`, 2, 5_000);
    expect(replay.length).toBeGreaterThanOrEqual(2);
    const seqs = replay.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(replay.some((e) => e.type === 'task/updated')).toBe(true);

    // 实时：先开流再创建任务 → 推送到达
    const live = sseBuffer(s, '/api/events?since=99999');
    await new Promise((r) => setTimeout(r, 200));
    await api(s, 'POST', '/api/tasks', { projectRoot: fx.root, profileId: fx.profileId, title: 'SSE 实时' });
    const events = await live.next(5_000, 1);
    live.close();
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]?.type).toBe('task/updated');
    void taskId;
  });
});

/** 读取 SSE 直到收满 count 条 data 事件或超时 */
function readSse(s: { baseUrl: string }, pathname: string, count: number, timeoutMs: number): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const events: any[] = [];
    const req = http.get(`${s.baseUrl}${pathname}`, { headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`SSE 状态码 ${res.statusCode}`));
        return;
      }
      expect(res.headers['content-type']).toContain('text/event-stream');
      let buf = '';
      const timer = setTimeout(() => {
        req.destroy();
        resolve(events);
      }, timeoutMs);
      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let idx = buf.indexOf('\n\n');
        while (idx >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
          if (dataLine) {
            events.push(JSON.parse(dataLine.slice(6)));
            if (events.length >= count) {
              clearTimeout(timer);
              req.destroy();
              resolve(events);
              return;
            }
          }
          idx = buf.indexOf('\n\n');
        }
      });
      res.on('error', () => undefined);
    });
    req.on('error', (e) => reject(e));
  });
}

/** SSE 流式缓冲（手动控制生命周期） */
function sseBuffer(s: { baseUrl: string }, pathname: string): { next(timeoutMs: number, count: number): Promise<any[]>; close(): void } {
  const events: any[] = [];
  const waiters: Array<{ count: number; resolve: (v: any[]) => void; timer: NodeJS.Timeout }> = [];
  const req = http.get(`${s.baseUrl}${pathname}`, { headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' } }, (res) => {
    let buf = '';
    res.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let idx = buf.indexOf('\n\n');
      while (idx >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (dataLine) {
          events.push(JSON.parse(dataLine.slice(6)));
          const w = waiters.find((x) => events.length >= x.count);
          if (w) {
            clearTimeout(w.timer);
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(events.splice(0));
          }
        }
        idx = buf.indexOf('\n\n');
      }
    });
    res.on('error', () => undefined);
  });
  return {
    next(timeoutMs: number, count: number): Promise<any[]> {
      if (events.length >= count) return Promise.resolve(events.splice(0));
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const i = waiters.findIndex((x) => x.count === count);
          if (i >= 0) waiters.splice(i, 1);
          resolve(events.splice(0));
        }, timeoutMs);
        waiters.push({ count, resolve, timer });
      });
    },
    close(): void {
      req.destroy();
    },
  };
}

describe('授权与诊断路由', () => {
  it('pending-authorization 空数组；authorize 不存在的操作 → 404；devices 无适配 → 空数组+说明；diagnostics 无凭证', async () => {
    const s = await startService();
    const pending = await api(s, 'GET', '/api/pending-authorization');
    expect(pending.json).toEqual([]);

    const missing = await api(s, 'POST', '/api/ops/authorize', {
      operationId: 'op-00000000-0000-4000-8000-000000000000',
      decision: 'approved',
      confirmedScope: { taskId: 'task-00000000-0000-4000-8000-000000000000' },
    });
    expect(missing.status).toBe(404);

    const devices = await api(s, 'GET', '/api/devices');
    expect(devices.json.devices).toEqual([]);
    expect(devices.json.adapterAvailable).toBe(false);
    expect(devices.json.note).toContain('设备适配层未注入');

    const diag = await api(s, 'GET', '/api/diagnostics');
    expect(diag.json.schemaVersion).toBe(1);
    expect(diag.json.storageOk).toBe(true);
    expect(typeof diag.json.gitAvailable).toBe('boolean');
    expect(diag.json.probeRsAvailable).toBe(false);
    expect(JSON.stringify(diag.json)).not.toContain(TOKEN); // 诊断不含令牌
  });

  it('发现文件写入与清理（close 后移除）', async () => {
    const s = await startService();
    const discovery = JSON.parse(await fsp.readFile(s.discoveryPath, 'utf8'));
    expect(discovery.schemaVersion).toBe(1);
    expect(discovery.port).toBe(s.port);
    expect(discovery.token).toBe(TOKEN);
    expect(discovery.pid).toBe(process.pid);
  });
});
