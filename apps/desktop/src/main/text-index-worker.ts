import { parentPort, workerData } from 'node:worker_threads';
import { buildTextIndex, updateTextIndex } from './text-index.ts';
import type { TextFileTask } from './fulltext-core.ts';

/**
 * 倒排索引构建线程。workerData 里只放任务清单和数据目录，
 * 文本读取、postings 拼装在子线程里完成，主进程只收进度和结果。
 *
 * mode=update 是增量：只重扫变了/新来的文件，识别完一本书就跟着跑一次，
 * 几十毫秒的事，不必等下一个人工全量重建。
 */
const job = workerData as { dataDir: string; tasks: TextFileTask[]; mode?: 'build' | 'update' };

const onProgress = (done: number, total: number): void => {
  parentPort?.postMessage({ type: 'progress', done, total });
};

try {
  if (job.mode === 'update') {
    const r = updateTextIndex(job.dataDir, job.tasks, { onProgress });
    parentPort?.postMessage({ type: 'done', meta: r.meta, stats: r.stats });
  } else {
    const meta = buildTextIndex(job.dataDir, job.tasks, { onProgress });
    parentPort?.postMessage({ type: 'done', meta });
  }
} catch (e) {
  parentPort?.postMessage({ type: 'error', error: (e as Error).message });
}
