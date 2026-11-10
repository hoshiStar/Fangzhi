import { parseFileName, extKind, hashId, bookKey } from './parse.ts';
import { PROVINCES, normalizeExt } from './lexicon.ts';
import { SCHEMA_VERSION } from './types.ts';
import type {
  RawShareDump, RawShareEntry, GazetteerIndex, BookRecord, FileRecord,
  IndexStats, IndexMeta, ExtKind, LeanIndex,
} from './types.ts';
import { toLean } from './types.ts';

/** 分享库根目录名，用于把绝对路径切成相对层级。 */
export function detectRoot(rows: RawShareEntry[]): string {
  const d = rows.find((r) => r.type === 'dir' && r.depth === 1);
  return d ? '/' + d.name : '';
}

/** 省区分组是 depth-3 且父级为「各地方志」的目录；其余分支没有省级层。 */
export function detectProvinces(rows: RawShareEntry[], root: string): Set<string> {
  const known = new Set<string>(PROVINCES);
  const out = new Set<string>();
  for (const r of rows) {
    if (r.type !== 'dir' || r.depth !== 3) continue;
    const segs = r.path.slice(root.length).split('/').filter(Boolean);
    if (segs[0] === '各地方志' && segs[1]) out.add(segs[1]);
  }
  // 有些分组名带「省」字（江西省/浙江省），直接纳入；其余用词表兜底
  for (const r of rows) {
    if (r.type !== 'dir' || r.depth !== 3) continue;
    const segs = r.path.slice(root.length).split('/').filter(Boolean);
    const name = segs[1];
    if (name && known.has(name.replace(/[省市]$/, ''))) out.add(name);
  }
  return out;
}

function confidence(p: ReturnType<typeof parseFileName>): number {
  if (p.isNoise) return 0;
  let c = 0.35;                       // 有书名主干
  if (p.zhiType) c += 0.25;           // 命中志种锚点
  if (p.place) c += 0.15;             // 提取到地名
  if (p.era) c += 0.15;               // 提取到朝代
  if (p.degenerate) c -= 0.25;        // 靠继承得来
  if (p.metaSource === 'catalog-string') c += 0.1; // 著录串信息量大
  if (p.title.length < 3) c -= 0.2;
  return Math.max(0, Math.min(1, Number(c.toFixed(2))));
}

export interface BuildOptions {
  meta: IndexMeta;
  crawledAt?: string;
}

export function buildIndex(dump: RawShareDump, opts: BuildOptions): GazetteerIndex {
  const { rows } = dump;
  const root = detectRoot(rows);
  const provinces = detectProvinces(rows, root);

  const rawFiles = rows.filter((r): r is RawShareEntry & { type: 'file' } => r.type === 'file');
  const bookMap = new Map<string, BookRecord>();
  const files: FileRecord[] = [];

  for (const rf of rawFiles) {
    const rel = rf.path.slice(root.length);
    const segs = rel.split('/').filter(Boolean);
    const category = segs[0] ?? '(未分类)';
    const seg1 = segs[1] ?? '';
    const province = provinces.has(seg1) ? seg1 : undefined;

    // 祖先目录，最近的在前。跳过 category 与 province 两层——
    // 「各地方志」「北京天津河北」提供不了书名，混进来只会污染兜底。
    const dirSegs = segs.slice(0, -1);
    const ancestors = dirSegs.slice(province ? 2 : 1).reverse();

    const p = parseFileName(rf.name, ancestors);
    const bk = bookKey(category, province ?? seg1 ?? '', p.era, p.title);
    const bookId = hashId(bk);
    const ext = extKind(rf.name);

    files.push({
      id: rf.fid,
      fid: rf.fid,
      pdirFid: rf.pdir_fid ?? '',
      shareFidToken: rf.share_fid_token ?? '',
      name: rf.name,
      path: rf.path,
      size: rf.size,
      ext,
      bookId,
      volume: p.volumes[0],
      part: p.part,
      section: p.section,
      isNoise: p.isNoise,
      isArchivePart: p.isArchivePart,
      archiveGroup: p.archiveGroup,
      metaSource: p.metaSource,
      ocrStatus: 'pending',
    });

    const existing = bookMap.get(bookId);
    if (existing) {
      existing.fileIds.push(rf.fid);
      existing.fileCount += 1;
      existing.totalSize += rf.size;
      if (!existing.exts.includes(ext)) existing.exts.push(ext);
      if (!existing.author && p.catalog?.author) existing.author = p.catalog.author;
      if (!existing.edition && p.catalog?.edition) existing.edition = p.catalog.edition;
      if (!existing.catalogRaw && p.catalog) existing.catalogRaw = p.catalog.raw;
      existing.confidence = Math.max(existing.confidence, confidence(p));
    } else {
      bookMap.set(bookId, {
        id: bookId,
        title: p.title,
        displayTitle: p.era && !p.displayTitle.includes(p.era) ? `[${p.era}]${p.title}` : p.displayTitle,
        zhiType: p.zhiType,
        place: p.place,
        province,
        category,
        era: p.era,
        author: p.catalog?.author,
        edition: p.catalog?.edition,
        catalogRaw: p.catalog?.raw,
        confidence: confidence(p),
        fileIds: [rf.fid],
        fileCount: 1,
        totalSize: rf.size,
        exts: [ext],
        ocrDone: 0,
      });
    }
  }

  const books = [...bookMap.values()].sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));

  const by = (arr: Array<string | undefined>): Record<string, number> => {
    const o: Record<string, number> = {};
    for (const k of arr) { if (k) o[k] = (o[k] ?? 0) + 1; }
    return o;
  };

  const stats: IndexStats = {
    fileCount: files.length,
    bookCount: books.length,
    totalSize: files.reduce((a, b) => a + b.size, 0),
    byCategory: by(files.map((f) => f.path.slice(root.length).split('/').filter(Boolean)[0])),
    byProvince: by(books.map((b) => b.province)),
    byEra: by(books.map((b) => b.era)),
    byExt: by(files.map((f) => f.ext as ExtKind)),
    parseCoverage: {
      zhiType: books.filter((b) => b.zhiType).length,
      era: books.filter((b) => b.era).length,
      place: books.filter((b) => b.place).length,
      volume: files.filter((f) => f.volume).length,
      inherited: files.filter((f) => f.metaSource !== 'filename').length,
      noise: files.filter((f) => f.isNoise).length,
    },
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    meta: opts.meta,
    crawledAt: opts.crawledAt ?? new Date().toISOString(),
    stats,
    books,
    files,
  };
}

export { toLean };
export type { LeanIndex };
export { normalizeExt };
