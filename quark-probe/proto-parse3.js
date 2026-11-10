// 原型 v3：括号分组解析。《》=书名包装(保留内容)，[]（）〔〕=元数据容器(提取后丢弃)
const { rows } = require('./index.json');
const files = rows.filter((r) => r.type === 'file');
const dirs = rows.filter((r) => r.type === 'dir');
const ROOT = '/全国各地地方志4000+本【101G】';

const ERA = ['顺治','康熙','雍正','乾隆','嘉庆','道光','咸丰','同治','光绪','宣统','民国',
  '崇祯','万历','天启','正德','嘉靖','隆庆','天顺','天順','成化','洪武','永乐','弘治','景泰','正统',
  '至正','开元','天宝','元和','熙宁','元丰','绍兴','淳熙','嘉定','宝祐','延祐','至元','大德','元贞',
  '清','明','元','宋','唐','隋'];
const ZHI = ['一统志','一統志','通志','府志','州志','县志','縣志','市志','省志','厅志','廳志','所志',
  '乡志','鄉志','镇志','鎮志','村志','山志','寺志','书院志','書院志','卫志','衛志','乡土志','鄉土志',
  '文化艺术志','民族志','军事志','方言志','水利志','宗教志','人物志','图志','圖志','风土志','风土记',
  '风俗志','物产志','选举志','艺文志','地理志','职官志','建置志','田赋志','学校志','祠祀志','备志',
  '杂志','文献','史料','考略','辑要','图说','圖說','联合目录','简介','点校','校注','乡土教材'];
const ZHI_RE = new RegExp('(' + ZHI.join('|') + ')$');
const PROVINCES = ['北京','天津','河北','山西','内蒙古','辽宁','吉林','黑龙江','上海','江苏','浙江','安徽',
  '福建','江西','山东','河南','湖北','湖南','广东','广西','海南','重庆','四川','贵州','云南','西藏',
  '陕西','甘肃','青海','宁夏','新疆','台湾','直隶','畿辅','奉天'];
// 省级前缀，地名里要剥掉以便拿到更具体的县级名
const PROV_PREFIX = new RegExp('^(' + PROVINCES.join('|') + ')(省|市)?');

const stripExt = (n) => n.replace(/\.(pdf|djvu|doc|docx|txt|rar|zip|uvz|exe)$/i, '');
const squeeze = (s) => s.replace(/[\s\u3000]+/g, '');
const trimPunct = (s) => s.replace(/^[\[［【(（〔《\]］】)）〕》、,，;；:：.\-_－]+/, '')
                          .replace(/[\[［【(（〔《\]］】)）〕》、,，;；:：.\-_－]+$/, '');

// 提取朝代：词表匹配，最靠前的优先；清/明/元/宋/唐 这类单字要防止误命中
function findEra(parts) {
  const LONG = ERA.filter((e) => e.length >= 2);
  const SHORT = ERA.filter((e) => e.length === 1);
  for (const p of parts) for (const e of LONG) if (p.includes(e)) return e;
  for (const p of parts) for (const e of SHORT) if (new RegExp('(^|[^\\u4e00-\\u9fa5])' + e + '($|[^\\u4e00-\\u9fa5]|代|朝)').test(p)) return e;
  return null;
}

// 提取卷次片段
const VOL_RE = /(卷\s*首|卷\s*末|卷\s*[0-9〇零一二三四五六七八九十百千兩两]+(?:\s*[-—~至到]\s*(?:卷\s*)?[0-9〇零一二三四五六七八九十百千兩两]+|\s*之?[上下])?|第\s*[0-9〇零一二三四五六七八九十百千兩两]+(?:\s*[-—~至到]\s*[0-9〇零一二三四五六七八九十百千兩两]+)?\s*[卷册冊]|[0-9〇零一二三四五六七八九十百千兩两]+\s*[-—~至到]\s*[0-9〇零一二三四五六七八九十百千兩两]+\s*[卷册冊]|全\s*[0-9〇零一二三四五六七八九十百千兩两]+\s*[册冊]|[上下]\s*[、,]?\s*下?\s*册?)/;

function parseName(rawName, parentDirName) {
  let s = stripExt(rawName);
  const frags = [];       // 括号内容碎片
  let titleParts = [];    // 书名主干片段

  // 《...》 视为书名包装：内容并入主干
  s = s.replace(/《([^》]*)》/g, (_, g) => ' ' + g + ' ');

  // 成对括号 [] （） () 〔〕 ［］ 【】 -> 抽出内容
  let prev;
  do {
    prev = s;
    s = s.replace(/[\[［【(（〔]([^\]］】)）〔]*)[\]］】)）〕]/g, (_, g) => { frags.push(g); return ' '; });
  } while (s !== prev);

  // 落单的括号字符（源数据里有不平衡括号）
  s = s.replace(/[\[［【(（〔\]］】)）〕]/g, ' ');

  titleParts = s.split(/\s+/).filter(Boolean);

  // 分册序号：主干尾部的 -01 / _2 / part1
  let part = null;
  if (titleParts.length) {
    const last = titleParts[titleParts.length - 1];
    const pm = last.match(/^(.*?)[\-－_]\d{1,3}$/) || last.match(/^(.*?)part\s*(\d+)$/i);
    if (pm && pm[1]) { titleParts[titleParts.length - 1] = pm[1]; part = last.slice(pm[1].length); }
  }

  const allParts = [...frags, ...titleParts, parentDirName || ''];
  const era = findEra(allParts) || findEra([parentDirName || '']);

  // 卷次：主干 + 碎片里所有命中
  const vols = [];
  [...titleParts, ...frags].forEach((p) => { const m = p.match(VOL_RE); if (m) vols.push(m[0]); });
  // 碎片里含"卷"的整块也算
  frags.forEach((f) => { if (/卷|册|冊/.test(f) && !vols.includes(f.trim())) vols.push(f.trim()); });

  // 书名主干 = 去掉卷次/朝代/纯序号后的最长片段
  let core = titleParts
    .map((p) => p.replace(VOL_RE, ' ').replace(new RegExp('^(' + ERA.join('|') + ')'), ''))
    .map((p) => trimPunct(p))
    .filter((p) => p && !/^\d{1,4}$/.test(p))
    .join('');
  core = squeeze(core);

  // 主干为空（如 1.pdf / 12-422.pdf）-> 继承父目录
  let inherited = false;
  if (!core) {
    inherited = true;
    let pd = squeeze(stripExt(parentDirName || ''));
    pd = pd.replace(VOL_RE, ' ');
    core = trimPunct(pd) || '(未命名)';
  }

  const zm = core.match(ZHI_RE);
  const zhiType = zm ? zm[1] : null;

  // 地名：志种前的部分，剥掉省级前缀
  let place = null;
  if (zhiType) {
    let head = trimPunct(core.slice(0, core.length - zhiType.length));
    head = head.replace(new RegExp('^(' + ERA.join('|') + ')'), '');
    head = head.replace(/^(新|旧|重修|重刻|增修|补|续|續|点校)/g, '');
    head = trimPunct(head);
    const withoutProv = head.replace(PROV_PREFIX, '');
    place = withoutProv || head || null;
  } else {
    const p = PROVINCES.find((x) => core.includes(x));
    place = p || (core.length <= 12 ? core : null);
  }

  return { title: core, zhiType, place, era, vols: [...new Set(vols)], part, inherited };
}

// ---------- 全量 ----------
const parsed = files.map((f) => {
  const segs = f.path.replace(ROOT, '').split('/').filter(Boolean);
  const parent = segs.length >= 2 ? segs[segs.length - 2] : '';
  return { f, parent, ...parseName(f.name, parent) };
});

// 聚合 key = 省份分组 + 朝代 + 书名主干（卷次已剥离，故同书不同卷会聚合）
const groups = new Map();
parsed.forEach((p) => {
  const prov = p.f.path.replace(ROOT, '').split('/')[2] || '(root)';
  const key = prov + '||' + (p.era || '') + '||' + p.title;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(p);
});
const arr = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
const n = files.length;
const stat = (f) => { const c = parsed.filter(f).length; return `${c} (${((c / n) * 100).toFixed(1)}%)`; };

console.log('文件数:', n);
console.log('聚合「书」数:', arr.length, '| 单文件:', arr.filter(([,v])=>v.length===1).length, '| 多卷:', arr.filter(([,v])=>v.length>=2).length);
console.log('志种识别:', stat((p) => p.zhiType));
console.log('朝代识别:', stat((p) => p.era));
console.log('地名识别:', stat((p) => p.place));
console.log('卷次识别:', stat((p) => p.vols.length > 0));
console.log('继承父目录:', stat((p) => p.inherited));

console.log('\n=== 最大聚合 15 ===');
arr.slice(0, 15).forEach(([k, v]) => {
  const [prov, era, title] = k.split('||');
  console.log(`  ${String(v.length).padStart(3)}  ${(prov||'').slice(0,14).padEnd(15)} ${(era||'-').padEnd(4)} ${title.slice(0,40)}`);
});

console.log('\n=== 回归：书名主干是否干净（不含括号残留） ===');
const dirty = arr.filter(([k]) => /[\[\]（）()〔〕《》]/.test(k.split('||')[2] || ''));
console.log('  仍含括号字符的书名组:', dirty.length);
dirty.slice(0, 8).forEach(([k]) => console.log('    ' + k.split('||')[2]));

console.log('\n=== 抽样验证 ===');
[['湖南通志','嘉庆版与光绪版应分开，同版不同卷应合并'],
 ['吉水县志','道光各卷段应合成一部'],
 ['保定府志','多卷合一'],
 ['镇坪县乡土志','地名保住'],
 ['方舆考证','嵌套方括号'],
 ['莆田县志','地名不应是"府莆田"']].forEach(([t, why]) => {
  console.log(`--- ${t} (${why}) ---`);
  const g = arr.filter(([k]) => (k.split('||')[2]||'').includes(t));
  if (!g.length) return console.log('    未找到');
  g.forEach(([k, v]) => {
    const [, era, title] = k.split('||'); const p = v[0];
    console.log(`    [${String(v.length).padStart(2)}文件] 书名=${title} 朝代=${era||'-'} 志种=${p.zhiType||'-'} 地名=${p.place||'-'}`);
    v.slice(0, 2).forEach((x) => console.log('         ' + x.f.name));
  });
});

console.log('\n=== 无志种锚点的书名 TOP 20（看漏了什么后缀） ===');
const noZhi = {};
parsed.filter((p) => !p.zhiType).forEach((p) => { noZhi[p.title] = (noZhi[p.title]||0)+1; });
Object.entries(noZhi).sort((a,b)=>b[1]-a[1]).slice(0,20).forEach(([k,v])=>console.log(`  ${String(v).padStart(3)}  ${k.slice(0,40)}`));
console.log('  无志种的不同书名总数:', Object.keys(noZhi).length);
