/**
 * 集成冒烟：真实进程级验证（开发机证据，非 mock）。
 * 1) node 启动 dist/runner/service.cjs（utilityProcess 同款 bundle）
 * 2) HTTP 控制面：创建任务（sample-tool fixture）→ build → test → 证据 → export
 * 3) 输入变化 → 证据过期（A 级失效规则）
 * 4) MCP 桥 bundle：initialize / tools/list / tools/call 握手冒烟
 * 用法：node scripts/smoke-runner.mjs
 * 安装态复验（A-10 深检）：FD_SMOKE_EXEC / FD_SMOKE_SERVICE_PATH / FD_SMOKE_BRIDGE_PATH /
 *   FD_SMOKE_DATA_DIR / FD_SMOKE_AS_NODE=1 指向安装目录产物，用随包 ForgeStudio.exe 作 Node 运行时。
 */
import { spawn, execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.FD_SMOKE_DATA_DIR ?? path.join(repoRoot, '.runtime', 'smoke');
const servicePath = process.env.FD_SMOKE_SERVICE_PATH ?? path.join(repoRoot, 'apps', 'desktop', 'dist', 'runner', 'service.cjs');
const bridgePath = process.env.FD_SMOKE_BRIDGE_PATH ?? path.join(repoRoot, 'apps', 'desktop', 'dist', 'bridge', 'mcp-bridge.cjs');
const childExec = process.env.FD_SMOKE_EXEC ?? process.execPath;
const childEnv = process.env.FD_SMOKE_AS_NODE === '1'
  ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  : { ...process.env };
const sampleToolDir = path.join(repoRoot, 'engineering', 'fixtures', 'sample-tool');

console.log(`[smoke] runner=${servicePath}`);
console.log(`[smoke] bridge=${bridgePath}`);
console.log(`[smoke] exec=${childExec}${childEnv.ELECTRON_RUN_AS_NODE ? ' (ELECTRON_RUN_AS_NODE)' : ''}`);
console.log(`[smoke] dataDir=${dataDir}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (step, detail) => console.log(`[smoke] ${step}${detail ? ' — ' + detail : ''}`);

async function readDiscovery() {
  for (let i = 0; i < 60; i++) {
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(dataDir, 'runner-discovery.json'), 'utf8'));
      if (raw.port && raw.token) return raw;
    } catch {}
    await sleep(200);
  }
  throw new Error('发现文件 20s 未出现');
}

async function main() {
  await fsp.rm(dataDir, { recursive: true, force: true });
  await fsp.mkdir(path.join(dataDir, 'profiles'), { recursive: true });
  // 用户 profile：sample-tool（fixture 工程，标注模拟样例）
  await fsp.copyFile(path.join(sampleToolDir, 'forgedesk.profile.json'), path.join(dataDir, 'profiles', 'sample-tool.profile.json'));

  log('1', '启动 runner 服务 bundle（真实进程）');
  const proc = spawn(childExec, [servicePath, '--fd-runner-data-dir', dataDir], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  try {
    const { port, token } = await readDiscovery();
    const api = async (p, init) => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...(init?.body ? { 'content-type': 'application/json' } : {}) },
        body: init?.body ? JSON.stringify(init.body) : undefined,
      });
      return res.json();
    };

    const health = await api('/health');
    log('2', `health=${JSON.stringify(health)}`);

    const profiles = await api('/api/profiles');
    const profileEntry = profiles.find?.((p) => p.id === 'sample-tool-wordcount');
    const revision = profileEntry?.revision ?? 1;
    log('3', `profiles=${profiles.length}（sample-tool-wordcount rev${revision}: ${profileEntry ? '已加载' : '缺失'}）`);
    if (!profileEntry) throw new Error('profile 未加载');

    log('4', '创建任务（含验收单）');
    const task = await api('/api/tasks', {
      method: 'POST',
      body: {
        projectRoot: sampleToolDir,
        profileId: 'sample-tool-wordcount',
        title: '冒烟：sample-tool 空输入缺陷',
        acceptance: [
          { kind: 'executable', verifierId: 'wordcount-normal', title: '正常文本词数统计', expected: 'fixtures/normal.txt 输出 words=N 且退出码 0', manualRequired: false, required: true },
          { kind: 'executable', verifierId: 'wordcount-empty-crash-repro', title: '空输入缺陷复现器', expected: '缺陷存在时复现器按预期报告（修复后转绿需人工复核）', manualRequired: false, required: true },
          { kind: 'manual', title: '人工复核 diff', expected: '修复改动经人工审阅', manualRequired: true, required: true },
        ],
      },
    });
    const taskId = task.id;
    log('5', `taskId=${taskId}`);

    log('6', '真实构建（node 执行 sample-tool build 脚本）');
    const buildRaw = await api('/api/ops/build?wait=true', { method: 'POST', body: { taskId, profileRevision: revision } });
    const build = buildRaw.result ?? buildRaw;
    log('6', `build ok=${build.ok} buildId=${build.buildId ?? '-'} sha=${(build.artifactSha256 ?? '').slice(0, 12)}`);
    if (!build.ok) throw new Error('构建失败: ' + JSON.stringify(buildRaw).slice(0, 300));

    log('7', '固定验收测试 wordcount-normal');
    const t1 = (await api('/api/ops/test?wait=true', { method: 'POST', body: { taskId, verifierId: 'wordcount-normal' } })).result;
    log('7', `result=${t1?.result}`);

    log('8', '固定验收测试 wordcount-empty-crash-repro（缺陷复现器）');
    const t2 = (await api('/api/ops/test?wait=true', { method: 'POST', body: { taskId, verifierId: 'wordcount-empty-crash-repro' } })).result;
    log('8', `result=${t2?.result}（缺陷存在时的复现器行为）`);

    const overview = await api(`/api/tasks/${taskId}`);
    const passedCount = overview.acceptance.filter((a) => a.status === 'passed').length;
    log('9', `验收单 ${passedCount}/${overview.acceptance.length} 通过，hasStaleEvidence=${overview.hasStaleEvidence}，证据 ${overview.evidence.length} 条`);
    if (overview.hasStaleEvidence) throw new Error('无输入变化时不应过期');
    if (!overview.evidence.length) throw new Error('无证据落盘');

    log('10', 'requestKey 幂等：同键重复 build');
    const key = 'smoke-' + crypto.randomUUID().slice(0, 8);
    const b1 = await api('/api/ops/build?wait=true', { method: 'POST', body: { taskId, profileRevision: revision, requestKey: key } });
    const b2 = await api('/api/ops/build?wait=true', { method: 'POST', body: { taskId, profileRevision: revision, requestKey: key } });
    log('10', `op1=${b1.operationId} op2=${b2.operationId} 同操作=${b1.operationId === b2.operationId}`);
    if (b1.operationId !== b2.operationId) throw new Error('幂等失败');

    log('11', '修改输入 → A 级证据过期');
    const probeFile = path.join(sampleToolDir, 'fixtures', 'normal.txt');
    const orig = await fsp.readFile(probeFile, 'utf8');
    await fsp.writeFile(probeFile, orig + '\nsmoke-edit', 'utf8');
    try {
      const stale = await api(`/api/tasks/${taskId}`);
      log('11', `修改后 hasStaleEvidence=${stale.hasStaleEvidence}（期望 true）`);
      if (!stale.hasStaleEvidence) throw new Error('证据未过期');
    } finally {
      await fsp.writeFile(probeFile, orig, 'utf8');
    }

    log('12', '导出交付包');
    const exp = (await api('/api/ops/export?wait=true', { method: 'POST', body: { taskId } })).result;
    log('12', `bundle=${exp?.bundlePath ? '已生成' : '失败'}`);
    if (!exp?.bundlePath) throw new Error('导出失败');

    // ---- MCP 桥 bundle 冒烟 ----
    log('13', 'MCP 桥 initialize/tools/list/tools/call');
    const mcpResult = await mcpSmoke(port, token, taskId);
    log('13', `initialize=${mcpResult.init ? 'OK' : 'FAIL'} tools=${mcpResult.tools} inspect=${mcpResult.inspect ? 'OK' : 'FAIL'}`);
    if (!mcpResult.init || mcpResult.tools !== 7) throw new Error('MCP 握手异常');

    log('DONE', '冒烟全部通过');
  } finally {
    proc.kill();
    if (stderr.trim()) console.log('[smoke][runner-stderr-tail]\n' + stderr.split('\n').slice(-5).join('\n'));
  }

  async function mcpSmoke(runnerPort, runnerToken, taskId) {
    // 桥按发现文件连接 runner（与上面同一实例）
    const child = spawn(childExec, [bridgePath], {
      env: { ...childEnv, FD_RUNNER_DATA_DIR: dataDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
    try {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
      await sleep(800);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      await sleep(800);
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'engineering.inspect', arguments: { taskId, profileId: 'sample-tool-wordcount' } } });
      await sleep(2500);
      const lines = out.split('\n').filter((l) => l.trim().startsWith('{'));
      const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const init = parsed.find((p) => p.id === 1 && p.result?.serverInfo);
      const toolsList = parsed.find((p) => p.id === 2 && p.result?.tools);
      const inspect = parsed.find((p) => p.id === 3 && p.result);
      return {
        init: !!init,
        tools: toolsList ? toolsList.result.tools.length : 0,
        inspect: !!inspect,
      };
    } finally {
      child.kill();
    }
  }
}

main().catch((err) => {
  console.error('[smoke] 失败:', err);
  process.exit(1);
});
