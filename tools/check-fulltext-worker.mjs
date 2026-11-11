import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';

const root = mkdtempSync(join(tmpdir(), 'fz-worker-'));
mkdirSync(join(root, 'ocr'), { recursive: true });
const page = (p, text) => JSON.stringify({ p, dpi: 200, w: 100, h: 200, text, lines: [] });
writeFileSync(join(root, 'ocr', 'a.jsonl'), [page(1, '嘉慶贛州府志序 贛州府志創修'), page(2, '贛州府志卷二 山川')].join('\n'));
writeFileSync(join(root, 'ocr', 'b.jsonl'), page(1, '吉水縣志 贛州府志未載'));

const files = [
  { fid: 'a', bookId: 'book-a', title: '贛州府志', name: 'a.pdf', textRef: 'ocr/a.jsonl' },
  { fid: 'b', bookId: 'book-b', title: '吉水縣志', name: 'b.pdf', textRef: 'ocr/b.jsonl' },
];

const w = new Worker(resolve('apps/desktop/dist/main/fulltext-worker.cjs'));

let progress = 0;
const results = [];
w.on('message', (m) => {
  if (m.type === 'progress') progress++;
  if (m.type === 'done' || m.type === 'error') results.push(m);
});
w.on('error', (e) => { console.error('worker error', e); process.exit(1); });

const wait = (n) => new Promise((res, rej) => {
  const t = setInterval(() => {
    if (results.length >= n) { clearInterval(t); res(); }
  }, 10);
  setTimeout(() => { clearInterval(t); rej(new Error('timeout, got ' + results.length)); }, 8000);
});

// 1. 首次检索
w.postMessage({ type: 'search', job: { id: 1, q: '赣州府志', limit: 20, dataDir: root, files } });
await wait(1);
const r1 = results[0];
if (r1.type !== 'done') throw new Error('first search failed: ' + JSON.stringify(r1));
console.log('first total', r1.result.total, 'books', r1.result.books.map((b) => `${b.title}:${b.count}`).join(','));
console.log('progress messages', progress, 'snippet', r1.result.books[0].files[0].snippet);

// 2. 缓存命中 + 取消：先发长查询再立刻取消
const t0 = Date.now();
w.postMessage({ type: 'search', job: { id: 2, q: '吉水', limit: 20, dataDir: root, files } });
w.postMessage({ type: 'cancel', id: 2 });
await wait(2);
const r2 = results[1];
console.log('cancel result', JSON.stringify(r2), 'elapsed', Date.now() - t0, 'ms');

// 3. 空查询
w.postMessage({ type: 'search', job: { id: 3, q: '   ', limit: 20, dataDir: root, files } });
await wait(3);
console.log('empty query', JSON.stringify(results[2].result));

await w.terminate();
rmSync(root, { recursive: true, force: true });
console.log('WORKER OK');
