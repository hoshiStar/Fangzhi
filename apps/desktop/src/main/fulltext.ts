import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { scanAllSync } from './fulltext-core.ts';
import type { TextFileTask, TextSearchResult } from './fulltext-core.ts';

export interface FulltextDeps {
  /** 当前索引里所有带 OCR 文本的文件。每次查询现取，索引重载后自动跟上。 */
  tasks(): TextFileTask[];
  dataDir(): string;
  onProgress?: (p: { scanned: number; total: number; q: string }) => void;
  /** 默认取同目录下的 fulltext-worker.cjs（见 scripts/build.mjs）。 */
  workerFile?: string;
  /** 一段时间没有任何进度就当 worker 卡死，退回同步扫描。 */
  idleTimeoutMs?: number;
}

/**
 * 全库全文检索的门面。
 *
 * 正常路径：常驻一个 worker 线程，把整批文件丢过去扫，主进程只等消息，
 * 搜索框和列表照常响应；新查询会把上一批顶掉，避免输入过程中白扫几千本书。
 * 兜底路径：worker 起不来（打包漏了文件、线程创建失败）时退回主进程同步扫，
 * 结果是慢且界面会卡一下，但功能不能没有。
 */
export function createFulltextSearch(deps: FulltextDeps) {
  let worker: Worker | null = null;
  let seq = 0;
  let disposed = false;
  let pending: {
    id: number;
    q: string;
    resolve: (r: TextSearchResult) => void;
    timer: NodeJS.Timeout;
  } | null = null;

  const workerPath = (): string => deps.workerFile ?? join(__dirname, 'fulltext-worker.cjs');

  function settle(result: TextSearchResult): void {
    const p = pending;
    if (!p) return;
    pending = null;
    clearTimeout(p.timer);
    p.resolve(result);
  }

  function armIdleTimer(): void {
    const p = pending;
    if (!p) return;
    clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      // 卡住的 worker 直接扔掉，下次查询重新起一个
      dropWorker();
      settle(scanAllSync(deps.tasks(), deps.dataDir(), p.q, 20));
    }, deps.idleTimeoutMs ?? 45_000);
    p.timer.unref?.();
  }

  function dropWorker(): void {
    const w = worker;
    worker = null;
    if (!w) return;
    w.removeAllListeners();
    void w.terminate().catch(() => {});
  }

  function ensureWorker(): Worker | null {
    if (worker) return worker;
    const file = workerPath();
    if (!existsSync(file)) return null;
    try {
      const w = new Worker(file);
      w.unref();
      w.on('message', (msg: { type: string; id?: number; result?: TextSearchResult; error?: string; scanned?: number; total?: number }) => {
        const p = pending;
        if (!p || msg.id !== p.id) return;
        if (msg.type === 'progress') {
          deps.onProgress?.({ scanned: msg.scanned ?? 0, total: msg.total ?? 0, q: p.q });
          armIdleTimer();
        } else if (msg.type === 'done') {
          settle(msg.result ?? { total: 0, books: [] });
        } else if (msg.type === 'error') {
          settle(scanAllSync(deps.tasks(), deps.dataDir(), p.q, 20));
        }
      });
      w.on('error', () => {
        // 线程挂了：当前请求走兜底，后续请求会重新起线程
        dropWorker();
        const p = pending;
        if (p) settle(scanAllSync(deps.tasks(), deps.dataDir(), p.q, 20));
      });
      w.on('exit', () => {
        if (worker === w) worker = null;
      });
      worker = w;
      return w;
    } catch {
      return null;
    }
  }

  function search(q: string, limit = 20): Promise<TextSearchResult> {
    const query = q.trim();
    if (disposed) return Promise.resolve(scanAllSync(deps.tasks(), deps.dataDir(), query, limit));
    if (!query) return Promise.resolve({ total: 0, books: [] });

    // 上一批还没回来就换查询：让 worker 停手，结果直接作废
    if (pending) {
      const stale = pending;
      pending = null;
      clearTimeout(stale.timer);
      worker?.postMessage({ type: 'cancel', id: stale.id });
      stale.resolve({ total: 0, books: [], canceled: true });
    }

    const w = ensureWorker();
    if (!w) {
      return Promise.resolve({ ...scanAllSync(deps.tasks(), deps.dataDir(), query, limit), degraded: true });
    }

    const id = ++seq;
    return new Promise<TextSearchResult>((resolve) => {
      pending = { id, q: query, resolve, timer: setTimeout(() => {}, 0) };
      armIdleTimer();
      try {
        w.postMessage({ type: 'search', job: { id, q: query, limit, dataDir: deps.dataDir(), files: deps.tasks() } });
      } catch {
        settle({ ...scanAllSync(deps.tasks(), deps.dataDir(), query, limit), degraded: true });
      }
    });
  }

  return {
    search,
    dispose(): void {
      disposed = true;
      if (pending) {
        const p = pending;
        pending = null;
        clearTimeout(p.timer);
        p.resolve({ total: 0, books: [], canceled: true });
      }
      dropWorker();
    },
  };
}
