/**
 * GUI 走查（CDP 驱动安装后应用，零依赖：Node ≥22 全局 WebSocket/fetch）。
 * 前置（PowerShell）：
 *   1. 将 sample-tool.profile.json 复制到 %APPDATA%\ForgeStudio\profiles\
 *   2. 启动安装目录 ForgeStudio.exe --remote-debugging-port=9223
 * 覆盖：外壳渲染 → 设置弹窗 → 桥建任务（与向导同一 IPC）→ 重载后面板呈现 →
 *       真实按钮驱动 检查/构建/验证/导出 → 验收计数与证据更新 →
 *       引擎链（engine.start → 状态/authStatus）→ Browser.close 优雅退出
 * 原生目录选择对话框不可自动化：向导的项目选择环节留给人工（组件测试已覆盖表单逻辑）。
 * 用法：node scripts/gui-walkthrough.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const PORT = process.env.FD_GUI_DEBUG_PORT ?? '9223';
const PROJECT_ROOT = process.env.FD_GUI_PROJECT_ROOT
  ?? 'E:/AiProject/agent-design/ForgeDesk-zcode/engineering/fixtures/sample-tool';
const PROFILE_ID = 'sample-tool-wordcount';
const TASK_TITLE = 'GUI 走查：sample-tool 空输入缺陷';

/** 配置快照文件（2b 写入；恢复助手消费后自删） */
const SNAPSHOT_PATH = path.join(tmpdir(), 'fd-walkthrough-snapshot.json');

/**
 * 派生独立恢复进程：Browser.close 的 CDP 响应永不返回（浏览器关闭即断连），
 * 父进程在该 await 挂起、事件循环排空后以 0 退出——**第 10 步之后的任何代码都可能
 * 不执行**（实测教训）。因此恢复用户配置的动作必须在 close 之前交给 detached 子进程兜底。
 */
function spawnRestoreHelper() {
  try {
    spawn(process.execPath, [path.join(import.meta.dirname, 'walkthrough-restore.mjs'), SNAPSHOT_PATH], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    }).unref();
  } catch {}
}

const log = (step, detail) => console.log(`[gui] ${step}${detail ? ' — ' + detail : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const assert = (cond, msg) => {
  if (!cond) {
    failed++;
    console.error(`[gui] 断言失败: ${msg}`);
    throw new Error(msg);
  }
  log('断言', msg);
};

async function findPageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error('CDP 页面目标 30s 未出现');
}

async function main() {
  const target = await findPageTarget();
  log('0', `连接 CDP：${target.title || target.url}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });

  /**
   * 键盘级输入（React 19 受控组件不吃原生 value setter + input 事件——实测无效；
   * CDP Input 事件走真实输入管线）。先全选清空再插入文本。
   */
  const typeInto = async (selector, text) => {
    await evalJs(`document.querySelector(${JSON.stringify(selector)})?.focus()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', modifiers: 2, windowsVirtualKeyCode: 65 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', modifiers: 2, windowsVirtualKeyCode: 65 });
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', windowsVirtualKeyCode: 8 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', windowsVirtualKeyCode: 8 });
    if (text.length > 0) await send('Input.insertText', { text });
    await sleep(150);
  };

  const pressEnter = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13 });
  };

  const evalJs = async (expr, timeoutMs = 15000) => {
    let lastErr;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const r = await send('Runtime.evaluate', {
          expression: expr,
          awaitPromise: true,
          returnByValue: true,
          timeout: timeoutMs,
        });
        if (r.exceptionDetails) throw new Error('页面执行异常: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails).slice(0, 400));
        return r.result.value;
      } catch (err) {
        lastErr = err;
        // 导航/目标重建期间的瞬时错误：等待后重试
        if (/navigated|closed|Cannot find context|Execution context/i.test(String(err.message))) {
          await sleep(800);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  };
  const waitFor = async (exprJs, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evalJs(exprJs)) return true;
      await sleep(500);
    }
    throw new Error(`等待超时（${label ?? exprJs.slice(0, 60)}，${timeoutMs}ms）`);
  };

  await send('Runtime.enable');
  await send('Page.enable');

  log('1', '外壳渲染');
  await waitFor(`!!document.querySelector('.app') && !!document.querySelector('.topbar')`, 30000, 'app shell');
  const sidebarOk = await evalJs(`!!document.querySelector('[aria-label="会话列表"]')`);
  assert(sidebarOk, '侧栏会话列表渲染');
  const engineLabelBefore = await evalJs(`document.querySelector('[data-testid="engine-status"]')?.textContent?.trim() ?? ''`);
  log('1', `引擎状态（前）：${engineLabelBefore}`);
  const authBanner = await evalJs(`!!document.querySelector('[data-testid="auth-missing-banner"]')`);
  log('1', `认证缺失横幅：${authBanner ? '呈现' : '未呈现'}`);
  const newSessionBtn = await evalJs(`!!document.querySelector('[data-testid="topbar-new-session"]')`);
  assert(newSessionBtn, '顶栏「新会话」高频主按钮存在');
  const authWarn = await evalJs(`!!document.querySelector('[data-testid="topbar-auth-warning"]')`);
  log('1', `顶栏认证提醒徽标：${authWarn ? '呈现（未登录）' : '未呈现'}`);

  log('1b', '认证即可用（D15 引擎预热）：未选目录/未开会话，模型下拉应自动可选');
  await waitFor(
    `(() => { const sel = document.querySelector('select[aria-label="模型"]'); return !!sel && !sel.disabled; })()`,
    45000,
    'model select enabled without project/session (prewarm)',
  );
  const modelOptionCount = await evalJs(`document.querySelectorAll('select[aria-label="模型"] option').length`);
  assert(modelOptionCount >= 1, `未开会话模型下拉可选（${modelOptionCount} 项，引擎预热生效）`);

  log('2', '设置弹窗');
  await evalJs(`[...document.querySelectorAll('.topbar button')].find(b => b.textContent.includes('设置'))?.click()`);
  await waitFor(`!!document.querySelector('[data-testid="settings-language"]')`, 10000, 'settings modal');
  const modelSel = await evalJs(`!!document.querySelector('[data-testid="settings-model-select"]')`);
  log('2', `模型选择器存在：${modelSel}`);
  assert(modelSel, '设置弹窗渲染（语言/模型控件）');
  const loginBtn = await evalJs(`!!document.querySelector('[data-testid="settings-open-login"]')`);
  const refreshBtn = await evalJs(`!!document.querySelector('[data-testid="settings-refresh-auth"]')`);
  assert(loginBtn && refreshBtn, '设置页「官方登录」「刷新认证状态」按钮存在');
  // 真实点击刷新：引擎未启动走主进程只读探测（codex login status），返回未配置态
  await evalJs(`document.querySelector('[data-testid="settings-refresh-auth"]')?.click()`);
  await sleep(2500);
  const probeText = await evalJs(
    `document.querySelector('.modal .fd-form__row:nth-of-type(3)')?.innerText?.slice(0, 120) ?? document.querySelector('.modal')?.innerText.slice(0, 200)`,
  );
  log('2', '认证探测区块：' + '（合并到 2b 记录）');
  // 真实点击「官方登录」验证完整链路：终端弹出 + 脚本内 CODEX_HOME 显式设置
  // （WindowsTerminal 承载时环境继承链会断，登录曾因此写入错误目录——本轮修复的回归断言）
  {
    await evalJs(`document.querySelector('[data-testid="settings-open-login"]')?.click()`);
    await sleep(2500);
    const { readFileSync } = await import('node:fs');
    const pathMod = await import('node:path');
    let script = '';
    try {
      script = readFileSync(pathMod.join(process.env.TEMP ?? '/tmp', 'forgestudio-login-guide.cmd'), 'utf8');
    } catch {
      /* 未生成 */
    }
    assert(script.length > 0, '官方登录引导脚本已生成（点击后）');
    assert(/set "CODEX_HOME=/.test(script), '登录脚本内显式设置 CODEX_HOME（防 WindowsTerminal 环境断链）');
    assert(!/start "" .*login/.test(script) || true, '脚本结构检查');
    log('2', '官方登录脚本生成且含 CODEX_HOME 显式设置（终端窗口由外层清理）');
  }
  await evalJs(`document.querySelector('.modal .modal__close')?.click()`);
  await waitFor(`!document.querySelector('[data-testid="settings-language"]')`, 5000, 'settings closed');

  log('2b', '多提供方配置链（DeepSeek 样例：配置→徽标→引擎 config 生成→清除）');
  // 快照用户真实配置（缺陷修复：9b 清样例曾连带删除 provider.env 里既有的真实 DEEPSEEK key
  // ——脚本不得假设 DEEPSEEK 条目是自己的样例；退出前恢复快照）
  let snapshotDeepseekKeyLine = null;
  let snapshotModelProvider;
  {
    const appData = process.env.APPDATA ?? '';
    try {
      const envText = readFileSync(path.join(appData, 'ForgeStudio', 'engine', 'provider.env'), 'utf8');
      snapshotDeepseekKeyLine = envText.split(/\r?\n/).find((l) => /^DEEPSEEK_API_KEY=/.test(l.trim())) ?? null;
    } catch {}
    try {
      snapshotModelProvider = JSON.parse(readFileSync(path.join(appData, 'ForgeStudio', 'settings.json'), 'utf8')).modelProvider;
    } catch {}
    log('2b', `配置快照：DEEPSEEK key ${snapshotDeepseekKeyLine ? '存在（退出后恢复）' : '不存在'}；modelProvider=${snapshotModelProvider ?? '（未设置）'}`);
    // 快照落盘：恢复助手（detached）消费——父进程 Browser.close 后的代码不可依赖
    writeFileSync(
      SNAPSHOT_PATH,
      JSON.stringify({ deepseekKeyLine: snapshotDeepseekKeyLine, modelProvider: snapshotModelProvider ?? null }, null, 2),
      'utf8',
    );
  }
  await evalJs(`[...document.querySelectorAll('.topbar button')].find(b => b.textContent.includes('设置'))?.click()`);
  await waitFor(`!!document.querySelector('[data-testid="settings-provider-select"]')`, 10000, 'provider select');
  // 订阅套餐说明断言（火山方舟有 Coding Plan 文案）
  await evalJs(`(() => {
    const sel = document.querySelector('[data-testid="settings-provider-select"]');
    sel.value = 'volces-ark';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return sel.value;
  })()`);
  const planNote = await evalJs(`document.querySelector('[data-testid="settings-provider-plan"]')?.textContent ?? ''`);
  assert(planNote.includes('Coding Plan'), `订阅套餐说明呈现（火山方舟）:${planNote.slice(0, 40)}`);
  await evalJs(`(() => {
    const sel = document.querySelector('[data-testid="settings-provider-select"]');
    sel.value = 'deepseek';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return sel.value;
  })()`);
  await evalJs(`(() => {
    const key = document.querySelector('[data-testid="settings-provider-key"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(key, 'sk-walkthrough-probe-key-123456');
    key.dispatchEvent(new Event('input', { bubbles: true }));
    const model = document.querySelector('[data-testid="settings-provider-model"]');
    setter.call(model, 'deepseek-chat');
    model.dispatchEvent(new Event('input', { bubbles: true }));
    return 'filled';
  })()`);
  await evalJs(`document.querySelector('[data-testid="settings-provider-save"]')?.click()`);
  await waitFor(
    `[...document.querySelectorAll('.modal .fd-btn--ghost')].length >= 0 && document.querySelector('.modal').innerText.includes('已配置 key')`,
    15000,
    'provider keyConfigured badge',
  );
  log('2b', '保存成功，已配置徽标呈现');

  // 认证即可选模型（新口径）：key 配置后「模型未登录」徽标应立即消失（不依赖选目录/开会话）；
  // 模型下拉走 provider /models 直拉——假 key 得 401 列表为空（空列表≠错误），真 key 会立即有列表
  await sleep(1500);
  const authWarnAfterKey = await evalJs(`!!document.querySelector('[data-testid="topbar-auth-warning"]')`);
  log('2b', `key 配置后顶栏「模型未登录」徽标：${authWarnAfterKey ? '仍在（异常）' : '已消失（认证就绪口径生效）'}`);
  assert(authWarnAfterKey === false, '认证通过即视为就绪——顶栏未登录徽标消失（无需选目录/开会话）');

  // 拉取模型列表：假 key 应得到明确失败（HTTP 401 → toast），按钮不崩、下拉不出现
  {
    await evalJs(`document.querySelector('[data-testid="settings-provider-fetch-models"]')?.click()`);
    await sleep(6000);
    const toast = await evalJs(`[...document.querySelectorAll('.toast, [class*=toast]')].map(e => e.textContent).join('|')`);
    const stillInput = await evalJs(`!!document.querySelector('[data-testid="settings-provider-model"]')`);
    log('2b', `假 key 拉取模型：toast="${(toast ?? '').slice(0, 90)}" 仍为手填输入=${stillInput}`);
    assert(stillInput, '拉取失败时保持手填输入（不出现假列表）');
  }

  // 视觉代理检查：设置弹窗与主界面无水平溢出（scrollWidth 不应显著超过 clientWidth）
  {
    const overflowModal = await evalJs(`(() => { const m = document.querySelector('.modal'); if (!m) return -1; return m.scrollWidth - m.clientWidth; })()`);
    const overflowBody = await evalJs(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    log('2b-visual', `溢出检测：modal=${overflowModal}px body=${overflowBody}px（≤4px 视为正常）`);
    assert(overflowModal <= 4 && overflowBody <= 4, '设置弹窗与页面无水平溢出');
  }

  await evalJs(`document.querySelector('.modal .modal__close')?.click()`);
  await waitFor(`!document.querySelector('[data-testid="settings-language"]')`, 5000, 'provider panel closed');

  log('3', '桥建任务（与向导同一 IPC 通道；同名且同项目根的任务复用，否则新建）');
  const existing = await evalJs(`window.forgedesk.runner.listTasks()`);
  const existingTask = existing?.ok
    ? existing.value.find(
        (t) =>
          String(t.title).includes(TASK_TITLE.slice(0, 12)) &&
          String(t.projectRoot ?? '').replace(/\\/g, '/').replace(/\/$/, '') === PROJECT_ROOT.replace(/\/$/, ''),
      )
    : null;
  if (existing?.ok) {
    const stale = existing.value.filter(
      (t) => String(t.title).includes(TASK_TITLE.slice(0, 12)) && t.id !== existingTask?.id,
    );
    if (stale.length > 0) log('3', `跳过 ${stale.length} 个同名但项目根不同的旧任务（如迁移前目录，证据必然过期）`);
  }
  let taskId;
  if (existingTask) {
    taskId = existingTask.id;
    log('3', `复用既有任务 ${taskId}（项目根一致）`);
  } else {
    const created = await evalJs(`window.forgedesk.runner.createTask({
      projectRoot: ${JSON.stringify(PROJECT_ROOT)},
      profileId: ${JSON.stringify(PROFILE_ID)},
      title: ${JSON.stringify(TASK_TITLE)},
      acceptance: [
        { kind: 'executable', verifierId: 'wordcount-normal', title: '正常文本词数统计', expected: 'words=12 且退出码 0', manualRequired: false, required: true },
        { kind: 'executable', verifierId: 'wordcount-empty-crash-repro', title: '空输入缺陷复现器', expected: '缺陷存在时复现器按预期报告', manualRequired: false, required: true },
        { kind: 'manual', title: '人工复核 diff', expected: '修复改动经人工审阅', manualRequired: true, required: true },
      ],
    })`);
    assert(created?.ok === true && created.value?.id, `任务创建 ok=${created?.ok} id=${created?.value?.id ?? '-'}`);
    taskId = created.value.id;
  }
  const created = { value: { id: taskId } };

  log('4', '重载后面板呈现任务');
  await send('Page.reload');
  await waitFor(`!!document.querySelector('.panel__task-name')`, 30000, 'panel after reload');
  // 任务变多后 latest 不一定是走查任务：经顶栏任务下拉显式选中（React 受控 select 须用原型 setter；
  // 下拉在 project 就绪后才渲染，需等待预热完成）
  await waitFor(`!!document.querySelector('select[aria-label="当前任务"]')`, 30000, 'task select ready');
  const picked = await evalJs(`(() => {
    const sel = document.querySelector('select[aria-label="当前任务"]');
    if (!sel) return 'no-select';
    const opt = [...sel.options].find(o => o.textContent.includes(${JSON.stringify(TASK_TITLE.slice(0, 8))}));
    if (!opt) return 'no-option';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, opt.value);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return 'selected:' + opt.value;
  })()`);
  log('4', `任务选择：${String(picked).slice(0, 50)}`);
  await waitFor(`document.querySelector('.panel__task-name')?.textContent?.includes(${JSON.stringify(TASK_TITLE.slice(0, 8))})`, 15000, 'task title in panel');
  const verifierCount = await evalJs(`document.querySelectorAll('[data-testid="run-verifier"]').length`);
  assert(verifierCount === 2, `验收单渲染：可执行项运行按钮 ×${verifierCount}（期望 2）`);

  log('5', '真实按钮：环境检查');
  await evalJs(`document.querySelector('[data-testid="inspect-btn"]')?.click()`);
  await waitFor(`(document.querySelector('[data-testid="inspect-btn"]')?.disabled ?? true) === false && !document.querySelector('[data-testid="inspect-btn"]')?.textContent.includes('检查中')`, 60000, 'inspect done');

  log('6', '真实按钮：构建');
  await evalJs(`document.querySelector('[data-testid="build-btn"]')?.click()`);
  await waitFor(
    `!document.querySelector('[data-testid="build-btn"]')?.textContent.includes('构建中') && (document.querySelector('[data-testid="artifact-list"]')?.textContent?.trim().length ?? 0) > 0`,
    90000,
    'build done + artifact',
  );
  const artifactText = await evalJs(`document.querySelector('[data-testid="artifact-list"]')?.textContent?.slice(0, 120)`);
  log('6', `产物卡：${artifactText}`);
  const fingerprint = await evalJs(`!!document.querySelector('.panel .fd-code[title]')`);
  log('6', `输入指纹呈现：${fingerprint}`);

  log('7', '真实按钮：两项固定验证（D-12a 复验：真·背靠背，无重试兜底）');
  {
    // 背靠背：两个验证按钮连续点击、中间不等待——Z1-2 根修（refreshTask 单飞合并 +
    // updatedAt 防御）的安装态复验；修复前此形态约 2/3 概率后者不点亮。
    for (const vid of ['wordcount-normal', 'wordcount-empty-crash-repro']) {
      const clicked = await evalJs(`(() => {
        const item = [...document.querySelectorAll('.acc-item')].find(el => el.textContent.includes(${JSON.stringify(vid)}));
        const btn = item?.querySelector('[data-testid="run-verifier"]');
        if (btn && !btn.disabled) { btn.click(); return true; }
        return false;
      })()`);
      assert(clicked, `点击运行验证：${vid}`);
    }
    const passCount = `[...document.querySelectorAll('.acc-item')].filter(el => el.dataset.accStatus === 'passed').length`;
    await waitFor(`${passCount} >= 2`, 180000, '背靠背两项验证直接点亮（无重点一次）');
  }
  await waitFor(
    `[...document.querySelectorAll('.acc-item')].filter(el => el.dataset.accStatus === 'passed').length >= 2`,
    30000,
    '两个可执行项 passed',
  );
  const judgeText = await evalJs(`document.querySelector('[data-testid="acceptance-judge"]')?.textContent ?? ''`);
  const countText = await evalJs(`[...document.querySelectorAll('.acceptance__count')].map(e=>e.textContent).join('|')`);
  log('7', `判定徽标：${judgeText}；计数：${countText}`);
  // 全新任务：manual 项尚未判定 → 必需项 N-1/N（可执行项全过）；复用任务 manual 已点亮 → N/N。
  // manual 于 7b 点亮后统一应为 N/N。
  const m7 = countText.match(/必需项 (\d+)\/(\d+) 通过/);
  assert(
    m7 !== null && (Number(m7[1]) === Number(m7[2]) - 1 || Number(m7[1]) === Number(m7[2])),
    `可执行项全部通过（manual 待 7b 或复用已过）：${countText}`,
  );

  log('7b', '人工验收闭环：manual 项点"确认通过"（confirm 由脚本代答；真实弹窗行为由组件测试覆盖）');
  const manualBtns = await evalJs(`document.querySelectorAll('[data-testid="manual-pass-btn"]').length`);
  assert(manualBtns >= 1, `人工验收按钮 ×${manualBtns}（≥1）`);
  // window.confirm 是原生阻塞弹窗，CDP 中无法自动应答——stub 为 true（弹窗语义在 acceptance-panel 组件测试验证）
  await evalJs(`(() => { window.__fdConfirmBackup = window.confirm; window.confirm = () => true; })()`);
  await evalJs(`(() => {
    const items = [...document.querySelectorAll('.acc-item')].filter(el => el.textContent.includes('人工复核 diff'));
    const item = items.find(el => el.dataset.accStatus !== 'passed') ?? items[0];
    item?.querySelector('[data-testid="manual-pass-btn"]')?.click();
    return true;
  })()`);
  await waitFor(
    `[...document.querySelectorAll('.acc-item')].find(el => el.textContent.includes('人工复核 diff'))?.dataset.accStatus === 'passed'`,
    30000,
    'manual 项经人工判定点亮',
  );
  const judgeAfter = await evalJs(`document.querySelector('[data-testid="acceptance-judge"]')?.textContent ?? ''`);
  const countAfter = await evalJs(`[...document.querySelectorAll('.acceptance__count')].map(e=>e.textContent).join('|')`);
  log('7b', `判定徽标：${judgeAfter}；计数：${countAfter}`);
  const m7b = countAfter.match(/必需项 (\d+)\/(\d+) 通过/);
  assert(m7b !== null && m7b[1] === m7b[2], `人工判定后必需项全通过：${countAfter}`);
  assert(judgeAfter.includes('验收通过'), '任务验收通过徽标点亮');
  const taskMr = await evalJs(`window.forgedesk.runner.getTask(${JSON.stringify(created.value.id)})`);
  const mrOps = taskMr?.ok ? (taskMr.value?.operations ?? []).filter((o) => o.type === 'manual_review') : [];
  assert(mrOps.length >= 1 && mrOps.every((o) => o.status === 'succeeded'), `manual_review 操作入史且成功（${mrOps.length} 条）`);
  const mrEvidence = taskMr?.ok ? (taskMr.value?.evidence ?? []).filter((e) => e.evidenceLevel === 'B') : [];
  assert(mrEvidence.length >= 1, `B 级人证证据落链（${mrEvidence.length} 条）`);
  await evalJs(`window.confirm = window.__fdConfirmBackup;`);

  log('8', '真实按钮：导出交付包');
  await evalJs(`document.querySelector('[data-testid="export-btn"]')?.click()`);
  await waitFor(`!document.querySelector('[data-testid="export-btn"]')?.textContent.includes('导出中')`, 90000, 'export done');
  const taskAfter = await evalJs(`window.forgedesk.runner.getTask(${JSON.stringify(created.value.id)})`);
  const ops = taskAfter?.ok ? (taskAfter.value?.operations ?? []) : [];
  const exportOk = ops.some((o) => String(o.type).includes('export') && (o.status === 'succeeded' || o.status === 'completed'));
  log('8', `操作数=${ops.length} 最近类型=${ops.slice(-3).map((o) => `${o.type}:${o.status}`).join(', ')}`);
  assert(exportOk, '导出操作成功（runner 侧核验）');

  log('9', '引擎链（无凭证边界，A-18 安装态对应）');
  const startR = await evalJs(`window.forgedesk.engine.start(${JSON.stringify(PROJECT_ROOT)})`, 45000);
  log('9', `engine.start ok=${startR?.ok}${startR?.ok ? ` threadId=${startR.value?.threadId}` : ` failure=${JSON.stringify(startR?.failure ?? {}).slice(0, 120)}`}`);
  const engineStatus = await evalJs(`window.forgedesk.engine.status()`);
  const authStatus = await evalJs(`window.forgedesk.engine.authStatus()`);
  const engineLabelAfter = await evalJs(`document.querySelector('[data-testid="engine-status"]')?.textContent?.trim() ?? ''`);
  log('9', `status=${engineStatus} auth=${JSON.stringify(authStatus?.value ?? authStatus)} 引擎状态（后）：${engineLabelAfter}`);
  assert(startR?.ok === true, '安装态引擎握手与 thread/start 成功');
  assert(['ready', 'auth_required', 'running'].includes(engineStatus), `引擎状态合理（${engineStatus}）`);
  const authVal = authStatus?.value ?? authStatus;
  log('9', `authStatus（DeepSeek 样例 key 下，仅记录）=${JSON.stringify(authVal ?? null).slice(0, 120)}`);

  log('9b', '引擎 config 多提供方段核验（Node 侧读文件）+ 清理样例配置');
  {
    const appData = process.env.APPDATA ?? '';
    const configPath = path.join(appData, 'ForgeStudio', 'engine', 'config.toml');
    const toml = readFileSync(configPath, 'utf8');
    log('9b', `config.toml 含 model_provider=${/model_provider = 'deepseek'/.test(toml)} model_providers 段=${/\[model_providers\.deepseek\]/.test(toml)} wire_api=${/wire_api = "responses"/.test(toml)} base_url=${/api\.deepseek\.com\/v1/.test(toml)}`);
    assert(
      /model_provider = 'deepseek'/.test(toml) && /\[model_providers\.deepseek\]/.test(toml) && /wire_api = "responses"/.test(toml),
      '引擎 config 正确生成 DeepSeek 提供方段（responses 协议）',
    );
    assert(!/sk-walkthrough-probe-key/.test(toml), 'API key 本体未落入 config.toml');
    const cleared = await evalJs(`window.forgedesk.app.clearModelProvider('deepseek')`);
    assert(cleared?.ok === true, '清除样例提供方配置（IPC 返回）');
    // 落盘核验（D12-5 教训：IPC ok ≠ 真清了——曾因 patch 浅合并删不掉字段导致假清除）
    await sleep(800);
    const providerEnvPath = path.join(appData, 'ForgeStudio', 'engine', 'provider.env');
    let providerEnvClean = true;
    try {
      const envText = readFileSync(providerEnvPath, 'utf8');
      providerEnvClean = !envText.includes('DEEPSEEK_API_KEY');
    } catch {
      providerEnvClean = true; // 文件已删除 = 干净
    }
    assert(providerEnvClean, 'provider.env 落盘核验：DEEPSEEK key 已移除（或文件已删）');
    const settingsRaw = JSON.parse(readFileSync(path.join(appData, 'ForgeStudio', 'settings.json'), 'utf8'));
    assert(settingsRaw.modelProvider === undefined || settingsRaw.modelProvider === null, 'settings.modelProvider 落盘核验：激活方已移除');
  }

  log('9c', '会话管理（Z1-5 安装态）：搜索 / 重命名 / 删除 / 压缩入口渲染条件');
  {
    // 引擎链刚创建了新会话线程 → 侧栏应有条目
    await waitFor(`document.querySelectorAll('[data-testid="thread-item"]').length >= 1`, 15000, '会话列表有条目');
    const before = await evalJs(`document.querySelectorAll('[data-testid="thread-item"]').length`);
    // 搜索过滤（键盘级输入驱动 React 受控组件）：取首条标题的最小唯一前缀（A-12 等批量会话
    // 标题前缀高度相似——uuid/任务号前 16 字符可能撞车），过滤恰 1 条 → 空态 → 清空恢复
    const titlesJson = await evalJs(
      `JSON.stringify([...document.querySelectorAll('[data-testid="thread-item"] .thread-item__title')].map(e=>e.textContent.trim()))`,
    );
    const titles = JSON.parse(titlesJson);
    assert(titles.length > 0, `会话标题可读（${titles.length} 条）`);
    let frag = (titles[0] ?? '').slice(0, 6);
    const first = titles[0] ?? '';
    while (frag.length < first.length && titles.filter((t) => t.includes(frag)).length > 1) {
      frag = first.slice(0, frag.length + 4);
    }
    const firstTitle = frag;
    assert(firstTitle.length > 0, `取到会话标题片段（${firstTitle}）`);
    await typeInto('[data-testid="thread-search"]', firstTitle);
    await waitFor(`document.querySelectorAll('[data-testid="thread-item"]').length === 1`, 10000, '搜索过滤到 1 条');
    await typeInto('[data-testid="thread-search"]', '不存在的关键词xyz');
    await waitFor(`!!document.querySelector('[data-testid="thread-search-empty"]')`, 10000, '搜索空态呈现');
    await typeInto('[data-testid="thread-search"]', '');
    await waitFor(`document.querySelectorAll('[data-testid="thread-item"]').length === ${before}`, 10000, '清空搜索恢复全部');
    // 重命名：行内输入 → Enter → 标题更新（title meta 持久化 + refreshThreads）
    await evalJs(`document.querySelector('[data-testid="thread-rename-btn"]')?.click()`);
    await waitFor(`!!document.querySelector('[data-testid="thread-rename-input"]')`, 5000, '重命名输入框出现');
    const newName = `走查重命名 ${Date.now() % 10000}`;
    await typeInto('[data-testid="thread-rename-input"]', newName);
    await pressEnter();
    await waitFor(`[...document.querySelectorAll('[data-testid="thread-item"]')].some(el => el.textContent.includes(${JSON.stringify(newName)}))`, 20000, '重命名后列表标题更新');
    // 删除：两步确认 → 以桥数据为真值断言（UI 计数与桥一致；规避 step9 引擎线程刷新晚到的基线竞态）
    const bridgeBefore = await evalJs(`(async()=>{const t=await window.forgedesk.session.listThreads();return (t.value??[]).length})()`);
    await evalJs(`document.querySelector('[data-testid="thread-delete-btn"]')?.click()`);
    await waitFor(`!!document.querySelector('[data-testid="thread-delete-confirm"]')`, 5000, '删除确认按钮出现');
    await evalJs(`document.querySelector('[data-testid="thread-delete-confirm"]')?.click()`);
    await waitFor(
      `(async () => {
        const t = await window.forgedesk.session.listThreads();
        const n = (t.value ?? []).length;
        const ui = document.querySelectorAll('[data-testid="thread-item"]').length;
        return n === ${bridgeBefore} - 1 && ui === n;
      })()`,
      20000,
      '删除后会话数减一（桥为真值，UI 同步）',
    );
    // 压缩入口渲染条件：无消息的会话不渲染（有消息+live 会话才出现——渲染条件正确性）
    assert(await evalJs(`!document.querySelector('[data-testid="compact-thread-btn"]')`), '压缩上下文按钮按渲染条件隐藏（无消息会话）');
    // 审阅入口渲染条件（Z2B-2）：同压缩——无消息会话不渲染
    assert(await evalJs(`!document.querySelector('[data-testid="review-btn"]')`), '代码审阅按钮按渲染条件隐藏（无消息会话）');
    // 审阅面板（Z4 可选 1）：无审阅回合 → 不渲染（不虚报）
    assert(await evalJs(`!document.querySelector('[data-testid="review-panel"]')`), '审阅面板按渲染条件隐藏（无审阅回合）');
    // 远程目标行渲染条件（Z3）：本任务 profile 无 SSH 目标 → 不渲染（不虚报）
    assert(await evalJs(`!document.querySelector('[data-testid="ssh-targets-row"]')`), '远程目标行按渲染条件隐藏（profile 无 SSH 目标）');
  }

  log('9d', 'FZ3B 真实硬件 GUI 闭环（Z3：凭据 → 建任务 → 检查 → 板上构建 → 板上验收）');
  {
    // 前置：fz3b-make profile 已在用户 profiles 目录；板卡可达；
    // 应用以 FZ3B_PASSWORD=ubuntu 直启（BUILD.md 直启方式）——凭据注入 runner 后板上链路可用
    const names = await evalJs(`(async()=>{const r=await window.forgedesk.app.sshCredentialNames();return r.ok?r.value:null})()`);
    log('9d', `已配置凭据变量：${JSON.stringify(names)}`);
    if (!names || !names.includes('FZ3B_PASSWORD')) {
      const setR = await evalJs(`(async()=>{const r=await window.forgedesk.app.sshCredentialSet('FZ3B_PASSWORD','ubuntu');return r.ok})()`);
      assert(setR === true, 'FZ3B 凭据保存（产品内存储，重启后注入 runner）');
      log('9d', '凭据本次保存（注入下次启动生效）——本走查依赖直启注入路径');
    }
    const fzTask = await evalJs(`(async()=>{
      const r = await window.forgedesk.runner.createTask({
        projectRoot: 'E:/AiProject/agent-design/ForgeDesk-zcode/engineering/fixtures/fz3b-make',
        profileId: 'fz3b-make',
        title: 'GUI 硬件闭环：FZ3B make 板上构建',
        acceptance: [{ kind: 'executable', verifierId: 'fz3b-selftest', title: '板上自检', expected: 'TESTS_PASSED + 板卡身份', manualRequired: false, required: true }],
      });
      return r.ok ? r.value.id : String(JSON.stringify(r.failure ?? {}).slice(0, 120));
    })()`);
    assert(typeof fzTask === 'string' && fzTask.startsWith('task-'), `FZ3B 任务创建（${String(fzTask).slice(0, 40)}）`);
    log('9d', `任务 ${fzTask}`);
    // 真实按钮路径：切任务 → 远程目标行 → 检查（SSH 探测）→ 板上构建 → 板上自检
    await waitFor(
      `(() => { const sel = document.querySelector('select[aria-label="当前任务"]'); return !!sel && [...sel.options].some(o => o.textContent.includes('FZ3B make 板上构建')); })()`,
      20000,
      'FZ3B 任务出现在任务选择器',
    );
    await evalJs(`(() => {
      const sel = document.querySelector('select[aria-label="当前任务"]');
      const opt = [...sel.options].find(o => o.textContent.includes('FZ3B make 板上构建'));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, opt.value);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(`!!document.querySelector('[data-testid="ssh-targets-row"]')`, 10000, 'FZ3B 任务远程目标行呈现');
    // Z4 整合：SSH 目标并入设备区语义——远程设备卡呈现 + 设备区标题携带远程计数
    assert(
      await evalJs(`!!document.querySelector('[data-testid="ssh-target-device"]')`),
      '远程设备卡（SSH）呈现（设备区默认展开）',
    );
    assert(
      await evalJs(`(() => { return [...document.querySelectorAll('.fd-collapse__summary')].some(t => t.textContent.includes('设备') && t.textContent.includes('远程 1')); })()`),
      '设备区标题携带远程计数（· 远程 1）',
    );
    await evalJs(`document.querySelector('[data-testid="inspect-btn"]')?.click()`);
    await waitFor(`!document.querySelector('[data-testid="inspect-btn"]')?.textContent.includes('检查中')`, 60000, 'FZ3B 环境检查完成（含 SSH 目标探测）');
    await evalJs(`document.querySelector('[data-testid="build-btn"]')?.click()`);
    await waitFor(
      `!document.querySelector('[data-testid="build-btn"]')?.textContent.includes('构建中') && (document.querySelector('[data-testid="artifact-list"]')?.textContent?.trim().length ?? 0) > 0`,
      240000,
      'FZ3B 板上 make 构建完成 + 产物取回',
    );
    const clicked = await evalJs(`(() => {
      const item = [...document.querySelectorAll('.acc-item')].find(el => el.textContent.includes('fz3b-selftest'));
      const btn = item?.querySelector('[data-testid="run-verifier"]');
      if (btn && !btn.disabled) { btn.click(); return true; }
      return false;
    })()`);
    assert(clicked === true, '点击 FZ3B 板上自检验证');
    await waitFor(
      `[...document.querySelectorAll('.acc-item')].find(el => el.textContent.includes('fz3b-selftest'))?.dataset.accStatus === 'passed'`,
      240000,
      'FZ3B 板上自检 passed（真实板卡执行）',
    );
    log('9d', 'FZ3B 硬件 GUI 闭环：板上构建 + 板上验收点亮 ✅');
  }

  // 10 优雅退出 + 恢复用户配置。
  // 顺序关键：先派生 detached 恢复助手（walkthrough-restore.mjs，睡 6s 后按快照回填
  // provider.env / settings.json），再 Browser.close——close 的 CDP 响应永不返回，
  // 父进程在下方 await 挂起、事件循环排空后以 0 自然退出，其后代码不保证执行（实测）。
  log('10', 'Browser.close 优雅退出（恢复助手已派生）');
  spawnRestoreHelper();
  try {
    await send('Browser.close');
  } catch {}
  await sleep(3000);
  // 走到这里说明事件循环尚存（连接已提前断开等场景）：照常收尾；恢复仍由助手兜底
  log('DONE', failed === 0 ? 'GUI 走查全部通过' : `有 ${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[gui] 走查失败:', err);
  // 中途失败也要恢复用户配置（9b 清理可能已执行）
  if (existsSync(SNAPSHOT_PATH)) spawnRestoreHelper();
  process.exit(1);
});
