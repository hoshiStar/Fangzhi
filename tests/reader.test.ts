import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { downloadDest } from '../apps/desktop/src/main/download.ts';
import { startReaderServer } from '../apps/desktop/src/main/reader.ts';
import type { ReaderDeps } from '../apps/desktop/src/main/reader.ts';
import type { FileRecord, GazetteerIndex } from '../packages/core/src/types.ts';

/** 32 字节假 PDF，够验 Range 的边界。 */
const BYTES = Buffer.from('0123456789abcdefghijklmnopqrstuv');

interface Fixture {
  root: string;
  deps: ReaderDeps;
  fid: string;
  cleanup(): void;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'fangzhi-reader-'));
  const fid = 'fid-test';
  const name = '测试县志.pdf';
  const rec = {
    id: fid,
    fid,
    bookId: 'book-test',
    name,
    size: BYTES.length,
    ext: 'pdf',
    isNoise: false,
    isArchivePart: false,
  } as unknown as FileRecord;
  const dest = downloadDest(root, { bookId: rec.bookId, fid, name });
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, BYTES);
  const index = { files: [rec], books: [], meta: {} } as unknown as GazetteerIndex;
  return {
    root,
    fid,
    deps: {
      hasCookie: () => false,
      cookie: () => '',
      downloadDir: () => root,
      index: () => index,
      shareUrl: () => '',
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 用原始 http 发请求，好把 Host 头改成别的东西（fetch 不允许动这个头）。 */
function rawStatus(origin: string, path: string, host: string): Promise<number> {
  const u = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: u.hostname, port: u.port, path, method: 'GET', headers: { host } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('本机阅读服务：缺 token 或 token 不对一律 403', async () => {
  const f = fixture();
  const srv = await startReaderServer(f.deps);
  try {
    assert.equal((await fetch(`${srv.origin}/read?fid=${f.fid}`)).status, 403);
    assert.equal((await fetch(`${srv.origin}/read?fid=${f.fid}&t=deadbeef`)).status, 403);
    assert.equal((await fetch(`${srv.origin}/nope?fid=${f.fid}&t=${srv.token}`)).status, 403);
  } finally {
    srv.close();
    f.cleanup();
  }
});

test('本机阅读服务：Host 不是本机这一份时 403', async () => {
  const f = fixture();
  const srv = await startReaderServer(f.deps);
  try {
    const port = new URL(srv.origin).port;
    assert.equal(await rawStatus(srv.origin, `/read?fid=${f.fid}&t=${srv.token}`, 'evil.example'), 403);
    // 正常 Host 应当放行（同一路径、同一 token）
    assert.equal(await rawStatus(srv.origin, `/read?fid=${f.fid}&t=${srv.token}`, `127.0.0.1:${port}`), 200);
  } finally {
    srv.close();
    f.cleanup();
  }
});

test('本机阅读服务：无 Range 返回整份，带 Range 返回 206 与正确的字节', async () => {
  const f = fixture();
  const srv = await startReaderServer(f.deps);
  try {
    const base = `${srv.origin}/read?fid=${f.fid}&t=${srv.token}`;

    const full = await fetch(base);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(full.headers.get('content-length'), String(BYTES.length));
    // pdf.js 靠这两个头判断能不能分段，缺了就会退化成整本读
    assert.match(full.headers.get('access-control-expose-headers') ?? '', /content-range/);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), BYTES);

    const part = await fetch(base, { headers: { range: 'bytes=4-11' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 4-11/${BYTES.length}`);
    assert.equal(part.headers.get('content-length'), '8');
    assert.equal(Buffer.from(await part.arrayBuffer()).toString(), '456789ab');

    // 大文件的首块请求就是这种形式
    const head = await fetch(base, { headers: { range: 'bytes=0-0' } });
    assert.equal(head.status, 206);
    assert.equal(Buffer.from(await head.arrayBuffer()).toString(), '0');
  } finally {
    srv.close();
    f.cleanup();
  }
});

test('本机阅读服务：未知 fid 404，大小对不上也不当成本地文件', async () => {
  const f = fixture();
  const srv = await startReaderServer(f.deps);
  try {
    assert.equal((await fetch(`${srv.origin}/read?fid=nope&t=${srv.token}`)).status, 404);

    // 同名文件但大小不符：localFileMatches 会拒绝，于是回落到在线分支 → 没 cookie 就 401
    writeFileSync(downloadDest(f.root, { bookId: 'book-test', fid: f.fid, name: '测试县志.pdf' }), 'tiny');
    assert.equal((await fetch(`${srv.origin}/read?fid=${f.fid}&t=${srv.token}`)).status, 401);
  } finally {
    srv.close();
    f.cleanup();
  }
});
