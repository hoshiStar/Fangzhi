import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { GazetteerIndex } from '@fangzhi/core';
import { Converter } from 'opencc-js';

export interface OcrDeps {
  index(): GazetteerIndex | null;
  /** 索引所在目录，textRef 是相对它的路径。 */
  dataDir(): string;
}

export interface OcrLine {
  t: string;
  /** [x0, y0, x1, y1]，基于该页按 dpi 渲染后的像素。 */
  b: number[];
  s: number;
}

export interface OcrPage {
  p: number;
  dpi: number;
  w: number;
  h: number;
  dir?: 'v' | 'h';
  text: string;
  lines: OcrLine[];
}

/** 全库全文命中的一部书。 */
export interface TextBookHit {
  bookId: string;
  title: string;
  count: number;
  files: Array<{
    fid: string;
    name: string;
    count: number;
    pages: Array<{ p: number; n: number }>;
    snippet: string;
    /** snippet 里的命中区间，供渲染层高亮（繁简已对齐）。 */
    marks: Array<[number, number]>;
  }>;
}

interface Loaded {
  pages: Map<number, OcrPage>;
  /** 检索用：整页文本归一化成简体，避免简体查询搜不到繁体 OCR 文本。 */
  norm: Map<number, { n: string; aligned: boolean }>;
}

const t2s = Converter({ from: 'tw', to: 'cn' });
const norm = (s: string): string => t2s(s);

/**
 * 读 OCR 产物（data/ocr/<fid>.jsonl，见 tools/ocr/ocr.py）。
 * 阅读器只按页取，不整本塞进渲染进程；文件在 OCR 重跑后会变，用 mtime 失效缓存。
 */
export function createOcrReader(deps: OcrDeps) {
  const cache = new Map<string, { mtimeMs: number; loaded: Loaded }>();

  function load(fid: string): Loaded | null {
    const rec = deps.index()?.files.find((f) => f.fid === fid);
    if (!rec?.textRef) return null;
    const root = resolve(deps.dataDir());
    const file = resolve(root, rec.textRef);
    // textRef 来自索引文件，仍按不可信输入处理：只允许落在数据目录内
    if (!file.startsWith(root + sep) || !existsSync(file)) return null;

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

  function countIn(hay: string, needle: string): number {
    let n = 0;
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) n++;
    return n;
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
      const hits: Array<{ p: number; n: number }> = [];
      let total = 0;
      for (const p of [...loaded.pages.keys()].sort((a, b) => a - b)) {
        const n = countIn(loaded.norm.get(p)?.n ?? '', needle);
        if (n) {
          hits.push({ p, n });
          total += n;
        }
      }
      return { hits, total };
    },

    /** 全库全文检索：按书聚合，每本只带前几个命中页和一句片段，按命中次数排序。 */
    searchAll(q: string, limit = 20) {
      const idx = deps.index();
      const needle = norm(q.trim());
      if (!idx || !needle) return { total: 0, books: [] as TextBookHit[] };

      const titles = new Map(idx.books.map((b) => [b.id, b.title]));
      const books = new Map<string, TextBookHit>();
      let total = 0;

      for (const rec of idx.files) {
        if (!rec.textRef) continue;
        const loaded = load(rec.fid);
        if (!loaded) continue;
        const hits: Array<{ p: number; n: number }> = [];
        for (const p of [...loaded.pages.keys()].sort((a, b) => a - b)) {
          const n = countIn(loaded.norm.get(p)?.n ?? '', needle);
          if (n) hits.push({ p, n });
        }
        if (!hits.length) continue;
        const count = hits.reduce((s, h) => s + h.n, 0);
        total += count;

        const first = loaded.pages.get(hits[0]!.p)!;
        const np = loaded.norm.get(hits[0]!.p)!;
        const at = np.n.indexOf(needle);
        // aligned 时原始文本和归一化文本等长，下标可以直接用；片段里 \n 换成空格也保持等长
        const src = at >= 0 && np.aligned ? first.text : np.n;
        const from = Math.max(0, at - 24);
        const to = Math.max(from, at) + needle.length + 40;
        const snippet = src.slice(from, to).replace(/\n/g, ' ');
        const marks: Array<[number, number]> = at >= 0 && np.aligned
          ? [[at - from, at - from + needle.length]]
          : [];

        const hit: TextBookHit = books.get(rec.bookId) ?? {
          bookId: rec.bookId,
          title: titles.get(rec.bookId) ?? rec.bookId,
          count: 0,
          files: [],
        };
        hit.count += count;
        hit.files.push({ fid: rec.fid, name: rec.name, count, pages: hits.slice(0, 3), snippet, marks });
        books.set(rec.bookId, hit);
      }

      const sorted = [...books.values()].sort((a, b) => b.count - a.count);
      for (const b of sorted) b.files.sort((x, y) => y.count - x.count);
      return { total, books: sorted.slice(0, limit) };
    },
  };
}
