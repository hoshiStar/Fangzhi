import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  finalizeBooks, loadTextFast, loadTextFile, mergeFileHit, parseTextCache, parseTextFile,
  resolveTextPath, scanAllSync, scanLoaded, normalizeText, serializeTextCache, textCachePath,
} from '../apps/desktop/src/main/fulltext-core.ts';
import type { TextBookHit, TextFileTask } from '../apps/desktop/src/main/fulltext-core.ts';

function page(p: number, text: string) {
  return JSON.stringify({ p, dpi: 200, w: 100, h: 200, text, lines: [] });
}

/** 造一个临时数据目录：ocr/<fid>.jsonl，textRef 相对数据目录。 */
function makeDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'fz-fulltext-'));
  mkdirSync(join(root, 'ocr'), { recursive: true });
  writeFileSync(join(root, 'ocr', 'f-a1.jsonl'), [
    page(1, '卷首　嘉慶贛州府志序　贛州府志創修於宋'),
    page(2, '贛州府志卷二　山川　贛江在其北'),
    page(3, '無關內容'),
    '{半截行',
  ].join('\n'));
  writeFileSync(join(root, 'ocr', 'f-a2.jsonl'), [
    page(1, '贛州府志卷三　城池'),
  ].join('\n'));
  writeFileSync(join(root, 'ocr', 'f-b1.jsonl'), [
    page(1, '吉水縣志　贛州府志未載'),
    page(2, '贛州府志　再次出現'),
  ].join('\n'));
  return root;
}

const tasks: TextFileTask[] = [
  { fid: 'f-a1', bookId: 'book-a', title: '（嘉慶）贛州府志', name: 'a1.pdf', textRef: 'ocr/f-a1.jsonl' },
  { fid: 'f-a2', bookId: 'book-a', title: '（嘉慶）贛州府志', name: 'a2.pdf', textRef: 'ocr/f-a2.jsonl' },
  { fid: 'f-b1', bookId: 'book-b', title: '（民國）吉水縣志', name: 'b1.pdf', textRef: 'ocr/f-b1.jsonl' },
  { fid: 'f-missing', bookId: 'book-c', title: '缺失文本', name: 'c.pdf', textRef: 'ocr/not-there.jsonl' },
];

test('OCR jsonl 解析：末行半截不影响前面的页', () => {
  const loaded = parseTextFile([
    page(1, '第一頁'),
    page(2, '第二頁'),
    '{半截行',
    '',
  ].join('\n'));
  assert.deepEqual([...loaded.pages.keys()], [1, 2]);
  assert.equal(loaded.pages.get(1)?.text, '第一頁');
});

test('繁简归一后按页统计命中次数', () => {
  const root = makeDataDir();
  try {
    const loaded = loadTextFile(join(root, 'ocr', 'f-a1.jsonl'));
    const { hits, count } = scanLoaded(loaded, normalizeText('赣州府志'));
    // 第 1 页 2 次、第 2 页 1 次，第 3 页无
    assert.deepEqual(hits, [{ p: 1, n: 2 }, { p: 2, n: 1 }]);
    assert.equal(count, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('全库同步检索：按书聚合、按命中数排序、带片段与高亮区间', () => {
  const root = makeDataDir();
  try {
    const r = scanAllSync(tasks, root, '赣州府志', 20);
    assert.equal(r.books.length, 2);
    assert.equal(r.books[0]?.bookId, 'book-a');
    assert.equal(r.books[0]?.count, 4);
    assert.equal(r.books[0]?.title, '（嘉慶）贛州府志');
    // book-a 下 a1 命中多，排在前面
    assert.equal(r.books[0]?.files[0]?.fid, 'f-a1');
    assert.equal(r.total, 6);

    const first = r.books[0]!.files[0]!;
    assert.ok(first.snippet.includes('贛州府志'), `片段应保留原文繁体：${first.snippet}`);
    const [from, to] = first.marks[0]!;
    // marks 落在原文片段上，切片就是命中的词（保留 OCR 的繁体字形）
    assert.equal(first.snippet.slice(from, to), '贛州府志');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('缺失的 textRef 直接跳过，不影响其它书', () => {
  const root = makeDataDir();
  try {
    const r = scanAllSync(tasks, root, '吉水', 20);
    assert.equal(r.books.length, 1);
    assert.equal(r.books[0]?.bookId, 'book-b');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('limit 生效：只返回命中最多的前 N 部', () => {
  const root = makeDataDir();
  try {
    const r = scanAllSync(tasks, root, '赣州府志', 1);
    assert.equal(r.books.length, 1);
    assert.equal(r.books[0]?.bookId, 'book-a');
    // total 统计不受 limit 影响
    assert.equal(r.total, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('textRef 越出数据目录一律拒绝', () => {
  const root = makeDataDir();
  try {
    assert.equal(resolveTextPath(root, '../outside.jsonl'), null);
    assert.equal(resolveTextPath(root, 'ocr/not-there.jsonl'), null);
    assert.ok(resolveTextPath(root, 'ocr/f-a1.jsonl'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('同一本书多文件合并到一条书目记录', () => {
  const root = makeDataDir();
  try {
    const books = new Map<string, TextBookHit>();
    const needle = normalizeText('赣州府志');
    for (const task of tasks.slice(0, 2)) {
      const loaded = loadTextFile(join(root, task.textRef));
      const { hits, count } = scanLoaded(loaded, needle);
      mergeFileHit(books, task, loaded, hits, count, needle);
    }
    const merged = finalizeBooks(books, 20);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.files.length, 2);
    assert.equal(merged[0]?.count, 4);
    assert.deepEqual(merged[0]?.files.map((f) => f.fid).sort(), ['f-a1', 'f-a2']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('磁盘文本缓存：往返一致，mtime 变了就失效', () => {
  const root = makeDataDir();
  try {
    const file = join(root, 'ocr', 'f-a1.jsonl');
    const cacheFile = textCachePath(root, 'f-a1');

    const first = loadTextFast(file, cacheFile);
    assert.ok(first);
    assert.equal(first.fromCache, false, '第一次应该解析 jsonl');
    assert.ok(existsSync(cacheFile), '解析后应写出缓存');

    const second = loadTextFast(file, cacheFile);
    assert.ok(second);
    assert.equal(second.fromCache, true, '第二次应命中缓存');
    // 缓存里没有坐标，但检索要用的两样东西必须一致
    assert.equal(second.loaded.pages.get(1)?.text, first.loaded.pages.get(1)?.text);
    assert.equal(second.loaded.norm.get(1)?.n, first.loaded.norm.get(1)?.n);
    assert.equal(second.loaded.norm.get(1)?.aligned, first.loaded.norm.get(1)?.aligned);
    assert.deepEqual(
      scanLoaded(second.loaded, normalizeText('赣州府志')),
      scanLoaded(first.loaded, normalizeText('赣州府志')),
    );

    // 假装 OCR 重跑过：缓存头里的 mtime 对不上就必须重新解析
    const stale = serializeTextCache(first.loaded, 1);
    assert.equal(parseTextCache(stale, 2), null);
    assert.ok(parseTextCache(stale, 1));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('缓存吸收正文里的换行和制表符', () => {
  const loaded = parseTextFile([
    JSON.stringify({ p: 1, dpi: 200, w: 10, h: 10, text: '第一行\t带制表\n第二行', lines: [] }),
  ].join('\n'));
  const round = parseTextCache(serializeTextCache(loaded, 123), 123);
  assert.equal(round?.pages.get(1)?.text, '第一行\t带制表\n第二行');
});

test('缓存文件路径按 fid 收敛到安全文件名', () => {
  const p = textCachePath('D:/data', '../evil/../f-x1');
  assert.ok(!p.includes('..'), `不应出现上级路径：${p}`);
  assert.ok(p.includes('.text-cache'));
});
