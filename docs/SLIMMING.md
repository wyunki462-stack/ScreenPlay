# 0.6.5 瘦身报告

> 前提：**不改核心业务逻辑与接口定义**、不影响构建、保留核心文档与验证脚本。
> 本文包含四件事：① 全量功能验收报告 ② 瘦身清单 ③ 瘦身前后体积对比 ④ 无回归证明。
>
> 源码树（`backend/src` + `web/src`，129 个文件）本轮结束后指纹 `cdafb82e0f15aa3f`
> （0.6.4 为 `a7bb3e34a7c330c6`）；差异只来自 5 处死代码与错误注释清理，**没有行为改动** ——
> 最直接的证据是前端产物 `dist/assets/index-DZEuyZR6.js` 的哈希与 0.6.4 完全相同。

---

## 一、全量功能验收报告

跑法（离线、零外网，前置一次 `npm run build`）见 `docs/VERIFY.md` 顶部。

| # | 功能项 | 验证方式 | 结果 |
|---|---|---|---|
| 1 | 后端编译 | `npm run build -w backend`（nest build） | ✅ exit 0 |
| 2 | 前端编译 | `npm run build -w web`（tsc && vite build） | ✅ exit 0；`dist/assets/index-DZEuyZR6.js` 537.99 kB（gzip 157.27），**与 0.6.4 同哈希** |
| 3 | 类型检查 | `npx tsc --noEmit -p backend/tsconfig.json --tsBuildInfoFile /tmp/.tsbi-backend.json`、`npx tsc --noEmit -p web/tsconfig.json` | ✅ 均 exit 0 |
| 4 | 应用启动 | 用「生产依赖子集」起 `backend/dist/main.js`（`PORT=3100 DATA_DIR=/tmp/slim/data`） | ✅ `/api/health` → 200，日志 `Ready after 1.0s` |
| 5 | 功能标记 | 上述 health 响应的 `features` | ✅ 27 个全在，含 `ratings-no-user-score`、`reviews-ui-search-sort`、`reviews-page-jump` |
| 6 | 静态前端 | `GET /` | ✅ 200 `text/html`（520 B） |
| 7 | 常规接口 | `/api/games`、`/api/settings`、`/api/library/status` | ✅ 均 200（`/api/games/recent` 404 属预期：该路由本就不存在） |
| 8 | 数据落盘与升级 | 启动后查看 `DATA_DIR` | ✅ 建表成功、schema 升级 `games.reviews_error` / `games.achievements_error`，生成 `covers/`、`previews/` |
| 9 | 媒体库扫描 | 启动日志 | ✅ `Scan complete: 2 games, 0 media files` |
| 10 | 媒体评价：抓取→解析→落库→接口 | `node backend/scripts/verify/media-reviews-e2e.mjs`（本地桩服，零外网） | ✅ 63/63（翻 6 页、66 条落库、重复抓取幂等） |
| 11 | 媒体评价解析器 | `node backend/scripts/verify/metacritic-reviews-test.mjs` | ✅ 63/63 |
| 12 | 官方接口解析 | `node backend/scripts/verify/metacritic-api-test.mjs`（零网络） | ✅ 38/38 |
| 13 | 抓取编排 | `node backend/scripts/verify/metacritic-crawl-test.mjs` | ✅ 13/13 |
| 14 | 评价分页 / 平台筛选 / 搜索 / 排序 / 点页码（需求 1–4） | `node backend/scripts/verify/requirements-ui.mjs`（真实 Chromium，file:// 自包含 bundle，不启服务） | ✅ 58/58 |
| 15 | 分页三个纯函数 | `node backend/scripts/verify/review-pagination-test.mjs` | ✅ 98/98 |
| 16 | 海报轮播归属（封面/截图、用户选择） | `node backend/scripts/verify/poster-rotation-e2e.mjs` | ✅ 16/16 |
| 17 | SSR DOM 行为 | `node backend/scripts/verify/poster-ui-ssr.mjs` | ✅ 10/10 |
| 18 | 通关时长缓存（空值不写缓存 + 重试） | `node backend/scripts/verify/duration-cache-e2e.mjs`（桩服 + 真实浏览器渲染） | ✅ 13/13 |
| 19 | 构建产物完整性 | `scripts/verify-build-artifacts.sh`（构建期在 Dockerfile 内执行） | ✅ 检查 `*.js` 齐全 |
| 20 | 镜像内原生依赖可加载 | Dockerfile 的 `node -e` 自检（better-sqlite3 内存库读写 + `require('sharp')`） | ⏳ 随用户的镜像构建执行；本地已用同一段断言复现「缺 binding 会失败」，证明它有效 |
| 21 | 已部署实例运行时/代理/图片自检 | `bash scripts/verify-image-fix.sh`（需要一个在跑的实例） | ⏳ 需在部署实例上执行，本次未跑 |
| 22 | 镜像构建与上传 | `bash scripts/docker-build.sh`、`bash scripts/push-to-ghcr.sh screenplay:latest 0.6.5` | ⏳ 本环境无 docker 权限，由用户执行 |

离线套件断言合计 **372 条，0 失败**（38+13+63+13+63+16+10+58+98）。

---

## 二、瘦身清单

### 2.1 依赖

| 位置 | 改动 | 依据 |
|---|---|---|
| 根 `package.json` | 删 `dependencies.playwright-core`；`playwright` 进 `devDependencies` | 代码里零 `import` 浏览器自动化库；离线套件要真实 Chromium，属开发期依赖 |
| `backend/package.json` | 删 `@nestjs/serve-static` | 从未被 import；静态资源走 `backend/src/main.ts:58 app.useStaticAssets(webDist)` |
| `web/package.json` | 删 `devDependencies.playwright` | 套件都在 `backend/scripts/` 下运行，web 工作区不需要 |
| `package-lock.json` | 重新生成（`npm install --package-lock-only`） | 只少了 `node_modules/@nestjs/serve-static` 及其嵌套 `path-to-regexp` |

**保留但已核实用途**（不是漏删）：`plyr`（`web/src/components/VideoPlayer.tsx:4` 引 `plyr/dist/plyr.css`）、
`prop-types`（`plyr-react` 的 esm 入口引用）、`reflect-metadata` 与 `rxjs`（`@nestjs/core@10.4.22` 的
peerDependency）。

### 2.2 构建配置

- `backend/tsconfig.build.json`：`sourceMap: false`、`incremental: false` —— 镜像里少 73 个 `.map`
  （约 0.4 MB）与 `tsconfig.build.tsbuildinfo`（198171 B）。`declaration` 必须保留（构建产物断言会 grep `.d.ts`）；
  `backend/tsconfig.json` 的 `sourceMap: true` 保留（开发需要）。
- `web/vite.config.ts:24` 本来就是 `sourcemap: false`，无需改动。
- `Dockerfile`（`run` 阶段）：`npm prune --omit=dev --no-audit --no-fund` 之后再删掉只有前端运行时
  才需要的包（`react`、`react-dom`、`react-router-dom`、`@tanstack`、`lucide-react`、`plyr`、
  `plyr-react`、`react-photo-view`；`backend/dist` 里没有任何 `require()` 指向它们），并打印
  `[slim] node_modules: <体积>`；随后按需 `npm rebuild better-sqlite3`，再跑原生依赖自检。
  - **不带 `--ignore-scripts`**：prune 会 reify 整棵树，一旦它重装含原生代码的包，`--ignore-scripts`
    会留下「装好了但没有编译产物」的包（本地已复现该坑）。

### 2.3 文件（删除 37 个跟踪文件 + 未跟踪残留）

- `scripts/`（12 个）：`verify-round-{d,e,f,g,k,l}.sh`、`verify-all-games.mjs`、
  `verify-media-reviews-ui.mjs`、`verify-media-reviews.sh`、`verify-poster-config.mjs`、
  `verify-rotation-state.sh`、`verify-ui-change.sh`。
- `backend/scripts/verify/`（6 个）：`round-{e,f,g,k}-backend.mjs`、`round-f-merge.js`、`merge.cjs`。
- `backend/scripts/achievements/`（19 个跟踪文件 + 44 MB 未跟踪产物）：`.gitignore`、
  `manual-target.mjs`、`run.sh`、`steam-contract.mjs`、`trophy-degrade.mjs`、`trophy-retry.mjs`、
  `ui/.gitignore`、`ui/entry-{e,f,g,k}.tsx`、`ui/package.json`、`ui/round-{e,f,g,k}-ui.js`、
  `ui/test-ui.js`；未跟踪部分是它自带的 `ui/node_modules`（2708 个文件）等一次性产物。
- 未跟踪临时目录：`.tmp-b`、`.tmp-mr`、`.tmp-mrui`、`.tmp-real`、`.tmp-rf`、`.tmp-rot`、
  `.tmp-round-d`（以及测试跑完剩下的 `.tmp-mr`、`.tmp-rot`）。
- **移动而非删除**（不计入 37）：
  - `backend/scripts/achievements/sqlite-shim.js` → `backend/scripts/verify/sqlite-shim.js`
    （本机没有编译产物时给 `node:sqlite` 用的兼容垫片；3 处引用同步改路径）。
  - `docs/UPLOAD-0.6.4.md` → `docs/UPLOAD.md`（去掉版号）。
  - `.tmp-b/pw`（554 MB 的 Playwright 浏览器）→ `.pw/`（`.gitignore` 已忽略；4 处引用改路径）。
- 前置已合并：根目录与 `scripts/` 下重复的 `push-to-ghcr.sh` 已在提交 `345d800` 合并。

**删除的脚本覆盖在哪里**（删之前逐条确认有替代者）：

| 删除的 | 现在由谁断言 |
|---|---|
| `verify-round-*.sh`（需求 1–8 的轮次验收） | `requirements-ui.mjs`（需求 1–4，真实 Chromium）、`review-pagination-test.mjs`、`media-reviews-e2e.mjs`、`poster-rotation-e2e.mjs`、`poster-ui-ssr.mjs`、`duration-cache-e2e.mjs` |
| `verify-media-reviews-ui.mjs` | `requirements-ui.mjs` 的 `[data-testid="media-reviews-search" / "-sort" / "-page-numbers"]` 断言（:458/:459/:486/:527/:548） |
| `verify-all-games.mjs`、`verify-poster-config.mjs`、`verify-rotation-state.sh` | `poster-rotation-e2e.mjs` + `scripts/verify-image-fix.sh` |
| `backend/scripts/achievements/*`（Steam 成就契约/降级/重试的临时工具） | 不属产品功能，且未被任何套件、文档或脚本引用 |

### 2.4 结构整理与文档

- `docs/VERIFY.md` 顶部跑法重写为两段：**A 离线套件清单**（含 `npm run build` 前置）+ **B 已部署实例自检**
  （`scripts/verify-image-fix.sh`），并注明「一次性轮次脚本已在 0.6.5 瘦身中删除，覆盖改由离线套件承担」。
  正文里的历史命令与数字**故意保留为历史记录**。
- `README.md:580-594`：本轮验收段标题与期望版本改为 0.6.5，并注明「0.6.5 是瘦身版，界面/接口/数据行为与
  0.6.4 完全一致（前端 bundle 哈希都相同），区别只在镜像体积」。
- `docs/UPLOAD.md`：版号无关（`V=$(node -p "require('./package.json').version")`），删掉两个已过期的
  产物 sha256，改为「以本机 `sha256sum` 为准」。
- `CHANGELOG.md`：新增 `## [0.6.5]`。
- 保留不动的结构：`flutter/`（README 有说明）、根目录 `fetch-and-build.sh` 与 `transfer-image.sh`
  （被 `screenplay.yml`、README、docs、`scripts/package-image.sh`、`scripts/push-to-ghcr.sh` 以根相对路径引用）、
  `scripts/verify-image-fix.sh`（`docs/VERIFY.md` 入口 + `scripts/docker-build.sh` 提示）。

### 2.5 代码清理（5 处，全部通过类型检查）

- `backend/src/media/media-processor.service.ts`：删未使用的 `decodeJxr` 导入。
- `backend/src/media/streaming.service.ts`：删死字段 `chunkSize`（`1024 * 256`，从未被读取）。
- `backend/src/library/game-recognizer.service.ts`、`backend/src/games/media-reviews.service.ts`、
  `backend/src/metadata/providers/igdb.provider.ts`：删未使用的 `Logger` 字段与对应导入。
- `web/src/components/HeroPosterCarousel.tsx:9`：注释还在引用已删除的 `ScreenshotCarousel`，
  改为「旧的截图轮播」。
- `backend/src/maintenance/maintenance.service.ts`：删掉从未被写入的 `ROTATION_MARKER` 常量，
  并把两处「声称会写版本标记」的注释改成真实行为（只有 `repairDurations` 用版本标记；
  海报轮播修复故意每次启动都跑，因为它便宜、幂等，且目标集合会随新增游戏变大）。
- 扫描结论（子代理，128 个 `.ts`/`.tsx`、24592 行、397 个导出符号）：`backend/src` 与 `web/src` 内没有
  `console.*`/`debugger` 调试残留，也没有零引用的导出符号。

**发现但故意不改**（改了就是改业务逻辑，超出瘦身范围）：

1. `backend/src/metadata/metadata.service.ts:791-795` 有一段死代码 `poster`，其上方注释承诺
   「本地已有海报时不覆盖」，但实际 SQL 是 `:814 poster_url = COALESCE(?, poster_url)` 且
   `:832` 传 `fragment.poster ?? null` —— 只要 provider 给了海报，用户自定义的外链海报就会被覆盖。
   **疑似真实缺陷，建议单独确认后再修。**
2. 6 组重复逻辑只记录不重构：metacritic 关键词变体（`metacritic-aliases.ts:192` ↔
   `metacritic.provider.ts:244`）、平台回退三连（`GameCard.tsx:19` ↔ `GameDetail.tsx:112` ↔
   `games.service.ts:191`）、评分色调（`RatingPickDialog.tsx:27` ↔ `lib/utils.ts:7`）、Escape 关闭
   （`PlatformDialog.tsx:28-34` ↔ `PosterDialog.tsx:87`）、轮播定时器（`HeroPosterCarousel.tsx:22` ↔
   `PosterCarousel.tsx:21`）、代理探针（`proxy-config.ts:363-372` ↔ `:375-384`）。它们都在核心链路上，
   重构收益低于风险。

### 2.6 明确没动的东西

核心业务逻辑、接口定义、`userScore`/`userCount` 的后端解析（接口与离线测试仍在使用）、
CHANGELOG 历史条目、官方文档正文（只加说明，不删历史）。

---

## 三、体积对比

| 口径 | 瘦身前 | 瘦身后 | 变化 |
|---|---|---|---|
| 跟踪文件数 | 269 | **232** | −37 |
| 跟踪文件改动量 | — | — | `57 files changed, 112 insertions(+), 5350 deletions(-)` |
| 仓库内容（排除 `.git`/`node_modules`/`.pw`/`dist-image`） | 7.5 MB | **5.1 MB** | −2.4 MB |
| `backend/dist` | 73 `.js` + 73 `.map` + `tsbuildinfo` | 73 `.js` + 73 `.d.ts` | −0.4 MB（源映射） −198 KB（增量信息） |
| `node_modules` 生产子集 | 266 MB（表观）/ 359 MB（占用） | **97 MB（表观）** | ≈ −64% |
| 同口径 `node_modules` tar.gz（gzip -6） | 61 MB | **25,570,655 B（≈25 MB）** | ≈ −58% |
| 顶层包数（生产子集） | 231 | 222 | −9 |
| 镜像体积 | **571.9 MiB**（实测） | **386.6 MiB**（推算，待本机构建复核） | **−32.4%** |

### 镜像体积：实测 vs 推算

**瘦身前（实测）**：0.6.4 在 GHCR / Docker Hub 都是 13 层，媒体类型全部是
`application/vnd.oci.image.layer.v1.tar`（**未压缩 tar**），各层字节数
`8,704,000 / 155,819,008 / 5,388,288 / 3,584 / 44,032 / 1,536 / 131,471,360 / 2,048 / 4,096 /
1,644,032 / 295,958,528 / 625,152 / 2,560`，合计 **599,668,224 B（571.9 MiB）** —— 与 Docker Hub
同一 digest 报的 `full_size` 完全一致。

- 最大层 `sha256:a958e970…`（295,958,528 B = 282.2 MiB）就是 `node_modules`：把该层 blob 经本地代理
  拉下来核对，35,578 个条目全部在 `app/node_modules/` 下，内容是 0.6.4 的**全量依赖树**。
- 顺带纠正一个此前的猜测：该层里**没有** Playwright 浏览器（无 `ms-playwright`、无 `chrome-linux`）；
  名字里带 "chromium" 的 32 个文件都属于 `electron-to-chromium` 这个数据包。所以「282 MB 那层含
  浏览器」的怀疑不成立，它就是全量 node_modules。

**瘦身后（推算，方法可复核）**：不再猜比例，而是直接在这层真实内容上做字节级核算 —— 逐条统计
「层内条目 512 B 头 + 文件按 512 B 对齐」的费用，减去不属于生产子集的包。核算模型自检：按同一模型
重算整个层得到 295,956,992 B，与真实值只差 1,536 B。再按平台差异修正（层里是 musl 的
`@img/sharp-libvips-linuxmusl-x64` + `@img/sharp-linuxmusl-x64` 共 16.06 MiB，是 sharp 的运行时
二进制，必须保留；被误判的 `@esbuild/linux-x64` 9.26 MiB 与 `@rollup/rollup-linux-x64-musl` 2.08 MiB
确属开发工具链，照删）：

- `node_modules` 层：295,958,528 B → **101,669,376 B（97.0 MiB）**，降幅 65.7%
- 镜像总量：599,668,224 B → **405,379,072 B（386.6 MiB）**，**降幅 32.4%**

被删掉的 201 MiB 主要是开发工具链与只给前端用的包：`lucide-react` 25.9、`typescript` 22.6、
`@nestjs/cli` 22.2、`@angular-devkit/{core,schematics}` 12.9、`@esbuild/linux-x64` 9.3、
`playwright-core` 7.4、`tailwindcss` 5.6、`webpack` 5.5、`plyr` 5.2、`@tanstack/*` 5.3、
`react-dom` 4.3 MiB 等。本地独立复核方向一致：同格式 tar 打出的生产子集 103.8 MiB（比推算略大，
因为本地树含 glibc 版 sharp 二进制，镜像里是 musl 版）。

> 一句提醒：0.6.4 的层是**未压缩**推上去的，所以 registry 的存储/拉取量就是 572 MB。若把推送改成压缩层
> （`docker buildx build --push --compression=gzip`，或推完用 skopeo/crane 转换），同内容的传输量会降到
> gzip 后的量级（本地全量树 gzip 后 61 MiB、瘦身后 25.5 MiB）—— 这只影响传输与 registry 存储，不影响
> `docker image ls` 的数字。要不要做由你定。

---

## 四、无回归证明

1. **构建**：`npm run build` exit 0；前端产物 `index-DZEuyZR6.js` 与 0.6.4 **同哈希** ——
   哈希相同即证明前端代码零改动。
2. **类型**：后端、前端两个 `tsc --noEmit` 均 exit 0。
3. **测试**：9 个离线套件 / 372 条断言 0 失败（逐套件数字见第一节）。
4. **运行**：用生产依赖子集启动完整应用 → `/api/health` 200 + 27 个 feature 标记齐全，
   静态前端 200，数据库建表与 schema 升级正常，媒体库扫描正常。
5. **指纹**：`backend/src` + `web/src` 共 129 个文件 = `cdafb82e0f15aa3f`；与 0.6.4 的
   `a7bb3e34a7c330c6` 的差异只来自 2.5 节的 5 处死代码/注释清理。
6. **镜像内自检**：Dockerfile 构建期跑构建产物断言 + 原生依赖读写自检，任一步失败即构建失败。

---

## 五、遗留与后续

1. 镜像体积的**实测值**需你执行 `bash scripts/docker-build.sh` 后用 `docker image ls` 取（本环境无
   docker 权限）；第三节给出的是在同一份真实镜像层内容上做字节级核算的推算值 386.6 MiB（−32.4%）。
2. 可选优化：把镜像层改成压缩推送（见第三节末的提醒），能再省一大截传输与 registry 存储量。
3. `metadata.service.ts` 海报覆盖问题疑似缺陷（见 2.5），建议单独确认后修。
4. 6 组重复逻辑只报告未重构（见 2.5）。
5. `docs/VERIFY.md` 正文历史命令保留；新跑法在文件顶部。
6. 线上确认项：007《初露锋芒》页点「重新抓取媒体评价」应从 1 条变为约 99 条；
   详情页评分区去掉「用户评分」、评价面板的页码跳转、搜索与排序三项界面改动需用户验收。

**回滚**：本轮改动都在 git 工作区，`git revert`/`git checkout HEAD -- <path>` 即可还原；
本节唯一的例外是被删的 `backend/scripts/achievements/`（HEAD 里仍在，
`git checkout HEAD -- backend/scripts/achievements` 可整体恢复）。