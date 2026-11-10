// 原型：验证「文件名 -> 归一化书名」的聚合质量
const { rows } = require('./index.json');
const files = rows.filter((r) => r.type === 'file');
const ROOT = '/全国各地地方志4000+本【101G】';

// 年号/朝代词表（归一化用，不靠括号）
const DYNASTY = [
  '顺治','康熙','雍正','乾隆','嘉庆','道光','咸丰','同治','光绪','宣统',
  '民国','崇祯','万历','正德','嘉靖','隆庆','天顺','成化','洪武','永乐',
  '大明','大清','宋','元','明','清','唐','隋','新','当代','1949年后',
];

function stripExt(n) { return n.replace(/\.(pdf|djvu|doc|docx|txt|rar|zip|uvz|exe)$/i, ''); }

// 去掉卷次/分册/序号标记，得到书名主干
function bookKey(raw) {
  let n = stripExt(raw).trim();
  n = n.replace(/part\s*\d+/gi, '');
  n = n.replace(/[\[［【(（〔]\s*(卷|第|册|上|下|全|一|二|三|四|五|六|七|八|九|十|续|补|附|正|内外)[^\]］】)）〕]*[\]］】)）〕]/g, '');
  n = n.replace(/[（(]\s*(全|上|下|上、下|全一册|全\d+册)[^）)]*[）)]/g, '');
  n = n.replace(/卷\s*[0-9〇一二三四五六七八九十百零兩]+\s*([-—~至到]\s*(卷\s*)?[0-9〇一二三四五六七八九十百零兩]+)?/g, '');
  n = n.replace(/第\s*[0-9〇一二三四五六七八九十百零兩]+\s*([-—~至到]\s*[0-9〇一二三四五六七八九十百零兩]+)?\s*[卷册]/g, '');
  n = n.replace(/^\s*[\[［【(（]\s*[^\]］】)）]{1,10}\s*[\]］】)）]\s*/, ''); // 前置朝代标记
  n = n.replace(/^[\s\-_－.、,，;；:：]+/, '');
  n = n.replace(new RegExp('^(' + DYNASTY.join('|') + ')\\s*'), '');
  n = n.replace(/[\s\-_－.、,，;；:：\[\]［］【】()（）〔〕《》]+$/, '');
  n = n.replace(/\s+/g, '');
  return n;
}

// 书名里含"志/图志/文献/史料"的核心部分
function zhiName(key) {
  const m = key.match(/^(.*?([\u4e00-\u9fa5]{1,3}(?:通志|府志|州志|县志|市志|省志|厅志|所志|乡志|镇志|村志|山志|寺志|书院志|图志|一统志|一統志|志|文献|史料|风土记|考略|辑要|目录|简介)))$/);
  return m ? m[2] : key;
}

const groups = new Map();
files.forEach((f) => {
  const k = bookKey(f.name);
  const z = zhiName(k);
  const key = z || k || '(empty)';
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(f);
});

const arr = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
console.log('文件数:', files.length);
console.log('聚合出的书名数:', arr.length);
console.log('单文件书(1个文件):', arr.filter(([, v]) => v.length === 1).length);
console.log('多卷书(>=2个文件):', arr.filter(([, v]) => v.length >= 2).length);
console.log('');
console.log('=== 最大的 20 个聚合（检查是否过度合并） ===');
arr.slice(0, 20).forEach(([k, v]) => {
  const provs = [...new Set(v.map((f) => f.path.replace(ROOT, '').split('/')[2]))];
  console.log(`  ${String(v.length).padStart(4)}  ${k.slice(0, 40).padEnd(42)} 省份:${provs.slice(0, 3).join('|')}`);
});
console.log('');
console.log('=== 空/超短 key（解析失败） ===');
const bad = arr.filter(([k]) => k.length <= 2);
console.log('  数量:', bad.length, '涉及文件:', bad.reduce((a, [, v]) => a + v.length, 0));
bad.slice(0, 15).forEach(([k, v]) => console.log(`    [${k}] <- ${v[0].name}`));
console.log('');
console.log('=== 抽样验证：多卷书聚合是否正确 ===');
['保定府志', '大明一統志', '吉水县志', '正定府志'].forEach((t) => {
  const g = arr.find(([k]) => k.includes(t));
  if (!g) return console.log(`  ${t}: 未找到`);
  console.log(`  ${t} -> 聚出 ${g[1].length} 个文件:`);
  g[1].slice(0, 4).forEach((f) => console.log('      ' + f.name));
});
