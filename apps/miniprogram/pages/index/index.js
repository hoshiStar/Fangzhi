const core = require('../../vendor/core.js');

const PAGE = 50;
let idx = null;
let timer = null;

function loadIdx() {
  if (!idx) idx = require('../../index.mini.json');
  return idx;
}

Page({
  data: {
    q: '',
    summary: '',
    books: [],
    provinces: [],
    eras: [],
    selProvinces: [],
    selEras: [],
    total: 0,
    hasMore: false,
    loading: false,
  },

  onLoad() {
    const i = loadIdx();
    const f = core.computeFacets(i);
    const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([v, c]) => ({ v, c }));
    this.setData({ provinces: top(f.province, 16), eras: top(f.era, 10) });
    this.run('', false);
  },

  onInput(e) {
    const q = e.detail.value;
    this.setData({ q });
    clearTimeout(timer);
    timer = setTimeout(() => this.run(q, false), 220);
  },

  onClear() {
    clearTimeout(timer);
    this.setData({ q: '' });
    this.run('', false);
  },

  toggleFacet(e) {
    const { kind, v } = e.currentTarget.dataset;
    const key = kind === 'province' ? 'selProvinces' : 'selEras';
    const arr = this.data[key].slice();
    const i = arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1); else arr.push(v);
    this.setData({ [key]: arr });
    this.run(this.data.q, false);
  },

  run(q, append) {
    if (this.data.loading) return;
    this.setData({ loading: true });
    const i = loadIdx();
    const offset = append ? this.data.books.length : 0;
    const r = core.search(i, q, {
      provinces: this.data.selProvinces,
      eras: this.data.selEras,
      zhiTypes: [],
      exts: [],
      limit: PAGE,
      offset,
    });
    const rows = r.items.map((h) => ({
      id: h.book.id,
      title: h.book.displayTitle || h.book.title,
      meta: [h.book.era, h.book.province, h.book.zhiType, h.book.fileCount + ' 册']
        .filter(Boolean).join(' · '),
      fuzzy: !h.direct,
    }));
    this.setData({
      books: append ? this.data.books.concat(rows) : rows,
      total: r.total,
      hasMore: offset + rows.length < (r.available ?? r.total),
      loading: false,
      summary: (q
        ? `${r.directTotal > 0 ? '直接命中' : '部分/近似命中'} ${r.directTotal || r.total} 部书 · ${r.elapsedMs}ms`
        : `共 ${r.total} 部书`)
        + (this.data.selProvinces.length || this.data.selEras.length ? ' · 已筛选' : ''),
    });
  },

  loadMore() {
    if (this.data.hasMore && !this.data.loading) this.run(this.data.q, true);
  },

  openDetail(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id });
  },
});
