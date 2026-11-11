import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import type { BookHit, BookOverride, BookOverrideFields, BookRecord, Facets, FileRecord, SearchResult, SearchFilters } from '@fangzhi/core';
import { formatSize } from '@fangzhi/core';

// worker 由 build.mjs 拷到 dist/renderer 下，和 index.html 同级。
pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs';

declare global {
  interface Window {
    fz: {
      info(): Promise<{ dataDir: string; hasIndex: boolean; meta?: { shareTitle: string; shareUrl?: string; author?: string }; stats?: { fileCount: number; bookCount: number; totalSize: number }; searchableBookCount?: number; crawledAt?: string }>;
      search(q: string, filters: SearchFilters, limit: number, offset: number): Promise<SearchResult>;
      book(id: string): Promise<{ book: BookRecord; files: FileRecord[]; override?: BookOverride } | undefined>;
      bookOverrideSet(id: string, patch: BookOverrideFields): Promise<{ ok: boolean; error?: string; applied?: number }>;
      facets(): Promise<Facets>;
      crawl(url: string, resume: boolean): Promise<{ ok: boolean; error?: string; aborted?: boolean; canResume?: boolean; diff?: { added: number; removed: number; changed: number } }>;
      cancelCrawl(): Promise<boolean>;
      pickDataDir(): Promise<{ ok: boolean; error?: string }>;
      openExternal(url: string): Promise<boolean>;
      cookieInfo(): Promise<{ has: boolean; names: string[]; bytes: number; encryptionAvailable: boolean }>;
      cookieSet(raw: string): Promise<{ ok: boolean; error?: string; has?: boolean; names?: string[]; bytes?: number; encryptionAvailable?: boolean }>;
      cookieClear(): Promise<{ has: boolean; names: string[]; bytes: number; encryptionAvailable: boolean }>;
      cookieTest(): Promise<{ ok: boolean; message: string }>;
      dlList(): Promise<DlState[]>;
      dlEnqueue(items: Array<{ fid: string; bookId: string; name: string; size: number; pdirFid: string; shareFidToken: string }>): Promise<DlState[]>;
      dlCancel(fid?: string): Promise<DlState[]>;
      dlRetry(fid: string): Promise<DlState[]>;
      dlInfo(): Promise<{ dir: string }>;
      dlDir(): Promise<{ ok: boolean; dir: string }>;
      showInFolder(p: string): Promise<boolean>;
      readerResolve(fid: string): Promise<{ ok: boolean; mode?: 'local' | 'online'; size?: number; url?: string; needCookie?: boolean; error?: string }>;
      dlLocal(fids: string[]): Promise<string[]>;
      ocrInfo(fid: string): Promise<{ ok: boolean; pages?: number; done?: boolean; error?: string }>;
      ocrPage(fid: string, p: number, q?: string): Promise<{ p: number; dpi: number; w: number; h: number; text: string; marks?: Array<[number, number]>; lines: Array<{ t: string; b: number[]; s: number }> } | null>;
      ocrSearch(fid: string, q: string): Promise<{ hits: Array<{ p: number; n: number }>; total: number }>;
      searchText(q: string): Promise<{
        total: number;
        books: Array<{ bookId: string; title: string; count: number; files: Array<{ fid: string; name: string; count: number; pages: Array<{ p: number; n: number }>; snippet: string; marks: Array<[number, number]> }> }>;
        canceled?: boolean;
        degraded?: boolean;
      }>;
      onTextProgress(cb: (p: { scanned: number; total: number; q: string }) => void): () => void;
      ocrSummary(): Promise<{ totalFiles: number; textFiles: number; doneFiles: number; doneBooks: number; totalBooks: number }>;
      openOcrFolder(): Promise<{ ok: boolean; dir?: string; error?: string }>;
      ocrRunnerStatus(): Promise<{ job: OcrJobState; runtime: { runtime: string; label: string; note: string } }>;
      ocrRunnerStart(opts: { limit?: number; maxPages?: number; force?: boolean; fids?: string[] }): Promise<{ ok: boolean; error?: string }>;
      ocrRunnerCancel(): Promise<{ ok: boolean; error?: string }>;
      onOcrProgress(cb: (p: OcrJobState) => void): () => void;
      onOcrDone(cb: (p: { ok: boolean; note?: string }) => void): () => void;
      marksList(): Promise<LibraryFile>;
      markToggle(fid: string, page: number): Promise<{ ok: boolean; added: boolean; marks: BookmarkRecord[] }>;
      markRemove(id: string): Promise<BookmarkRecord[]>;
      recentTouch(fid: string, page: number): Promise<RecentRecord[]>;
      recentList(): Promise<RecentRecord[]>;
      recentClear(): Promise<RecentRecord[]>;
      onCrawlProgress(cb: (p: { dirsDone: number; dirsPending: number; files: number; reqCount: number; currentPath: string }) => void): () => void;
      onDlProgress(cb: (p: DlState) => void): () => void;
    };
  }
}

interface DlState {
  fid: string;
  name: string;
  size: number;
  bytes: number;
  status: 'queued' | 'linking' | 'downloading' | 'done' | 'error' | 'canceled';
  error?: string;
  dest?: string;
}

/** 和 main/ocr-runner.ts 的 OcrJobState 对应。 */
interface OcrJobState {
  status: 'idle' | 'running' | 'done' | 'error' | 'canceled';
  runtime: string;
  fileIndex: number;
  fileTotal: number;
  currentName: string;
  page: number;
  pageTotal: number;
  doneFiles: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  log: string[];
}

/** 和 main/library.ts 对应。 */
interface BookmarkRecord {
  id: string;
  fid: string;
  bookId: string;
  title: string;
  fileName: string;
  page: number;
  createdAt: string;
}

interface RecentRecord {
  fid: string;
  bookId: string;
  title: string;
  fileName: string;
  page: number;
  at: string;
}

interface LibraryFile {
  version: 1;
  marks: BookmarkRecord[];
  recent: RecentRecord[];
}

const PAGE = 50;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const state = {
  q: '',
  filters: { provinces: [], eras: [], zhiTypes: [], exts: [], allTermsOnly: false } as SearchFilters & { provinces: string[]; eras: string[]; zhiTypes: string[]; exts: string[]; allTermsOnly: boolean },
  offset: 0,
  selected: '',
  crawling: false,
  shareUrl: '',
  ocrTotalFiles: 0,
  ocrTextFiles: 0,
  ocrDoneFiles: 0,
};

/** 文件名来自网盘，是不可信输入，插值前必须转义。 */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
/** 转义后把查询词标出来。 */
function hl(s: string, q: string): string {
  const e = esc(s);
  const terms = q.trim().split(/\s+/).filter((t) => t.length >= 2);
  if (!terms.length) return e;
  const re = new RegExp('(' + terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
  return e.replace(re, '<em>$1</em>');
}

function chipHtml(value: string, count: number, on: boolean): string {
  return `<span class="chip${on ? ' on' : ''}" data-v="${esc(value)}">${esc(value)}<b>${count}</b></span>`;
}

function renderFacets(f: Facets): void {
  const spec: Array<[string, keyof Facets, number]> = [
    ['province', 'province', 40],
    ['era', 'era', 30],
    ['zhiType', 'zhiType', 30],
    ['ext', 'ext', 12],
  ];
  const keyOf = (k: string): string[] => {
    if (k === 'province') return state.filters.provinces;
    if (k === 'era') return state.filters.eras;
    if (k === 'zhiType') return state.filters.zhiTypes;
    return state.filters.exts;
  };
  for (const [name, field, max] of spec) {
    const box = document.querySelector<HTMLElement>(`.facets section[data-facet="${name}"] .chips`)!;
    const entries = Object.entries(f[field]).sort((a, b) => b[1] - a[1]).slice(0, max);
    const on = new Set(keyOf(name));
    box.innerHTML = entries.map(([v, c]) => chipHtml(v, c, on.has(v))).join('');
    box.onclick = (ev) => {
      const el = (ev.target as HTMLElement).closest('.chip') as HTMLElement | null;
      if (!el) return;
      const v = el.dataset.v!;
      const arr = keyOf(name);
      const i = arr.indexOf(v);
      if (i >= 0) arr.splice(i, 1); else arr.push(v);
      el.classList.toggle('on');
      $('btn-reset').classList.toggle('hidden', !hasFilters());
      state.offset = 0;
      clearSelection();
      run();
    };
  }
}

function hasFilters(): boolean {
  const f = state.filters;
  return !!(f.provinces?.length || f.eras?.length || f.zhiTypes?.length || f.exts?.length);
}

function clearSelection(): void {
  state.selected = '';
  $('detail').classList.add('hidden');
  $('detail').innerHTML = '';
}

function bookMeta(b: BookRecord): string[] {
  const out: string[] = [];
  if (b.era) out.push(b.era);
  if (b.province) out.push(b.province);
  if (b.place && b.place !== b.title) out.push(b.place);
  if (b.zhiType) out.push(b.zhiType);
  if (b.author) out.push(b.author);
  if (b.edition) out.push(b.edition);
  out.push(`${b.fileCount} 册`);
  out.push(formatSize(b.totalSize));
  if (b.ocrDone) out.push(`已识别 ${b.ocrDone}`);
  if (b.verified) out.push('已校正');
  else if (b.confidence < 0.4) out.push('待核对');
  return out;
}

function renderResults(r: SearchResult): void {
  const list = $('list');
  if (!r.items.length) {
    list.innerHTML = `<div class="empty">没有匹配的书。<br>试试只输地名（如「莆田」），或清掉左侧筛选。</div>`;
    $('summary').innerHTML = '';
    $('pager').innerHTML = '';
    clearSelection();
    return;
  }

  const weakNote = r.weakTotal > 0
    ? ` · 另有 ${r.weakTotal} 条部分/近似${r.weakShown < r.weakTotal ? `（保留 ${r.weakShown} 条）` : ''}`
    : '';
  const mainCount = r.directTotal > 0
    ? `直接命中 <b>${r.directTotal}</b> 部书`
    : `部分/近似命中 <b>${r.total}</b> 部书`;
  $('summary').innerHTML =
    `${mainCount}${r.available < r.total ? ` · 可浏览 ${r.available} 部` : ''} · ${r.elapsedMs}ms` +
    (state.q ? ` · 查询「${esc(state.q)}」` : ' · 浏览全部') +
    (state.filters.allTermsOnly ? ' · 全部词严格匹配' : '') +
    (hasFilters() ? ' · 已筛选' : '') + weakNote;

  list.innerHTML = r.items.map((h: BookHit) => {
    const b = h.book;
    const quality = h.match === 'partial' || h.match === 'fuzzy' ? ' fuzzy' : '';
    return `<div class="book${b.id === state.selected ? ' on' : ''}" data-id="${b.id}">
      <div class="t">${hl(b.title, state.q)}</div>
      <div class="m">${bookMeta(b).map((x) => `<span>${esc(x)}</span>`).join('')}
        <span>${h.matched.map((m) => `<i class="tag${quality}">${esc(m)}</i>`).join(' ')}</span>
      </div>
    </div>`;
  }).join('');

  list.onclick = (ev) => {
    const el = (ev.target as HTMLElement).closest('.book') as HTMLElement | null;
    if (el) selectBook(el.dataset.id!);
  };

  const pages = Math.ceil(r.available / PAGE);
  const cur = Math.floor(state.offset / PAGE) + 1;
  $('pager').innerHTML = pages > 1
    ? `<button id="prev"${cur <= 1 ? ' disabled' : ''}>上一页</button>
       <span class="tag">${cur} / ${pages}</span>
       <button id="next"${cur >= pages ? ' disabled' : ''}>下一页</button>`
    : '';
  const prev = $('pager').querySelector<HTMLButtonElement>('#prev');
  const next = $('pager').querySelector<HTMLButtonElement>('#next');
  if (prev) prev.onclick = () => { state.offset = Math.max(0, state.offset - PAGE); run(); };
  if (next) next.onclick = () => { state.offset += PAGE; run(); };
}

async function selectBook(id: string): Promise<void> {
  state.selected = id;
  document.querySelectorAll('.book').forEach((el) => el.classList.toggle('on', (el as HTMLElement).dataset.id === id));
  const panel = $('detail');
  panel.classList.remove('hidden');
  panel.innerHTML = '<div class="empty">载入中…</div>';

  const d = await window.fz.book(id);
  if (state.selected !== id) return;
  if (!d) { panel.innerHTML = '<div class="empty">找不到这本书</div>'; return; }
  const b = d.book;

  panel.innerHTML = `
    <h2>${hl(b.title, state.q)}</h2>
    <div class="meta">
      ${b.era ? `<div>朝代 <b>${esc(b.era)}</b></div>` : ''}
      ${b.place ? `<div>地名 <b>${esc(b.place)}</b></div>` : ''}
      ${b.zhiType ? `<div>志种 <b>${esc(b.zhiType)}</b></div>` : ''}
      ${b.province ? `<div>省区 <b>${esc(b.province)}</b></div>` : ''}
      ${b.author ? `<div>著录 <b>${esc(b.author)}</b></div>` : ''}
      ${b.edition ? `<div>版本 <b>${esc(b.edition)}</b></div>` : ''}
      ${b.catalogRaw ? `<div>原串 <b>${esc(b.catalogRaw)}</b></div>` : ''}
      <div>置信度 <b>${b.confidence.toFixed(2)}</b> · ${b.fileCount} 册 · ${formatSize(b.totalSize)}
        ${b.verified ? '<i class="tag ok">已人工校正</i>' : b.confidence < 0.4 ? '<i class="tag fuzzy">待核对</i>' : ''}</div>
    </div>
    <div class="acts">
      <button id="d-share" class="primary">在夸克打开分享页</button>
      <button id="d-dl">下载本书</button>
      <button id="d-ocr" class="ghost" disabled title="只识别已下载到本地的 PDF">识别本书</button>
      <button id="d-edit" class="ghost">校正书目</button>
    </div>
    <h3>文件</h3>
    ${d.files.map((f) => `<div class="file">
      ${f.ext === 'pdf' && !f.isArchivePart ? `<button class="read" data-fid="${esc(f.fid)}">阅读</button>` : ''}
      ${!f.isNoise && !f.isArchivePart ? `<button class="dlone ghost" data-fid="${esc(f.fid)}">下载</button>` : ''}
      <span class="s">${formatSize(f.size)}</span>${hl(f.name, state.q)}
      ${f.volume ? ` <i class="tag">${esc(f.volume)}</i>` : ''}
      ${f.section ? ` <i class="tag">${esc(f.section)}</i>` : ''}
      ${f.isArchivePart ? ' <i class="tag fuzzy">分卷</i>' : ''}
    </div>`).join('')}
  `;
  const btn = panel.querySelector<HTMLButtonElement>('#d-share');
  if (btn && state.shareUrl) btn.onclick = () => window.fz.openExternal(state.shareUrl);
  else if (btn) btn.remove();
  const dlBtn = panel.querySelector<HTMLButtonElement>('#d-dl');
  if (dlBtn) {
    dlBtn.onclick = () => void enqueueBook(d.files);
    // 这本书已有文件在本地时，按钮语义变成「更新」——重新下载会覆盖旧文件。
    void window.fz.dlLocal(d.files.map((f) => f.fid)).then((local) => {
      if (state.selected !== id) return;
      if (local.length) dlBtn.textContent = '更新本书';
    });
  }
  const editBtn = panel.querySelector<HTMLButtonElement>('#d-edit');
  if (editBtn) editBtn.onclick = () => overrideModal(b, d.override);
  const ocrBtn = panel.querySelector<HTMLButtonElement>('#d-ocr');
  void window.fz.dlLocal(d.files.map((f) => f.fid)).then((local) => {
    if (state.selected !== id || !ocrBtn) return;
    // 只有 PDF 能识别；分卷文件本身不是完整文档，跳过。
    const localPdf = d.files
      .filter((f) => f.ext === 'pdf' && !f.isArchivePart && local.includes(f.fid))
      .map((f) => f.fid);
    if (!localPdf.length) return;
    ocrBtn.disabled = false;
    ocrBtn.title = `识别这本书在本地的 ${localPdf.length} 个 PDF`;
    ocrBtn.onclick = () => void ocrBook(localPdf);
  });
  panel.querySelectorAll<HTMLButtonElement>('.file .read').forEach((el) => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const fid = el.dataset.fid!;
      const rec = d.files.find((x) => x.fid === fid);
      void openReader(fid, rec?.name ?? '');
    });
  });
  panel.querySelectorAll<HTMLButtonElement>('.file .dlone').forEach((el) => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const rec = d.files.find((x) => x.fid === el.dataset.fid);
      if (rec) void enqueueBook([rec]);
    });
  });
}

/**
 * 请求序号。IPC 是异步的，清筛选触发的浏览渲染可能比后发的检索渲染晚回来，
 * 不丢弃过期结果就会把新查询的列表覆盖掉。
 */
let runSeq = 0;

async function run(): Promise<void> {
  const mine = ++runSeq;
  const r = await window.fz.search(state.q, state.filters, PAGE, state.offset);
  if (mine !== runSeq) return;
  renderResults(r);
  void renderTextHits(state.q, mine);
}

let textRunSeq = 0;
/** 主进程 worker 推来的扫描进度，用于「检索中」占位文案。 */
let textProgress: { scanned: number; total: number; q: string } | null = null;

/** 全库全文命中：单独一块展示，避免正文命中被书名结果淹掉。 */
async function renderTextHits(q: string, mine: number): Promise<void> {
  const box = $('textlist');
  const token = ++textRunSeq;
  if (q.trim().length < 2) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  // 先占位：全库扫描要读上千个 jsonl，不能一直挂着上一次的命中列表
  box.innerHTML = `<div class="thead">全文检索中…</div><div class="thint" id="tprog">正在读取本机 OCR 文本</div>`;
  box.classList.remove('hidden');
  const tick = setInterval(() => {
    const el = box.querySelector('#tprog');
    if (!el) { clearInterval(tick); return; }
    if (textProgress && textProgress.q === q.trim() && textProgress.total) {
      el.textContent = `已扫描 ${textProgress.scanned}/${textProgress.total} 个文件 · 首次较慢，之后走缓存`;
    }
  }, 200);

  const r = await window.fz.searchText(q);
  clearInterval(tick);
  if (token !== textRunSeq || mine !== runSeq) return;
  if (r.canceled) return;
  if (!r.books.length) {
    const coverage = state.ocrTextFiles
      ? `当前全文库覆盖 ${state.ocrTextFiles}/${state.ocrTotalFiles} 个文件，未命中不代表原书没有该内容。`
      : '当前还没有任何 OCR 全文数据，全文检索不可用；书名检索不受影响。';
    box.innerHTML = `<div class="thead">全文没有命中</div><div class="thint">${esc(coverage)}</div>`;
    box.classList.remove('hidden');
    return;
  }
  const slow = r.degraded ? '<div class="thint">检索线程不可用，本次走兼容模式（主进程同步扫描）。</div>' : '';
  box.innerHTML = `
    <div class="thead">全文命中 ${r.total} 处 · ${r.books.length} 部书</div>
    ${slow}
    ${r.books.map((b) => `
      <div class="tbook">
        <div class="tb-title">${esc(b.title)}<span class="tag">${b.count} 处</span></div>
        ${b.files.map((f) => f.pages.map((p, i) => `
          <div class="thit" data-fid="${esc(f.fid)}" data-page="${p.p}" data-name="${esc(f.name)}">
            <span class="tpage">第 ${p.p} 页${p.n > 1 ? `（${p.n} 处）` : ''}</span>
            ${i === 0 && f.snippet ? `<span class="tsnip">${paintRanges(f.snippet, f.marks ?? [])}</span>` : ''}
          </div>`).join('')).join('')}
      </div>`).join('')}`;
  box.classList.remove('hidden');
  box.onclick = (ev) => {
    const el = (ev.target as HTMLElement).closest('.thit') as HTMLElement | null;
    if (el) void openReader(el.dataset.fid!, el.dataset.name!, { page: Number(el.dataset.page), q });
  };
}

let timer: ReturnType<typeof setTimeout> | undefined;
function scheduleRun(): void {
  clearTimeout(timer);
  clearSelection();
  timer = setTimeout(() => { state.offset = 0; run(); }, 160);
}

/* ---------- 更新索引 ---------- */
const CRAWL_FORM = `
  <span>分享链接</span>
  <input id="c-url" style="flex:1;padding:5px 8px;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--fg)"
         value="https://pan.quark.cn/s/2d5c2ddfe25b" spellcheck="false" />
  <label style="display:flex;align-items:center;gap:4px;font-size:12px">
    <input id="c-resume" type="checkbox" /> 续爬
  </label>
  <button id="c-go" class="primary">开始</button>
  <button id="c-close" class="ghost">关闭</button>`;

const CRAWL_PROGRESS = `
  <span id="c-pct">爬取中 0%</span>
  <span class="bar"><i id="c-fill"></i></span>
  <span id="c-path" style="font-size:11px;opacity:.75;max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
  <button id="c-cancel" class="ghost">取消</button>`;

function crawlModal(): void {
  const bar = $('crawlbar');
  bar.classList.remove('hidden');
  bar.innerHTML = CRAWL_FORM;

  const url = bar.querySelector<HTMLInputElement>('#c-url')!;
  bar.querySelector('#c-close')!.addEventListener('click', () => { if (!state.crawling) bar.classList.add('hidden'); });

  bar.querySelector('#c-go')!.addEventListener('click', async () => {
    const target = url.value.trim();
    const resume = bar.querySelector<HTMLInputElement>('#c-resume')!.checked;
    state.crawling = true;
    bar.innerHTML = CRAWL_PROGRESS;
    bar.querySelector('#c-cancel')!.addEventListener('click', () => window.fz.cancelCrawl());

    const res = await window.fz.crawl(target, resume);
    state.crawling = false;

    if (res.ok) {
      const d = res.diff;
      bar.innerHTML = `<span style="color:var(--ok)">索引已更新${d ? `：新增 ${d.added}，删除 ${d.removed}，变更 ${d.changed}` : ''}</span>
        <button id="c-close" class="ghost">关闭</button>`;
      bar.querySelector('#c-close')!.addEventListener('click', () => bar.classList.add('hidden'));
      await boot();
    } else {
      bar.innerHTML = `<span style="color:var(--err)">${esc(res.error ?? '失败')}${res.canResume ? '（勾选续爬可接着跑）' : ''}</span>
        <button id="c-retry" class="ghost">重试</button>
        <button id="c-close" class="ghost">关闭</button>`;
      bar.querySelector('#c-close')!.addEventListener('click', () => bar.classList.add('hidden'));
      bar.querySelector('#c-retry')!.addEventListener('click', crawlModal);
    }
  });
}

/* ---------- 账号 cookie ---------- */
function openModal(html: string): HTMLElement {
  $('modal').classList.remove('hidden');
  const card = $('modal-card');
  card.innerHTML = html;
  return card;
}
function closeModal(): void {
  $('modal').classList.add('hidden');
  $('modal-card').innerHTML = '';
}

async function cookieModal(hint = ''): Promise<void> {
  const info = await window.fz.cookieInfo();
  const canSave = info.encryptionAvailable;
  const card = openModal(`
    <h2>夸克账号 cookie</h2>
    <p>下载要走你自己的登录态：浏览器登录 pan.quark.cn，F12 → Network 里随便点一个 drive-pc.quark.cn 的请求，复制请求头里的 Cookie 整串粘进来。</p>
    <p>cookie 只在系统密钥服务可用时加密保存在本机，不上传、也不进索引目录。${canSave ? '' : '<strong>当前系统密钥服务不可用，出于安全考虑不会保存明文 cookie。</strong>'}</p>
    <div class="row"><span class="msg ${info.has ? 'ok' : canSave ? '' : 'err'}">${info.has ? `已配置 ${info.bytes} 字符：${esc(info.names.join(' '))}` : canSave ? '未配置' : '未配置 · 系统密钥服务不可用'}</span></div>
    <textarea id="k-raw" spellcheck="false" placeholder="__puus=...; __pus=...; __pugs=..."></textarea>
    <div class="row">
      <button id="k-save" class="primary"${canSave ? '' : ' disabled'}>保存</button>
      <button id="k-test" class="ghost">测试登录</button>
      <button id="k-clear" class="ghost">清除</button>
      <button id="k-close" class="ghost">关闭</button>
      <span id="k-msg" class="msg ${hint ? 'err' : ''}">${esc(hint)}</span>
    </div>`);
  const msg = card.querySelector<HTMLSpanElement>('#k-msg')!;
  card.querySelector('#k-save')!.addEventListener('click', async () => {
    const raw = card.querySelector<HTMLTextAreaElement>('#k-raw')!.value;
    const r = await window.fz.cookieSet(raw);
    msg.className = 'msg ' + (r.ok ? 'ok' : 'err');
    msg.textContent = r.ok ? '已保存' : (r.error ?? '保存失败');
  });
  card.querySelector('#k-test')!.addEventListener('click', async () => {
    msg.className = 'msg';
    msg.textContent = '测试中…';
    const r = await window.fz.cookieTest();
    msg.className = 'msg ' + (r.ok ? 'ok' : 'err');
    msg.textContent = r.message;
  });
  card.querySelector('#k-clear')!.addEventListener('click', async () => {
    await window.fz.cookieClear();
    msg.className = 'msg';
    msg.textContent = '已清除';
  });
  card.querySelector('#k-close')!.addEventListener('click', closeModal);
}

/* ---------- 书目人工校正 ---------- */
function overrideModal(book: BookRecord, override?: BookOverride): void {
  const current = { ...book, ...(override ?? {}) };
  const field = (key: keyof BookOverrideFields, label: string): string => `
    <label><span>${label}</span><input id="o-${key}" value="${esc(String(current[key] ?? ''))}" autocomplete="off" spellcheck="false" /></label>`;
  const card = openModal(`
    <h2>校正书目</h2>
    <p>校正只保存在本机，不修改原始索引；爬取更新后仍会按书目成员文件重新应用。留空表示清除该字段。</p>
    <div class="editgrid">
      ${field('title', '书名主干')}
      ${field('era', '朝代 / 年号')}
      ${field('place', '地名')}
      ${field('zhiType', '志种')}
      ${field('province', '省区')}
      ${field('author', '著录 / 作者')}
      ${field('edition', '版本')}
    </div>
    <div class="row">
      <button id="o-save" class="primary">保存校正</button>
      <button id="o-close" class="ghost">取消</button>
      <span id="o-msg" class="msg"></span>
    </div>`);
  const msg = card.querySelector<HTMLSpanElement>('#o-msg')!;
  card.querySelector('#o-close')!.addEventListener('click', closeModal);
  card.querySelector('#o-save')!.addEventListener('click', async () => {
    const keys: Array<keyof BookOverrideFields> = [
      'title', 'era', 'place', 'zhiType', 'province', 'author', 'edition',
    ];
    const patch: BookOverrideFields = {};
    for (const key of keys) {
      const value = card.querySelector<HTMLInputElement>(`#o-${key}`)!.value.trim();
      const original = String(book[key] ?? '').trim();
      // 只保存真正改过的字段，避免把未改动的人工结果锁死，挡住后续解析规则升级。
      if (value !== original) patch[key] = value;
    }
    msg.className = 'msg';
    msg.textContent = '保存中…';
    const r = await window.fz.bookOverrideSet(book.id, patch);
    if (!r.ok) {
      msg.className = 'msg err';
      msg.textContent = r.error ?? '保存失败';
      return;
    }
    closeModal();
    await run();
    await selectBook(book.id);
  });
}

/* ---------- 全文识别 ---------- */
/** OCR 任务进度百分比：已完成本数 + 当前这本的页进度。 */
function ocrPct(job: OcrJobState): number {
  if (job.status === 'done') return 100;
  if (!job.fileTotal) return 0;
  const inFile = job.pageTotal ? Math.min(1, job.page / job.pageTotal) : 0;
  return Math.min(99, Math.round(((job.fileIndex - 1 + inFile) / job.fileTotal) * 100));
}

/** 进度面板只在弹层打开时存在，订阅是全局的，找不到元素就静默跳过。 */
function renderOcrJob(job: OcrJobState): void {
  const fill = document.getElementById('x-fill');
  if (!fill) return;
  fill.style.width = `${ocrPct(job)}%`;
  const line = document.getElementById('x-line')!;
  const logBox = document.getElementById('x-log')!;
  const running = job.status === 'running';
  const start = document.getElementById('x-start') as HTMLButtonElement | null;
  const cancel = document.getElementById('x-cancel') as HTMLButtonElement | null;
  if (start) start.disabled = running;
  if (cancel) cancel.classList.toggle('hidden', !running);

  const LABEL: Record<OcrJobState['status'], string> = {
    idle: '待开始', running: '识别中', done: '已完成', error: '失败', canceled: '已取消',
  };
  const parts = [LABEL[job.status]];
  if (job.fileTotal) parts.push(`第 ${job.fileIndex}/${job.fileTotal} 本`);
  if (job.currentName) parts.push(job.currentName);
  if (job.pageTotal) parts.push(`第 ${job.page} / ${job.pageTotal} 页`);
  if (job.doneFiles) parts.push(`已整本完成 ${job.doneFiles} 个`);
  if (job.error) parts.push(job.error);
  line.className = 'msg ' + (job.status === 'error' ? 'err' : job.status === 'done' ? 'ok' : '');
  line.textContent = parts.join(' · ');
  logBox.textContent = job.log.slice(-12).join('\n');
  logBox.scrollTop = logBox.scrollHeight;
}

async function ocrModal(): Promise<void> {
  const s = await window.fz.ocrSummary();
  state.ocrTotalFiles = s.totalFiles;
  state.ocrTextFiles = s.textFiles;
  state.ocrDoneFiles = s.doneFiles;
  const pct = s.totalFiles ? Math.round((s.textFiles / s.totalFiles) * 100) : 0;
  // 运行时探测要起子进程（打包版首次可能十几秒），先把弹层开出来再补状态，
  // 否则用户点了按钮会觉得没反应。
  const card = openModal(`
    <h2>全文识别</h2>
    <p>全文检索来自本机 OCR 文本。当前覆盖 <b>${s.textFiles}/${s.totalFiles}</b> 个文件，
      完成 <b>${s.doneFiles}</b> 个文件、<b>${s.doneBooks}/${s.totalBooks}</b> 部书。</p>
    <div class="ocrbar"><i style="width:${pct}%"></i></div>
    <p>只会识别<b>已经下载到本地</b>的 PDF。没识别的书仍可按书名、地名、志种检索和阅读原文；
      全文无结果不能解释为原书没有该内容。</p>
    <div class="ocrtask">
      <div class="row">
        <span>识别环境 <b id="x-runtime">检测中…</b></span>
        <span id="x-ready" class="msg"></span>
      </div>
      <div id="x-hint"></div>
      <div class="row">
        <label>本次最多 <input id="x-limit" value="5" size="3" /> 本</label>
        <label>每本最多 <input id="x-pages" value="0" size="4" /> 页（0 = 全部）</label>
        <label><input id="x-force" type="checkbox" /> 重跑已识别</label>
      </div>
      <div class="row">
        <button id="x-start" class="primary" disabled>开始识别</button>
        <button id="x-cancel" class="ghost hidden">取消</button>
        <button id="x-open" class="ghost">打开 OCR 数据目录</button>
        <button id="x-close" class="ghost">关闭</button>
        <span id="x-note" class="msg"></span>
      </div>
      <div class="ocrbar2"><i id="x-fill" style="width:0%"></i></div>
      <div id="x-line" class="msg"></div>
      <pre id="x-log" class="ocrlog"></pre>
    </div>`);

  card.querySelector('#x-close')!.addEventListener('click', closeModal);
  card.querySelector('#x-open')!.addEventListener('click', async () => {
    const r = await window.fz.openOcrFolder();
    const note = card.querySelector<HTMLSpanElement>('#x-note')!;
    note.className = 'msg ' + (r.ok ? 'ok' : 'err');
    note.textContent = r.ok ? '已打开' : (r.error ?? '打开失败');
  });
  card.querySelector('#x-cancel')!.addEventListener('click', () => void window.fz.ocrRunnerCancel());
  card.querySelector('#x-start')!.addEventListener('click', async () => {
    const limit = Number.parseInt(card.querySelector<HTMLInputElement>('#x-limit')!.value, 10);
    const maxPages = Number.parseInt(card.querySelector<HTMLInputElement>('#x-pages')!.value, 10);
    const force = card.querySelector<HTMLInputElement>('#x-force')!.checked;
    const r = await window.fz.ocrRunnerStart({
      limit: Number.isFinite(limit) && limit > 0 ? limit : 5,
      maxPages: Number.isFinite(maxPages) && maxPages > 0 ? maxPages : 0,
      force,
    });
    if (!r.ok) {
      const note = card.querySelector<HTMLSpanElement>('#x-note')!;
      note.className = 'msg err';
      note.textContent = r.error ?? '启动失败';
    }
  });

  const st = await window.fz.ocrRunnerStatus();
  const runtime = card.querySelector<HTMLElement>('#x-runtime');
  const ready = card.querySelector<HTMLElement>('#x-ready');
  const start = card.querySelector<HTMLButtonElement>('#x-start');
  const hint = card.querySelector<HTMLElement>('#x-hint');
  if (!runtime || !ready || !start || !hint) return;
  runtime.textContent = st.runtime.label;
  const ok = !!st.runtime.runtime;
  ready.className = 'msg ' + (ok ? 'ok' : 'err');
  ready.textContent = ok ? '可用' : '不可用';
  start.disabled = !ok;
  hint.innerHTML = ok ? '' : `<p class="msg err">${esc(st.runtime.note || '未检测到 uv 或 Python 识别环境')}<br>
    需要先安装 <code>uv</code>（推荐）或带 <code>pymupdf</code>、<code>rapidocr-onnxruntime</code> 的 Python 3.12。</p>`;
  renderOcrJob(st.job);
}

/** 详情面板里的「识别本书」：只跑这本书本地已有的 PDF。 */
async function ocrBook(fids: string[]): Promise<void> {
  const r = await window.fz.ocrRunnerStart({ limit: Math.max(1, fids.length), fids });
  alert(r.ok ? '已开始识别，进度见「工具 → 全文识别」。' : (r.error ?? '启动失败'));
}

/* ---------- 书签与最近阅读 ---------- */
function libRow(kind: 'mark' | 'recent', fid: string, title: string, fileName: string, page: number, id: string, time: string): string {
  return `<div class="librow" data-kind="${kind}" data-id="${esc(id)}" data-fid="${esc(fid)}">
    <button class="primary open" data-page="${page}">打开</button>
    <span class="ln" title="${esc(fileName || title)}">${esc(title || fileName || '（未知文件）')}</span>
    <span class="lp">第 ${page} 页</span>
    <span class="lt">${esc(time)}</span>
    ${kind === 'mark' ? '<button class="ghost del">删除</button>' : ''}
  </div>`;
}

async function libraryModal(): Promise<void> {
  const lib = await window.fz.marksList();
  const recent = await window.fz.recentList();
  const card = openModal(`
    <h2>书签与最近阅读</h2>
    <p>这些记录只保存在本机，不随索引更新丢失，也不上传。</p>
    <h3>书签（${lib.marks.length}）</h3>
    <div class="liblist">${lib.marks.length
      ? lib.marks.map((m) => libRow('mark', m.fid, m.title, m.fileName, m.page, m.id, new Date(m.createdAt).toLocaleString('zh-CN'))).join('')
      : '<div class="empty">还没有书签。阅读时点右上角「☆ 书签」收藏当前页。</div>'}</div>
    <h3>最近阅读（${recent.length}）</h3>
    <div class="liblist">${recent.length
      ? recent.map((r) => libRow('recent', r.fid, r.title, r.fileName, r.page, r.fid, new Date(r.at).toLocaleString('zh-CN'))).join('')
      : '<div class="empty">还没有阅读记录。</div>'}</div>
    <div class="row">
      <button id="l-clear" class="ghost">清空最近阅读</button>
      <button id="l-close" class="ghost">关闭</button>
      <span id="l-msg" class="msg"></span>
    </div>`);

  card.querySelector('#l-close')!.addEventListener('click', closeModal);
  card.querySelector('#l-clear')!.addEventListener('click', async () => {
    await window.fz.recentClear();
    closeModal();
    void libraryModal();
  });

  card.querySelectorAll<HTMLElement>('.librow').forEach((row) => {
    const fid = row.dataset.fid ?? '';
    const title = row.querySelector('.ln')?.textContent ?? '';
    const page = Number(row.querySelector<HTMLElement>('.open')?.dataset.page ?? '1');
    row.querySelector<HTMLButtonElement>('.open')?.addEventListener('click', () => {
      closeModal();
      void openReader(fid, title, undefined, page);
    });
    row.querySelector<HTMLButtonElement>('.del')?.addEventListener('click', async () => {
      await window.fz.markRemove(row.dataset.id ?? '');
      closeModal();
      void libraryModal();
    });
  });
}

/* ---------- 下载队列 ---------- */
const dl = new Map<string, DlState>();

function dlActive(): number {
  let n = 0;
  for (const s of dl.values()) if (s.status === 'queued' || s.status === 'linking' || s.status === 'downloading') n++;
  return n;
}

const DL_LABEL: Record<DlState['status'], string> = {
  queued: '排队中', linking: '取直链', downloading: '下载中', done: '完成', error: '失败', canceled: '已取消',
};

function renderDl(): void {
  const n = dlActive();
  const badge = $('dl-badge');
  badge.classList.toggle('hidden', n === 0);
  badge.textContent = String(n);

  const tray = $('dltray');
  if (tray.classList.contains('hidden')) return;
  const items = [...dl.values()];
  tray.innerHTML =
    `<header><span>下载队列 · ${items.length}</span><span>
       <button id="t-dir" class="ghost">保存目录</button>
       <button id="t-close" class="ghost">收起</button></span></header>` +
    (items.length
      ? items.map((s) => {
          const pct = s.size ? Math.min(100, Math.round((s.bytes / s.size) * 100)) : 0;
          const busy = s.status === 'queued' || s.status === 'linking' || s.status === 'downloading';
          const note = s.status === 'error' ? (s.error ?? '失败')
            : s.status === 'downloading' ? `${DL_LABEL[s.status]} ${pct}% · ${formatSize(s.bytes)} / ${formatSize(s.size)}`
            : DL_LABEL[s.status];
          return `<div class="dlitem" data-fid="${esc(s.fid)}">
            <div class="n" title="${esc(s.name)}">${esc(s.name)}</div>
            <span class="bar"><i style="width:${s.status === 'done' ? 100 : pct}%"></i></span>
            <div class="r"><span class="${s.status === 'error' ? 'err' : s.status === 'done' ? 'ok' : ''}">${esc(note)}</span>
              ${busy ? '<button data-act="cancel">取消</button>' : ''}
              ${s.status === 'error' ? '<button data-act="retry">重试</button>' : ''}
              ${s.dest ? '<button data-act="show">打开位置</button>' : ''}
            </div></div>`;
        }).join('')
      : '<div class="empty">队列为空。<br>在右侧书详情里点「下载本书」。</div>');

  tray.querySelector('#t-close')!.addEventListener('click', () => tray.classList.add('hidden'));
  tray.querySelector('#t-dir')!.addEventListener('click', async () => {
    const r = await window.fz.dlDir();
    const head = tray.querySelector('header span');
    if (head && r.ok) head.textContent = `下载队列 · ${items.length}`;
  });
  tray.querySelectorAll<HTMLButtonElement>('.dlitem button').forEach((b) => {
    b.addEventListener('click', () => {
      const fid = (b.closest('.dlitem') as HTMLElement).dataset.fid!;
      if (b.dataset.act === 'cancel') void window.fz.dlCancel(fid);
      else if (b.dataset.act === 'retry') {
        void window.fz.dlRetry(fid).then((list) => {
          for (const s of list) dl.set(s.fid, s);
          renderDl();
        });
      } else {
        const dest = dl.get(fid)?.dest;
        if (dest) void window.fz.showInFolder(dest);
      }
    });
  });
}

async function enqueueBook(files: FileRecord[]): Promise<void> {
  const ci = await window.fz.cookieInfo();
  if (!ci.has) { void cookieModal('先配置 cookie 才能下载。'); return; }
  const items = files
    .filter((f) => !f.isNoise && f.shareFidToken)
    .map((f) => ({ fid: f.fid, bookId: f.bookId, name: f.name, size: f.size, pdirFid: f.pdirFid, shareFidToken: f.shareFidToken }));
  if (!items.length) return;
  for (const s of await window.fz.dlEnqueue(items)) dl.set(s.fid, s);
  $('dltray').classList.remove('hidden');
  renderDl();
}

/* ---------- 内置阅读器 ---------- */
/**
 * 极简 canvas 翻页器：只用 PDF.js 的核心 API（getDocument + page.render），
 * 不引入 pdf.js 的 viewer 外壳——那套要 'unsafe-inline' 样式，和本项目的 CSP / 手写风格不搭。
 */
let readerDoc: PDFDocumentProxy | null = null;
let readerTask: PDFDocumentLoadingTask | null = null;
let readerRender: RenderTask | null = null;
let readerSeq = 0;
/** 当前已渲染的页；readerTarget 是最后一次请求的页（翻页连续点击时按它递增）。 */
let readerPage = 1;
let readerTarget = 1;
let readerFit = true;
/** 当前看的是原 PDF 还是 OCR 文本；两种模式共用同一个页码。 */
let readerMode: 'pdf' | 'ocr' = 'pdf';
let readerFid = '';
/** 这本书 OCR 到了第几页；0 表示没有 OCR 文本，按钮灰掉。 */
let readerOcrPages = 0;
/** 书内搜索状态：命中页、当前第几个命中、上一次的查询词。 */
let readerHits: Array<{ p: number; n: number }> = [];
let readerHitIdx = -1;
let readerQuery = '';
/** 这本书已收藏的页码。进阅读器时拉一次，翻页只查内存。 */
let readerMarks = new Set<number>();

/** 书签按钮反映「当前这一页是否已收藏」。 */
function renderMarkBtn(): void {
  const btn = $('r-mark');
  const on = readerFid ? readerMarks.has(readerPage) : false;
  btn.textContent = on ? '★ 已收藏' : '☆ 书签';
  btn.classList.toggle('on', on);
}

/** 翻到新页：更新书签按钮，并记一条最近阅读（主进程内部会合并高频调用）。 */
function afterPageTurn(no: number): void {
  renderMarkBtn();
  if (readerFid) void window.fz.recentTouch(readerFid, no);
}

const readerLimit = (): number => (readerMode === 'ocr' ? readerOcrPages : readerDoc?.numPages ?? 0);
const posKey = (fid: string): string => `fz:last-page:${fid}`;
const savedPage = (fid: string): number => {
  const n = Number(localStorage.getItem(posKey(fid)));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
};

function readerMsg(text: string, err = false): void {
  const msg = $('r-msg');
  msg.textContent = text;
  msg.className = 'rmsg' + (err ? ' err' : '');
  $<HTMLCanvasElement>('r-canvas').classList.add('hidden');
}

async function renderReaderPage(n: number): Promise<void> {
  if (readerMode === 'ocr') return renderOcrPage(n);
  const doc = readerDoc;
  if (!doc) return;
  const no = Math.min(Math.max(1, n), doc.numPages);
  readerTarget = no;
  try {
    const page = await doc.getPage(no);
    if (doc !== readerDoc) return;
    const canvas = $<HTMLCanvasElement>('r-canvas');
    const stage = $('r-stage');
    const base = page.getViewport({ scale: 1 });
    const scale = readerFit ? Math.max(0.1, (stage.clientWidth - 32) / base.width) : 1;
    const viewport = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    canvas.classList.remove('hidden');
    $('r-msg').classList.add('hidden');

    readerRender?.cancel();
    const task = page.render({
      canvas: null,
      canvasContext: canvas.getContext('2d')!,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });
    readerRender = task;
    await task.promise;

    readerPage = no;
    $<HTMLInputElement>('r-page').value = String(no);
    if (readerFid) localStorage.setItem(posKey(readerFid), String(no));
    afterPageTurn(no);
  } catch (e) {
    // 翻页太快会取消上一次渲染，这不是错误
    if ((e as Error).name === 'RenderingCancelledException') return;
    if (doc === readerDoc) readerMsg(`这一页渲染失败：${(e as Error).message}`, true);
  }
}

/** OCR 文本模式：一次只取一页，页码和 PDF 模式共用，方便来回对照。 */
async function renderOcrPage(n: number): Promise<void> {
  if (!readerFid || !readerOcrPages) return;
  const no = Math.min(Math.max(1, n), readerOcrPages);
  readerTarget = no;
  const page = await window.fz.ocrPage(readerFid, no, readerQuery);
  if (readerMode !== 'ocr') return;
  readerPage = no;
  $<HTMLInputElement>('r-page').value = String(no);
  if (readerFid) localStorage.setItem(posKey(readerFid), String(no));
  afterPageTurn(no);
  $('r-msg').classList.add('hidden');
  $<HTMLCanvasElement>('r-canvas').classList.add('hidden');
  const box = $('r-text');
  box.classList.remove('hidden');
  box.innerHTML = page?.text.trim()
    ? paintPage(page.text, page.marks ?? [])
    : '<div class="empty">这一页没有识别出文字。</div>';
  box.scrollTop = 0;
}

/** 把命中区间（基于原文下标）染成 mark，未命中的部分做 HTML 转义。 */
function paintRanges(text: string, marks: Array<[number, number]>): string {
  let html = '';
  let cur = 0;
  for (const [s, e] of marks) {
    if (s < cur || e <= s) continue;
    html += esc(text.slice(cur, s)) + `<mark>${esc(text.slice(s, e))}</mark>`;
    cur = e;
  }
  return html + esc(text.slice(cur));
}

function paintPage(text: string, marks: Array<[number, number]>): string {
  let offset = 0;
  return text.split('\n').map((line) => {
    const start = offset;
    const end = offset + line.length;
    offset = end + 1;
    const local: Array<[number, number]> = [];
    for (const [s, e] of marks) {
      const a = Math.max(s, start);
      const b = Math.min(e, end);
      if (b > a) local.push([a - start, b - start]);
    }
    return `<p>${paintRanges(line, local)}</p>`;
  }).join('');
}

/** 书内全文搜索：第一次回车查一遍，之后回车在命中页之间循环。 */
async function readerFind(next: boolean): Promise<void> {
  const q = $<HTMLInputElement>('r-q').value.trim();
  if (!q || !readerFid) return;
  const hitsBox = $('r-hits');
  if (q !== readerQuery) {
    readerQuery = q;
    const res = await window.fz.ocrSearch(readerFid, q);
    readerHits = res.hits;
    readerHitIdx = -1;
    hitsBox.classList.remove('hidden');
    if (!readerHits.length) {
      hitsBox.textContent = '无命中';
      await renderOcrPage(readerPage);
      return;
    }
  }
  if (!readerHits.length) return;
  readerHitIdx = next
    ? (readerHitIdx + 1) % readerHits.length
    : (readerHitIdx - 1 + readerHits.length) % readerHits.length;
  const hit = readerHits[readerHitIdx];
  if (!hit) return;
  const total = readerHits.reduce((s, h) => s + h.n, 0);
  hitsBox.textContent = `${readerHitIdx + 1}/${readerHits.length} 页 · 共 ${total} 处`;
  setReaderMode('ocr', false); // 命中在 OCR 文本里；换页交给下面，避免和模式切换里的渲染抢
  await renderOcrPage(hit.p);
}

function setReaderMode(mode: 'pdf' | 'ocr', render = true): void {
  if (mode === 'ocr' && !readerOcrPages) return;
  readerMode = mode;
  $('r-pdf').classList.toggle('on', mode === 'pdf');
  $('r-ocr').classList.toggle('on', mode === 'ocr');
  $('r-fit').classList.toggle('hidden', mode === 'ocr');
  if (mode === 'pdf') $('r-text').classList.add('hidden');
  const total = readerLimit();
  $('r-total').textContent = total ? `/ ${total}` : '/ …';
  if (render) void renderReaderPage(readerPage);
}

async function closeReader(): Promise<void> {
  readerSeq++;
  readerRender?.cancel();
  readerRender = null;
  $('reader').classList.add('hidden');
  readerDoc = null;
  const task = readerTask;
  readerTask = null;
  if (task) await task.destroy().catch(() => undefined);
}

async function showReader(
  url: string,
  name: string,
  mode: 'local' | 'online',
  fid: string,
  ocrOnly = false,
): Promise<void> {
  const seq = ++readerSeq;
  $('reader').classList.remove('hidden');
  $('r-title').textContent = name;
  $('r-title').title = name;
  $('r-mode').textContent = mode === 'local' ? '本地' : '在线';
  $('r-total').textContent = '/ …';
  $<HTMLInputElement>('r-page').value = '';
  readerPage = 1;
  readerTarget = 1;
  readerFid = fid;
  readerMode = 'pdf';
  readerOcrPages = 0;
  $('r-pdf').classList.add('on');
  $('r-ocr').classList.remove('on');
  $<HTMLButtonElement>('r-ocr').disabled = true;
  $('r-ocr').title = '这本书还没有 OCR 文本';
  $('r-fit').classList.remove('hidden');
  $('r-text').classList.add('hidden');
  $('r-text').innerHTML = '';
  readerHits = [];
  readerHitIdx = -1;
  readerQuery = '';
  readerMarks = new Set();
  renderMarkBtn();
  // 书签异步取，别挡住 PDF 加载；回来时确认还是同一本书
  void window.fz.marksList().then((lib) => {
    if (readerFid !== fid) return;
    readerMarks = new Set(lib.marks.filter((m) => m.fid === fid).map((m) => m.page));
    renderMarkBtn();
  });
  $<HTMLInputElement>('r-q').value = '';
  $('r-q').classList.add('hidden');
  $('r-hits').classList.add('hidden');
  $('r-hits').textContent = '';
  readerMsg('载入中…');

  // OCR 信息在本地读，先问它：PDF 打不开时至少知道有没有文字可看
  const ocrInfo = await window.fz.ocrInfo(fid);
  if (seq === readerSeq && ocrInfo.ok && ocrInfo.pages) {
    readerOcrPages = ocrInfo.pages;
    $<HTMLButtonElement>('r-ocr').disabled = false;
    $('r-q').classList.remove('hidden');
    $('r-ocr').title = `看 OCR 识别出的文字（共 ${ocrInfo.pages} 页${ocrInfo.done ? '' : '，整本未识别完'}）`;
    $('r-mode').textContent += ` · OCR ${ocrInfo.pages}页`;
  }

  readerDoc = null;
  const stale = readerTask;
  readerTask = null;
  if (stale) await stale.destroy().catch(() => undefined);

  // PDF 暂时打不开（例如没有 cookie）时，已有 OCR 文本仍可进入阅读。
  if (ocrOnly && readerOcrPages) {
    $('r-mode').textContent = '仅 OCR 文本';
    readerPage = Math.min(savedPage(fid), readerOcrPages);
    setReaderMode('ocr');
    return;
  }

  try {
    const task = pdfjsLib.getDocument({
      url,
      wasmUrl: './wasm/',
      iccUrl: './iccs/',
      cMapUrl: './cmaps/',
      cMapPacked: true,
      standardFontDataUrl: './standard_fonts/',
    });
    readerTask = task;
    const doc = await task.promise;
    if (seq !== readerSeq) { void task.destroy(); return; }
    readerDoc = doc;
    $('r-total').textContent = `/ ${doc.numPages}`;
    readerFit = true;
    $('r-fit').textContent = '适应宽度';
    readerPage = Math.min(savedPage(fid), doc.numPages);
    // 文档确实打开了就先记一条最近阅读：首屏渲染偶尔会失败/被打断，
    // 那种情况下也不该把「用户读过这本书」这件事漏掉。
    if (readerFid) void window.fz.recentTouch(readerFid, readerPage);
    await renderReaderPage(readerPage);
  } catch (e) {
    if (seq !== readerSeq) return;
    readerMsg(`打不开这个 PDF：${(e as Error).message}`, true);
  }
}

/** at 用于从全文命中直接跳页：打开后切到 OCR 文本并定位到该页、带上高亮词。
 *  gotoPage 用于书签/最近阅读：只跳页，不带查询词。 */
async function openReader(
  fid: string,
  name: string,
  at?: { page: number; q: string },
  gotoPage?: number,
): Promise<void> {
  const r = await window.fz.readerResolve(fid);
  if (!r.ok) {
    if (r.needCookie) {
      const oi = await window.fz.ocrInfo(fid);
      if (oi.ok && oi.pages) {
        await showReader('', name, 'local', fid, true);
        if (at) {
          const res = await window.fz.ocrSearch(fid, at.q);
          readerQuery = at.q;
          readerHits = res.hits;
          readerHitIdx = readerHits.findIndex((h) => h.p === at.page);
          $<HTMLInputElement>('r-q').value = at.q;
          $('r-hits').classList.remove('hidden');
          $('r-hits').textContent = `${Math.max(1, readerHitIdx + 1)}/${res.hits.length} 页 · 共 ${res.total} 处`;
          await renderOcrPage(at.page);
        } else if (gotoPage) {
          await renderOcrPage(gotoPage);
        }
        return;
      }
      void cookieModal('在线阅读需要夸克 cookie（已下载到本地的文件不需要）。');
      return;
    }
    alert(r.error ?? '打不开这个文件');
    return;
  }
  await showReader(r.url!, name, r.mode ?? 'online', fid);
  if (!at) {
    if (gotoPage && gotoPage > 1) await renderReaderPage(gotoPage);
    return;
  }
  const res = await window.fz.ocrSearch(fid, at.q);
  readerQuery = at.q;
  readerHits = res.hits;
  readerHitIdx = readerHits.findIndex((h) => h.p === at.page);
  $<HTMLInputElement>('r-q').value = at.q;
  $('r-hits').classList.remove('hidden');
  $('r-hits').textContent = readerHits.length
    ? `${readerHitIdx + 1}/${readerHits.length} 页 · 共 ${res.total} 处`
    : '无命中';
  setReaderMode('ocr', false);
  await renderOcrPage(at.page);
}

$('r-prev').addEventListener('click', () => void renderReaderPage(readerTarget - 1));
$('r-next').addEventListener('click', () => void renderReaderPage(readerTarget + 1));
$('r-mark').addEventListener('click', async () => {
  if (!readerFid) return;
  const r = await window.fz.markToggle(readerFid, readerPage);
  readerMarks = new Set(r.marks.filter((m) => m.fid === readerFid).map((m) => m.page));
  renderMarkBtn();
});
$('r-close').addEventListener('click', () => void closeReader());
$('r-pdf').addEventListener('click', () => setReaderMode('pdf'));
$('r-ocr').addEventListener('click', () => setReaderMode('ocr'));
$<HTMLInputElement>('r-q').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  void readerFind(!e.shiftKey); // Shift+回车往回找
});
$('r-fit').addEventListener('click', () => {
  readerFit = !readerFit;
  $('r-fit').textContent = readerFit ? '适应宽度' : '实际大小';
  void renderReaderPage(readerPage);
});
$<HTMLInputElement>('r-page').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const n = Number.parseInt((e.target as HTMLInputElement).value, 10);
  if (Number.isFinite(n)) void renderReaderPage(n);
});
window.addEventListener('keydown', (e) => {
  if ($('reader').classList.contains('hidden')) return;
  // 在搜索框里输入时，方向键归光标用，别拿去翻页
  const typing = document.activeElement instanceof HTMLInputElement;
  if (e.key === 'Escape') void closeReader();
  else if (!typing && (e.key === 'ArrowLeft' || e.key === 'PageUp')) void renderReaderPage(readerTarget - 1);
  else if (!typing && (e.key === 'ArrowRight' || e.key === 'PageDown')) void renderReaderPage(readerTarget + 1);
});
let readerResize = 0;
window.addEventListener('resize', () => {
  if (readerMode === 'ocr' || !readerDoc || !readerFit) return;
  clearTimeout(readerResize);
  readerResize = window.setTimeout(() => void renderReaderPage(readerPage), 200);
});

/* ---------- 启动 ---------- */
async function boot(): Promise<void> {
  const info = await window.fz.info();
  state.shareUrl = info.meta?.shareUrl ?? '';

  if (!info.hasIndex) {
    $('subtitle').textContent = '未找到索引';
    $('list').innerHTML = `<div class="empty">还没有索引数据。<br>点右上角「更新索引」从夸克分享链接爬取，或点「数据目录」选择已有索引。</div>`;
    $('status-left').textContent = info.dataDir;
    return;
  }

  const s = info.stats!;
  const label = `${info.meta?.shareTitle ?? ''}${info.meta?.author ? ' · ' + info.meta.author : ''}`;
  $('subtitle').textContent = label;
  $('subtitle').title = label;
  $('status-left').textContent = info.dataDir;
  const searchable = info.searchableBookCount ?? s.bookCount;
  const bookLabel = searchable === s.bookCount
    ? `${s.bookCount} 部书`
    : `${s.bookCount} 部书（${searchable} 部可检索）`;
  const ocrSummary = await window.fz.ocrSummary();
  state.ocrTotalFiles = ocrSummary.totalFiles;
  state.ocrTextFiles = ocrSummary.textFiles;
  state.ocrDoneFiles = ocrSummary.doneFiles;
  $('status-right').textContent =
    `${s.fileCount} 文件 · ${bookLabel} · 全文 ${ocrSummary.textFiles}/${ocrSummary.totalFiles} 文件` +
    ` · ${formatSize(s.totalSize)} · 爬取于 ${new Date(info.crawledAt ?? Date.now()).toLocaleString('zh-CN')}`;

  for (const s of await window.fz.dlList()) dl.set(s.fid, s);
  renderDl();

  renderFacets(await window.fz.facets());
  await run();
}

$('q').addEventListener('input', (e) => { state.q = (e.target as HTMLInputElement).value; scheduleRun(); });
$('q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(timer); state.offset = 0; run(); }
  if (e.key === 'Escape') { (e.target as HTMLInputElement).value = ''; state.q = ''; scheduleRun(); }
});
$('clear').addEventListener('click', () => { const q = $<HTMLInputElement>('q'); q.value = ''; state.q = ''; q.focus(); scheduleRun(); });
$('btn-reset').addEventListener('click', () => {
  state.filters = { provinces: [], eras: [], zhiTypes: [], exts: [], allTermsOnly: $<HTMLInputElement>('strict').checked };
  $('btn-reset').classList.add('hidden');
  state.offset = 0;
  clearSelection();
  boot();
});
$<HTMLInputElement>('strict').addEventListener('change', (e) => {
  state.filters.allTermsOnly = (e.target as HTMLInputElement).checked;
  state.offset = 0;
  clearSelection();
  run();
});
$('btn-crawl').addEventListener('click', crawlModal);
$('btn-facets').addEventListener('click', () => $('facets').classList.toggle('collapsed'));
// 每个分面（省区/朝代/…）单独可收起：点标题切换，收起后 chip 行隐藏、只留标题
for (const h of document.querySelectorAll<HTMLElement>('.facets section > h2')) {
  h.title = '点击收起 / 展开';
  h.addEventListener('click', () => h.parentElement?.classList.toggle('collapsed'));
}
for (const b of document.querySelectorAll<HTMLElement>('.toolmenu button')) {
  b.addEventListener('click', () => b.closest('details')?.removeAttribute('open'));
}
$('btn-cookie').addEventListener('click', () => void cookieModal());
$('btn-ocr').addEventListener('click', () => void ocrModal());
$('btn-lib').addEventListener('click', () => void libraryModal());
$('btn-dl').addEventListener('click', async () => {
  const tray = $('dltray');
  if (tray.classList.contains('hidden')) {
    for (const s of await window.fz.dlList()) dl.set(s.fid, s);
    tray.classList.remove('hidden');
    renderDl();
  } else {
    tray.classList.add('hidden');
  }
});
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
$('btn-dir').addEventListener('click', async () => {
  const r = await window.fz.pickDataDir();
  if (!r.ok && r.error) alert(r.error);
  await boot();
});

window.fz.onCrawlProgress((p) => {
  if (!state.crawling) return;
  const bar = $('crawlbar');
  const total = p.dirsDone + p.dirsPending;
  const pct = total ? Math.round((p.dirsDone / total) * 100) : 0;
  const label = bar.querySelector('#c-pct');
  if (!label) return;
  label.textContent = `爬取中 ${pct}%  ·  ${p.files} 文件  ·  ${p.reqCount} 请求`;
  (bar.querySelector('#c-fill') as HTMLElement).style.width = pct + '%';
  const path = bar.querySelector('#c-path') as HTMLElement;
  path.textContent = p.currentPath;
  path.title = p.currentPath;
});

window.fz.onDlProgress((s) => {
  dl.set(s.fid, s);
  renderDl();
});

window.fz.onTextProgress((p) => { textProgress = p; });

window.fz.onOcrProgress(renderOcrJob);
window.fz.onOcrDone((r) => {
  // 识别进程直接改了索引文件，主进程已重载；这边刷新覆盖度和列表。
  void (async () => {
    const s = await window.fz.ocrSummary();
    state.ocrTotalFiles = s.totalFiles;
    state.ocrTextFiles = s.textFiles;
    state.ocrDoneFiles = s.doneFiles;
    const line = document.getElementById('x-line');
    if (line && !r.ok && r.note) {
      line.className = 'msg err';
      line.textContent = r.note;
    }
    if (r.ok) await boot();
  })();
});

void boot();
