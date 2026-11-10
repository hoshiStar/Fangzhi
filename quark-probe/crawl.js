const fs = require('fs');
const H = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Referer': 'https://pan.quark.cn/',
  'Origin': 'https://pan.quark.cn',
};
const B = 'https://drive-pc.quark.cn/1/clouddrive/share/sharepage';
const PWD_ID = '2d5c2ddfe25b';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let stoken = '';

async function getToken(passcode = '') {
  const r = await fetch(B + '/token?pr=ucpro&fr=pc', {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pwd_id: PWD_ID, passcode }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('token fail: ' + JSON.stringify(j));
  return j.data.stoken;
}

async function ls(fid, page, size = 100) {
  const u =
    B + '/detail?pr=ucpro&fr=pc&pwd_id=' + PWD_ID +
    '&stoken=' + encodeURIComponent(stoken) +
    '&pdir_fid=' + fid + '&force=0&_page=' + page +
    '&_size=' + size + '&_fetch_total=1&_sort=file_type:asc,file_name:asc';
  for (let attempt = 0; attempt < 4; attempt++) {
    const j = await (await fetch(u, { headers: H })).json();
    if (j.code === 0) return j;
    if (j.code === 41005 || /stoken/i.test(j.message || '')) {
      stoken = await getToken();
      continue;
    }
    await sleep(800 * (attempt + 1));
  }
  throw new Error('ls fail ' + fid + ' p' + page);
}

async function listAll(fid) {
  const out = [];
  let page = 1;
  while (true) {
    const j = await ls(fid, page);
    const list = j.data.list || [];
    out.push(...list);
    const total = j.metadata._total;
    if (out.length >= total || list.length === 0) break;
    page++;
    await sleep(120);
  }
  return out;
}

(async () => {
  stoken = await getToken();
  const rows = [];
  let reqCount = 0;
  let maxDepth = 0;

  async function walk(fid, path, depth) {
    maxDepth = Math.max(maxDepth, depth);
    const items = await listAll(fid);
    reqCount++;
    for (const f of items) {
      const p = path + '/' + f.file_name;
      if (f.dir) {
        rows.push({ type: 'dir', path: p, name: f.file_name, size: 0, fid: f.fid, depth });
        await sleep(100);
        await walk(f.fid, p, depth + 1);
      } else {
        rows.push({
          type: 'file', path: p, name: f.file_name, size: f.size,
          fid: f.fid, pdir_fid: fid, depth,
          ext: (f.file_name.match(/\.([^.]+)$/) || [])[1] || '',
          format: f.format_type || '', share_fid_token: f.share_fid_token || '',
        });
      }
    }
  }

  const root = await listAll('0');
  reqCount++;
  for (const f of root) {
    if (f.dir) {
      rows.push({ type: 'dir', path: '/' + f.file_name, name: f.file_name, size: 0, fid: f.fid, depth: 1 });
      await walk(f.fid, '/' + f.file_name, 2);
    } else {
      rows.push({ type: 'file', path: '/' + f.file_name, name: f.file_name, size: f.size, fid: f.fid, depth: 1 });
    }
  }

  fs.writeFileSync(__dirname + '/index.json', JSON.stringify({ rows, stat: { reqCount, maxDepth } }, null, 0));

  const files = rows.filter((r) => r.type === 'file');
  const dirs = rows.filter((r) => r.type === 'dir');
  console.log('requests:', reqCount, 'maxDepth:', maxDepth);
  console.log('dirs:', dirs.length, 'files:', files.length);
  console.log('total bytes:', files.reduce((a, b) => a + (b.size || 0), 0));
  const ext = {};
  files.forEach((f) => (ext[f.ext || '(none)'] = (ext[f.ext || '(none)'] || 0) + 1));
  console.log('ext:', JSON.stringify(ext));
  console.log('--- sample files ---');
  files.slice(0, 15).forEach((f) => console.log(f.path, f.size));
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
