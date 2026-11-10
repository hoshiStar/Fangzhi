import { crawlShare, parseShareUrl, diffDumps } from './packages/core/src/crawl.ts';
import type { CrawlCheckpoint } from './packages/core/src/crawl.ts';
import { readFileSync } from 'node:fs';
import type { RawShareDump } from './packages/core/src/types.ts';

const target = parseShareUrl('https://pan.quark.cn/s/2d5c2ddfe25b');
const full = JSON.parse(readFileSync('./data/raw.json', 'utf8')) as RawShareDump;

// 第一次：爬到 20 个目录就中断，留下断点
let ckpt: CrawlCheckpoint | undefined;
const ac = new AbortController();
try {
  await crawlShare({
    target,
    signal: ac.signal,
    onCheckpoint: (c) => {
      ckpt = c;
      if (c.listedFids.length >= 20) ac.abort();
    },
  });
  console.log('FAIL: 应该被中断');
} catch (e) {
  console.log(`中断成功: ${(e as Error).message}`);
}
if (!ckpt) throw new Error('没有拿到断点');
console.log(`断点: ${ckpt.rows.length} 行, ${ckpt.listedFids.length} 个目录已列完, ${ckpt.stat.reqCount} 次请求`);

// 第二次：从断点续爬
const t = Date.now();
const resumed = await crawlShare({ target, resume: ckpt });
const files = (d: RawShareDump) => d.rows.filter((r) => r.type === 'file').length;
const dirs = (d: RawShareDump) => d.rows.filter((r) => r.type === 'dir').length;

console.log(`续爬耗时 ${((Date.now() - t) / 1000).toFixed(1)}s, 请求 ${resumed.dump.stat.reqCount} 次`);
console.log(`完整爬取: ${files(full)} 文件 / ${dirs(full)} 目录`);
console.log(`断点续爬: ${files(resumed.dump)} 文件 / ${dirs(resumed.dump)} 目录`);

const d = diffDumps(full, resumed.dump);
console.log(`差异: 新增 ${d.added}, 删除 ${d.removed}, 变更 ${d.changed}`);

// 断点里的行不该在续爬时重复出现
const fids = resumed.dump.rows.map((r) => r.fid);
const dupes = fids.length - new Set(fids).size;
const ok = d.added === 0 && d.removed === 0 && d.changed === 0 && dupes === 0
  && files(resumed.dump) === files(full) && dirs(resumed.dump) === dirs(full);
console.log(ok ? 'PASS 续爬结果与完整爬取一致' : `FAIL 重复行=${dupes} 文件=${files(resumed.dump)}/${files(full)} 目录=${dirs(resumed.dump)}/${dirs(full)}`);
