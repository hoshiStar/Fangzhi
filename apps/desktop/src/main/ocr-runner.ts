import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 内置 OCR 执行器：把 tools/ocr/ocr.py 当成子进程跑，主进程只做三件事——
 * 找得到 Python 运行时、把 stdout 解析成进度、把结果回灌索引。
 * 识别本身太重，绝不能放到主进程里算。
 */

export interface OcrRunnerDeps {
  /** ocr.py 的绝对路径。开发版在仓库里，打包版在 resources 下。 */
  scriptPath(): string;
  /** 子进程工作目录（uv 会在这里找 pyproject / 缓存）。 */
  cwd(): string;
  /** 索引所在目录，--index 指过去。 */
  dataDir(): string;
  /** 桌面端下载目录，--dir 指过去。 */
  downloadDir(): string;
  onProgress(s: OcrJobState): void;
  /** 子进程结束且成功时回调：主进程据此重载索引。 */
  onFinished(ok: boolean, note?: string): void;
}

export type OcrRuntime = 'uv' | 'venv' | 'python' | 'py' | '';

export type OcrJobStatus = 'idle' | 'running' | 'done' | 'error' | 'canceled';

export interface OcrJobState {
  status: OcrJobStatus;
  runtime: OcrRuntime;
  /** 当前第几本 / 共几本（来自 `[1/3] 文件名` 行）。 */
  fileIndex: number;
  fileTotal: number;
  currentName: string;
  /** 当前这本识别到第几页 / 共几页。 */
  page: number;
  pageTotal: number;
  /** 本次已整本完成的文件数。 */
  doneFiles: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  /** 最后若干行原始输出，给用户看「到底卡在哪」。 */
  log: string[];
}

export interface OcrStartOptions {
  /** 最多识别几本。 */
  limit?: number;
  /** 每本最多几页，0 = 全部。 */
  maxPages?: number;
  lang?: string;
  vertical?: 'auto' | 'off' | 'always';
  force?: boolean;
  /** 只识别这些 fid（桌面端「识别本书」）。 */
  fids?: string[];
}

const LOG_MAX = 60;

function idleState(): OcrJobState {
  return {
    status: 'idle', runtime: '', fileIndex: 0, fileTotal: 0, currentName: '',
    page: 0, pageTotal: 0, doneFiles: 0, log: [],
  };
}

/** 带超时的探针：能跑起来就算可用，超时当作不可用（uv 首次建环境可能较慢）。 */
function probe(cmd: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<{ ok: boolean; out: string }> {
  return new Promise((done) => {
    let settled = false;
    const finish = (ok: boolean, out: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ ok, out });
    };
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, env: env ?? process.env });
    } catch {
      finish(false, '');
      return;
    }
    const chunks: string[] = [];
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退了 */ }
      finish(false, 'timeout');
    }, timeoutMs);
    child.stdout?.on('data', (b: Buffer) => chunks.push(b.toString('utf8')));
    child.stderr?.on('data', (b: Buffer) => chunks.push(b.toString('utf8')));
    child.on('error', () => finish(false, ''));
    child.on('close', (code) => finish(code === 0, chunks.join('').slice(0, 4000)));
  });
}

export function createOcrRunner(deps: OcrRunnerDeps) {
  let state: OcrJobState = idleState();
  let child: ReturnType<typeof spawn> | null = null;
  let cached: { runtime: OcrRuntime; cmd: string; args: string[]; note: string; at: number } | null = null;

  const emit = (): void => deps.onProgress({ ...state, log: [...state.log] });

  function push(line: string): void {
    const t = line.replace(/\r$/, '');
    if (!t.trim()) return;
    state.log.push(t);
    if (state.log.length > LOG_MAX) state.log.splice(0, state.log.length - LOG_MAX);
  }

  /** 依次试 uv / 仓库 .venv / python / py；任一能跑通 --help 就固定下来。 */
  async function detect(): Promise<{ runtime: OcrRuntime; label: string; note: string }> {
    if (cached && Date.now() - cached.at < 5 * 60_000) {
      return { runtime: cached.runtime, label: labelOf(cached.runtime), note: cached.note };
    }
    const script = deps.scriptPath();
    if (!existsSync(script)) {
      cached = { runtime: '', cmd: '', args: [], note: `找不到识别脚本 ${script}`, at: Date.now() };
      return { runtime: '', label: '不可用', note: cached.note };
    }

    const venv = process.platform === 'win32'
      ? join(deps.cwd(), '.venv', 'Scripts', 'python.exe')
      : join(deps.cwd(), '.venv', 'bin', 'python');
    const candidates: Array<{ runtime: OcrRuntime; cmd: string; args: string[] }> = [
      { runtime: 'uv', cmd: 'uv', args: ['run', script] },
      ...(existsSync(venv) ? [{ runtime: 'venv' as OcrRuntime, cmd: venv, args: [script] }] : []),
      { runtime: 'python', cmd: 'python', args: [script] },
      { runtime: 'py', cmd: 'py', args: ['-3', script] },
    ];

    const failures: string[] = [];
    for (const c of candidates) {
      // --help 会先完成模块顶部的 import，导入失败即说明缺依赖，比“能启动”更准。
      const r = await probe(c.cmd, [...c.args, '--help'], c.runtime === 'uv' ? 90_000 : 30_000);
      if (r.ok && /usage|用法/i.test(r.out)) {
        cached = { ...c, note: '', at: Date.now() };
        return { runtime: c.runtime, label: labelOf(c.runtime), note: '' };
      }
      failures.push(`${c.runtime}: ${r.out === 'timeout' ? '超时' : (r.out.split('\n').filter(Boolean).pop() ?? '启动失败')}`);
    }
    cached = { runtime: '', cmd: '', args: [], note: failures.join('；'), at: Date.now() };
    return { runtime: '', label: '不可用', note: cached.note };
  }

  function labelOf(r: OcrRuntime): string {
    return { uv: 'uv run', venv: '项目 .venv', python: 'python', py: 'py -3', '': '不可用' }[r];
  }

  function parseLine(line: string): void {
    const t = line.trim();
    let m = /^\[(\d+)\/(\d+)\]\s+(.*)$/.exec(t);
    if (m) {
      state.fileIndex = Number(m[1]);
      state.fileTotal = Number(m[2]);
      state.currentName = m[3] ?? '';
      state.page = 0;
      state.pageTotal = 0;
      return;
    }
    m = /^page (\d+)\/(\d+)/.exec(t);
    if (m) {
      state.page = Number(m[1]);
      state.pageTotal = Number(m[2]);
      return;
    }
    if (t.startsWith('-> ocr/')) {
      // 收尾行形如「-> ocr/<fid>.jsonl（v6s，本次 3 页，全本 80 页，状态 pending）」。
      // 只有状态是 done 才算整本完成——限页冒烟时这本书仍然是 pending。
      if (/状态\s*done/.test(t)) state.doneFiles += 1;
      return;
    }
  }

  return {
    /** 当前任务快照 + 运行时探测结果，供 UI 首屏渲染。 */
    async status() {
      const d = await detect();
      return { job: { ...state, runtime: state.runtime || d.runtime, log: [...state.log] }, runtime: d };
    },

    async start(opts: OcrStartOptions = {}) {
      if (state.status === 'running') return { ok: false as const, error: '已有识别任务在跑' };
      const d = await detect();
      if (!d.runtime || !cached?.cmd) {
        return { ok: false as const, error: `没有可用的 Python 识别环境：${d.note || '未检测到 uv 或 Python'}` };
      }

      const args = [...cached.args];
      args.push('--index', join(deps.dataDir(), 'index.full.json'));
      args.push('--dir', deps.downloadDir());
      args.push('--limit', String(Math.max(1, Math.min(500, opts.limit ?? 5))));
      if (opts.fids?.length) args.push('--fids', opts.fids.join(','));
      if (opts.maxPages && opts.maxPages > 0) args.push('--max-pages', String(opts.maxPages));
      if (opts.lang) args.push('--lang', opts.lang);
      if (opts.vertical) args.push('--vertical', opts.vertical);
      if (opts.force) args.push('--force');

      state = {
        ...idleState(), status: 'running', runtime: d.runtime,
        startedAt: Date.now(),
        log: [`$ ${cached.cmd} ${args.join(' ')}`],
      };
      emit();

      let c;
      try {
        c = spawn(cached.cmd, args, { cwd: deps.cwd(), windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } });
      } catch (e) {
        state.status = 'error';
        state.error = (e as Error).message;
        emit();
        return { ok: false as const, error: state.error };
      }
      child = c;

      const onChunk = (buf: Buffer): void => {
        for (const line of buf.toString('utf8').split('\n')) {
          push(line);
          parseLine(line);
        }
        emit();
      };
      c.stdout?.on('data', onChunk);
      c.stderr?.on('data', onChunk);

      const finish = (ok: boolean, note?: string): void => {
        child = null;
        if (state.status === 'canceled') {
          state.finishedAt = Date.now();
          emit();
          deps.onFinished(false, '已取消');
          return;
        }
        state.status = ok ? 'done' : 'error';
        state.finishedAt = Date.now();
        if (!ok) state.error = note || '识别失败，见下方输出';
        emit();
        deps.onFinished(ok, note);
      };

      c.on('error', (e) => finish(false, (e as Error).message));
      c.on('close', (code) => {
        if (code === 0) return finish(true);
        finish(false, `识别进程退出码 ${code}`);
      });

      return { ok: true as const };
    },

    cancel() {
      if (!child) return { ok: false as const, error: '没有在跑的任务' };
      state.status = 'canceled';
      emit();
      const pid = child.pid;
      if (process.platform === 'win32' && pid) {
        // uv 会再 fork 出 python，只 kill 父进程会留下孤儿继续吃 CPU
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      } else {
        try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
      }
      return { ok: true as const };
    },
  };
}
