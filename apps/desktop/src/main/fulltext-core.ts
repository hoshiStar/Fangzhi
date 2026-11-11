import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { Converter } from 'opencc-js';

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

export interface TextSearchResult {
  total: number;
  books: TextBookHit[];
  /** 被更新的查询顶掉，结果不可用。 */
  canceled?: boolean;
  /** worker 不可用，退回到主进程同步扫描。 */
  degraded?: boolean;
}

/** 交给检索的一本书内文件：只带检索需要的字段，避免把整个索引塞进 worker。 */
export interface TextFileTask {
  fid: string;
  bookId: string;
  title: string;
  name: string;
  textRef: string;
}

const t2s = Converter({ from: 'tw', to: 'cn' });

/** 检索用的归一化：OCR 文本多为繁体，简体查询也要能命中。 */
export function normalizeText(s: string): string {
  return t2s(s);
}

export interface LoadedText {
  pages: Map<number, OcrPage>;
  /** 检索用：整页文本归一化成简体。aligned 表示和原文等长，下标可以直接互换。 */
  norm: Map<number, { n: string; aligned: boolean }>;
}

/** textRef 来自索引文件，按不可信输入处理：只允许落在数据目录内。 */
export function resolveTextPath(dataDir: string, textRef: string): string | null {
  const root = resolve(dataDir);
  const file = resolve(root, textRef);
  if (!file.startsWith(root + sep) || !existsSync(file)) return null;
  return file;
}

export function textFileMtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

/** 解析 data/ocr/<fid>.jsonl（见 tools/ocr/ocr.py），顺手把整页文本归一化一次。 */
export function parseTextFile(content: string): LoadedText {
  const pages = new Map<number, OcrPage>();
  for (const raw of content.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const p = JSON.parse(raw) as OcrPage;
      if (typeof p?.p === 'number') pages.set(p.p, p);
    } catch {
      // 末行可能被中断的 OCR 进程写成半截，跳过
    }
  }
  const norm = new Map<number, { n: string; aligned: boolean }>();
  for (const [p, page] of pages) {
    const n = normalizeText(page.text);
    norm.set(p, { n, aligned: n.length === page.text.length });
  }
  return { pages, norm };
}

export function loadTextFile(file: string): LoadedText {
  return parseTextFile(readFileSync(file, 'utf8'));
}

/* ---------- 持久化文本缓存 ---------- */

/**
 * OCR 的 jsonl 每页都带 lines（每个字的坐标框），比正文大一倍以上；再叠上 opencc
 * 逐页归一化，全库首次检索就得啃上千个文件。这里把「检索真正要用的两样东西」——
 * 原文和归一化文本——单独落一份紧凑缓存，键是源文件 mtime，重跑识别自动失效。
 *
 * 格式刻意不用 JSON：一行一页，字段用 \t 分隔，正文里的换行/制表符用控制字符占位，
 * 解析成本比 JSON.parse 一个带坐标数组的对象低一个量级。
 */
const CACHE_MAGIC = 'FZTC1';
const NL = '\u0001';
const TAB = '\u0002';

function escapeCell(s: string): string {
  return s.replace(/\n/g, NL).replace(/\t/g, TAB);
}
function unescapeCell(s: string): string {
  return s.replace(new RegExp(NL, 'g'), '\n').replace(new RegExp(TAB, 'g'), '\t');
}

/** 缓存放数据目录下的隐藏子目录，跟着索引走；fid 只保留安全字符当文件名。 */
export function textCachePath(dataDir: string, fid: string): string {
  return join(dataDir, '.text-cache', `${fid.replace(/[^\w-]/g, '_').slice(0, 100)}.txt`);
}

export function serializeTextCache(loaded: LoadedText, mtimeMs: number): string {
  const rows: string[] = [`${CACHE_MAGIC}\t${mtimeMs}\t${loaded.pages.size}`];
  for (const p of [...loaded.pages.keys()].sort((a, b) => a - b)) {
    const page = loaded.pages.get(p)!;
    const np = loaded.norm.get(p);
    const text = page.text;
    const n = np?.n ?? text;
    rows.push([
      p,
      np?.aligned ? 1 : 0,
      escapeCell(text),
      // 归一化后和原文一字不差（本来就是简体）时不重复存
      n === text ? '' : escapeCell(n),
    ].join('\t'));
  }
  return rows.join('\n') + '\n';
}

/** mtime 对不上（OCR 重跑过）就当没有缓存。 */
export function parseTextCache(content: string, mtimeMs: number): LoadedText | null {
  const lines = content.split('\n');
  const head = lines[0]?.split('\t') ?? [];
  if (head[0] !== CACHE_MAGIC || Number(head[1]) !== mtimeMs) return null;

  const pages = new Map<number, OcrPage>();
  const norm = new Map<number, { n: string; aligned: boolean }>();
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw) continue;
    const cell = raw.split('\t');
    if (cell.length < 3) continue;
    const p = Number(cell[0]);
    if (!Number.isInteger(p)) continue;
    const aligned = cell[1] === '1';
    const text = unescapeCell(cell[2] ?? '');
    const n = cell[3] ? unescapeCell(cell[3]) : text;
    pages.set(p, { p, dpi: 0, w: 0, h: 0, text, lines: [] });
    norm.set(p, { n, aligned });
  }
  if (!pages.size) return null;
  return { pages, norm };
}

/**
 * 取一份可直接检索的文本：优先读缓存，没缓存（或已过期）才解析 jsonl 并回写。
 * 写缓存是尽力而为——打包版的数据目录可能是只读的，失败不能影响检索。
 */
export function loadTextFast(file: string, cacheFile: string): { loaded: LoadedText; fromCache: boolean } | null {
  const mtimeMs = textFileMtime(file);
  if (mtimeMs < 0) return null;

  try {
    const cached = parseTextCache(readFileSync(cacheFile, 'utf8'), mtimeMs);
    if (cached) return { loaded: cached, fromCache: true };
  } catch {
    // 没有缓存文件是常态
  }

  let loaded: LoadedText;
  try {
    loaded = loadTextFile(file);
  } catch {
    return null;
  }
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    writeFileSync(tmp, serializeTextCache(loaded, mtimeMs));
    renameSync(tmp, cacheFile);
  } catch {
    // 只读目录或磁盘满：下次还是要重新解析，但不影响本次结果
  }
  return { loaded, fromCache: false };
}

export function countIn(hay: string, needle: string): number {
  let n = 0;
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) n++;
  return n;
}

/** 单个文件内按页统计命中次数，页码升序。 */
export function scanLoaded(loaded: LoadedText, needle: string): { hits: Array<{ p: number; n: number }>; count: number } {
  const hits: Array<{ p: number; n: number }> = [];
  let count = 0;
  for (const p of [...loaded.pages.keys()].sort((a, b) => a - b)) {
    const n = countIn(loaded.norm.get(p)?.n ?? '', needle);
    if (n) {
      hits.push({ p, n });
      count += n;
    }
  }
  return { hits, count };
}

/**
 * 命中片段。normalized 页面等长时直接用原文切片，保留 OCR 的原始字形；
 * 不等长（繁简转换改变了长度）退回归一化文本，靠 marks 空数组表示无法精确高亮。
 */
export function pageSnippet(
  loaded: LoadedText,
  p: number,
  needle: string,
): { snippet: string; marks: Array<[number, number]> } {
  const page = loaded.pages.get(p);
  const np = loaded.norm.get(p);
  if (!page || !np) return { snippet: '', marks: [] };
  const at = np.n.indexOf(needle);
  if (at < 0) return { snippet: '', marks: [] };
  // 片段里 \n 换成空格，长度不变，marks 依然对得上
  const src = np.aligned ? page.text : np.n;
  const from = Math.max(0, at - 24);
  const to = Math.max(from, at) + needle.length + 40;
  return {
    snippet: src.slice(from, to).replace(/\n/g, ' '),
    marks: np.aligned ? [[at - from, at - from + needle.length]] : [],
  };
}

/** 把单个文件的命中并进书目聚合表。 */
export function mergeFileHit(
  books: Map<string, TextBookHit>,
  task: TextFileTask,
  loaded: LoadedText,
  hits: Array<{ p: number; n: number }>,
  count: number,
  needle: string,
): void {
  const first = hits[0]!;
  const { snippet, marks } = pageSnippet(loaded, first.p, needle);
  const book = books.get(task.bookId) ?? {
    bookId: task.bookId,
    title: task.title || task.bookId,
    count: 0,
    files: [],
  };
  book.count += count;
  book.files.push({ fid: task.fid, name: task.name, count, pages: hits.slice(0, 3), snippet, marks });
  books.set(task.bookId, book);
}

/** 按命中次数排序，每本只留前几个文件，最后截到 limit 本。 */
export function finalizeBooks(books: Map<string, TextBookHit>, limit: number): TextBookHit[] {
  const sorted = [...books.values()].sort((a, b) => b.count - a.count);
  for (const b of sorted) b.files.sort((x, y) => y.count - x.count);
  return sorted.slice(0, limit);
}

/** 主进程兜底路径（worker 起不来时用）：同步逐文件扫。 */
export function scanAllSync(
  tasks: TextFileTask[],
  dataDir: string,
  q: string,
  limit: number,
): TextSearchResult {
  const needle = normalizeText(q.trim());
  if (!needle) return { total: 0, books: [] };
  const books = new Map<string, TextBookHit>();
  let total = 0;
  for (const task of tasks) {
    const file = resolveTextPath(dataDir, task.textRef);
    if (!file) continue;
    // 兜底路径同样吃磁盘缓存：至少别让界面在同步扫描时重复做 opencc
    const r = loadTextFast(file, textCachePath(dataDir, task.fid));
    if (!r) continue;
    const { hits, count } = scanLoaded(r.loaded, needle);
    if (!count) continue;
    total += count;
    mergeFileHit(books, task, r.loaded, hits, count, needle);
  }
  return { total, books: finalizeBooks(books, limit) };
}
