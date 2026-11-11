# tools 脚本说明

运行前先确认脚本性质，避免误改真实数据或账号状态。

## 只读诊断

- `verify-search.ts`：检索样例、筛选和性能诊断，不改写数据。
- `tools/cdp-detail.mjs`：通过 CDP 观察详情页异步时序，不包含写操作。
- `tools/check-fulltext-worker.mjs`：在临时目录造 OCR 样本，直接驱动 `dist/main/fulltext-worker.cjs`，验证命中的页码聚合、扫描进度、取消、空查询、位图预筛，以及建倒排索引后是否真的走索引且结果与扫描一致。只写系统临时目录，需要先 `npm run build:desktop`。

## 会改写本地数据

- `build-text-index.ts`：建全文倒排索引到 `<数据目录>/.text-index/`（只读 `index.full.json`，不改它）。`npm run build:text-index` 即可；`FZ_DF_CAP` 可收紧高频双字剪枝阈值。
- `verify-index.ts`：会重写 `data/index.full.json` 和 `index.lean.json`，必须显式加 `--write`。
- `tools/ocr/ocr.py`：会写 `data/ocr/*.jsonl` 并回写索引，使用前先备份索引。
- `tools/gen-t2s.mjs`：重写 `packages/core/src/t2s.ts`（繁简单字映射表），只有升级 opencc 词典时才需要跑。

## 会访问真实网络

- `verify-crawl-resume.ts`：真实爬取夸克分享，必须显式加 `--run`。
- `tools/cdp-probe.mjs`：默认只读界面检查；账号与下载写操作需要 `FZ_CDP_ALLOW_COOKIE_MUTATION=1`，真跑识别需要 `FZ_CDP_RUN_OCR=1`，通过界面重建全文索引需要 `FZ_CDP_BUILD_INDEX=1`，且都只能在独立 `FZ_USER_DATA_DIR` 下运行。

## OCR

`tools/ocr/ocr.py` 需要 Python 3.12 和 uv，用法见仓库根目录 `README.md`。桌面端已内置执行器，日常不需要命令行。
