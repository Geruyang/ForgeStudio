const PORT = process.argv[2] ?? '9227';
const EXPR = process.argv[3];
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
const r = await new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: EXPR, awaitPromise: true, returnByValue: true, timeout: 20000 } }));
});
if (r.exceptionDetails) console.log('EXC:', JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails).slice(0, 500));
else console.log(JSON.stringify(r.result.value, null, 2));
ws.close();
