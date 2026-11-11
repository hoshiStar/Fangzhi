import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { buildIndex } from '../packages/core/src/build-index.ts';
import { toLean } from '../packages/core/src/types.ts';
import { search, computeFacets, countSearchableBooks } from '../packages/core/src/search.ts';
import { applyBookOverrides, emptyBookOverrides, overrideForBook } from '../packages/core/src/book-overrides.ts';
import { toSimp } from '../packages/core/src/t2s.ts';
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

test('繁体输入能命中简体书目，简体输入不受影响', { skip: !existsSync('data/index.full.json') }, () => {
  const idx = JSON.parse(readFileSync('data/index.full.json', 'utf8')) as GazetteerIndex;

  // 映射本身：一字对一字，简体幂等，扩展区字符不打乱后面的对齐
  assert.equal(toSimp('贛州府志'), '赣州府志');
  assert.equal(toSimp('光緒'), '光绪');
  assert.equal(toSimp('赣州府志'), '赣州府志');
  assert.equal(toSimp('志'), '志');

  const trad = search(idx, '贛州府志', { limit: 10 });
  const simp = search(idx, '赣州府志', { limit: 10 });
  assert.ok(trad.directTotal >= 1, '繁体查询应有直接命中');
  assert.equal(trad.total, simp.total, '繁简查询结果数应一致');
  assert.equal(trad.items[0]?.book.id, simp.items[0]?.book.id, '繁简查询首条应一致');
  assert.ok(trad.items[0]?.book.title.includes('赣州'), '首条应是赣州府志');

  // 年代字段的繁体写法也要能对上
  const era = search(idx, '光緒 湖南通志', { limit: 5 });
  assert.ok(era.directTotal >= 1);
  assert.ok(era.items[0]?.book.title.includes('湖南通志'));
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

/** 书名里带朝代括注的书：解析会把「（嘉慶）」拆进完整名，title 本身不含括号。 */
function punctFixture(): RawShareDump {
  return {
    rows: [
      { type: 'dir', path: '/测试/各地方志', name: '各地方志', size: 0, fid: 'dir-root', depth: 1 },
      { type: 'dir', path: '/测试/各地方志/江西/赣州', name: '赣州', size: 0, fid: 'dir-gz', depth: 3 },
      {
        type: 'file',
        path: '/测试/各地方志/江西/赣州/（嘉慶）贛州府志.pdf',
        name: '（嘉慶）贛州府志.pdf',
        size: 100,
        fid: 'f-gz',
        depth: 4,
        pdir_fid: 'dir-gz',
      },
      {
        type: 'file',
        path: '/测试/各地方志/江西/赣州/赣州府志.pdf',
        name: '赣州府志.pdf',
        size: 100,
        fid: 'f-gz2',
        depth: 4,
        pdir_fid: 'dir-gz',
      },
    ],
    stat: { reqCount: 1, maxDepth: 4 },
  };
}

test('连写繁体查询靠紧凑串直接命中，不再掉进「近似」', () => {
  const idx = buildIndex(punctFixture(), { meta: META });
  const target = idx.books.find((b) => /贛州府志|赣州府志/.test(b.title) && b.displayTitle?.includes('嘉慶'));
  assert.ok(target, '夹具应解析出带朝代括注的书');

  // 「嘉慶贛州府志」中间不加空格，整串子串匹配会失败，去标点后才能对上完整名
  const joined = search(idx, '嘉慶贛州府志', { limit: 5 });
  const hit = joined.items.find((h) => h.book.id === target.id);
  assert.ok(hit, '连写查询应命中该书');
  assert.equal(hit.direct, true, '紧凑命中应算直接命中');
  assert.notEqual(hit.match, 'fuzzy');
  assert.ok(hit.matched.length > 0);

  // 带空格的老写法优先级更高：同一部书仍然排第一，且多打的「嘉慶」不该把结果降级
  const spaced = search(idx, '嘉慶 贛州府志', { limit: 5 });
  assert.equal(spaced.items[0]?.book.id, target.id);
  assert.equal(spaced.items[0]?.direct, true, '书名精确命中不因多余的词降级');
  assert.ok(spaced.items[0]!.score > hit.score, '分词命中的得分应高于连写紧凑命中');
});
