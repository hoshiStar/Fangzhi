import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex } from '../packages/core/src/build-index.ts';
import { createLibrary } from '../apps/desktop/src/main/library.ts';
import type { GazetteerIndex, RawShareDump } from '../packages/core/src/types.ts';

const META = { pwdId: 'test', shareUrl: 'https://pan.quark.cn/s/test', shareTitle: '测试分享' };

function fixture(): RawShareDump {
  return {
    rows: [
      { type: 'dir', path: '/测试/各地方志', name: '各地方志', size: 0, fid: 'dir-root', depth: 1 },
      { type: 'dir', path: '/测试/各地方志/江西/吉安', name: '吉安', size: 0, fid: 'dir-jian', depth: 3 },
      {
        type: 'file',
        path: '/测试/各地方志/江西/吉安',
        name: '（民国）吉水县志.pdf',
        size: 24 * 1024 * 1024,
        fid: 'fid-jishui',
        pdirFid: 'dir-jian',
        depth: 4,
        shareFidToken: 'tok',
      },
    ],
  } as unknown as RawShareDump;
}

test('书签可增可删，且按书目补齐书名', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fz-lib-'));
  try {
    const idx: GazetteerIndex = buildIndex(fixture(), { meta: META });
    const lib = createLibrary(join(dir, 'library.json'), { index: () => idx });

    const first = lib.toggleMark('fid-jishui', 12);
    assert.equal(first.added, true);
    assert.equal(first.marks.length, 1);
    assert.equal(first.marks[0]?.page, 12);
    assert.ok(first.marks[0]?.title.includes('吉水'), '书签应带上书名，便于索引变化后仍可辨认');
    assert.equal(first.marks[0]?.bookId.length > 0, true);

    // 同一页再点一次 = 取消收藏，不会留下两条
    const again = lib.toggleMark('fid-jishui', 12);
    assert.equal(again.added, false);
    assert.equal(again.marks.length, 0);

    const two = lib.toggleMark('fid-jishui', 3);
    lib.toggleMark('fid-jishui', 9);
    assert.equal(lib.list().marks.length, 2);
    assert.equal(lib.list().marks[0]?.page, 9, '新书签排在最前');
    assert.equal(lib.removeMark(`fid-jishui:9`).length, 1);
    assert.equal(lib.removeMark(`fid-jishui:3`).length, 0);
    assert.equal(two.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('最近阅读去重、保留最新页码并持久化', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fz-lib-'));
  const file = join(dir, 'library.json');
  try {
    const idx = buildIndex(fixture(), { meta: META });
    const lib = createLibrary(file, { index: () => idx });

    lib.touch('fid-jishui', 1);
    lib.touch('fid-jishui', 5);
    assert.equal(lib.list().recent.length, 1, '同一个文件只保留一条最近记录');
    assert.equal(lib.list().recent[0]?.page, 5);

    // 重新打开（模拟重启）：记录必须还在，且能读回页码
    const reopened = createLibrary(file, { index: () => idx });
    const recent = reopened.list().recent;
    assert.equal(recent.length, 1);
    assert.equal(recent[0]?.fid, 'fid-jishui');
    assert.equal(recent[0]?.page, 5);
    assert.ok((recent[0]?.title ?? '').includes('吉水'));

    // 索引里已经没有这个文件时也不能崩，退回已有标题
    const gone = createLibrary(file, { index: () => null });
    assert.equal(gone.list().recent[0]?.page, 5);

    reopened.clearRecent();
    assert.equal(reopened.list().recent.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('最近阅读有条数上限，不会无限增长', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fz-lib-'));
  try {
    const lib = createLibrary(join(dir, 'library.json'), { index: () => null });
    for (let i = 1; i <= 45; i++) lib.touch(`fid-${i}`, 1);
    assert.equal(lib.list().recent.length, 30);
    assert.equal(lib.list().recent[0]?.fid, 'fid-45', '最新的排最前');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
