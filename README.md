# 方志检索

面向地方志研究、资料收集场景的 Windows 桌面检索与阅读工具。项目把夸克分享中的地方志目录整理成可检索书目，并支持下载、PDF 在线阅读和本地 OCR 全文检索。

## 产品边界

- 当前核心是 **Windows 桌面端**：检索、筛选、下载、PDF 阅读和 OCR 文本阅读。
- 微信小程序是 **只读离线书目查询**，不提供下载、PDF 阅读和全文检索。
- 全文检索仍处于试点阶段，覆盖范围以界面显示的“全文 X/Y 文件”为准；未命中不代表原书没有该内容。
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
- 夸克 cookie 只在系统密钥服务可用时加密保存；不可用时拒绝写入明文。
- 外部链接仅允许夸克官方 HTTPS 域名；文件定位限制在下载目录内。
- 人工校正保存在本机 `userData/book-overrides.json`，不写入共享索引。
- 自动化 CDP 检查默认跳过账号与下载写操作；需要时必须在独立用户目录中显式设置 `FZ_CDP_ALLOW_COOKIE_MUTATION=1`。

## OCR

```bash
uv run tools/ocr/ocr.py --dir "下载目录" --limit 20
```

产物写入 `data/ocr/<fid>.jsonl`，并把 `textRef` / `ocrStatus` 回写索引。桌面端“工具 → 全文识别”会显示当前覆盖范围和数据目录。

## 测试与诊断脚本

- `npm test`：纯逻辑测试，不访问网络、不修改真实数据。
- `verify-search.ts`：只读检索诊断。
- `verify-index.ts`：会覆盖索引，必须显式加 `--write`。
- `verify-crawl-resume.ts`：会真实联网爬取，必须显式加 `--run`。
- `tools/cdp-probe.mjs`：默认只读界面检查；账号/下载写操作需要显式环境变量和隔离 profile。
- 使用隔离 profile 启动桌面端：

```bash
FZ_USER_DATA_DIR=.tmp/cdp-profile npx electron apps/desktop --remote-debugging-port=9333
```

## 发布

`npm run package --workspace @fangzhi/desktop` 会：

1. 复制当前 `dist/`；
2. 复制当前 `data/index.full.json`、`meta.json` 和全部 OCR 数据；
3. 生成 `resources/data/data-manifest.json`，包含应用版本、索引哈希、OCR 文件数和统计信息；
4. 生成 `release/portable-win-x64/方志检索.exe`。

发布前应执行 `npm run verify`，并核对数据清单中的 OCR 引用数与实际文件数。

## 当前已知限制

- OCR 执行仍依赖本地 Python/uv 环境，桌面端暂不内置识别运行时。
- 全文检索尚未迁移到独立 worker 或倒排索引，全库覆盖后需要进一步优化。
- 小程序仍需真实 AppID、真机验收和发布流程。
- 人工校正以当前书目成员文件校验身份；解析规则大幅变化导致书目重新聚合时，校正可能被安全忽略，需要重新确认。
