# 方志检索

面向地方志研究、资料收集场景的 Windows 桌面检索与阅读工具。项目把夸克分享中的地方志目录整理成可检索书目，并支持下载与 PDF 在线阅读。（本地 OCR 全文检索已暂时冻结，见下文「OCR」。）

## 产品边界

- 当前核心是 **Windows 桌面端**：检索、筛选、下载、PDF 阅读。
- 微信小程序是 **只读离线书目查询**，不提供下载、PDF 阅读和全文检索。
- **全文检索与 OCR 识别自 2026-11 起暂时停用**：识别率不达标，且本机 OCR 语料只有 10 个文件 × 6 页（书库 4600 个文件），搜出来几乎不可能是要找的那一本。界面入口全部隐藏，主进程不读 `data/ocr` 与 `.text-index`，检索只走书目维度（书名 / 地名 / 志种 / 著者 / 文件名）。代码与语料都保留，恢复方法见「OCR」一节。
- 内置阅读器只支持 PDF。DJVU、DOC、压缩包目前只能下载或跳转分享页。
- 项目默认适配仓库中配置的特定夸克地方志分享库，不代表任意分享链接都能获得相同解析质量。

## 环境要求

- Node.js >= 22.18（测试使用 Node 原生 TypeScript 类型擦除）
- npm >= 10
- Python >= 3.12,<3.13 与 [uv](https://github.com/astral-sh/uv)（仅 OCR 支线需要）
- 当前发布目标为 Windows x64

## 快速开始

```bash
npm install

# 从夸克分享爬取目录，生成 data/raw.json
npm run crawl

# 构建完整索引与精简索引
npm run build-index

# 构建并启动桌面端
npm run dev --workspace @fangzhi/desktop
```

仓库中的 `data/` 不进入 Git，首次运行需要自行爬取或放入兼容的索引数据。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run crawl` | 遍历分享目录并写 `data/raw.json` |
| `npm run build-index` | 构建 `index.full.json` 和 `index.lean.json`，自动保留已有 OCR 关联 |
| `npm run stats` | 查看索引规模与解析覆盖率 |
| `npm run search -- --q 吉水县志` | 命令行检索 |
| `npm run typecheck` | 检查核心库类型 |
| `npm run typecheck --workspace @fangzhi/desktop` | 检查桌面端类型 |
| `npm test` | 运行核心、跨端一致性和下载路径测试 |
| `npm run build:text-index` | 建全文倒排索引到 `data/.text-index/`（`-- <数据目录>` 指定目录，`--update` 只更新变过的文件，`FZ_DF_CAP` 可收紧高频双字剪枝） |
| `npm run verify` | 类型检查 + 自动测试 + 小程序冒烟 |
| `npm run build --workspace @fangzhi/desktop` | 构建桌面端 `dist/` |
| `npm run package --workspace @fangzhi/desktop` | 构建 Windows 便携版并生成数据清单 |
| `node apps/miniprogram/build.mjs` | 打包小程序核心与裁剪索引 |

## 目录结构

```text
packages/core/          书目解析、索引、检索、爬取、下载协议
apps/desktop/           Electron 桌面端：main / preload / renderer
apps/miniprogram/       微信小程序只读检索版
tools/ocr/              Python OCR 支线
tools/                  CDP 界面诊断等开发工具
data/                   本地数据：原始目录、索引、OCR JSONL（不提交）
release/                便携版发布产物（不提交）
tests/                  自动化测试
docs/                   产品评审与历史方案
quark-probe/            早期协议与解析实验，已归档
```

## 数据与安全

- 索引构建与下载落盘均使用“临时文件 + 原子替换”，避免中断留下半份 JSON。
- 下载按 `下载目录/books/<bookId>/<fid>/<文件名>` 隔离，同名文件不会互相覆盖。
- 阅读器会校验本地文件大小，旧版平铺下载目录只做只读兼容。
- 在线阅读的字节由 main 在本机 `127.0.0.1` 上开临时 HTTP 服务转发：只监听回环、端口随机、URL 必须带本次进程生成的 token，并校验 `Host`。PDF.js 因此能发 Range 请求分段取，打开一本几百 MB 的扫描件不会一次性塞进内存（自定义协议做不到这一点：pdf.js 只对 http(s) 启用 Range）。
- 夸克 cookie 只在系统密钥服务可用时加密保存；不可用时拒绝写入明文。
- 外部链接仅允许夸克官方 HTTPS 域名；文件定位限制在下载目录内。
- 人工校正保存在本机 `userData/book-overrides.json`，不写入共享索引。
- 自动化 CDP 检查默认跳过账号与下载写操作；需要时必须在独立用户目录中显式设置 `FZ_CDP_ALLOW_COOKIE_MUTATION=1`。

## OCR

> **整条链路暂时停用（2026-11）**：识别率还达不到可用程度，而且本机 OCR 语料只有 10 个文件 × 6 页 = 60 页（书库 4600 个文件），全文检索覆盖 0.2%，实际价值接近零。所以连**消费侧**一起冻结，而不只是藏识别按钮。
>
> **界面**：「工具 → 全文识别」「工具 → 全文索引」、详情页「识别本书」、阅读器「OCR 文本」按钮与书内搜索、搜索结果里的「全文命中」块、详情页「已识别 N」标注、状态栏「全文 X/Y」，全部不再渲染。
>
> **主进程**：`search-text`、`text-index-status/build/sync/set-auto`、`ocr-info/page/search`、`ocr-runner-status/start/cancel` 一律短路，不读 `data/ocr`、不读 `.text-index`/`.text-cache`、启动时不做索引同步预检、也不探测 uv/python。
>
> **打包**：便携版不再带 `data/ocr`、`.text-index`、`.text-cache`（`data-manifest.json` 里 `ocr.packed` 为 `false`）。
>
> **恢复三步**：① `apps/desktop/src/main/index.ts` 与 `apps/desktop/src/renderer/app.ts` 里两个常量 `OCR_RECOGNITION_ENABLED`、`FULLTEXT_ENABLED` 改回 `true`；② 放开 `index.html` 里注释掉的 `#btn-ocr`、`#btn-textindex`、`#r-ocr`；③ `apps/desktop/scripts/package-portable.mjs` 的 `FULLTEXT_ENABLED` 改回 `true` 重新打包。语料与索引仍在仓库 `data/` 下，代码一行没删；`tools/cdp-probe.mjs` 里对应的面板/检索断言也以注释形式保留。
>
> 下面两节是这些能力的原有说明，保留作恢复时的参考。

桌面端「工具 → 全文识别」内置了识别执行器：启动时会自动探测 `uv` → 项目 `.venv` → `python` → `py -3`，找到能跑通脚本的环境后即可在应用内选择「本次最多识别几本 / 每本最多几页 / 是否重跑」，书详情里还有「识别本书」。进度按本数和页码实时显示，可取消，失败后可继续跑（已识别的页会跳过）。识别完成会自动重载索引、刷新全文覆盖统计，并马上跑一次倒排索引的增量更新。

命令行等价用法：

```bash
uv run tools/ocr/ocr.py --dir "下载目录" --limit 20
uv run tools/ocr/ocr.py --dir "下载目录" --fids <fid1>,<fid2>   # 只识别指定文件
```

产物写入 `data/ocr/<fid>.jsonl`，并把 `textRef` / `ocrStatus` 回写索引。下载目录按 `books/<bookId>/<fid>/` 分层存放，脚本同时兼容早期的平铺目录。

首次识别会从 ModelScope 下载识别模型（约 100 MB）到 `tools/ocr/models`，需要联网；打包版不含模型。

## 书签与最近阅读

阅读器右上角「☆ 书签」收藏当前页，再点一次取消；「工具 → 书签与最近阅读」可查看、跳转、删除书签，以及最近读过的 30 个文件。记录存在 `userData/library.json`，与索引分开，重建索引或换数据目录都不会丢。

## 检索的繁简处理

索引里的书名、地名基本是简体，而古籍研究者的引用常是繁体。核心检索层内置了 3116 组单字繁转简映射（`packages/core/src/t2s.ts`，由 `node tools/gen-t2s.mjs` 从 opencc 生成），查询词与书目字段走同一张表，因此「贛州府志」能命中《赣州府志》，简体输入不受影响。小程序使用同一份核心代码，行为一致。

## 测试与诊断脚本

- `npm test`：纯逻辑测试，不访问网络、不修改真实数据。
- `verify-search.ts`：只读检索诊断。
- `verify-index.ts`：会覆盖索引，必须显式加 `--write`。
- `verify-crawl-resume.ts`：会真实联网爬取，必须显式加 `--run`。
- `tools/cdp-probe.mjs`：默认只读界面检查；账号/下载写操作需要显式环境变量和隔离 profile。
- `tools/check-fulltext-worker.mjs`：用临时数据目录直接起全文检索 worker，验证聚合、进度、取消、位图预筛跳过、换一个 worker 后是否全部命中磁盘缓存，以及建倒排索引后是否真的走索引并与扫描结果一致；需要先 `npm run build:desktop`。
- 使用隔离 profile 启动桌面端：

```bash
FZ_USER_DATA_DIR=.tmp/cdp-profile npx electron apps/desktop --remote-debugging-port=9333
```

## 发布

`npm run package --workspace @fangzhi/desktop` 会：

1. 复制当前 `dist/`；
2. 复制当前 `data/index.full.json` 与 `meta.json`；**全文数据（`data/ocr`、`.text-index`、`.text-cache`）在冻结期间不拷**，由脚本顶部的 `FULLTEXT_ENABLED` 控制，与主进程同名常量保持一致；
3. 生成 `resources/data/data-manifest.json`，包含应用版本、索引哈希与统计信息；冻结期间 `ocr.packed` 为 `false`，OCR 文件数记 0；
4. 全文数据随包发时，`data/.text-index/` 一起拷进包（打包版数据目录通常不可写，运行时无法自建）；
5. 生成 `release/portable-win-x64/方志检索.exe`。装配先写临时目录，再整体换上去；换的时候只用改名让位、不整树删除——便携版目录动辄几百个条目，整棵树 `rm` 会被环境的批量删除守卫当成批量删除拦下，本机杀软也常锁着上一版 `electron.exe`。因此旧目录会改名成 `portable-win-x64.old-<时间戳>/`，确认新版可用后自行删除即可腾出几百 MB；只有改名都失败（旧目录被占用）时才退让成 `portable-win-x64-<时间戳>/` 并打印提示。

构建脚本默认**不清空** `dist/`（esbuild 输出文件名固定，覆盖写即可，也避开整目录删除）；确实要从零重建时用 `node apps/desktop/scripts/build.mjs --clean`。

发布前应执行 `npm run verify`；`ocr.packed` 为 `true` 时还要核对数据清单中的 OCR 引用数与实际文件数。

## 当前已知限制

> 下面与全文检索相关的几条对应的是**已冻结**的代码（`FULLTEXT_ENABLED = false`），保留作恢复时的参考；标了「实测」的数据来自 2026-11 冻结前的合成语料或本机 10 文件小样本。
- 全库全文检索在独立 worker 线程里跑，界面不会被上千个 JSONL 的解析卡住。检索前先看每个文件缓存头里的**字符位图**（正文出现过哪些字），查询里的字一个都没有就直接跳过，正文一个字节都不读；位图本身也常驻内存，同一线程内二次查询不再发系统调用。实测 300 本 × 120 页样本，稀见词查询 1.9s → 0.11s（二次 0.08s）。
- 另有**双字倒排索引**（`npm run build:text-index`，或界面「工具 → 全文索引」重建）：把「双字 → 页码」预存到 `<数据目录>/.text-index/`，查询时先求交定候选页，再回正文核实，不再逐本读正文。实测 300 本 × 120 页样本，稀见词查询 0.76s → 0.014s；同语料下索引与全量扫描的结果逐本逐页一致。
- 倒排索引会剪掉太常见的双字（默认单个双字超过 2 万条倒排就不存）：`县志`、`府志` 这类高频双字查询仍然退回扫描，「赣州府志」这类带低频双字的照常走索引。
- 索引**自动增量更新**：识别完成（该触发随识别入口停用，代码保留）、程序启动、切换数据目录时各比对一次，只重扫变过/新来的文件（旧的 posting 按新下标平移后直接沿用），没有任何变化就不写盘。全量重建只留给界面「工具 → 全文索引 → 全量重建」（面板随全文一起冻结）和 `npm run build:text-index`。自动同步可以在同一面板关掉，关掉后新识别的内容仍会按「未覆盖」整篇扫描，结果一样全，只是慢。
- 增量更新的成本约等于「改过的文件数」× 单文件扫描时间：本机 10 个文件里改 1 个约 0.1s；全量重建则随语料线性增长。
- 索引体积随语料线性增长（本机 10 个文件约 0.12 MB；粗估每 100 万页量级在数百 MB）。
- **超大语料自动分批落盘**：内存里攒够 40 万条 posting（约 10MB 级）就按首字分桶写一个 run 文件到 `.text-index/.build-<pid>/`，再用多路归并逐桶排序去重、剪枝、编码，最后拼成 `index.bin`。键数最多的一个桶天然 ≤ 65536（首字相同，次字组合有限），所以构建时的内存上限由「单桶 + 缓冲」决定，与语料总规模无关。合成语料实测：1 万页 / 1192 万条 posting / 106MB 索引，内存峰值从 94MB 降到 8MB，耗时基本持平（15.5s → 14.7s）；小语料（几千页）根本不会落盘。落盘路径与内存路径写出的 `index.bin` 逐字节一致（有测试盯着）。
- posting 压成 32 位数（文件下标 × 10 万 + 页码），所以单个索引最多 42949 个有文本的文件、每本 10 万页；超了构建会直接报错而不是算错页码。带文本的文件目前 10/4600。
- 索引整体是 `readFileSync` 读进内存的（主进程与每个 worker 各一份），索引到几百 MB 时加载会明显吃内存；再往上要改成按需 mmap 或分片。
- 识别模型首次使用需联网下载（约 100 MB），应用内还没有下载进度提示。
- 查询没有做分词：连写（「嘉慶贛州府志」）靠去标点的紧凑串和「书名被查询包含」反向命中，中间夹错字时仍只会落到「近似」一档。
- 小程序仍需真实 AppID、真机验收和发布流程。
- 人工校正以当前书目成员文件校验身份；解析规则大幅变化导致书目重新聚合时，校正可能被安全忽略，需要重新确认。
