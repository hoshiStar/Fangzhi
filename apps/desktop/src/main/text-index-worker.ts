import { parentPort, workerData } from 'node:worker_threads';
import { buildTextIndex } from './text-index.ts';
import type { TextFileTask } from './fulltext-core.ts';

/**
 * 倒排索引构建线程。workerData 里只放任务清单和数据目录，
 * 文本读取、postings 拼装在子线程里完成，主进程只收进度和结果。
 */
const job = workerData as { dataDir: string; tasks: TextFileTask[] };

try {
  const meta = buildTextIndex(job.dataDir, job.tasks, {
    onProgress: (done, total) => parentPort?.postMessage({ type: 'progress', done, total }),
  });
  parentPort?.postMessage({ type: 'done', meta });
} catch (e) {
  parentPort?.postMessage({ type: 'error', error: (e as Error).message });
}
