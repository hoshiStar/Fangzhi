import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
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
  /** 出现过的字（见 textMask），用来在读整份正文之前先排除掉这个文件。 */
  mask?: Uint8Array;
}

/* ---------- 字符位图：查询前的负向过滤 ---------- */

/**
 * 全库扫一遍时最大的浪费不是比对，而是「把根本不含查询字的文件也读进内存再比对」。
 * 一部志的正文几百万字，但用到的汉字不过三四千个（占常用汉字的 20% 上下），
 * 所以给每份文本配一张「出现过的字」位图：查询里任意一个字位图上没有，这个文件
 * 一定不命中，连盘都不用读。
 *
 * 查询越长过滤越狠——六个字全都不在的概率是 0.2^6，全库基本只剩真正含这串字的文件。
 */
const CJK_START = 0x4e00;
const CJK_END = 0x9fff;
const CJK_SLOTS = CJK_END - CJK_START + 1;
const ASCII_START = 0x20;
const ASCII_END = 0x7e;
const ASCII_SLOTS = ASCII_END - ASCII_START + 1;
const MASK_BYTES = Math.ceil((CJK_SLOTS + ASCII_SLOTS) / 8);

/** 字符落在位图里的下标；返回 -1 表示这个字不参与过滤（标点、扩展区生僻字）。 */
function charSlot(cp: number): number {
  if (cp >= CJK_START && cp <= CJK_END) return cp - CJK_START;
  if (cp >= ASCII_START && cp <= ASCII_END) return CJK_SLOTS + cp - ASCII_START;
  return -1;
}

export function textMask(text: string): Uint8Array {
  const mask = new Uint8Array(MASK_BYTES);
  for (const ch of text) {
    const slot = charSlot(ch.codePointAt(0)!);
    if (slot >= 0) mask[slot >> 3]! |= 1 << (slot & 7);
  }
  return mask;
}

function mergeMask(into: Uint8Array, add: Uint8Array): void {
  for (let i = 0; i < into.length && i < add.length; i++) into[i]! |= add[i]!;
}

/** 位图说「不可能含」就一定不含；说「可能含」还要真扫一遍。 */
export function maskMayContain(mask: Uint8Array, needle: string): boolean {
  if (!mask.length) return true;
  for (const ch of needle) {
    const slot = charSlot(ch.codePointAt(0)!);
    if (slot < 0) continue;
    if (!(mask[slot >> 3]! & (1 << (slot & 7)))) return false;
  }
  return true;
}

/** 整份文本的位图：逐页归一化文本并起来，和检索时比对的是同一份字符。 */
function maskOfLoaded(loaded: LoadedText): Uint8Array {
  if (loaded.mask?.length === MASK_BYTES) return loaded.mask;
  const mask = new Uint8Array(MASK_BYTES);
  for (const { n } of loaded.norm.values()) mergeMask(mask, textMask(n));
  return mask;
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
  const mask = new Uint8Array(MASK_BYTES);
  for (const [p, page] of pages) {
    const n = normalizeText(page.text);
    norm.set(p, { n, aligned: n.length === page.text.length });
    mergeMask(mask, textMask(n));
  }
  return { pages, norm, mask };
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
const CACHE_MAGIC = 'FZTC2';
const NL = '\u0001';
const TAB = '\u0002';
/** 缓存头（含 base64 位图约 3.5KB）一定在前面，读这么多足够。 */
const HEADER_READ = 4096;

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
  const mask = Buffer.from(maskOfLoaded(loaded)).toString('base64');
  const rows: string[] = [`${CACHE_MAGIC}\t${mtimeMs}\t${loaded.pages.size}\t${mask}`];
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
  const mask = head[3] ? new Uint8Array(Buffer.from(head[3], 'base64')) : undefined;

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
  return { pages, norm, mask: mask?.length === MASK_BYTES ? mask : undefined };
}

/**
 * 只读缓存文件开头那点字节，拿到 mtime 和字符位图。命中不了的文件因此可以
 * 一个字节正文都不读——这是全库检索从「几秒」压到「几百毫秒」的关键。
 */
export function readCacheHeader(cacheFile: string): { mtimeMs: number; mask: Uint8Array } | null {
  let fd: number | null = null;
  try {
    fd = openSync(cacheFile, 'r');
    const buf = Buffer.allocUnsafe(HEADER_READ);
    const n = readSync(fd, buf, 0, HEADER_READ, 0);
    if (n <= 0) return null;
    const text = buf.subarray(0, n).toString('utf8');
    const nl = text.indexOf('\n');
    // 缓存头没读完（理论上不会，位图是定长）就当无从判断
    if (nl < 0) return null;
    const cell = text.slice(0, nl).split('\t');
    if (cell[0] !== CACHE_MAGIC) return null;
    const mtimeMs = Number(cell[1]);
    if (!Number.isFinite(mtimeMs)) return null;
    const mask = new Uint8Array(Buffer.from(cell[3] ?? '', 'base64'));
    if (mask.length !== MASK_BYTES) return null;
    return { mtimeMs, mask };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 忽略
      }
    }
  }
}

/**
 * 取一份可直接检索的文本：优先读缓存，没缓存（或已过期）才解析 jsonl 并回写。
 * 写缓存是尽力而为——打包版的数据目录可能是只读的，失败不能影响检索。
 */
export function loadTextFast(
  file: string,
  cacheFile: string,
  knownMtime?: number,
): { loaded: LoadedText; fromCache: boolean } | null {
  const mtimeMs = knownMtime ?? textFileMtime(file);
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

/**
 * 位图进程内缓存。全库上千个文件、每个 stat + open + read 三四个系统调用，
 * 一次扫描光这些就要一两秒；位图才 2.6KB，全存下来 8MB，换来后续查询零 IO。
 * 键是文件路径，值里带 mtime——OCR 重跑、缓存重建都会让 mtime 变，自然失效。
 */
const maskCache = new Map<string, { mtimeMs: number; mask: Uint8Array }>();
const MAX_MASK_ENTRIES = 8000;

/** 取某个文件的位图（进程内缓存优先，没有才读缓存头）。 */
export function cachedMask(file: string, cacheFile: string): { mtimeMs: number; mask: Uint8Array } | null {
  const hit = maskCache.get(file);
  if (hit) {
    maskCache.delete(file);
    maskCache.set(file, hit);
    return hit;
  }
  const head = readCacheHeader(cacheFile);
  if (head) {
    maskCache.set(file, head);
    while (maskCache.size > MAX_MASK_ENTRIES) {
      const oldest = maskCache.keys().next();
      if (oldest.done) break;
      maskCache.delete(oldest.value);
    }
  }
  return head;
}

/** 已有位图（刚解析/刚加载出来）时直接登记，省掉一次读缓存头。 */
export function rememberMask(file: string, mtimeMs: number, mask: Uint8Array): void {
  if (!mask.length) return;
  maskCache.delete(file);
  maskCache.set(file, { mtimeMs, mask });
  while (maskCache.size > MAX_MASK_ENTRIES) {
    const oldest = maskCache.keys().next();
    if (oldest.done) break;
    maskCache.delete(oldest.value);
  }
}

/** 测试用：清掉位图缓存，模拟换一个进程。 */
export function clearMaskCache(): void {
  maskCache.clear();
}

/**
 * 检索前的取文本：先看缓存头的字符位图，明摆着不含查询字的文件直接跳过，
 * 一个字节正文都不读；可能命中的才真正加载。
 */
export function loadForSearch(dataDir: string, task: TextFileTask, needle: string): LoadedText | null {
  const file = resolveTextPath(dataDir, task.textRef);
  if (!file) return null;
  const mtimeMs = textFileMtime(file);
  if (mtimeMs < 0) return null;
  const cacheFile = textCachePath(dataDir, task.fid);
  const head = cachedMask(file, cacheFile);
  if (head && head.mtimeMs === mtimeMs && !maskMayContain(head.mask, needle)) return null;
  const r = loadTextFast(file, cacheFile, mtimeMs);
  // 缓存缺失或过期时刚重解析出来的位图更可信，再判一次
  if (!r) return null;
  if (r.loaded.mask) {
    rememberMask(file, mtimeMs, r.loaded.mask);
    if (!maskMayContain(r.loaded.mask, needle)) return null;
  }
  return r.loaded;
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
    // 位图先过一遍：命中不了的文件连缓存正文都不用读
    const loaded = loadForSearch(dataDir, task, needle);
    if (!loaded) continue;
    const { hits, count } = scanLoaded(loaded, needle);
    if (!count) continue;
    total += count;
    mergeFileHit(books, task, loaded, hits, count, needle);
  }
  return { total, books: finalizeBooks(books, limit) };
}
