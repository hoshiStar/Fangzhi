import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fetchShareToken, parseShareUrl, QuarkShareError, refreshShareFidTokens } from '@fangzhi/core/crawl';
import type { CrawlTarget } from '@fangzhi/core/crawl';
import { fetchDownloadLinks, QUARK_UA } from '@fangzhi/core/download';
import type { FileRecord, GazetteerIndex } from '@fangzhi/core';
import { downloadDest, legacyDownloadDest, localFileMatches } from './download.ts';

export interface ReaderDeps {
  hasCookie(): boolean;
  cookie(): string;
  downloadDir(): string;
  index(): GazetteerIndex | null;
  shareUrl(): string;
}

interface LinkEntry {
  url: string;
  size: number;
  at: number;
}

/** 直链有 TTL，保守取 4 分钟；过期后下一次请求自动重取。 */
const LINK_TTL = 4 * 60_000;

/**
 * 跨源头。渲染页面是 fz:// 或 file://，请求 127.0.0.1 属跨源，pdf.js 还带着
 * Range 头（非简单请求），所以既要放行预检，也要把 Content-Range / Content-Length
 * 暴露出去——读不到这几个头，pdf.js 会判定不支持分段，又退化成整本取。
 */
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'range, if-range',
  'access-control-expose-headers': 'content-length, content-range, accept-ranges, content-type, content-disposition',
};

const acao = (h: Headers): Headers => {
  h.set('access-control-allow-origin', '*');
  h.set(
    'access-control-expose-headers',
    'content-length, content-range, accept-ranges, content-type, content-disposition',
  );
  return h;
};

const json = (status: number, obj: unknown): Response =>
  new Response(JSON.stringify(obj), {
    status,
    headers: acao(new Headers({ 'content-type': 'application/json; charset=utf-8' })),
  });

/** 新下载文件的路径，和下载管理器使用同一条书目/文件隔离规则。 */
export function localPath(deps: ReaderDeps, rec: FileRecord): string {
  return downloadDest(deps.downloadDir(), { bookId: rec.bookId, fid: rec.fid, name: rec.name });
}

/**
 * 找到真正属于这个 fid 的本地文件。旧版平铺目录只读兼容；
 * 两条路径都必须通过大小校验，防止同名文件被误读成另一本书。
 */
export function findLocalPath(deps: ReaderDeps, rec: FileRecord): string {
  const candidates = [
    localPath(deps, rec),
    legacyDownloadDest(deps.downloadDir(), { bookId: rec.bookId, fid: rec.fid, name: rec.name }),
  ];
  for (const p of candidates) if (localFileMatches(p, rec.size)) return p;
  return '';
}

export function createReader(deps: ReaderDeps): (req: Request) => Promise<Response> {
  const linkCache = new Map<string, LinkEntry>();
  const inflight = new Map<string, Promise<LinkEntry>>();
  let stoken = '';
  let stokenFor = '';

  function target(): CrawlTarget {
    const url = deps.shareUrl();
    if (!url) throw new Error('索引里没有分享链接，无法在线取直链');
    return parseShareUrl(url);
  }

  async function currentStoken(t: CrawlTarget): Promise<string> {
    if (stoken && stokenFor === t.pwdId) return stoken;
    stoken = (await fetchShareToken(t)).stoken;
    stokenFor = t.pwdId;
    return stoken;
  }

  /**
   * 换直链。索引里的 shareFidToken 是爬取那一刻签发的，早就失效（41020），
   * 必须用当前 stoken 现取一份 fresh token 再换。
   */
  async function resolveLink(rec: FileRecord): Promise<LinkEntry> {
    const go = async (): Promise<LinkEntry> => {
      const t = target();
      const tok = await currentStoken(t);
      const fresh = await refreshShareFidTokens({ target: t, stoken: tok, files: [{ fid: rec.fid, pdirFid: rec.pdirFid }] });
      const shareFidToken = fresh.get(rec.fid);
      if (!shareFidToken) throw new Error('没能刷新 share_fid_token，文件可能已被移出分享');
      const links = await fetchDownloadLinks({ target: t, stoken: tok, cookie: deps.cookie(), files: [{ fid: rec.fid, shareFidToken }] });
      const first = links[0];
      if (!first) throw new Error('服务端没给直链');
      const entry: LinkEntry = { url: first.url, size: first.size, at: Date.now() };
      linkCache.set(rec.fid, entry);
      return entry;
    };
    try {
      return await go();
    } catch (e) {
      // stoken 过期就重取一次，不算失败
      if (e instanceof QuarkShareError && (e.code === 41005 || /stoken/i.test(e.message))) {
        stoken = '';
        return go();
      }
      throw e;
    }
  }

  /** 一次「打开」只打一次换链接口：并发请求共用同一个 in-flight 结果。 */
  async function link(rec: FileRecord): Promise<LinkEntry> {
    const cached = linkCache.get(rec.fid);
    if (cached && Date.now() - cached.at < LINK_TTL) return cached;
    const pending = inflight.get(rec.fid);
    if (pending) return pending;
    const p = resolveLink(rec).finally(() => inflight.delete(rec.fid));
    inflight.set(rec.fid, p);
    return p;
  }

  /** CDN 403/412（直链中途失效）时重取一次。 */
  async function relink(rec: FileRecord): Promise<LinkEntry> {
    linkCache.delete(rec.fid);
    return resolveLink(rec);
  }

  async function serveLocal(path: string, method: string, range: string | null): Promise<Response> {
    const size = statSync(path).size;
    const headers = acao(new Headers({ 'content-type': 'application/pdf', 'accept-ranges': 'bytes' }));
    if (!range) {
      headers.set('content-length', String(size));
      const body = method === 'HEAD' ? null : (Readable.toWeb(createReadStream(path)) as ReadableStream);
      return new Response(body, { status: 200, headers });
    }
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m?.[1] ? Number(m[1]) : 0;
    const end = Math.min(m?.[2] ? Number(m[2]) : size - 1, size - 1);
    if (start > end || start >= size) {
      headers.set('content-range', `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set('content-range', `bytes ${start}-${end}/${size}`);
    headers.set('content-length', String(end - start + 1));
    const body = method === 'HEAD' ? null : (Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream);
    return new Response(body, { status: 206, headers });
  }

  async function serveRemote(rec: FileRecord, entry: LinkEntry, method: string, range: string | null): Promise<Response> {
    const withRange = (h: Record<string, string>): Record<string, string> => {
      if (range) h.range = range;
      return h;
    };
    const headers = (): Record<string, string> => withRange({ 'user-agent': QUARK_UA, cookie: deps.cookie() });

    let res = await fetch(entry.url, { method, headers: headers() });
    if (res.status === 403 || res.status === 412) {
      const fresh = await relink(rec);
      res = await fetch(fresh.url, { method, headers: headers() });
    }

    const h = acao(new Headers({
      'accept-ranges': 'bytes',
      'content-type': res.headers.get('content-type') ?? 'application/pdf',
    }));
    for (const k of ['content-length', 'content-range'] as const) {
      const v = res.headers.get(k);
      if (v) h.set(k, v);
    }
    return new Response(method === 'HEAD' ? null : res.body, { status: res.status, headers: h });
  }

  return async (req: Request): Promise<Response> => {
    const u = new URL(req.url);
    const fid = u.searchParams.get('fid') ?? u.pathname.replace(/^\//, '');
    const rec = deps.index()?.files.find((f) => f.fid === fid);
    if (!rec) return json(404, { error: '索引里没有这个文件' });
    if (rec.ext !== 'pdf') return json(415, { error: `内置阅读器只支持 PDF，这是 .${rec.ext}` });

    const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
    const range = req.headers.get('range');

    // 1) 本地优先：已下载的直接读盘，不碰网络、不需要 cookie
    const local = findLocalPath(deps, rec);
    if (local) return serveLocal(local, method, range);

    // 2) 在线直读：main 拿着 cookie 去 CDN 取流，renderer 只看到本机 http
    if (!deps.hasCookie()) return json(401, { error: '在线阅读需要夸克 cookie' });
    try {
      const entry = await link(rec);
      return await serveRemote(rec, entry, method, range);
    } catch (e) {
      const status = e instanceof QuarkShareError && e.needLogin ? 401 : 502;
      return json(status, { error: (e as Error).message });
    }
  };
}

/**
 * 本机 HTTP 阅读服务。
 *
 * 为什么不用自定义协议：pdf.js 只在 `isHttp` 为真时才发 Range 请求
 * （validateRangeRequestCapabilities 里 `!isHttp` 直接判定不支持分段），
 * 走自定义协议必然把整本 PDF 一次性取回内存。换成 127.0.0.1 上的 http 之后，
 * 翻到哪读到哪，一本几百 MB 的扫描件也不会一打开就吃掉同等内存。
 *
 * 只监听回环、端口随机、URL 必须带本进程生成的 token，并校验 Host 防 DNS rebinding。
 */
export interface ReaderServer {
  /** http://127.0.0.1:<port> */
  origin: string;
  /** 拼进 URL 的随机串；渲染层不通过 IPC 拿到它就要不到字节。 */
  token: string;
  close(): void;
}

export function startReaderServer(deps: ReaderDeps): Promise<ReaderServer> {
  const handler = createReader(deps);
  const token = randomBytes(16).toString('hex');
  const server = createServer((req, res) => { void onRequest(req, res); });

  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    // pdf.js 带 Range 头，属非简单请求，浏览器会先发预检
    if (method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { ...CORS_HEADERS, allow: 'GET, HEAD, OPTIONS' });
      res.end();
      return;
    }
    const port = (server.address() as AddressInfo).port;
    // Host 必须是这一份服务，挡掉把域名解析到 127.0.0.1 的页面
    if (req.headers.host !== `127.0.0.1:${port}`) {
      res.writeHead(403, CORS_HEADERS);
      res.end('forbidden');
      return;
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname !== '/read' || url.searchParams.get('t') !== token) {
      res.writeHead(403, CORS_HEADERS);
      res.end('forbidden');
      return;
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(', '));
    }
    let response: Response;
    try {
      response = await handler(new Request(url, { method, headers }));
    } catch (e) {
      res.writeHead(500, CORS_HEADERS);
      res.end((e as Error).message);
      return;
    }
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    if (!response.body) {
      res.end();
      return;
    }
    const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    body.on('error', () => res.destroy());
    res.on('close', () => body.destroy());
    body.pipe(res);
  }

  return new Promise<ReaderServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        token,
        close: () => {
          // 复用连接不掐掉的话，server.close() 会等 keep-alive 超时才真正结束
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}
