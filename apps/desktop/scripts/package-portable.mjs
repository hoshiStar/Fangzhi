// 手工装配便携版。electron-builder 的 asar 打包步骤在本机被 EBUSY 锁死，
// 而 Electron 本身只认 resources/app（或 app.asar），直接拼目录效果等价。
// 用法: node scripts/package-portable.mjs [输出目录]
import { cpSync, mkdirSync, renameSync, rmSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = dirname(here);
const repo = resolve(desktop, '..', '..');
const out = process.argv[2] ? resolve(process.argv[2]) : join(repo, 'release', 'portable-win-x64');

const src = join(repo, 'data', 'index.full.json');
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
  version: '0.1.0',
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

renameSync(join(out, 'electron.exe'), join(out, '方志检索.exe'));

const mb = (p) => (statSync(p).size / 1048576).toFixed(1);
console.log(`便携版 -> ${out}`);
console.log(`  方志检索.exe  ${mb(join(out, '方志检索.exe'))} MB`);
console.log(`  resources/app ${mb(join(app, 'dist', 'main', 'index.cjs'))} MB (main bundle)`);
console.log(`  resources/data/index.full.json  ${mb(join(data, 'index.full.json'))} MB`);
