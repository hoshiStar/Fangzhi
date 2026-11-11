import type { BookRecord, GazetteerIndex } from './types.ts';

/** 人工校正只保存用户真正改过的字段，重建索引时再合并回来。 */
export interface BookOverrideFields {
  title?: string;
  era?: string;
  place?: string;
  zhiType?: string;
  province?: string;
  author?: string;
  edition?: string;
}

export interface BookOverride extends BookOverrideFields {
  bookId: string;
  /** 保存时的成员文件；用于在书目重新聚合后避免把校正套到错误对象上。 */
  fileIds: string[];
  updatedAt: string;
}

export interface BookOverrideFile {
  version: 1;
  books: Record<string, BookOverride>;
}

const EMPTY: BookOverrideFile = { version: 1, books: {} };

export function emptyBookOverrides(): BookOverrideFile {
  return { version: 1, books: {} };
}

function normalizeText(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const s = v.trim();
  return s ? s : undefined;
}

/**
 * 把人工校正合并进索引。bookId 相同且文件集合至少有一个交集时才算同一本书，
 * 避免爬取/解析规则变化后把某一本书的校正错误套到另一本书上。
 */
export function applyBookOverrides(idx: GazetteerIndex, file: BookOverrideFile | undefined): number {
  const overrides = file?.books ?? EMPTY.books;
  let applied = 0;
  for (const b of idx.books) {
    const ov = overrides[b.id];
    if (!ov) continue;
    if (ov.fileIds.length) {
      const current = new Set(b.fileIds);
      if (!ov.fileIds.some((id) => current.has(id))) continue;
    }
    const fields: Array<keyof BookOverrideFields> = [
      'title', 'era', 'place', 'zhiType', 'province', 'author', 'edition',
    ];
    for (const key of fields) {
      if (!(key in ov)) continue;
      const value = normalizeText(ov[key]);
      if (value) b[key] = value;
      else if (key !== 'title') delete b[key];
      // 书名是检索和书目的必需字段，不允许通过清空校正删掉。
    }
    if (ov.title !== undefined || ov.era !== undefined) {
      b.displayTitle = b.era && !b.title.includes(b.era) ? `[${b.era}]${b.title}` : b.title;
    }
    b.verified = true;
    applied++;
  }
  if (applied) idx.books.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
  return applied;
}

/** 给 UI 回显用：只返回当前索引里仍有效的校正记录。 */
export function overrideForBook(file: BookOverrideFile | undefined, book: BookRecord): BookOverride | undefined {
  const ov = file?.books[book.id];
  if (!ov) return undefined;
  if (!ov.fileIds.length) return ov;
  const current = new Set(book.fileIds);
  return ov.fileIds.some((id) => current.has(id)) ? ov : undefined;
}
