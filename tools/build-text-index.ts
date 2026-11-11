// 建全文倒排索引：data/.text-index/{index.bin, meta.json}
//
// 用法：
//   node tools/build-text-index.ts            用根目录 data/
//   node tools/build-text-index.ts <数据目录>
//   node tools/build-text-index.ts --update   增量：只重扫变过/新来的文件
//   FZ_DF_CAP=5000 node tools/build-text-index.ts   收紧高频双字剪枝阈值
//
// 只读 data/index.full.json 里带 textRef 的文件，不改索引本身；文本走 .text-cache，
// 所以重复构建大多只花在拼 postings 上。--update 是桌面端「识别完自动同步」走的同一条路。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  buildTextIndex, loadTextIndex, candidatePages, bigramKeys, updateTextIndex,
} from '../apps/desktop/src/main/text-index.ts';
import type { TextFileTask } from '../apps/desktop/src/main/fulltext-core.ts';
import { normalizeText } from '../apps/desktop/src/main/fulltext-core.ts';

const args = process.argv.slice(2);
const incremental = args.includes('--update');
const dataDir = resolve(args.find((a) => !a.startsWith('-')) ?? 'data');
const indexPath = join(dataDir, 'index.full.json');
if (!existsSync(indexPath)) {
  console.error(`找不到 ${indexPath}`);
  process.exit(1);
}

const idx = JSON.parse(readFileSync(indexPath, 'utf8')) as {
  files?: Array<{ fid?: string; bookId?: string; name?: string; textRef?: string }>;
};
const tasks: TextFileTask[] = (idx.files ?? [])
  .filter((f) => f.fid && f.textRef)
  .map((f) => ({
    fid: f.fid!,
    bookId: f.bookId ?? '',
    title: f.name ?? f.fid!,
    name: f.name ?? '',
    textRef: f.textRef!,
  }));

if (!tasks.length) {
  console.error('索引里没有任何 textRef，先跑 OCR（tools/ocr/ocr.py）再建倒排索引。');
  process.exit(1);
}

const dfCap = Number(process.env.FZ_DF_CAP ?? '') || undefined;
console.log(`${incremental ? '增量更新' : '全量重建'}倒排索引：${tasks.length} 个 OCR 文件，dfCap=${dfCap ?? '沿用索引设置'}`);
const t0 = Date.now();
const onProgress = (done: number, total: number): void => {
  if (done % 200 === 0 || done === total) process.stdout.write(`\r  已索引 ${done}/${total} 个文件`);
};
const meta = incremental
  ? (() => {
      const r = updateTextIndex(dataDir, tasks, { dfCap, onProgress });
      process.stdout.write('\n');
      const s = r.stats;
      console.log(
        s.full
          ? '  没有可用索引，已退化成全量重建'
          : `  新增 ${s.added} · 更新 ${s.updated} · 移除 ${s.removed} · 沿用 ${s.reused}${s.changed ? '' : '（没有任何变化，未写盘）'}`,
      );
      return r.meta;
    })()
  : (() => {
      const m = buildTextIndex(dataDir, tasks, { dfCap, onProgress });
      process.stdout.write('\n');
      return m;
    })();

const bin = join(dataDir, '.text-index', 'index.bin');
const mb = (n: number) => (n / 1048576).toFixed(2);
console.log(`  双字 ${meta.bigramCount} 个（剪枝 ${meta.prunedBigrams}） · 倒排 ${meta.postingCount} 条`);
console.log(`  index.bin ${mb(statSync(bin).size)} MB · 耗时 ${Date.now() - t0} ms`);

// 自检：索引必须能正常读回，且常见查询能落到候选页上
const loaded = loadTextIndex(dataDir);
if (!loaded) {
  console.error('自检失败：索引读不回来');
  process.exit(1);
}
for (const q of ['赣州府志', '县志', '京师']) {
  const needle = normalizeText(q);
  const cand = candidatePages(loaded, needle);
  const detail = cand === null
    ? '索引帮不上（退回扫描）'
    : `${cand.size} 个候选文件 / ${[...cand.values()].reduce((n, p) => n + p.length, 0)} 个候选页`;
  console.log(`  「${q}」(${bigramKeys(needle)?.length ?? 0} 个双字) → ${detail}`);
}
