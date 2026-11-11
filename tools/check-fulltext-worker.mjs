import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';

const root = mkdtempSync(join(tmpdir(), 'fz-worker-'));
mkdirSync(join(root, 'ocr'), { recursive: true });
const page = (p, text) => JSON.stringify({ p, dpi: 200, w: 100, h: 200, text, lines: [] });
writeFileSync(join(root, 'ocr', 'a.jsonl'), [page(1, '嘉慶贛州府志序 贛州府志創修'), page(2, '贛州府志卷二 山川')].join('\n'));
writeFileSync(join(root, 'ocr', 'b.jsonl'), page(1, '吉水縣志 贛州府志未載'));
// 这份正文里没有「赣」「州」任何一个字，位图预筛应当直接跳过它
writeFileSync(join(root, 'ocr', 'c.jsonl'), page(1, '順天府志 京師形勝'));

const files = [
  { fid: 'a', bookId: 'book-a', title: '贛州府志', name: 'a.pdf', textRef: 'ocr/a.jsonl' },
  { fid: 'b', bookId: 'book-b', title: '吉水縣志', name: 'b.pdf', textRef: 'ocr/b.jsonl' },
  { fid: 'c', bookId: 'book-c', title: '順天府志', name: 'c.pdf', textRef: 'ocr/c.jsonl' },
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
console.log('first run stats', JSON.stringify(r1.stats));
if (r1.stats.skipped < 1) throw new Error('位图预筛未生效: ' + JSON.stringify(r1.stats));
if (r1.result.books.some((b) => b.bookId === 'book-c')) throw new Error('被跳过文件不应出现在结果里');
if (r1.stats.skipped < 1) throw new Error('位图预筛未生效: ' + JSON.stringify(r1.stats));
if (r1.result.books.some((b) => b.bookId === 'book-c')) throw new Error('被跳过文件不应出现在结果里');

await w.terminate();

// 4. 换一个 worker（模拟重启程序）：应当全部命中磁盘缓存，不再解析 jsonl
const w2 = new Worker(resolve('apps/desktop/dist/main/fulltext-worker.cjs'));
const results2 = [];
w2.on('message', (m) => { if (m.type === 'done' || m.type === 'error') results2.push(m); });
w2.on('error', (e) => { console.error('worker2 error', e); process.exit(1); });
w2.postMessage({ type: 'search', job: { id: 9, q: '赣州府志', limit: 20, dataDir: root, files } });
await new Promise((res, rej) => {
  const t = setInterval(() => { if (results2.length) { clearInterval(t); res(); } }, 10);
  setTimeout(() => { clearInterval(t); rej(new Error('worker2 timeout')); }, 8000);
});
const r3 = results2[0];
if (r3.type !== 'done') throw new Error('second worker failed: ' + JSON.stringify(r3));
console.log('second run stats', JSON.stringify(r3.stats), 'total', r3.result.total);
// 只有 a、b 需要读正文；c 在缓存头就被位图挡掉了
if (r3.stats.cached !== 2 || r3.stats.parsed !== 0 || r3.stats.skipped !== 1) {
  throw new Error('重启后应两个走缓存、一个被跳过: ' + JSON.stringify(r3.stats));
}
// 同一线程内再查一次：位图进了内存缓存，一个系统调用都不该再发
const t1 = Date.now();
w2.postMessage({ type: 'search', job: { id: 10, q: '赣州府志', limit: 20, dataDir: root, files } });
await new Promise((res, rej) => {
  const t = setInterval(() => { if (results2.length >= 2) { clearInterval(t); res(); } }, 10);
  setTimeout(() => { clearInterval(t); rej(new Error('worker2 rerun timeout')); }, 8000);
});
console.log('second query in same worker', Date.now() - t1, 'ms', JSON.stringify(results2[1].stats));
if (r3.result.total !== r1.result.total) throw new Error('缓存前后结果不一致');
await w2.terminate();

rmSync(root, { recursive: true, force: true });
console.log('WORKER OK');
