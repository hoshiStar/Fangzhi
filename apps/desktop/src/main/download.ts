import { fetchShareToken, parseShareUrl, QuarkShareError, refreshShareFidTokens } from '@fangzhi/core/crawl';
import type { CrawlTarget } from '@fangzhi/core/crawl';
import { downloadFile, fetchDownloadLinks } from '@fangzhi/core/download';
import type { DownloadLink } from '@fangzhi/core/download';
import { join } from 'node:path';

export interface DlItem {
  fid: string;
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

/** 网盘文件名是不可信输入，落盘前先把路径分隔符和 Windows 保留字符换掉。阅读器找本地文件也用这条规则。 */
export const sanitize = (n: string): string => n.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '_').trim() || 'download';

/**
 * 串行下载队列。一次只下一个文件：
 * 取链接口比遍历接口敏感，并发是封号的主要诱因，速度也不是瓶颈（瓶颈在账号限速）。
 */
export class DownloadManager {
  private deps: DlDeps;
  private queue: DlItem[] = [];
  private states = new Map<string, DlState>();
  private abort: AbortController | null = null;
  private pumping = false;
  private stoken = '';
  private stokenFor = '';

  constructor(deps: DlDeps) { this.deps = deps; }

  list(): DlState[] { return [...this.states.values()]; }

  enqueue(items: DlItem[]): void {
    for (const it of items) {
      const cur = this.states.get(it.fid)?.status;
      if (cur === 'queued' || cur === 'linking' || cur === 'downloading') continue;
      const s: DlState = { fid: it.fid, name: it.name, size: it.size, bytes: 0, status: 'queued' };
      this.states.set(it.fid, s);
      this.queue.push(it);
      this.deps.emit(s);
    }
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

  private async token(target: CrawlTarget): Promise<string> {
    if (this.stoken && this.stokenFor === target.pwdId) return this.stoken;
    this.stoken = (await fetchShareToken(target)).stoken;
    this.stokenFor = target.pwdId;
    return this.stoken;
  }

  private async links(target: CrawlTarget, it: DlItem): Promise<DownloadLink[]> {
    // 索引里存的 share_fid_token 到下载时基本已失效（41020），必须用当前 stoken 现取。
    const go = async (): Promise<DownloadLink[]> => {
      await this.token(target);
      const fresh = await refreshShareFidTokens({ target, stoken: this.stoken, files: [{ fid: it.fid, pdirFid: it.pdirFid }] });
      const tok = fresh.get(it.fid);
      if (!tok) throw new Error('没能刷新到 share_fid_token，文件可能已被移出分享');
      return fetchDownloadLinks({ target, stoken: this.stoken, cookie: this.deps.cookie(), files: [{ fid: it.fid, shareFidToken: tok }] });
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
      const link = (await this.links(target, it))[0];
      if (!link) throw new Error('服务端没给直链');
      const dest = join(this.deps.destDir(), sanitize(it.name));
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
          const l = (await this.links(target, it))[0];
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
