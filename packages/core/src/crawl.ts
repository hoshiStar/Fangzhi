import type { RawShareDump, RawShareEntry, IndexMeta } from './types.ts';
import { normalizeExt } from './lexicon.ts';

const BASE = 'https://drive-pc.quark.cn/1/clouddrive/share/sharepage';

const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Referer: 'https://pan.quark.cn/',
  Origin: 'https://pan.quark.cn',
};

export interface CrawlTarget {
  pwdId: string;
  passcode?: string;
}

/** 从分享链接取 pwd_id 与提取码。支持 /s/<id> 和带 ?pwd= 的形式。 */
export function parseShareUrl(url: string): CrawlTarget {
  const u = url.trim();
  const m = u.match(/\/s\/([a-z0-9]+)/i);
  if (!m?.[1]) throw new Error(`无法从链接解析出分享 ID: ${url}`);
  const pwd = u.match(/[?&]pwd=([^&#]+)/i);
  return { pwdId: m[1], passcode: pwd?.[1] ? decodeURIComponent(pwd[1]) : undefined };
}

export interface CrawlProgress {
  /** 已完整列出内容的目录数。 */
  dirsDone: number;
  /** 待列出的目录数。 */
  dirsPending: number;
  files: number;
  reqCount: number;
  maxDepth: number;
  currentPath: string;
}

/**
 * 断点。`listedFids` 是「已经完整列完子项」的目录，
 * 只存 rows 无法判断某个目录是列到一半还是列完了，所以必须单独记。
 */
export interface CrawlCheckpoint {
  pwdId: string;
  rows: RawShareEntry[];
  listedFids: string[];
  stat: { reqCount: number; maxDepth: number };
  savedAt: string;
}

export interface CrawlOptions {
  target: CrawlTarget;
  pageSize?: number;
  /** 请求间隔，随机取值以避开固定节奏。默认 100–140ms。 */
  delayMs?: [number, number];
  retries?: number;
  signal?: AbortSignal;
  onProgress?: (p: CrawlProgress) => void;
  /** 每个目录列完后回调，CLI 用它落盘断点。 */
  onCheckpoint?: (c: CrawlCheckpoint) => void;
  /** 上次中断的断点，用来续爬。 */
  resume?: CrawlCheckpoint;
}

interface ShareListItem {
  fid: string;
  file_name: string;
  size: number;
  dir: boolean;
  format_type?: string;
  share_fid_token?: string;
}

interface ApiResponse {
  status: number;
  code: number;
  message?: string;
  data?: { stoken?: string; title?: string; expired_at?: number; list?: ShareListItem[]; author?: { nick_name?: string } };
  metadata?: { _total?: number };
}

export class QuarkShareError extends Error {
  readonly code: number;
  readonly needLogin: boolean;
  constructor(message: string, code: number, needLogin = false) {
    super(message);
    this.name = 'QuarkShareError';
    this.code = code;
    this.needLogin = needLogin;
  }
}

export interface CrawlResult {
  dump: RawShareDump;
  meta: IndexMeta;
  /** 相对 previous 的变化，用于增量更新提示。 */
  diff?: { added: number; removed: number; changed: number; addedPaths: string[]; removedPaths: string[] };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });

export interface ShareToken {
  stoken: string;
  title?: string;
  author?: string;
  expiredAt?: number;
}

/** 分享令牌。遍历和取下载直链都要用，而且都会过期，抽出来两边复用。 */
export async function fetchShareToken(target: CrawlTarget, signal?: AbortSignal): Promise<ShareToken> {
  const j = await fetch(`${BASE}/token?pr=ucpro&fr=pc`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pwd_id: target.pwdId, passcode: target.passcode ?? '' }),
    signal,
  }).then((r) => r.json() as Promise<ApiResponse>);
  if (j.code !== 0 || !j.data?.stoken) {
    throw new QuarkShareError(`取 stoken 失败: ${j.message ?? ''} (code ${j.code})`, j.code);
  }
  return { stoken: j.data.stoken, title: j.data.title, author: j.data.author?.nick_name, expiredAt: j.data.expired_at };
}

export interface ShareFidTokenRef {
  fid: string;
  pdirFid: string;
}

/**
 * share_fid_token 与签发它的 stoken 绑定，而且会过期。爬取时存进索引的 token，
 * 到下载时往往已失效，直接拿去换直链会报 41020「token校验异常」。所以下载前用
 * 当前 stoken 现取一份：按父目录分组分页遍历 detail，命中目标 fid 就收下它的 fresh token。
 */
export async function refreshShareFidTokens(opts: {
  target: CrawlTarget;
  stoken: string;
  files: ShareFidTokenRef[];
  signal?: AbortSignal;
}): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const byDir = new Map<string, Set<string>>();
  for (const f of opts.files) {
    let s = byDir.get(f.pdirFid);
    if (!s) { s = new Set(); byDir.set(f.pdirFid, s); }
    s.add(f.fid);
  }
  for (const [pdirFid, want] of byDir) {
    if (opts.signal?.aborted) throw new Error('aborted');
    let page = 1;
    for (;;) {
      const qs =
        `?pr=ucpro&fr=pc&pwd_id=${opts.target.pwdId}` +
        `&stoken=${encodeURIComponent(opts.stoken)}&pdir_fid=${pdirFid}` +
        `&force=0&_page=${page}&_size=100&_fetch_total=1` +
        `&_sort=file_type:asc,file_name:asc`;
      const j = await fetch(BASE + `/detail${qs}`, { headers: HEADERS, signal: opts.signal })
        .then((r) => r.json() as Promise<ApiResponse>);
      if (j.code === 31001 || /require login/i.test(j.message ?? '')) {
        throw new QuarkShareError(j.message ?? 'require login', j.code, true);
      }
      if (j.code !== 0) {
        throw new QuarkShareError(`刷新 share_fid_token 失败: ${j.message ?? ''} (code ${j.code})`, j.code);
      }
      const list = j.data?.list ?? [];
      for (const it of list) {
        if (want.has(it.fid) && it.share_fid_token) out.set(it.fid, it.share_fid_token);
      }
      const total = j.metadata?._total ?? list.length;
      let all = true;
      for (const fid of want) if (!out.has(fid)) { all = false; break; }
      if (all || list.length === 0 || page * 100 >= total) break;
      page++;
      await sleep(120, opts.signal);
    }
  }
  return out;
}

/**
 * 遍历一个夸克分享链接的全部目录树。
 *
 * 遍历不需要登录，只有下载需要——所以这一步可以在完全离线账号的情况下跑完，
 * 产物是本地索引的唯一数据来源。
 */
export async function crawlShare(opts: CrawlOptions): Promise<CrawlResult> {
  const { target, signal } = opts;
  const pageSize = opts.pageSize ?? 100;
  const [dMin, dMax] = opts.delayMs ?? [100, 140];
  const maxRetries = opts.retries ?? 4;

  let stoken = '';
  let reqCount = 0;
  let maxDepth = 0;
  let shareTitle = '';
  let shareAuthor: string | undefined;
  let expiredAt: number | undefined;

  const jitter = () => dMin + Math.random() * (dMax - dMin);

  async function call(path: string, init?: RequestInit): Promise<ApiResponse> {
    if (signal?.aborted) throw new Error('aborted');
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetch(BASE + path, { ...init, headers: { ...HEADERS, ...(init?.headers as Record<string, string>) } });
      const j = (await res.json()) as ApiResponse;
      if (j.code === 0) return j;
      // stoken 过期：重取后原地重试，不算失败
      if (j.code === 41005 || /stoken/i.test(j.message ?? '')) {
        await refreshToken();
        continue;
      }
      if (j.code === 31001 || /require login/i.test(j.message ?? '')) {
        throw new QuarkShareError(j.message ?? 'require login', j.code, true);
      }
      if (attempt === maxRetries) throw new QuarkShareError(`${j.message ?? 'unknown'} (code ${j.code})`, j.code);
      await sleep(800 * (attempt + 1), signal);
    }
    throw new QuarkShareError('重试次数用尽', -1);
  }

  async function refreshToken(): Promise<void> {
    const t = await fetchShareToken(target, signal);
    stoken = t.stoken;
    shareTitle = t.title ?? shareTitle;
    shareAuthor = t.author ?? shareAuthor;
    expiredAt = t.expiredAt ?? expiredAt;
  }

  async function listPage(pdirFid: string, page: number): Promise<ApiResponse> {
    reqCount++;
    const qs =
      `?pr=ucpro&fr=pc&pwd_id=${target.pwdId}` +
      `&stoken=${encodeURIComponent(stoken)}&pdir_fid=${pdirFid}` +
      `&force=0&_page=${page}&_size=${pageSize}&_fetch_total=1` +
      `&_sort=file_type:asc,file_name:asc`;
    return call(`/detail${qs}`);
  }

  const rows: RawShareEntry[] = [];
  const listedFids = new Set<string>();
  /**
   * 已入 rows 的 fid。续爬时根目录还没被标记为「列完」（它要等整棵树走完才标记），
   * 所以一定会重列一遍根和已完成的中间层；靠这个集合保证不会重复插入。
   */
  const seenFids = new Set<string>();
  let fileCount = 0;

  if (opts.resume && opts.resume.pwdId === target.pwdId) {
    rows.push(...opts.resume.rows);
    for (const r of opts.resume.rows) seenFids.add(r.fid);
    for (const f of opts.resume.listedFids) listedFids.add(f);
    // 根目录必须重新列一次才能往下递归；它只有一个，多花一次请求换掉一套
    // 「扫描 rows 找未完成目录」的逻辑。子目录靠 listedFids 跳过，不会重列。
    listedFids.delete('0');
    fileCount = opts.resume.rows.reduce((n, r) => n + (r.type === 'file' ? 1 : 0), 0);
    reqCount = opts.resume.stat.reqCount;
    maxDepth = opts.resume.stat.maxDepth;
  }

  await refreshToken();

  function report(currentPath: string): void {
    opts.onProgress?.({
      dirsDone: listedFids.size,
      dirsPending: rows.filter((r) => r.type === 'dir' && !listedFids.has(r.fid)).length,
      files: fileCount,
      reqCount,
      maxDepth,
      currentPath,
    });
  }

  /**
   * 落断点。不变式：listedFids 里的目录，其子项一定已经全在 rows 里。
   * 续爬靠这条判断哪些目录要重列，所以只能在目录真正走完之后调用。
   */
  function checkpoint(): void {
    opts.onCheckpoint?.({
      pwdId: target.pwdId,
      rows: [...rows],
      listedFids: [...listedFids],
      stat: { reqCount, maxDepth },
      savedAt: new Date().toISOString(),
    });
  }

  async function listAll(fid: string, path: string): Promise<ShareListItem[]> {
    const out: ShareListItem[] = [];
    let page = 1;
    for (;;) {
      const j = await listPage(fid, page);
      const list = j.data?.list ?? [];
      out.push(...list);
      const total = j.metadata?._total ?? out.length;
      if (out.length >= total || list.length === 0) break;
      page++;
      await sleep(jitter(), signal);
    }
    report(path);
    return out;
  }

  async function walk(fid: string, path: string, depth: number): Promise<void> {
    if (signal?.aborted) throw new Error('aborted');
    if (listedFids.has(fid)) return;
    maxDepth = Math.max(maxDepth, depth);
    const items = await listAll(fid, path);

    // 中途被打断时必须回滚已推入的子项：否则 fid 没进 listedFids，
    // 续爬会重列一遍，rows 里就出现重复条目。
    const mark = rows.length;
    try {
      for (const f of items) {
        const p = path + '/' + f.file_name;
        const isNew = !seenFids.has(f.fid);
        if (f.dir) {
          // 即使这行已经在断点里，也照样递归——walk 自己会用 listedFids 跳过列完的目录
          if (isNew) {
            rows.push({ type: 'dir', path: p, name: f.file_name, size: 0, fid: f.fid, depth });
            seenFids.add(f.fid);
          }
          await sleep(jitter(), signal);
          await walk(f.fid, p, depth + 1);
        } else {
          if (isNew) {
            rows.push({
              type: 'file',
              path: p,
              name: f.file_name,
              size: f.size ?? 0,
              fid: f.fid,
              pdir_fid: fid,
              depth,
              ext: normalizeExt(f.file_name),
              format: f.format_type ?? '',
              share_fid_token: f.share_fid_token ?? '',
            });
            seenFids.add(f.fid);
            fileCount++;
          }
        }
      }
    } catch (e) {
      for (const r of rows.slice(mark)) seenFids.delete(r.fid);
      rows.length = mark;
      throw e;
    }

    listedFids.add(fid);
    checkpoint();
  }

  await walk('0', '', 1);

  const dump: RawShareDump = { rows, stat: { reqCount, maxDepth } };
  const meta: IndexMeta = {
    pwdId: target.pwdId,
    shareUrl: `https://pan.quark.cn/s/${target.pwdId}`,
    shareTitle,
    author: shareAuthor,
    expiredAt,
  };

  return { dump, meta };
}

/** 两次爬取结果的差异，按 fid 比对。增量更新时用来提示用户。 */
export function diffDumps(prev: RawShareDump, next: RawShareDump): NonNullable<CrawlResult['diff']> {
  const byFid = (d: RawShareDump) => new Map(d.rows.filter((r) => r.type === 'file').map((r) => [r.fid, r]));
  const a = byFid(prev);
  const b = byFid(next);
  const addedPaths: string[] = [];
  const removedPaths: string[] = [];
  let changed = 0;
  for (const [fid, r] of b) {
    const old = a.get(fid);
    if (!old) addedPaths.push(r.path);
    else if (old.size !== r.size || old.name !== r.name) changed++;
  }
  for (const [fid, r] of a) if (!b.has(fid)) removedPaths.push(r.path);
  return { added: addedPaths.length, removed: removedPaths.length, changed, addedPaths, removedPaths };
}
