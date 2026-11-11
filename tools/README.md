# tools 脚本说明

运行前先确认脚本性质，避免误改真实数据或账号状态。

## 只读诊断

- `verify-search.ts`：检索样例、筛选和性能诊断，不改写数据。
- `tools/cdp-detail.mjs`：通过 CDP 观察详情页异步时序，不包含写操作。

## 会改写本地数据

- `verify-index.ts`：会重写 `data/index.full.json` 和 `index.lean.json`，必须显式加 `--write`。
- `tools/ocr/ocr.py`：会写 `data/ocr/*.jsonl` 并回写索引，使用前先备份索引。

## 会访问真实网络

- `verify-crawl-resume.ts`：真实爬取夸克分享，必须显式加 `--run`。
- `tools/cdp-probe.mjs`：默认只读界面检查；账号与下载写操作需要 `FZ_CDP_ALLOW_COOKIE_MUTATION=1`，且只能在独立 `FZ_USER_DATA_DIR` 下运行。

## OCR

`tools/ocr/ocr.py` 需要 Python 3.12 和 uv，用法见仓库根目录 `README.md`。
