export * from './types.ts';
export * from './lexicon.ts';
export * from './parse.ts';
export * from './build-index.ts';
export * from './search.ts';

// crawl.ts 故意不在这里导出：它依赖 Node 的 fetch 直连 drive-pc.quark.cn，
// 小程序端拿不到这个域名的白名单，只能通过内嵌的 lean 索引离线检索。
// 桌面端和 CLI 直接从 './crawl.ts' 引入。
