import { build } from 'esbuild';
import { cpSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// 默认不清空 dist：esbuild 的输出文件名是固定的，覆盖写就够了。
// 整目录 rm 有两个坏处——每次构建白删 200 多个文件（本机杀软逐个扫描很慢），
// 而且删除量一大就会被环境的批量删除守卫当成批量删除拦下，本地打包因此中断过。
// 确实要从零重建时加 --clean。
if (process.argv.includes('--clean')) {
  rmSync('dist', { recursive: true, force: true });
  console.log('已清空 dist/');
}

const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  external: ['electron'],
};

// 主进程与 preload 打成 CJS：Electron 对 ESM 主进程的支持仍然要求 package.json
// 带 type:module，而这个包同时要给 renderer 提供 .js，统一用 .cjs 后缀最省事。
await build({
  ...shared,
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist/main/index.cjs',
  platform: 'node',
  format: 'cjs',
  target: 'node22',
});

await build({
  ...shared,
  entryPoints: ['src/preload/index.ts'],
  outfile: 'dist/preload/index.cjs',
  platform: 'node',
  format: 'cjs',
  target: 'node22',
});

// 全库全文检索的 worker 线程：作为独立文件随主进程一起发（main/fulltext.ts 按路径起线程）。
// 必须和主进程同目录，打包脚本整目录拷 dist，不用单独处理。
await build({
  ...shared,
  entryPoints: ['src/main/fulltext-worker.ts'],
  outfile: 'dist/main/fulltext-worker.cjs',
  platform: 'node',
  format: 'cjs',
  target: 'node22',
});

// 倒排索引构建线程：同上，按路径起线程，整目录拷贝时自动带上。
await build({
  ...shared,
  entryPoints: ['src/main/text-index-worker.ts'],
  outfile: 'dist/main/text-index-worker.cjs',
  platform: 'node',
  format: 'cjs',
  target: 'node22',
});

await build({
  entryPoints: ['src/renderer/app.ts'],
  outfile: 'dist/renderer/app.js',
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  format: 'iife',
  platform: 'browser',
  target: 'chrome130',
  // pdfjs-dist 的可选 node 依赖，浏览器构建里必须排除
  external: ['canvas', '@napi-rs/canvas'],
});

cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('src/renderer/style.css', 'dist/renderer/style.css');

// PDF.js 的 worker 与编解码资源必须作为独立文件随 renderer 一起发布。
// 路径用 createRequire 解析，npm workspaces 会把 pdfjs-dist 提升到根 node_modules。
const pdfjsRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
cpSync(join(pdfjsRoot, 'build/pdf.worker.min.mjs'), 'dist/renderer/pdf.worker.min.mjs');
for (const dir of ['wasm', 'iccs', 'cmaps', 'standard_fonts']) {
  cpSync(join(pdfjsRoot, dir), join('dist/renderer', dir), { recursive: true });
}
console.log('构建完成 -> dist/');
