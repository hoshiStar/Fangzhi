import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DownloadManager, downloadDest, legacyDownloadDest, localFileMatches } from '../apps/desktop/src/main/download.ts';

test('同名文件按书目和 fid 隔离，不再落到同一路径', () => {
  const root = mkdtempSync(join(tmpdir(), 'fangzhi-dl-'));
  try {
    const a = downloadDest(root, { bookId: 'book-a', fid: 'fid-1', name: '天津通志.pdf' });
    const b = downloadDest(root, { bookId: 'book-b', fid: 'fid-2', name: '天津通志.pdf' });
    assert.notEqual(a, b);
    assert.match(a, /books[\\/]book-a[\\/]fid-1[\\/]天津通志\.pdf$/);
    assert.match(b, /books[\\/]book-b[\\/]fid-2[\\/]天津通志\.pdf$/);
    assert.notEqual(legacyDownloadDest(root, { bookId: 'book-a', fid: 'fid-1', name: '天津通志.pdf' }), a);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('下载清单可恢复未完成任务且不会自动联网', () => {
  const root = mkdtempSync(join(tmpdir(), 'fangzhi-dl-'));
  try {
    writeFileSync(join(root, 'download-manifest.json'), JSON.stringify({
      version: 1,
      items: [{
        fid: 'fid-restore',
        bookId: 'book-1',
        pdirFid: 'dir-1',
        name: '待下载.pdf',
        size: 100,
        bytes: 0,
        status: 'downloading',
        dest: join(root, 'books', 'book-1', 'fid-restore', '待下载.pdf'),
      }],
    }));
    const manager = new DownloadManager({
      cookie: () => '',
      shareUrl: () => 'https://pan.quark.cn/s/test',
      destDir: () => root,
      emit: () => undefined,
    });
    assert.equal(manager.restore(), 1);
    assert.equal(manager.list()[0]?.status, 'queued');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('本地文件必须大小匹配，防止同名错读', () => {
  const root = mkdtempSync(join(tmpdir(), 'fangzhi-dl-'));
  try {
    const p = join(root, 'book', 'fid', 'same.pdf');
    mkdirSync(join(root, 'book', 'fid'), { recursive: true });
    writeFileSync(p, Buffer.alloc(10));
    assert.equal(localFileMatches(p, 10), true);
    assert.equal(localFileMatches(p, 11), false);
    assert.equal(localFileMatches(join(root, 'missing.pdf'), 10), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
