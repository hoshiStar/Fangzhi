import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { countIn, loadTextFast, resolveTextPath, textCachePath, textFileMtime } from './fulltext-core.ts';
import type { LoadedText, TextFileTask } from './fulltext-core.ts';

/**
 * 全文倒排索引：双字（bigram）→ 页。
 *
 * 为什么不建「词 → 页」：中文没有空格，分词要么依赖词典（古籍里的地名、人名、
 * 职官名大量不在通用词典里），要么把整串字当词。双字索引既不用词典，又能让
 * 任意查询落到有限候选页上——查「赣州府志」就是「赣州」「州府」「府志」三张
 * 倒排表求交，剩下的逐页核实交给正文。
 *
 * 体积：postings 用「文档内页码升序 + delta + varint」，一条命中平均一字节多一点。
 * 高频双字（「府志」这种）单条倒排能到几十万条，全部留下会让索引比语料还大，
 * 所以超过 dfCap 的双字打上 PRUNED 标记：字典里留着「这个双字存在」，但不存倒排，
 * 查询时当作无约束条件，靠同串里其它低频双字收窄候选。查询全是高频双字时退回扫描。
 */

const MAGIC = 'FZTX';
const VERSION = 1;
/** 一个 posting 的键 = fidIdx * PAGE_UNIT + 页码；页码上限 99 万，够任何一本书用。 */
export const PAGE_UNIT = 1_000_000;
/** 被剪枝的高频双字：字典里有、倒排没有。 */
const PRUNED = 0xffffffff;

export interface IndexedFile {
  fid: string;
  mtimeMs: number;
  pages: number;
}

export interface TextIndexMeta {
  version: number;
  builtAt: string;
  dfCap: number;
  bigramCount: number;
  /** 因为太常见而被剪掉倒排的双字数，只用来诊断。 */
  prunedBigrams: number;
  postingCount: number;
  files: IndexedFile[];
}

export interface TextIndex {
  meta: TextIndexMeta;
  keys: Uint32Array;
  offsets: Uint32Array;
  counts: Uint32Array;
  blob: Buffer;
  /** OCR 重跑过、索引内容已不可信的文件，查询时按「未覆盖」整篇重扫。 */
  stale: Set<string>;
}

export function textIndexDir(dataDir: string): string {
  return join(dataDir, '.text-index');
}

/* ---------- 双字键 ---------- */

/**
 * 一对 UTF-16 码元 → 32 位键。代理对（扩展区生僻字）拆半没有意义，直接跳过；
 * 含这类字的查询会因此拿不到倒排，退回扫描，不影响正确性。
 */
function pairKey(a: number, b: number): number {
  if (a >= 0xd800 && a <= 0xdfff) return -1;
  if (b >= 0xd800 && b <= 0xdfff) return -1;
  return ((a << 16) | b) >>> 0;
}

/** 查询串覆盖到的双字键（去重、升序）。少于两个字返回 null。 */
export function bigramKeys(text: string): number[] | null {
  if (text.length < 2) return null;
  const set = new Set<number>();
  for (let i = 0; i + 1 < text.length; i++) {
    const k = pairKey(text.charCodeAt(i), text.charCodeAt(i + 1));
    if (k >= 0) set.add(k);
  }
  return set.size ? [...set].sort((a, b) => a - b) : null;
}

function encodeDeltas(list: number[]): Buffer {
  const out = Buffer.allocUnsafe(list.length * 5 + 8);
  let at = 0;
  let prev = 0;
  for (const v of list) {
    let d = v - prev;
    prev = v;
    while (d >= 0x80) {
      out[at++] = (d & 0x7f) | 0x80;
      d = Math.floor(d / 128);
    }
    out[at++] = d;
  }
  return out.subarray(0, at);
}

function decodeList(index: TextIndex, i: number): number[] {
  const count = index.counts[i]!;
  const out: number[] = new Array(count);
  let at = index.offsets[i]!;
  let prev = 0;
  for (let j = 0; j < count; j++) {
    let d = 0;
    let shift = 1;
    for (;;) {
      const b = index.blob[at++]!;
      d += (b & 0x7f) * shift;
      if (b < 0x80) break;
      shift *= 128;
    }
    prev += d;
    out[j] = prev;
  }
  return out;
}

function findKey(keys: Uint32Array, key: number): number {
  let lo = 0;
  let hi = keys.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = keys[mid]!;
    if (v === key) return mid;
    if (v < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/* ---------- 构建 ---------- */

export interface BuildOptions {
  /** 单个双字允许的最大倒排条数，超过就剪枝。 */
  dfCap?: number;
  onProgress?: (done: number, total: number) => void;
}

function writeAtomic(file: string, data: string | Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

/**
 * 建索引。输入和检索用同一份任务清单（fid + textRef），文本走 `.text-cache`，
 * 所以重复构建基本只在拼 postings。
 */
export function buildTextIndex(
  dataDir: string,
  tasks: TextFileTask[],
  opts: BuildOptions = {},
): TextIndexMeta {
  const dfCap = opts.dfCap ?? 20_000;
  const files: IndexedFile[] = [];
  const postings = new Map<number, number[]>();

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    const file = resolveTextPath(dataDir, task.textRef);
    const mtimeMs = file ? textFileMtime(file) : -1;
    if (!file || mtimeMs < 0) continue;
    const r = loadTextFast(file, textCachePath(dataDir, task.fid), mtimeMs);
    if (!r) continue;
    const fidIdx = files.length;
    files.push({ fid: task.fid, mtimeMs, pages: r.loaded.pages.size });

    for (const [p, np] of r.loaded.norm) {
      const text = np.n;
      if (text.length < 2) continue;
      // 同一页同一个双字只记一次：倒排是「双字 → 页」，页内重复次数留给核实阶段数
      const seen = new Set<number>();
      for (let at = 0; at + 1 < text.length; at++) {
        const k = pairKey(text.charCodeAt(at), text.charCodeAt(at + 1));
        if (k < 0 || seen.has(k)) continue;
        seen.add(k);
        const list = postings.get(k);
        if (list) list.push(fidIdx * PAGE_UNIT + p);
        else postings.set(k, [fidIdx * PAGE_UNIT + p]);
      }
    }
    opts.onProgress?.(i + 1, tasks.length);
  }

  const entries = [...postings.keys()].sort((a, b) => a - b);
  // 每项 12 字节：双字键 / 倒排偏移 / 条数。交错存放，读的时候顺序扫一遍就行。
  const table = Buffer.allocUnsafe(entries.length * 12);
  const chunks: Buffer[] = [];
  let blobLen = 0;
  let postingCount = 0;
  let prunedBigrams = 0;

  for (let i = 0; i < entries.length; i++) {
    const key = entries[i]!;
    const at = i * 12;
    table.writeUInt32LE(key, at);
    const list = postings.get(key)!;
    if (list.length > dfCap) {
      table.writeUInt32LE(PRUNED, at + 4);
      table.writeUInt32LE(PRUNED, at + 8);
      prunedBigrams++;
      continue;
    }
    list.sort((a, b) => a - b);
    const buf = encodeDeltas(list);
    table.writeUInt32LE(blobLen, at + 4);
    table.writeUInt32LE(list.length, at + 8);
    blobLen += buf.length;
    postingCount += list.length;
    chunks.push(buf);
  }
  const blob = Buffer.concat(chunks, blobLen);

  const head = Buffer.alloc(16);
  head.write(MAGIC, 0, 'latin1');
  head.writeUInt32LE(VERSION, 4);
  head.writeUInt32LE(entries.length, 8);
  head.writeUInt32LE(blob.length, 12);

  const dir = textIndexDir(dataDir);
  writeAtomic(join(dir, 'index.bin'), Buffer.concat([head, table, blob]));

  const meta: TextIndexMeta = {
    version: VERSION,
    builtAt: new Date().toISOString(),
    dfCap,
    bigramCount: entries.length,
    prunedBigrams,
    postingCount,
    files,
  };
  writeAtomic(join(dir, 'meta.json'), JSON.stringify(meta));
  // 全量重建后原来的失效标记就没意义了
  try {
    writeAtomic(join(dir, 'stale.json'), JSON.stringify({ fids: [] }));
  } catch {
    // 只读目录：索引能用，失效标记删不掉而已
  }
  return meta;
}

/* ---------- 加载与查询 ---------- */

let cached: { key: string; index: TextIndex | null } | null = null;

function staleFids(dir: string): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'stale.json'), 'utf8')) as { fids?: string[] };
    return new Set(Array.isArray(raw?.fids) ? raw.fids : []);
  } catch {
    return new Set();
  }
}

/** 读索引；文件缺失/版本不符/被截断一律当没有，调用方退回扫描。 */
export function loadTextIndex(dataDir: string): TextIndex | null {
  const dir = textIndexDir(dataDir);
  const binPath = join(dir, 'index.bin');
  const metaPath = join(dir, 'meta.json');
  let binStat;
  try {
    binStat = statSync(binPath);
  } catch {
    cached = null;
    return null;
  }
  let staleStat;
  try {
    staleStat = statSync(join(dir, 'stale.json'));
  } catch {
    staleStat = null;
  }
  const key = `${binStat.mtimeMs}:${binStat.size}:${staleStat?.mtimeMs ?? 0}`;
  if (cached?.key === key) return cached.index;

  let index: TextIndex | null = null;
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as TextIndexMeta;
    const buf = readFileSync(binPath);
    if (buf.toString('latin1', 0, 4) !== MAGIC) throw new Error('magic');
    const version = buf.readUInt32LE(4);
    if (version !== VERSION || meta.version !== VERSION) throw new Error('version');
    const n = buf.readUInt32LE(8);
    const blobLen = buf.readUInt32LE(12);
    if (buf.length < 16 + n * 12 + blobLen) throw new Error('truncated');
    const keys = new Uint32Array(n);
    const offsets = new Uint32Array(n);
    const counts = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      keys[i] = buf.readUInt32LE(16 + i * 12);
      offsets[i] = buf.readUInt32LE(20 + i * 12);
      counts[i] = buf.readUInt32LE(24 + i * 12);
    }
    const blobStart = 16 + n * 12;
    index = {
      meta,
      keys,
      offsets,
      counts,
      blob: buf.subarray(blobStart, blobStart + blobLen),
      stale: staleFids(dir),
    };
  } catch {
    index = null;
  }
  cached = { key, index };
  return index;
}

/**
 * 查询 → 候选页。返回 null 表示索引帮不上忙（查询太短、全是高频双字），
 * 调用方整批退回扫描；返回空 Map 表示索引覆盖的部分确实没有命中。
 */
export function candidatePages(index: TextIndex, needle: string): Map<number, number[]> | null {
  const keys = bigramKeys(needle);
  if (!keys) return null;

  const lists: number[][] = [];
  for (const key of keys) {
    const at = findKey(index.keys, key);
    // 字典里没有 = 全库都不含这个双字，覆盖范围直接判空
    if (at < 0) return new Map();
    if (index.counts[at] === PRUNED) continue;
    lists.push(decodeList(index, at));
  }
  // 全是高频双字，没有可用的收窄条件
  if (!lists.length) return null;

  lists.sort((a, b) => a.length - b.length);
  let acc = new Set<number>(lists[0]);
  for (let i = 1; i < lists.length && acc.size; i++) {
    const other = new Set(lists[i]);
    const next = new Set<number>();
    for (const v of acc) if (other.has(v)) next.add(v);
    acc = next;
  }

  const out = new Map<number, number[]>();
  for (const v of acc) {
    const fidIdx = Math.floor(v / PAGE_UNIT);
    const page = v % PAGE_UNIT;
    const pages = out.get(fidIdx);
    if (pages) pages.push(page);
    else out.set(fidIdx, [page]);
  }
  for (const pages of out.values()) pages.sort((a, b) => a - b);
  return out;
}

/** OCR 重跑过的文件登记失效：查询时按未覆盖整篇重扫，不用等重建整个索引。 */
export function invalidateTextIndexFiles(dataDir: string, fids: string[]): void {
  const list = [...new Set(fids.filter(Boolean))];
  if (!list.length) return;
  const dir = textIndexDir(dataDir);
  if (!existsSync(join(dir, 'meta.json'))) return;
  const merged = new Set([...staleFids(dir), ...list]);
  try {
    writeAtomic(join(dir, 'stale.json'), JSON.stringify({ fids: [...merged] }));
  } catch {
    // 只读数据目录：索引本身还能用，只是这些文件的新内容要等重建
  }
}

/** 索引覆盖到的文件（去掉已失效的）。 */
export function coveredFids(index: TextIndex): Set<string> {
  const out = new Set<string>();
  for (const f of index.meta.files) if (!index.stale.has(f.fid)) out.add(f.fid);
  return out;
}

export interface IndexedFileHit {
  task: TextFileTask;
  loaded: LoadedText;
  hits: Array<{ p: number; n: number }>;
  count: number;
  fromCache: boolean;
}

export interface IndexedSearchResult {
  /** 索引已经负责的文件：调用方不必再扫（候选之外的一律不可能命中）。 */
  covered: Set<string>;
  hits: IndexedFileHit[];
  /** 候选文件数，只用于诊断。 */
  candidates: number;
  stopped: boolean;
}

export interface IndexedSearchOptions {
  onProgress?: (done: number, total: number) => void;
  /** 新查询顶掉旧查询时提前收手。 */
  shouldStop?: () => boolean;
}

/**
 * 用倒排索引检索：候选页 → 逐页核实。
 * 返回 null 表示这次查询索引帮不上（太短、或全是高频双字），调用方整批扫描。
 */
export function searchTextIndex(
  index: TextIndex,
  dataDir: string,
  tasks: TextFileTask[],
  needle: string,
  opts: IndexedSearchOptions = {},
): IndexedSearchResult | null {
  const cand = candidatePages(index, needle);
  if (!cand) return null;

  const covered = coveredFids(index);
  const byFid = new Map<string, TextFileTask>();
  for (const t of tasks) byFid.set(t.fid, t);

  const hits: IndexedFileHit[] = [];
  let done = 0;
  let stopped = false;
  for (const [fidIdx, pages] of cand) {
    if (opts.shouldStop?.()) {
      stopped = true;
      break;
    }
    const meta = index.meta.files[fidIdx];
    const task = meta ? byFid.get(meta.fid) : undefined;
    if (!meta || !task) continue;
    // 标了失效的文件交给调用方整篇扫，避免「核实一次 + 扫描一次」重复计数
    if (index.stale.has(meta.fid)) continue;
    const hit = verifyFile(dataDir, task, needle, pages, meta.mtimeMs);
    if (hit) hits.push(hit);
    done++;
    if (done % 20 === 0 || done === cand.size) opts.onProgress?.(done, cand.size);
  }
  return { covered, hits, candidates: cand.size, stopped };
}

/**
 * 核实候选页：双字求交只保证「这几个字都在这一页」，是否连成词要看正文。
 * 索引里的 mtime 和当前文件对不上（OCR 重跑过）时不信候选页，整篇重扫。
 */
function verifyFile(
  dataDir: string,
  task: TextFileTask,
  needle: string,
  pages: number[],
  indexedMtime: number,
): IndexedFileHit | null {
  const file = resolveTextPath(dataDir, task.textRef);
  if (!file) return null;
  const mtimeMs = textFileMtime(file);
  if (mtimeMs < 0) return null;
  const r = loadTextFast(file, textCachePath(dataDir, task.fid), mtimeMs);
  if (!r) return null;

  const scanPages = mtimeMs === indexedMtime ? pages : [...r.loaded.pages.keys()].sort((a, b) => a - b);
  const hits: Array<{ p: number; n: number }> = [];
  let count = 0;
  for (const p of scanPages) {
    const n = countIn(r.loaded.norm.get(p)?.n ?? '', needle);
    if (n) {
      hits.push({ p, n });
      count += n;
    }
  }
  if (!count) return null;
  return { task, loaded: r.loaded, hits, count, fromCache: r.fromCache };
}
