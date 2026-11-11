import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { crawlShare, diffDumps, parseShareUrl } from './crawl.ts';
import type { CrawlCheckpoint } from './crawl.ts';
import { buildIndex } from './build-index.ts';
import { toLean } from './types.ts';
import type { RawShareDump, GazetteerIndex, IndexMeta, ExtKind } from './types.ts';
import { search, computeFacets, facetOptions, formatSize } from './search.ts';
import type { SearchFilters } from './search.ts';

const DATA_DIR = resolve('data');
const DUMP_PATH = resolve(DATA_DIR, 'raw.json');
const CKPT_PATH = resolve(DATA_DIR, 'crawl-checkpoint.json');
const FULL_PATH = resolve(DATA_DIR, 'index.full.json');
const LEAN_PATH = resolve(DATA_DIR, 'index.lean.json');

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.findIndex((a) => a === `--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3) ?? fallback;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
/** 位置参数。跳过 --x 形式的选项和紧跟在取值选项后面的那个词。 */
function positionals(from: number): string[] {
  const VALUE_FLAGS = new Set(['url', 'share', 'q', 'limit', 'province', 'era', 'zhi', 'category', 'ext']);
  const out: string[] = [];
  for (let i = from; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    if (a.startsWith('--')) {
      if (!a.includes('=') && VALUE_FLAGS.has(a.slice(2))) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}
/** 同目录临时文件 + 原子替换，避免进程中断后留下半份索引。 */
function write(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}
function readJson<T>(path: string): T | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : undefined;
}
function mb(path: string): string {
  return (readFileSync(path).length / 1048576).toFixed(2) + 'MB';
}

async function cmdCrawl(): Promise<void> {
  const url = arg('url') ?? arg('share') ?? 'https://pan.quark.cn/s/2d5c2ddfe25b';
  const target = parseShareUrl(url);
  const resumeFrom = flag('resume') ? readJson<CrawlCheckpoint>(CKPT_PATH) : undefined;
  if (resumeFrom) console.log(`续爬：已有 ${resumeFrom.rows.length} 行，${resumeFrom.listedFids.length} 个目录列完`);

  let last = 0;
  const { dump, meta } = await crawlShare({
    target,
    resume: resumeFrom,
    onProgress: (p) => {
      const now = Date.now();
      if (now - last < 500) return;
      last = now;
      process.stdout.write(`\r  目录 ${p.dirsDone} 个 (待 ${p.dirsPending}) | 文件 ${p.files} | 请求 ${p.reqCount} | ${p.currentPath.slice(-46)}`);
    },
    onCheckpoint: (c) => write(CKPT_PATH, JSON.stringify(c)),
  });
  process.stdout.write('\n');

  const prev = readJson<RawShareDump>(DUMP_PATH);
  if (prev) {
    const d = diffDumps(prev, dump);
    console.log(`增量对比：新增 ${d.added}，删除 ${d.removed}，变更 ${d.changed}`);
    for (const p of d.addedPaths.slice(0, 10)) console.log(`  + ${p}`);
    for (const p of d.removedPaths.slice(0, 10)) console.log(`  - ${p}`);
  }

  write(DUMP_PATH, JSON.stringify(dump));
  write(resolve(DATA_DIR, 'meta.json'), JSON.stringify(meta, null, 2));
  // 爬完了就不该再留断点，否则下次 --resume 会拿一份过期数据当起点
  if (existsSync(CKPT_PATH)) rmSync(CKPT_PATH);

  const files = dump.rows.filter((r) => r.type === 'file');
  console.log(`完成：${files.length} 个文件，${dump.rows.length - files.length} 个目录，最大深度 ${dump.stat.maxDepth}，请求 ${dump.stat.reqCount} 次`);
  console.log(`分享名：${meta.shareTitle}  作者：${meta.author ?? '-'}`);
  console.log(`总大小：${formatSize(files.reduce((a, b) => a + b.size, 0))}`);
  console.log(`已写入 ${DUMP_PATH}`);
}

function cmdBuildIndex(): void {
  const dump = readJson<RawShareDump>(DUMP_PATH);
  if (!dump) throw new Error(`找不到 ${DUMP_PATH}，先跑 npm run crawl`);
  const meta = readJson<IndexMeta>(resolve(DATA_DIR, 'meta.json')) ?? {
    pwdId: '', shareUrl: '', shareTitle: '',
  };

  const t = Date.now();
  const previous = readJson<GazetteerIndex>(FULL_PATH);
  const idx = buildIndex(dump, { meta, previous });
  write(FULL_PATH, JSON.stringify(idx));
  const lean = toLean(idx);
  write(LEAN_PATH, JSON.stringify(lean));

  console.log(`构建耗时 ${Date.now() - t}ms`);
  console.log(`文件 ${idx.stats.fileCount} | 书 ${idx.stats.bookCount} | 总体积 ${formatSize(idx.stats.totalSize)}`);
  console.log(`  ${FULL_PATH}  ${mb(FULL_PATH)}`);
  console.log(`  ${LEAN_PATH}  ${mb(LEAN_PATH)}  (小程序用)`);
}

function cmdStats(): void {
  const idx = readJson<GazetteerIndex>(FULL_PATH);
  if (!idx) throw new Error(`找不到 ${FULL_PATH}，先跑 npm run build-index`);
  const c = idx.stats.parseCoverage;
  const pct = (n: number, d: number) => `${n}/${d}  ${((n / d) * 100).toFixed(1)}%`;
  console.log(`文件 ${idx.stats.fileCount} | 书 ${idx.stats.bookCount} | ${formatSize(idx.stats.totalSize)}`);
  console.log(`爬取时间 ${idx.crawledAt}`);
  console.log('\n--- 解析覆盖率 ---');
  console.log(`  志种  ${pct(c.zhiType, idx.stats.bookCount)}`);
  console.log(`  朝代  ${pct(c.era, idx.stats.bookCount)}`);
  console.log(`  地名  ${pct(c.place, idx.stats.bookCount)}`);
  console.log(`  卷次  ${pct(c.volume, idx.stats.fileCount)} (按文件)`);
  console.log(`  继承  ${pct(c.inherited, idx.stats.fileCount)} (按文件)`);
  console.log(`  噪声  ${c.noise}`);
  const show = (label: string, o: Record<string, number>, n = 14) => {
    console.log(`\n--- ${label} ---`);
    for (const x of facetOptions(o).slice(0, n)) console.log(`  ${x.value.padEnd(18)} ${x.count}`);
  };
  show('省区分布', idx.stats.byProvince);
  show('朝代分布', idx.stats.byEra);
  show('格式分布', idx.stats.byExt);
  const f = computeFacets(idx);
  show('志种分布', f.zhiType, 20);
}

function cmdSearch(): void {
  const idx = readJson<GazetteerIndex>(FULL_PATH);
  if (!idx) throw new Error(`找不到 ${FULL_PATH}，先跑 npm run build-index`);
  const q = arg('q') ?? positionals(3)[0] ?? '';
  const limit = Number(arg('limit', '20'));
  const list = (name: string): string[] | undefined => arg(name)?.split(',').filter(Boolean);
  const filters: SearchFilters = {
    provinces: list('province'),
    eras: list('era'),
    zhiTypes: list('zhi'),
    categories: list('category'),
    exts: list('ext') as ExtKind[] | undefined,
  };
  const r = search(idx, q, { limit, ...filters });
  console.log(`"${q}" → ${r.total} 部书，${r.elapsedMs}ms`);
  for (const h of r.items) {
    const b = h.book;
    console.log(
      `  ${String(Math.round(h.score)).padStart(5)}  《${b.title}》 ${b.era ?? ''} [${b.province ?? '-'}]` +
        ` ${b.fileCount}册 ${formatSize(b.totalSize)} ${h.direct ? '' : '(模糊)'}`,
    );
    if (flag('files')) for (const f of h.files.slice(0, 5)) console.log(`           └ ${f.file.name}`);
  }
}

const cmd = process.argv[2];
const run: Record<string, () => void | Promise<void>> = {
  crawl: cmdCrawl,
  'build-index': cmdBuildIndex,
  stats: cmdStats,
  search: cmdSearch,
};

if (!cmd || !run[cmd]) {
  console.log(`用法: node packages/core/src/cli.ts <命令>

  crawl [--url <分享链接>] [--resume]     遍历分享目录树，写 data/raw.json
  build-index                            从 raw.json 构建 full + lean 索引
  stats                                  打印索引统计与解析覆盖率
  search [--q <词>] [--limit N] [--files] 检索
         [--province 江西省] [--era 光绪] [--zhi 县志] [--category 各地方志] [--ext djvu]`);
  process.exit(cmd ? 1 : 0);
}

try {
  await run[cmd]!();
} catch (e) {
  console.error('失败:', e instanceof Error ? e.message : e);
  process.exit(1);
}
