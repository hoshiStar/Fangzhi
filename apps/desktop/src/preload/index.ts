import { contextBridge, ipcRenderer } from 'electron';
import type { SearchFilters } from '@fangzhi/core';

/** 渲染进程能碰到的全部能力。刻意不给 fs / child_process。 */
const api = {
  info: () => ipcRenderer.invoke('info'),
  search: (q: string, filters: SearchFilters, limit: number, offset: number) =>
    ipcRenderer.invoke('search', q, filters, limit, offset),
  book: (id: string) => ipcRenderer.invoke('book', id),
  bookOverrideSet: (id: string, patch: unknown) => ipcRenderer.invoke('book-override-set', id, patch),
  facets: () => ipcRenderer.invoke('facets'),
  exportLean: () => ipcRenderer.invoke('export-lean'),
  crawl: (url: string, resume: boolean) => ipcRenderer.invoke('crawl', url, resume),
  cancelCrawl: () => ipcRenderer.invoke('crawl-cancel'),
  pickDataDir: () => ipcRenderer.invoke('pick-data-dir'),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  showInFolder: (p: string) => ipcRenderer.invoke('show-in-folder', p),
  cookieInfo: () => ipcRenderer.invoke('cookie-info'),
  cookieSet: (raw: string) => ipcRenderer.invoke('cookie-set', raw),
  cookieClear: () => ipcRenderer.invoke('cookie-clear'),
  cookieTest: () => ipcRenderer.invoke('cookie-test'),
  dlList: () => ipcRenderer.invoke('dl-list'),
  dlEnqueue: (items: Array<{ fid: string; bookId: string; name: string; size: number; pdirFid: string; shareFidToken: string }>) =>
    ipcRenderer.invoke('dl-enqueue', items),
  dlCancel: (fid?: string) => ipcRenderer.invoke('dl-cancel', fid),
  dlRetry: (fid: string) => ipcRenderer.invoke('dl-retry', fid),
  dlInfo: () => ipcRenderer.invoke('dl-info'),
  dlLocal: (fids: string[]) => ipcRenderer.invoke('dl-local', fids),
  dlDir: () => ipcRenderer.invoke('dl-dir'),
  readerResolve: (fid: string) => ipcRenderer.invoke('reader-resolve', fid),
  ocrInfo: (fid: string) => ipcRenderer.invoke('ocr-info', fid),
  ocrPage: (fid: string, p: number, q?: string) => ipcRenderer.invoke('ocr-page', fid, p, q),
  ocrSearch: (fid: string, q: string) => ipcRenderer.invoke('ocr-search', fid, q),
  searchText: (q: string) => ipcRenderer.invoke('search-text', q),
  onTextProgress: (cb: (p: unknown) => void) => {
    const h = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on('search-text-progress', h);
    return () => ipcRenderer.removeListener('search-text-progress', h);
  },
  ocrSummary: () => ipcRenderer.invoke('ocr-summary'),
  textIndexStatus: () => ipcRenderer.invoke('text-index-status'),
  buildTextIndex: () => ipcRenderer.invoke('text-index-build'),
  syncTextIndex: () => ipcRenderer.invoke('text-index-sync'),
  setTextIndexAuto: (on: boolean) => ipcRenderer.invoke('text-index-set-auto', on),
  onTextIndexProgress: (cb: (p: unknown) => void) => {
    const h = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on('text-index-progress', h);
    return () => ipcRenderer.removeListener('text-index-progress', h);
  },
  onTextIndexAuto: (cb: (p: unknown) => void) => {
    const h = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on('text-index-auto', h);
    return () => ipcRenderer.removeListener('text-index-auto', h);
  },
  openOcrFolder: () => ipcRenderer.invoke('open-ocr-folder'),
  ocrRunnerStatus: () => ipcRenderer.invoke('ocr-runner-status'),
  ocrRunnerStart: (opts: { limit?: number; maxPages?: number; force?: boolean; fids?: string[] }) =>
    ipcRenderer.invoke('ocr-runner-start', opts),
  ocrRunnerCancel: () => ipcRenderer.invoke('ocr-runner-cancel'),
  onOcrProgress: (cb: (p: unknown) => void) => {
    const h = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on('ocr-progress', h);
    return () => ipcRenderer.removeListener('ocr-progress', h);
  },
  onOcrDone: (cb: (p: unknown) => void) => {
    const h = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on('ocr-done', h);
    return () => ipcRenderer.removeListener('ocr-done', h);
  },
  marksList: () => ipcRenderer.invoke('marks-list'),
  markToggle: (fid: string, page: number) => ipcRenderer.invoke('mark-toggle', fid, page),
  markRemove: (id: string) => ipcRenderer.invoke('mark-remove', id),
  recentTouch: (fid: string, page: number) => ipcRenderer.invoke('recent-touch', fid, page),
  recentList: () => ipcRenderer.invoke('recent-list'),
  recentClear: () => ipcRenderer.invoke('recent-clear'),
  onCrawlProgress: (cb: (p: unknown) => void) => {
    const h = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on('crawl-progress', h);
    return () => ipcRenderer.removeListener('crawl-progress', h);
  },
  onDlProgress: (cb: (p: unknown) => void) => {
    const h = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on('dl-progress', h);
    return () => ipcRenderer.removeListener('dl-progress', h);
  },
};

contextBridge.exposeInMainWorld('fz', api);

export type FzApi = typeof api;
