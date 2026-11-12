// 手工装配便携版。electron-builder 的 asar 打包步骤在本机被 EBUSY 锁死，
// 而 Electron 本身只认 resources/app（或 app.asar），直接拼目录效果等价。
// 用法: node scripts/package-portable.mjs [输出目录]
import { cpSync, mkdirSync, renameSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = dirname(here);
const repo = resolve(desktop, '..', '..');
// 先装配到临时目录，最后整体替换：本机上杀软/残留进程常会短暂锁住上一版
// electron.exe 或 resources/*.asar，直接往旧目录里覆盖就会 EBUSY。
const target = process.argv[2] ? resolve(process.argv[2]) : join(repo, 'release', 'portable-win-x64');
const out = `${target}.staging-${process.pid}`;

const src = join(repo, 'data', 'index.full.json');
const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
if (!existsSync(join(desktop, 'dist', 'main', 'index.cjs'))) {
  console.error('缺少 dist/，先跑 npm run build');
  process.exit(1);
}
if (!existsSync(src)) {
  console.error('缺少 data/index.full.json，先跑 npm run crawl && npm run build-index（仓库根目录）');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
cpSync(join(repo, 'node_modules', 'electron', 'dist'), out, { recursive: true });
rmSync(join(out, 'resources', 'default_app.asar'));

const app = join(out, 'resources', 'app');
mkdirSync(app, { recursive: true });
writeFileSync(join(app, 'package.json'), JSON.stringify({
  name: 'fangzhi-desktop',
  productName: '方志检索',
  version: pkg.version,
  private: true,
  main: 'dist/main/index.cjs',
}, null, 2) + '\n');
cpSync(join(desktop, 'dist'), join(app, 'dist'), { recursive: true });

// 全文数据是否随包发（与 apps/desktop/src/main/index.ts 的 FULLTEXT_ENABLED 保持一致）。
// 冻结期间不带 data/ocr、.text-index、.text-cache：运行时根本不读它们，
// 白占体积还要多校验一遍时间戳；索引里的 textRef 字段仍然保留，
// 恢复时把这个常量改回 true 重新打包即可。
const FULLTEXT_ENABLED = false;

const data = join(out, 'resources', 'data');
mkdirSync(data, { recursive: true });
cpSync(src, join(data, 'index.full.json'));
const meta = join(repo, 'data', 'meta.json');
if (existsSync(meta)) cpSync(meta, join(data, 'meta.json'));
if (FULLTEXT_ENABLED) {
  // OCR 文本目录（tools/ocr/ocr.py 的产出），没有就不拷，阅读器会自己降级成只读 PDF
  // OCR 文本与倒排索引都按 (源文件 mtime) 判有效期，拷贝必须保留时间戳，
  // 否则包内索引一装就全部判过期，等于白带。
  const ocrDir = join(repo, 'data', 'ocr');
  if (existsSync(ocrDir)) cpSync(ocrDir, join(data, 'ocr'), { recursive: true, preserveTimestamps: true });
  // 倒排索引随包发：打包版数据目录通常不可写，运行时没法自己重建
  const textIndex = join(repo, 'data', '.text-index');
  if (existsSync(textIndex)) cpSync(textIndex, join(data, '.text-index'), { recursive: true, preserveTimestamps: true });
  // 检索缓存同理：跟 OCR 一起带走，首次检索不用重新解析
  const textCache = join(repo, 'data', '.text-cache');
  if (existsSync(textCache)) cpSync(textCache, join(data, '.text-cache'), { recursive: true, preserveTimestamps: true });
}

// 识别脚本随包发：桌面端「全文识别」要能直接拉起子进程（识别暂停时也用不上，
// 但只有二十来 KB，留着省得恢复时还要重新打包）。
// 模型（tools/ocr/models）几十 MB 且首次使用才下载，不打进包里。
const ocrScript = join(repo, 'tools', 'ocr', 'ocr.py');
if (existsSync(ocrScript)) {
  const dest = join(out, 'resources', 'tools', 'ocr');
  mkdirSync(dest, { recursive: true });
  cpSync(ocrScript, join(dest, 'ocr.py'));
}

/** 递归收集文件，用于版本清单和 OCR 覆盖率核对。 */
function walkFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walkFiles(p) : [p];
  });
}

const indexBytes = readFileSync(src);
const idx = JSON.parse(indexBytes.toString('utf8'));
/** 只有随包发 OCR 数据时才核对覆盖率，否则索引里残留的 textRef 会被当成「缺文件」。 */
const missingOcr = FULLTEXT_ENABLED
  ? (idx.files ?? [])
    .filter((f) => f.textRef && !existsSync(join(data, String(f.textRef))))
    .map((f) => f.textRef)
  : [];
if (missingOcr.length) {
  console.error(`发布中止：索引引用了 ${missingOcr.length} 个缺失的 OCR 文件，例如 ${missingOcr[0]}`);
  process.exit(1);
}
const ocrFiles = FULLTEXT_ENABLED ? walkFiles(join(data, 'ocr')) : [];
const manifest = {
  generatedAt: new Date().toISOString(),
  appVersion: pkg.version,
  schemaVersion: idx.schemaVersion,
  crawledAt: idx.crawledAt,
  index: {
    sha256: createHash('sha256').update(indexBytes).digest('hex'),
    fileCount: idx.stats?.fileCount ?? idx.files?.length ?? 0,
    bookCount: idx.stats?.bookCount ?? idx.books?.length ?? 0,
    totalSize: idx.stats?.totalSize ?? 0,
    ocrRefs: (idx.files ?? []).filter((f) => f.textRef).length,
  },
  // packed=false 表示这一版没有随包带全文数据（全文检索与索引在运行时被冻结）
  ocr: {
    packed: FULLTEXT_ENABLED,
    files: ocrFiles.length,
    bytes: ocrFiles.reduce((n, p) => n + statSync(p).size, 0),
  },
};
writeFileSync(join(data, 'data-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

renameSync(join(out, 'electron.exe'), join(out, '方志检索.exe'));

// 替换旧产物：只用 rename 让位，不整树删除。
// 便携版目录动辄几百个条目，整棵树 rm 会被环境的批量删除守卫当成批量删除拦下
// （本地打包就因此中断过），而且本机杀软/残留进程还常锁着上一版 electron.exe。
// 旧目录改名成 x.old-<时间戳> 交给人工清理，只有条目很少时才顺手删掉。
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
let finalOut = target;
let parked = null;
if (existsSync(target)) {
  const dest = `${target}.old-${stamp}`;
  try {
    renameSync(target, dest);
    parked = dest;
  } catch (e) {
    finalOut = `${target}-${stamp}`;
    console.warn(`注意：${target} 被占用，未能替换（${e.message.split('\n')[0]}）`);
    console.warn(`      本次产物在 ${finalOut}；关掉占用它的程序后下次会正常覆盖。`);
  }
}
renameSync(out, finalOut);
if (parked) console.log(`旧产物已改名 -> ${parked}（确认新版可用后自行删除，可省几百 MB）`);

const mb = (p) => (statSync(p).size / 1048576).toFixed(1);
console.log(`便携版 -> ${finalOut}${finalOut === target ? '' : '（旧目录未能替换）'}`);
console.log(`  version ${manifest.appVersion} · index ${manifest.index.sha256.slice(0, 12)}`);
console.log(`  方志检索.exe  ${mb(join(finalOut, '方志检索.exe'))} MB`);
console.log(`  resources/app ${mb(join(finalOut, 'resources', 'app', 'dist', 'main', 'index.cjs'))} MB (main bundle)`);
console.log(`  resources/data/index.full.json  ${mb(join(finalOut, 'resources', 'data', 'index.full.json'))} MB`);
console.log(`  OCR ${manifest.ocr.files} 文件 · 索引引用 ${manifest.index.ocrRefs} 个`);
