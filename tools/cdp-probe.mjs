// 通过 CDP 驱动真实窗口，检查渲染结果。用法: node tools/cdp-probe.mjs [port]
const port = process.argv[2] ?? '9333';
const base = `http://127.0.0.1:${port}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(base + '/json')).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error('找不到可调试的页面');
}

let seq = 0;
const pending = new Map();

function connect(url) {
  const ws = new WebSocket(url);
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
}

function send(ws, method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')); } }, 20000);
  });
}

async function evaluate(ws, expr) {
  const r = await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result.value;
}

const page = await getPage();
console.log('页面:', page.title, '|', page.url);
const ws = await connect(page.webSocketDebuggerUrl);
await send(ws, 'Runtime.enable');

const errors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
  }
});

const checks = [];
async function check(name, expr, assert) {
  try {
    const v = await evaluate(ws, expr);
    const ok = assert(v);
    checks.push({ name, ok, v });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  →  ${JSON.stringify(v)?.slice(0, 220)}`);
  } catch (e) {
    checks.push({ name, ok: false, v: e.message });
    console.log(`FAIL  ${name}  →  ${e.message}`);
  }
}

/** 轮询到条件成立，避免用固定 sleep 猜渲染时机。 */
async function waitFor(expr, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    if (await evaluate(ws, expr)) return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(80);
  }
}

/** 设置查询词并等列表真的刷新完。 */
async function typeQuery(q, expectSummary) {
  await evaluate(ws, `(()=>{const el=document.getElementById('q');el.value=${JSON.stringify(q)};el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await waitFor(expectSummary ? `/${expectSummary}/.test(document.getElementById('summary').textContent)` : 'true');
  await sleep(150);
}

await sleep(1500);

await check('窗口标题', 'document.title', (v) => v === '方志检索');
await check('副标题(分享名)', `document.getElementById('subtitle').textContent`, (v) => !!v && v !== '载入中…' && v !== '未找到索引');
await check('状态栏统计', `document.getElementById('status-right').textContent`, (v) => /4600/.test(v) && /3149/.test(v));
await check('省区分面已渲染', `document.querySelectorAll('.facets section[data-facet="province"] .chip').length`, (v) => v >= 10);
await check('志种分面已渲染', `document.querySelectorAll('.facets section[data-facet="zhiType"] .chip').length`, (v) => v >= 5);
await check('初始列表(浏览全部)', `document.querySelectorAll('.book').length`, (v) => v === 50);

// 检索
await typeQuery('吉水县志', '22');
await check('搜索"吉水县志"命中数', `document.getElementById('summary').textContent`, (v) => /22/.test(v));
await check('搜索"吉水县志"首条', `document.querySelector('.book .t')?.textContent`, (v) => v === '吉水县志');
await check('关键词高亮', `document.querySelectorAll('.book .t em').length`, (v) => v >= 1);
await check('模糊标记', `document.querySelectorAll('.tag.fuzzy').length`, (v) => v >= 1);

// 分面筛选
await typeQuery('');
await evaluate(ws, `(()=>{const chip=[...document.querySelectorAll('.facets section[data-facet="province"] .chip')].find(c=>c.dataset.v==='江西省');chip.click();})()`);
await waitFor(`/已筛选/.test(document.getElementById('summary').textContent)`);
await check('省区筛选生效', `document.getElementById('summary').textContent`, (v) => /已筛选/.test(v));
await check('筛选后条目数', `document.querySelectorAll('.book').length`, (v) => v > 0 && v <= 50);
await check('清除筛选按钮出现', `!document.getElementById('btn-reset').classList.contains('hidden')`, (v) => v === true);

await evaluate(ws, `document.getElementById('btn-reset').click()`);
await waitFor(`document.querySelectorAll('.book').length===50 && document.getElementById('btn-reset').classList.contains('hidden')`);
await check('清除筛选后恢复', `document.querySelectorAll('.book').length`, (v) => v === 50);

// 详情面板：先确认列表已经切到检索结果，再点首条
await typeQuery('保定府志', '保定府志');
await check('详情前列表已刷新', `document.querySelector('.book .t')?.textContent`, (v) => v === '保定府志');
await evaluate(ws, `document.querySelector('.book').click()`);
await waitFor(`/李振祜/.test(document.querySelector('.detail .meta')?.textContent ?? '')`);
await check('详情面板打开', `!document.getElementById('detail').classList.contains('hidden')`, (v) => v === true);
await check('详情标题', `document.querySelector('.detail h2')?.textContent`, (v) => v === '保定府志');
await check('详情著录信息', `document.querySelector('.detail .meta')?.textContent`, (v) => /李振祜/.test(v) && /光绪刻本/.test(v));
await check('详情文件列表', `document.querySelectorAll('.detail .file').length`, (v) => v === 31);
await check('夸克跳转按钮存在', `!!document.querySelector('#d-share')`, (v) => v === true);

// 多词检索
await typeQuery('光绪 湖南通志', '湖南通志');
await check('多词检索首条', `document.querySelector('.book .t')?.textContent`, (v) => v === '湖南通志');
await check('多词检索朝代标注', `document.querySelector('.book .m')?.textContent`, (v) => /光绪/.test(v));

// 无结果
await typeQuery('量子力学导论');
await waitFor(`!!document.querySelector('.empty')`);
await check('无结果提示', `document.querySelector('.empty')?.textContent`, (v) => /没有匹配/.test(v));

// 更新索引弹层
await evaluate(ws, `(async () => { document.getElementById('btn-crawl').click(); await new Promise(r => setTimeout(r, 300)); })()`);
await check('爬取弹层出现', `!document.getElementById('crawlbar').classList.contains('hidden') && !!document.getElementById('c-url')`, (v) => v === true);
await check('爬取链接预填', `document.getElementById('c-url').value`, (v) => v === 'https://pan.quark.cn/s/2d5c2ddfe25b');

// 下载与账号
await check('详情下载按钮存在', `!!document.querySelector('#d-dl')`, (v) => v === true);
await evaluate(ws, `document.querySelector('#d-dl').click()`);
await waitFor(`!document.getElementById('modal').classList.contains('hidden')`);
await check('无 cookie 时下载被拦到账号弹层', `document.getElementById('modal-card').textContent`, (v) => /先配置 cookie/.test(v));
await evaluate(ws, `document.getElementById('k-close').click()`);
await waitFor(`document.getElementById('modal').classList.contains('hidden')`);

await evaluate(ws, `document.getElementById('btn-cookie').click()`);
await waitFor(`!!document.getElementById('k-raw')`);
await check('账号弹层显示未配置', `document.getElementById('modal-card').textContent`, (v) => /未配置/.test(v));
await evaluate(ws, `(()=>{const t=document.getElementById('k-raw');t.value='garbage';document.getElementById('k-save').click();})()`);
await waitFor(`/格式不对/.test(document.getElementById('k-msg').textContent)`);
await check('非法 cookie 被拒', `document.getElementById('k-msg').textContent`, (v) => /格式不对/.test(v));
await evaluate(ws, `(()=>{const t=document.getElementById('k-raw');t.value='a=1; b=2';document.getElementById('k-save').click();})()`);
await waitFor(`/已保存/.test(document.getElementById('k-msg').textContent)`);
await check('cookie 保存(加密落盘)', `document.getElementById('k-msg').textContent`, (v) => /已保存/.test(v));
await evaluate(ws, `document.getElementById('k-test').click()`);
await waitFor(`document.getElementById('k-msg').textContent !== '测试中…'`, 15000);
await check('假 cookie 被测出失效', `document.getElementById('k-msg').textContent + '|' + document.getElementById('k-msg').className`, (v) => /失效|未登录|不完整|failed|失败/.test(v) && /err/.test(v));
await evaluate(ws, `document.getElementById('k-clear').click()`);
await waitFor(`/已清除/.test(document.getElementById('k-msg').textContent)`);
await check('cookie 清除', `document.getElementById('modal-card').textContent`, (v) => /已清除/.test(v));
await evaluate(ws, `document.getElementById('k-close').click()`);
await waitFor(`document.getElementById('modal').classList.contains('hidden')`);
await evaluate(ws, `document.getElementById('btn-cookie').click()`);
await waitFor(`!!document.getElementById('k-raw')`);
await check('清除后重开确未配置(加密文件已删)', `document.getElementById('modal-card').textContent`, (v) => /未配置/.test(v));
await evaluate(ws, `document.getElementById('k-close').click()`);
await waitFor(`document.getElementById('modal').classList.contains('hidden')`);

await evaluate(ws, `document.getElementById('btn-dl').click()`);
await waitFor(`!document.getElementById('dltray').classList.contains('hidden')`);
await check('下载托盘空态', `document.getElementById('dltray').textContent`, (v) => /队列为空/.test(v));
await evaluate(ws, `document.getElementById('t-close').click()`);
await check('下载托盘收起', `document.getElementById('dltray').classList.contains('hidden')`, (v) => v === true);

await sleep(300);
console.log('\n页面报错:', errors.length ? errors : '无');
const failed = checks.filter((c) => !c.ok);
console.log(`\n=== ${checks.length - failed.length}/${checks.length} 通过 ===`);
if (failed.length) { console.log('失败项:'); failed.forEach((f) => console.log(' -', f.name, JSON.stringify(f.v)?.slice(0, 160))); }

const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' }).catch(() => null);
if (shot?.data) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync('data/ui-check.png', Buffer.from(shot.data, 'base64'));
  console.log('截图 -> data/ui-check.png');
}

ws.close();
process.exit(failed.length || errors.length ? 1 : 0);
