// 一次性生成 packages/core/src/t2s.ts：把 opencc-js 的单字繁转简表固化成源码，
// 让 core 和小程序运行时都不依赖 opencc。改表就重跑本脚本。
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Converter } = require('opencc-js');
const t2s = Converter({ from: 'tw', to: 'cn' });

const from = [];
const to = [];
for (let c = 0x4e00; c <= 0x9fff; c++) {
  const s = String.fromCodePoint(c);
  const o = t2s(s);
  if (o === s || [...o].length !== 1) continue;
  from.push(s);
  to.push(o);
}

// 两两成对压成一条串，按码点切块。不能拆成「繁体串 + 简体串」两张等长表：
// opencc 有少量输出落在扩展区（UTF-16 双子），按码元对齐会整体错位。
const pairs = [...from.map((f, i) => f + to[i]).join('')];
const lines = [];
for (let i = 0; i < pairs.length; i += 60) lines.push(`  '${pairs.slice(i, i + 60).join('')}'`);
const table = lines.join(' +\n');

const file = `/**
 * 繁体 → 简体单字映射（${from.length} 对）。
 *
 * 用途只有一个：让检索把「用户输入的繁体」和「索引里的简体」对齐。古籍研究者的引用
 * 常是繁体，直接按原样比对会整条搜不到，而这里不能引入 opencc——core 同时被小程序
 * 打包，词典体积扛不住，所以固化成「繁简繁简…」两两相邻的一条串（见 gen-t2s.mjs）。
 *
 * 只做单字一一映射，不做词组转换（「乾隆」这类专名反而不能动）。
 */
const PAIRS =
${table};

const MAP = new Map<string, string>();
const LIST = [...PAIRS];
for (let i = 0; i + 1 < LIST.length; i += 2) MAP.set(LIST[i]!, LIST[i + 1]!);

const cache = new Map<string, string>();

/** 逐字转简；非繁体的字符原样保留，因此对简体输入是幂等的。 */
export function toSimp(s: string): string {
  if (!s) return s;
  const hit = cache.get(s);
  if (hit !== undefined) return hit;
  let out = '';
  for (const ch of s) out += MAP.get(ch) ?? ch;
  // 书目字段和查询词的重复率极高，缓存一手省掉大量逐字查找
  if (cache.size < 20000) cache.set(s, out);
  return out;
}
`;

writeFileSync(new URL('../packages/core/src/t2s.ts', import.meta.url), file);
console.log(`wrote ${from.length} pairs`);
