/**
 * 索引 schema。两端共用：桌面版读 full，小程序读 lean。
 * 全文检索字段已预留（ocrStatus / textRef），当前不填充。
 */

export const SCHEMA_VERSION = 1 as const;

/** 文件类型。djvu 是好压/古籍常见格式，uvz 是好压专有压缩包。 */
export type ExtKind = 'pdf' | 'djvu' | 'doc' | 'txt' | 'rar' | 'zip' | 'uvz' | 'exe' | 'other';

/** 全文检索的处理状态，为后续 Python OCR 支线预留。 */
export type OcrStatus = 'pending' | 'skipped' | 'done' | 'failed';

/** 元数据来自哪里，决定可信度。 */
export type MetaSource =
  | 'filename'        // 文件名自带朝代/卷次，最可信
  | 'parent-dir'      // 文件名是纯数字，继承父目录著录
  | 'catalog-string';  // 父目录是完整著录串（"55 保定府志（32册80卷），清 李振祜修…"）

export interface RawShareEntry {
  type: 'file' | 'dir';
  path: string;
  name: string;
  size: number;
  fid: string;
  depth: number;
  ext?: string;
  format?: string;
  share_fid_token?: string;
  pdir_fid?: string;
}

export interface RawShareDump {
  rows: RawShareEntry[];
  stat: { reqCount: number; maxDepth: number };
}

/** 单个物理文件的索引记录。 */
export interface FileRecord {
  /** 夸克 fid，同时作为稳定主键。 */
  id: string;
  fid: string;
  pdirFid: string;
  /** 换直链下载用。lean 投影会剥离此字段。 */
  shareFidToken: string;
  name: string;
  path: string;
  size: number;
  ext: ExtKind;
  bookId: string;
  /** 卷次原文，如 "卷首至卷十二"。 */
  volume?: string;
  /** 分册序号，如 "-01"、"part2"。 */
  part?: string;
  /** 分志，如《莆田县志》下的 "人物志"。 */
  section?: string;
  /** 垃圾文件（新建文本文档、须知、exe）。检索默认排除。 */
  isNoise: boolean;
  /** rar/zip 分卷的一部分，下载时需整组取回。 */
  isArchivePart: boolean;
  archiveGroup?: string;
  metaSource: MetaSource;
  /** 全文预留。 */
  ocrStatus: OcrStatus;
  textRef?: string;
}

/** 一部书（可能跨多个物理文件）。检索的主要单位。 */
export interface BookRecord {
  id: string;
  /** 书名主干，已剥离卷次/分册/朝代前缀，如 "吉水县志"。 */
  title: string;
  /** 展示用完整名，保留朝代标记，如 "[道光]吉水县志"。 */
  displayTitle: string;
  /** 志种后缀，如 "县志"、"通志"、"乡土志"。 */
  zhiType?: string;
  /** 地名，已剥省级前缀，如 "吉水"、"兴化府莆田"。 */
  place?: string;
  /** 省区分组（分享库自带的 18 个大区），如 "江西省"。 */
  province?: string;
  /** 大类，如 "各地方志"、"一统志、图志、方舆考证"。 */
  category: string;
  /** 朝代或年号，如 "道光"、"民国"。 */
  era?: string;
  /** 从父目录著录串解析出的作者，如 "李振祜修 张豫垲纂"。 */
  author?: string;
  /** 版本，如 "光绪刻本"、"四部丛刊本"。 */
  edition?: string;
  /** 父目录著录原文，未解析时供人工核对。 */
  catalogRaw?: string;
  /** 0~1，解析置信度。低于阈值的在 UI 上标记待核。 */
  confidence: number;
  fileIds: string[];
  fileCount: number;
  totalSize: number;
  exts: ExtKind[];
  /** 全文预留：已完成 OCR 的文件数。 */
  ocrDone: number;
}

export interface IndexStats {
  fileCount: number;
  bookCount: number;
  totalSize: number;
  byCategory: Record<string, number>;
  byProvince: Record<string, number>;
  byEra: Record<string, number>;
  byExt: Record<string, number>;
  parseCoverage: {
    zhiType: number;
    era: number;
    place: number;
    volume: number;
    inherited: number;
    noise: number;
  };
}

export interface IndexMeta {
  pwdId: string;
  shareUrl: string;
  shareTitle: string;
  author?: string;
  expiredAt?: number;
}

/** 完整索引：桌面版用，含下载所需 token。 */
export interface GazetteerIndex {
  schemaVersion: typeof SCHEMA_VERSION;
  meta: IndexMeta;
  crawledAt: string;
  stats: IndexStats;
  books: BookRecord[];
  files: FileRecord[];
}

/** 精简索引：小程序用，去掉 token 与路径，只留检索所需。 */
export interface LeanIndex {
  schemaVersion: typeof SCHEMA_VERSION;
  meta: IndexMeta;
  crawledAt: string;
  stats: IndexStats;
  books: BookRecord[];
  /** 只保留展示与跳转所需字段。 */
  files: Array<{
    id: string;
    fid: string;
    name: string;
    size: number;
    ext: ExtKind;
    bookId: string;
    volume?: string;
    part?: string;
    section?: string;
    ocrStatus: OcrStatus;
  }>;
}

export function toLean(idx: GazetteerIndex): LeanIndex {
  return {
    schemaVersion: idx.schemaVersion,
    meta: idx.meta,
    crawledAt: idx.crawledAt,
    stats: idx.stats,
    books: idx.books,
    files: idx.files.map((f) => ({
      id: f.id,
      fid: f.fid,
      name: f.name,
      size: f.size,
      ext: f.ext,
      bookId: f.bookId,
      volume: f.volume,
      part: f.part,
      section: f.section,
      ocrStatus: f.ocrStatus,
    })),
  };
}
