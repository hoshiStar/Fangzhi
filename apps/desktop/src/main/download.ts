import { fetchShareToken, parseShareUrl, QuarkShareError, refreshShareFidTokens } from '@fangzhi/core/crawl';
import type { CrawlTarget } from '@fangzhi/core/crawl';
import { downloadFile, fetchDownloadLinks } from '@fangzhi/core/download';
import type { DownloadLink } from '@fangzhi/core/download';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface DlItem {
  fid: string;
  bookId: string;
  name: string;
  size: number;
  /** 换直链前要用它去 detail 现取一份 fresh share_fid_token。 */
  pdirFid: string;
  shareFidToken: string;
}

export type DlStatus = 'queued' | 'linking' | 'downloading' | 'done' | 'error' | 'canceled';

export interface DlState {
  fid: string;
  name: string;
  size: number;
  bytes: number;
  status: DlStatus;
  error?: string;
  dest?: string;
}

export interface DlDeps {
  cookie: () => string;
  shareUrl: () => string;
  destDir: () => string;
  emit: (state: DlState) => void;
}

/** 网盘文件名是不可信输入，落盘前先把路径分隔符和 Windows 保留字符换掉。 */
export const sanitize = (n: string): string => n.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '_').trim() || 'download';

/** 目录名只保留安全字符，并限制长度，避免恶意或异常 fid 变成超长路径。 */
export const safeSegment = (s: string): string =>
  (s.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 96) || '_unknown');

export interface DownloadRef {
  bookId: string;
  fid: string;
  name: string;
}

/**
 * 每个文件独立目录：不同书、不同 fid 即使原始文件名相同也不会互相覆盖。
 * 阅读器、下载清单和 dl-local 都必须使用这一条规则。
 */
export function downloadDest(root: string, ref: DownloadRef): string {
  return join(root, 'books', safeSegment(ref.bookId), safeSegment(ref.fid), sanitize(ref.name));
}

/** 旧版把文件直接平铺在下载目录；仅作只读兼容，不再往这里写。 */
export function legacyDownloadDest(root: string, ref: DownloadRef): string {
  return join(root, sanitize(ref.name));
}

/** 本地文件必须存在且大小与索引一致，避免把同名文件误当成目标文件。 */
export function localFileMatches(path: string, expectedSize: number): boolean {
  if (!existsSync(path)) return false;
  if (!expectedSize) return true;
  try { return statSync(path).size === expectedSize; } catch { return false; }
}

function writeAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/**
 * 串行下载队列。一次只下一个文件：
 * 取链接口比遍历接口敏感，并发是封号的主要诱因，速度也不是瓶颈（瓶颈在账号限速）。
 */
export class DownloadManager {
  private deps: DlDeps;
  private queue: DlItem[] = [];
  private states = new Map<string, DlState>();
  private items = new Map<string, DlItem>();
  private abort: AbortController | null = null;
  private pumping = false;
  private stoken = '';
  private stokenFor = '';

  constructor(deps: DlDeps) { this.deps = deps; }

  list(): DlState[] { return [...this.states.values()]; }

  enqueue(items: DlItem[]): void {
    for (const it of items) {
      this.items.set(it.fid, it);
      const cur = this.states.get(it.fid)?.status;
      if (cur === 'queued' || cur === 'linking' || cur === 'downloading') continue;
      const s: DlState = { fid: it.fid, name: it.name, size: it.size, bytes: 0, status: 'queued' };
      this.states.set(it.fid, s);
      this.queue.push(it);
      this.deps.emit(s);
    }
    this.persist();
    void this.pump();
  }

  /** 失败或重启后仍能看出文件属于哪本书，后续恢复队列也靠这份清单。 */
  private persist(): void {
    try {
      const items = [...this.states.values()].map((s) => {
        const it = this.items.get(s.fid);
        return {
          fid: s.fid,
          bookId: it?.bookId ?? '',
          pdirFid: it?.pdirFid ?? '',
          name: s.name,
          size: s.size,
          bytes: s.bytes,
          status: s.status,
          dest: s.dest,
          error: s.error,
        };
      });
      writeAtomic(join(this.deps.destDir(), 'download-manifest.json'), JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        items,
      }, null, 2) + '\n');
    } catch (e) {
      console.warn('下载清单写入失败:', (e as Error).message);
    }
  }

  /**
   * 启动时恢复上次未完成任务。只恢复状态，不立刻发网络请求；
   * 有 cookie 时由 main 调 resumePending()，没有 cookie 时等用户配置后再继续。
   */
  restore(): number {
    try {
      const raw = JSON.parse(readFileSync(join(this.deps.destDir(), 'download-manifest.json'), 'utf8')) as {
        version?: number;
        items?: Array<{
          fid?: string; bookId?: string; pdirFid?: string; name?: string; size?: number;
          bytes?: number; status?: DlStatus; dest?: string; error?: string;
        }>;
      };
      if (raw?.version !== 1 || !Array.isArray(raw.items)) return 0;
      for (const it of raw.items) {
        if (!it.fid || !it.name || !it.size) continue;
        const status: DlStatus = it.status ?? 'queued';
        const state: DlState = {
          fid: it.fid,
          name: it.name,
          size: it.size,
          bytes: it.bytes ?? 0,
          status,
          dest: it.dest,
          error: it.error,
        };
        this.states.set(it.fid, state);
        if (!it.bookId || !it.pdirFid) continue;
        this.items.set(it.fid, {
          fid: it.fid,
          bookId: it.bookId,
          name: it.name,
          size: it.size,
          pdirFid: it.pdirFid,
          shareFidToken: '',
        });
        if (status === 'queued' || status === 'linking' || status === 'downloading') {
          // 清单里可能已经写完但没来得及标记完成
          const dest = it.dest ?? downloadDest(this.deps.destDir(), this.items.get(it.fid)!);
          if (localFileMatches(dest, it.size)) {
            state.status = 'done';
            state.bytes = it.size;
            state.dest = dest;
          } else {
            state.status = 'queued';
            state.bytes = 0;
            state.error = undefined;
            this.queue.push(this.items.get(it.fid)!);
          }
        }
        this.deps.emit(state);
      }
      const pending = this.queue.length;
      this.persist();
      return pending;
    } catch {
      return 0;
    }
  }

  /** 用户配置/恢复 cookie 后继续上次未完成任务。 */
  resumePending(): void {
    if (this.queue.length) void this.pump();
  }

  retry(fid: string): void {
    const it = this.items.get(fid);
    const s = this.states.get(fid);
    if (!it || !s) return;
    if (s.status === 'queued' || s.status === 'linking' || s.status === 'downloading') return;
    s.status = 'queued';
    s.bytes = 0;
    s.error = undefined;
    this.queue.push(it);
    this.deps.emit(s);
    this.persist();
    void this.pump();
  }

  cancel(fid?: string): void {
    if (fid) {
      const i = this.queue.findIndex((q) => q.fid === fid);
      if (i >= 0) {
        this.queue.splice(i, 1);
        this.finish(fid, 'canceled');
        return;
      }
      const cur = this.states.get(fid)?.status;
      if (cur === 'downloading' || cur === 'linking') this.abort?.abort();
      return;
    }
    for (const q of this.queue) this.finish(q.fid, 'canceled');
    this.queue = [];
    this.abort?.abort();
  }

  private finish(fid: string, status: DlStatus, extra?: Partial<DlState>): void {
    const s = this.states.get(fid);
    if (!s) return;
    Object.assign(s, { status }, extra);
    this.deps.emit(s);
    this.persist();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const it = this.queue.shift()!;
        await this.runOne(it);
      }
    } finally {
      this.pumping = false;
    }
  }

  private target(): CrawlTarget {
    const url = this.deps.shareUrl();
    if (!url) throw new Error('索引里没有分享链接，无法下载');
    return parseShareUrl(url);
  }

  private async token(target: CrawlTarget, signal?: AbortSignal): Promise<string> {
    if (this.stoken && this.stokenFor === target.pwdId) return this.stoken;
    this.stoken = (await fetchShareToken(target, signal)).stoken;
    this.stokenFor = target.pwdId;
    return this.stoken;
  }

  private async links(target: CrawlTarget, it: DlItem, signal?: AbortSignal): Promise<DownloadLink[]> {
    if (signal?.aborted) throw new Error('aborted');
    // 索引里存的 share_fid_token 到下载时基本已失效（41020），必须用当前 stoken 现取。
    const go = async (): Promise<DownloadLink[]> => {
      await this.token(target, signal);
      const fresh = await refreshShareFidTokens({ target, stoken: this.stoken, files: [{ fid: it.fid, pdirFid: it.pdirFid }], signal });
      const tok = fresh.get(it.fid);
      if (!tok) throw new Error('没能刷新到 share_fid_token，文件可能已被移出分享');
      return fetchDownloadLinks({ target, stoken: this.stoken, cookie: this.deps.cookie(), files: [{ fid: it.fid, shareFidToken: tok }], signal });
    };
    try {
      return await go();
    } catch (e) {
      // stoken 过期：重取一次再试，不算失败
      if (e instanceof QuarkShareError && (e.code === 41005 || /stoken/i.test(e.message))) {
        this.stoken = '';
        return go();
      }
      throw e;
    }
  }

  private async runOne(it: DlItem): Promise<void> {
    if (!this.deps.cookie()) {
      this.finish(it.fid, 'error', { error: '还没配置夸克 cookie，点右上角「账号」粘贴' });
      return;
    }
    this.abort = new AbortController();
    const signal = this.abort.signal;
    try {
      this.finish(it.fid, 'linking');
      const target = this.target();
      const link = (await this.links(target, it, signal))[0];
      if (!link) throw new Error('服务端没给直链');
      const dest = downloadDest(this.deps.destDir(), it);
      this.finish(it.fid, 'downloading', { dest });
      let last = 0;
      await downloadFile({
        link,
        dest,
        cookie: this.deps.cookie(),
        signal,
        onProgress: (p) => {
          const now = Date.now();
          if (now - last < 250) return;
          last = now;
          const s = this.states.get(it.fid);
          if (!s) return;
          s.bytes = p.bytes;
          this.deps.emit(s);
        },
        refresh: async () => {
          const l = (await this.links(target, it, signal))[0];
          if (!l) throw new Error('换直链失败：服务端没给新链');
          return l;
        },
      });
      this.finish(it.fid, 'done', { bytes: it.size, dest });
    } catch (e) {
      const msg = (e as Error).message;
      this.finish(it.fid, msg === 'aborted' ? 'canceled' : 'error', { error: msg });
    } finally {
      this.abort = null;
    }
  }
}
