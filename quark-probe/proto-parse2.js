// 原型 v2：锚点法。以「志种后缀」为锚，向前取地名，绝不剥离书名主体。
const { rows } = require('./index.json');
const files = rows.filter((r) => r.type === 'file');
const dirs = rows.filter((r) => r.type === 'dir');
const ROOT = '/全国各地地方志4000+本【101G】';

// ---- 词表 ----
const ERA = [
  '顺治','康熙','雍正','乾隆','嘉庆','道光','咸丰','同治','光绪','宣统','民国',
  '崇祯','万历','天启','正德','嘉靖','隆庆','天顺','成化','洪武','永乐','弘治',
  '景泰','正统','天順','至正','开元','天宝','元和','熙宁','元丰','绍兴','淳熙',
  '嘉定','宝祐','元至元','元贞','大德','延祐','至元','唐','宋','元','明','清',
];
// 志种后缀，长的在前（最长匹配优先）
const ZHI = [
  '一统志','一統志','通志','府志','州志','县志','縣志','市志','省志','厅志','廳志',
  '所志','乡志','鄉志','镇志','鎮志','村志','山志','寺志','书院志','書院志','卫志','衛志',
  '乡土志','鄉土志','文化艺术志','民族志','军事志','方言志','水利志','宗教志','人物志',
  '图志','圖志','风土志','风土记','风俗志','物产志','选举志','艺文志','地理志','职官志',
  '建置志','田赋志','学校志','祠祀志','选举考','备志','杂志','杂志',
  '文献','史料','考略','辑要','图说','圖說','总目','联合目录','简介','点校','校注',
];
const ZHI_RE = new RegExp('(' + ZHI.join('|') + ')$');

const PROVINCES = [
  '北京','天津','河北','山西','内蒙古','辽宁','吉林','黑龙江','上海','江苏','浙江','安徽',
  '福建','江西','山东','河南','湖北','湖南','广东','广西','海南','重庆','四川','贵州',
  '云南','西藏','陕西','甘肃','青海','宁夏','新疆','台湾','直隶','畿辅','奉天',
];

function stripExt(n) { return n.replace(/\.(pdf|djvu|doc|docx|txt|rar|zip|uvz|exe)$/i, ''); }
const norm = (s) => s.replace(/[\s\u3000]+/g, '');

// 从任意字符串里提取朝代/年号（词表匹配，不依赖括号）
function extractEra(s) {
  const found = ERA.filter((e) => s.includes(e));
  if (!found.length) return null;
  // 优先返回出现在最前面的
  found.sort((a, b) => s.indexOf(a) - s.indexOf(b));
  return found[0];
}

// 提取卷次/分册信息（从文件名里，剥出来但不丢）
function extractVolume(s) {
  const hits = [];
  const pats = [
    /卷\s*[0-9〇零一二三四五六七八九十百千兩两]+\s*(?:[-—~至到]\s*(?:卷\s*)?[0-9〇零一二三四五六七八九十百千兩两]+)?(?:\s*之?[上下])?/g,
    /第\s*[0-9〇零一二三四五六七八九十百千兩两]+\s*(?:[-—~至到]\s*[0-9〇零一二三四五六七八九十百千兩两]+)?\s*[卷册冊]/g,
    /[（(]\s*(?:全)?\s*[0-9〇零一二三四五六七八九十百千兩两]+\s*[册冊]\s*[）)]/g,
    /[（(]\s*[上下](?:\s*、\s*下)?\s*册?\s*[）)]/g,
    /[（(〔]\s*[一二三四五六七八九十]+\s*[）)〕]/g,
    /part\s*\d+/gi,
  ];
  let t = s;
  pats.forEach((p) => { t = t.replace(p, (m) => { hits.push(m.trim()); return '\u0000'; }); });
  return { rest: t, vols: hits };
}

// 核心：锚点法定书名
function parseName(rawName, parentDirName) {
  let base = norm(stripExt(rawName));
  const { rest, vols } = extractVolume(base);
  // 去掉分册序号尾巴 (-01, _2, .3)
  let core = rest.replace(/[\-－_－.]+\d{1,3}$/, '').replace(/\u0000/g, '');
  core = core.replace(/^[\[［【(（]/, '').replace(/[\]］】)）]$/, '');
  core = core.replace(/^[、,，;；:：.\-_－\s]+|[\[［【(（]\u0000[\]］】)）]/g, '');
  core = norm(core.replace(/\u0000/g, ''));

  const era = extractEra(rawName) || extractEra(parentDirName || '');

  // 锚点：从 core 尾部找志种后缀
  let title = core, zhiType = null, place = null;
  const m = core.match(ZHI_RE);
  if (m) {
    zhiType = m[1];
    // 向前取地名：去掉朝代前缀、去掉志种后缀
    let head = core.slice(0, core.length - zhiType.length);
    head = head.replace(new RegExp('^(' + ERA.join('|') + ')'), '');
    head = head.replace(/^[\[［【(（\]］】)）、,，.\-_－\s]+/, '');
    head = head.replace(/^(?:新|旧|重修|重刻|增修|补|续|道光|民国)/, (x) => (/^(新|旧|重修|重刻|增修|补|续)$/.test(x) ? '' : x));
    place = PROVINCES.find((p) => head.includes(p)) || (head.length >= 1 && head.length <= 12 ? head : null);
    title = core; // 书名 = 完整 core，不做剥离
  } else {
    // 无志种锚点：整名当书名；若为纯数字/空则继承父目录
    if (/^\d{1,4}$/.test(core) || core.length === 0) {
      title = norm(stripExt(parentDirName || '')) || '(未命名)';
      zhiType = (title.match(ZHI_RE) || [])[1] || null;
      place = PROVINCES.find((p) => title.includes(p)) || null;
      return { title, zhiType, place, era, vols, inherited: true, core };
    }
    title = core;
    place = PROVINCES.find((p) => core.includes(p)) || null;
  }
  return { title, zhiType, place, era, vols, inherited: false, core };
}

// ---- 跑全量 ----
const dirNameByFid = new Map(dirs.map((d) => [d.fid, d.name]));
const parsed = files.map((f) => {
  const segs = f.path.replace(ROOT, '').split('/').filter(Boolean);
  const parent = segs.length >= 2 ? segs[segs.length - 2] : '';
  return { f, ...parseName(f.name, parent) };
});

// 聚合：同省份分组 + 同书名
const groups = new Map();
parsed.forEach((p) => {
  const prov = p.f.path.replace(ROOT, '').split('/')[2] || '(root)';
  const key = prov + '||' + p.title;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(p);
});
const arr = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

console.log('文件数:', files.length);
console.log('聚合出「书」数:', arr.length);
console.log('  单文件:', arr.filter(([, v]) => v.length === 1).length);
console.log('  多卷(>=2):', arr.filter(([, v]) => v.length >= 2).length);
console.log('继承父目录的文件:', parsed.filter((p) => p.inherited).length);
console.log('识别出志种:', parsed.filter((p) => p.zhiType).length, `(${((parsed.filter((p) => p.zhiType).length / files.length) * 100).toFixed(1)}%)`);
console.log('识别出朝代:', parsed.filter((p) => p.era).length, `(${((parsed.filter((p) => p.era).length / files.length) * 100).toFixed(1)}%)`);
console.log('识别出地名/省份:', parsed.filter((p) => p.place).length, `(${((parsed.filter((p) => p.place).length / files.length) * 100).toFixed(1)}%)`);

console.log('\n=== 最大聚合 20（检查过度合并 / 地名是否保住） ===');
arr.slice(0, 20).forEach(([k, v]) => {
  const [prov, title] = k.split('||');
  console.log(`  ${String(v.length).padStart(4)}  ${prov.padEnd(12)} ${title.slice(0, 44)}`);
});

console.log('\n=== 关键回归检查：不该再出现被剥空的 key ===');
['县乡土志', '族自治县志', '府莆田县志', '志人物志'].forEach((bad) => {
  const hit = arr.filter(([k]) => k.endsWith('||' + bad));
  console.log(`  "${bad}" 作为独立书名: ${hit.length} 组 ${hit.length ? '<<< 仍有问题' : 'OK 已消除'}`);
});

console.log('\n=== 抽样验证 ===');
[
  ['湖南通志', '分册 -01/-02 应聚成一本'],
  ['保定府志', '多卷'],
  ['镇坪县乡土志', '地名应保住'],
  ['阿坝藏族羌族自治州文化艺术志', '长地名应完整'],
  ['吉水县志', '朝代+卷次'],
].forEach(([t, why]) => {
  const g = arr.filter(([k]) => k.includes(t));
  console.log(`--- ${t}  (${why}) ---`);
  if (!g.length) return console.log('    未找到');
  g.forEach(([k, v]) => {
    const p = v[0];
    console.log(`    [${v.length}个文件] 书名=${p.title} 志种=${p.zhiType} 地名=${p.place} 朝代=${p.era}`);
    v.slice(0, 3).forEach((x) => console.log('        ' + x.f.name));
  });
});

console.log('\n=== 解析质量最差的样本（title 过短或等于纯数字） ===');
parsed.filter((p) => p.title.length <= 3 && !p.inherited).slice(0, 20)
  .forEach((p) => console.log(`  "${p.title}" <- ${p.f.name}  | 父目录: ${p.f.path.replace(ROOT,'').split('/')[3] || ''}`.slice(0, 150)));
