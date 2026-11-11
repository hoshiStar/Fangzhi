import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GazetteerIndex } from '@fangzhi/core';

/**
 * 书签与最近阅读。放在 userData 下独立文件里：
 * 索引是「可以重新爬的公共数据」，这些是「用户自己的痕迹」，两者不能混在一起，
 * 否则重建索引或换数据目录就全丢了。
 */

export interface BookmarkRecord {
  /** fid + 页码，天然去重，同一页不会存两条。 */
  id: string;
  fid: string;
  bookId: string;
  /** 书名，便于索引重建后仍能显示（书可能已下架）。 */
  title: string;
  fileName: string;
  page: number;
  createdAt: string;
}

export interface RecentRecord {
  fid: string;
  bookId: string;
  title: string;
  fileName: string;
  page: number;
  at: string;
}

export interface LibraryFile {
  version: 1;
  marks: BookmarkRecord[];
  recent: RecentRecord[];
}

export interface LibraryDeps {
  index(): GazetteerIndex | null;
}

const RECENT_MAX = 30;
const MARKS_MAX = 2000;

function empty(): LibraryFile {
  return { version: 1, marks: [], recent: [] };
}

export function createLibrary(path: string, deps: LibraryDeps) {
  let data: LibraryFile = load();

  function load(): LibraryFile {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<LibraryFile>;
      if (raw?.version !== 1) return empty();
      return {
        version: 1,
        marks: Array.isArray(raw.marks) ? raw.marks.filter((m) => m && typeof m.fid === 'string' && typeof m.page === 'number') : [],
        recent: Array.isArray(raw.recent) ? raw.recent.filter((r) => r && typeof r.fid === 'string') : [],
      };
    } catch {
      // 文件不存在或损坏：当作空，不阻塞阅读
      return empty();
    }
  }

  function save(): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    renameSync(tmp, path);
  }

  /** 书名和所属书目从当前索引补齐；文件已不在索引里就退回文件名。 */
  function describe(fid: string): { bookId: string; title: string; fileName: string } {
    const idx = deps.index();
    const rec = idx?.files.find((f) => f.fid === fid);
    if (!rec) return { bookId: '', title: '', fileName: '' };
    const book = idx?.books.find((b) => b.id === rec.bookId);
    return { bookId: rec.bookId, title: book?.title ?? rec.name, fileName: rec.name };
  }

  const snapshot = (): LibraryFile => ({ version: 1, marks: [...data.marks], recent: [...data.recent] });

  return {
    list(): LibraryFile {
      return snapshot();
    },

    /** 同一页重复添加即取消，阅读器里一个按钮就够用。 */
    toggleMark(fid: string, page: number) {
      const p = Math.max(1, Math.floor(page));
      const id = `${fid}:${p}`;
      const at = data.marks.findIndex((m) => m.id === id);
      if (at >= 0) {
        data.marks.splice(at, 1);
        save();
        return { ok: true as const, added: false, marks: snapshot().marks };
      }
      const meta = describe(fid);
      data.marks.unshift({
        id,
        fid,
        bookId: meta.bookId,
        title: meta.title,
        fileName: meta.fileName,
        page: p,
        createdAt: new Date().toISOString(),
      });
      if (data.marks.length > MARKS_MAX) data.marks.length = MARKS_MAX;
      save();
      return { ok: true as const, added: true, marks: snapshot().marks };
    },

    removeMark(id: string) {
      const at = data.marks.findIndex((m) => m.id === id);
      if (at >= 0) {
        data.marks.splice(at, 1);
        save();
      }
      return snapshot().marks;
    },

    /** 每次翻页都会调，只更新这一条的页码和时间，不做无谓重写。 */
    touch(fid: string, page: number) {
      const p = Math.max(1, Math.floor(page));
      const at = data.recent.findIndex((r) => r.fid === fid);
      const prev = at >= 0 ? data.recent[at] : undefined;
      if (prev && prev.page === p && Date.now() - Date.parse(prev.at) < 10_000) return snapshot().recent;
      const meta = describe(fid);
      const rec: RecentRecord = {
        fid,
        bookId: meta.bookId || prev?.bookId || '',
        title: meta.title || prev?.title || meta.fileName || prev?.fileName || fid,
        fileName: meta.fileName || prev?.fileName || '',
        page: p,
        at: new Date().toISOString(),
      };
      if (at >= 0) data.recent.splice(at, 1);
      data.recent.unshift(rec);
      if (data.recent.length > RECENT_MAX) data.recent.length = RECENT_MAX;
      save();
      return snapshot().recent;
    },

    clearRecent() {
      data.recent = [];
      save();
      return snapshot().recent;
    },
  };
}

/** 供测试用：不碰磁盘，只看文件是否存在。 */
export function libraryExists(path: string): boolean {
  return existsSync(path);
}
