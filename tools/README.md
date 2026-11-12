# tools 脚本说明

运行前先确认脚本性质，避免误改真实数据或账号状态。

## 只读诊断

- `verify-search.ts`：检索样例、筛选和性能诊断，不改写数据。
- `tools/cdp-detail.mjs`：通过 CDP 观察详情页异步时序，不包含写操作。
- `tools/check-fulltext-worker.mjs`：在临时目录造 OCR 样本，直接驱动 `dist/main/fulltext-worker.cjs`，验证命中的页码聚合、扫描进度、取消、空查询、位图预筛，以及建倒排索引后是否真的走索引且结果与扫描一致。只写系统临时目录，需要先 `npm run build:desktop`。

## 会改写本地数据

- `build-text-index.ts`：建全文倒排索引到 `<数据目录>/.text-index/`（只读 `index.full.json`，不改它）。`npm run build:text-index` 全量建；加 `-- --update` 只重扫变过/新来的文件（桌面端「识别完自动同步」走同一条路）；`FZ_DF_CAP` 可收紧高频双字剪枝阈值。语料大到内存放不下时会自动分批落到 `<数据目录>/.text-index/.build-<pid>/`（构建结束即删），不用手工干预。
- `verify-index.ts`：会重写 `data/index.full.json` 和 `index.lean.json`，必须显式加 `--write`。
- `tools/ocr/ocr.py`：会写 `data/ocr/*.jsonl` 并回写索引，使用前先备份索引。
- `tools/gen-t2s.mjs`：重写 `packages/core/src/t2s.ts`（繁简单字映射表），只有升级 opencc 词典时才需要跑。

## 会访问真实网络

- `verify-crawl-resume.ts`：真实爬取夸克分享，必须显式加 `--run`。
- `tools/cdp-probe.mjs`：默认只读界面检查；账号与下载写操作需要 `FZ_CDP_ALLOW_COOKIE_MUTATION=1`，通过界面重建全文索引需要 `FZ_CDP_BUILD_INDEX=1`（该路径目前随全文面板一起冻结），且都只能在独立 `FZ_USER_DATA_DIR` 下运行。识别入口与全文检索都已暂时停用，探针改为断言「入口已隐藏 + 接口回停用」；`FZ_CDP_RUN_OCR=1` 暂时被忽略，索引面板与全文检索的原断言、真跑识别的原步骤都留在注释里。

## OCR

`tools/ocr/ocr.py` 需要 Python 3.12 和 uv，用法见仓库根目录 `README.md`。桌面端已内置执行器，日常不需要命令行。

> 识别与全文检索自 2026-11 起暂时停用（本机语料只有 60 页），下面的脚本与 `build-text-index.ts` 仍可手工运行，产出会写进 `data/`，但应用当前不读它们。恢复方式见根目录 `README.md` 的「OCR」一节。
