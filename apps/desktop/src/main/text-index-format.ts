import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 倒排索引的二进制格式与编解码。
 *
 * 文件布局（`<数据目录>/.text-index/index.bin`）：
 *   16B 头：magic "FZTX" + 版本 + 双字条目数 + blob 长度
 *   条目数 × 12B 交错表：双字键 / 倒排偏移 / 倒排条数
 *   blob：每张倒排表按「页码升序 + delta + varint」压过
 *
 * 这里只有纯粹的数据形状与编解码，不碰业务（谁建、谁查、怎么增量）。
 * 构建侧在 text-index-build.ts，加载与查询在 text-index.ts。
 */

export const MAGIC = 'FZTX';
/**
 * 版本 2：POSTING 里的页码基从 100 万降到 10 万。
 * 一个 posting 压成 32 位数（文件下标 × PAGE_UNIT + 页码），基取 100 万时
 * 文件下标超过 4294 就会溢出 UInt32；本库全量 OCR 完有 4600 个文件，正好踩线。
 * 基降到 10 万后上限变成 42949 个文件、每本 10 万页，几十年够用。
 * 版本变了，旧索引（v1）会被 loadTextIndex 判为不可用并重建，不会读错页码。
 */
export const VERSION = 2;
/**
 * 一个 posting 的键 = fidIdx * PAGE_UNIT + 页码；页码上限 9.9 万。
 * 这样「文件下标 + 页码」压成一个 32 位数，倒排表里只存一个整数。
 */
export const PAGE_UNIT = 100_000;
/** 能索引的文件数上限，见 VERSION 注释。 */
export const MAX_FILES = Math.floor(0xffffffff / PAGE_UNIT);
/** 被剪枝的高频双字：字典里有、倒排没有。 */
export const PRUNED = 0xffffffff;

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

/**
 * 一对 UTF-16 码元 → 32 位键。代理对（扩展区生僻字）拆半没有意义，直接跳过；
 * 含这类字的查询会因此拿不到倒排，退回扫描，不影响正确性。
 */
export function pairKey(a: number, b: number): number {
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

export function encodeDeltas(list: number[]): Buffer {
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

export function decodeList(index: TextIndex, i: number): number[] {
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

export function findKey(keys: Uint32Array, key: number): number {
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

/** 倒排要求升序且不重复：重复会让同一个候选页被核实两次、命中数翻倍。 */
export function dedupeSorted(list: number[]): number[] {
  list.sort((a, b) => a - b);
  let at = 0;
  for (let i = 0; i < list.length; i++) {
    const v = list[i]!;
    if (at === 0 || v !== list[at - 1]!) list[at++] = v;
  }
  list.length = at;
  return list;
}

/** 临时文件 + 原子替换：进程中断时不会留下半份索引。 */
export function writeAtomic(file: string, data: string | Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

/**
 * 时间戳是否算「同一个版本」。
 *
 * 严格相等踩过坑：打包时 cpSync 会重设 mtime，而 NTFS 的时间戳是 100ns 一格，
 * 重设过程把值量化到相邻一格（差 0.0003ms 这种量级），旧的严格相等就把整库
 * 判成过期——便携版冷启动一开就把带进去的索引全部重扫一遍，包内索引等于白带。
 * 1ms 以内视为同一版本：真改动的时间差至少是秒级，而 stale.json 的失效标记照旧
 * 立即生效，不会因为容差漏掉。
 */
export function sameMtime(a: number, b: number): boolean {
  return a === b || Math.abs(a - b) < 1;
}
