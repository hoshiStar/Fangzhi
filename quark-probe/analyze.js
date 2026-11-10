const { rows } = require('./index.json');
const files = rows.filter((r) => r.type === 'file');
const dirs = rows.filter((r) => r.type === 'dir');
const ROOT = '/全国各地地方志4000+本【101G】';

const pct = (n) => ((n / files.length) * 100).toFixed(1) + '%';

console.log('====== 文件名模式覆盖率 ======');
const patterns = {
  '方括号朝代 [xx]': (n) => /^[\[［【]/.test(n),
  '圆括号卷次 （卷…）': (n) => /[（(]\s*卷/.test(n),
  '方头括号卷次 〔卷…〕': (n) => /〔\s*卷/.test(n),
  '含"志"字': (n) => n.includes('志'),
  '含分册序号 -NN 结尾': (n) => /[-－_]\d{1,3}\.(pdf|djvu|doc|PDF)$/i.test(n),
  '含书名号《》': (n) => /[《》]/.test(n),
  '含"第X卷"': (n) => /第\s*[0-9〇一二三四五六七八九十百零]+\s*[-—~至]?\s*[0-9〇一二三四五六七八九十百零]*\s*卷/.test(n),
  '纯中文名无标点': (n) => /^[\u4e00-\u9fa50-9\s]+\.(pdf|djvu|doc|PDF)$/i.test(n),
};
for (const [name, test] of Object.entries(patterns)) {
  const hit = files.filter((f) => test(f.name)).length;
  console.log(`  ${name.padEnd(26)} ${String(hit).padStart(5)} / ${files.length}  ${pct(hit)}`);
}

console.log('\n====== 朝代标记统计（方括号内） ======');
const dyn = {};
files.forEach((f) => {
  const m = f.name.match(/^[\[［【]\s*([^\]］】]{1,12})\s*[\]］】]/);
  if (m) dyn[m[1]] = (dyn[m[1]] || 0) + 1;
});
const dynSorted = Object.entries(dyn).sort((a, b) => b[1] - a[1]);
console.log('  distinct:', dynSorted.length);
dynSorted.slice(0, 25).forEach(([k, v]) => console.log(`    ${k.padEnd(14)} ${v}`));

console.log('\n====== 志种后缀统计（书名尾字） ======');
const kind = {};
files.forEach((f) => {
  const m = f.name.match(/([\u4e00-\u9fa5]{1,4}志|[\u4e00-\u9fa5]{1,3}图志|[\u4e00-\u9fa5]{1,3}文献|[\u4e00-\u9fa5]{1,3}史料)\s*[（(〔\[《]?\s*(卷|第|之)?/);
  if (m) kind[m[1]] = (kind[m[1]] || 0) + 1;
});
const kindSorted = Object.entries(kind).sort((a, b) => b[1] - a[1]);
console.log('  distinct:', kindSorted.length);
kindSorted.slice(0, 30).forEach(([k, v]) => console.log(`    ${k.padEnd(14)} ${v}`));

console.log('\n====== 随机样本（跨省份，每省 3 条） ======');
const byProv = {};
files.forEach((f) => {
  const p = f.path.replace(ROOT, '').split('/')[2] || '(root)';
  (byProv[p] = byProv[p] || []).push(f.name);
});
Object.entries(byProv).forEach(([p, names]) => {
  console.log(`--- ${p} (${names.length}) ---`);
  const step = Math.max(1, Math.floor(names.length / 3));
  [0, step, step * 2].forEach((i) => names[i] && console.log('   ' + names[i]));
});

console.log('\n====== 书籍级目录名著录样本（depth>=4 的 dir） ======');
dirs
  .filter((d) => d.depth >= 4 && d.name.length > 12)
  .slice(0, 14)
  .forEach((d) => console.log('  ' + d.name));

console.log('\n====== 噪声文件（非书籍内容） ======');
files
  .filter((f) => /新建 文本文档|\.txt$|\.exe$|\.rar$|\.uvz$|说明|目录|清单/i.test(f.name))
  .slice(0, 20)
  .forEach((f) => console.log('  ' + f.path.replace(ROOT, '') + '  [' + f.size + ']'));
const noise = files.filter((f) => /新建 文本文档|\.exe$/.test(f.name)).length;
console.log('  合计明显噪声:', noise);
