import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { buildIndex } from '../packages/core/src/build-index.ts';
import { toLean } from '../packages/core/src/types.ts';
import { search, computeFacets, countSearchableBooks } from '../packages/core/src/search.ts';
import { applyBookOverrides, emptyBookOverrides, overrideForBook } from '../packages/core/src/book-overrides.ts';
import type { GazetteerIndex, RawShareDump } from '../packages/core/src/types.ts';

const META = {
  pwdId: 'test',
  shareUrl: 'https://pan.quark.cn/s/test',
  shareTitle: '测试分享',
};

function fixture(): RawShareDump {
  return {
    rows: [
      { type: 'dir', path: '/测试/各地方志', name: '各地方志', size: 0, fid: 'dir-root', depth: 1 },
      { type: 'dir', path: '/测试/各地方志/江西/吉安', name: '吉安', size: 0, fid: 'dir-jian', depth: 3 },
      {
        type: 'file',
        path: '/测试/各地方志/江西/吉安/吉水县志.pdf',
        name: '吉水县志.pdf',
        size: 123,
        fid: 'f-normal',
        depth: 4,
        pdir_fid: 'dir-jian',
      },
      {
        type: 'file',
        path: '/测试/各地方志/江西/吉安/新建文本文档.txt',
        name: '新建文本文档.txt',
        size: 8,
        fid: 'f-noise',
        depth: 4,
        pdir_fid: 'dir-jian',
      },
    ],
    stat: { reqCount: 1, maxDepth: 4 },
  };
}

test('重建索引时按 fid 保留 OCR 引用和完成状态', () => {
  const first = buildIndex(fixture(), { meta: META });
  const file = first.files.find((f) => f.fid === 'f-normal');
  assert.ok(file, '正常文件应进入索引');
  file.textRef = 'ocr/f-normal.jsonl';
  file.ocrStatus = 'done';
  const book = first.books.find((b) => b.id === file.bookId);
  assert.ok(book);
  book.ocrDone = 1;

  const next = buildIndex(fixture(), { meta: META, previous: first });
  const kept = next.files.find((f) => f.fid === 'f-normal');
  assert.equal(kept?.textRef, 'ocr/f-normal.jsonl');
  assert.equal(kept?.ocrStatus, 'done');
  assert.equal(next.books.find((b) => b.id === kept?.bookId)?.ocrDone, 1);
});

test('lean/full 对全噪声书使用同一检索口径', () => {
  const full = buildIndex(fixture(), { meta: META });
  const lean = toLean(full);
  assert.equal(lean.files.every((f) => typeof f.isNoise === 'boolean'), true);

  const a = search(full, '', { limit: 50 });
  const b = search(lean, '', { limit: 50 });
  assert.equal(a.total, b.total);
  assert.equal(a.directTotal, b.directTotal);
  assert.equal(a.total, countSearchableBooks(full));
  assert.equal(JSON.stringify(computeFacets(full)), JSON.stringify(computeFacets(lean)));
  assert.ok(a.total < full.books.length, '全噪声书应被检索排除');
});

test('严格全词模式不返回部分命中结果', () => {
  const idx = buildIndex(fixture(), { meta: META });
  const loose = search(idx, '吉水 江西', { limit: 50 });
  const strict = search(idx, '吉水 江西', { limit: 50, allTermsOnly: true });
  assert.ok(strict.items.every((h) => h.direct), '严格模式只允许直接命中');
  assert.ok(strict.total <= loose.total);
});

test('人工校正按书目成员应用，并在重建后继续生效', () => {
  const first = buildIndex(fixture(), { meta: META });
  const book = first.books.find((b) => b.title.includes('吉水'));
  assert.ok(book);

  const overrides = emptyBookOverrides();
  overrides.books[book.id] = {
    bookId: book.id,
    fileIds: [...book.fileIds],
    title: '吉水县志（校正）',
    era: '民国',
    updatedAt: new Date().toISOString(),
  };
  assert.equal(applyBookOverrides(first, overrides), 1);
  assert.equal(book.title, '吉水县志（校正）');
  assert.equal(book.era, '民国');
  assert.equal(book.verified, true);
  assert.equal(overrideForBook(overrides, book)?.title, '吉水县志（校正）');

  const rebuilt = buildIndex(fixture(), { meta: META, previous: first });
  applyBookOverrides(rebuilt, overrides);
  assert.ok(rebuilt.books.some((b) => b.title === '吉水县志（校正）' && b.verified));

  const wrong = emptyBookOverrides();
  wrong.books[book.id] = { ...overrides.books[book.id]!, fileIds: ['not-this-book'] };
  const untouched = buildIndex(fixture(), { meta: META });
  assert.equal(applyBookOverrides(untouched, wrong), 0, '成员文件不匹配时不得套用校正');
});

test('桌面 full 与小程序 mini 的关键查询一致', { skip: !existsSync('data/index.full.json') || !existsSync('apps/miniprogram/index.mini.json') }, () => {
  const full = JSON.parse(readFileSync('data/index.full.json', 'utf8')) as GazetteerIndex;
  const mini = JSON.parse(readFileSync('apps/miniprogram/index.mini.json', 'utf8')) as GazetteerIndex;
  for (const q of ['', '县志', '吉水县志', '光绪 湖南通志', '保定府志']) {
    const a = search(full, q, { limit: 50 });
    const b = search(mini, q, { limit: 50 });
    assert.equal(a.total, b.total, `total mismatch: ${q}`);
    assert.equal(a.directTotal, b.directTotal, `directTotal mismatch: ${q}`);
    assert.equal(a.items[0]?.book.id, b.items[0]?.book.id, `first result mismatch: ${q}`);
  }
});
