/**
 * A-12 模型驱动工程任务闭环（按需运行；消耗真实模型 token——ChatGPT 订阅或激活的提供方）：
 *   fixture 拷贝到临时目录 → recentProjects 指向 → 冷启动预热（引擎 cwd=工程目录）→
 *   桥建任务（含验收单）→ UI 下发修复指令 → 自动审批（优先"本会话内允许"）→
 *   等回合完成 → 落盘核验修复 → runner 侧操作/证据核验 → 人工验收点亮 → 导出交付包。
 * 原生对话框不可自动化环节均走桥/UI 现有通道；fixture 用临时副本，仓库原件不动。
 * 用法：node scripts/model-task-e2e.mjs
 */
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const PORT = process.env.FD_A12_PORT ?? '9244';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureSrc = path.join(repoRoot, 'engineering', 'fixtures', 'sample-tool');
const workDir = path.join(os.tmpdir(), 'fd-a12', 'sample-tool');
const APPDATA = process.env.APPDATA;
const settingsPath = path.join(APPDATA, 'ForgeStudio', 'settings.json');
const exe = path.join(process.env.LOCALAPPDATA, 'Programs', 'ForgeStudio', 'ForgeStudio.exe');
const TASK_TITLE = 'A-12 模型修复：wordcount 空输入崩溃';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const assert = (c, m) => { if (!c) { failed++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); };
const log = (s, d) => console.log(`[a12] ${s}${d ? ' — ' + d : ''}`);

async function prep() {
  // 上一轮引擎子进程（cwd=工作副本）可能短暂占用目录：先清残留再重试删除
  const { execSync } = await import('node:child_process');
  try { execSync(`powershell -NoProfile -Command "Get-Process ForgeStudio,codex -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*ForgeStudio*' } | Stop-Process -Force"`, { stdio: 'ignore' }); } catch {}
  await sleep(1500);
  for (let i = 0; i < 5; i++) {
    try {
      await fsp.rm(path.dirname(workDir), { recursive: true, force: true });
      break;
    } catch {
      if (i === 4) throw new Error('工作目录被占用，无法清理（请稍后重跑）');
      await sleep(1500);
    }
  }
  await fsp.cp(fixtureSrc, workDir, { recursive: true });
  const raw = JSON.parse(await fsp.readFile(settingsPath, 'utf8'));
  const next = {
    ...raw,
    modelProvider: undefined, // 本轮走 ChatGPT 官方登录
    recentProjects: [
      { projectRoot: workDir, name: 'sample-tool', at: new Date().toISOString() },
      ...(raw.recentProjects ?? []).filter((p) => p.projectRoot !== workDir),
    ].slice(0, 20),
  };
  await fsp.writeFile(settingsPath, JSON.stringify(next, null, 2), 'utf8');
  const buggy = await fsp.readFile(path.join(workDir, 'tools', 'wordcount.mjs'), 'utf8');
  assert(buggy.includes('words.length') && !/words\s*\?\s*words/.test(buggy), '工作副本为带缺陷原始版');
}

async function cdp() {
  let page = null;
  for (let i = 0; i < 200; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) break;
    } catch {}
    await sleep(100);
  }
  if (!page) throw new Error('CDP 20s 未出现');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expr, timeoutMs = 60000) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: timeoutMs });
    return r.exceptionDetails ? 'EXC:' + JSON.stringify(r.exceptionDetails).slice(0, 200) : r.result.value;
  };
  await send('Runtime.enable');
  return { ev, reload: () => send('Page.reload') };
}

async function main() {
  await prep();
  const { execSync } = await import('node:child_process');
  try { execSync(`powershell -NoProfile -Command "Get-Process ForgeStudio -ErrorAction SilentlyContinue | Stop-Process -Force"`, { stdio: 'ignore' }); } catch {}
  await sleep(2000);
  spawn(exe, [`--remote-debugging-port=${PORT}`], { detached: true, stdio: 'ignore' }).unref();
  const { ev, reload } = await cdp();

  log('1', '等预热引擎 ready（cwd=工程副本）');
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if ((await ev('window.forgedesk.engine.status()')) === 'ready') { ready = true; break; }
    await sleep(1000);
  }
  assert(ready, '引擎就绪');
  const auth = await ev('window.forgedesk.engine.authStatus()');
  log('1', `认证：${JSON.stringify(auth?.value?.mode ?? auth)}`);

  log('2', '桥建任务（含验收单）');
  const created = await ev(`window.forgedesk.runner.createTask({
    projectRoot: ${JSON.stringify(workDir.replaceAll('\\', '/'))},
    profileId: 'sample-tool-wordcount',
    title: ${JSON.stringify(TASK_TITLE)},
    acceptance: [
      { kind: 'executable', verifierId: 'wordcount-normal', title: '正常文本词数统计', expected: 'fixtures/normal.txt 输出 words=12 且退出码 0', manualRequired: false, required: true },
      // 复现器语义=检测缺陷存在：修复后其 failed 恰是"缺陷已消失"的证据，故设为非必需观察项
      { kind: 'executable', verifierId: 'wordcount-empty-crash-repro', title: '空输入缺陷复现器（修复后应转 failed）', expected: '修复后复现器不再复现崩溃（failed 即缺陷已除）', manualRequired: false, required: false },
      { kind: 'manual', title: '人工复核修复 diff', expected: '修复改动经人工审阅', manualRequired: true, required: true },
    ],
  })`);
  assert(created?.ok === true && created.value?.id, `任务创建 ok=${created?.ok}`);
  const taskId = created.value.id;
  log('2', `taskId=${taskId}`);

  log('3', 'UI 下发修复指令（真实模型回合）');
  const prompt = [
    `工程任务（taskId: ${taskId}）：修复当前目录 tools/wordcount.mjs 的空输入崩溃缺陷。`,
    '背景：输入为空（空文件/空 stdin）时 text.match(/\\S+/g) 返回 null，words.length 抛未捕获 TypeError，进程非 0 退出。',
    '要求：',
    '1) 只做最小必要修改（空输入应输出 words=0 且退出码 0，正常输入行为不变）；',
    `2) 修改后调用 MCP 工具留证：先 engineering.build（参数只传 taskId='${taskId}'），再 engineering.test 两次（taskId='${taskId}'，verifierId 分别为 'wordcount-normal' 与 'wordcount-empty-crash-repro'）；`,
    '3) 最后用两三句话说明修改点。不要改动 fixtures、test、scripts 目录。',
  ].join('\n');
  await ev(`(() => {
    const ta = document.querySelector('textarea[aria-label="消息输入"], textarea[aria-label="追加指令"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(prompt)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 'filled';
  })()`);
  await ev(`document.querySelector('[data-testid="send-btn"]')?.click()`);
  log('3', '已发送，观察回合（自动审批优先"本会话内允许"）');

  let approved = 0;
  let lastLen = 0;
  const deadline = Date.now() + 15 * 60 * 1000;
  let turnDone = false;
  while (Date.now() < deadline) {
    // 自动审批：未处理审批卡 → 点"本会话内允许"，无则"允许一次"
    const n = await ev(`(() => {
      const cards = [...document.querySelectorAll('.approval-card:not(.approval-card--resolved)')];
      let clicked = 0;
      for (const c of cards) {
        const btns = [...c.querySelectorAll('.approval-card__actions button')];
        const pick = btns.find(b => b.textContent.includes('本会话内允许')) ?? btns.find(b => b.textContent.includes('允许一次'));
        if (pick) { pick.click(); clicked++; }
      }
      return clicked;
    })()`);
    if (typeof n === 'number' && n > 0) { approved += n; log('审批', `自动允许 ×${n}（累计 ${approved}）`); }
    const stream = await ev(`document.querySelector('.chat-stream')?.innerText ?? ''`);
    if (stream.length > lastLen + 400) { log('回合', `进行中 stream=${stream.length} 字符，尾：${JSON.stringify(stream.slice(-90))}`); lastLen = stream.length; }
    const err = await ev(`!!document.querySelector('.error-card')`);
    if (err) { log('回合', '出现错误卡：' + JSON.stringify(await ev(`document.querySelector('.error-card')?.innerText?.slice(0, 200) ?? ''`))); break; }
    const running = await ev(`!!document.querySelector('[data-testid="composer-stop-btn"]')`);
    const idleComposer = await ev(`!!document.querySelector('textarea[aria-label="消息输入"]')`);
    if (!running && idleComposer && lastLen > 0) {
      await sleep(2500); // 等终态事件投影
      const running2 = await ev(`!!document.querySelector('[data-testid="composer-stop-btn"]')`);
      if (!running2) { turnDone = true; break; }
    }
    await sleep(4000);
  }
  assert(turnDone, `模型回合完成（审批 ${approved} 次）`);
  const tailText = await ev(`document.querySelector('.chat-stream')?.innerText?.slice(-500) ?? ''`);
  log('3', '回合尾部：' + JSON.stringify(String(tailText).slice(-260)));

  log('4', '落盘核验修复（Node 侧独立验证，不信模型自述）');
  const fixed = await fsp.readFile(path.join(workDir, 'tools', 'wordcount.mjs'), 'utf8');
  const semanticallyFixed = /words\s*\?\s*words\.length\s*:\s*0/.test(fixed) || /(words\s*===\s*null|words\s*==\s*null|!words)/.test(fixed);
  assert(semanticallyFixed, 'tools/wordcount.mjs 已含空输入防护');
  const sanity = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(workDir, 'tools', 'wordcount.mjs'), path.join(workDir, 'fixtures', 'empty.txt')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out: out.trim() }));
  });
  assert(sanity.code === 0 && sanity.out === 'words=0', `独立运行：空输入退出码 ${sanity.code}，输出 "${sanity.out}"`);

  log('5', 'runner 侧核验（模型经 MCP 工具留证的操作与证据）');
  const task = await ev(`window.forgedesk.runner.getTask(${JSON.stringify(taskId)})`);
  const ops = task?.value?.operations ?? [];
  const evidence = task?.value?.evidence ?? [];
  log('5', `操作 ${ops.length} 条（类型：${[...new Set(ops.map((o) => o.type))].join(',')}），证据 ${evidence.length} 条`);
  assert(ops.some((o) => o.type === 'build' && o.status === 'succeeded'), '模型调用 engineering.build 成功');
  assert(ops.filter((o) => o.type === 'test' && o.status === 'succeeded').length >= 1, '模型调用 engineering.test 成功');
  assert(evidence.length >= 1, '证据落链');

  log('6', '重载页面使工程面板指向本任务，再走人工验收 + 导出（UI 真实按钮）');
  await reload();
  const waitFor = async (exprJs, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await ev(exprJs)) return true;
      await sleep(1000);
    }
    return false;
  };
  await waitFor(`!!document.querySelector('.panel__task-name')`, 30000);
  await waitFor(`[...document.querySelectorAll('.acc-item')].some(el => el.textContent.includes('人工复核修复 diff'))`, 30000);
  const panelTask = await ev(`document.querySelector('.panel__task-name')?.textContent ?? ''`);
  assert(panelTask.includes('A-12 模型修复'), `面板已指向本任务（${panelTask.slice(0, 24)}）`);
  await ev(`(() => { window.__fdConfirmBackup = window.confirm; window.confirm = () => true; })()`);
  await ev(`(() => {
    const items = [...document.querySelectorAll('.acc-item')].filter(el => el.textContent.includes('人工复核修复 diff'));
    const item = items.find(el => el.dataset.accStatus !== 'passed') ?? items[0];
    item?.querySelector('[data-testid="manual-pass-btn"]')?.click();
    return true;
  })()`);
  await ev(`window.confirm = window.__fdConfirmBackup;`);
  // 等 manual 项点亮（manualReview 异步 IPC）再导出
  let manualLit = false;
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const st = await ev(`[...document.querySelectorAll('.acc-item')].find(el => el.textContent.includes('人工复核修复 diff'))?.dataset.accStatus ?? ''`);
    if (st === 'passed') { manualLit = true; break; }
  }
  assert(manualLit, '人工验收项点亮');
  await ev(`document.querySelector('[data-testid="export-btn"]')?.click()`);
  let exported = false;
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const t2 = await ev(`window.forgedesk.runner.getTask(${JSON.stringify(taskId)})`);
    const op2 = t2?.value?.operations ?? [];
    if (op2.some((o) => String(o.type).includes('export') && o.status === 'succeeded')) { exported = true; break; }
  }
  assert(exported, '导出交付包成功（runner 侧核验）');
  const countText = await ev(`[...document.querySelectorAll('.acceptance__count')].map(e=>e.textContent).join('|')`);
  const judge = await ev(`document.querySelector('[data-testid="acceptance-judge"]')?.textContent ?? ''`);
  log('6', `判定：${judge}；计数：${countText}`);
  assert(judge.includes('验收通过'), '任务验收通过徽标点亮');

  console.log(failed === 0 ? '\nA-12 模型驱动工程任务闭环 全部通过' : `\n有 ${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[a12] 失败:', err);
  process.exit(1);
});
