import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { buildIndex, toLean } from './packages/core/src/build-index.ts';
import type { GazetteerIndex, RawShareDump } from './packages/core/src/types.ts';

// 本脚本会覆盖 data/index.full.json 和 index.lean.json，必须显式确认。
if (!process.argv.includes('--write')) {
  console.error('拒绝执行：该脚本会覆盖索引。确认后运行 node verify-index.ts --write');
  process.exit(1);
}

const dump = JSON.parse(readFileSync('./quark-probe/index.json', 'utf8')) as RawShareDump;

const previous = existsSync('./data/index.full.json')
  ? (JSON.parse(readFileSync('./data/index.full.json', 'utf8')) as GazetteerIndex)
  : undefined;

const t0 = Date.now();
const idx = buildIndex(dump, {
  meta: {
    pwdId: '2d5c2ddfe25b',
    shareUrl: 'https://pan.quark.cn/s/2d5c2ddfe25b',
    shareTitle: '全国各地地方志4000+本【101G】',
    author: '百刻*长',
  },
  previous,
});
const ms = Date.now() - t0;

const lean = toLean(idx);
writeFileSync('./data/index.full.json', JSON.stringify(idx));
writeFileSync('./data/index.lean.json', JSON.stringify(lean));

const s = idx.stats;
const GB = (n: number) => (n / 1073741824).toFixed(1);
const pc = (a: number, b: number) => ((a / b) * 100).toFixed(1) + '%';

console.log(`构建耗时 ${ms}ms`);
console.log(`文件 ${s.fileCount} | 书 ${s.bookCount} | 总体积 ${GB(s.totalSize)}GB`);
console.log('\n--- 解析覆盖率（按书） ---');
console.log(`  志种  ${s.parseCoverage.zhiType}/${s.bookCount}  ${pc(s.parseCoverage.zhiType, s.bookCount)}`);
console.log(`  朝代  ${s.parseCoverage.era}/${s.bookCount}  ${pc(s.parseCoverage.era, s.bookCount)}`);
console.log(`  地名  ${s.parseCoverage.place}/${s.bookCount}  ${pc(s.parseCoverage.place, s.bookCount)}`);
console.log(`  卷次  ${s.parseCoverage.volume}/${s.fileCount}  ${pc(s.parseCoverage.volume, s.fileCount)} (按文件)`);
console.log(`  继承  ${s.parseCoverage.inherited}/${s.fileCount}  ${pc(s.parseCoverage.inherited, s.fileCount)} (按文件)`);
console.log(`  噪声  ${s.parseCoverage.noise}/${s.fileCount}`);

console.log('\n--- 产物体积 ---');
const mb = (p: string) => (readFileSync(p).length / 1048576).toFixed(2) + 'MB';
console.log(`  data/index.full.json  ${mb('./data/index.full.json')}`);
console.log(`  data/index.lean.json  ${mb('./data/index.lean.json')}`);

console.log('\n--- 大类分布 ---');
Object.entries(s.byCategory).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
console.log('\n--- 省区分布 ---');
Object.entries(s.byProvince).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(14)} ${v}`));
console.log('\n--- 朝代分布 ---');
Object.entries(s.byEra).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(6)} ${v}`));

console.log('\n=== 回归检查 ===');
const badTitles = idx.books.filter((b) => /[\[\]（）()〔〕《》]/.test(b.title));
console.log(`  书名含括号残留: ${badTitles.length} ${badTitles.length ? '<<<' : 'OK'}`);
badTitles.slice(0, 5).forEach((b) => console.log('    ' + b.title.slice(0, 60)));
const stripped = idx.books.filter((b) => /^(县|府|省|市)?(乡土志|自治县志|人物志)$/.test(b.title));
console.log(`  地名被剥空的书: ${stripped.length} ${stripped.length ? '<<<' : 'OK'}`);
const lowConf = idx.books.filter((b) => b.confidence < 0.4);
console.log(`  低置信度(<0.4): ${lowConf.length} / ${idx.books.length}`);
lowConf.slice(0, 8).forEach((b) => console.log(`    ${b.confidence} ${b.title.slice(0, 40)} | ${b.fileIds.length}文件`));

console.log('\n=== 边界用例验证 ===');
const check = (label: string, bookTitle: string) => {
  const g = idx.books.filter((b) => b.title.includes(bookTitle));
  console.log(`--- ${label} ---`);
  if (!g.length) return console.log('    未找到');
  g.slice(0, 4).forEach((b) => {
    console.log(`    [${b.fileCount}文件 ${b.confidence}] 「${b.title}」 朝代=${b.era ?? '-'} 志种=${b.zhiType ?? '-'} 地名=${b.place ?? '-'} 省=${b.province ?? '-'}`);
    if (b.author) console.log(`         作者=${b.author} 版本=${b.edition ?? '-'}`);
  });
};
check('方舆考证（书名在方括号内）', '方舆考证');
check('莆田县志（主志+分志拆分）', '莆田县志');
check('湖南通志（嘉庆/光绪应分开）', '湖南通志');
check('保定府志（父目录著录串）', '保定府志');
check('大清一统志（纯数字文件名继承）', '大清一统志');
check('正定府志（rar 分卷应归组）', '正定府志');

console.log('\n=== 分志拆分结果 ===');
idx.books.filter((b) => b.fileIds.length).forEach(() => {});
const withSection = idx.files.filter((f) => f.section);
console.log(`  带分志的文件: ${withSection.length}`);
[...new Set(withSection.map((f) => f.section))].slice(0, 15).forEach((s2) => console.log('    ' + s2));

console.log('\n=== 噪声与压缩分卷 ===');
console.log(`  噪声文件: ${idx.files.filter((f) => f.isNoise).length}`);
idx.files.filter((f) => f.isNoise).slice(0, 6).forEach((f) => console.log('    ' + f.name));
console.log(`  压缩分卷: ${idx.files.filter((f) => f.isArchivePart).length}`);
idx.files.filter((f) => f.isArchivePart).slice(0, 6).forEach((f) => console.log(`    ${f.name} -> group=${f.archiveGroup}`));

// 已知回归项必须为零，否则让脚本以失败状态退出。
if (badTitles.length || stripped.length) {
  console.error(`\nREGRESSION: ${badTitles.length} 个括号残留, ${stripped.length} 个地名被剥空`);
  process.exitCode = 1;
}
