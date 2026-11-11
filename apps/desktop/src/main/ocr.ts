import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { GazetteerIndex } from '@fangzhi/core';
import {
  finalizeBooks, mergeFileHit, normalizeText, scanLoaded,
} from './fulltext-core.ts';
import type { LoadedText, OcrPage, TextBookHit } from './fulltext-core.ts';

export type { OcrLine, OcrPage, TextBookHit } from './fulltext-core.ts';

export interface OcrDeps {
  index(): GazetteerIndex | null;
  /** 索引所在目录，textRef 是相对它的路径。 */
  dataDir(): string;
}

const norm = normalizeText;

/**
 * 读 OCR 产物（data/ocr/<fid>.jsonl，见 tools/ocr/ocr.py）。
 * 阅读器只按页取，不整本塞进渲染进程；文件在 OCR 重跑后会变，用 mtime 失效缓存。
 *
 * 全库检索走 fulltext.ts 的 worker，这里的 searchAll 只是 worker 不可用时的兜底，
 * 两条路径共用 fulltext-core 里的解析与聚合，避免各写一套。
 */
export function createOcrReader(deps: OcrDeps) {
  const cache = new Map<string, { mtimeMs: number; loaded: LoadedText }>();

  function locate(fid: string): string | null {
    const rec = deps.index()?.files.find((f) => f.fid === fid);
    if (!rec?.textRef) return null;
    const root = resolve(deps.dataDir());
    const file = resolve(root, rec.textRef);
    // textRef 来自索引文件，仍按不可信输入处理：只允许落在数据目录内
    if (!file.startsWith(root + sep) || !existsSync(file)) return null;
    return file;
  }

  function load(fid: string): LoadedText | null {
    const file = locate(fid);
    if (!file) return null;
    const mtimeMs = statSync(file).mtimeMs;
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.loaded;

    const pages = new Map<number, OcrPage>();
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      try {
        const p = JSON.parse(raw) as OcrPage;
        if (typeof p?.p === 'number') pages.set(p.p, p);
      } catch {
        // 末行可能被中断的 OCR 进程写成半截，跳过
      }
    }
    // 归一化一次就缓存：全库检索时每页都转一遍太慢
    const normMap = new Map<number, { n: string; aligned: boolean }>();
    for (const [p, page] of pages) {
      const n = norm(page.text);
      normMap.set(p, { n, aligned: n.length === page.text.length });
    }
    const loaded = { pages, norm: normMap };
    cache.set(file, { mtimeMs, loaded });
    return loaded;
  }

  return {
    /** 控制面：这本书有没有 OCR 文本、识别到第几页、是否整本完成。 */
    info(fid: string) {
      const rec = deps.index()?.files.find((f) => f.fid === fid);
      const pages = load(fid)?.pages;
      if (!pages?.size) return { ok: false as const, error: '这本书还没有 OCR 文本' };
      const last = Math.max(...pages.keys());
      return { ok: true as const, pages: last, done: rec?.ocrStatus === 'done' };
    },

    /** 数据面：单页文本。带 q 时顺带返回命中区间（基于原始文本的下标，繁简已对齐）。 */
    page(fid: string, p: number, q?: string): (OcrPage & { marks?: Array<[number, number]> }) | null {
      const loaded = load(fid);
      const page = loaded?.pages.get(p) ?? null;
      if (!page || !loaded || !q?.trim()) return page;
      const np = loaded.norm.get(p);
      const needle = norm(q.trim());
      if (!np?.aligned || !needle) return { ...page, marks: [] };
      const marks: Array<[number, number]> = [];
      for (let at = np.n.indexOf(needle); at !== -1; at = np.n.indexOf(needle, at + needle.length)) {
        marks.push([at, at + needle.length]);
      }
      return { ...page, marks };
    },

    /** 书内搜索：返回命中页码和每页命中次数。 */
    search(fid: string, q: string) {
      const loaded = load(fid);
      const needle = norm(q.trim());
      if (!loaded || !needle) return { hits: [] as Array<{ p: number; n: number }>, total: 0 };
      const { hits, count } = scanLoaded(loaded, needle);
      return { hits, total: count };
    },

    /** 全库全文检索（同步兜底版）：按书聚合，每本只带前几个命中页和一句片段。 */
    searchAll(q: string, limit = 20) {
      const idx = deps.index();
      const needle = norm(q.trim());
      if (!idx || !needle) return { total: 0, books: [] as TextBookHit[] };

      const books = new Map<string, TextBookHit>();
      const titles = new Map(idx.books.map((b) => [b.id, b.title] as const));
      let total = 0;

      for (const rec of idx.files) {
        if (!rec.textRef) continue;
        const loaded = load(rec.fid);
        if (!loaded) continue;
        const { hits, count } = scanLoaded(loaded, needle);
        if (!count) continue;
        total += count;
        mergeFileHit(books, {
          fid: rec.fid,
          bookId: rec.bookId,
          title: titles.get(rec.bookId) ?? rec.bookId,
          name: rec.name,
          textRef: rec.textRef,
        }, loaded, hits, count, needle);
      }

      return { total, books: finalizeBooks(books, limit) };
    },
  };
}
