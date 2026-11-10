const port = process.argv[2] ?? '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
let seq = 0; const pending = new Map();
const ws = await new Promise((res, rej) => { const w = new WebSocket(page.webSocketDebuggerUrl); w.addEventListener('open', () => res(w), { once: true }); w.addEventListener('error', rej, { once: true }); });
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
const send = (method, params = {}) => { const id = ++seq; return new Promise((res, rej) => { pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); }); };
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
await send('Runtime.enable');

// 清空并回到浏览态
await ev(`(async()=>{const q=document.getElementById('q');q.value='';q.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,900));})()`);
console.log('浏览态首条:', await ev(`document.querySelector('.book .t')?.textContent`));

// 输入检索词，分阶段观察列表何时更新
await ev(`(()=>{const q=document.getElementById('q');q.value='保定府志';q.dispatchEvent(new Event('input',{bubbles:true}));})()`);
for (const w of [100, 300, 600, 1200]) {
  await sleep(w);
  console.log(`  +${w}ms  summary="${await ev(`document.getElementById('summary').textContent`)}"  首条="${await ev(`document.querySelector('.book .t')?.textContent`)}"`);
}

// 现在点击首条
await ev(`document.querySelector('.book').click()`);
await sleep(900);
console.log('详情标题:', await ev(`document.querySelector('.detail h2')?.textContent`));
console.log('详情文件数:', await ev(`document.querySelectorAll('.detail .file').length`));
console.log('详情著录:', (await ev(`document.querySelector('.detail .meta')?.textContent`)).replace(/\s+/g, ' ').trim());
ws.close();
