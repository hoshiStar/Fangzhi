import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bigramKeys, buildTextIndex, candidatePages, coveredFids, invalidateTextIndexFiles,
  loadTextIndex, searchTextIndex, textIndexDir,
} from '../apps/desktop/src/main/text-index.ts';
import {
  finalizeBooks, loadTextFile, mergeFileHit, normalizeText, scanAllSync, scanLoaded,
} from '../apps/desktop/src/main/fulltext-core.ts';
import type { TextBookHit, TextFileTask } from '../apps/desktop/src/main/fulltext-core.ts';

const page = (p: number, text: string) => JSON.stringify({ p, dpi: 200, w: 100, h: 200, text, lines: [] });

function fixture(): { root: string; tasks: TextFileTask[] } {
  const root = mkdtempSync(join(tmpdir(), 'fz-tindex-'));
  mkdirSync(join(root, 'ocr'), { recursive: true });
  writeFileSync(join(root, 'ocr', 'f-a1.jsonl'), [
    page(1, '卷首　嘉慶贛州府志序　贛州府志創修於宋'),
    page(2, '贛州府志卷二　山川　贛江在其北'),
    page(3, '無關內容　風俗'),
  ].join('\n'));
  writeFileSync(join(root, 'ocr', 'f-a2.jsonl'), [
    page(1, '贛州府志卷三　城池　京師形勝'),
  ].join('\n'));
  writeFileSync(join(root, 'ocr', 'f-b1.jsonl'), [
    page(1, '吉水縣志　贛州府志未載'),
  ].join('\n'));
  const tasks: TextFileTask[] = [
    { fid: 'f-a1', bookId: 'book-a', title: '（嘉慶）贛州府志', name: 'a1.pdf', textRef: 'ocr/f-a1.jsonl' },
    { fid: 'f-a2', bookId: 'book-a', title: '（嘉慶）贛州府志', name: 'a2.pdf', textRef: 'ocr/f-a2.jsonl' },
    { fid: 'f-b1', bookId: 'book-b', title: '（民國）吉水縣志', name: 'b1.pdf', textRef: 'ocr/f-b1.jsonl' },
  ];
  return { root, tasks };
}

/** 用索引检索并聚合成扫描路径同形状的结果，方便逐项对比。 */
function searchByIndex(root: string, tasks: TextFileTask[], q: string): { total: number; books: TextBookHit[]; covered: number } {
  const index = loadTextIndex(root);
  assert.ok(index, '索引应能加载');
  const r = searchTextIndex(index, root, tasks, normalizeText(q));
  assert.ok(r, '这个查询应该能用上索引');
  const books = new Map<string, TextBookHit>();
  let total = 0;
  for (const h of r.hits) {
    total += h.count;
    mergeFileHit(books, h.task, h.loaded, h.hits, h.count, normalizeText(q));
  }
  return { total, books: finalizeBooks(books, 20), covered: r.covered.size };
}

test('倒排索引：候选页覆盖所有真实命中页', () => {
  const { root, tasks } = fixture();
  try {
    const meta = buildTextIndex(root, tasks);
    assert.equal(meta.files.length, 3);
    assert.ok(meta.bigramCount > 0 && meta.postingCount > 0);

    const index = loadTextIndex(root)!;
    const needle = normalizeText('赣州府志');
    const cand = candidatePages(index, needle);
    assert.ok(cand, '三个双字都该有倒排');
    const got = new Set<string>();
    for (const [fidIdx, pages] of cand) {
      for (const p of pages) got.add(`${index.meta.files[fidIdx]!.fid}:${p}`);
    }

    // 逐页扫出来的真实命中必须全在候选里，否则会漏结果
    const expected = new Set<string>();
    for (const task of tasks) {
      const { hits } = scanLoaded(loadTextFile(join(root, task.textRef)), needle);
      for (const h of hits) expected.add(`${task.fid}:${h.p}`);
    }
    assert.ok(expected.size >= 4, `夹具应有足够命中，实际 ${expected.size}`);
    for (const key of expected) assert.ok(got.has(key), `候选页缺了真实命中 ${key}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('倒排索引结果与全量扫描逐本逐页一致', () => {
  const { root, tasks } = fixture();
  try {
    buildTextIndex(root, tasks);
    for (const q of ['赣州府志', '京师', '吉水', '山川', '不存在字串']) {
      const scan = scanAllSync(tasks, root, q, 20);
      const viaIndex = searchByIndex(root, tasks, q);
      assert.equal(viaIndex.total, scan.total, `${q} 命中总数不一致`);
      assert.deepEqual(
        viaIndex.books.map((b) => [b.bookId, b.count, b.files.map((f) => [f.fid, f.count])]),
        scan.books.map((b) => [b.bookId, b.count, b.files.map((f) => [f.fid, f.count])]),
        `${q} 书目聚合不一致`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('单一双字与单字查询：单字退回扫描，双字能定候选', () => {
  const { root, tasks } = fixture();
  try {
    buildTextIndex(root, tasks);
    const index = loadTextIndex(root)!;
    assert.equal(candidatePages(index, normalizeText('府')), null, '单字没有双字键，应退回扫描');
    const cand = candidatePages(index, normalizeText('府志'));
    assert.ok(cand && cand.size >= 1);
    assert.equal(bigramKeys(normalizeText('府')), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('高频双字剪枝后仍能靠低频双字收窄；全被剪时退回扫描', () => {
  const { root, tasks } = fixture();
  try {
    // dfCap=1：出现两次以上的双字全部剪掉
    const meta = buildTextIndex(root, tasks, { dfCap: 1 });
    assert.ok(meta.prunedBigrams > 0, '应当有双字被剪枝');
    const index = loadTextIndex(root)!;
    // 「京师」只出现在一处 → 未剪，能定位到文件
    const rare = candidatePages(index, normalizeText('京师'));
    assert.ok(rare && rare.size === 1);
    // 「府志」高频但「赣州」也高频，整串可能全被剪 → 允许 null 或空，但不能给出错误候选
    const common = candidatePages(index, normalizeText('府志'));
    if (common) {
      for (const [, pages] of common) assert.ok(pages.length > 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('失效标记让改动过的文件回到「未覆盖」，由调用方整篇重扫', () => {
  const { root, tasks } = fixture();
  try {
    buildTextIndex(root, tasks);
    let index = loadTextIndex(root)!;
    assert.equal(coveredFids(index).size, 3);

    invalidateTextIndexFiles(root, ['f-b1']);
    index = loadTextIndex(root)!;
    assert.deepEqual([...coveredFids(index)].sort(), ['f-a1', 'f-a2']);

    // 被标失效的文件不在 covered 里，worker 会整篇扫描它
    const r = searchTextIndex(index, root, tasks, normalizeText('吉水'))!;
    assert.ok(!r.covered.has('f-b1'));
    assert.ok(!r.hits.some((h) => h.task.fid === 'f-b1'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OCR 重跑但没标失效：mtime 对不上时整篇重扫，不会漏掉新页', () => {
  const { root, tasks } = fixture();
  try {
    buildTextIndex(root, tasks);
    const index = loadTextIndex(root)!;
    // 在原文件末尾追加一页（含新的「赣州府志」），mtime 自然变化
    writeFileSync(join(root, 'ocr', 'f-b1.jsonl'), [
      page(1, '吉水縣志　贛州府志未載'),
      page(2, '贛州府志　補遺'),
    ].join('\n'));
    // 索引仍是旧的：候选里没有第 2 页，但 mtime 不一致会触发整篇重扫
    const r = searchTextIndex(index, root, tasks, normalizeText('赣州府志'))!;
    const b1 = r.hits.find((h) => h.task.fid === 'f-b1');
    assert.ok(b1, '失效文件应当被整篇重扫并命中');
    assert.deepEqual(b1.hits.map((h) => h.p), [1, 2]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('索引损坏或缺文件时当作没有，不抛错', () => {
  const { root, tasks } = fixture();
  try {
    buildTextIndex(root, tasks);
    assert.ok(loadTextIndex(root));
    // 破坏头部
    writeFileSync(join(textIndexDir(root), 'index.bin'), 'NOT-AN-INDEX');
    assert.equal(loadTextIndex(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('双字键忽略代理对，纯生僻字查询退回扫描', () => {
  assert.equal(bigramKeys('𪚥𪚥'), null);
  assert.deepEqual(bigramKeys('赣'), null);
  assert.equal(bigramKeys('赣州')?.length, 1);
  assert.equal(bigramKeys('赣州府志')?.length, 3);
});
