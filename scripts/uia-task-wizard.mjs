/**
 * TaskWizard UIA 实操（安全版：应用内全 CDP，不向系统发送任何键盘/鼠标事件）。
 * 原生目录选择对话框经实测无法安全自动化（Windows 前台锁定下 SendKeys 可能误投其他窗口），
 * 该环节维持"留给人工"口径；本脚本覆盖向导的 acceptance 模式全流程（不依赖目录对话框）：
 *   打开"调整验收单" → 添加手动验收项（填标题/通过标准）→ 提交 → 验收单呈现 →
 *   人工判定"确认通过"（confirm 代答）→ 状态点亮 → B 级证据闭环（第二轮 UI 实证）。
 * 截图（release-final/ui-audit/）：05 向导 / 06 表单填写 / 07 提交后验收单 / 08 人工判定后。
 * 用法：node scripts/uia-task-wizard.mjs
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = process.env.FD_GUI_DEBUG_PORT ?? '9226';
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shotDir = path.join(repoRoot, 'apps', 'desktop', 'release-final', 'ui-audit');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const assert = (cond, msg) => {
  if (!cond) { failed++; throw new Error(msg); }
  console.log(`[uia] 断言 — ${msg}`);
};
const log = (step, detail) => console.log(`[uia] ${step}${detail ? ' — ' + detail : ''}`);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) throw new Error('无 CDP 页面目标');
const ws = new WebSocket(page.webSocketDebuggerUrl);
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
const evalJs = async (expression, timeoutMs = 20000) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs });
  if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails).slice(0, 300));
  return r.result.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(shotDir, `${name}.png`), Buffer.from(r.data, 'base64'));
  log('截图', `${name}.png`);
};
async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) { log('等待', `${label} ✓`); return; }
    await sleep(500);
  }
  throw new Error(`等待超时（${label}，${timeoutMs}ms）`);
}
const setInputValue = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  return true;
})()`;

await send('Page.enable');
await sleep(1000);

// 前置：确认有活动任务（走查任务）
const hasTask = await evalJs(`!!document.querySelector('.panel__task-name')`);
assert(hasTask, '工程面板有活动任务（前置）');

// A：打开"调整验收单"向导（acceptance 模式）
log('A', '打开「调整验收单」向导');
await evalJs(`[...document.querySelectorAll('button')].find(b => b.textContent.trim().includes('调整验收单'))?.click(); true`);
await waitFor(() => evalJs(`!!document.querySelector('[data-testid="wizard-template"]')`), 5000, '向导（acceptance 模式）打开');
await shot('05-wizard-acceptance');

// B：清空模板勾选（software 模板 verifier 不属于 sample-tool profile，全量提交会被 runner 校验拒绝）
//    + 添加手动验收项并填写（React 受控输入经原生 setter 派发）
log('B', '清空模板勾选；添加手动验收项：标题 + 通过标准');
await evalJs(`(() => { document.querySelectorAll('.template-item input[type=checkbox]').forEach(cb => { if (cb.checked) cb.click(); }); return true; })()`);
const added = await evalJs(`document.querySelector('[data-testid="wizard-add-manual"]')?.click(); true`);
assert(added, '点击「＋ 添加手动项」');
await waitFor(() => evalJs(`document.querySelectorAll('.template-item input[placeholder="标题（必填）"]').length === 1`), 4000, '手动项输入框出现');
assert(await evalJs(setInputValue('input[placeholder="标题（必填）"]', 'UIA 实操：界面走查项')), '填手动项标题');
assert(await evalJs(setInputValue('.template-item input[placeholder="通过标准"]', '界面经人工走查无阻碍')), '填通过标准');
await shot('06-wizard-manual-item');

// C：提交"更新验收单"
log('C', '提交「更新验收单」');
await evalJs(`document.querySelector('[data-testid="wizard-submit"]')?.click(); true`);
await waitFor(
  () => evalJs(`[...document.querySelectorAll('.acc-item__title')].some(e => e.textContent.includes('UIA 实操：界面走查项'))`),
  10000,
  '验收单出现新手动项',
);
await shot('07-acceptance-updated');
const newItemStatus = await evalJs(`(() => { const el = [...document.querySelectorAll('.acc-item')].find(e => e.textContent.includes('UIA 实操：界面走查项')); return el?.dataset.accStatus ?? null; })()`);
assert(newItemStatus === 'pending', `新项初始 pending（${newItemStatus}）——不被工具点亮`);

// D：人工判定"确认通过"（confirm 代答）→ 状态点亮
log('D', '人工验收「确认通过」（confirm 由脚本代答）');
await evalJs(`window.__fdC = window.confirm; window.confirm = () => true; (() => {
  const el = [...document.querySelectorAll('.acc-item')].find(e => e.textContent.includes('UIA 实操：界面走查项'));
  el?.querySelector('[data-testid="manual-pass-btn"]')?.click(); return true;
})()`);
await waitFor(
  () => evalJs(`(() => { const el = [...document.querySelectorAll('.acc-item')].find(e => e.textContent.includes('UIA 实操：界面走查项')); return el?.dataset.accStatus === 'passed'; })()`),
  15000,
  '人工判定点亮 passed',
);
await evalJs(`window.confirm = window.__fdC; true`);
await shot('08-manual-reviewed');

// E：runner 侧复核（操作 + B 级证据）
const verify = await evalJs(`(async () => {
  const tasks = (await window.forgedesk.runner.listTasks()).value;
  const t = tasks.find(x => x.title.includes('GUI 走查'));
  const full = await window.forgedesk.runner.getTask(t.id);
  const item = full.value.acceptance.find(a => a.title.includes('UIA 实操：界面走查项'));
  const mrOps = full.value.operations.filter(o => o.type === 'manual_review');
  const bEvidence = full.value.evidence.filter(e => e.evidenceLevel === 'B');
  return { itemStatus: item?.status, lastEvidenceId: item?.lastEvidenceId, mrOps: mrOps.length, bEvidence: bEvidence.length };
})()`);
const v = verify ?? {};
assert(v.itemStatus === 'passed', `runner 侧新项 passed（${v.itemStatus}）`);
assert(v.mrOps >= 2, `manual_review 操作 ≥2（走查项+UIA 项，实际 ${v.mrOps}）`);
assert(v.bEvidence >= 2, `B 级证据 ≥2（实际 ${v.bEvidence}）`);
assert(Boolean(v.lastEvidenceId), `lastEvidenceId 绑定（${v.lastEvidenceId}）`);

console.log(failed === 0 ? '\n[uia] 全部通过' : `\n[uia] 失败 ${failed} 项`);
ws.close();
process.exit(failed === 0 ? 0 : 1);
