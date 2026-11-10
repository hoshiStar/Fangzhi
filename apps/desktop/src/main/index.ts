import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildIndex, computeFacets, getBook, search, toLean } from '@fangzhi/core';
import type { GazetteerIndex, RawShareDump, IndexMeta, LeanIndex } from '@fangzhi/core';
import { crawlShare, diffDumps, parseShareUrl } from '@fangzhi/core/crawl';
import type { CrawlCheckpoint } from '@fangzhi/core/crawl';
import { probeLogin } from '@fangzhi/core/download';
import type { SearchFilters } from '@fangzhi/core';
import { CookieStore } from './cookies.ts';
import { DownloadManager } from './download.ts';
import type { DlItem } from './download.ts';
import { localPath, registerReader, registerReaderSchemes } from './reader.ts';
import type { ReaderDeps } from './reader.ts';
import { createOcrReader } from './ocr.ts';

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
  const candidates = [userDir];
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
let settings: { downloadDir: string } = { downloadDir: '' };

function settingsPath(): string { return join(app.getPath('userData'), 'settings.json'); }

function loadSettings(): void {
  try {
    settings = { ...settings, ...(JSON.parse(readFileSync(settingsPath(), 'utf8')) as object) };
  } catch { /* 首次运行没有设置文件 */ }
  // 默认落在系统「下载」文件夹下的独立子目录：用户找得到，开发版和打包版也共用同一处，
  // 不会因为 app name 不同（@fangzhi/desktop vs 方志检索）各存一份、互相看不见。
  if (!settings.downloadDir) settings.downloadDir = join(app.getPath('downloads'), '方志检索');
}

function saveSettings(): void { writeFileSync(settingsPath(), JSON.stringify(settings, null, 2)); }

function writeJson(file: string, data: unknown): string {
  mkdirSync(dataDir, { recursive: true });
  const p = join(dataDir, file);
  writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data));
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
    return { ok: true };
  } catch (e) {
    idx = null;
    return { ok: false, error: `索引损坏: ${(e as Error).message}` };
  }
}

function send(channel: string, payload: unknown): void {
  win?.webContents.send(channel, payload);
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

function registerIpc(): void {
  ipcMain.handle('info', () => ({
    dataDir,
    hasIndex: !!idx,
    meta: idx?.meta,
    stats: idx?.stats,
    crawledAt: idx?.crawledAt,
    version: app.getVersion(),
  }));

  ipcMain.handle('search', (_e, q: string, filters: SearchFilters, limit: number, offset: number) => {
    if (!idx) return { total: 0, items: [], elapsedMs: 0, facets: { province: {}, era: {}, zhiType: {}, ext: {} } };
    return search(idx, q, { ...filters, limit, offset });
  });

  ipcMain.handle('book', (_e, id: string) => (idx ? getBook(idx, id) : undefined));

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

      // 爬完直接重建索引，用户不用再点一次
      const next = buildIndex(dump, { meta: mergeMeta(meta) });
      idxPath = writeJson('index.full.json', next);
      writeJson('index.lean.json', toLean(next));
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

  ipcMain.handle('open-external', (_e, url: string) => { shell.openExternal(url); return true; });

  ipcMain.handle('show-in-folder', (_e, p: string) => { shell.showItemInFolder(p); return true; });

  ipcMain.handle('pick-data-dir', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: '选择索引数据目录' });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    const dir = r.filePaths[0];
    if (!existsSync(join(dir, 'index.full.json'))) return { ok: false, error: `${dir} 里没有 index.full.json` };
    dataDir = dir;
    idxPath = join(dir, 'index.full.json');
    idx = JSON.parse(readFileSync(idxPath, 'utf8')) as GazetteerIndex;
    return { ok: true, dataDir, stats: idx.stats, meta: idx.meta, crawledAt: idx.crawledAt };
  });

  ipcMain.handle('cookie-info', () => cookies.describe());
  ipcMain.handle('cookie-set', (_e, raw: string) => {
    try {
      cookies.set(raw);
      return { ok: true, ...cookies.describe() };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  ipcMain.handle('cookie-clear', () => { cookies.clear(); return cookies.describe(); });
  ipcMain.handle('cookie-test', () => (cookies.has() ? probeLogin(cookies.get()) : { ok: false, message: '还没配置 cookie' }));

  ipcMain.handle('dl-list', () => downloads.list());
  ipcMain.handle('dl-enqueue', (_e, items: DlItem[]) => { downloads.enqueue(items); return downloads.list(); });
  ipcMain.handle('dl-cancel', (_e, fid?: string) => { downloads.cancel(fid); return downloads.list(); });
  ipcMain.handle('dl-info', () => ({ dir: settings.downloadDir }));

  /** 这些 fid 里哪些已经在本地了。详情面板据此把「下载本书」换成「更新本书」。 */
  ipcMain.handle('dl-local', (_e, fids: string[]) => {
    const want = new Set(fids);
    const deps = readerDeps();
    const out: string[] = [];
    for (const rec of idx?.files ?? []) {
      if (want.has(rec.fid) && existsSync(localPath(deps, rec))) out.push(rec.fid);
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
    const local = localPath(readerDeps(), rec);
    if (existsSync(local)) return { ok: true, mode: 'local', size: rec.size, url };
    if (!cookies.has()) return { ok: false, needCookie: true };
    return { ok: true, mode: 'online', size: rec.size, url };
  });

  /** OCR 文本：控制面拿目录信息，数据面按页取，正文不进渲染进程内存一次到底。 */
  ipcMain.handle('ocr-info', (_e, fid: string) => ocr.info(fid));
  ipcMain.handle('ocr-page', (_e, fid: string, p: number, q?: string) => ocr.page(fid, p, q));
  ipcMain.handle('ocr-search', (_e, fid: string, q: string) => ocr.search(fid, q));
  ipcMain.handle('search-text', (_e, q: string) => ocr.searchAll(q));
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
      sandbox: false,
    },
  });

  win.loadFile(resolve(__dirname, '..', 'renderer', 'index.html'));

  win.webContents.on('will-navigate', (e, url) => {
    // 站内跳转之外一律丢给系统浏览器，避免窗口被外链顶掉
    if (!url.startsWith('file://')) { e.preventDefault(); shell.openExternal(url); }
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  const r = loadIndex();
  loadSettings();
  cookies = new CookieStore(app.getPath('userData'));
  downloads = new DownloadManager({
    cookie: () => cookies.get(),
    shareUrl: () => idx?.meta?.shareUrl ?? '',
    destDir: () => settings.downloadDir,
    emit: (s) => send('dl-progress', s),
  });
  registerIpc();
  registerReader(readerDeps());
  createWindow();
  if (!r.ok) dialog.showErrorBox('索引未就绪', r.error ?? '');

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
