import {
  LONG_ERAS, SHORT_ERAS, ERA_PLACE_CONFLICT, GENERIC_ZHI, ZHI_TYPES, ZHI_RE,
  ZHI_BOOK, ZHI_SECTION, ZHI_BOOK_RE,
  PROVINCES, PROV_PREFIX_RE, TITLE_PREFIX_RE, NOISE_RE, NOISE_EXT,
  normalizeExt, ARCHIVE_PART_RE,
} from './lexicon.ts';
import type { ExtKind, MetaSource } from './types.ts';

const squeeze = (s: string): string => s.replace(/[\s\u3000]+/g, '');
const trimPunct = (s: string): string =>
  s.replace(/^[\[［【(（〔《\]］】)）〕》、,，;；:：.\-_－·]+/, '')
   .replace(/[\[［【(（〔《\]］】)）〕》、,，;；:：.\-_－·]+$/, '');

const VOL_RE = new RegExp(
  '(' + [
    '卷\\s*首', '卷\\s*末',
    '卷\\s*[0-9〇零一二三四五六七八九十百千兩两]+(?:\\s*[-—~至到]\\s*(?:卷\\s*)?[0-9〇零一二三四五六七八九十百千兩两]+|\\s*之?[上下])?',
    '第\\s*[0-9〇零一二三四五六七八九十百千兩两]+(?:\\s*[-—~至到]\\s*[0-9〇零一二三四五六七八九十百千兩两]+)?\\s*[卷册冊]',
    '[0-9〇零一二三四五六七八九十百千兩两]+\\s*[-—~至到]\\s*[0-9〇零一二三四五六七八九十百千兩两]+\\s*[卷册冊]',
    '全\\s*[0-9〇零一二三四五六七八九十百千兩两]+\\s*[册冊]',
    '全\\s*[一二三四五六七八九十]+\\s*[册冊]',
    '[0-9〇零一二三四五六七八九十百千兩两]+\\s*[册冊](?:\\s*全)?',
    '[上下]\\s*[、,]?\\s*下?\\s*册?',
  ].join('|') + ')',
);

const ZHI_SCAN_RE = new RegExp('(' + ZHI_TYPES.join('|') + ')', 'g');

/**
 * 分志名允许省略尾部「志」：《嘉定县志·方言》的分志是「方言」。
 * 词干至少 2 字，避免「事志」退化成单字「事」而过度匹配。
 */
const SECTION_STEMS = ZHI_SECTION.map((z) => z.replace(/志$/, '')).filter((z) => z.length >= 2);
const ZHI_SECTION_RE = new RegExp('^(' + SECTION_STEMS.join('|') + ')志?');

export interface CatalogInfo {
  seq?: string;
  title?: string;
  era?: string;
  author?: string;
  edition?: string;
  year?: string;
  volumes?: string[];
  format?: string;
  sizeHint?: string;
  raw: string;
}

/**
 * 判断是否为「中文地名-中文地名」列表。
 *
 * 《大清一统志》各册括号内是清代府州名列表，如
 * "绍兴-台州-金华-衢州-严州-温州-处州-玉环"，其中「绍兴」「嘉定」
 * 既是年号又是地名。数字范围（"光绪6-8"、"卷1-40"）不算地名列表。
 */
function isPlaceList(s: string): boolean {
  return /[\u4e00-\u9fa5]{2,}\s*[-—－]\s*[\u4e00-\u9fa5]{2,}/.test(s);
}

/**
 * 年号识别。优先级：括号内独立年号 > 开头年号 > 短串内年号 > 单字朝代。
 * 地名列表一律跳过，见 isPlaceList。
 */
export function findEraIn(s: string): string | undefined {
  if (!s) return undefined;

  const brackets = s.match(/[\[［【(（][^\]］】)）]{1,8}[\]］】)）]/g);
  if (brackets) {
    for (const b of brackets) {
      const inner = squeeze(b.slice(1, -1));
      const e = LONG_ERAS.find((x) => inner === x || inner.startsWith(x));
      if (e) return e;
    }
  }

  const head = LONG_ERAS.find((e) => s.startsWith(e));
  if (head) {
    // 冲突年号 + 通用志种 = 地名。"绍兴县志"的绍兴是地名，"嘉定赤城志"的嘉定才是年号。
    const rest = s.slice(head.length);
    const isPlace = ERA_PLACE_CONFLICT.includes(head) && GENERIC_ZHI.some((z) => rest.startsWith(z));
    if (!isPlace && !isPlaceList(s)) return head;
  }

  if (isPlaceList(s)) return undefined;

  if (s.length <= 10) {
    const hit = LONG_ERAS.find((e) => s.includes(e) && !ERA_PLACE_CONFLICT.includes(e));
    if (hit) return hit;
  }

  for (const e of SHORT_ERAS) {
    if (new RegExp('(?:^|[^\\u4e00-\\u9fa5])' + e + '(?:$|[^\\u4e00-\\u9fa5]|[代朝])').test(s)) return e;
    if (new RegExp('[\\[［【(（]' + e + '[\\]］】)）]').test(s)) return e;
  }
  return undefined;
}

/**
 * 剥掉开头的朝代前缀，但与 findEraIn 用同一套地名判断。
 *
 * 「嘉定县志」的嘉定是地名，不能剥——剥了就变成「县志」，
 * 既丢了书名也无法再拆出分志。findEraIn 和这里必须口径一致，
 * 否则同一部书会因为 era 字段和 title 字段判定不同而被拆成两组。
 */
export function stripLeadingEra(s: string): string {
  const head = LONG_ERAS.find((e) => s.startsWith(e));
  if (!head) return s;
  const rest = s.slice(head.length);
  const isPlace = ERA_PLACE_CONFLICT.includes(head) && GENERIC_ZHI.some((z) => rest.startsWith(z));
  return isPlace ? s : rest;
}

/** 按优先级在多个片段里找年号：文件名碎片 > 主干 > 祖先目录。 */
export function findEra(parts: string[]): string | undefined {
  for (const p of parts) {
    const e = findEraIn(p);
    if (e) return e;
  }
  return undefined;
}

/**
 * 解析父目录的完整著录串。
 * 形如 "55 保定府志（32册80卷），清 李振祜修 张豫垲纂，光绪 刻本；pdf格式 575M"
 */
export function parseCatalogString(dirName: string): CatalogInfo {
  const raw = dirName;
  let s = dirName.replace(/\.(pdf|djvu|docx?|txt|rar|zip|uvz)$/i, '');
  const out: CatalogInfo = { raw, volumes: [] };

  const fmt = s.match(/([a-z]{2,4})\s*格式\s*([\d.]+\s*[MGK])/i) ?? s.match(/([\d.]+\s*[MGK])\s*$/i);
  if (fmt) {
    const g1 = fmt[1] ?? '';
    if (/[a-z]/i.test(g1) && !/^[\d.]+$/.test(g1)) out.format = g1.toLowerCase();
    out.sizeHint = (fmt[2] ?? g1).trim();
    s = s.replace(fmt[0], ' ');
  }

  const segs = s.split(/[，,；;]/).map((x) => x.trim()).filter(Boolean);
  const first = segs.shift() ?? '';

  const seq = first.match(/^\s*(\d+(?:[-－]\d+)?)[、.\s]/);
  if (seq?.[1]) out.seq = seq[1];

  const bookMark = first.match(/《([^》]+)》/);
  if (bookMark?.[1]) {
    out.title = squeeze(bookMark[1]);
  } else {
    const frags: string[] = [];
    let t = first.replace(/[\[［【(（〔]([^\]］】)）〔]*)[\]］】)）〕]/g, (_, g: string) => { frags.push(g); return ' '; });
    t = t.replace(/^\s*\d+(?:[-－]\d+)?[、.\s]+/, '');
    t = t.replace(/[\[［【(（〔\]］】)）〕]/g, ' ');
    const vols: string[] = [];
    for (const f of [...frags, t]) {
      const m = f.match(VOL_RE);
      if (m?.[0]) { const v = squeeze(m[0]); if (!vols.includes(v)) vols.push(v); }
    }
    if (vols.length) out.volumes = vols;
    let core = squeeze(t.replace(VOL_RE, ' '));
    core = trimPunct(stripLeadingEra(core).replace(TITLE_PREFIX_RE, ''));
    if (core) out.title = core;
    else if (frags.length) out.title = squeeze(trimPunct(frags[0] ?? ''));
  }

  const authorParts: string[] = [];
  const editionParts: string[] = [];
  for (const seg of segs) {
    const ym = seg.match(/((?:19|20)\d{2})\s*年/);
    if (ym?.[1] && !out.year) out.year = ym[1];
    if (/(刻本|抄本|刊本|稿本|石印|影印|四部丛刊|书局|書局|図書館|图书馆|藏书|聚珍|殿本|丛刊|精裝|精装)/.test(seg)) editionParts.push(seg);
    if (/(修|纂|著|撰|主编|主修|编|編|校注|校|辑|輯)/.test(seg)) authorParts.push(seg);
    if (!out.era) { const e = findEraIn(seg); if (e) out.era = e; }
  }
  if (authorParts.length) {
    out.author = squeeze(authorParts.join(' '))
      .replace(/^[\[［【(（]*/, '').replace(/^(清|民|元|明|宋|唐)/, '')
      .replace(/^[\]］】)）]*/, '').replace(/[，,、;；]+$/, '');
  }
  if (editionParts.length) out.edition = squeeze(editionParts.join(' '));
  if (!out.era) out.era = findEraIn(first);
  return out;
}

/** 这个祖先目录名看起来是不是完整著录串（含分隔符或很长）。 */
function looksLikeCatalog(dirName: string): boolean {
  return /[，,；;]/.test(dirName) || dirName.length > 22 || /格式/.test(dirName);
}

/** 这个祖先目录能不能提供书名信息（不是 "1" / "后8册修正" / "12册补页" 这类无信息层）。 */
function ancestorHasTitle(dirName: string): boolean {
  const s = squeeze(dirName);
  if (!s || /^\d{1,4}$/.test(s)) return false;
  if (/^(前|后|後)?\d{1,3}[册冊](补页|補页|修正)/.test(s)) return false;
  if (/^\d+$/.test(s.replace(VOL_RE, ''))) return false;
  return s.replace(VOL_RE, '').length >= 3;
}

export interface ParsedName {
  title: string;
  displayTitle: string;
  zhiType?: string;
  section?: string;
  place?: string;
  era?: string;
  volumes: string[];
  part?: string;
  isNoise: boolean;
  isArchivePart: boolean;
  archiveGroup?: string;
  metaSource: MetaSource;
  degenerate: boolean;
  catalog?: CatalogInfo;
}

/**
 * 解析单个文件名。
 *
 * @param rawName    文件名
 * @param ancestors  祖先目录名，最近的在前（ancestors[0] 是直接父目录）。
 *                   用于著录继承：直接父目录无信息时向上回溯。
 * 纯函数、无 IO —— Electron 与小程序共用。
 */
export function parseFileName(rawName: string, ancestors: string[] = []): ParsedName {
  const ext = normalizeExt(rawName);
  const isNoise = NOISE_RE.test(rawName.trim()) || NOISE_EXT.includes(ext);
  const isArchivePart = ARCHIVE_PART_RE.test(rawName);
  const archiveGroup = isArchivePart
    ? squeeze(rawName.replace(/\.(rar|zip|uvz|7z)$/i, '').replace(/part\s*\d+$/i, '').replace(/[（(]\s*\d+\s*[）)]$/, ''))
    : undefined;

  const parentDirName = ancestors[0] ?? '';

  let s = rawName.replace(/\.(pdf|djvu|docx?|txt|rar|zip|uvz|exe)$/i, '');
  const origForDisplay = s.trim();

  // 《…》是书名包装，内容并入主干
  s = s.replace(/《([^》]*)》/g, (_, g: string) => ' ' + g + ' ');

  // 成对括号抽出为元数据碎片；循环处理嵌套（[方舆考证][1].1）
  const frags: string[] = [];
  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(/[\[［【(（〔]([^\[\]［］【】(（)）〔〕]*)[\]］】)）〕]/g, (_, g: string) => { frags.push(g); return ' '; });
  }
  s = s.replace(/[\[［【(（〔\]］】)）〕]/g, ' ');

  const parts = s.split(/\s+/).filter(Boolean);

  // 分册序号：主干尾部 -01 / _2 / part1
  let part: string | undefined;
  if (parts.length) {
    const li = parts.length - 1;
    const last = parts[li] ?? '';
    const pm = last.match(/^(.+?)[\-－_]\d{1,3}$/) ?? last.match(/^(.+?)part\s*\d+$/i);
    if (pm?.[1]) { parts[li] = pm[1]; part = last.slice(pm[1].length); }
  }

  // 最近的、能提供书名信息的祖先；以及最近的著录串祖先
  const titleAncestor = ancestors.find((a) => ancestorHasTitle(a)) ?? parentDirName;
  const catalogAncestor = ancestors.find((a) => looksLikeCatalog(a) && ancestorHasTitle(a));
  const catalog = catalogAncestor ? parseCatalogString(catalogAncestor) : undefined;

  // 年号优先级：文件名括号 > 文件名主干 > 祖先目录
  const era = findEra([...frags, ...parts]) ?? catalog?.era ?? findEra(ancestors);

  const volumes: string[] = [];
  for (const p of [...parts, ...frags]) {
    const m = p.match(VOL_RE);
    if (m?.[0]) { const v = squeeze(m[0]); if (!volumes.includes(v)) volumes.push(v); }
  }
  for (const f of frags) {
    if (/[卷册冊]/.test(f)) { const t = squeeze(f); if (t && !volumes.includes(t)) volumes.push(t); }
  }
  for (const v of catalog?.volumes ?? []) if (!volumes.includes(v)) volumes.push(v);

  // 书名主干
  let core = squeeze(
    parts
      .map((p) => p.replace(VOL_RE, ' '))
      .map((p) => trimPunct(p))
      .filter((p) => p && !/^\d{1,4}$/.test(p))
      .join(''),
  );
  core = trimPunct(stripLeadingEra(core).replace(TITLE_PREFIX_RE, ''));

  let metaSource: MetaSource = 'filename';
  let degenerate = false;

  // 兜底 1：主干退化为空/纯数字，书名可能藏在碎片里（[方舆考证][1].1.djvu）
  if (!core || /^\d{1,4}$/.test(core)) {
    degenerate = true;
    const candidate = frags
      .map((f) => trimPunct(squeeze(f.replace(VOL_RE, ' '))))
      .filter((f) => f && f.length >= 2 && !/^\d+$/.test(f) && !findEraIn(f))
      .sort((a, b) => b.length - a.length)[0];
    if (candidate) { core = candidate; degenerate = false; }
  }

  // 兜底 2：向上回溯祖先目录（修复 ".../1/后8册修正/12册补页/12-422.pdf"）
  if (!core || /^\d{1,4}$/.test(core)) {
    degenerate = true;
    metaSource = catalog ? 'catalog-string' : 'parent-dir';
    const inherited = catalog?.title
      ?? trimPunct(squeeze(stripLeadingEra(titleAncestor.replace(/\.(pdf|djvu|docx?|txt|rar|zip|uvz)$/i, '').replace(VOL_RE, ' '))));
    core = inherited || '(未命名)';
  }

  // 主志 + 分志：仅当第一锚点是书级、剩余部分以分志级开头时才拆
  let title = core;
  let section: string | undefined;
  ZHI_SCAN_RE.lastIndex = 0;
  const m1 = ZHI_SCAN_RE.exec(core);
  if (m1) {
    const firstType = m1[0] ?? '';
    const firstEnd = m1.index + firstType.length;
    const rest = trimPunct(core.slice(firstEnd));
    if (
      ZHI_BOOK.includes(firstType as typeof ZHI_BOOK[number]) &&
      firstEnd >= 3 &&
      rest.length >= 2 &&
      ZHI_SECTION_RE.test(rest)
    ) {
      title = core.slice(0, firstEnd);
      section = rest;
    }
  }

  const zm = title.match(ZHI_RE);
  const zhiType = zm?.[1];

  let place: string | undefined;
  if (zhiType) {
    // 必须在完整 title 上剥朝代，不能先截掉志种再剥——
    // "嘉定县志" 截成 "嘉定" 后，地名判断失去了「后面跟着县志」这个依据。
    const withoutEra = trimPunct(stripLeadingEra(title).replace(TITLE_PREFIX_RE, ''));
    let head = trimPunct(withoutEra.slice(0, Math.max(0, withoutEra.length - zhiType.length)));
    if (!head) head = trimPunct(title.slice(0, title.length - zhiType.length));
    place = head.replace(PROV_PREFIX_RE, '') || head || undefined;
  } else {
    place = PROVINCES.find((p) => title.includes(p)) ?? (title.length <= 14 ? title : undefined);
  }

  return {
    title: title || '(未命名)',
    displayTitle: trimPunct(origForDisplay) || title,
    zhiType, section, place, era,
    volumes, part,
    isNoise, isArchivePart, archiveGroup,
    metaSource, degenerate, catalog,
  };
}

export function extKind(name: string): ExtKind {
  const e = normalizeExt(name);
  switch (e) {
    case 'pdf': case 'djvu': case 'doc': case 'txt':
    case 'rar': case 'zip': case 'uvz': case 'exe':
      return e;
    default: return 'other';
  }
}

/** FNV-1a -> base36，用作稳定且紧凑的 bookId。 */
export function hashId(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** 书级聚合键：同大类 + 同省区 + 同朝代 + 同书名主干 视为同一部书的不同卷。 */
export function bookKey(category: string, province: string, era: string | undefined, title: string): string {
  return [category, province, era ?? '-', title].join('|');
}

export { ZHI_SECTION, ZHI_BOOK_RE };
