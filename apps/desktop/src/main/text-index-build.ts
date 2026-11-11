import {
  appendFileSync, closeSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { loadTextFast, resolveTextPath, textCachePath, textFileMtime } from './fulltext-core.ts';
import type { TextFileTask } from './fulltext-core.ts';
import {
  MAGIC, MAX_FILES, PAGE_UNIT, PRUNED, VERSION, decodeList, dedupeSorted, encodeDeltas, pairKey,
  sameMtime, textIndexDir, writeAtomic,
} from './text-index-format.ts';
import type { IndexedFile, TextIndex, TextIndexMeta } from './text-index-format.ts';
import { loadTextIndex } from './text-index.ts';

/**
 * 倒排索引的构建：全量与增量，都在这里。
 *
 * 小语料直接在内存里拼 `Map<双字, 页码[]>`，一次写成 index.bin——这是绝大多数
 * 情况下的路径（几千页到几万页）。但 posting 的条数约等于「页数 × 每页不同双字
 * 数」，古籍一页上千个双字很正常，十万页量级就要几百 MB，百万页直接爆掉。
 * 因此加了一条落盘路径：
 *
 *   攒够 postingBuffer 条 → 按首字排序后追加到一个 run 文件（`.text-index/.build-<pid>/s<N>.bin`）
 *   → 多个 run 用多路归并合成「桶 → (双字 → 页码[])」
 *   → 每个桶排序去重、剪枝、按升序编码 → 顺序写进 table.tmp / blob.tmp
 *   → 拼成最终 index.bin
 *
 * 两个关键取舍：
 * 1. **每个桶只差「次字」**。桶号取 key 的高 16 位（首字），桶内只剩次字，所以
 *    「桶号升序 + 桶内升序」就是全局双字升序，不必做全量外部排序。
 * 2. **一轮只写一个文件**。按桶分文件（首字有三千个）更直观，但本机每次
 *    appendFileSync 到不同文件约 1.4ms（杀软逐个文件扫描），几千个桶每轮就是
 *    几秒；改成「一个 run 文件 + 归并」后同样的语料快一个数量级。
 *
 * 单个桶就是「首字相同」的全部双字：键数天然 ≤ 65536（次字的全部可能），
 * 所以内存上限由页数决定，与语料总规模无关。
 */

export interface BuildOptions {
  /** 单个双字允许的最大倒排条数，超过就剪枝。 */
  dfCap?: number;
  /** 内存里最多攒多少条 posting（「双字-页」对）就落盘，默认 40 万条。 */
  postingBuffer?: number;
  /** 分桶位移：桶号 = key >>> partitionShift，默认 16（即「首字相同」进一个桶）。 */
  partitionShift?: number;
  /** 归并时同时打开多少个 run，默认 32；超过就先做一轮中间归并。 */
  mergeFanIn?: number;
  onProgress?: (done: number, total: number, phase: BuildPhase) => void;
}

export type BuildPhase = 'scan' | 'merge';

const DEFAULT_BUFFER = 400_000;
const DEFAULT_SHIFT = 16;
const DEFAULT_FAN_IN = 32;
const READ_CHUNK = 1 << 16;
const WRITE_CHUNK = 1 << 18;
/**
 * 「这个双字被剪枝」的占位 posting。增量更新时旧索引里的 PRUNED 条目要原样带进
 * 新索引，走落盘路径时它必须和普通 posting 一起进桶，否则顺序会乱。
 * PAGE_UNIT = 10 万时真实 posting 最大 4,294,899,999，不会撞上这个值。
 */
const PRUNE_MARK = 0xffffffff;

/* ---------- 写盘小工具 ---------- */

function writeAll(fd: number, buf: Buffer, len: number): void {
  let off = 0;
  while (off < len) off += writeSync(fd, buf, off, len - off);
}

function copyInto(dstFd: number, file: string): void {
  const src = openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = readSync(src, buf, 0, buf.length, null);
      if (!n) break;
      writeAll(dstFd, buf, n);
    }
  } finally {
    closeSync(src);
  }
}

function writeMeta(dir: string, meta: TextIndexMeta): void {
  writeAtomic(join(dir, 'meta.json'), JSON.stringify(meta));
  // 重新落盘后，被登记失效的文件已经重扫过，标记就没意义了
  try {
    writeAtomic(join(dir, 'stale.json'), JSON.stringify({ fids: [] }));
  } catch {
    // 只读目录：索引能用，失效标记删不掉而已
  }
}

/** 一条 8 字节记录的缓冲写入器（归并中间产物用）。 */
class RecordWriter {
  private buf = Buffer.allocUnsafe(WRITE_CHUNK);
  private len = 0;
  private fd: number;

  constructor(file: string) {
    this.fd = openSync(file, 'w');
  }

  write(key: number, ref: number): void {
    if (this.len + 8 > this.buf.length) this.flush();
    this.buf.writeUInt32LE(key, this.len);
    this.buf.writeUInt32LE(ref, this.len + 4);
    this.len += 8;
  }

  private flush(): void {
    if (this.len) writeAll(this.fd, this.buf, this.len);
    this.len = 0;
  }

  close(): void {
    this.flush();
    closeSync(this.fd);
  }
}

/** 一条 8 字节记录的缓冲读取器；`key < 0` 表示读完。 */
class RunReader {
  key = -1;
  ref = 0;
  private buf = Buffer.allocUnsafe(READ_CHUNK);
  private pos = 0;
  private end = 0;
  private fd: number;

  constructor(file: string) {
    this.fd = openSync(file, 'r');
  }

  next(): boolean {
    if (this.pos + 8 > this.end && !this.fill()) {
      this.key = -1;
      return false;
    }
    this.key = this.buf.readUInt32LE(this.pos);
    this.ref = this.buf.readUInt32LE(this.pos + 4);
    this.pos += 8;
    return true;
  }

  private fill(): boolean {
    const rest = this.end - this.pos;
    if (rest > 0) this.buf.copy(this.buf, 0, this.pos, this.end);
    this.pos = 0;
    this.end = rest;
    const n = readSync(this.fd, this.buf, this.end, this.buf.length - this.end, null);
    this.end += n;
    return this.end - this.pos >= 8;
  }

  close(): void {
    closeSync(this.fd);
  }
}

/* ---------- 内存路径 ---------- */

/**
 * 把 files + postings 直接落盘。落盘路径产出的字节必须和这里一致：
 * 都是「双字升序 + delta/varint」，两路可以逐字节对比（有测试盯着）。
 */
function writeIndex(
  dataDir: string,
  files: IndexedFile[],
  postings: Map<number, number[]>,
  pruned: ReadonlySet<number>,
  dfCap: number,
): TextIndexMeta {
  // 剪枝过的双字也要留在字典里：「这个双字存在、但倒排太大」本身就是有用信息
  const keySet = new Set<number>(postings.keys());
  for (const k of pruned) keySet.add(k);
  const entries = [...keySet].sort((a, b) => a - b);

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
    const list = pruned.has(key) ? undefined : postings.get(key);
    if (!list || list.length > dfCap) {
      table.writeUInt32LE(PRUNED, at + 4);
      table.writeUInt32LE(PRUNED, at + 8);
      prunedBigrams++;
      continue;
    }
    const sorted = dedupeSorted(list);
    const buf = encodeDeltas(sorted);
    table.writeUInt32LE(blobLen, at + 4);
    table.writeUInt32LE(sorted.length, at + 8);
    blobLen += buf.length;
    postingCount += sorted.length;
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
  writeMeta(dir, meta);
  return meta;
}

/* ---------- 落盘路径 ---------- */

export interface PostingSink {
  /** 收一条「双字 → 页」；重复由最后统一去重。 */
  add(key: number, ref: number): void;
  /** 记一个被剪枝的双字（旧索引带过来的）。 */
  addPruned(key: number): void;
  /** 扫完正文：归并 run、写出 index.bin，并清掉临时目录。 */
  finish(files: IndexedFile[], dfCap: number): TextIndexMeta;
  /** 出错时清掉临时目录（可重复调用）。 */
  dispose(): void;
}

interface SinkOptions {
  dataDir: string;
  budget: number;
  shift: number;
  fanIn: number;
  onMerge?: (done: number, total: number) => void;
}

/**
 * postings 收集器。内存没超预算就全在内存里（快路径）；超了就把已攒内容按桶
 * 排序写成第一个 run 文件，之后按桶缓存、成批追加。
 */
export function createPostingSink(opts: SinkOptions): PostingSink {
  const mem = new Map<number, number[]>();
  const prunedKeys = new Set<number>();
  const parts = new Map<number, number[]>();
  let memCount = 0;
  let buffered = 0;
  let spilled = false;
  let runSeq = 0;
  let totalPairs = 0;
  let dir: string | null = null;

  const bucketOf = (key: number): number => key >>> opts.shift;

  function ensureDir(): string {
    if (!dir) {
      dir = join(textIndexDir(opts.dataDir), `.build-${process.pid}-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  function buffer(key: number, ref: number): void {
    const part = bucketOf(key);
    let arr = parts.get(part);
    if (!arr) {
      arr = [];
      parts.set(part, arr);
    }
    arr.push(key, ref);
    if (++buffered >= opts.budget) flushParts();
  }

  /**
   * 把缓冲按桶号升序写成一个 run 文件。run 内部必须「桶有序」，
   * 归并时才能顺序消费——Map 的插入顺序不是桶序，必须显式排序。
   */
  function flushParts(): void {
    if (!buffered) return;
    const d = ensureDir();
    const order = [...parts.keys()].sort((a, b) => a - b);
    let pairs = 0;
    for (const b of order) pairs += parts.get(b)!.length >> 1;
    const buf = Buffer.allocUnsafe(pairs * 8);
    let at = 0;
    for (const b of order) {
      const arr = parts.get(b)!;
      for (let i = 0; i < arr.length; i += 2) {
        buf.writeUInt32LE(arr[i]!, at);
        buf.writeUInt32LE(arr[i + 1]!, at + 4);
        at += 8;
      }
      arr.length = 0;
    }
    appendFileSync(join(d, `s${runSeq++}.bin`), buf);
    totalPairs += pairs;
    buffered = 0;
  }

  /** 内存超预算：把已攒的全散进桶，之后不再用 mem。 */
  function switchToSpill(): void {
    spilled = true;
    ensureDir();
    for (const [key, list] of mem) {
      const part = bucketOf(key);
      let arr = parts.get(part);
      if (!arr) {
        arr = [];
        parts.set(part, arr);
      }
      for (const ref of list) arr.push(key, ref);
      buffered += list.length;
    }
    mem.clear();
    memCount = 0;
    for (const key of prunedKeys) buffer(key, PRUNE_MARK);
    prunedKeys.clear();
    flushParts();
  }

  function add(key: number, ref: number): void {
    if (!spilled) {
      const list = mem.get(key);
      if (list) list.push(ref);
      else mem.set(key, [ref]);
      if (++memCount >= opts.budget) switchToSpill();
      return;
    }
    buffer(key, ref);
  }

  function addPruned(key: number): void {
    if (!spilled) {
      prunedKeys.add(key);
      return;
    }
    buffer(key, PRUNE_MARK);
  }

  function dispose(): void {
    if (!dir) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 临时目录删不掉不影响索引本身，下次构建会换个名字
    }
    dir = null;
    parts.clear();
    mem.clear();
  }

  function finish(files: IndexedFile[], dfCap: number): TextIndexMeta {
    if (!spilled) return writeIndex(opts.dataDir, files, mem, prunedKeys, dfCap);
    flushParts();
    try {
      const d = ensureDir();
      let runs = readdirSync(d)
        .filter((f) => /^s\d+\.bin$/.test(f))
        .map((f) => ({ n: Number(f.slice(1, -4)), file: join(d, f) }))
        .sort((a, b) => a.n - b.n)
        .map((r) => r.file);
      runs = reduceRuns(d, runs, opts.shift, opts.fanIn);
      return emitRuns(d, runs, files, dfCap, opts, totalPairs);
    } finally {
      dispose();
    }
  }

  return { add, addPruned, finish, dispose };
}

/**
 * 多路归并：把若干「桶有序」的 run 合成一路，按桶回调。
 * 每个 run 只留一个读缓冲，所以占用与同时打开的 run 数有关、与语料大小无关。
 */
type BucketHandler = (groups: Map<number, number[]>, bucket: number, pairs: number) => void;

function mergeRuns(runs: string[], shift: number, onBucket: BucketHandler): void {
  const readers = runs.map((f) => new RunReader(f));
  try {
    for (const r of readers) r.next();
    for (;;) {
      let min = Infinity;
      for (const r of readers) {
        if (r.key < 0) continue;
        const b = r.key >>> shift;
        if (b < min) min = b;
      }
      if (min === Infinity) break;

      const groups = new Map<number, number[]>();
      let pairs = 0;
      for (const r of readers) {
        while (r.key >= 0 && (r.key >>> shift) === min) {
          const list = groups.get(r.key);
          if (list) list.push(r.ref);
          else groups.set(r.key, [r.ref]);
          pairs++;
          r.next();
        }
      }
      onBucket(groups, min, pairs);
    }
  } finally {
    for (const r of readers) r.close();
  }
}

/** run 数太多时先做几轮中间归并，避免一次打开上百个文件。 */
function reduceRuns(dir: string, runs: string[], shift: number, fanIn: number): string[] {
  let cur = runs;
  let round = 0;
  while (cur.length > fanIn) {
    const next: string[] = [];
    for (let i = 0; i < cur.length; i += fanIn) {
      const chunk = cur.slice(i, i + fanIn);
      if (chunk.length === 1) {
        next.push(chunk[0]!);
        continue;
      }
      const out = join(dir, `m${round}-${i}.bin`);
      const w = new RecordWriter(out);
      try {
        // 中间归并只要求「桶有序」，桶内顺序无所谓，最终归并会排序
        mergeRuns(chunk, shift, (groups) => {
          for (const [key, refs] of groups) for (const ref of refs) w.write(key, ref);
        });
      } finally {
        w.close();
      }
      for (const c of chunk) rmSync(c, { force: true });
      next.push(out);
    }
    cur = next;
    round++;
  }
  return cur;
}

interface RangeOut {
  tableFd: number;
  blobFd: number;
  entries: number;
  postings: number;
  pruned: number;
  blobLen: number;
}

/** 一个桶落地：排序去重 → 剪枝判定 → 编码写 table/blob。 */
function emitBucket(groups: Map<number, number[]>, dfCap: number, out: RangeOut): void {
  const keys = [...groups.keys()].sort((a, b) => a - b);
  const table = Buffer.allocUnsafe(keys.length * 12);
  const chunks: Buffer[] = [];
  let chunkBytes = 0;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const at = i * 12;
    table.writeUInt32LE(key, at);
    const list = dedupeSorted(groups.get(key)!);
    // PRUNE_MARK 是最大值，排序后必然落在末位；只剩它就代表这个双字只标了剪枝
    if ((list.length === 1 && list[0] === PRUNE_MARK) || list.length > dfCap) {
      table.writeUInt32LE(PRUNED, at + 4);
      table.writeUInt32LE(PRUNED, at + 8);
      out.pruned++;
      continue;
    }
    const enc = encodeDeltas(list);
    table.writeUInt32LE(out.blobLen, at + 4);
    table.writeUInt32LE(list.length, at + 8);
    out.blobLen += enc.length;
    out.postings += list.length;
    chunks.push(enc);
    chunkBytes += enc.length;
  }

  writeAll(out.tableFd, table, table.length);
  if (chunkBytes) writeAll(out.blobFd, Buffer.concat(chunks, chunkBytes), chunkBytes);
  out.entries += keys.length;
}

function emitRuns(
  dir: string,
  runs: string[],
  files: IndexedFile[],
  dfCap: number,
  opts: SinkOptions,
  totalPairs: number,
): TextIndexMeta {
  const tableFd = openSync(join(dir, 'table.tmp'), 'w');
  const blobFd = openSync(join(dir, 'blob.tmp'), 'w');
  const out: RangeOut = { tableFd, blobFd, entries: 0, postings: 0, pruned: 0, blobLen: 0 };
  let done = 0;
  try {
    // 进度按「已归并多少条 posting」报：语料多大都能有个像样的百分比
    mergeRuns(runs, opts.shift, (groups, _bucket, pairs) => {
      emitBucket(groups, dfCap, out);
      done += pairs;
      opts.onMerge?.(done, totalPairs);
    });
  } finally {
    closeSync(tableFd);
    closeSync(blobFd);
  }

  const head = Buffer.alloc(16);
  head.write(MAGIC, 0, 'latin1');
  head.writeUInt32LE(VERSION, 4);
  head.writeUInt32LE(out.entries, 8);
  head.writeUInt32LE(out.blobLen, 12);

  const indexDir = textIndexDir(opts.dataDir);
  mkdirSync(indexDir, { recursive: true });
  const tmp = join(dir, 'index.bin.tmp');
  const fd = openSync(tmp, 'w');
  try {
    writeAll(fd, head, 16);
    copyInto(fd, join(dir, 'table.tmp'));
    copyInto(fd, join(dir, 'blob.tmp'));
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, join(indexDir, 'index.bin'));

  const meta: TextIndexMeta = {
    version: VERSION,
    builtAt: new Date().toISOString(),
    dfCap,
    bigramCount: out.entries,
    prunedBigrams: out.pruned,
    postingCount: out.postings,
    files,
  };
  writeMeta(indexDir, meta);
  return meta;
}

/* ---------- 扫正文 ---------- */

/**
 * 把一个文件的正文扫进 sink。返回 null 表示这个文件没有可用文本
 * （textRef 失效、文件被删），调用方不能给它分配下标，否则 id 会错位。
 */
function scanFile(
  dataDir: string,
  task: TextFileTask,
  fidIdx: number,
  sink: PostingSink,
): IndexedFile | null {
  // 下标要乘 PAGE_UNIT 塞进 32 位，超了会静默算错页码，宁可在建的时候直接报出来
  if (fidIdx >= MAX_FILES) {
    throw new Error(`有文本的文件超过 ${MAX_FILES} 个，倒排索引的 32 位 posting 装不下，需要按目录拆成多个索引`);
  }
  const file = resolveTextPath(dataDir, task.textRef);
  if (!file) return null;
  const mtimeMs = textFileMtime(file);
  if (mtimeMs < 0) return null;
  const r = loadTextFast(file, textCachePath(dataDir, task.fid), mtimeMs);
  if (!r) return null;

  const add = sink.add;
  for (const [p, np] of r.loaded.norm) {
    const text = np.n;
    if (text.length < 2) continue;
    // 同一页同一个双字只记一次：倒排是「双字 → 页」，页内重复次数留给核实阶段数
    const seen = new Set<number>();
    for (let at = 0; at + 1 < text.length; at++) {
      const k = pairKey(text.charCodeAt(at), text.charCodeAt(at + 1));
      if (k < 0 || seen.has(k)) continue;
      seen.add(k);
      add(k, fidIdx * PAGE_UNIT + p);
    }
  }
  return { fid: task.fid, mtimeMs, pages: r.loaded.pages.size };
}

function makeSink(dataDir: string, opts: BuildOptions, onMerge: (d: number, t: number) => void): PostingSink {
  return createPostingSink({
    dataDir,
    budget: opts.postingBuffer ?? DEFAULT_BUFFER,
    shift: opts.partitionShift ?? DEFAULT_SHIFT,
    fanIn: opts.mergeFanIn ?? DEFAULT_FAN_IN,
    onMerge,
  });
}

/* ---------- 全量 ---------- */

/**
 * 建索引。输入和检索用同一份任务清单（fid + textRef），文本走 `.text-cache`，
 * 所以重复构建基本只在拼 postings。
 */
export function buildTextIndex(
  dataDir: string,
  tasks: TextFileTask[],
  opts: BuildOptions = {},
): TextIndexMeta {
  const sink = makeSink(dataDir, opts, (d, t) => opts.onProgress?.(d, t, 'merge'));
  try {
    const files: IndexedFile[] = [];
    for (let i = 0; i < tasks.length; i++) {
      const entry = scanFile(dataDir, tasks[i]!, files.length, sink);
      if (entry) files.push(entry);
      opts.onProgress?.(i + 1, tasks.length, 'scan');
    }
    return sink.finish(files, opts.dfCap ?? 20_000);
  } catch (e) {
    sink.dispose();
    throw e;
  }
}

/* ---------- 增量 ---------- */

export interface IndexUpdateStats {
  /** 语料里新出现、之前没索引过的文件。 */
  added: number;
  /** 内容变过（mtime 不符或被标失效）而重做倒排的文件。 */
  updated: number;
  /** 已从语料消失、倒排被删掉的文件。 */
  removed: number;
  /** 直接沿用旧倒排的文件。 */
  reused: number;
  /** 旧索引不可用，整份重建。 */
  full: boolean;
  /** 真的写了索引；false 表示什么都没变，一个字节都没动。 */
  changed: boolean;
}

export interface IndexUpdateResult {
  meta: TextIndexMeta;
  stats: IndexUpdateStats;
}

interface SyncPlan {
  /** 旧索引条目下标 → 新索引条目下标。 */
  remap: Map<number, number>;
  kept: IndexedFile[];
  toIndex: TextFileTask[];
  added: number;
  updated: number;
  removed: number;
}

/**
 * 比一遍「索引里记的」和「现在磁盘上的」：谁没变（直接复用倒排）、谁变了、
 * 谁新来、谁走了。只做 stat，不读正文，所以可以随时调用。
 */
function planUpdate(index: TextIndex, dataDir: string, tasks: TextFileTask[]): SyncPlan {
  const now = new Map<string, { task: TextFileTask; mtimeMs: number }>();
  for (const task of tasks) {
    const file = resolveTextPath(dataDir, task.textRef);
    if (!file) continue;
    const mtimeMs = textFileMtime(file);
    if (mtimeMs < 0) continue;
    now.set(task.fid, { task, mtimeMs });
  }

  const kept: IndexedFile[] = [];
  const remap = new Map<number, number>();
  const toIndex: TextFileTask[] = [];
  let updated = 0;
  let removed = 0;
  for (let i = 0; i < index.meta.files.length; i++) {
    const f = index.meta.files[i]!;
    const cur = now.get(f.fid);
    if (!cur) {
      removed++;
      continue;
    }
    if (index.stale.has(f.fid) || !sameMtime(cur.mtimeMs, f.mtimeMs)) {
      toIndex.push(cur.task);
      updated++;
      continue;
    }
    remap.set(i, kept.length);
    kept.push(f);
  }

  const known = new Set(index.meta.files.map((f) => f.fid));
  let added = 0;
  for (const [fid, cur] of now) {
    if (known.has(fid)) continue;
    toIndex.push(cur.task);
    added++;
  }
  return { remap, kept, toIndex, added, updated, removed };
}

/**
 * 增量更新：只重扫变过/新来的文件，没变的倒排原样搬过来。
 *
 * 全量重建要把三千多本的正文过一遍（有 .text-cache 也要拼几十万条 postings），
 * 识别完一本书就全量重建是不现实的；增量通常只碰几个文件，几十毫秒就完事。
 * 旧索引不可用（首次、版本不符、文件损坏）时老实退化成全量重建。
 *
 * 旧倒排是顺着读一遍灌进 sink 的，不整体展开成 Map，所以索引再大也不会因为
 * 「增量」把内存顶爆。
 */
export function updateTextIndex(
  dataDir: string,
  tasks: TextFileTask[],
  opts: BuildOptions = {},
): IndexUpdateResult {
  const prev = loadTextIndex(dataDir);
  if (!prev) {
    const meta = buildTextIndex(dataDir, tasks, opts);
    return {
      meta,
      stats: { added: tasks.length, updated: 0, removed: 0, reused: 0, full: true, changed: true },
    };
  }

  const plan = planUpdate(prev, dataDir, tasks);
  const reused = plan.kept.length;
  if (!plan.toIndex.length && !plan.removed) {
    return {
      meta: prev.meta,
      stats: { added: 0, updated: 0, removed: 0, reused, full: false, changed: false },
    };
  }

  const sink = makeSink(dataDir, opts, (d, t) => opts.onProgress?.(d, t, 'merge'));
  try {
    // 旧倒排按新下标平移；被删/重做文件的 posting 顺手丢掉
    const add = sink.add;
    for (let i = 0; i < prev.keys.length; i++) {
      const key = prev.keys[i]!;
      if (prev.counts[i] === PRUNED) {
        sink.addPruned(key);
        continue;
      }
      const list = decodeList(prev, i);
      for (const v of list) {
        const nf = plan.remap.get(Math.floor(v / PAGE_UNIT));
        if (nf === undefined) continue;
        add(key, nf * PAGE_UNIT + (v % PAGE_UNIT));
      }
    }

    const files = plan.kept.slice();
    for (let j = 0; j < plan.toIndex.length; j++) {
      const entry = scanFile(dataDir, plan.toIndex[j]!, files.length, sink);
      if (entry) files.push(entry);
      opts.onProgress?.(j + 1, plan.toIndex.length, 'scan');
    }

    // dfCap 沿用旧索引的设置：中途改阈值会让剪枝范围前后不一致
    const meta = sink.finish(files, opts.dfCap ?? prev.meta.dfCap);
    return {
      meta,
      stats: { added: plan.added, updated: plan.updated, removed: plan.removed, reused, full: false, changed: true },
    };
  } catch (e) {
    sink.dispose();
    throw e;
  }
}
