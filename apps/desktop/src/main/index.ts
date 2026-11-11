import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  applyBookOverrides, buildIndex, computeFacets, countSearchableBooks,
  emptyBookOverrides, getBook, overrideForBook, search, toLean,
} from '@fangzhi/core';
import type {
  BookOverrideFields, BookOverrideFile, GazetteerIndex, RawShareDump, IndexMeta, LeanIndex,
} from '@fangzhi/core';
import { crawlShare, diffDumps, parseShareUrl } from '@fangzhi/core/crawl';
import type { CrawlCheckpoint } from '@fangzhi/core/crawl';
import { clearSocialToken, probeLogin } from '@fangzhi/core/download';
import type { SearchFilters } from '@fangzhi/core';
import { CookieStore } from './cookies.ts';
import { DownloadManager } from './download.ts';
import type { DlItem } from './download.ts';
import { findLocalPath, registerReader, registerReaderSchemes } from './reader.ts';
import type { ReaderDeps } from './reader.ts';
import { createOcrReader } from './ocr.ts';
import { createFulltextSearch } from './fulltext.ts';
import type { TextFileTask } from './fulltext-core.ts';
import { createOcrRunner } from './ocr-runner.ts';
import { createTextIndexBuilder } from './text-index-run.ts';
import { invalidateTextIndexFiles, loadTextIndex } from './text-index.ts';
import { createLibrary } from './library.ts';

// 自动化检查必须使用独立用户目录，避免碰真实 cookie、下载清单和校正记录。
// 仅测试环境显式设置；正常启动不受影响。
const testUserData = process.env.FZ_USER_DATA_DIR;
if (testUserData) app.setPath('userData', resolve(testUserData));

// fzpdf 必须在 app ready 之前声明为特权 scheme，否则 fetch / 流式响应都不可用。
registerReaderSchemes();

let win: BrowserWindow | null = null;
let idx: GazetteerIndex | null = null;
let idxPath = '';
let crawlAbort: AbortController | null = null;

/**
 * 数据目录优先级：用户可写目录 > 打包进 resources 的只读索引 > 仓库里的开发数据。
 * 打包版必须写 userData，否则装到 Program Files 下就没权限了。
 */
function resolveDataDir(): string {
  const userDir = join(app.getPath('userData'), 'data');
  const candidates: string[] = [];
  // 用户手动选择的数据目录优先，并在重启后继续使用。
  if (settings.dataDir && existsSync(join(settings.dataDir, 'index.full.json'))) candidates.push(settings.dataDir);
  candidates.push(userDir);
  if (app.isPackaged) candidates.push(join(process.resourcesPath, 'data'));
  let p = __dirname;
  for (let i = 0; i < 6; i++) {
    p = dirname(p);
    if (existsSync(join(p, 'data', 'index.full.json'))) { candidates.push(join(p, 'data')); break; }
  }
  for (const c of candidates) if (existsSync(join(c, 'index.full.json'))) return c;
  mkdirSync(userDir, { recursive: true });
  return userDir;
}

let dataDir = '';
let cookies: CookieStore;
let downloads: DownloadManager;
let ocrRunner: ReturnType<typeof createOcrRunner>;
let library: ReturnType<typeof createLibrary>;
let bookOverrides: BookOverrideFile = emptyBookOverrides();
let settings: { downloadDir: string; dataDir?: string } = { downloadDir: '' };

function settingsPath(): string { return join(app.getPath('userData'), 'settings.json'); }
function overridesPath(): string { return join(app.getPath('userData'), 'book-overrides.json'); }

function loadBookOverrides(): BookOverrideFile {
  try {
    const raw = JSON.parse(readFileSync(overridesPath(), 'utf8')) as Partial<BookOverrideFile>;
    if (raw?.version !== 1 || !raw.books || typeof raw.books !== 'object') return emptyBookOverrides();
    return { version: 1, books: raw.books };
  } catch {
    return emptyBookOverrides();
  }
}

function writeBookOverrides(): void {
  const p = overridesPath();
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(bookOverrides, null, 2) + '\n');
  renameSync(tmp, p);
}

function loadSettings(): void {
  try {
    settings = { ...settings, ...(JSON.parse(readFileSync(settingsPath(), 'utf8')) as object) };
  } catch { /* 首次运行没有设置文件 */ }
  // 默认落在系统「下载」文件夹下的独立子目录：用户找得到，开发版和打包版也共用同一处，
  // 不会因为 app name 不同（@fangzhi/desktop vs 方志检索）各存一份、互相看不见。
  if (!settings.downloadDir) settings.downloadDir = join(app.getPath('downloads'), '方志检索');
}

function saveSettings(): void { writeFileSync(settingsPath(), JSON.stringify(settings, null, 2)); }

/** 索引和断点都写同目录临时文件再替换；进程中断时不会留下半份 JSON。 */
function writeJson(file: string, data: unknown): string {
  mkdirSync(dataDir, { recursive: true });
  const p = join(dataDir, file);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data));
  renameSync(tmp, p);
  return p;
}

function loadIndex(): { ok: boolean; error?: string } {
  dataDir = resolveDataDir();
  idxPath = join(dataDir, 'index.full.json');
  if (!existsSync(idxPath)) {
    idx = null;
    return { ok: false, error: `还没有索引。数据目录 ${dataDir}` };
  }
  try {
    idx = JSON.parse(readFileSync(idxPath, 'utf8')) as GazetteerIndex;
    applyBookOverrides(idx, bookOverrides);
    return { ok: true };
  } catch (e) {
    idx = null;
    return { ok: false, error: `索引损坏: ${(e as Error).message}` };
  }
}

function send(channel: string, payload: unknown): void {
  win?.webContents.send(channel, payload);
}

/** 只允许打开夸克官方 HTTPS 页面；索引文件也可能来自外部目录，不能信任其中的 URL。 */
function allowedExternal(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && (u.hostname === 'quark.cn' || u.hostname.endsWith('.quark.cn'));
  } catch {
    return false;
  }
}

/** 文件操作只接受用户下载目录内的路径，不让渲染层借 shell 暴露任意位置。 */
function insideDownloadDir(p: string): boolean {
  const root = resolve(settings.downloadDir);
  const target = resolve(p);
  return target === root || target.startsWith(root + '\\') || target.startsWith(root + '/');
}

/** 阅读器的依赖注入：cookie / 目录 / 索引都延迟取值，whenReady 之后才真正可用。 */
const readerDeps = (): ReaderDeps => ({
  hasCookie: () => cookies.has(),
  cookie: () => cookies.get(),
  downloadDir: () => settings.downloadDir,
  index: () => idx,
  shareUrl: () => idx?.meta?.shareUrl ?? '',
});

/** OCR 文本读取，延迟取值同上。 */
const ocr = createOcrReader({ index: () => idx, dataDir: () => dataDir });

/** 索引里所有带 OCR 文本的文件；全文检索和倒排索引构建共用同一份清单。 */
function ocrTextTasks(): TextFileTask[] {
  const i = idx;
  if (!i) return [];
  const titles = new Map(i.books.map((b) => [b.id, b.title] as const));
  const out: TextFileTask[] = [];
  for (const f of i.files) {
    if (!f.textRef) continue;
    out.push({
      fid: f.fid,
      bookId: f.bookId,
      title: titles.get(f.bookId) ?? f.bookId,
      name: f.name,
      textRef: f.textRef,
    });
  }
  return out;
}

/**
 * 全库全文检索跑在 worker 线程里。传给线程的只有 fid / 书名 / textRef，
 * 不带整份索引；界面不会被上千个 jsonl 的解析和繁简归一化卡住。
 */
const fulltext = createFulltextSearch({
  tasks: ocrTextTasks,
  dataDir: () => dataDir,
  onProgress: (p) => send('search-text-progress', p),
});

/** 倒排索引构建：同样放线程里跑，构建上千本时要几十秒，不能占住界面。 */
const textIndexBuilder = createTextIndexBuilder({
  tasks: ocrTextTasks,
  dataDir: () => dataDir,
  onProgress: (p) => send('text-index-progress', p),
});

/**
 * 识别脚本位置。开发版在仓库里；打包版随 resources 一起发（见 package-portable.mjs）。
 * cwd 给 uv 用：它会在这里找 .venv / 缓存，跑到别处会重新解析依赖。
 */
function resolveOcrScript(): { script: string; cwd: string } {
  const rel = join('tools', 'ocr', 'ocr.py');
  const packaged = join(process.resourcesPath, rel);
  if (app.isPackaged && existsSync(packaged)) return { script: packaged, cwd: process.resourcesPath };
  let p = __dirname;
  for (let i = 0; i < 6; i++) {
    p = dirname(p);
    if (existsSync(join(p, rel))) return { script: join(p, rel), cwd: p };
  }
  return { script: packaged, cwd: process.resourcesPath };
}

/** 识别进程直接改了 index.full.json，这里重新读回来并复用人工作过的校正。 */
function reloadIndexFromDisk(): void {
  try {
    const fresh = JSON.parse(readFileSync(idxPath, 'utf8')) as GazetteerIndex;
    applyBookOverrides(fresh, bookOverrides);
    idx = fresh;
    writeJson('index.lean.json', toLean(fresh));
  } catch {
    // 读不回来不动内存里的旧索引：界面还能用，只是看不到新识别结果
  }
}

function registerIpc(): void {
  ipcMain.handle('info', () => ({
    dataDir,
    hasIndex: !!idx,
    meta: idx?.meta,
    stats: idx?.stats,
    searchableBookCount: idx ? countSearchableBooks(idx) : 0,
    crawledAt: idx?.crawledAt,
    version: app.getVersion(),
  }));

  ipcMain.handle('search', (_e, q: string, filters: SearchFilters, limit: number, offset: number) => {
    if (!idx) return { total: 0, directTotal: 0, available: 0, weakTotal: 0, weakShown: 0, items: [], elapsedMs: 0, facets: { province: {}, era: {}, zhiType: {}, ext: {} } };
    return search(idx, q, { ...filters, limit, offset });
  });

  ipcMain.handle('book', (_e, id: string) => {
    if (!idx) return undefined;
    const d = getBook(idx, id);
    return d ? { ...d, override: overrideForBook(bookOverrides, d.book) } : undefined;
  });

  ipcMain.handle('book-override-set', (_e, id: string, patch: BookOverrideFields) => {
    if (!idx) return { ok: false, error: '没有索引' };
    const book = idx.books.find((b) => b.id === id);
    if (!book) return { ok: false, error: '找不到这本书' };
    const allowed: Array<keyof BookOverrideFields> = [
      'title', 'era', 'place', 'zhiType', 'province', 'author', 'edition',
    ];
    const clean: BookOverrideFields = {};
    for (const key of allowed) {
      if (key in patch) clean[key] = String(patch[key] ?? '').trim();
    }
    bookOverrides.books[id] = {
      ...bookOverrides.books[id],
      bookId: id,
      fileIds: [...book.fileIds],
      ...clean,
      updatedAt: new Date().toISOString(),
    };
    try {
      writeBookOverrides();
      // 从磁盘重载基础索引后再合并全部校正，避免连续编辑时旧值叠加。
      const fresh = JSON.parse(readFileSync(idxPath, 'utf8')) as GazetteerIndex;
      applyBookOverrides(fresh, bookOverrides);
      idx = fresh;
      return { ok: true, applied: Object.keys(bookOverrides.books).length };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle('facets', () => (idx ? computeFacets(idx) : { province: {}, era: {}, zhiType: {}, ext: {} }));

  ipcMain.handle('export-lean', () => {
    if (!idx) return { ok: false, error: '没有索引' };
    const lean: LeanIndex = toLean(idx);
    const p = writeJson('index.lean.json', lean);
    return { ok: true, path: p, bytes: readFileSync(p).length };
  });

  ipcMain.handle('crawl', async (_e, url: string, resume: boolean) => {
    if (crawlAbort) return { ok: false, error: '已有爬取在进行' };
    crawlAbort = new AbortController();
    const rawPath = join(dataDir, 'raw.json');
    const ckptPath = join(dataDir, 'crawl-checkpoint.json');
    try {
      const target = parseShareUrl(url);
      const saved = resume && existsSync(ckptPath)
        ? (JSON.parse(readFileSync(ckptPath, 'utf8')) as CrawlCheckpoint)
        : undefined;

      let last = 0;
      const { dump, meta } = await crawlShare({
        target,
        signal: crawlAbort.signal,
        resume: saved,
        onProgress: (p) => {
          const now = Date.now();
          if (now - last < 200) return;
          last = now;
          send('crawl-progress', p);
        },
        onCheckpoint: (c) => writeJson('crawl-checkpoint.json', c),
      });

      const prev = existsSync(rawPath) ? (JSON.parse(readFileSync(rawPath, 'utf8')) as RawShareDump) : undefined;
      const diff = prev ? diffDumps(prev, dump) : undefined;

      writeJson('raw.json', dump);
      writeJson('meta.json', meta);
      if (existsSync(ckptPath)) rmSync(ckptPath);

      // 爬完直接重建索引，用户不用再点一次。把旧索引传进去以保留 OCR 关联。
      const next = buildIndex(dump, { meta: mergeMeta(meta), previous: idx ?? undefined });
      idxPath = writeJson('index.full.json', next);
      writeJson('index.lean.json', toLean(next));
      // 磁盘保留机器解析结果，用户校正只在本机运行时叠加。
      applyBookOverrides(next, bookOverrides);
      idx = next;

      return { ok: true, diff, stats: next.stats, meta: next.meta };
    } catch (e) {
      const msg = (e as Error).message;
      return { ok: false, error: msg, aborted: msg === 'aborted', canResume: existsSync(ckptPath) };
    } finally {
      crawlAbort = null;
    }
  });

  ipcMain.handle('crawl-cancel', () => { crawlAbort?.abort(); return true; });

  ipcMain.handle('open-external', (_e, url: string) => {
    if (!allowedExternal(url)) return false;
    void shell.openExternal(url);
    return true;
  });

  ipcMain.handle('show-in-folder', (_e, p: string) => {
    if (!insideDownloadDir(p)) return false;
    shell.showItemInFolder(p);
    return true;
  });

  ipcMain.handle('pick-data-dir', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: '选择索引数据目录' });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    const dir = r.filePaths[0];
    if (!existsSync(join(dir, 'index.full.json'))) return { ok: false, error: `${dir} 里没有 index.full.json` };
    dataDir = dir;
    idxPath = join(dir, 'index.full.json');
    idx = JSON.parse(readFileSync(idxPath, 'utf8')) as GazetteerIndex;
    applyBookOverrides(idx, bookOverrides);
    settings.dataDir = dir;
    saveSettings();
    return { ok: true, dataDir, stats: idx.stats, meta: idx.meta, crawledAt: idx.crawledAt };
  });

  ipcMain.handle('cookie-info', () => cookies.describe());
  ipcMain.handle('cookie-set', (_e, raw: string) => {
    try {
      cookies.set(raw);
      clearSocialToken();
      downloads.resumePending();
      return { ok: true, ...cookies.describe() };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  ipcMain.handle('cookie-clear', () => {
    cookies.clear();
    clearSocialToken();
    return cookies.describe();
  });
  ipcMain.handle('cookie-test', () => (cookies.has() ? probeLogin(cookies.get()) : { ok: false, message: '还没配置 cookie' }));

  ipcMain.handle('dl-list', () => downloads.list());
  ipcMain.handle('dl-enqueue', (_e, items: DlItem[]) => { downloads.enqueue(items); return downloads.list(); });
  ipcMain.handle('dl-cancel', (_e, fid?: string) => { downloads.cancel(fid); return downloads.list(); });
  ipcMain.handle('dl-retry', (_e, fid: string) => { downloads.retry(fid); return downloads.list(); });
  ipcMain.handle('dl-info', () => ({ dir: settings.downloadDir }));

  /** 这些 fid 里哪些已经在本地了。详情面板据此把「下载本书」换成「更新本书」。 */
  ipcMain.handle('dl-local', (_e, fids: string[]) => {
    const want = new Set(fids);
    const deps = readerDeps();
    const out: string[] = [];
    for (const rec of idx?.files ?? []) {
      if (want.has(rec.fid) && findLocalPath(deps, rec)) out.push(rec.fid);
    }
    return out;
  });
  ipcMain.handle('dl-dir', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], title: '选择下载保存目录' });
    if (r.canceled || !r.filePaths[0]) return { ok: false, dir: settings.downloadDir };
    settings.downloadDir = r.filePaths[0];
    saveSettings();
    return { ok: true, dir: settings.downloadDir };
  });

  /** 控制面：告诉渲染进程「能不能读、走本地还是在线、拿哪个 URL」。数据面走 fzpdf:// */
  ipcMain.handle('reader-resolve', (_e, fid: string) => {
    const rec = idx?.files.find((f) => f.fid === fid);
    if (!rec) return { ok: false, error: '索引里没有这个文件' };
    if (rec.ext !== 'pdf') return { ok: false, error: `内置阅读器只支持 PDF，这是 .${rec.ext}` };
    if (rec.isArchivePart) return { ok: false, error: '这是分卷文件，请下载整组后阅读' };
    const url = `fzpdf://read?fid=${encodeURIComponent(fid)}`;
    if (findLocalPath(readerDeps(), rec)) return { ok: true, mode: 'local', size: rec.size, url };
    if (!cookies.has()) return { ok: false, needCookie: true };
    return { ok: true, mode: 'online', size: rec.size, url };
  });

  /** OCR 文本：控制面拿目录信息，数据面按页取，正文不进渲染进程内存一次到底。 */
  ipcMain.handle('ocr-info', (_e, fid: string) => ocr.info(fid));
  ipcMain.handle('ocr-page', (_e, fid: string, p: number, q?: string) => ocr.page(fid, p, q));
  ipcMain.handle('ocr-search', (_e, fid: string, q: string) => ocr.search(fid, q));
  // 全库全文检索走独立线程；同一时间只跑一条，新查询顶掉旧查询。
  ipcMain.handle('search-text', (_e, q: string) => fulltext.search(q));
  /** 倒排索引：状态用于界面展示，重建放线程里跑并推进度。 */
  ipcMain.handle('text-index-status', () => {
    const i = loadTextIndex(dataDir);
    return {
      built: !!i,
      meta: i?.meta ?? null,
      stale: i ? [...i.stale] : [],
      textFiles: (idx?.files ?? []).filter((f) => !!f.textRef).length,
      bytes: (() => {
        try {
          return statSync(join(dataDir, '.text-index', 'index.bin')).size;
        } catch {
          return 0;
        }
      })(),
    };
  });
  ipcMain.handle('text-index-build', () => textIndexBuilder.build());
  ipcMain.handle('ocr-summary', () => {
    const files = idx?.files ?? [];
    return {
      totalFiles: files.length,
      textFiles: files.filter((f) => !!f.textRef).length,
      doneFiles: files.filter((f) => f.ocrStatus === 'done').length,
      doneBooks: idx?.books.filter((b) => b.ocrDone > 0).length ?? 0,
      totalBooks: idx?.books.length ?? 0,
    };
  });
  ipcMain.handle('open-ocr-folder', async () => {
    const dir = join(dataDir, 'ocr');
    mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    return err ? { ok: false, error: err } : { ok: true, dir };
  });

  /** 内置识别任务：启动前先探测运行时，跑完自动重载索引。 */
  ipcMain.handle('ocr-runner-status', () => ocrRunner.status());
  ipcMain.handle('ocr-runner-start', (_e, opts: Parameters<typeof ocrRunner.start>[0]) => ocrRunner.start(opts));
  ipcMain.handle('ocr-runner-cancel', () => ocrRunner.cancel());

  /** 书签与最近阅读：只存在本机，不进索引，跟随用户目录走。 */
  ipcMain.handle('marks-list', () => library.list());
  ipcMain.handle('mark-toggle', (_e, fid: string, page: number) => library.toggleMark(fid, page));
  ipcMain.handle('mark-remove', (_e, id: string) => library.removeMark(id));
  ipcMain.handle('recent-touch', (_e, fid: string, page: number) => library.touch(fid, page));
  ipcMain.handle('recent-list', () => library.list().recent);
  ipcMain.handle('recent-clear', () => library.clearRecent());
}

/** 爬取拿到的 meta 缺 shareUrl 之外的字段时，沿用旧索引里的。 */
function mergeMeta(m: IndexMeta): IndexMeta {
  const old = idx?.meta;
  return {
    ...m,
    shareTitle: m.shareTitle || old?.shareTitle || '',
    author: m.author ?? old?.author,
    expiredAt: m.expiredAt ?? old?.expiredAt,
  };
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: '方志检索',
    backgroundColor: '#14161a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(resolve(__dirname, '..', 'renderer', 'index.html'));

  win.webContents.on('will-navigate', (e, url) => {
    // 站内跳转之外一律拦截；只有夸克官方 HTTPS 地址才交给系统浏览器。
    if (url.startsWith('file://')) return;
    e.preventDefault();
    if (allowedExternal(url)) void shell.openExternal(url);
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  loadSettings();
  bookOverrides = loadBookOverrides();
  const r = loadIndex();
  cookies = new CookieStore(app.getPath('userData'));
  downloads = new DownloadManager({
    cookie: () => cookies.get(),
    shareUrl: () => idx?.meta?.shareUrl ?? '',
    destDir: () => settings.downloadDir,
    emit: (s) => send('dl-progress', s),
  });
  downloads.restore();
  if (cookies.has()) downloads.resumePending();
  ocrRunner = createOcrRunner({
    scriptPath: () => resolveOcrScript().script,
    cwd: () => resolveOcrScript().cwd,
    dataDir: () => dataDir,
    downloadDir: () => settings.downloadDir,
    onProgress: (s) => send('ocr-progress', s),
    onFinished: (ok, note) => {
      if (ok) {
        reloadIndexFromDisk();
        // 新识别的文本还没进倒排索引：登记失效，检索时按未覆盖整篇重扫，
        // 不必为了这一本书重建全量索引（重建可以从「工具 → 全文索引」手动触发）。
        const done = ocrRunner?.doneFids?.() ?? [];
        if (done.length) invalidateTextIndexFiles(dataDir, done);
      }
      send('ocr-done', { ok, note });
    },
  });
  library = createLibrary(join(app.getPath('userData'), 'library.json'), { index: () => idx });
  registerIpc();
  registerReader(readerDeps());
  createWindow();
  if (!r.ok) dialog.showErrorBox('索引未就绪', r.error ?? '');

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  // worker 线程不会自己退出，退出前显式收掉，避免残留进程
  app.on('before-quit', () => fulltext.dispose());
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
