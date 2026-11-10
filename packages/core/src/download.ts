import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { QuarkShareError } from './crawl.ts';
import type { CrawlTarget } from './crawl.ts';

/**
 * 夸克 PC 客户端 UA。取直链接口认这个身份，普通浏览器 UA 拿不到链。
 * 值对齐 LinkSwift（AGPL-3.0）逆向出的当前客户端版本。
 */
export const QUARK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0.0.0 Safari/537.36 QuarkPC/6.9.7.761 QuarkCloudDrivePC/6.9.7.761 quark-cloud-drive/2.5.40';

const LINK_API = 'https://drive-pc.quark.cn/1/clouddrive/file/download?pr=ucpro&fr=pc&sys=win32&ve=6.9.7.761';
const SOCIAL_API =
  'https://drive-social-api.quark.cn/1/clouddrive/chat/conv/file/acquire_dl_token' +
  '?pr=ucpro&fr=pc&sys=win32&ve=6.9.7.761&fr=win&la=zh-CN&ch=pckk%40product_guanwan';
const BATCH = 15;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });

export interface LinkRequest {
  fid: string;
  shareFidToken: string;
}

export interface DownloadLink {
  fid: string;
  fileName: string;
  size: number;
  url: string;
}

interface LinkResponse {
  code: number;
  message?: string;
  data?: Array<{ fid: string; file_name: string; size: number; download_url?: string }>;
}

let social: { token: string; expiredAt: number } | null = null;

/**
 * 下载令牌。分享页场景拿不到也允许（传空串），但 31001 要抛出来——
 * 那是「没登录」，吞掉会让用户以为只是链慢。
 */
export async function acquireSocialToken(cookie: string, signal?: AbortSignal): Promise<string> {
  const now = Date.now();
  if (social && social.expiredAt > now + 60_000) return social.token;
  const t = Math.floor(now / 1000);
  const res = await fetch(SOCIAL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, 'User-Agent': QUARK_UA },
    body: JSON.stringify({ conversation_id: `300000${t}`, conversation_type: 3, msg_id: `${t}000` }),
    signal,
  });
  const j = (await res.json()) as { code: number; message?: string; data?: { token?: string; expired_timestamp?: number } };
  if (j.code === 31001 || /require login/i.test(j.message ?? '')) {
    throw new QuarkShareError(j.message ?? 'require login', j.code, true);
  }
  if (j.code !== 0 || !j.data?.token) return '';
  social = { token: j.data.token, expiredAt: j.data.expired_timestamp ?? 0 };
  return social.token;
}

/** 登录态自检。cookie-test 用它，比随便猜一个会员接口可靠。 */
export async function probeLogin(cookie: string): Promise<{ ok: boolean; message: string }> {
  try {
    const token = await acquireSocialToken(cookie);
    return token ? { ok: true, message: '登录态有效' } : { ok: false, message: '接口通了但没发令牌，cookie 可能不完整' };
  } catch (e) {
    if (e instanceof QuarkShareError && e.needLogin) return { ok: false, message: 'cookie 已失效或未登录' };
    return { ok: false, message: (e as Error).message };
  }
}

/**
 * 批量换直链。服务端一次最多 15 个 fid，批间留 1s——
 * 这个接口比遍历接口敏感，节流是防封号的主要手段。
 */
export async function fetchDownloadLinks(opts: {
  target: CrawlTarget;
  stoken: string;
  cookie: string;
  files: LinkRequest[];
  signal?: AbortSignal;
}): Promise<DownloadLink[]> {
  const out: DownloadLink[] = [];
  for (let i = 0; i < opts.files.length; i += BATCH) {
    if (opts.signal?.aborted) throw new Error('aborted');
    const batch = opts.files.slice(i, i + BATCH);
    const token = await acquireSocialToken(opts.cookie, opts.signal).catch(() => '');
    const res = await fetch(LINK_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: opts.cookie, 'User-Agent': QUARK_UA },
      body: JSON.stringify({
        fids: batch.map((f) => f.fid),
        fids_token: batch.map((f) => f.shareFidToken),
        pwd_id: opts.target.pwdId,
        stoken: opts.stoken,
        speedup_session: '',
        token,
      }),
      signal: opts.signal,
    });
    const j = (await res.json()) as LinkResponse;
    if (j.code === 31001 || /require login/i.test(j.message ?? '')) {
      throw new QuarkShareError(j.message ?? 'require login', j.code, true);
    }
    if (j.code === 23018) {
      throw new QuarkShareError(`超出游客可下载的大小限制，请确认 cookie 已登录: ${j.message ?? ''}`, j.code, true);
    }
    if (j.code !== 0 || !j.data) {
      throw new QuarkShareError(`取直链失败: ${j.message ?? ''} (code ${j.code})`, j.code);
    }
    for (const d of j.data) {
      if (d.download_url) out.push({ fid: d.fid, fileName: d.file_name, size: d.size, url: d.download_url });
    }
    if (i + BATCH < opts.files.length) await sleep(1000, opts.signal);
  }
  return out;
}

export interface DownloadProgress {
  fid: string;
  bytes: number;
  total: number;
}

async function streamTo(
  res: Response,
  dest: string,
  start: number,
  total: number,
  fid: string,
  onProgress?: (p: DownloadProgress) => void,
): Promise<number> {
  const ws = createWriteStream(dest, start > 0 ? { flags: 'r+', start } : { flags: 'w' });
  const reader = res.body!.getReader();
  let written = start;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!ws.write(value)) await new Promise<void>((r, j) => { ws.once('drain', () => r()); ws.once('error', j); });
      written += value.byteLength;
      onProgress?.({ fid, bytes: written, total });
    }
  } finally {
    reader.releaseLock();
    await new Promise<void>((r) => ws.close(() => r()));
  }
  return written;
}

/**
 * 单文件下载，带断点续传。半成品留在 .part 里，重试时发 Range 接着写；
 * 直链 403/412 时通过 refresh 换一条新链，不从头再来。
 */
export async function downloadFile(opts: {
  link: DownloadLink;
  dest: string;
  cookie: string;
  signal?: AbortSignal;
  onProgress?: (p: DownloadProgress) => void;
  refresh?: (fid: string) => Promise<DownloadLink>;
}): Promise<void> {
  mkdirSync(dirname(opts.dest), { recursive: true });
  let url = opts.link.url;
  let stalls = 0;
  for (;;) {
    if (opts.signal?.aborted) throw new Error('aborted');
    const part = opts.dest + '.part';
    const done = existsSync(part) ? statSync(part).size : 0;
    if (opts.link.size > 0 && done >= opts.link.size) {
      // 上次已经写满，只是没来得及改名
      renameSync(part, opts.dest);
      return;
    }
    const headers: Record<string, string> = { 'User-Agent': QUARK_UA, Cookie: opts.cookie };
    if (done > 0) headers.Range = `bytes=${done}-`;
    const res = await fetch(url, { headers, signal: opts.signal });
    if (res.status === 403 || res.status === 412) {
      if (!opts.refresh) throw new QuarkShareError(`直链失效 (HTTP ${res.status})，请重试`, res.status, res.status === 412);
      url = (await opts.refresh(opts.link.fid)).url;
      continue;
    }
    if (!res.ok && res.status !== 206) throw new QuarkShareError(`下载失败 HTTP ${res.status}`, res.status);
    // 服务器不认 Range 就会回 200 全文，这时必须从头写
    const start = res.status === 206 ? done : 0;
    const written = await streamTo(res, part, start, opts.link.size, opts.link.fid, opts.onProgress);
    if (written === start) {
      if (++stalls > 2) throw new QuarkShareError('连续三次没有任何进度，放弃', -1);
      continue;
    }
    stalls = 0;
    if (opts.link.size > 0 && written < opts.link.size) continue;
    renameSync(part, opts.dest);
    return;
  }
}
