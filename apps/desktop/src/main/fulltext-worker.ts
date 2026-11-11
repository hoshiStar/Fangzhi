import { parentPort } from 'node:worker_threads';
import {
  cachedMask, finalizeBooks, loadTextFast, maskMayContain, mergeFileHit, normalizeText,
  rememberMask, resolveTextPath, scanLoaded, textCachePath, textFileMtime,
} from './fulltext-core.ts';
import type { LoadedText, TextBookHit, TextFileTask } from './fulltext-core.ts';

/**
 * 全库全文检索的独立线程。
 *
 * 为什么要单开线程：一本志的 OCR 文本动辄几十万字，全库扫一遍要读上千个 jsonl、
 * 每页还要做一次繁简归一化了。放在主进程里同步跑，搜索框会整体卡住，连输入都掉帧。
 *
 * 三级过滤：
 * - 磁盘缓存头里的字符位图：查询字一个都没有的文件，正文一个字节都不读；
 * - 磁盘缓存：`data/.text-cache/*.txt`，只存原文和归一化文本，省掉 jsonl 的坐标数组和
 *   opencc 换算，进程重启后第一次检索也走缓存；
 * - 内存：按 (路径, mtime) 失效，上限 400 个文件——上千本全塞进来是几百兆，不划算。
 */

const MAX_CACHED_FILES = 400;

interface Job {
  id: number;
  q: string;
  limit: number;
  dataDir: string;
  files: TextFileTask[];
}

interface ScanStats {
  cached: number;
  parsed: number;
  skipped: number;
}

const cache = new Map<string, { mtimeMs: number; loaded: LoadedText }>();
const canceled = new Set<number>();
const queue: Job[] = [];
let running = false;

function remember(file: string, mtimeMs: number, loaded: LoadedText): void {
  cache.delete(file);
  cache.set(file, { mtimeMs, loaded });
  while (cache.size > MAX_CACHED_FILES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function takeFromCache(
  dataDir: string,
  task: TextFileTask,
  needle: string,
  stats: ScanStats,
): LoadedText | null {
  const file = resolveTextPath(dataDir, task.textRef);
  if (!file) return null;
  const mtimeMs = textFileMtime(file);
  if (mtimeMs < 0) return null;

  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) {
    // 命中率靠 LRU 维持：重新插入把最近用到的推到队尾
    remember(file, mtimeMs, hit.loaded);
    if (hit.loaded.mask && !maskMayContain(hit.loaded.mask, needle)) {
      stats.skipped++;
      return null;
    }
    return hit.loaded;
  }

  // 内存里没有：只读缓存头那几 KB，位图说不可能含就直接跳过
  const cacheFile = textCachePath(dataDir, task.fid);
  const head = cachedMask(file, cacheFile);
  if (head && head.mtimeMs === mtimeMs && !maskMayContain(head.mask, needle)) {
    stats.skipped++;
    return null;
  }

  const r = loadTextFast(file, cacheFile, mtimeMs);
  if (!r) return null;
  remember(file, mtimeMs, r.loaded);
  if (r.loaded.mask) {
    rememberMask(file, mtimeMs, r.loaded.mask);
    if (!maskMayContain(r.loaded.mask, needle)) {
      stats.skipped++;
      return null;
    }
  }
  if (r.fromCache) stats.cached++;
  else stats.parsed++;
  return r.loaded;
}

const yieldToMessages = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function runJob(job: Job): Promise<void> {
  const needle = normalizeText(job.q.trim());
  const books = new Map<string, TextBookHit>();
  let total = 0;

  if (!needle) {
    parentPort?.postMessage({ type: 'done', id: job.id, result: { total: 0, books: [] } });
    return;
  }

  const step = Math.max(1, Math.ceil(job.files.length / 40));
  // 每 8 个文件让出一次事件循环：取消消息才进得来，进度也不会几秒才跳一下
  const yieldEvery = 8;
  // 这一轮多少文件走了磁盘缓存、多少重新解析过、多少被位图直接排除，供诊断脚本核对
  const stats: ScanStats = { cached: 0, parsed: 0, skipped: 0 };
  for (let i = 0; i < job.files.length; i++) {
    if (canceled.has(job.id)) {
      canceled.delete(job.id);
      parentPort?.postMessage({ type: 'done', id: job.id, result: { total: 0, books: [], canceled: true } });
      return;
    }
    const task = job.files[i]!;
    const loaded = takeFromCache(job.dataDir, task, needle, stats);
    if (loaded) {
      const { hits, count } = scanLoaded(loaded, needle);
      if (count) {
        total += count;
        mergeFileHit(books, task, loaded, hits, count, needle);
      }
    }
    const last = i === job.files.length - 1;
    if (i % step === 0 || last) {
      parentPort?.postMessage({ type: 'progress', id: job.id, scanned: i + 1, total: job.files.length });
    }
    if (i % yieldEvery === 0 || last) await yieldToMessages();
  }

  parentPort?.postMessage({
    type: 'done',
    id: job.id,
    result: { total, books: finalizeBooks(books, job.limit) },
    stats,
  });
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const job = queue.shift()!;
      try {
        await runJob(job);
      } catch (e) {
        parentPort?.postMessage({ type: 'error', id: job.id, error: (e as Error).message });
      }
    }
  } finally {
    running = false;
    // 队列清空时把取消标记一并清掉，避免作业 id 长期堆着
    if (!queue.length) canceled.clear();
  }
}

parentPort?.on('message', (msg: { type: string; id?: number; job?: Job }) => {
  if (msg.type === 'search' && msg.job) {
    queue.push(msg.job);
    void pump();
  } else if (msg.type === 'cancel' && typeof msg.id === 'number') {
    // 未开始的直接丢掉，跑着的会在下一批让出时看到标记
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i]!.id === msg.id) {
        queue.splice(i, 1);
        parentPort?.postMessage({ type: 'done', id: msg.id, result: { total: 0, books: [], canceled: true } });
      }
    }
    canceled.add(msg.id);
  }
});

parentPort?.postMessage({ type: 'ready' });
