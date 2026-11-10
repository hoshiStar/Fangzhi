// 小程序包装配：core 打成单个 CJS 供 require，索引裁掉只有下载才用的字段。
// 主包上限 2048KB，这里每次构建都报体积，超了立刻知道。
import { build } from 'esbuild';
import { readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');

mkdirSync(join(here, 'vendor'), { recursive: true });
// 仓库根是 type:module，Node 冒烟测试要靠这个把 vendor 认成 CJS；微信端无视它
writeFileSync(join(here, 'vendor', 'package.json'), JSON.stringify({ type: 'commonjs' }) + '\n');
await build({
  entryPoints: [join(repo, 'packages', 'core', 'src', 'index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  target: 'es2018',
  minify: true,
  outfile: join(here, 'vendor', 'core.js'),
});

const lean = JSON.parse(readFileSync(join(repo, 'data', 'index.lean.json'), 'utf8'));
const mini = {
  schemaVersion: lean.schemaVersion,
  meta: lean.meta,
  crawledAt: lean.crawledAt,
  stats: lean.stats,
  books: lean.books,
  // fid / ocrStatus 只服务于下载和 OCR，检索和展示都用不到，裁掉省约 300KB。
  // id 必须留：getBook 靠它把文件挂回书目。
  files: lean.files.map((f) => ({
    id: f.id, name: f.name, size: f.size, ext: f.ext, bookId: f.bookId,
    volume: f.volume, part: f.part, section: f.section,
  })),
};
writeFileSync(join(here, 'index.mini.json'), JSON.stringify(mini));

const kb = (p) => `${(statSync(p).size / 1024).toFixed(0)} KB`;
console.log(`vendor/core.js   ${kb(join(here, 'vendor', 'core.js'))}`);
console.log(`index.mini.json  ${kb(join(here, 'index.mini.json'))}  (主包上限 2048 KB)`);
