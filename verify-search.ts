import { readFileSync } from 'node:fs';
import { search, getBook, computeFacets, facetOptions, formatSize } from './packages/core/src/search.ts';
import type { GazetteerIndex } from './packages/core/src/types.ts';

const idx = JSON.parse(readFileSync('./data/index.full.json', 'utf8')) as GazetteerIndex;

const show = (label: string, q: string, filters: Parameters<typeof search>[2] = {}) => {
  const r = search(idx, q, { limit: 6, ...filters });
  console.log(`\n── ${label}  query="${q}"${Object.keys(filters).length ? '  ' + JSON.stringify(filters) : ''}`);
  console.log(`   ${r.total} 部书命中, ${r.elapsedMs}ms`);
  r.items.forEach((h) => {
    const b = h.book;
    console.log(`   ${String(Math.round(h.score)).padStart(5)}  「${b.title}」 ${b.era ?? ''} | ${b.province} | ${b.place ?? '-'} | ${b.zhiType ?? '-'} | ${b.fileCount}文件 ${formatSize(b.totalSize)} | ${h.matched.join('+')}${h.direct ? '' : '  [模糊]'}`);
    h.files.slice(0, 2).forEach((f) => console.log(`            └ [${f.field}] ${f.file.name}`));
  });
};

console.log('=== 全库分面 ===');
const f = computeFacets(idx);
console.log('  省区:', facetOptions(f.province).slice(0, 5).map((x) => `${x.value}(${x.count})`).join(' '));
console.log('  朝代:', facetOptions(f.era).slice(0, 8).map((x) => `${x.value}(${x.count})`).join(' '));
console.log('  志种:', facetOptions(f.zhiType).slice(0, 8).map((x) => `${x.value}(${x.count})`).join(' '));

show('精确书名', '吉水县志');
show('地名', '莆田');
show('地名+志种', '保定府志');
show('朝代筛选', '湖南通志', { eras: ['光绪'] });
show('省区筛选', '县志', { provinces: ['江西省'] });
show('分志检索', '人物志');
show('卷次检索', '卷首');
show('著录字段', '李振祜');
show('模糊/错字容错', '嘉定为');
show('多词AND', '光绪 湖南通志');
show('多词AND', '保定 府志');
show('多词部分命中', '康熙 莆田 人物');
show('大类筛选', '一统志', { categories: ['一统志、图志、方舆考证'] });
show('格式筛选', '贵阳府志', { exts: ['djvu'] });
show('无结果', '量子力学导论');
show('空查询=浏览', '');

console.log('\n=== 性能：全量无筛选 ===');
for (const n of [1, 10, 100]) {
  const t = Date.now();
  for (let i = 0; i < n; i++) search(idx, '县志', { limit: 50 });
  console.log(`  ${n} 次检索耗时 ${Date.now() - t}ms  (平均 ${((Date.now() - t) / n).toFixed(1)}ms)`);
}

console.log('\n=== getBook 详情 ===');
const b = idx.books.find((x) => x.title === '保定府志');
if (b) {
  const d = getBook(idx, b.id);
  console.log(`  「${d.book.title}」 ${d.book.era} ${d.book.author ?? ''} ${d.book.edition ?? ''}`);
  console.log(`  ${d.files.length} 个文件:`);
  d.files.slice(0, 5).forEach((x) => console.log(`    ${x.name}  ${formatSize(x.size)}`));
}
