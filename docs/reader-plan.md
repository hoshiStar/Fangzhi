# 内置 PDF 阅读器 —— 实现方案与交接文档

> 面向接手的 agent。读完这一篇就能直接开工，不需要回溯之前的对话。
> 本文所有代码签名、行号、文件路径都已在 `D:\AI\fangzhi` 当前代码上核对过（2026-11-10）。

---

## 0. 一句话任务

给方志检索桌面版加一个**内置 PDF 阅读器**：在书目的文件列表里，每个 PDF 后面加一个「阅读」按钮，点开就能在应用内直接翻页看正文——**在线直读**（不要求先下载），已下载到本地的文件则自动走本地。

---

## 1. 背景（项目是什么）

- 项目：查询夸克网盘分享 `https://pan.quark.cn/s/2d5c2ddfe25b` 的工具，内容是一套约 **4600 个文件 / 101GB 的中国地方志合集**（PDF 为主）。
- 形态：Electron 桌面应用（monorepo，npm workspaces）。
  - `packages/core`：纯 TS 库（解析 / 索引 / 检索 / 爬取 / 下载协议）。
  - `apps/desktop`：Electron（main + preload + renderer，renderer 是手写 TS，无框架）。
  - `apps/miniprogram`：微信小程序只读检索版（另一条线，未完成，见 §10）。
- 技术栈定调：**TS 主线 + Python OCR 支线**。
- 索引规模：`data/index.full.json` 里 `stats.fileCount = 4600`，`byExt.pdf = 4404`。文件记录在**顶层 `idx.files`**（不是 `books[].files`；`books[].fileIds` 只是引用）。

数据结构（`packages/core/src/types.ts` 的 `FileRecord`，与阅读器相关的字段）：

```ts
interface FileRecord {
  fid: string;          // 夸克文件 id，主键
  pdirFid: string;      // 父目录 fid，刷新 share_fid_token 时要用
  shareFidToken: string;// 换直链用，绑定签发它的 stoken，会过期 → 必须在线重取（见 §4）
  name: string;         // 网盘原始文件名（含空格/中文，落盘前要 sanitize）
  size: number;
  ext: ExtKind;         // 'pdf' | 'djvu' | 'doc' | 'txt' | 'rar' | 'zip' | 'uvz' | 'exe' | 'other'
  isNoise: boolean;     // 垃圾文件（须知/exe/新建文本文档），检索默认排除
  isArchivePart: boolean;// rar/zip 分卷的一部分
  ocrStatus: OcrStatus; // 全文预留
  textRef?: string;
}
```

**阅读器只做 `ext === 'pdf'`。** djvu/doc/rar 等不能直接渲染，按钮不显示。

---

## 2. 已选方案：在线直读（用户拍板）

用户在被问到「PDF 来源」时选了 **「在线直读（推荐）」**：

- 点「阅读」→ 应用直接向夸克换一条下载直链 → 边下边喂给 PDF.js 渲染，**不需要先把整本下到磁盘**。
- **本地优先**：如果这个文件之前已经下载到 `settings.downloadDir`，直接读本地文件，不碰网络、不需要 cookie。
- 好处：4600 个文件不可能全下；用户想翻哪本就翻哪本。

---

## 3. 安全不变量（必须遵守，不可协商）

下载用的 cookie 是**用户本人的夸克登录态**，处理原则和已完成的下载功能一致：

1. **cookie 只存在于 main 进程**。用 `safeStorage` 加密落在 `userData/quark-cookie.enc`（见 `apps/desktop/src/main/cookies.ts`）。
2. **渲染进程永远拿不到 cookie 值**，只能通过 `cookie-info` 拿到「有没有 + 名字列表 + 字节数」（`CookieStore.describe()`）。
3. **`fzpdf://` 这个 URL 里只能出现非机密信息**——建议**只放 `fid`**（`fzpdf://read?fid=<fid>`）。文件名、pdirFid、直链、cookie 全部由 main 端从 `idx` 现查，不进 URL。
4. cookie **绝不**写进索引 / dataDir / 任何会被拷走或上传的地方；小程序端**绝不**托管 cookie。

在线直读的字节流全程在 main 进程内代理（main 拿着 cookie 去 CDN 取，再把流交给渲染进程的 PDF.js），渲染进程只看到一个 `fzpdf://` URL，看不到 cookie，也看不到真实 CDN 直链。

---

## 4. 夸克下载协议的关键坑（血泪教训，务必照做）

这些是下载功能（已完成）里踩过并修好的坑，阅读器复用同一套协议，会原样遇到：

- **`share_fid_token` 会过期且绑定 stoken 会话**。索引里存的 `shareFidToken` 是爬取那一刻签发的，直接拿去换直链会报 **41020「转存文件 token 校验异常」**。
  - 修法：换直链前，**用当前 stoken 在线重取** `share_fid_token`（`refreshShareFidTokens`），再拿新 token 去 `fetchDownloadLinks`。下载功能已这么修好并**用真实 cookie 验证过**（30047 字节文件字节级一致）。
- **stoken 也会过期**（错误码 41005 或消息含 `stoken`）→ 清空 stoken 缓存、重取一次、再试，不算失败。
- **`fetchDownloadLinks` 是封号最敏感的接口**。下载功能的设计原则是：串行、批间 sleep 1s、一次最多 15 个 fid。
  - 阅读器必须遵守同样的克制：**一次「打开」只换一次直链**，之后的 Range 分段请求**复用缓存的直链**，不要每个 Range 都去打 link 接口。只有 CDN 返回 **403/412**（直链失效）时才重取一次。
- CDN 直链有 TTL，可能**读到一半过期**。见 §6 的缓解策略。

---

## 5. 可直接复用的现有代码（签名 + 出处，已核对）

### 5.1 `packages/core/src/crawl.ts`

```ts
// :19
export function parseShareUrl(url: string): CrawlTarget;         // CrawlTarget { pwdId, passcode? }
// :113
export async function fetchShareToken(target: CrawlTarget, signal?: AbortSignal): Promise<ShareToken>; // ShareToken { stoken, title?, author?, expiredAt? }
// :126
export interface ShareFidTokenRef { fid: string; pdirFid: string; }
// :136  —— 换直链前在线刷新 share_fid_token，按父目录分组、分页、找齐即停
export async function refreshShareFidTokens(opts: {
  target: CrawlTarget; stoken: string; files: ShareFidTokenRef[]; signal?: AbortSignal;
}): Promise<Map<string, string>>;                                // fid -> 新鲜 share_fid_token
// :81
export class QuarkShareError extends Error { code: number; needLogin: boolean; }
```

> 注意：`crawl.ts` **没有**从 `packages/core/src/index.ts` 再导出（刻意，避免小程序 bundle 受爬取改动影响）。main 里要用请走子路径 `@fangzhi/core/crawl`（现有 `apps/desktop/src/main/index.ts:6` 就是这么 import 的）。

### 5.2 `packages/core/src/download.ts`

```ts
// :10
export const QUARK_UA = 'Mozilla/5.0 ... QuarkPC/6.9.7.761 ...'; // 取直链/CDN 认这个 PC 客户端 UA，普通浏览器 UA 拿不到链
// :26 / :31
export interface LinkRequest { fid: string; shareFidToken: string; }
export interface DownloadLink { fid: string; fileName: string; size: number; url: string; }
// :84
export async function fetchDownloadLinks(opts: {
  target: CrawlTarget; stoken: string; cookie: string; files: LinkRequest[]; signal?: AbortSignal;
}): Promise<DownloadLink[]>;
// :50 / :70
export async function acquireSocialToken(cookie: string, signal?: AbortSignal): Promise<string>;
export async function probeLogin(cookie: string): Promise<{ ok: boolean; message: string }>;
```

从 `@fangzhi/core/download` 导入（现有 `main/index.ts:8` 已导入 `probeLogin`）。

### 5.3 `apps/desktop/src/main/download.ts`（下载管理器，参考它的 stoken/token 缓存写法）

- `sanitize`（当前是模块内私有函数，**建议 export 出来给阅读器复用**，避免落盘命名规则漂移）：
  ```ts
  const sanitize = (n: string): string =>
    n.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '_').trim() || 'download';
  ```
- 下载落盘路径 = `join(settings.downloadDir, sanitize(rec.name))`。阅读器的**本地优先**要用**完全相同**的规则去找已下载文件。
- `DownloadManager.links(target, it)` / `.token(target)` 展示了正确的调用序列：`token()`（stoken 按 pwdId 缓存）→ `refreshShareFidTokens` → `fetchDownloadLinks`，并在 41005/stoken 过期时清 stoken 重试一次。阅读器的 `resolveLink` 照抄这个序列即可。

### 5.4 `apps/desktop/src/main/cookies.ts`

```ts
class CookieStore {
  constructor(dir: string);              // dir = app.getPath('userData')
  get(): string;                         // 明文 cookie（仅 main 内部用）
  has(): boolean;
  set(raw: string): void; clear(): void;
  describe(): { has: boolean; names: string[]; bytes: number }; // 给渲染进程的唯一出口
}
```

### 5.5 main 里的现成上下文（`apps/desktop/src/main/index.ts`）

- `idx: GazetteerIndex | null`（模块级），`idx.files` 是全部文件记录，`idx.meta.shareUrl` 是分享链接。
- `settings.downloadDir`（默认 `join(app.getPath('userData'), 'downloads')`，见 `loadSettings()` :44）。
- `cookies: CookieStore`、`downloads: DownloadManager` 都在 `app.whenReady().then(...)`（:232）里创建。
- IPC 都在 `registerIpc()`（:80）里 `ipcMain.handle(...)` 注册。
- 窗口 `webPreferences`：`contextIsolation: true, nodeIntegration: false, sandbox: false`（:215），preload = `dist/preload/index.cjs`。

---

## 6. 架构设计

### 6.1 总览

```
renderer (PDF.js)                main (Node/Electron)                 Quark
─────────────────                ────────────────────                 ─────
getDocument({url:                 protocol.handle('fzpdf')
  'fzpdf://read?fid=X'})  ──►     1. idx.files 查 fid → rec
     │  (Range 请求)              2. 本地存在? → 读盘 serveLocal
     │                            3. 否则在线: resolveLink(fid)
     │                               token → refreshShareFidTokens
     │                               → fetchDownloadLinks  ──────►  link API
     │                               (结果按 fid 缓存, TTL)
     │                            4. fetch(CDN url, {Cookie,UA,Range}) ─►  CDN
     ◄──── Response(206/200, 流) ─┘   (403/412 → 重取一次直链再试)
```

关键点：**渲染进程只发 `fzpdf://` 请求**；cookie、真实直链、文件名全在 main。

### 6.2 自定义协议 `fzpdf://`（greenfield，main 里目前没有任何 protocol/session/webRequest 代码）

Electron 44.3.0（`apps/desktop/package.json` devDep）支持 `protocol.handle`。两处注册，**时机不能错**：

1. **`app.whenReady()` 之前**（模块顶层）调用 `protocol.registerSchemesAsPrivileged`，把 `fzpdf` 声明为 `standard / secure / supportFetchAPI / stream / corsEnabled`。
2. **`app.whenReady()` 之后**调用 `protocol.handle('fzpdf', handler)`。

因为 renderer 是 `loadFile(...)`（`file://` origin），去 fetch `fzpdf://` 属于跨 origin，所以：
- scheme 要 `corsEnabled: true`，且 handler 每个响应都带 `Access-Control-Allow-Origin: *`。
- CSP 的 `connect-src` 要放行 `fzpdf:`（见 §7）。
- **兜底方案**（万一跨 origin fetch 仍被拦）：把 renderer 改成用自定义 `app://` scheme 加载（同样 `registerSchemesAsPrivileged` + `protocol.handle` 伺服 `dist/renderer`），这样页面 origin 是 `app://`，`fzpdf:` 就变成同站。这是 plan B，先试 plan A。

### 6.3 直链缓存（防封号 + 抗过期）

```
linkCache: Map<fid, { url, size, at }>   // TTL ~4 分钟，保守
stoken / stokenFor                        // 按 pwdId 缓存，照抄 DownloadManager.token
```

- 一次打开：第一个请求触发 `resolveLink`（打一次 link API），结果进缓存。
- 后续 Range 请求：命中缓存直接复用，**不再打 link API**。
- CDN 返回 403/412：`linkCache.delete(fid)` + 重取一次 + 重试该请求。
- 缓解「读到一半直链过期」：TTL 到期后下次请求自动重取；PDF.js 对单个失败的 Range 不一定会自动重试，若出现中途报错，可在 handler 里对 403/412 做一次透明重取重试（上面已含）。这属于已知局限，先做到「重取一次」，够用。

### 6.4 控制面 vs 数据面分离

- **控制面走 IPC**：新增 `reader-resolve(fid)`，返回结构化结果 `{ ok, mode:'local'|'online', size, url }` 或 `{ ok:false, needCookie:true }` / `{ ok:false, error }`。renderer 用它来判断「要不要弹 cookie 框」「是不是 PDF」「拿 fzpdf url」。
- **数据面走协议**：`fzpdf://` 只管流字节。
- 这样错误能结构化返回，而不是让 PDF.js 去解析一个失败的 fetch。

---

## 7. 具体改动清单（按文件）

### 7.1 新文件 `apps/desktop/src/main/reader.ts`

 owns `fzpdf://` handler + 直链缓存 + `resolveLink` + `reader-resolve` 的实现体。依赖用参数注入（cookie/downloadDir/index/shareUrl），不要去 import main 的模块级变量，保持可测。**起点骨架**（类型自己再校一遍）：

```ts
import { protocol } from 'electron';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { parseShareUrl, fetchShareToken, refreshShareFidTokens, QuarkShareError } from '@fangzhi/core/crawl';
import { fetchDownloadLinks, QUARK_UA } from '@fangzhi/core/download';
import type { GazetteerIndex, FileRecord } from '@fangzhi/core';
import { sanitize } from './download.ts'; // 需要先把 sanitize 从 download.ts export 出来

export interface ReaderDeps {
  hasCookie(): boolean;
  cookie(): string;
  downloadDir(): string;
  index(): GazetteerIndex | null;
  shareUrl(): string;
}

const linkCache = new Map<string, { url: string; size: number; at: number }>();
const LINK_TTL = 4 * 60_000;
let stoken = '', stokenFor = '';

// 必须在 app ready 之前（模块顶层）调用
export function registerReaderSchemes(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'fzpdf',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  }]);
}

const acao = (h: Headers) => { h.set('access-control-allow-origin', '*'); return h; };
const json = (status: number, obj: unknown) =>
  new Response(JSON.stringify(obj), { status, headers: acao(new Headers({ 'content-type': 'application/json' })) });

export function registerReader(deps: ReaderDeps): void {
  protocol.handle('fzpdf', async (req) => {
    const u = new URL(req.url);
    const fid = u.searchParams.get('fid') ?? u.pathname.replace(/^\//, '');
    const rec = deps.index()?.files.find((f) => f.fid === fid);
    if (!rec) return json(404, { error: '索引里没有这个文件' });
    if (rec.ext !== 'pdf') return json(415, { error: `只支持 PDF，这是 .${rec.ext}` });
    const range = req.headers.get('range') ?? undefined;

    // 1) 本地优先
    const local = join(deps.downloadDir(), sanitize(rec.name));
    if (existsSync(local)) return serveLocal(local, range);

    // 2) 在线直读
    if (!deps.hasCookie()) return json(401, { error: 'need-cookie' });
    try {
      const link = await resolveLink(deps, rec, false);
      return await serveRemote(deps, link.url, range, () => resolveLink(deps, rec, true));
    } catch (e) {
      const status = e instanceof QuarkShareError && e.needLogin ? 401 : 502;
      return json(status, { error: (e as Error).message });
    }
  });
}

async function resolveLink(deps: ReaderDeps, rec: FileRecord, force: boolean) {
  const cached = linkCache.get(rec.fid);
  if (!force && cached && Date.now() - cached.at < LINK_TTL) return cached;
  const go = async () => {
    const target = parseShareUrl(deps.shareUrl());
    if (!stoken || stokenFor !== target.pwdId) { stoken = (await fetchShareToken(target)).stoken; stokenFor = target.pwdId; }
    const fresh = await refreshShareFidTokens({ target, stoken, files: [{ fid: rec.fid, pdirFid: rec.pdirFid }] });
    const tok = fresh.get(rec.fid);
    if (!tok) throw new Error('没能刷新 share_fid_token，文件可能已被移出分享');
    const links = await fetchDownloadLinks({ target, stoken, cookie: deps.cookie(), files: [{ fid: rec.fid, shareFidToken: tok }] });
    if (!links[0]) throw new Error('服务端没给直链');
    const entry = { url: links[0].url, size: links[0].size, at: Date.now() };
    linkCache.set(rec.fid, entry);
    return entry;
  };
  try { return await go(); }
  catch (e) {
    if (e instanceof QuarkShareError && (e.code === 41005 || /stoken/i.test(e.message))) { stoken = ''; return go(); }
    throw e;
  }
}

function serveLocal(path: string, range?: string): Response {
  const size = statSync(path).size;
  const h = acao(new Headers({ 'content-type': 'application/pdf', 'accept-ranges': 'bytes' }));
  if (!range) {
    h.set('content-length', String(size));
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { status: 200, headers: h });
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  const start = m?.[1] ? Number(m[1]) : 0;
  const end = Math.min(m?.[2] ? Number(m[2]) : size - 1, size - 1);
  h.set('content-range', `bytes ${start}-${end}/${size}`);
  h.set('content-length', String(end - start + 1));
  return new Response(Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream, { status: 206, headers: h });
}

async function serveRemote(deps: ReaderDeps, url: string, range: string | undefined, refresh: () => Promise<{ url: string }>): Promise<Response> {
  const base: Record<string, string> = { 'user-agent': QUARK_UA, cookie: deps.cookie() };
  if (range) base.range = range;
  let res = await fetch(url, { headers: base });
  if (res.status === 403 || res.status === 412) res = await fetch((await refresh()).url, { headers: base });
  const h = acao(new Headers({ 'accept-ranges': 'bytes', 'content-type': res.headers.get('content-type') || 'application/pdf' }));
  for (const k of ['content-length', 'content-range']) { const v = res.headers.get(k); if (v) h.set(k, v); }
  return new Response(res.body, { status: res.status, headers: h });
}
```

### 7.2 `apps/desktop/src/main/download.ts`

把 `sanitize` 改成 `export const sanitize = ...`（当前是私有）。其余不动。

### 7.3 `apps/desktop/src/main/index.ts`

- 顶层（import 之后、`app.whenReady` 之前）：`import { registerReaderSchemes, registerReader } from './reader.ts'; registerReaderSchemes();`
- `registerIpc()` 里加：
  ```ts
  ipcMain.handle('reader-resolve', (_e, fid: string) => {
    const rec = idx?.files.find((f) => f.fid === fid);
    if (!rec) return { ok: false, error: '索引里没有这个文件' };
    if (rec.ext !== 'pdf') return { ok: false, error: `内置阅读器暂只支持 PDF，这是 .${rec.ext}` };
    if (rec.isArchivePart) return { ok: false, error: '这是分卷文件，请下载整组后阅读' };
    const url = `fzpdf://read?fid=${fid}`;
    const local = join(settings.downloadDir, sanitize(rec.name)); // 记得 import { sanitize } from './download.ts'
    if (existsSync(local)) return { ok: true, mode: 'local', size: rec.size, url };
    if (!cookies.has()) return { ok: false, needCookie: true };
    return { ok: true, mode: 'online', size: rec.size, url };
  });
  ```
- `app.whenReady().then(...)` 里，`downloads = new DownloadManager(...)` 之后加：
  ```ts
  registerReader({
    hasCookie: () => cookies.has(),
    cookie: () => cookies.get(),
    downloadDir: () => settings.downloadDir,
    index: () => idx,
    shareUrl: () => idx?.meta?.shareUrl ?? '',
  });
  ```

### 7.4 `apps/desktop/src/preload/index.ts`

`api` 对象里加一行（注意 `dlEnqueue` 的类型注解当前**漏了 `pdirFid`**——运行时对象原样透传不影响功能，但既然在改这个文件，顺手补上 `pdirFid: string` 与 renderer 侧保持一致）：

```ts
readerResolve: (fid: string) => ipcRenderer.invoke('reader-resolve', fid),
```

### 7.5 `apps/desktop/src/renderer/app.ts`

- 顶部 `window.fz` 的接口声明（`dlEnqueue` 那处，:20 附近）加：
  ```ts
  readerResolve(fid: string): Promise<{ ok: boolean; mode?: 'local' | 'online'; size?: number; url?: string; needCookie?: boolean; error?: string }>;
  ```
- 文件行渲染（`selectBook` 内，:193 的 `d.files.map(...)`）：在每个 `.file` 里，当 `f.ext === 'pdf' && !f.isArchivePart` 时追加一个按钮：
  ```ts
  ${f.ext === 'pdf' && !f.isArchivePart ? `<button class="read" data-fid="${f.fid}">阅读</button>` : ''}
  ```
- `selectBook` 设完 `innerHTML` 后（:196 附近给 `#d-share` 绑 onclick 的地方），给所有 `.read` 绑定点击 → `openReader(fid)`。
- 新增 `openReader(fid)`：
  ```ts
  async function openReader(fid: string): Promise<void> {
    const r = await window.fz.readerResolve(fid);
    if (!r.ok) {
      if (r.needCookie) { void cookieModal('在线阅读需要夸克 cookie（已下载的本地文件无需 cookie）。'); return; }
      // 用现有的 modal/toast 机制提示 r.error
      return;
    }
    showReaderOverlay(r.url!, r.mode === 'local'); // 见 §7.6
  }
  ```
- `cookieModal` 已存在（:284），直接复用。

### 7.6 renderer 阅读器 UI（overlay + PDF.js）

- 建议**自己写一个极简 canvas 翻页器**，用 PDF.js 的**核心 API**（`getDocument` + 逐页 `page.render(canvas)`），而不是引入 pdf.js 那套重型 `viewer.mjs`（viewer 会要 `'unsafe-inline'` 样式、CSS 一堆，跟本项目手写风格不搭）。
- 在 `index.html` 加一个全屏 overlay（参考现有 `#modal` :33 / `#detail` :51 的写法），放：`<canvas>` + 上一页/下一页/页码输入/缩放/关闭。样式加进 `style.css`。
- 加载：
  ```ts
  import * as pdfjsLib from 'pdfjs-dist';
  pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs'; // 见 §7.7 拷贝
  const doc = await pdfjsLib.getDocument({ url, isEvalSupported: false }).promise;
  // 逐页 render 到 canvas；翻页时按需 renderPage(n)
  ```
- `isEvalSupported: false` 让 CSP 不必开 `'unsafe-eval'`。

### 7.7 `apps/desktop/scripts/build.mjs`

renderer 那一段 esbuild（:34）：
- `external` 从 `['electron']` 扩到 `['electron', 'canvas']`（pdfjs-dist 的 node 可选依赖 `canvas` 在浏览器构建里要排除，否则 bundle 报错）。
- 在末尾 `cpSync(index.html/style.css)`（:44-45）旁边，把 PDF.js worker 拷进 `dist/renderer`：
  ```js
  // 文件名以安装版本为准：pdf.worker.min.mjs（v4）；用 createRequire 解析更稳，别硬编 node_modules 路径
  cpSync(fileURLToPath(import.meta.resolve('pdfjs-dist/build/pdf.worker.min.mjs')),
         'dist/renderer/pdf.worker.min.mjs');
  ```
  > `import.meta.resolve` 若因 pdfjs-dist 的 `exports` 限制解析不到，改用 `createRequire(import.meta.url).resolve('pdfjs-dist/build/pdf.worker.min.mjs')`，或直接指向 workspace 根 `../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs`（npm workspaces 会把 pdfjs-dist 提升到根 `node_modules`）。**装好后先确认 worker 的确切文件名再拷。**

### 7.8 `apps/desktop/src/renderer/index.html`（CSP，第 6 行）

当前：
```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
```
改为（加 worker / connect / font，放宽 img 到 blob:）：
```
default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self' fzpdf:; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data:;
```
- `connect-src fzpdf:` —— PDF.js（及其 worker）fetch 直链流。
- `worker-src 'self'` —— 加载 `./pdf.worker.min.mjs`。
- 若控制台报 CSP eval/wasm 错，再给 `script-src` 补 `'wasm-unsafe-eval'`（PDF.js 某些 PDF 的字体/wasm 路径会要）。

### 7.9 依赖

`pdfjs-dist` **尚未安装**（`node_modules/pdfjs-dist` 不存在）。装到 `apps/desktop`：
```bash
cd /d/AI/fangzhi/apps/desktop && npm install -D pdfjs-dist
```
- 用 devDependency 即可：esbuild 会把它打进 `dist/renderer/app.js`，运行时不需要它作为 node 依赖（worker 是单独拷的文件）。
- **本机 GitHub 不可达**，但 **npm registry 可达**，pdfjs-dist 在 npm 上、无重型 postinstall，正常能装。若默认 registry 慢/失败，用镜像（见 §8）。
- 装完 `pdfjs-dist` 会带 `node_modules/pdfjs-dist/build/` 下的 `pdf.mjs` / `pdf.worker.min.mjs` 等；确认确切文件名。

---

## 8. 环境须知（本机专属，踩过的坑）

- **项目现在在 `D:\AI\fangzhi`**（已从 C: 迁移过来）。**上一个会话的 Qoder 工作区绑定的是已删除的 C: 路径**，所以：
  - 请在 Qoder 里**从 `D:\AI\fangzhi` 重新打开项目**再干活。
  - 所有文件操作用**绝对 D: 路径**。
- **Bash 每条命令后 cwd 会重置回 C:**（本会话现象）→ 每条命令自己 `cd /d/AI/fangzhi/...`。
- **不是 git 仓库**（`git rev-parse` 失败）。改动没有版本兜底，动手前先想清楚，或自行 `git init` 一个。
- **npm workspaces 的 junction**：`node_modules/@fangzhi/{core,desktop}` 是指向绝对路径的 Windows JUNCTION，迁移时已重建指向 D:。若你移动/重装导致失效，用 Node `fs.symlinkSync(target, link, 'junction')` 重建（**别用 `cmd //c mklink /J`**——Git Bash 的 MSYS 路径转换会把 `//c` 弄坏）。
- **构建 / 运行 / 类型检查**（都在 `apps/desktop` 下）：
  ```bash
  cd /d/AI/fangzhi/apps/desktop
  npm run build       # node scripts/build.mjs
  npm run dev         # build && electron .
  npm run typecheck   # tsc -p tsconfig.json --noEmit
  # 起可调试实例（CDP 验证用）：
  npx electron . --remote-debugging-port=9333
  ```
  core 的类型检查在根：`cd /d/AI/fangzhi && npm run typecheck`（= `tsc -p packages/core/tsconfig.json --noEmit`）。
- **Node 24 + TS**：`erasableSyntaxOnly` / `verbatimModuleSyntax` 生效——不要用 TS 独有语法糖（enum/namespace/参数属性），import 类型要 `import type`。源码里 import 带 `.ts` 后缀是本项目的既有风格（如 `./download.ts`）。
- **cookie / 下载 / settings 存在 C: 的 APPDATA**（`%APPDATA%\@fangzhi\desktop`，即 `app.getPath('userData')`），**不在仓库里**，迁移没动它 → 用户真实 cookie 和已下载文件都还在。
- **Windows 带 flag 的命令**（robocopy 的 `/E` 等）在 Git Bash 里会被 MSYS 路径转换搞坏 → 前缀 `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'`。
- **写文件到磁盘时 encoding 必须显式 `utf-8`**（Windows 默认 gbk 会写坏中文——OCR 支线踩过）。
- npm 镜像（GitHub 不可达时的兜底）：`gh-proxy.com/<gh-url>`、gitcode 镜像、npm registry 均可用。

### ⚠️ 绝对不要做的事

- **不要跑破坏性的 cookie 探测脚本**（`tools/cdp-probe.mjs` 里那种会 `cookie-set('a=1; b=2')` 再 `cookie-clear` 的检查）打到**正在运行的实例**上——那会**清掉用户本人的真实夸克 cookie**。验证登录态只用只读的 `cookie-test` / `cookie-info`。
- 不要把 cookie 打进日志、URL、索引、dataDir。

---

## 9. 验证方法（cookie-safe）

### 9.1 测试样本（已在当前 `data/index.full.json` 核对存在）

| 用途 | 文件名 | 大小 | fid | pdirFid |
|---|---|---|---|---|
| 快速冒烟（字节级/首屏） | `一统志18-671 000661.pdf` | 30047 B (~29KB) | `a7a72eaa40094b718fbd65b361215388` | `da1abe159a38424490d03829e78ba8cc` |
| Range / 流式分段 | `昌图县志（1-2册）.pdf` | 8.0 MB | `fd7ec4e13f664a09bbeaaafde893fcdf` | `924c516fa6db488ba8933ffd3ad46f4f` |

（另有 477MB 的《天津通志 旧志点校卷 上》，非必要别拿它测，太慢。）

### 9.2 验证步骤

1. **类型 + 构建**：`npm run typecheck`（desktop 与 core 都过）→ `npm run build` 退出 0 → 确认 `dist/renderer/pdf.worker.min.mjs` 被拷进去了。
2. **起实例**：`npx electron . --remote-debugging-port=9333`。
3. **CDP 驱动**（沿用项目既有手法）：`fetch('http://127.0.0.1:9333/json')` 拿 page 的 `webSocketDebuggerUrl` → 裸 WebSocket 发 `Runtime.evaluate` → 轮询 DOM。
   - 先 `cookie-test` 确认「登录态有效」（只读，安全）。
4. **协议单测**（不开 UI 也能验）：在 renderer 控制台或用 CDP evaluate：
   ```js
   const r = await fetch('fzpdf://read?fid=a7a72eaa40094b718fbd65b361215388');
   r.status;                                   // 期望 200（无 Range）
   r.headers.get('content-type');              // application/pdf
   r.headers.get('accept-ranges');             // bytes
   const buf = await r.arrayBuffer(); buf.byteLength; // ≈ 30047
   // 带 Range：
   const r2 = await fetch('fzpdf://read?fid=a7a72eaa40094b718fbd65b361215388', { headers: { Range: 'bytes=0-99' } });
   r2.status;                                  // 期望 206
   r2.headers.get('content-range');            // bytes 0-99/30047
   ```
5. **大文件 Range**：对 `fd7ec4e13f664a09bbeaaafde893fcdf` 发几个不同 `Range`，确认 206 + `content-range` 正确、`link API` 只被打了一次（看 main 日志或计数）。
6. **UI 端到端**：搜到含上面 PDF 的书目 → 打开详情 → 点该 PDF 行的「阅读」→ overlay 里能翻到第 1 页、下一页、跳页。
7. **本地优先**：先「下载本书」把某 PDF 下到 `settings.downloadDir`，再点「阅读」→ 应走本地（可临时断网或看 main 没有打 CDN）；`reader-resolve` 返回 `mode:'local'`。
8. **无 cookie**：`cookie-info` 显示未配置时点在线 PDF 的「阅读」→ 弹 `cookieModal`，不崩。（**测完记得别把用户真 cookie 清了**；要造「无 cookie」态就在一个干净的临时 userData 下测，别动真实的。）

### 9.3 验收标准

- [ ] PDF 行有「阅读」按钮，非 PDF / 分卷行没有。
- [ ] 点在线 PDF 能在应用内翻页看正文，不落地整本也能看。
- [ ] 已下载文件自动走本地、无 cookie 也能读。
- [ ] 一次打开只打一次 link 接口；Range 分段复用直链；403/412 自动重取一次。
- [ ] 渲染进程拿不到 cookie 值；`fzpdf://` URL 里只有 fid。
- [ ] desktop + core 的 typecheck、build 均退出 0。
- [ ] 未破坏用户真实 cookie。

---

## 10. 当前项目状态与遗留（交接上下文）

**已完成并验证：**
- #1–#7、#9、#10。其中 **#7（cookie + 完整下载）已用真实 cookie 在线验证**：cookieTest=登录态有效，29KB PDF 字节级一致下载、无 `.part` 残留，41020 token 过期 bug 已修（`refreshShareFidTokens`），dev 与 portable 两个 bundle 都带修复。**#10 迁移**：866 文件 / 797M 已从 C: 移到 `D:\AI\fangzhi`，junction 重建，typecheck/build 过。
- 唯一未测的下载子路径：中断后 Range/206 续传（逻辑已审，测试文件太小难中断）——阅读器的 Range 测试正好能覆盖类似逻辑。

**遗留 / 暂停（未经用户确认不要擅自开工）：**
- **#8 小程序版**（in_progress）：需要用户把 `apps/miniprogram` 导入微信开发者工具做真机渲染检查——**本机没装**微信开发者工具。
- **本阅读器任务本身**：用户明确说「写个文档，我换个 agent 继续」——即**实现由下一个 agent 做**，本文就是交接物。
- 清理项（用户尚未确认）：C: 那个空的 `...\5d8c2816` 文件夹壳（本会话删不掉，被 Qoder 当工作区根占用；从 D: 重开后可删）；根目录的临时脚本 `verify-*.ts`、`quark-probe/`。

---

## 11. 开工顺序建议

1. `cd /d/AI/fangzhi/apps/desktop && npm install -D pdfjs-dist` → 确认 worker 文件名。
2. 导出 `sanitize`（`main/download.ts`）。
3. 写 `main/reader.ts`（§7.1 骨架）。
4. 接线 `main/index.ts`（§7.3）、`preload`（§7.4）。
5. `build.mjs` 拷 worker + external canvas（§7.7）；改 CSP（§7.8）。
6. renderer：接口声明 + 文件行按钮 + `openReader` + overlay/PDF.js（§7.5–7.6）。
7. `npm run typecheck` → `npm run build` → `npx electron . --remote-debugging-port=9333` → 按 §9 验证。

先从「协议 + tiny PDF 的 fetch 单测」跑通（不依赖 UI），再接 PDF.js overlay，最后接文件行按钮。这样每步都能独立验证，出问题好定位。
