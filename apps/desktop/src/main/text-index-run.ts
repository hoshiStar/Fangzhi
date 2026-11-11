import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { buildTextIndex, updateTextIndex } from './text-index.ts';
import type { IndexUpdateStats, TextIndexMeta } from './text-index.ts';
import type { TextFileTask } from './fulltext-core.ts';

export interface TextIndexBuildDeps {
  tasks(): TextFileTask[];
  dataDir(): string;
  onProgress?: (p: { done: number; total: number }) => void;
  /** 默认取同目录的 text-index-worker.cjs（见 scripts/build.mjs）。 */
  workerFile?: string;
}

export interface BuildResult {
  ok: boolean;
  meta?: TextIndexMeta;
  /** 仅增量更新返回：新增/重做/删除各几个文件。 */
  stats?: IndexUpdateStats;
  error?: string;
}

type Mode = 'build' | 'update';

/**
 * 倒排索引构建的门面。构建要读全部 OCR 文本、拼几十万条 postings，
 * 上千本时是几十秒级，必须放线程里跑，否则界面会整体冻住。
 * 线程起不来（打包漏文件）就退回同步构建——慢且卡，但结果对。
 *
 * build() 是全量重建（界面上的按钮），update() 是增量（识别完成后自动跑）。
 */
export function createTextIndexBuilder(deps: TextIndexBuildDeps) {
  let running = false;

  return {
    running: () => running,

    /** 全量重建：清掉旧倒排从头拼。 */
    build(): Promise<BuildResult> {
      return start('build');
    },

    /**
     * 增量更新：没变的文件沿用旧倒排，只重扫变过/新来的。
     * 没有任何变化时一个字节都不写，直接返回 changed=false。
     */
    update(): Promise<BuildResult> {
      return start('update');
    },
  };

  function start(mode: Mode): Promise<BuildResult> {
    if (running) return Promise.resolve({ ok: false, error: '已有索引任务在跑' });
    const tasks = deps.tasks();
    if (!tasks.length) return Promise.resolve({ ok: false, error: '还没有任何 OCR 文本，先跑全文识别' });
    const dataDir = deps.dataDir();
    running = true;

    const sync = (): BuildResult => {
      try {
        // rethrow：同步路径没有线程边界，异常必须自己兜住
        if (mode === 'update') {
          const r = updateTextIndex(dataDir, tasks, { onProgress: (done, total) => deps.onProgress?.({ done, total }) });
          return { ok: true, meta: r.meta, stats: r.stats };
        }
        const meta = buildTextIndex(dataDir, tasks, { onProgress: (done, total) => deps.onProgress?.({ done, total }) });
        return { ok: true, meta };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      } finally {
        running = false;
      }
    };

    const file = deps.workerFile ?? join(__dirname, 'text-index-worker.cjs');
    if (!existsSync(file)) return Promise.resolve(sync());

    return new Promise<BuildResult>((resolve) => {
      const done = (r: BuildResult): void => {
        running = false;
        resolve(r);
      };
      type Msg = {
        type?: string; done?: number; total?: number;
        meta?: TextIndexMeta; stats?: IndexUpdateStats; error?: string;
      };
      try {
        const w = new Worker(file, { workerData: { dataDir, tasks, mode } });
        w.on('message', (m: Msg) => {
          if (m?.type === 'progress') deps.onProgress?.({ done: m.done ?? 0, total: m.total ?? 0 });
          else if (m?.type === 'done') {
            void w.terminate();
            done({ ok: true, meta: m.meta, stats: m.stats });
          } else if (m?.type === 'error') {
            void w.terminate();
            done({ ok: false, error: m.error });
          }
        });
        w.on('error', () => {
          void w.terminate();
          // 线程挂了（内存不足、打包缺依赖）就同步再试一次，别让用户白等
          done(sync());
        });
      } catch (e) {
        done({ ok: false, error: (e as Error).message });
      }
    });
  }
}
