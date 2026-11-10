// 小程序逻辑冒烟：用 Node 按页面同样的方式 require 打包产物和裁剪索引。
// 真机渲染归微信开发者工具管，这里只保证 core 打包后行为与桌面端一致。
const assert = require('node:assert');
const { statSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const core = require('./vendor/core.js');
const idx = require('./index.mini.json');

const r1 = core.search(idx, '吉水县志', { provinces: [], eras: [], zhiTypes: [], exts: [], limit: 50, offset: 0 });
assert.strictEqual(r1.items[0].book.title, '吉水县志', '吉水县志首条');
console.log(`吉水县志 -> ${r1.total} 部, ${r1.elapsedMs}ms`);

const r2 = core.search(idx, '保定府志', { provinces: [], eras: [], zhiTypes: [], exts: [], limit: 50, offset: 0 });
assert.strictEqual(r2.items[0].book.title, '保定府志', '保定府志首条');
const d = core.getBook(idx, r2.items[0].book.id);
assert.strictEqual(d.files.length, 31, '保定府志文件数');
assert.ok(d.files.every((f) => typeof f.name === 'string' && f.fid === undefined), '裁剪索引不含 fid');
console.log(`保定府志 -> ${d.files.length} 册, 著录 ${d.book.author}`);

const f = core.computeFacets(idx);
assert.ok(Object.keys(f.province).length >= 10, '省区分面');
console.log(`分面: 省区 ${Object.keys(f.province).length}, 朝代 ${Object.keys(f.era).length}`);

const r3 = core.search(idx, '光绪 湖南通志', { provinces: [], eras: [], zhiTypes: [], exts: [], limit: 50, offset: 0 });
assert.strictEqual(r3.items[0].book.title, '湖南通志', '多词 AND');
console.log(`多词 "光绪 湖南通志" -> 首条 ${r3.items[0].book.title}`);

// 主包体积：微信上限 2048KB，统计除 project.config 外全部文件
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
const total = walk(__dirname).filter((p) => !p.endsWith('smoke.cjs') && !p.includes('project.config'))
  .reduce((a, p) => a + statSync(p).size, 0);
console.log(`主包合计 ${(total / 1024).toFixed(0)} KB / 2048 KB`);
assert.ok(total < 2048 * 1024, '主包超 2MB');

console.log('小程序冒烟通过');
