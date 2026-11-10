const core = require('../../vendor/core.js');

function fmtSize(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
}

Page({
  data: { book: null, files: [], shareUrl: '', notFound: false },

  onLoad(query) {
    const idx = require('../../index.mini.json');
    const d = core.getBook(idx, query.id);
    if (!d) {
      this.setData({ notFound: true });
      return;
    }
    this.setData({
      book: d.book,
      files: d.files.map((f) => ({ ...f, sizeText: fmtSize(f.size) })),
      shareUrl: idx.meta?.shareUrl ?? '',
    });
  },

  copyLink() {
    if (!this.data.shareUrl) return;
    wx.setClipboardData({
      data: this.data.shareUrl,
      success: () => wx.showToast({ title: '分享链接已复制', icon: 'none' }),
    });
  },

  copyName(e) {
    wx.setClipboardData({
      data: e.currentTarget.dataset.name,
      success: () => wx.showToast({ title: '文件名已复制', icon: 'none' }),
    });
  },
});
