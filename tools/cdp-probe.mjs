// 通过 CDP 驱动真实窗口，检查渲染结果。用法: node tools/cdp-probe.mjs [port]
// 账号/下载检查会写假 cookie 并清除，默认跳过；只在独立测试 profile 上显式开启：
//   FZ_CDP_ALLOW_COOKIE_MUTATION=1 node tools/cdp-probe.mjs
const port = process.argv[2] ?? '9333';
const allowCookieMutation = process.env.FZ_CDP_ALLOW_COOKIE_MUTATION === '1';
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
    // 允许直接传 JS 布尔值（waitFor 的返回值），不必再拼一条表达式
    const v = typeof expr === 'string' ? await evaluate(ws, expr) : expr;
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

/** 等表达式的结果连续两次一致：冷启动时列表可能分两拍渲染。 */
async function waitStable(expr, ms = 8000) {
  const t0 = Date.now();
  let last;
  let same = 0;
  for (;;) {
    const v = await evaluate(ws, expr);
    if (v === last) {
      if (++same >= 2) return true;
    } else {
      same = 0;
      last = v;
    }
    if (Date.now() - t0 > ms) return false;
    await sleep(80);
  }
}

/** 设置查询词并等列表真的刷新完。 */
async function typeQuery(q, expectSummary) {
  await evaluate(ws, `(()=>{const el=document.getElementById('q');el.value=${JSON.stringify(q)};el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  if (expectSummary) {
    // 冷启动那一下检索链路长，给足时间；超时要喊出来，别带着旧列表继续断言
    const ok = await waitFor(`/${expectSummary}/.test(document.getElementById('summary').textContent)`, 15000);
    if (!ok) console.log(`WAIT  摘要「${expectSummary}」在 15s 内未出现`);
  }
  await waitStable(`document.querySelector('.book .t')?.textContent ?? ''`);
  await sleep(150);
}

await sleep(1500);

// 上一轮探针可能把窗口留在别的查询/筛选状态，先恢复到「浏览全部」再断言。
// 清空输入会触发一次防抖检索，必须等它和启动时的首屏渲染都落地，否则后面的
// 断言会读到二次渲染前的旧列表。
await evaluate(ws, `(()=>{
  const q=document.getElementById('q'); q.value=''; q.dispatchEvent(new Event('input',{bubbles:true}));
  const strict=document.getElementById('strict'); strict.checked=false; strict.dispatchEvent(new Event('change',{bubbles:true}));
  const reset=document.getElementById('btn-reset'); if(!reset.classList.contains('hidden')) reset.click();
})()`);
await waitFor(`document.getElementById('summary').textContent.includes('浏览全部') && document.querySelectorAll('.book').length === 50 && document.getElementById('status-right').textContent.length > 0`, 20000);
// 冷启动时首屏 boot() 还要跑分面、下载队列、全文统计，链路比单次检索长；
// 留一段静置时间，否则后续断言会撞上首屏那次渲染。
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
await waitFor(`document.querySelector('.book .t')?.textContent === '保定府志'`, 15000);
await check('详情前列表已刷新', `document.querySelector('.book .t')?.textContent`, (v) => v === '保定府志');
await evaluate(ws, `document.querySelector('.book').click()`);
await waitFor(`/李振祜/.test(document.querySelector('.detail .meta')?.textContent ?? '')`, 15000);
await check('详情面板打开', `!document.getElementById('detail').classList.contains('hidden')`, (v) => v === true);
await check('详情标题', `document.querySelector('.detail h2')?.textContent`, (v) => v === '保定府志');
await check('详情著录信息', `document.querySelector('.detail .meta')?.textContent`, (v) => /李振祜/.test(v) && /光绪刻本/.test(v));
await check('详情文件列表', `document.querySelectorAll('.detail .file').length`, (v) => v === 31);
await check('夸克跳转按钮存在', `!!document.querySelector('#d-share')`, (v) => v === true);

// 多词检索与严格模式
await typeQuery('光绪 湖南通志', '湖南通志');
await check('多词检索首条', `document.querySelector('.book .t')?.textContent`, (v) => v === '湖南通志');
await check('多词检索朝代标注', `document.querySelector('.book .m')?.textContent`, (v) => /光绪/.test(v));
await evaluate(ws, `(()=>{const el=document.getElementById('strict');el.checked=true;el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
await waitFor(`/严格匹配/.test(document.getElementById('summary').textContent)`);
await check('严格全词模式生效', `document.getElementById('summary').textContent`, (v) => /严格匹配/.test(v));
await evaluate(ws, `(()=>{const el=document.getElementById('strict');el.checked=false;el.dispatchEvent(new Event('change',{bubbles:true}));})()`);

// 无结果
await typeQuery('量子力学导论');
await waitFor(`!!document.querySelector('.empty')`);
await check('无结果提示', `document.querySelector('.empty')?.textContent`, (v) => /没有匹配/.test(v));
await check('无结果时收起旧详情', `document.getElementById('detail').classList.contains('hidden')`, (v) => v === true);

// 全文识别入口已停用（识别率暂时不达标）：按钮不渲染，IPC 一律回「已停用」。
await check('全文识别入口已隐藏', `!!document.getElementById('btn-ocr')`, (v) => v === false);
await check('详情页识别按钮已隐藏', `!!document.getElementById('d-ocr')`, (v) => v === false);
await check('识别启动被拒', `window.fz.ocrRunnerStart({})`, (v) => v?.ok === false && /停用/.test(v.error ?? ''));
await check('识别状态标记停用', `window.fz.ocrRunnerStatus()`, (v) => v?.disabled === true);

// 全文检索与倒排索引一起冻结（本机 OCR 语料只有 60 页，见 FULLTEXT_ENABLED）：
// 工具菜单入口不渲染、状态接口回停用、重建被拒、OCR 文本接口当作「没有文本」。
// 恢复时把这段换回原来的面板断言（已注释保留在下面）。
await check('全文索引入口已隐藏', `!!document.getElementById('btn-textindex')`, (v) => v === false);
await check('全文索引状态标记停用', `window.fz.textIndexStatus()`, (v) => v?.disabled === true && v?.built === false);
await check('全文索引重建被拒', `window.fz.buildTextIndex()`, (v) => v?.disabled === true);
await check('OCR 文本接口标记停用', `window.fz.ocrInfo('x')`, (v) => v?.ok === false && /停用/.test(v.error ?? ''));
await check('状态栏不再报全文覆盖', `document.getElementById('status-right').textContent`, (v) => !/全文/.test(v));
// 原来的面板断言：恢复 FULLTEXT_ENABLED 后放回来
// await evaluate(ws, `document.getElementById('btn-textindex').click()`);
// await waitFor(`!!document.getElementById('ti-build')`);
// await check('全文索引面板已打开', `document.getElementById('modal-card').textContent`, (v) => /倒排索引/.test(v));
// await check('全文索引状态可见', `document.getElementById('ti-state').textContent`,
//   (v) => /已建/.test(v) || /还没有倒排索引/.test(v));
// await check('自动同步默认开启', `document.getElementById('ti-auto')?.checked`, (v) => v === true);
// if (process.env.FZ_CDP_BUILD_INDEX === '1') {
//   await evaluate(ws, `document.getElementById('ti-build').click()`);
//   await waitFor(`/完成：|失败|没有/.test(document.getElementById('ti-msg')?.textContent ?? '')`, 180000);
//   await check('全文索引重建完成', `document.getElementById('ti-msg')?.textContent`, (v) => /完成：/.test(v));
//   await evaluate(ws, `document.getElementById('ti-sync-now').click()`);
//   await waitFor(`/已经是最新|同步完成|失败/.test(document.getElementById('ti-msg')?.textContent ?? '')`, 60000);
//   await check('全量重建后增量同步判定无变化', `document.getElementById('ti-msg')?.textContent`, (v) => /已经是最新/.test(v));
// }
// await evaluate(ws, `document.getElementById('ti-close').click()`);
// await waitFor(`document.getElementById('modal').classList.contains('hidden')`);

// 书签与最近阅读面板
await evaluate(ws, `document.getElementById('btn-lib').click()`);
await waitFor(`!!document.getElementById('l-clear')`);
await check('书签面板两栏都在', `document.querySelectorAll('#modal-card h3').length`, (v) => v === 2);
await check('空态提示', `document.getElementById('modal-card').textContent`, (v) => /书签|阅读记录/.test(v));
await evaluate(ws, `document.getElementById('l-close').click()`);
await waitFor(`document.getElementById('modal').classList.contains('hidden')`);

// 真跑一本识别（默认关闭：慢，且会往真实数据目录写 OCR 结果）。
// 识别入口暂时停用（见 README「OCR」），这段检查一并停掉；原来的步骤留在注释里，
// 恢复识别（OCR_RECOGNITION_ENABLED = true + 放回 #btn-ocr）后再放出来。
if (process.env.FZ_CDP_RUN_OCR === '1') {
  console.log('SKIP  FZ_CDP_RUN_OCR 已忽略：全文识别入口暂时停用');
}
// if (process.env.FZ_CDP_RUN_OCR === '1') {
//   await evaluate(ws, `document.getElementById('btn-ocr').click()`);
//   await waitFor(`!!document.getElementById('x-start')`);
//   await evaluate(ws, `(()=>{document.getElementById('x-limit').value='1';document.getElementById('x-pages').value='1';})()`);
//   await evaluate(ws, `document.getElementById('x-start').click()`);
//   await waitFor(`/已完成|失败/.test(document.getElementById('x-line').textContent)`, 180000);
//   await check('内置识别跑完一本', `document.getElementById('x-line').textContent`, (v) => /已完成/.test(v));
//   await check('识别进度有页码反馈', `document.getElementById('x-log').textContent`, (v) => /page \d+\/\d+|没有待识别|已整本完成|-> ocr/.test(v));
//   await evaluate(ws, `document.getElementById('x-close').click()`);
//   await waitFor(`document.getElementById('modal').classList.contains('hidden')`);
// }

// 阅读器里的书签闭环：只有本地已下载的 PDF 能离线打开，读不到就跳过。
// 不写真实用户目录（书签落在 FZ_USER_DATA_DIR 指定的隔离目录里）。
if (process.env.FZ_CDP_SKIP_READER !== '1') {
  await typeQuery('序列目录', '直接命中');
  await waitFor(`/序列目录/.test(document.querySelector('.book .t')?.textContent ?? '')`, 10000);
  await evaluate(ws, `document.querySelector('.book')?.click()`);
  await waitFor(`!!document.querySelector('.detail .file .read')`);
  const hasLocal = await evaluate(ws, `!!document.querySelector('.detail .file .read')`);
  // pdf.js 只对 http(s) 发 Range，地址必须落在本机 http 服务上，不能退回自定义协议
  await check('阅读器地址走本机 http', `window.fz.readerResolve(document.querySelector('.detail .file .read')?.dataset.fid ?? '')`,
    (v) => /^http:\/\/127\.0\.0\.1:\d+\/read\?fid=[^&]+&t=[0-9a-f]{32}$/.test(v?.url ?? ''));
  if (hasLocal) {
    await evaluate(ws, `document.querySelector('.detail .file .read').click()`);
    await waitFor(`!document.getElementById('reader').classList.contains('hidden') && !!document.getElementById('r-mark')`, 20000);
    await sleep(1200);
    await check('阅读器画布已渲染', `!document.getElementById('r-canvas').classList.contains('hidden')`, (v) => v === true);
    await check('阅读器书签按钮初始未选中', `document.getElementById('r-mark').textContent`, (v) => /书签/.test(v) && !/已收藏/.test(v));
    await check('阅读器 OCR 文本按钮已隐藏', `!!document.getElementById('r-ocr')`, (v) => v === false);
    // 全文冻结后 ocrInfo 一律回「没有文本」，书内搜索框与 OCR 页数标注都不应出现
    await check('书内搜索框也隐藏', `document.getElementById('r-q').classList.contains('hidden')`, (v) => v === true);
    await check('阅读器不标 OCR 页数', `document.getElementById('r-mode').textContent`, (v) => !/OCR/.test(v));
    await evaluate(ws, `document.getElementById('r-mark').click()`);
    await waitFor(`/已收藏/.test(document.getElementById('r-mark').textContent)`, 8000);
    await check('点书签后变为已收藏', `document.getElementById('r-mark').textContent`, (v) => /已收藏/.test(v));

    // 面板里应出现这条书签，并且最近阅读已记一条
    await evaluate(ws, `document.getElementById('r-close').click()`);
    await sleep(300);
    await check('详情页下载按钮语义', `document.getElementById('d-dl')?.textContent`, (v) => /下载本书|更新本书/.test(v ?? ''));
    await check('文件条目下载按钮语义', `document.querySelector('.detail .file .dlone')?.textContent`, (v) => /^(下载|更新)$/.test(v ?? ''));
    if (await evaluate(ws, `document.querySelector('.detail .file .dlone')?.textContent === '更新'`)) {
      await evaluate(ws, `document.querySelector('.detail .file .dlone').click()`);
      await waitFor(`!!document.getElementById('u-ok')`, 8000);
      await check('更新前弹出确认', `document.getElementById('modal-card').textContent`,
        (v) => /确认更新/.test(v) && /覆盖/.test(v));
      const badgeBefore = await evaluate(ws, `document.getElementById('dl-badge')?.textContent ?? ''`);
      await evaluate(ws, `document.getElementById('u-cancel').click()`);
      await waitFor(`document.getElementById('modal').classList.contains('hidden')`);
      await check('取消更新不入队', `document.getElementById('dl-badge')?.textContent ?? ''`, (v) => v === badgeBefore);
      // 整本「更新本书」走的是另一条分支，同样要确认
      await evaluate(ws, `document.getElementById('d-dl').click()`);
      await waitFor(`!!document.getElementById('u-ok')`, 8000);
      await check('整本更新前弹出确认', `document.getElementById('modal-card').textContent`,
        (v) => /确认更新/.test(v) && /已在本地/.test(v));
      await evaluate(ws, `document.getElementById('u-cancel').click()`);
      await waitFor(`document.getElementById('modal').classList.contains('hidden')`);
    } else {
      console.log('SKIP  更新确认弹窗（这份文件不在本地）');
    }
    await evaluate(ws, `document.getElementById('btn-lib').click()`);
    await waitFor(`!!document.getElementById('l-clear')`);
    await check('书签已落库', `document.querySelectorAll('.librow[data-kind="mark"]').length`, (v) => v >= 1);
    await check('最近阅读已记录', `document.querySelectorAll('.librow[data-kind="recent"]').length`, (v) => v >= 1);

    // 从书签直接跳回原页
    await evaluate(ws, `document.querySelector('.librow[data-kind="mark"] .open').click()`);
    await waitFor(`!document.getElementById('reader').classList.contains('hidden')`, 15000);
    await sleep(1000);
    await check('从书签可跳回阅读器', `!document.getElementById('reader').classList.contains('hidden')`, (v) => v === true);
    await evaluate(ws, `document.getElementById('r-mark').click()`);
    await waitFor(`!/已收藏/.test(document.getElementById('r-mark').textContent)`, 8000);
    await check('再点一次取消收藏', `document.getElementById('r-mark').textContent`, (v) => !/已收藏/.test(v));
    await evaluate(ws, `document.getElementById('r-close').click()`);
  } else {
    console.log('SKIP  阅读器书签闭环（本地没有已下载的 PDF）');
  }
}

// 人工校正入口（只打开，不写数据）
await typeQuery('保定府志', '保定府志');
// 按书名精确点开，别依赖「第一条」——首屏刷新可能还在路上
await waitFor(`[...document.querySelectorAll('.book .t')].some((e) => e.textContent === '保定府志')`, 15000);
await check('详情前列表已刷新', `document.querySelector('.book .t')?.textContent`, (v) => v === '保定府志');
await evaluate(ws, `[...document.querySelectorAll('.book')].find((b) => b.querySelector('.t')?.textContent === '保定府志')?.click()`);
await waitFor(`document.querySelector('.detail h2')?.textContent === '保定府志'`, 10000);
await waitFor(`!!document.querySelector('#d-edit')`);
await evaluate(ws, `document.getElementById('d-edit').click()`);
await waitFor(`!!document.getElementById('o-title')`);
await check('书目校正表单', `document.querySelectorAll('.editgrid input').length`, (v) => v === 7);
await evaluate(ws, `document.getElementById('o-close').click()`);
await waitFor(`document.getElementById('modal').classList.contains('hidden')`);

// 更新索引弹层
await evaluate(ws, `(async () => { document.getElementById('btn-crawl').click(); await new Promise(r => setTimeout(r, 300)); })()`);
await check('爬取弹层出现', `!document.getElementById('crawlbar').classList.contains('hidden') && !!document.getElementById('c-url')`, (v) => v === true);
await check('爬取链接预填', `document.getElementById('c-url').value`, (v) => v === 'https://pan.quark.cn/s/2d5c2ddfe25b');
await evaluate(ws, `document.getElementById('c-close')?.click()`);

// 全库全文检索已冻结（FULLTEXT_ENABLED = false）：查询只走书目，正文块不再出现。
// 恢复后把下面注释掉的链路断言放回来（原来查的是只出现在 OCR 正文里的「成文出版社」）。
await typeQuery('成文出版社');
await sleep(800);
await check('全文命中块已隐藏', `document.getElementById('textlist').classList.contains('hidden')`, (v) => v === true);
await check('全文检索 IPC 回停用', `window.fz.searchText('成文出版社')`, (v) => v?.disabled === true && v?.total === 0);
await typeQuery('', '浏览全部');
await waitFor(`document.querySelectorAll('.book').length === 50`, 15000);
// await evaluate(ws, `(()=>{const b=document.getElementById('textlist');b.classList.add('hidden');b.innerHTML='';})()`);
// await typeQuery('成文出版社');
// const textHit = await waitFor(`/全文命中|全文没有命中/.test(document.getElementById('textlist').textContent)`, 25000);
// await check('全文检索返回结果块', textHit, (v) => v === true);
// await check('全文命中计数', `document.getElementById('textlist').textContent`, (v) => /全文命中\s*\d+\s*处/.test(v));
// await check('全文命中行可跳页', `document.querySelectorAll('#textlist .thit').length`, (v) => v >= 1);
// await check('全文检索未退化为同步模式', `document.getElementById('textlist').textContent`, (v) => !/兼容模式/.test(v));
// await typeQuery('', '浏览全部');
// await waitFor(`document.querySelectorAll('.book').length === 50`, 15000);

// 下载与账号：会写/清 cookie，默认不在真实用户目录执行
if (allowCookieMutation) {
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
  await waitFor(`/已保存|密钥服务不可用/.test(document.getElementById('k-msg').textContent)`);
  await check('cookie 保存走加密或明确拒绝', `document.getElementById('k-msg').textContent`, (v) => /已保存|密钥服务不可用/.test(v));
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
} else {
  console.log('SKIP  账号/下载写操作（未设置 FZ_CDP_ALLOW_COOKIE_MUTATION=1）');
}

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
