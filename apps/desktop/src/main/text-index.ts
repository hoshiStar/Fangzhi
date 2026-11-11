import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { countIn, loadTextFast, resolveTextPath, textCachePath, textFileMtime } from './fulltext-core.ts';
import type { LoadedText, TextFileTask } from './fulltext-core.ts';
import {
  MAGIC, PAGE_UNIT, PRUNED, VERSION, bigramKeys, decodeList, findKey, sameMtime, textIndexDir,
  writeAtomic,
} from './text-index-format.ts';
import type { IndexedFile, TextIndex, TextIndexMeta } from './text-index-format.ts';

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
 *
 * 这个文件只管「已经落盘的索引怎么读、怎么查、怎么标失效」；
 * 构建（含超大语料的分批落盘）在 text-index-build.ts，格式在 text-index-format.ts。
 */

// 兼容旧的导入处：格式常量与类型从 format 模块转出去
export { PAGE_UNIT, bigramKeys, textIndexDir, MAGIC, VERSION } from './text-index-format.ts';
export type { IndexedFile, TextIndex, TextIndexMeta } from './text-index-format.ts';

/* ---------- 失效标记 ---------- */

function staleFids(dir: string): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'stale.json'), 'utf8')) as { fids?: string[] };
    return new Set(Array.isArray(raw?.fids) ? raw.fids : []);
  } catch {
    return new Set();
  }
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

/* ---------- 加载 ---------- */

let cached: { key: string; index: TextIndex | null } | null = null;

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
  // 键里必须带路径：两个数据目录可能在同一毫秒写出同样大小的 index.bin
  const key = `${binPath}:${binStat.mtimeMs}:${binStat.size}:${staleStat?.mtimeMs ?? 0}`;
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

/* ---------- 查询 ---------- */

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

  const scanPages = sameMtime(mtimeMs, indexedMtime) ? pages : [...r.loaded.pages.keys()].sort((a, b) => a - b);
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

/* ---------- 同步预检 ---------- */

/**
 * 轻量判断「值不值得跑一次增量」。主进程用它决定要不要起线程：
 * 只读 meta.json（几百 KB）逐个 stat 文本，不碰几十 MB 的 index.bin。
 */
export function textIndexSyncNeeded(dataDir: string, tasks: TextFileTask[]): boolean {
  if (!tasks.length) return false;
  const dir = textIndexDir(dataDir);
  if (!existsSync(join(dir, 'index.bin'))) return true;
  let meta: TextIndexMeta;
  try {
    meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as TextIndexMeta;
  } catch {
    return true;
  }
  if (meta.version !== VERSION || !Array.isArray(meta.files)) return true;
  const stale = staleFids(dir);
  const known = new Map<string, number>(meta.files.map((f: IndexedFile) => [f.fid, f.mtimeMs] as const));
  let seen = 0;
  for (const task of tasks) {
    const file = resolveTextPath(dataDir, task.textRef);
    if (!file) continue;
    const mtimeMs = textFileMtime(file);
    if (mtimeMs < 0) continue;
    seen++;
    if (!sameMtime(known.get(task.fid) ?? NaN, mtimeMs) || stale.has(task.fid)) return true;
  }
  // 条数对不上就说明有文件进/出，交给增量逻辑去分新增和移除
  return seen !== meta.files.length;
}
