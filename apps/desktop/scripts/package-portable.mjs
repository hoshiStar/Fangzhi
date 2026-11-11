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

const data = join(out, 'resources', 'data');
mkdirSync(data, { recursive: true });
cpSync(src, join(data, 'index.full.json'));
const meta = join(repo, 'data', 'meta.json');
if (existsSync(meta)) cpSync(meta, join(data, 'meta.json'));
// OCR 文本目录（tools/ocr/ocr.py 的产出），没有就不拷，阅读器会自己降级成只读 PDF
const ocrDir = join(repo, 'data', 'ocr');
if (existsSync(ocrDir)) cpSync(ocrDir, join(data, 'ocr'), { recursive: true });

// 识别脚本随包发：桌面端「全文识别」要能直接拉起子进程。
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
const missingOcr = (idx.files ?? [])
  .filter((f) => f.textRef && !existsSync(join(data, String(f.textRef))))
  .map((f) => f.textRef);
if (missingOcr.length) {
  console.error(`发布中止：索引引用了 ${missingOcr.length} 个缺失的 OCR 文件，例如 ${missingOcr[0]}`);
  process.exit(1);
}
const ocrFiles = walkFiles(join(data, 'ocr'));
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
  ocr: {
    files: ocrFiles.length,
    bytes: ocrFiles.reduce((n, p) => n + statSync(p).size, 0),
  },
};
writeFileSync(join(data, 'data-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

renameSync(join(out, 'electron.exe'), join(out, '方志检索.exe'));

// 替换旧产物。旧目录被占用时退让：留一份带时间戳的产物并明确告知，
// 而不是把已经装配好的几百 MB 白扔。
let finalOut = target;
let replaced = true;
try {
  rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  renameSync(out, target);
} catch (e) {
  replaced = false;
  finalOut = `${target}-${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}`;
  renameSync(out, finalOut);
  console.warn(`注意：${target} 被占用，未能替换（${e.message.split('\n')[0]}）`);
  console.warn(`      本次产物在 ${finalOut}；关掉占用它的程序后下次会正常覆盖。`);
}

const mb = (p) => (statSync(p).size / 1048576).toFixed(1);
console.log(`便携版 -> ${finalOut}${replaced ? '' : '（旧目录未能替换）'}`);
console.log(`  version ${manifest.appVersion} · index ${manifest.index.sha256.slice(0, 12)}`);
console.log(`  方志检索.exe  ${mb(join(finalOut, '方志检索.exe'))} MB`);
console.log(`  resources/app ${mb(join(finalOut, 'resources', 'app', 'dist', 'main', 'index.cjs'))} MB (main bundle)`);
console.log(`  resources/data/index.full.json  ${mb(join(finalOut, 'resources', 'data', 'index.full.json'))} MB`);
console.log(`  OCR ${manifest.ocr.files} 文件 · 索引引用 ${manifest.index.ocrRefs} 个`);
