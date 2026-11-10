import type { BookRecord, FileRecord, GazetteerIndex, LeanIndex, ExtKind } from './types.ts';

/** 两种投影都能喂进来：桌面版传 full，小程序传 lean。 */
export type AnyIndex = GazetteerIndex | LeanIndex;

export interface SearchFilters {
  /** 省区分组，如 "江西省"。 */
  provinces?: string[];
  /** 朝代/年号。 */
  eras?: string[];
  /** 志种，如 "县志"。 */
  zhiTypes?: string[];
  /** 大类，如 "各地方志"。 */
  categories?: string[];
  /** 文件格式。 */
  exts?: ExtKind[];
  /** 只看已完成 OCR 的书（全文支线启用后才有意义）。 */
  ocrDoneOnly?: boolean;
  /** 是否包含噪声文件所属的书。默认 false。 */
  includeNoise?: boolean;
  minSize?: number;
  maxSize?: number;
}

export interface SearchOptions extends SearchFilters {
  limit?: number;
  offset?: number;
}

export interface FileHit {
  file: FileRecord | LeanIndex['files'][number];
  /** 命中在哪个字段，用于 UI 高亮。 */
  field: 'name' | 'volume' | 'section';
}

export interface BookHit {
  book: BookRecord;
  score: number;
  /** 命中字段，按贡献度排序。 */
  matched: string[];
  files: FileHit[];
  /**
   * false = 只靠分词/文件名兜底命中，不是真正的字段级匹配。
   * 精确结果够多时这批会被整体丢弃，UI 也可以拿它画分隔线。
   */
  direct: boolean;
}

export interface SearchResult {
  total: number;
  items: BookHit[];
  elapsedMs: number;
  /** 本次结果集内的分面统计，供 UI 收窄用。 */
  facets: Facets;
}

export interface Facets {
  province: Record<string, number>;
  era: Record<string, number>;
  zhiType: Record<string, number>;
  ext: Record<string, number>;
}

/** 分面：某个维度上各取值的书数。 */
export function computeFacets(idx: AnyIndex): Facets {
  const bump = (o: Record<string, number>, k: string | undefined) => { if (k) o[k] = (o[k] ?? 0) + 1; };
  const f: Facets = { province: {}, era: {}, zhiType: {}, ext: {} };
  for (const b of idx.books) {
    bump(f.province, b.province);
    bump(f.era, b.era);
    bump(f.zhiType, b.zhiType);
    for (const e of b.exts) bump(f.ext, e);
  }
  return f;
}

function facetsOf(books: BookRecord[]): Facets {
  const bump = (o: Record<string, number>, k: string | undefined) => { if (k) o[k] = (o[k] ?? 0) + 1; };
  const f: Facets = { province: {}, era: {}, zhiType: {}, ext: {} };
  for (const b of books) {
    bump(f.province, b.province);
    bump(f.era, b.era);
    bump(f.zhiType, b.zhiType);
    for (const e of b.exts) bump(f.ext, e);
  }
  return f;
}

/** 查询按空白切成词，多词时要求每个词都落在某个字段上（AND 语义）。 */
export function splitTerms(q: string): string[] {
  return q.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * 模糊命中判定用的字集。只看汉字，英文数字交给精确子串匹配。
 * 单独抽出来是为了在几千部书上复用时不必反复构造。
 */
export function queryChars(q: string): string[] {
  return [...new Set([...q].filter((c) => /[\u4e00-\u9fa5]/.test(c)))];
}

/**
 * 查询里有多少比例的汉字出现在目标里。
 * 用字重合率而不是 n-gram 计数——"嘉定为"对"嘉定县志"是 2/3，
 * 对"青浦县志"是 0/3，正好把错字容错和无关噪声分开。
 */
export function charOverlap(chars: string[], target: string): number {
  if (!chars.length) return 0;
  let shared = 0;
  for (const c of chars) if (target.includes(c)) shared++;
  return shared / chars.length;
}

/** 至少一半的字对得上才算模糊命中；单字查询走精确匹配就够了。 */
const FUZZY_MIN_RATIO = 0.5;
/** 模糊结果最多带这么多条，否则搜"吉水县志"会拖出一千多部含"县志"的志。 */
const FUZZY_CAP = 20;
/** 文件级命中的总分上限，防止册数多的书靠数量碾压书名精确命中。 */
const FILE_SCORE_CAP = 60;

function applyFilters(idx: AnyIndex, f: SearchFilters): { books: BookRecord[]; fileById: Map<string, FileRecord | LeanIndex['files'][number]> } {
  const fileById = new Map<string, FileRecord | LeanIndex['files'][number]>();
  for (const fl of idx.files) fileById.set(fl.id, fl);

  const has = (arr: string[] | undefined) => !!arr && arr.length > 0;

  const books = idx.books.filter((b) => {
    if (!f.includeNoise) {
      // 全是噪声文件的书直接排除
      const all = b.fileIds.map((id) => fileById.get(id));
      if (all.length && all.every((x) => x && 'isNoise' in x && x.isNoise)) return false;
    }
    if (has(f.provinces) && !(b.province && f.provinces!.includes(b.province))) return false;
    if (has(f.eras) && !(b.era && f.eras!.includes(b.era))) return false;
    if (has(f.zhiTypes) && !(b.zhiType && f.zhiTypes!.includes(b.zhiType))) return false;
    if (has(f.categories) && !f.categories!.includes(b.category)) return false;
    if (has(f.exts) && !b.exts.some((e) => f.exts!.includes(e))) return false;
    if (f.ocrDoneOnly && b.ocrDone === 0) return false;
    if (f.minSize !== undefined && b.totalSize < f.minSize) return false;
    if (f.maxSize !== undefined && b.totalSize > f.maxSize) return false;
    return true;
  });
  return { books, fileById };
}

/**
 * 检索。空 query 时退化为按筛选条件浏览，按书名排序。
 *
 * 评分权重刻意让「书名精确等于」远高于其它命中——
 * 地方志检索的真实意图绝大多数是「找某一部志」，不是全文模糊搜索。
 */
export function search(idx: AnyIndex, query: string, opts: SearchOptions = {}): SearchResult {
  const t0 = Date.now();
  const { books, fileById } = applyFilters(idx, opts);
  const q = query.trim().toLowerCase();
  const qChars = queryChars(q);
  const terms = splitTerms(q);

  const strong: BookHit[] = [];
  const weak: BookHit[] = [];

  for (const b of books) {
    const files = b.fileIds
      .map((id) => fileById.get(id))
      .filter((x): x is FileRecord | LeanIndex['files'][number] => !!x)
      .filter((x) => opts.includeNoise || !('isNoise' in x && x.isNoise));

    let score = 0;
    const matched: string[] = [];
    const fileHits: FileHit[] = [];

    const title = b.title.toLowerCase();
    const place = (b.place ?? '').toLowerCase();
    const era = (b.era ?? '').toLowerCase();
    const zhi = (b.zhiType ?? '').toLowerCase();
    const disp = b.displayTitle.toLowerCase();
    const author = (b.author ?? '').toLowerCase();
    const edition = (b.edition ?? '').toLowerCase();

    if (q) {
      // 单个词在某个字段上的得分。多词查询对每个词各算一次，全中才算精确命中。
      // place 在没解析出志种时会退化成书名本身，这时它是冗余信息，不再计分——
      // 否则"保定府志序列目录"会因为书名和地名双重命中而压过真正的《保定府志》。
      const placeField = place && place !== title ? place : '';
      const fieldScore = (t: string): { s: number; tags: string[] } => {
        let s = 0;
        const tags: string[] = [];
        if (title === t) { s += 1000; tags.push('书名精确'); }
        else if (title.startsWith(t)) { s += 400; tags.push('书名开头'); }
        else if (title.includes(t)) { s += 200; tags.push('书名包含'); }
        if (placeField.includes(t)) { s += 120; tags.push('地名'); }
        if (disp.includes(t) && !tags.length) { s += 90; tags.push('完整名'); }
        if (era && era.includes(t)) { s += 60; tags.push('朝代'); }
        if (zhi && zhi.includes(t)) { s += 40; tags.push('志种'); }
        if (author.includes(t)) { s += 50; tags.push('作者'); }
        if (edition.includes(t)) { s += 30; tags.push('版本'); }
        return { s, tags };
      };

      let direct = false;
      let anyField = false;
      if (terms.length <= 1) {
        const r = fieldScore(q);
        score += r.s;
        matched.push(...r.tags);
        anyField = r.tags.length > 0;
        direct = anyField;
      } else {
        let acc = 0;
        let part = 0;
        for (const t of terms) {
          const r = fieldScore(t);
          if (r.s > 0) { acc += r.s; part++; matched.push(...r.tags); }
        }
        anyField = part > 0;
        if (part === terms.length) { score += acc; direct = true; }
        else if (part > 0) { score += Math.round(acc * 0.3); matched.push(`命中${part}/${terms.length}词`); }
      }

      // 文件级命中：分志、卷次这些不在书名里的信息。只做精确子串，
      // 模糊匹配放到书级就够了，否则一部《大清一统志》会因为文件名里
      // 出现"保定府"而被任何含"保定"的查询捞出来。
      // 总分封顶：98 册的书不该靠文件数量压过书名精确命中的单册书。
      let fileScore = 0;
      for (const fl of files) {
        const nm = fl.name.toLowerCase();
        const sec = ('section' in fl && fl.section ? fl.section : '').toLowerCase();
        const vol = (fl.volume ?? '').toLowerCase();
        let field: FileHit['field'] | undefined;
        for (const t of terms.length ? terms : [q]) {
          if (nm.includes(t)) { field = 'name'; break; }
          if (sec && sec.includes(t)) { field = 'section'; break; }
          if (vol && vol.includes(t)) { field = 'volume'; break; }
        }
        if (field) {
          fileHits.push({ file: fl, field });
          fileScore += field === 'section' ? 25 : 8;
        }
      }
      if (fileScore) {
        score += Math.min(fileScore, FILE_SCORE_CAP);
        if (!anyField) matched.push('文件内容');
      }

      // 错字容错：一个字都没对上时才启用，避免和真实命中重复计分
      if (!anyField) {
        const ratio = charOverlap(qChars, title + place + era + zhi);
        if (ratio >= FUZZY_MIN_RATIO && qChars.length >= 2) {
          score += Math.round(ratio * 60);
          matched.push(`近似${Math.round(ratio * 100)}%`);
        }
      }

      if (score > 0) {
        score += b.confidence * 10;
        (direct ? strong : weak).push({ book: b, score, matched: [...new Set(matched)], files: fileHits, direct });
      }
    } else {
      strong.push({ book: b, score: 1, matched: [], files: [], direct: true });
    }
  }

  const cmp = (a: BookHit, b2: BookHit) =>
    b2.score - a.score || a.book.title.localeCompare(b2.book.title, 'zh-Hans-CN');
  strong.sort(cmp);

  const limit = opts.limit ?? 100;
  // 精确结果填满一页就不再掺模糊结果，否则前几页之后全是噪声
  const kept = strong.length >= limit ? strong : [...strong, ...weak.sort(cmp).slice(0, FUZZY_CAP)];

  const total = kept.length;
  const offset = opts.offset ?? 0;
  const items = kept.slice(offset, offset + limit);

  return {
    total,
    items,
    elapsedMs: Date.now() - t0,
    facets: q ? facetsOf(items.map((h) => h.book)) : facetsOf(books),
  };
}

export function getBook(idx: AnyIndex, bookId: string): { book: BookRecord; files: Array<FileRecord | LeanIndex['files'][number]> } | undefined {
  const book = idx.books.find((b) => b.id === bookId);
  if (!book) return undefined;
  const byId = new Map(idx.files.map((f) => [f.id, f]));
  return { book, files: book.fileIds.map((id) => byId.get(id)).filter((x) => !!x) };
}

/** 供 UI 用的筛选下拉数据源，按数量降序。 */
export function facetOptions(f: Record<string, number>): Array<{ value: string; count: number }> {
  return Object.entries(f).map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
}

export function formatSize(bytes: number): string {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(0) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}
