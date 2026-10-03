# `1.3.0` 性能优化报告（Linux 端：内存 / 镜像 / 磁盘）

本轮只做一件事：在不改变功能、交互、数据结构与接口的前提下，降低运行内存、镜像体积与磁盘占用。
所有改动随 **`1.3.0`** 发布（版本号从 `1.2.0` 升到 `1.3.0`，其余一律不变），部署命令与使用方式完全不变。

配套数据文件：

| 文件 | 内容 |
| --- | --- |
| `docs/perf/before-local.txt` | 优化前宿主侧基线（产物体积、web/dist 资产明细） |
| `docs/perf/after-local.txt` | 优化后宿主侧实测 |
| `docs/perf/suites-before.txt` | 优化前 11 套离线套件 + 产物自查结果 |
| `docs/perf/suites-after.txt` / `docs/perf/suites-after2.txt` / `docs/perf/suites-after3.txt` | 优化后（三轮：主体改动后、死代码清理后、卡帧改缩略图后） |
| `docs/perf/suites-final.txt` | **最终全量回归**（所有改动落定后，11 套件 + 产物自查，0 失败） |
| `docs/perf/suites-after-batch.txt` | 评分目标批量读之后的再一轮全量回归（含端点级排序修复与死代码清理） |
| `docs/perf/suites-after-queries.txt` | 列表查询批次化 + 测试库锁硬化之后的全量回归（14 项全绿） |
| `docs/perf/suites-final-post-script-edits.txt` | 用户侧脚本预检加固之后的全量回归（14 项全绿，198s）—— 那次改动只碰了 `scripts/` |
| `docs/perf/suites-after-vacuum-code.txt` | 可选启动期 `VACUUM`（优化项 15）落地之后的全量回归（14 项全绿，218s）—— 那时还没把 `sqlite-vacuum` 加进套件列表 |
| `docs/perf/suites-after-vacuum.txt` | `VACUUM` + 新增 `sqlite-vacuum` 套件之后的全量回归（15 项全绿，216s） |
| `docs/perf/suites-after-docker-layers.txt` | 运行阶段逐文件 COPY + Dockerfile 分层自查接入之后（16 项全绿，216s；那时自查 24 项、run 阶段仍是 node 基础镜像） |
| `docs/perf/suites-after-run-base.txt` | 运行阶段换最小基础镜像（优化项 16）+ 分层自查扩到第 9 组之后（16 项全绿，213s；分层自查 30 项 —— 该脚本其后扩到 33 项，见 5.1） |
| `docs/perf/suites-after-audit-fixes.txt` | 独立审计复查后的 3 处加固 + 1 处撤回（`Accept-Encoding` 的 q 值协商、`wal_checkpoint` 兜底、`proxied/` 清扫可关、空闲轮询回退原值）之后（16 项全绿，233s；分层自查当时 30 项）—— 详见 5.8 |
| `docs/perf/suites-after-context.txt` | 构建上下文瘦身（`.dockerignore` 新增 `.pw` / `.pw-cache`）+ 分层自查扩到 32 项之后（16 项全绿，204s；分层自查 32 项） |
| `docs/perf/suites-after-alpine-324.txt` | 运行阶段基础镜像钉回 `alpine:3.24`（消除 ffmpeg 漂移）+ 分层自查扩到 **33 项**之后（**16 项全绿**，210s；分层自查 **33 项**）—— 详见 5.1 |
| `docs/perf/suites-after-thumb-audit.txt` | 补完方向②剩余点名项（缩略图无损压缩可行性实测 + 日志轮转留档）之后重跑（**16 项全绿**，229s；434 断言 / 产物 38 命中 / 分层 **33 项**）—— 详见 5.1 |
| `docs/perf/suites-release-1.3.0.txt` | **最新全量回归**：版本号升到 `1.3.0`（版本号 / 文档 / 脚本 / 清单同步）之后的**发布前最后一跑**（**16 项全绿**，213s；434 断言 / 产物 38 命中 / 分层 **33 项**）—— 详见 5.1 |
| `docs/perf/suites-after-queries-flake.txt` | 批次化后首跑撞上测试自身锁抖动的留档（`database is locked`，已修，见 5.1） |
| `docs/perf/before-docker.txt` | **优化前容器侧实测**（真机跑 `perf-baseline.sh`，2026-10-03 11:50，未重建的 1.2.0 容器）：镜像体积 / 层数 / 内存峰值 / `/data` 占用 / SQLite PRAGMA / 12 条热接口耗时，55 个 `KEY=VALUE` |
| `docs/perf/after-docker.txt` | **优化后容器侧实测**（同日 11:57，重建后）：同上 55 个键，键名与 before 逐行一致（便于 diff 与自动对比） |
| `docs/perf/compare.md` | **交付 1 的三项对比表**：`scripts/perf-compare.sh` 读上面两份基线生成（镜像体积 / 运行内存峰值 / 磁盘占用 + SQLite 与热接口附录），另见 §3.1 末尾、§3.2、§3.3 的文字版 |
| `docs/perf/list-path-bench.txt` | 列表接口新旧实现的基准实测输出（SQL 条数 / 物化文本 / 峰值内存 / 端点级计数） |
| `docs/perf/baseline-dryrun-keys.txt` | `perf-baseline.sh` 六节逻辑干跑（假 docker CLI 罐装输出）的 54 个 `KEY=VALUE` 键 —— 只为验证脚本自身，**不是真实测量数据** |
| `docs/perf/leak-soak.txt` | 长跑 / 泄漏扫描原始输出（3000 次请求的 RSS、V8 堆、活跃句柄、SQL 形状数采样表） |
| `docs/perf/list-path-queries.txt` | 列表路径「查询批次化」前后逐条对比：每条接口的 SQL 条数、响应字节、sha256 指纹（12 条全部逐字节相同） |
| `docs/perf/maintenance-reclaim.txt` | 启动回收（维护）端到端验证输出：造过期缓存行 + 孤儿衍生件 + 用户上传海报，真启动一次，逐条断言删了什么、留了什么、回收多少字节 |
| `docs/perf/query-plans.txt` | 19 条热点 SQL 的 `EXPLAIN QUERY PLAN` + 索引清单 + 各表行数（只读采集，见 5.7）—— 回答「索引够不够」，结论是够，未新增索引 |
| `docs/perf/dependency-audit.txt` | 18 个后端 runtime 依赖的逐个使用核对 + 0 命中的两个为什么必须留 + 前端依赖为何不进镜像（见方向 ③） |
| `docs/perf/heap-flags.txt` | **方向① Node 堆参数的实测原始输出**：`NODE_OPTIONS` 四个变体（默认 / `--max-semi-space-size=8` / `--max-old-space-size=256` / `--max-semi-space-size=32`）各跑同一份 1200 次请求负载的 RSS、V8 堆、耗时与句柄 —— 结论是**不加参数**（见 7 的对应行） |
| `docs/perf/apk-parity.txt` | **换基线的包级等价性核对原始输出**（见 3.1.2）：123 个 before 包 / 16 个 rootfs 包 / 113 个依赖闭包 / 四条断言全过 |
| `docs/perf/thumb-compression.txt` | **缩略图「无损高压缩」可行性实测**（方向②点名项，见优化项 9 末条）：gzip −0.8% / brotli −1.2% / 无损 WebP 重编码 +308.5% / 降质量 −12.0% —— 结论是不做 |
| `docs/perf/log-rotation.txt` | **日志上限 + 轮转的留档**（方向②点名项）：两份 compose 的 `logging:` 原文行号、`docker compose config` 解析结果、两份 `config -q` 退出码 0、`--numstat` 10/0 与 9/0（只增不删）、上限换算 10m×3 = 30 MiB/容器 |
| `docs/perf/RUN-ON-HOST.md` | 给你（宿主机侧）的操作卡：容器侧 before/after 的四步命令、只读性说明、交接方式、故障排查表 |
| `scripts/perf-baseline.sh` | 上述两个容器侧文件的采集脚本（只读，不改任何东西） |
| `scripts/perf-compare.sh` | 把上面两份容器侧基线拼成前后对比表（只读这两个文件，不碰 docker） |
| `scripts/perf-bench/apk-parity.py` | **换基线的包级等价性核对脚本**（纯宿主 python3 + curl，只读网络、不需要 docker）：下载 minirootfs 与 v3.24 的 main/community APKINDEX（缓存到 `--cache-dir`），解析出「rootfs 包清单 / 依赖闭包 / before 的包在新仓库里的状态」，跑 4 条断言（见 3.1.2），通过 exit 0 —— 这是「换 `alpine:3.24` 不会装错包」的可复现证据 |
| `scripts/verify-suites.sh` | 一键跑离线全量回归（2 个类型检查 + 12 套件 + 产物自查 + Dockerfile 分层自查，共 16 项），产出 `docs/perf/suites-*.txt` |
| `scripts/verify-docker-layers.mjs` | Dockerfile / `.dockerignore` / `apk-setup.sh` 的**分层静态自查**（9 组 33 项，不需要 docker）：同层删除、「加完即删」跨层白洞、目录 COPY 带进无用文件、`apk add` 必须 `--no-cache`、运行阶段不得出现 build 工具 / 开发依赖、部署契约断言、build 阶段必须删 `node_modules` 非运行期文件、运行阶段不得删 COPY 进来的载荷、运行阶段必须是「最小 alpine + 只拷 node 二进制 + `libstdc++`」 —— 见优化项 11 与 16 |
| `scripts/perf-bench/` | 基准 / 长跑 / 回收 / 索引验证脚手架（11 个脚本）：`seed-bench-db.js`（列表基准的 500 局库）、`bench-list-path.js`（SQL/文本/耗时）、`bench-peak-memory.js`（进程峰值）、`seed-soak-db.js`（富 schema 库：表结构抽自 `migrate()`，500 局 + 1500 张真实 JPEG）、`soak-server.js`（观测桩：SIGUSR1 内存快照 / SIGUSR2 SQL 计数）、`bench-soak.sh`（长跑扫描驱动）、`bench-maintenance.sh`（回收端到端验证）、`seed-plan-db.js`（把基准库复制一份并给所有稀疏表填合成行，供执行计划核对）、`query-plans.js`（只读 `EXPLAIN QUERY PLAN` 采集）、`apk-parity.py`（换基线的包级等价性核对，见 3.1.2）、`thumb-compress.js`（缩略图无损压缩可行性实测，见优化项 9 末条） |

---

## 〇、四项交付对照（你要的东西在哪）

| 交付 | 状态 | 在哪 |
| --- | --- | --- |
| 1. 运行内存峰值 / 镜像体积 / 磁盘占用 的**优化前后对比** | **已完成**（宿主侧 + 端点侧 + 容器侧三套都实测了） | **容器侧对比表 = `docs/perf/compare.md`**（由 `docs/perf/before-docker.txt` → `docs/perf/after-docker.txt` 一条命令生成，2026-10-03 真机采集）：镜像 **386.8 → 322.1 MiB（−16.72%）**、层合计 406.3 → 337.6 MiB（−16.91%）、层数 13 → 12、VmHWM 153.3 → 152.5 MiB、同口径 60 请求内存增量 RSS −65.7% / cgroup −58.8%、`/data` 311.4 → 304.0 MiB（−2.4%）、空闲态 WAL 4.1 MiB → 156.9 KiB；逐项说明见 §3.1 末尾、§3.2、§3.3。宿主侧 / 端点侧见 §3.2、§3.3 与 §5.3–§5.6，镜像 before 另有 registry 直读旁证（§3.1.1） |
| 2. **优化项 + 改动文件 + 依赖变更**清单 | 已完成 | 优化项 1–16 见 §二（按四个方向分组）；改动文件清单与逐类归属见 §九（**101 个文件改动，+21383 / −233**，含 36 个 `docs/perf/` 实测留档与 11 个 `scripts/perf-bench/` 基准脚本）；依赖变更见 §四 —— 结论是**零新增、零升级、零移除**运行期依赖；换基线的**包级等价性**另有可复现证明（§3.1.2：123 个 before 包在新仓库里一个不缺、闭包 113 个包零新增）；方向②点名的两个子项各有留档 —— 日志上限+轮转 `docs/perf/log-rotation.txt`（30 MiB/容器，两份 compose 校验退出码 0）、缩略图「无损高压缩」`docs/perf/thumb-compression.txt`（实测负收益，结论是不做） |
| 3. **全量功能回归 + 数据兼容** | 已完成 | §5.1：一键 `bash scripts/verify-suites.sh` **16 项全绿 / 434 断言**（最新日志 `docs/perf/suites-release-1.3.0.txt`，213s）；接口响应逐字节相同见 §5.6，DDL 只追加、`data/` 与上传海报零误删见 §5.4 / §5.5；`alpine:3.24` 这一改的包级等价性见 §3.1.2（不需要 docker 也能复跑） |
| 4. **部署命令与使用方式不变** | 已完成 | §六：`docker compose up -d` / `pull` / `up -d --force-recreate` / `scripts/rebuild-and-verify.sh` 用法完全不变；新增的只是**可选**环境变量（`PROXIED_CACHE_TTL_DAYS`、`MAINTENANCE_VACUUM` 等），不设时行为同 1.2.0 |

---

## 一、硬约束

> 所有现有功能、交互逻辑、数据结构、接口完全保持不变，仅做内存与存储占用优化，不得造成任何功能退化。

据此**冻结**（本轮一行未改）：HTTP API 形状 / DTO / 状态码、DDL 与 migrations（只允许追加
`addColumnIfMissing`）、`configuration.ts` 默认值、`JXR_PIPELINE_VERSION = 2`、依赖版本（不新增、不升级）、
`GamesService.cardPosters`、两套轮播的取数与交互、`useRotationTimer` 3500ms、`usePosters` 的 `refetchOnMount: "always"`、
`apiFetch` 的 401 事件流、`LazyImage` 的 IntersectionObserver 语义、`streaming.service.ts` 的 Range 支持。

**静态产物的 `Cache-Control` 需要单独说清**：`app.useStaticAssets(webDist)` 原来没有传选项，Express 默认
`public, max-age=0`；本轮按方向 ④「缓存策略」把它改成分档（优化项 10）——`/assets/*` 是 Vite 内容哈希命名，
发 `public, max-age=31536000, immutable`；其余（`index.html`、`favicon.svg` 等）保持 `no-cache`，也就是
「重新部署后刷新即拿到新版」这条语义没变。它是本报告里唯一一处**响应头变化**，回退点只有
`backend/src/main.ts` 的 `setHeaders` 一处；实测见 5.2。

**三个需要点名的可见 / 行为变化**：

1. 首页卡片轮播的 media 帧由完整 `/preview` 改用同一张图的缩略图（优化项 7）—— **你已经当面确认并接受**
   （卡片上那几帧变软）。后端载荷、API、其余界面一律未动，回退点只有 `web/src/components/GameCard.tsx`
   里的 `cardFrame()` 一处。
2. 运行阶段的基础镜像由 `node:22-alpine` 换成 `alpine:3.24` + 只 `COPY` 一个 node 二进制（优化项 16）——
   **你已经点头**。容器里因此**没有 npm / corepack**；基础镜像的 alpine 版本取的是**与构建阶段
   `node:22-alpine` 同版本**（3.24.2，也就是现状容器跑的那版），所以 `ffmpeg 8.1.2-r0` /
   `libstdc++ 15.2.0-r5` 与现状**完全同包版本**（若按早前误写的 3.22 构建，ffmpeg 会降到 6.1.2-r2 —— 已修）。
   功能面已逐条核对（本仓没有任何脚本或文档在容器内跑 npm；原生模块仍是同一套 musl libc + Node v22 ABI），
   回退是一行 `FROM`。属**构建结构改动**，宿主无 docker ⇒ 必须由真机构建验证（`scripts/rebuild-and-verify.sh`）。
3. 前端按需加载带来的**首帧占位**（优化项 6）：`GameDetail` / `Settings` / `VideoPlayer` 改成 `lazy()`，
   首次进入这几屏会先显示一帧 loading（视频那处是空白），卡片帧也从「全部预取」变成「滚到才取」。
   方向 ① 点名了「大对象按需加载」，所以这是本轮主动做的取舍：省的是解码后的位图内存与首屏传输，
   代价是首次进入这几屏多一次 chunk 往返。回退点：`web/src/App.tsx:25-26` 的两个 `lazy` 与
   `web/src/components/PosterCarousel.tsx:218` 的 `loading="lazy"`。

**一处已撤回的改动**：`web/src/api/hooks.ts` 的**空闲轮询降频**（`useMetadataStatus` 5s → 15s、
`useDurationCoverage` 20s → 30s）已按硬约束回退，两个间隔保持优化前的 5000 / 20000 ms —— 它只省空闲请求，
不省内存也不省磁盘，却会让「别的客户端造成的变更」更晚出现在我们的界面上。一行版本见 §八。

**第九轮补的一处构建侧改动（不进运行镜像，运行时零影响）**：`.dockerignore` 新增 `.pw` / `.pw-cache`
排除项 —— 构建上下文从 555.0 MiB / 363 个文件降到 2.0 MiB / 216 个文件（省掉每轮白传的 553.0 MiB
Playwright Chromium，它只给宿主机上的浏览器套件 `duration-cache-e2e` / `requirements-ui` /
`scripts/verify-browser.mjs` 用；见优化项 12）；同一条排除项已由
`scripts/verify-docker-layers.mjs` 第 5 组固化为断言（连同 `windows`），分层自查因此 30 项 → **33 项**
（第 5 组 +2、第 9 组新增 alpine 版本钉死那条 +1）。

---

## 二、优化项清单

### 方向 ①：运行时内存

#### 1. 列表接口 N+1 查询（真实请求 651 → 102 → 4 条 SQL，端点实测）

* 文件：`backend/src/games/games.service.ts`、`backend/src/metadata/rating-target.service.ts`
* 原来（两处 N+1，同一次请求里叠加）：
  1. `arrange()` 先 `SELECT * FROM games` 读全表，然后对**每一行**调一次 `media.countByGame(r.id)`
     拼 `mediaCount`（HEAD 版 `games.service.ts:1144`），最后才 `slice` 出 50 条分页 ——
     500 个游戏时共 501 条 SQL，其中 500 条是在为「马上会被丢掉的行」做无用功。
  2. 同一段排序键里，每一行还要一次 `SELECT * FROM rating_targets WHERE game_id = ?`
     （手工评分目标，`rating-target.service.ts:52`），出页的 50 张卡片再各查一次 ——
     500 行 + 50 卡 = **550 条 SQL**。这条在副本基准里没被建模，是端点级计数才暴露出来的。
* 现在：新增轻量投影常量 `GALLERY_COLUMNS`（17 列）与 `arrange(): GalleryEntry[]`，一次
  `SELECT ${GALLERY_COLUMNS} FROM games` 取全量，在内存里 filter → 生成排序键 → 排序 → 分页；
  `mediaCount` 仅在 `sort === 'mediaCount'` 时才逐行查询。排序键与 summary 共用同一取值路径
  （新私有方法 `resolveRating()`），保证「按分数排序」与「卡片上显示的分数」不可能分叉。
  评分目标新增 `RatingTargetService.all()`：整表读一次成 `Map<game_id, RatingTarget>`，由 `list()`
  一次取出、排序与出页共用（`rating_targets` 每局最多一行、只在用户手工选过评分时才有，很小）；
  `resolveRating()`/`toSummary()`/`toSortKey()` 多一个可选的 `manualTargets` 参数，
  详情页等单行路径不传、行为一字不变。
* **再进一步：出页的逐卡查询也批量化**。分页切片后，用这一页的 50 个 id 一次取回全部卡片海报行与媒体
  计数（`cardPosterRows()` / `mediaCounts()`，`ID_CHUNK = 400` 一批，兼容老 SQLite 的 999 变量上限；
  同一局的行走同一个批次，局内顺序不变）。`cardPosters()` 与 `toSummary()` 各多一个可选的预取参数
  （`SummaryPrefetch`），**函数体、去重与兜底逻辑一字未改**，只是行来自批量查询而不是每卡一次；
  `toSortKey()` 的第二个参数由布尔改成 `Map<string, number> | null`，`sort=mediaCount` 时对**全部匹配行**
  批量取计数，而不是 500 行各查一次。详情页等单行路径不传预取，走的仍是原查询。
* **实测（副本基准）**（`scripts/perf-bench/`，500 局 / 1500 媒体，两组同口径；完整输出见
  `docs/perf/list-path-bench.txt`）：SQL 501 → 1 条（−99.8%）、单请求物化的字符串
  **1,640,970 B → 109,170 B（−93.3%）**、5 次中位耗时 10.3–10.6 ms → 4.4–5.2 ms（−49%～−58%）。
* **实测（真实后端 + HTTP）**：新 dist 起在 500 局种子库上，单次 `GET /api/games?limit=60`
  共 **651 → 102 条 SQL（−84%）**（games 投影 1、rating_targets 550→1、卡片海报 50、媒体计数 50），
  响应仍是 50 卡 / 34,150 B，耗时 0.010–0.016 s；手工评分优先级逐条核对正确
  （`Game 0` → 99/`metacritic`，`Game 1` → 77/`metacritic-SWITCH`）。
* **实测（批次化后，同一份 500 局种子库快照）**：12 条接口的**响应体字节数与 sha256 逐字节一致**，
  SQL 102 → **4**（默认排序：games 投影 1 + rating_targets 1 + 海报行 1 + 媒体计数 1），
  最坏情况 `sort=mediaCount` 602 → **6**；详情 13、neighbors 2、媒体列表与缩略图 1 均未变。
  逐条对比见 `docs/perf/list-path-queries.txt`。
* 为什么列投影能省内存：`games` 表带 `summary` / `screenshots` / `voice_actors` / `prices` / `ratings` 等
  TEXT 列，500 行合计约 1.5MB；旧实现把每个请求的这批文本都读进内存再丢掉。
* 分页结果与排序顺序逐字节不变（画廊那条查询的计划文本就是 `SCAN games`，即 rowid 顺序；`games` 上那几个
  索引只服务于按 `id` / 唯一列的查找，投影不会改变行序 —— 见 5.7 的 `docs/perf/query-plans.txt`）。

#### 2. prepared statement 缓存

* 文件：`backend/src/database/database.service.ts`
* 新增 `private prepare(sql)`：`Map<string, Statement>` 命中即复用，`STATEMENT_CACHE_LIMIT = 512`，溢出整体清空
  （有界，避免长尾 SQL 把句柄堆爆）；`run/get/all` 全部走它。
* 收益：不再为每次查询重新编译 SQL 语句（同一 SQL 的编译结果与绑定在 better-sqlite3 里是珍贵资源）。

#### 3. SQLite PRAGMA 调优（不触碰 durability 语义）

* 文件：`backend/src/database/database.service.ts` → `onModuleInit`
* `busy_timeout = 5000`：并发写（扫描器 + 请求）不再立刻抛 SQLITE_BUSY。
* `temp_store = MEMORY`：临时 B-tree / 排序中间结果不再落磁盘（减少 `/data` 写入与页缓存压力）。
* `migrate()` 之后 `wal_checkpoint(TRUNCATE)`：启动时把 WAL 收干净，避免 `-wal` 文件随重启无限增长。这一句包在
  `try/catch` 里、失败只 `warn`（best-effort，与第 15 项的 VACUUM 一样）。实测（宿主 node 24 的 `node:sqlite`，
  同一套 SQLite C 库）在**另一个连接持写锁**的情况下：该 pragma **不抛错**，而是把竞争写进结果行
  `{"busy":1,"log":2,"checkpointed":2}`；同一场景下 `VACUUM` 会抛 `ERR_SQLITE_ERROR | database is locked`
  ⇒ 第 15 项的 guard 是必需的，这一处是顺带加的兜底（挡住 I/O 类错误，不让启动因此失败）。
* **故意没做**：`synchronous` 保持 `FULL`（改 `NORMAL` 会改变断电语义，属于「功能退化」风险，列入建议清单）。
* 「**DB 连接池**」这一项在本项目里没有可调对象，特此说明：better-sqlite3 是**进程内单连接**（SQLite 是文件数据库，
  没有 C/S 与连接池概念）⇒ 能调的就是 prepared statement 复用（优化项 2）、`busy_timeout` /`temp_store`（本项）
  与 WAL 检查点；真正的「连接池」优化发生在 HTTP 出口那一侧（优化项 5，`createIpv4Agents()` 单例复用 keep-alive agent）。
  入站 HTTP 连接数由 Node HTTP server 默认行为决定，本轮未改（改它等于改并发行为）。

#### 4. 逐行 UPDATE 改为单条语句 + 事务

* 文件：`backend/src/games/games.service.ts` → `renumberCustomOrder()`
* 原来每行一次 UPDATE（且无事务，N 次隐式事务 N 次 fsync）；现在一条
  `UPDATE games SET custom_order = ? WHERE id = ?` 的 prepared statement 包在
  `this.db.raw.transaction(...)` 里，一次提交。

#### 5. HTTP 连接池复用

* 文件：`backend/src/common/http/proxy-config.ts`
* `createIpv4Agents()` 改成模块级单例（`MAX_FREE_SOCKETS = 4`）。原来每个请求 `new Agent()`，等于丢弃可复用的
  keep-alive socket、把旧连接池交给 GC —— 元数据抓取与图片代理走同一出口，长扫描时是纯 churn，并且每次都要
  重新 TLS 握手。对外不可见（调用方只是把 agent spread 进 axios 配置）。

#### 6. 前端按需加载（省的不只是带宽，也是解码后的位图内存）

* `web/src/App.tsx`：`GameDetail` / `Settings` 改 `lazy()` + `<Suspense fallback={t("action.loading")}>`；
  **Home 与 Login 保持静态导入**（Home 是入口屏，Login 是未登录首屏，为 ~20KB 不值得多一次往返）。
* `web/src/components/MediaGrid.tsx`：`VideoPlayer` 改 `lazy()`（它本来就是条件挂载），plyr 的 116KB JS + 32KB CSS
  推迟到真正点开视频；**`PhotoSlider` 保持静态导入**（它以 `visible={false}` 常驻挂载以便开关动画，改条件挂载会改变交互）。
* `web/src/components/PosterCarousel.tsx`：卡片帧加 `loading="lazy" decoding="async"`，非可视区的帧不再发起请求、
  不再解码成位图（500 卡 × 2 帧的请求放大器在此收窄）。
* `web/src/components/HeroPosterCarousel.tsx`：只加 `decoding="async"`，**不加 `loading="lazy"`** —— 它恒定轮播、
  必须在切换时就绪，加了会改变观感。
* `web/src/pages/GameDetail.tsx` 成就图标、`MediaGrid` 两处 tile：补 `decoding="async"`。

#### 7. 首页卡片轮播帧改用缩略图渲染（本轮单项带宽收益最大）

* 文件：`web/src/components/GameCard.tsx`（`cardPosters()` 里新增 `cardFrame()` 映射）
* 问题：卡片轮播的 media 帧此前取完整 `/preview` 渲染件 —— 4K 截图 2.5–9.8 MB/张。
  一屏 50 张卡片、每卡按轮播帧数请求，**一屏就是约 250 MB**。
* 改法：`const MEDIA_PREVIEW = /^\/api\/media\/([^/]+)\/preview$/;` 命中的 URL 换成
  `/api/media/<id>/thumbnail`（同一张图的磁盘缓存缩略图，缩略图宽默认 480px、质量 80，约 6 KB）。
* 只改卡片这一个面：上传海报（`/api/posters/<id>/image`）与官方刮削图（`media.rawg.io` 及其代理形式）原样不动；
  详情页仍是完整 `/preview`（`PosterDialog` 用的是 `thumbUrl || url`，本来就已是缩略图）。
* 代价（**已与用户确认并接受**）：卡片上的帧分辨率下降 —— 卡片宽约 300px，480px 缩略图在 1× DPR 下无差别，
  2× 屏略软。换来的是每屏约 250 MB → 约 300 KB（约 −99.9%）。

#### 8. ~~空闲轮询降频~~（**已撤回**，保持优化前的 5000 / 20000 ms）

* 曾经的改法：`web/src/api/hooks.ts` 里 `useMetadataStatus` 空闲间隔 5000 → 15000 ms（运行中仍 1500）、
  `useDurationCoverage` 空闲 20000 → 30000 ms（缺失中仍 6000）。
* **撤回理由**：轮询间隔是交互时序，不是内存或存储占用；四项方向没有点名它，而它会让「别的客户端造成的
  变更」在我们这边更晚出现（5s → 15s、20s → 30s），与「交互逻辑完全保持不变」直接冲突。省下的只是空闲请求
  数，收益不落在本轮三项指标上。
* 现在的代码：这两个 `refetchInterval` 与优化前逐字一致（`? 1500 : 5000` 与 `? 6000 : 20000`），在 diff 里是
  **上下文行**，只多了一句注释说明为什么保持原值。想启用只有一行改动，见 §八。

### 方向 ②：磁盘与镜像瘦身

#### 9. 构建期预压缩（运行期零 CPU 压缩）

* 新增 `scripts/build/precompress.mjs`（`node:zlib`，brotli quality 11 + gzip level 9，`MIN_BYTES = 1024`，
  `MIN_SAVING = 0.05`），在 `Dockerfile` 的 `npm run build` 之后跑：`RUN node scripts/build/precompress.mjs web/dist`。
* 新增 `backend/src/common/http/precompressed-static.ts`：按 `Accept-Encoding` 直接发构建期生成的 `.br` / `.gz` 兄弟文件；
  只处理 `js|mjs|cjs|css|html|json|svg|txt`，带 `Range` 或都不接受编码时 `next()` 回落到原来的静态处理器；
  `Vary: Origin`（CORS）与 `Accept-Encoding` 合并而非覆盖；`ETag` + `If-None-Match` → 304；变体比原文件旧则不用。
* 编码协商按 **q 值**排序（`br` / `gzip` 取 q 高者，相等时 br 优先；`q=0` 视为「客户端明确拒绝」不选；`*` 故意忽略，
  即只发客户端点名要的编码）。这处是审计复查后改的：原实现用 `/\bbr\b/`、`/\bgzip\b/` 直接测子串，
  `gzip;q=0` 也会被塞 gzip —— 实测矩阵见 5.2。
* 不新增任何依赖，运行期不压缩（后端是唯一的服务者，现压正是要消掉的稳态开销）。
* 白名单里**故意没有图片扩展名**（`webp/jpg/png/jxr`）—— 方向②点名要「缩略图的无损高压缩」，实测结论是
  **这条路是负收益**，所以不做（原始输出 `docs/perf/thumb-compression.txt`，一条命令可复跑
  `node scripts/perf-bench/thumb-compress.js`）：用生产管线同参数（sharp、480px、WebP q80）生成的缩略图 8,948 B，
  gzip −0.8% / brotli −1.2%（WebP 已是熵编码容器，传输层再压没有空间），对已生成的 WebP 做「无损 WebP 重编码」
  **+308.5%**，源图直接无损 WebP **+124.5%**；唯一真能变小的是降质量（q70 −12.0%、q60 −15.2%），而那是**改变画面**。
  缩略图这一侧真正的收益来自「让卡片用缩略图」（优化项 7，约 250 MB → 300 KB/屏）与「衍生件过期清理」（优化项 4）。

#### 10. 静态产物缓存头修正

* 文件：`backend/src/main.ts`
* `/assets/`（Vite 内容哈希命名）改为 `public, max-age=31536000, immutable`；`index.html` / `favicon.svg` 为 `no-cache`
  （必须可再验证，否则重新部署后不硬刷新看不到新版本）。原来统一 `max-age=0`，两个 bundle 每次导航都重新校验。

#### 11. 镜像内删除无用文件

* `Dockerfile` 瘦身步骤新增剔除（宿主实测合计 **31,124,449 B ≈29.7 MiB** —— 就是下面第 1、2 两条；
  第 3、4、5 条的字节另计）：
  * web 孤儿包 13 个：`core-js`、`@remix-run/router`、`loadjs`、`react-router`、`rangetouch`、`scheduler`、
    `prop-types`、`url-polyfill`、`react-aptor`、`react-is`、`loose-envify`、`js-tokens`、`custom-event-polyfill`
    （都只被前端构建期用到的库依赖，后端运行时不需要）
  * 包内死重量：`fluent-ffmpeg/{coverage,doc,OLD,tools}`、`libphonenumber-js/{bundle,es6,es6-modern}`、
    `class-validator/{bundles,esm2015,esm5}`、`class-transformer/{bundles,esm2015,esm5}`、`lodash/fp`、`rxjs/src`
  * `backend/dist/**/*.d.ts`（199,636 B / 75 个，审计后重建的实测值）：运行期不需要类型声明
  * `node_modules` 里的**非运行期文件** `*.map` / `*.md` / `*.d.ts`（按 backend **生产闭包** `npm ls --omit=dev --all`
    **去重**统计：`.map` 1,707 个 / 4,885,817 B、`.md` 391 个 / 3,175,970 B、`.d.ts` 1,639 个 / 2,258,701 B
    ⇒ **3,737 个文件 / 10,320,488 B = 9.84 MiB**）。
    **更正一处早前的错数**：原先写的 `18.29 MiB`（2,389 / 422 / 1,683 个）偏大 —— 那次统计跟着
    `node_modules/@screenplay/backend|web` 两个 workspace 软链接走进了源码树，而且同一文件在嵌套条目里被重复累加。
    现在按「跳过软链接 + 按绝对路径去重 + 排除第 1、2 行已整目录删掉的包」重算，**与第 1、2 行不重叠**（重复计会虚增收益）。
    抽查校验：`rxjs` 单独 `find` = 2,349,789 B，与脚本口径逐字节一致。
    命令是 `find node_modules -type f \( -name '*.map' -o -name '*.md' -o -name '*.d.ts' \) -delete`
    （`find` 默认不跟随软链接，所以镜像里真正删掉的就是这 3,737 个）。
    `*.ts` **不删**：不少包把 `.ts` 当发布内容的一部分（入口解析有风险），收益也只有约 3.6 MiB。
    `--enable-source-maps` 全仓 0 命中，所以删 `.map` 不会让任何堆栈失去行号。
  * ~~run 阶段 `apk add` 之后 `rm -rf /var/cache/apk/*`~~ —— **更正：这一项不构成本轮收益**。
    `scripts/build/apk-setup.sh` 本来就是 `apk add --no-cache`，并且在同一个 RUN 的末尾已经
    `rm -rf /var/cache/apk/*`（脚本本轮未改，1.2.0 用同一份），所以索引/包缓存从来就没进过任何一层；
    Dockerfile 里本轮新增的 `&& rm -rf /var/cache/apk/*` 只是冗余保险（同一 RUN 内创建又删除的字节本来就不进层）。
* 每一步删除后都有**入口自检**兜底：`node -e "require('fluent-ffmpeg');require('class-validator');…"` 与
  `better-sqlite3` 真读写 + `sharp` 加载，删错就构建失败。
* **明确不删**：`@img/sharp-*`（`node_modules/sharp/lib/sharp.js:16` 用模板串动态 require）、`reflect-metadata`、
  `rxjs`、`lodash`（被 @nestjs 内部 require）、隐式依赖的 `express`。
* **run 阶段只拷真正要用的那一个脚本**：`COPY scripts/build/ /tmp/` → `COPY scripts/build/apk-setup.sh /tmp/apk-setup.sh`。
  原来整目录拷进来 5 个文件（**43,527 B**），其中 `npm-run.sh`（11,089 B）、`proxy-probe.js`（8,578 B）、
  `README.md`（1,604 B）、`precompress.mjs`（3,785 B）这 4 个（合计 25,056 B）都只在**构建阶段**用；
  现在它们根本不进镜像，进镜像的那一个（18,471 B）仍在同一个 RUN 里删掉。
* **「加完即删」必须在同一个 RUN 里**（这是层语义的硬要求）：`rm` 一旦拆成独立 RUN，就只是多一个白洞层，
  字节仍然占着镜像体积。run 阶段唯一的「跨层先加后删」只有 `COPY scripts/build/apk-setup.sh /tmp/apk-setup.sh`
  这一处 —— 它单独占一层（**18,471 B**），是构建期 apk 换源/代理校验必需的，且**不能**改用 `RUN --mount=type=bind`
  绕开：本仓检测到旧版 Docker 会降级为经典构建器，`--mount` 会让降级路径直接构建失败（见优化项 16 的前提核对）。
  也就是说，那 18 KB 会以白洞形式留在镜像里，是有意保留的最小代价；除此之外 `/tmp` 里的脚本与日志
  都在**用它的那一个 RUN** 里清掉。新增 `scripts/verify-docker-layers.mjs` 把这条规则固化进回归（9 组共 33 项
  静态检查：同层删除、目录 COPY 带进来的无用文件、`apk add` 必须 `--no-cache` 且同层清缓存、运行阶段不得出现
  build 专用工具（python3/make/g++/git）与开发依赖、`.dockerignore` 必备排除项、`WORKDIR`/`CMD`/`DATA_DIR`/
  `MEDIA_DIRS`/`WEB_DIST` 契约断言、`apk-setup.sh` 自身用 `--no-cache`、**第 8 组两条**：
  build 阶段必须存在删 `node_modules` 非运行期文件的 `find`（否则「那 9.84 MiB 会原样进镜像」），
  且**运行阶段不得删除 `node_modules` / `dist` / `/app/public` / `build-info.json` 里的任何东西**——那些载荷是
  `COPY --from=build` 搬进来的，COPY 之后再删只会多一个白洞层，必须挪到 build 阶段；**第 9 组六条**（见优化项 16）：
  build 阶段仍必须是 node 镜像、运行阶段必须是最小 alpine **且版本与构建阶段同版**、必须有
  `COPY --from=build …/node → /usr/local/bin/node`、apk 必须装 `libstdc++`、不得把 npm/corepack/全局
  `node_modules` COPY 进运行镜像）。它自身做过负例自测：
  把 rm 拆成独立 RUN → 20 通过 / 2 失败；删掉 `rm -rf /var/cache/apk/*` → 21 / 1；改回整目录 COPY → 21 / 5，
  并逐条点名那 4 个文件；sed 掉 build 阶段的 `find node_modules … -delete` → 23 / 1；在运行阶段追加
  `rm -rf /app/node_modules/@img && find ./dist -name "*.d.ts" -delete` → 23 / 2（两条都被点名）；
  第 9 组的负例同样全部命中（把运行阶段改回 `node:22-alpine` → 29 / 1、去掉 `libstdc++` → 29 / 1、
  删掉那条 node 的 COPY → 28 / 1、`COPY --from=build …/lib/node_modules …` → 30 / 1、
  **把运行阶段写成 `alpine:3.22` → 32 / 1** 并打印版本漂移告警）。上面的分母按各自的脚本版本记录，
  脚本现已扩到 **33 项**（见 5.1）。
* **基础镜像层里的文件不在此列**（上层 `rm` 删了也不省字节）—— 原因见第七节「镜像体积的层语义」；
  那部分字节只能由**优化项 16「换最小基础镜像」**回收，删不掉。

#### 12. 构建上下文瘦身

* `.dockerignore` 追加 `windows`（`du -sh` 835 MB = apparent 805,004,969 B ≈ 767.7 MiB，桌面构建链）与 `.pw` / `.pw-cache`
  （553.0 MiB / 147 个文件，Playwright 的 Chromium —— 只有宿主机上的浏览器套件 `duration-cache-e2e`
  （`backend/scripts/verify/duration-cache-e2e.mjs:263`）、`requirements-ui`（同目录 `requirements-ui.mjs:198`）
  以及 `scripts/verify-browser.mjs:35` 用它；`poster-ui-ssr` 相反，它**故意不用浏览器**——文件头写着
  「为什么用 SSR 而不是浏览器：这台机器上没有可用的 Chromium 二进制」。镜像里既没有 playwright 也不跑浏览器），
  另有 `android`、`dist-image`、`**/dist-desktop`。
  每次 `docker build` 都要把整棵上下文打包发给守护进程，而 Linux 镜像的两条 `COPY`
  只碰 `backend/` 与 `web/`。**实测（`/tmp/ctxsize.mjs` 按 `.dockerignore` 语义遍历仓库）：
  排掉 `windows/` 之后上下文里唯一的巨块就是 `.pw/`，加上这两行后
  555.0 MiB / 363 个文件 → 2.0 MiB / 216 个文件**（不影响镜像体积，只影响构建速度与网络）。
  （复现「before」要把 `.pw` / `.pw-cache` 两行从忽略集里**去掉**再跑：`.pw` 已经在忽略集里时再追加排除是空操作。）
  这条已由 `scripts/verify-docker-layers.mjs` 第 5 组固化（删掉任一行断言就红）。
  **根因**：Playwright 的浏览器原先放在 `.tmp-b/pw`（554 MB，见 `docs/SLIMMING.md:94`），
  当时 `.tmp*` 这条规则顺带把它挡住了；它后来搬到 `.pw/`（那正是 `docs/SLIMMING.md` 记录的那次搬家），
  `.tmp*` 便不再覆盖它 —— 而 `CHANGELOG.md:435` 记的「上下文 700MB+ → 约 17MB」是**搬家之前**的读数。
  也就是说这 553 MiB 是**回归**（搬家时漏改 `.dockerignore`），不是新增。新增 `.pw` / `.pw-cache` 即补回覆盖。
  `scripts/` 不能整目录排除（Dockerfile 需要 `COPY scripts/build/ /tmp/`）。

#### 13. 日志限大小 + 轮转

* `docker-compose.yml` / `docker-compose.deploy.yml` 各加
  `logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }`。
  后端日志全走 stdout/stderr，默认 json-file 驱动**不轮转**，长期运行会单调增长 —— 现在上限 30MB。

### 方向 ③：依赖与代码精简

* 依赖：**无新增、无升级、无降级**；没有任何「换轻量等价库」的改动 —— 审计（见下）确认所有生产依赖都在代码路径上，
  唯一可换的重依赖（`plyr` / `react-photo-view`）涉及交互，不动。
  * 审计原始输出：`docs/perf/dependency-audit.txt`。方法：对 `backend/package.json` 的 18 个 runtime 依赖逐个在
    `backend/src` 里搜 import / `require()`，再解释 0 命中的两个（`reflect-metadata`、`rxjs` ——都是 `@nestjs/core`
    启动与内部 Observable 必需）、以及静态扫描会漏掉的两个函数内 `require()`（`fluent-ffmpeg` 在
    `backend/src/library/library.service.ts:353`、`jpegxr` 在 `backend/src/media/jxr-decoder.ts:42`）。
  * 结论：**没有一个可删的后端 runtime 依赖**；后端 devDependencies 不进镜像（slim 阶段 `npm prune --omit=dev`）；
    前端 runtime 依赖也不进镜像（产物是 vite 打好的静态文件），slim 阶段已显式删除 21 个包 + 各包的 ESM/类型冗余副本。
* 代码：删除零外部引用的死代码 —— `web/src/components/PosterImage.tsx`（整文件）、
  `useLibraryStatus`（`web/src/api/hooks.ts`）、`CardTitle`（`web/src/components/ui/Card.tsx`）、
  `getGalleryQuery` 与 `filterKey`（`web/src/lib/galleryState.ts`）、`Health`（`web/src/types.ts`）、
  `hasCjk`（`backend/src/metadata/providers/metacritic-aliases.ts`）、
  `isSupported`（`backend/src/media/media-types.ts`）、`probeTcp`（`backend/src/common/http/proxy-config.ts`），
  以及 `web/README.md` 里对应的文件树条目。
* 审计确认无 `console.log` 调试残留、无 `TODO` 残留；未引用的 i18n 键 16 个（`action.all/back/copy/processing/refresh/reset`、
  `state.empty/error/no/none/yes`、`detail.reviews.outlet/score`、`home.nextScreenshot/prevScreenshot/screenshotAlt`）
  **保留**：删除收益为 0（打包产物中未引用字符串本来就会被摇掉）而字典改动有出错面。

### 方向 ④：缓存策略

#### 14. 启动 + 周期性回收（这是本轮唯一新增的「行为」，但默认只清理可再生缓存）

* 文件：`backend/src/maintenance/maintenance.service.ts`
* `reclaimCaches()` 三件事：
  1. `MetadataCacheService.prune()` —— `metadata_cache` 里 `expires_at` 已过的行。该方法**此前全仓库没有任何调用者**，
     即过期元数据行只增不减。
  2. `/data/proxied` 按 mtime 清理超过 TTL 的代理图片（默认 30 天，`PROXIED_CACHE_TTL_DAYS` 可调；
     **设成 0 就跳过这一步** —— 源 URL 失效后这份缓存可能是唯一副本，要不要永久留着由部署者决定，见 5.8 第 6 条）。
     该目录按 URL 的 sha1 命名，DB 里从不存这个路径（存的是源 URL），所以删掉只是下次重新下载，不会出现指向缺失文件的行。
  3. `thumbnails` / `covers` / `previews` 里的**孤儿衍生文件**：用
     `DERIVED_RENDITION = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:@(?:w\d+|full))?(?:v\d+)?\.webp$/`
     只认「能证明是某个 media id 的衍生件」且该 id 已不在 `SELECT id FROM media` 里的文件。
* 安全栏杆：`posters/` 永不触碰（用户上传的原始图）；media 表为空时整段跳过（`liveMediaIds()` 返回 `null`）；
  1 小时内的新文件永不删（`HOUSEKEEPING_MIN_AGE_MS`，顺带免锁避免与写入竞争）；任何不匹配的名字 / 目录 / 瞬时消失的文件都不动。
* 调度：`scheduleHousekeeping()` 用 `setTimeout` 链（不是 `setInterval`，避免慢跑叠加）+ `unref()`，
  默认每 6 小时一次（`HOUSEKEEPING_INTERVAL_MS`，设为 0 则只在启动跑一次）；`library.isScanning()` 时跳过该轮。
* 日志：追加 `caches reclaimed: N expired cache row(s), M stale file(s) (…)`，并**保留**构建自检 grep 的固定串
  `Boot maintenance finished in ${seconds}s — ` 与 `auto-added frames removed from the card rotation: `。

---

### 方向 ②（补充）：SQLite 文件级收缩

#### 15. 可选启动期 `VACUUM`（默认关闭，`MAINTENANCE_VACUUM=1` 开启）

* 文件：`backend/src/database/database.service.ts`（新增私有方法 `vacuumIfRequested(dbPath)`，调用点紧挨
  `this.db.pragma('wal_checkpoint(TRUNCATE)')`，仍在 `onModuleInit()` 里、`listen()` 之前）
* 为什么需要：删行（优化项 14 回收的过期缓存行、被删游戏的行）只把页放回**文件内部的空闲页链表**，
  文件本身永不缩小 —— 长期运行的库只涨不缩，这是方向②里「SQLite 清理**收缩**」唯一没被覆盖的一半。
  `VACUUM` 按页重写整个文件，是唯一能把空间还给文件系统的办法。
* 为什么**默认关闭**：`VACUUM` 要重写整库、瞬时需要约等于库大小的空闲空间，better-sqlite3 又是同步的，
  大库上这会阻塞启动数十秒到数分钟。这是「运维显式选择」的成本，不该强加给所有人 ⇒ 不设该变量时
  行为与 HEAD 逐字一致（**零行为变化**）。
* 实现要点：
  * 开关解析沿用 `MAINTENANCE_ON_BOOT` 的宽松写法（`1`/`true`/`yes`/`on` 均视为开）。
  * 顺序：`migrate()` → `wal_checkpoint(TRUNCATE)` → `VACUUM` → **再**一次 `wal_checkpoint(TRUNCATE)`
    （重写走 WAL，再折一次才能让 `/data` 上的 `-wal` 也变小）。
  * 之后 `this.statements.clear()`：重排了页，缓存里的语句句柄一律丢弃、下次调用重新 prepare，
    不依赖任何「`VACUUM` 后旧句柄仍有效」的假设。
  * 失败（磁盘不够、被别的进程持锁）只 `logger.warn('VACUUM skipped: …')` 并继续启动 —— 它永远不能让服务起不来。
  * 日志：`VACUUM finished in {秒}s — database {前} → {后} (reclaimed {差}).`（`fileSize()`/`formatBytes()` 两个
    模块内小工具，不进任何导出面）。
* **实测**（shim 起真实 `backend/dist`，`DATA_DIR` 指向一个**人为造膨胀**的库：拷 1000 局基准库后写入
  12 万行 × 400 B 再把行全删掉，WAL 已 checkpoint，文件 57,491,456 B）：
  * 不设开关：文件**一字节不变**（57,491,456 → 57,491,456），日志里没有 `VACUUM` 行 —— 默认路径确实没动。
  * `MAINTENANCE_VACUUM=1`：`VACUUM finished in 0.0s — database 54.8 MB → 2.7 MB (reclaimed 52.2 MB).`，
    文件 57,491,456 → **2,785,280 B（−95.2%）**，随后 `Nest application successfully started` 正常。
  * 数据完整性：`PRAGMA integrity_check` = `ok`，`games` 1000 行 / `media` 1500 行与源库逐表相同；
    同一库再真启动一次（膨胀 → 自愈 → 服务）后 `/api/health` = 200、`/api/games` 列表照常返回。
* 属于「新增可选环境变量」，不改 DDL、不改 schema、不改接口 ⇒ 与硬约束一致；容器部署命令不变，
  需要收缩时给容器加一个环境变量即可，不需要时完全不涉及。

**索引（同一子项的另一半）：不需要新增**。把产品代码里 19 条热点 SQL 逐字交给 `EXPLAIN QUERY PLAN`
（`docs/perf/query-plans.txt`，见 5.7）之后确认：所有逐请求路径（`auth_sessions WHERE token = ?`、
`metadata_cache WHERE key = ?`、批量海报行、媒体计数、详情媒体列表、成就 / 评价按 `game_id`）**都已在走索引**；
仅剩的 4 条全表扫描是「画廊要先取全部候选行」「整表一次读成 Map」「维护要 media id 全集」「统计聚合」这类
本来就该扫的场景（表在千行级，毫秒以下）。加复合索引只为省掉对单局那几行的临时排序，反而增加索引体积与写放大。

---

### 方向 ②（补充）：运行阶段换最小基础镜像

#### 16. 运行阶段 `node:22-alpine` → `alpine:3.24` + 只拷 node 二进制

* 文件：`Dockerfile`（运行阶段 `FROM`、新增一条 `COPY --from=build /usr/local/bin/node`、apk 那一步追加
  `libstdc++`、载荷 COPY 之后新增构建期自检 `RUN node -v`）、`scripts/verify-docker-layers.mjs`（第 9 组 6 项断言，
  其中一条把 alpine 版本钉在 **3.24**）、`scripts/verify-suites.sh`（接入）、`scripts/docker-build.sh`（`:58` 起从
  Dockerfile 派生 `RUN_BASE_IMAGE` 并打印在 `:361` 的信息行里，避免脚本与 Dockerfile 两处漂移）。
* 为什么需要：运行阶段只执行 `node dist/main.js`，而 `node:22-alpine` 的那一层（**155,819,008 B = 148.6 MiB**）里
  装的是 node 二进制 **+ npm（≈12 MB）+ corepack（≈2 MB）+ `/usr/local/include/node`（≈8 MB）+ shim** ——
  后三样运行期一次都用不到。**删不掉，只能换基础镜像**（层语义见第七节：基础层里的文件在上层 `rm` 只是加白洞）。
* 层核算（该 registry 的层是**未压缩 OCI tar**，层字节数 1:1 等于拉取/落盘体积；「before」四项全部来自
  **registry 直读的 1.2.0 镜像层清单**，见 §3.1.1，不再是推算）：

  | 动作 | 字节 | 依据（实测 / 推算） |
  | --- | --- | --- |
  | 移除 `node:22-alpine` 的 **alpine rootfs 层** | −8,704,000 | 1.2.0 的 L1 实测 = `ADD alpine-minirootfs-3.24.2-x86_64.tar.gz`；这一层也属于 node 基础镜像，**必须和 node 层一起减掉** —— 早前的表漏了它，把净省算小了 |
  | 移除 `node:22-alpine` 的 **node 层** | −155,819,008 | 1.2.0 的 L2 实测（148.6 MiB），含 node 二进制 + npm（≈12 MB）+ corepack + `/usr/local/include/node` + shim |
  | 移除 **yarn 层** | −5,388,288 | 1.2.0 的 L3 实测（`created_by` = yarn 安装 RUN：`apk add --no-cache --virtual .build-deps-yarn curl gnupg tar …`）。**早前的表漏算了这一层** |
  | 移除 **docker-entrypoint.sh 层** | −3,584 | 1.2.0 的 L4 实测（`COPY docker-entrypoint.sh /usr/local/bin/`）。**早前的表漏算了这一层** |
  | 换回 `alpine:3.24` 的 rootfs 层 | +8,704,000 | **与 before 的 rootfs 同一份内容、同版本**（`alpine:3.24` tag 现 ≡ `3.24.2`，digest `sha256:d56c381f961d307a2…`）⇒ 这一项与 before 相抵 |
  | `COPY --from=build /usr/local/bin/node` | +129,237,456 | **实测**：`node:22-alpine` 在 x86_64 上并不编译，而是解包官方 musl 预编译包（nodejs/docker-node `22/alpine3.23/Dockerfile:19-24`，`NODE_VERSION=22.23.3`）⇒ 量得 `bin/node = 129,237,456 B`；把该 tarball 的清单按 `.so` 与 `libnode` 两个模式各筛一次，**结果都是空** ⇒ 包里没有任何共享库、没有 `libnode.so` ⇒ 只拷这一个二进制是完整的。版本也与现状一致：1.2.0 的镜像 `env` 里就是 `NODE_VERSION=22.23.3` |
  | `libstdc++` + `libgcc` | +2,978,024 | **实测**：alpine v3.24 main 的 `APKINDEX`：`libstdc++ 15.2.0-r5` 安装后 2,804,104 B + `libgcc 15.2.0-r5` 173,920 B（libstdc++ 经 `so:libgcc_s.so.1` 依赖带出 libgcc）。**与 before 镜像里的包同版本**（1.2.0 的 `/lib/apk/db/installed` 里就是 15.2.0-r5，原来由 node 基础层白送，现在必须自己装）；与 ffmpeg 同一个 `apk` RUN，不额外增层 |
  | **净省** | **28,995,400 B（−27.7 MiB）** | 移除 169,914,880 − 新增 140,919,480。**更正**：早前写的 23,748,936 B 少算了 yarn 5,388,288 + docker-entrypoint.sh 3,584，且 rootfs/libstdc++ 用的是 alpine 3.22 的版本 |

* **为什么是 3.24 而不是 3.22（这行字曾经写错，代价是 ffmpeg 跨两个大版本降级）**：
  * 构建阶段的 `node:22-alpine` 当前 = alpine **3.24.2**（实测其 rootfs 层就是 `alpine-minirootfs-3.24.2-x86_64.tar.gz`）；
    已发布的 1.2.0 镜像也跑在这套 3.24 仓库上 —— 从 1.2.0 的 L7 层里抽出 `/lib/apk/db/installed`（107,399 B）看到
    **`ffmpeg 8.1.2-r0`**、`libstdc++ 15.2.0-r5`、`libgcc 15.2.0-r5`。
  * 若运行阶段写 `alpine:3.22`（Dockerfile 原本就是这么写的，注释还自称「跟着构建阶段那版 node:22-alpine」），
    apk 会从 v3.22 仓库装到 **`ffmpeg 6.1.2-r2`**（v3.22 community；依赖 `libavcodec.so.60`，而 8.1.2 用 `.62`）
    —— 抽帧组件倒退两个大版本，与「不得造成任何功能退化」的硬约束直接冲突。
  * 版本对照（两侧都实测 `APKINDEX`）：v3.22 → ffmpeg **6.1.2-r2** / libstdc++ **14.2.0-r6**；
    v3.24 → ffmpeg **8.1.2-r0** / libstdc++ **15.2.0-r5**（= 现状）。
  * 换回 3.24 的代价只有 **+145,408 B**（rootfs 8,704,000 vs 8,591,360；libstdc+++libgcc 2,978,024 vs 2,945,256），
    换来运行期组件与现状**完全同包版本**。
  * 硬化：`scripts/verify-docker-layers.mjs` 第 9 组新增一条断言把 alpine 版本钉住（当前 3.24），
    负例命中：改回 `alpine:3.22` ⇒ **32/1** 并打印「不是 alpine:3.24 —— 版本与构建阶段不同会让 apk 从另一套仓库装包」。
    node 官方镜像哪天跳到 alpine 3.25，这条断言会先报错，提醒同步。

* **顺带被换掉的一层没有副作用**：`node:22-alpine` 基础镜像里的 `docker-entrypoint.sh`（L4，3,584 B）也随之消失。
  它只是一个「参数分派」包装（把 CMD 原样 exec 出去），本镜像的 `CMD ["node","dist/main.js"]` 不经过它，
  新运行阶段也没有设 `ENTRYPOINT` ⇒ 启动方式与进程树和现状一致（`USER` 仍然未设、`WORKDIR /app/backend`
  仍旧，见第 6 组的部署契约断言）。

* **预期**整镜像体积 **421,106,176 → 350,799,991 B（≈334.6 MiB，−16.70%）** —— 这是**推算**，逐项明细只在
  §3.1 列一次（同一套数字两处写会漂移）。**真机实测已在 2026-10-03 完成**：`docker images` 口径
  405,580,274 → 337,753,553 B（**−16.72%**）、逐层合计口径 426,022,167 → 353,978,424 B（−16.91%），
  与推算相差 ≤ 2.5 MiB（见 §3.1 末尾的实测表与 `docs/perf/compare.md`）。
  这里的 **421,106,176 B = 401.6 MiB / 13 层**是 **1.2.0（= 当前 latest）registry 直读实测**值（见 §3.1.1；
  1.0.0 实测 421,100,544 B 作交叉核对）；容器侧 before 基准见 `docs/perf/before-docker.txt`。
* 为什么不会功能退化（逐条核对过的前提）：
  * **容器内没有任何地方跑 npm** —— 把 `scripts/` 下**所有** `docker exec` 的命令行抓出来看，只用到
    `node` / `sh` / `rm` / `du` / `ls` / `grep` / `cat`（含 `scripts/perf-baseline.sh:291` 的
    `node /tmp/.perf-db.js`，它拷一个脚本进容器用 `node` 跑，不装任何东西）。文件级旁证：
    `scripts/docker-verify.sh:5` 明确「全部在容器里完成，宿主机不需要 node / npm」；`scripts/verify-image-fix.sh`
    同理；`scripts/rebuild-and-verify.sh:120` 的 npm 只是报错文案；`scripts/package-image.sh:126` 的 npm 是**宿主**脚本。
  * `backend/src` 全仓无 `spawn('node')` / `nodejs` 调用；也没加 `/usr/local/bin/nodejs` 符号链接（用不到）。
    另核对过「**TLS 信任库**」这个常见疑虑：`nodejs/docker-node` 的 alpine 运行镜像（`22/alpine3.23/Dockerfile:7-8`）
    里 `apk add --no-cache` **只装 `libstdc++`**，并不装 `ca-certificates` —— 也就是说**旧的
    `node:22-alpine` 运行镜像本来就没有系统 CA 库**，Node 一直用的是自带（bundled）CA；本仓也没有任何
    `spawn`/`child_process` 去调 `curl`/`wget`/`openssl`（`backend/src` 全仓 grep 为空），HTTP 全走 Node 自己的
    `https`，所以换基础镜像在这一项上**与优化前完全等价**，不存在「少了 CA 库导致 https 失败」的回归。
  * **原生模块没有 ABI 风险**：`node_modules` 里的 `.node`（better-sqlite3 等）是在 **build 阶段那个
    `node:22-alpine`（musl）** 里装/编的，运行阶段用 alpine 3.24 仍是**同一套 musl libc**（而且与现状
    **同一版本**）、Node ABI 仍是 v22 —— 与「换 glibc 发行版」那种风险无关。真正缺的只有 `libstdc++`，
    已与 ffmpeg 同层补上，版本也与现状一致（15.2.0-r5）。
    （`scripts/docker-verify.sh` 在容器里跑的那几个 `node scripts/verify/*.mjs` 也正是这条链路的回归证据。）
  * node 二进制路径与官方镜像一致（`/usr/local/bin/node`），`CMD ["node","dist/main.js"]`、`HEALTHCHECK`、
    `ENV DATA_DIR/MEDIA_DIRS/WEB_DIST/PORT/NODE_ENV`、`VOLUME`、`WORKDIR /app/backend`、`USER` 全部未动。
  * apk 换源/代理注入的既有机制未变；**没有使用 BuildKit 的 `RUN --mount=`** —— 本仓检测到旧版 Docker 会降级为
    经典构建器，`--mount` 会让降级路径直接构建失败（属功能退化风险，故刻意避开）。
* 风险与三重防线（换基础镜像最典型的失败形态是「漏装 `libstdc++` ⇒ 容器起不来」）：
  1. 构建期自检 `RUN node -v` —— 二进制加载不了就在构建阶段失败，而不是部署现场；
  2. `scripts/verify-docker-layers.mjs` 第 9 组 6 项静态断言（build 阶段仍是 node 镜像、run 阶段必须是 alpine、
     **alpine 版本必须是 3.24**、必须有那条 node 的 COPY、apk 必须含 `libstdc++`、不得把 npm/corepack/全局
     `node_modules` COPY 进来）；负例全部命中（改回 node 基础镜像 32/1、去掉 `libstdc++` 32/1、删掉 node COPY 31/1、
     `COPY …/lib/node_modules` 33/1、**改回 `alpine:3.22` ⇒ 32/1**）；
  3. 真机构建后 `scripts/rebuild-and-verify.sh` 的真启动断言（`/api/health` = 200 + 15 个 feature 标记齐全 +
   启动期维护日志措辞 + 前端投递的 `Content-Encoding`/缓存头）。
* 一并说明（**曾经的风险，已消除**）：运行阶段的 `apk add` 现在跑在 **alpine 3.24** 的仓库上，装到的
  `ffmpeg 8.1.2-r0` / `libstdc++ 15.2.0-r5` 与 1.2.0 镜像里的包**完全同版本**（证据见上面「为什么是 3.24」）。
  抽帧通过 fluent-ffmpeg 调 CLI（`backend/src/library/library.service.ts:353`），输出格式参数在代码里显式给出，
  不依赖某个 ffmpeg 版本的默认行为；现在连版本都不变，这一项与优化前完全等价。
* **回滚方式（一行）**：把运行阶段的 `FROM ${REGISTRY}alpine:3.24 AS run` 改回 `FROM ${REGISTRY}node:22-alpine AS run`，
  并删掉 `COPY --from=build /usr/local/bin/node …`（`libstdc++` 留着无害）。改完 `node scripts/verify-docker-layers.mjs`
  会在第 9 组如实报出来，便于确认回滚到位。

---

## 三、三项指标对比

### 3.1 镜像体积

宿主侧可确定的部分（镜像构建阶段真实删除的字节）：

| 项目 | 字节 | 说明 |
| --- | --- | --- |
| web 孤儿包 13 个 | 6,520,157 | 宿主 glibc 口径，逐包重算一致（明细见优化项 11）。**只算本轮新增的孤儿包**：`react`/`react-dom`/`react-router-dom`/`lucide-react`/`@tanstack`/`plyr`/`plyr-react`/`react-photo-view` 这 8 个前端直接依赖是 1.0.0 那轮就删掉的，不算在本轮收益里（21 个包全量实测 47,454,011 B） |
| 包内死重量目录 | 24,604,292 | 同上（15 个目录，逐目录重算一致） |
| `node_modules` 非运行期文件（`*.map`/`*.md`/`*.d.ts`） | 10,320,488（3,737 个；9.84 MiB） | backend 生产闭包（`npm ls --omit=dev --all`）**去重**实测：`.map` 1,707/4,885,817、`.md` 391/3,175,970、`.d.ts` 1,639/2,258,701；**已排除第 1、2 行整目录删掉的包，不重复计**。build 阶段删，COPY 只搬幸存文件。**更正**：早前写的 19,180,700（18.29 MiB）偏大，原因是统计时跟着 `node_modules/@screenplay/*` 软链接进了源码树、且同一文件被重复累加（推导见优化项 11） |
| `backend/dist/**/*.d.ts` | 199,636（75 个） | 精确 |
| 运行阶段基础层：`node:22-alpine` → `alpine:3.24` + 只拷 node 二进制 | 28,995,400（约 27.7 MiB） | 优化项 16：移除 rootfs 8,704,000 + node 层 155,819,008 + yarn 层 5,388,288 + docker-entrypoint.sh 层 3,584 = 169,914,880；新增 alpine:3.24 rootfs 8,704,000 + node 二进制 129,237,456 + libstdc++/libgcc 2,978,024 = 140,919,480。**四项移除全部来自 registry 直读的 1.2.0 层清单（§3.1.1）**，层字节 1:1 |
| ~~apk 索引缓存~~ | **0** | **更正：不构成收益**。`scripts/build/apk-setup.sh` 一直是 `apk add --no-cache` + 同层 `rm -rf /var/cache/apk/*`（脚本本轮未改），缓存字节从未进过层 |
| 预压缩产物 `.br`/`.gz` | +333,788（约 326 KB） | 新增：9 个资源各一份（`.br` 合计 154,940 + `.gz` 合计 178,848），换来的是**传输**体积少 60–75%（见 5.2） |
| **合计** | **约 −67.0 MB（净减 70,306,185 B ≈ 67.05 MiB）** | 6,520,157 + 24,604,292 + 10,320,488 + 199,636 + 28,995,400 − 333,788；**未计构建上下文**（优化项 12：`windows/`（`du -sh` 835 MB ≈ 767.7 MiB）与 `.pw/` 553.0 MiB 已排除，上下文 555.0 MiB / 363 个文件 → 2.0 MiB / 216 个文件；不影响镜像体积，只影响构建速度/网络） |

按上面逐项相加，**预期**整镜像从 **421,106,176 B（401.6 MiB）** 降到 **350,799,991 B（≈334.6 MiB，−16.70%）**。

> 基准值的出处：那 **421,106,176 B = 401.6 MiB / 13 层**是 **1.2.0（= 当前 latest）的 registry 直读实测**值
> （见下面的 §3.1.1，含逐层清单与复现命令）。1.0.0 实测 421,100,544 B / 13 层，两者只差 5,632 B（层 5/6/7/10/12
> 的产物字节），所以「1.2.0 与 1.0.0 层结构相同」这句话已被证实，不再只是断言。

#### 3.1.1 before 侧 13 层实测清单（registry 直读，不走 docker）

宿主没有 docker 权限（`uid 973` 不在 `docker` 组，`docker ps` 报 `permission denied … docker.sock`），所以
「before」不是靠推算：**直接读 Docker Hub 的 registry API** 拿到的 1.2.0 镜像 manifest 与逐层字节。
复现方式（匿名 token，三条 curl）：

```bash
TOK=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:wyunki/screenplay:pull" \
      | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -s -H "Authorization: Bearer $TOK" \
     -H 'Accept: application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json' \
     https://registry-1.docker.io/v2/wyunki/screenplay/manifests/latest   # → 13 层 + config digest
# 取某一层：registry 会 307 到 production.cloudfront.docker.com 的签名 URL，
# 必须先把 location 读出来再 curl（直接 curl -L 打在 registry URL 上只得到 307 / 0 字节）
URL=$(curl -s -D - -o /dev/null -H "Authorization: Bearer $TOK" \
      "https://registry-1.docker.io/v2/wyunki/screenplay/blobs/sha256:<层 digest>" \
      | tr -d '\r' | awk '/^location:/{print $2}')
curl -sL "$URL" | tar -xO -f - lib/apk/db/installed | grep -E '^(P|V|I):'   # 例：看容器里到底装了哪个 ffmpeg
```

1.2.0（`latest`，digest `sha256:13afde9bdead5e082b77f5f5da078ebccb851f8a4b04196b45a1dc61b537b444`）：

| # | 字节 | 身份（`history.created_by` / 实测内容） |
| --- | --- | --- |
| L1 | 8,704,000 | `ADD alpine-minirootfs-3.24.2-x86_64.tar.gz` ⇒ **运行 OS = alpine 3.24.2** |
| L2 | 155,819,008 | `node:22-alpine` 装的 node + npm + corepack + 头文件 + `apk add --no-cache libstdc++` |
| L3 | 5,388,288 | yarn 安装 RUN（`--virtual .build-deps-yarn curl gnupg tar …`） |
| L4 | 3,584 | `COPY docker-entrypoint.sh /usr/local/bin/` |
| L5 | 44,544 | `COPY scripts/build/ /tmp/`（**整目录 5 个文件**的层；正文写的是文件级 43,527 B） |
| L6 | 1,536 | `RUN … APK_SETUP_VERSION` 回显 |
| L7 | 131,470,848 | 大层：`sh /tmp/apk-setup.sh ffmpeg` + 建 `screenplay` 用户；**实测内含 `ffmpeg 8.1.2-r0`**（另抽出 `/lib/apk/db/installed` = 107,399 B：`libstdc++ 15.2.0-r5`、`libgcc 15.2.0-r5`，**无** `ca-certificates`、**无** `sqlite-libs`） |
| L8 | 2,048 | `WORKDIR /app/backend` |
| L9 | 4,096 | `COPY backend/package.json` |
| L10 | 995,840 | `COPY /app/backend/dist` |
| L11 | 118,035,456 | `COPY /app/node_modules` |
| L12 | 634,368 | `COPY /app/web/dist → /app/public` |
| L13 | 2,560 | `COPY /app/build-info.json` |
| **合计** | **421,106,176** | 13 层；层 mediaType = `application/vnd.oci.image.layer.v1.tar`（**未压缩** ⇒ 层字节 ≈ 拉取/落盘字节） |

config blob（`sha256:06e5dc1517c43d9950978da5bcb55b08986562f55ca0cb1bbab19c67ac82bf0c`，13,045 B）确认部署契约与现状一致：
`created 2026-10-02T22:41:10+08:00`、`Cmd ["node","dist/main.js"]`、`WorkingDir /app/backend`、`User` 未设、
`NODE_VERSION=22.23.3`、`BUILD_VERSION=1.2.0`、`YARN_VERSION=1.22.22`、`DATA_DIR/MEDIA_DIRS/WEB_DIST/PORT/NODE_ENV`
逐条相同，`rootfs.diff_ids` = 13。
1.0.0（`sha256:f4a18a209b36cae89a24fa6e3f27965195863afd0bb264fd15fab51ac8ef26e3`）= **421,100,544 B / 13 层**，
与 1.2.0 逐层对齐后只差 5,632 B ⇒ 报告的 421,100,544 基准得到独立复核。

#### 3.1.2 换基线的「包级等价性证明」（不需要 docker，可复现）

换运行阶段基线最容易出事的地方不是体积，而是**包版本**：`FROM alpine:3.24` 之后 `apk add` 会从 v3.24
仓库重新解依赖 —— 如果哪些包在这两个大版本之间改了名、换了 soname 或降了级，容器里就会少库或多包。
`scripts/perf-bench/apk-parity.py` 把三份**公开来源**的真实数据摆在一起核对（全部可复现，不需要 docker 权限）：

| 输入 | 来源 | 实测 |
| --- | --- | --- |
| before 镜像的 apk 数据库 | 1.2.0 的 L7 层里抽出 `/lib/apk/db/installed`（107,399 B） | **123 个包**，安装后合计 **142,130,576 B** |
| 新基线的 rootfs 数据库 | `alpine-minirootfs-3.24.2-x86_64.tar.gz`（3,701,382 B，就是 `FROM alpine:3.24` 那一层的内容） | **16 个包**，合计 **8,399,794 B** |
| v3.24 仓库的 APKINDEX | `dl-cdn.alpinelinux.org/alpine/v3.24/{main,community}/x86_64/APKINDEX.tar.gz` | main + community 共 **28,649 条记录** |

四条断言（当前全过，原始输出见 `docs/perf/apk-parity.txt`）：

| 断言 | 结果 |
| --- | --- |
| ① 新基线 rootfs 的 16 个包在 before 里**版本一字不差** | 通过（`alpine-release = 3.24.2-r0`）⇒ 基线层内容没变，所以 §3.1 里「换回 alpine 的 rootfs 层 +8,704,000 与 before 相抵」成立 |
| ② 从真实根包 `ffmpeg libstdc++`（即 Dockerfile 里的 `apk-setup.sh ffmpeg libstdc++`）出发，依赖闭包在 v3.24 里能**完全解析** | **113 个包**，未解析 token **0 个** ⇒ 构建不会因缺包失败 |
| ③ 闭包 ⊆ (rootfs ∪ before) | **是**：闭包里的新包 **0 个**，before 里有、重建后拿不到的包 **0 个** ⇒ 体积与功能两侧都没有漂移 |
| ④ before 的 123 个包在 v3.24 仓库里**都还在**吗、版本有没有更新 | 找不到的 **0 个**；版本更新的只有 2 个：`libcrypto3` / `libssl3` `3.5.8-r0` → 仓库 `3.5.9-r0` |

第 ④ 项那 2 个更新**不会进镜像**，两条证据：

* 依赖写法上没有硬约束 —— 闭包里引用它们的地方全是未固定 soname（`so:libcrypto.so.3` / `so:libssl.so.3`），
  而已装的 `3.5.8-r0` 正好提供这两个 soname；`apk add` 不带 `-u`，不会升级已装包（仓库里 `libssl3 3.5.9-r0`
  自带的 `libcrypto3=3.5.9-r0` 只有在该版本自己被安装时才生效）。
* 经验证据：这批更新构建于 `2026-09-30T07:09:33Z`，而 before 镜像 `created = 2026-10-02T22:41:10+08:00`
  （即 `14:41:10Z`）——**更新早于构建**，before 镜像里却仍是 `3.5.8-r0` ⇒ 上一次构建的 `apk add` 确实没升级它。
  重建走同一条命令、同一套仓库，结论相同。

顺带澄清一处容易误读的地方：`ca-certificates-bundle 20260909-r0` 属于 **alpine rootfs 自带的 16 个包**
（不是 node 层带来的），所以 before 镜像里本来就有系统 CA 包（`/etc/ssl/certs/ca-certificates.crt`），
新基线同样带它；node 层对**包清单**的净贡献只有 `libstdc++` + `libgcc`（这正是 Dockerfile 现在要显式装这两个的原因）。

> 口径说明：上面这两个数（421,106,176 → 350,799,991）都是**层字节之和**，来源是 registry 直读（§3.1.1）与
> 逐项实测/推算。它和 `docker images` 显示的数字不是同一个量（后者算的是本地解包用量 + 元数据），但前后两次
> 用同一种口径采集（`scripts/perf-baseline.sh` 的 `image_size_bytes` / `image_layer_sum_bytes`）就能直接比。
> 早前写的「379,393,892 B / −9.9%」是同一张表的旧版本（当时漏了旧 alpine rootfs 层、片内数字也偏大），已作废。

**容器侧实测（真机采集，2026-10-03；`docs/perf/before-docker.txt` 11:50 未重建的 1.2.0 容器 → `docs/perf/after-docker.txt` 11:57 重建后）：**

| 项目 | 优化前（1.2.0） | 优化后 | 变化 |
| --- | --- | --- | --- |
| `image_size_bytes`（`docker image inspect` 的 `.Size`） | 405,580,274 B（386.8 MiB） | 337,753,553 B（322.1 MiB） | **−67,826,721 B（−16.72%）** |
| `image_layer_sum_bytes`（逐层 `docker history` 求和） | 426,022,167 B（406.3 MiB） | 353,978,424 B（337.6 MiB） | −72,043,743 B（−16.91%） |
| `image_layers` | 13 | 12 | −1（换基础镜像改变了层清单） |

实测与预测吻合：`image_size_bytes` 的 −16.72% 对上 §3.1 预测的 **−16.70%**（421,106,176 → 350,799,991）；
净减字节数三种算法分别是 67,826,721（本地 `docker images` 口径）、72,043,743（本地 `docker history` 口径）、
70,306,185（registry 层字节口径），相差 ≤ 2.5 MiB —— 同一量级，说明预测里两个扣减项（旧 alpine rootfs + node 层里的
npm/corepack/yarn 共 155,819,008 + 5,388,288 + 3,584 B，以及 apk 侧换成 3.24 仓库后的替换）都真实发生了。
（本地 `docker history` 求和比 registry 直读的层和略大 4.7 MiB，属两者记录方式差异，故只做**同口径前后比**。）

生成对比表的命令（只读这两份基线文件，不碰 docker）：

```bash
bash scripts/perf-compare.sh docs/perf/before-docker.txt docs/perf/after-docker.txt docs/perf/compare.md
```

它按「镜像体积 / 运行内存峰值 / 磁盘占用」三节列出差值、百分比与增减方向，另附 SQLite PRAGMA 与热接口耗时明细；
缺键显示 `—` 而不报错。产出的 **`docs/perf/compare.md` 就是交付 1 的对比表**（下面是它的文字版说明）。

### 3.2 运行内存峰值

| 项目 | 优化前 | 优化后 | 依据 |
| --- | --- | --- | --- |
| 列表接口 SQL 条数（500 游戏） | 501 条（`SELECT *` + 每行一次 `countByGame`） | 1 条（17 列投影） | **实测** `scripts/perf-bench/bench-list-path.js` |
| 3000 次真实请求后的进程 RSS | 未测（无基线） | 190.8 MiB，前 500 次内到平台、后半段 +0.5% | **实测** `scripts/perf-bench/bench-soak.sh`（`docs/perf/leak-soak.txt`） |
| 列表接口单请求 SQL 条数（真实后端 HTTP） | 651 条（+ 每行一次 `rating_targets`） | **4 条**（`sort=mediaCount` 6 条） | **实测** 端点级计数（−99.4% / −99.0%，响应逐字节相同，见 `docs/perf/list-path-queries.txt`） |
| 列表接口单请求物化文本（500 游戏） | 1,640,970 B（1.56 MiB） | 109,170 B（0.10 MiB） | 同上（−93.3%） |
| 连续 200 次列表请求的进程峰值 VmHWM | 199.4–202.2 MiB | 95.8–97.8 MiB | **实测** `scripts/perf-bench/bench-peak-memory.js`（约 −51%） |
| 同上：单次列表耗时 | 6.63–6.67 ms | 2.61–2.67 ms | 同上（约 −60%） |
| 首页卡片轮播图片请求数（500 卡） | 每卡全部帧各自请求、无 `lazy` | 非可视区帧不请求、不解码 | `loading="lazy" decoding="async"` |
| 首页卡片轮播帧的图片体积（一屏 50 卡） | 每帧完整 `/preview`，约 250 MB | 每帧约 6 KB 缩略图，约 300 KB | 见优化项 7（用户已确认） |
| 静态资源压缩 | 运行期无压缩 | 构建期压缩，运行期零 CPU/零缓冲 | 实测 Content-Encoding/Content-Length |
| JXR 解码瞬时峰值 | 约 160MB / 4s | **不变** | 无泄漏，属一次性解码缓冲区，不改 |

> 基准脚本跑在宿主 `node:sqlite` shim 上（容器里是真 better-sqlite3），绝对值不代表容器环境；
> 两个实现同口径对照，比值可信。完整输出见 `docs/perf/list-path-bench.txt`，可自行复跑。

**容器侧内存（真机采集，`scripts/perf-baseline.sh` ② 节；同 §3.1 的两份基线文件）：**

| 指标 | 优化前（1.2.0 容器） | 优化后（重建后） | 变化 | 可比性 |
| --- | --- | --- | --- | --- |
| `rss_hwm_bytes`（`/proc/1` 的 VmHWM，进程生命周期峰值） | 160,763,904 B（153.3 MiB） | 159,887,360 B（152.5 MiB） | −856 KiB（−0.5%） | ✅ 峰值口径 |
| `cgroup_peak_bytes`（cgroup v2 `memory.peak`，含内核/页缓存） | 822,411,264 B（784.3 MiB） | 652,935,168 B（622.7 MiB） | −161.6 MiB（−20.6%） | ⚠️ 见下 |
| `load_rss_delta_bytes`（60 次真实请求期间的 RSS 增量，两次同一序列） | 9,424,896 B（9.0 MiB） | 3,235,840 B（3.1 MiB） | **−65.7%** | ✅ 同口径增量 |
| `load_cgroup_delta_bytes`（同上，cgroup 增量） | 8,269,824 B（7.9 MiB） | 3,407,872 B（3.2 MiB） | **−58.8%** | ✅ 同口径增量 |
| `rss_bytes`（采集时刻 `/proc/1` 的 VmRSS） | 13,623,296 B（13.0 MiB） | 126,664,704 B（120.8 MiB） | +107.8 MiB | ⚠️ 快照，不可比 |
| `cgroup_current_bytes`（采集时刻 `memory.current`） | 22,564,864 B（21.5 MiB） | 584,892,416 B（557.8 MiB） | +536.3 MiB | ⚠️ 快照，不可比 |
| `vmpeak_bytes`（虚拟地址空间峰值） | 11,583,713,280 B（10.79 GiB） | 11,582,296,064 B（10.79 GiB） | −1.4 MiB | ✅ |

怎么读这张表（**别被两个 ⚠️ 误导**）：

- **两个快照值是「污染样本」**：before 容器处于长时间空闲后的稳定态（13.0 MiB 的 VmRSS 只有在 V8 已把空闲堆
  归还 OS、页缓存被内核回收后才可能出现），而 after 容器在 11:57 采样时**距重建后启动只有几分钟**，启动维护 +
  首次媒体扫描还在进行 ⇒ 进程 RSS 抬到 120.8 MiB、cgroup 当前占用被刚触摸过的页缓存抬到 557.8 MiB。
  这是采样时刻的**状态差**，不是「优化后更吃内存」。
- **同口径指标（增量、峰值）才是结论**：同样 60 次真实请求造成的内存增量小了一半以上（RSS −65.7%、cgroup −58.8%）；
  进程生命周期峰值 VmHWM 持平（−0.5%）。⇒ **每单位请求的内存成本确实下降，且峰值没有变差。**
- cgroup 峰值 −20.6% 这一行**不足以下结论**：after 侧只覆盖启动后几分钟，before 侧覆盖的是长跑生命周期，
  两个窗口时长不同；它只能说明「没变差」。
- 若要补一行严格可比的「空闲态快照」，在容器跑稳后（启动维护结束、无扫描在跑，例如启动 30 分钟以上）再跑一次
  after 侧采集即可（**不需要重建**，命令见 `docs/perf/RUN-ON-HOST.md` 的四步）。

同一份 `docs/perf/compare.md` 附录里还列了 12 条热接口耗时（**每条只采一次**，所以只看方向与量级）：优化后
**全部 ≤ 优化前** —— `GET /api/games?limit=60` 13.9 → 9.6 ms（−30.9%）、`/api/health` 4.1 → 1.7 ms（−58.5%）、
`/api/settings` 3.7 → 1.5 ms（−59.5%）、`/api/media/1/thumbnail` 2.7 → 1.5 ms（−44.4%）、
`/api/games/1/media/reviews?page=1` 4.1 → 2.4 ms（−41.5%）；`/api/media/1/preview` 持平（1.3 → 1.3 ms）。
它变快的机制不是玄学：同一条列表路径的 SQL 条数从 **651 → 4** 是端点级实测出来的（§5.6）。

### 3.3 磁盘占用

| 项目 | 优化前 | 优化后 |
| --- | --- | --- |
| 运行日志 | json-file 无上限，单调增长（运行 152K 为打包脚本输出，非运行时日志） | 上限 30MB（10m × 3） |
| `metadata_cache` 过期行 | 只增不减（`prune()` 无调用者） | 启动 + 每 6 小时回收 |
| `/data/proxied` | 按 URL 累积，永不清理 | 超期（默认 30 天）按 mtime 删除 |
| `thumbnails`/`covers`/`previews` 孤儿衍生件 | 游戏被删后残留 | 自动清理（`posters/` 不动） |
| SQLite WAL | 随运行增长 | 每次启动 `wal_checkpoint(TRUNCATE)` |
| SQLite **文件内部拼图空洞** | 删行只还到空闲页链表，文件只涨不缩 | 优化项 15：`MAINTENANCE_VACUUM=1` 时启动期 `VACUUM` 归还给文件系统（实测膨胀库 54.8 MB → 2.7 MB，−52.2 MB；默认关闭） |
| 宿主产物 | web/dist 620K → | 632K（多分块，见 3.4）；另有 **+333,788 B** 的构建期预压缩副本（9 个 `.br` 154,940 + 9 个 `.gz` 178,848，`web/dist` 合计 966,833 B）—— 这是**有意留在磁盘上**的，运行期不再压缩（见优化项 9 / 5.2） |
| 上述回收的**实测效果** | — | 造 100 个文件 / 120 KiB 的 `/data` fixture（30 张孤儿缩略图 + 10 封面 + 18 预览 + 20 过期代理图 + 100 条过期缓存行），真启动一次：**删 100 条过期行 + 78 个孤儿文件，回收 78 KiB**，`posters/` 与不认识的文件名零误删（见 5.5） |

**容器侧磁盘（真机采集，`scripts/perf-baseline.sh` ③/④ 节；同 §3.1 的两份基线文件）：**

| 项目 | 优化前（1.2.0） | 优化后 | 变化 |
| --- | --- | --- | --- |
| `/data` 合计（`du -sk`） | 318,896 KiB（311.4 MiB） | 311,288 KiB（304.0 MiB） | −7,608 KiB（−2.4%） |
| SQLite 主文件（探针 `stat()`） | 268,697,600 B（256.2 MiB） | 268,697,600 B | 持平（本仓 DB 未 `VACUUM`，见优化项 15，默认关闭） |
| SQLite WAL（**采集时刻，空闲态**） | 4,247,752 B（4.05 MiB） | **160,712 B（156.9 KiB）** | **−4.07 MiB（−96.2%）** —— 启动 `wal_checkpoint(TRUNCATE)` 的直接证据（优化项 14） |
| SQLite WAL（60 请求后探针） | 4,194,304 B（4.0 MiB） | 4,194,304 B | 持平（两边都停在 1000 页自动 checkpoint 阈值） |
| 页数 / 空闲页（`page_count` / `freelist_count`） | 65,596 / 812 | 65,596 / 812 | 持平 |
| 媒体库（宿主挂载目录） | 69,847,628 KiB（66.6 GiB） | 69,847,628 KiB | 持平（媒体文件一个字节都没动） |
| 运行日志上限 | json-file 无上限 | 10m × 3 = 30 MiB/容器 | 见优化项 13 与 `docs/perf/log-rotation.txt` |

> 一处**口径瑕疵（已如实标注，不影响任何前后差值）**：`docs/perf/compare.md` 里「SQLite 主文件」同时列了两行 ——
> 探针 `stat()` 的 268,697,600 B（权威，和 `page_count × page_size = 65,596 × 4,096 = 268,697,344` 自洽）与
> 采集脚本 ③ 段 `ls -l /data/*.db | awk {s+=$5}` 汇总的 3,399,680 B；两者在同一容器、同一时刻附近给出不同结果，
> 成因未定（同样的 awk 管道在宿主用 5 MiB + 7 KiB 两个 `.db` 测试能得到正确的 5,250,048，脚本逻辑本身没问题）。
> 两份基线里这个键的值完全相同，所以对 before/after 的任何差值都没有影响；对比表以探针 `stat()` 为准。

> 另一处**读表时容易误读的地方**：`docs/perf/compare.md` 附录里的 `cache_size` / `mmap_size` / `synchronous`
> （以及上面的 `temp_store`）是**探针那条只读连接自己的** per-connection 取值——SQLite 这些 PRAGMA 不写进库文件，
> 探针连接没设过，自然就是默认值（`-2000` / `0` / `2`），**不代表应用进程没应用 §二 项 3 的调优**。
> 反过来，`journal_mode`、`user_version`、`page_size`、`auto_vacuum` 这几个是写在库文件里的持久属性，
> 看到的就是真实值（所以两份基线里 `wal` / `12` 相同是有意义的对照）。

### 3.4 首屏传输（宿主实测，`docs/perf/after-local.txt`）

| | 优化前 | 优化后 | 变化 |
| --- | --- | --- | --- |
| 首屏原始（entry.js + css + html） | 627,184 B | 354,585 B | **−43.5%** |
| 首屏 gzip | 171,342 B | 103,800 B | **−39.4%** |
| 首屏 brotli | n/a | 89,431 B | — |
| 实际传输（构建期预压缩，gzip / br） | 627,184 B（无压缩，含 html） | 103,800 / 89,431 B | **−83.4% / −85.7%** |

按需分块（首次不进首屏）：`VideoPlayer` 117,541 B + `GameDetail` 89,552 B + `Settings` 31,645 B + 两张 CSS + `Card`，
合计 275,373 B（gzip 74,295 / br 64,752）。

---

## 四、依赖变更清单

**无。** 没有任何 `package.json` 依赖项被新增、删除、升级或降级；`precompress.mjs`、`precompressed-static.ts`
全部基于 `node:zlib` / `node:fs` 标准库实现。镜像内的删除只是删文件（见 2.10），不涉及版本解析结果。
证据：`git diff -- '**/package.json'` 输出为空 —— 全仓没有任何一个 `package.json` 进入本次改动。

---

## 五、无回归证明

### 5.1 离线套件（与优化前基线逐条一致）

12 套件全部通过，断言数与优化前逐条相同（新增套件只是**加**了断言，没有改任何既有期望值）。
**最新一份日志是 `docs/perf/suites-release-1.3.0.txt`**（版本号升到 `1.3.0` 之后的**发布前最后一跑**，
一键脚本 `bash scripts/verify-suites.sh`）：
**16 项全绿**（2 个类型检查 + 12 套件 434 断言 + 产物自查 38 项命中 + Dockerfile 分层自查 33 项），213s，0 失败；
逐套件断言数与上一份**逐条相同**（98/63/38/13/63/13/22/11/64/10/27/12 = 434）。
上一份 `docs/perf/suites-after-thumb-audit.txt`（补完方向②剩余点名项 —— 缩略图无损压缩可行性实测
与日志轮转留档 —— 之后重跑，16 项全绿 / 434 断言 / 229s）。
上一份 `docs/perf/suites-after-alpine-324.txt`（运行阶段基础镜像钉回 `alpine:3.24`、分层自查从 32 项扩到 33 项
之后重跑，16 项全绿 / 434 断言 / 210s）。
上一份 `docs/perf/suites-after-context.txt`（16 项全绿，204s）覆盖构建上下文瘦身（`.dockerignore` 新增
`.pw` / `.pw-cache`）+ 分层自查从 30 项扩到 32 项。
上一份 `docs/perf/suites-after-audit-fixes.txt`（16 项全绿，233s）覆盖审计复查后的 3 处加固 + 1 处撤回
（那时分层自查 30 项）。
上一份 `docs/perf/suites-after-run-base.txt`（16 项全绿，213s）覆盖运行阶段换最小基础镜像 + 分层自查扩到第 9 组。
上一份 `docs/perf/suites-after-docker-layers.txt`（16 项全绿，216s）覆盖运行阶段逐文件 COPY 与分层自查接入
（那时自查还是 24 项、运行阶段仍是 node 基础镜像）。
上一份 `docs/perf/suites-after-vacuum.txt`（15 项全绿，216s）覆盖可选启动期 `VACUUM` 落地 + 新增
`sqlite-vacuum` 套件 —— 那一跑还没有 `verify-docker-layers` 这一项。
上一份 `docs/perf/suites-final-post-script-edits.txt`（14 项全绿，198s）覆盖用户侧脚本预检加固 ——
那次只改了 `scripts/` 下的宿主机脚本，产品代码未动；`docs/perf/suites-after-vacuum-code.txt`
（14 项全绿，218s）覆盖 `VACUUM` 代码进 `backend/dist` 之后、新套件加进列表之前的那一跑。
更早的 `docs/perf/suites-after-queries.txt` 覆盖列表查询批次化与测试库锁硬化，`docs/perf/suites-after-batch.txt`
覆盖评分目标批量读等改动，`docs/perf/suites-final.txt` 覆盖卡帧改缩略图。

**测试自身的锁抖动已修掉（只动测试脚本，产品代码一行未改）**：`poster-rotation-e2e` 在本轮首跑
（留档 `docs/perf/suites-after-queries-flake.txt`）和更早的 `docs/perf/suites-after3.txt` 都出现过
`Error: database is locked`（`code: 'ERR_SQLITE_ERROR', errcode: 5`），位置都是
`backend/scripts/verify/poster-rotation-e2e.mjs:344` 的 `for (const id of globalThis.__legacyIds) del.run(id);`。
根因是**测试进程自己**用 `node:sqlite` 的 `DatabaseSync` 打开同一个 `screenplay.db` 删它自己造的假行时，
busy timeout 默认为 0，一撞上正在跑的服务的写事务就立刻抛错 —— 后端的连接早已设 `busy_timeout = 5000`
（见优化项 3），唯独测试侧没有。实测确认该选项就是 busy timeout：持锁连接不放时
`new DatabaseSync(f, { timeout: 800 })` 会先等满 802 ms 才抛 `database is locked`，锁一释放同一句就成功。
现在 4 个会写库的离线套件里 9 处 `DatabaseSync` 构造都加了 `{ timeout: 5000 }`
（`backend/scripts/verify/poster-rotation-e2e.mjs`、`backend/scripts/verify/media-reviews-e2e.mjs`、
`backend/scripts/verify/duration-cache-e2e.mjs`、`backend/scripts/verify/password-change.mjs`），
断言与期望值一字未改；该套件随后连续两次单独重跑都是 22 / 0。
（另：判断套件是否通过要看有没有 `结果：` 行 —— 早期日志里「退出码」曾被 `| tail` 取错状态。）

| 套件 | 结果 | 套件 | 结果 |
| --- | --- | --- | --- |
| review-pagination-test | 98 / 0 | duration-cache-e2e | 13 / 0 |
| metacritic-reviews-test | 63 / 0 | poster-rotation-e2e | 22 / 0 |
| metacritic-api-test | 38 / 0 | poster-ui-ssr | 11 / 0 |
| metacritic-crawl-test | 13 / 0 | requirements-ui | 64 / 0 |
| media-reviews-e2e | 63 / 0 | poster-merge-unit | 10 / 0 |
| password-change | 27 / 0 | **合计** | **434 断言 / 0 失败** |
| sqlite-vacuum | 12 / 0 | （新增：`MAINTENANCE_VACUUM` 默认关 / 开启两条路径） | |
| verify-docker-layers | 33 / 0 | （新增：Dockerfile 分层 9 组规则，**纯静态**，不需要 docker；含 `.dockerignore` 必须排除 `windows` 与 `.pw`、运行阶段 alpine 版本必须与构建阶段同版） | |

`APP_DIR=$PWD sh scripts/verify-build-artifacts.sh` → **38 项命中 / 0 项缺失**（分块后的新产物同样全中）。
原始输出：`docs/perf/suites-before.txt`、`docs/perf/suites-after.txt`、`docs/perf/suites-after2.txt`、
`docs/perf/suites-after-batch.txt`、`docs/perf/suites-final-post-script-edits.txt`、
`docs/perf/suites-after-vacuum-code.txt`、`docs/perf/suites-after-vacuum.txt`、
`docs/perf/suites-after-docker-layers.txt`、`docs/perf/suites-after-run-base.txt`、
`docs/perf/suites-after-audit-fixes.txt`、
`docs/perf/suites-after-context.txt`、
`docs/perf/suites-after-alpine-324.txt`、
`docs/perf/suites-after-thumb-audit.txt`、
`docs/perf/suites-release-1.3.0.txt`（最新）。

### 5.2 压缩与缓存头实测（真实后端，宿主 127.0.0.1:3399）

| 请求 | 结果 |
| --- | --- |
| `Accept-Encoding: gzip` → `index.js` | 200 + `Content-Encoding: gzip` + `Content-Length: 159299` + `Vary: Origin, Accept-Encoding` + `immutable` |
| `Accept-Encoding: br` → `index.js` | 200 + `Content-Encoding: br` + 135,064 |
| `Accept-Encoding: gzip, deflate, br` | 选 br（优先级正确） |
| `Accept-Encoding: deflate` 或不带编码 | 回落未压缩 552,818（未破坏原行为） |
| CSS / favicon.svg | gzip 12,569 / 1,250，favicon 为 `no-cache` |
| `/`（index.html） | 744，`no-cache` |
| 带 `Range: bytes=0-99` | 206 Partial Content（**不压缩**，视频/图片 Range 语义未受影响） |
| 命中 `If-None-Match` | 304 |

**审计复查后的补测（同一台宿主后端，`web/dist` 重新构建过，所以文件名哈希与字节数与上表不是同一份产物）**：
协商逻辑改成按 **q 值**排序后，逐一实测（`Accept-Encoding` → 实际返回）：

| 请求头 | 结果 | 说明 |
| --- | --- | --- |
| `br` | `Content-Encoding: br`，82,933 B | 首选正确 |
| `br, gzip` | br，82,933 B | 两个都接受时选 br |
| `gzip` | gzip，96,090 B | 只有 gzip 时不硬塞 br |
| **`gzip;q=0`** | **不压缩，316,035 B** | **审计发现的那处缺陷已修**：q=0 = 客户端明确拒绝，不再返回 gzip |
| `br;q=0, gzip` | gzip，96,090 B | br 被显式拒绝时退到 gzip |
| `gzip;q=0.5, br;q=0.9` | br，82,933 B | 两个都接受时按 q 高者，而不是「谁写在前面」 |
| `br;q=0, gzip;q=0` | 不压缩，316,035 B | 全部拒绝 ⇒ 回落（`next()`） |
| `identity` / `*` | 不压缩，316,035 B | `*` 故意忽略：只发客户端点名的编码 |
| `br, gzip`（把 `.br` 临时移走） | gzip，96,090 B | 兜底链：首选变体缺失时用次选，而不是回落未压缩 |
| `Vary` | 选中变体时 `Origin, Accept-Encoding`；不压缩时 `Origin` | CORS 的 `Vary: Origin` 未被覆盖 |

同一轮补测的响应头：`/assets/index-*.js` → `Cache-Control: public, max-age=31536000, immutable` +
弱 ETag（`W/\"4d283-1a0fd86a46c\"`）；`/`（index.html）与 `/favicon.svg` → `no-cache`；
`Range: bytes=0-99` → `206` + 100 B + **无 `Content-Encoding`**（Range 请求直接 `next()`，压缩中间件不介入）。

### 5.3 长跑 / 泄漏扫描（3000 次请求，真实产物，`docs/perf/leak-soak.txt`）

`bash scripts/perf-bench/bench-soak.sh`：起真实 `backend/dist` 服务，按固定间隔采样 VmRSS、V8 堆、
活跃句柄数、不同 SQL 形状数，轮流打 15 条真实热路径（列表各排序/筛选、详情、媒体列表、相邻、缩略图、
静态入口），3000 次请求。

| 指标 | 首采 | 中途 | 结束 | 判定 |
| --- | --- | --- | --- | --- |
| VmRSS | 147.7 MiB | 185.1 MiB（前 500 次内到平台） | 190.8 MiB | 后半段 +0.5%，无单调增长 |
| V8 堆（`heapUsed`） | 46.3 MiB | 39.8 MiB | 56.5 MiB | 34–57 MiB 锯齿（GC 正常回收），无趋势 |
| 活跃句柄 | 1 | 1 | 1 | 稳定，无定时器/连接堆积 |
| 不同 SQL 形状数 | 25 | 25 | 25 | 全程不变 ⇒ 语句缓存键空间由 SQL **形状**决定，不随参数值增长（`STATEMENT_CACHE_LIMIT = 512` 根本用不满） |

平均 4.6 ms/次、最慢 23 ms。结论：**未发现泄漏**；QPS 前后无退化。
口径：宿主没有 better-sqlite3 原生产物，驱动由仓库自带 node:sqlite shim 顶替 —— 量的是应用层
（序列化、缓存、句柄、语句缓存）的内存行为，SQLite 驱动自身的内存不在口径内；容器侧请用 3.1 的
`scripts/perf-baseline.sh`。

### 5.4 数据兼容

未改 DDL、未改 migrations、未改任何表结构或数据格式；新增的回收只删除**可再生缓存**
（远程响应副本、按需重制的图片衍生件），`posters/` 里的用户上传原图永不触碰。
`screenplay-data` 命名卷不变，重建镜像不会丢数据。

不是只凭推理，有三份可复核的证据：

1. **DDL / 索引 / 持久化开关：全 diff 零改动** ——
   `git diff -- backend web | grep -Ei 'CREATE TABLE|ALTER TABLE|addColumnIfMissing|CREATE (UNIQUE )?INDEX|DROP (TABLE|INDEX)|PRAGMA (journal_mode|synchronous|auto_vacuum|user_version)|JXR_PIPELINE_VERSION'`
   在增删行里**一条都匹配不到**。`database.service.ts` 在 SQL 层的改动只有三样（§二 项 2/3/15）：
   prepared statement 缓存、`busy_timeout = 5000` + `temp_store = MEMORY`、启动时 `wal_checkpoint(TRUNCATE)`
   与可选的 `VACUUM`；代码注释里明确写了 `synchronous` **故意保持默认 FULL**（不动断电持久化语义）。
   缓存句柄在 schema 变更后仍有效（SQLite 会自行重新 prepare，注释里也写了这一点）。
2. **在「已经存在、且有数据的库」上真跑启动** —— `backend/scripts/verify/sqlite-vacuum.mjs` 的现场不是
   应用自己建的库：它先造一个含 3 行 `keep` 业务数据的文件，再直接对该文件跑编译产物里的
   `DatabaseService.onModuleInit()`。断言结果是 **3 行一行不少、`PRAGMA integrity_check = ok`、默认路径不做
   VACUUM**（12 项断言全过，见 `docs/perf/suites-after-audit-fixes.txt`）⇒ 老库上身是追加式建表/迁移，不丢数据。
3. **12 个 e2e 套件都走「真实 service 建库写数据 → 接口 / 浏览器断言」这条路**（合计 434 项断言），
   另有 `docs/perf/maintenance-reclaim.txt` 证明回收只删可再生缓存（100 → 22 个文件）且 `posters/` 零误删。
4. **重建后同一个库、同一份数据的现场核对（真机采集）** —— 优化前后的容器探针读的是**同一个**
   `/data/screenplay.db`（`db_file=/data/screenplay.db`、`db_read_via=original(readonly)`，脚本全程只读打开），
   两份基线里 `db_user_version=12`、`db_encoding=UTF-8`、`db_page_size=4096`、`db_page_count=65596`、
   `db_freelist_count=812`、`db_tables=18`、`db_indexes=11`、`db_auto_vacuum=0`、`db_journal_mode=wal`、
   `db_quick_check=ok` **逐键相同**，宿主媒体目录 69,847,628 KiB 也一个字节没变 ⇒ 换基础镜像 + 重建容器之后，
   老库存量数据被原样打开、结构版本未动、校验通过。
   （注意：`db_cache_size` / `db_mmap_size` / `db_temp_store` / `db_synchronous` 是**探针那条只读连接自己的**
   per-connection 取值，不反映应用进程的设置，所以不列入本项对照 —— 见 §3.3 末尾的说明。）

### 5.5 回收（维护）端到端验证（`docs/perf/maintenance-reclaim.txt`）

`bash scripts/perf-bench/bench-maintenance.sh`：造一个「过期缓存行 + 孤儿衍生件 + 用户上传海报 + 陌生文件名」
的 `/data`，真启动一次后端（`MAINTENANCE_ON_BOOT` 默认开启），逐条断言。

| 断言 | 结果 |
| --- | --- |
| `caches reclaimed: 100 expired cache row(s), 78 stale file(s)`（`Boot maintenance finished in 0.6s`） | ✅ |
| 孤儿衍生件按规则被删：30 缩略图 + 10 封面 + 18 预览 + 20 过期代理图 = 78 | ✅ |
| `keepIds`（media 行仍在）的衍生件保留，哪怕文件很老 | ✅ |
| 名字不匹配规则（`random.webp`、`not-a-uuid.webp`、`notes.txt`）一律不碰 | ✅ |
| `proxied/` 里未过期的保留 | ✅ |
| `posters/` 整目录完好（用户上传原图） | ✅ |
| `metadata_cache` 150 行 → 50 行（只删过期行） | ✅ |

合计 **10 项断言 / 0 失败**，文件数 100 → 22、字节 122,880 → 43,008（回收 78 KiB）。
口径与长跑一致：宿主没有 better-sqlite3 原生产物，驱动由 node:sqlite shim 顶替。

### 5.6 列表路径「查询批次化」前后逐条对比（`docs/perf/list-path-queries.txt`）

同一份 500 局 / 1500 媒体种子库快照、真实后端 + HTTP，逐条比对 SQL 执行次数与响应指纹：

| 接口 | SQL 前 | SQL 后 | 响应 |
| --- | --- | --- | --- |
| `GET /api/games?limit=60` | 102 | **4** | 34,100 B，`6a8732974ef55a2d` 前后一致 |
| `GET /api/games?limit=60&page=2` | 102 | **4** | 34,149 B，一致 |
| `GET /api/games?limit=60&sort=mediaCount` | 602 | **6** | 33,501 B，一致 |
| `GET /api/games?limit=60&sort=mediaCount&order=desc` | 602 | **6** | 33,501 B，一致 |
| `GET /api/games?limit=60&sort=custom` | 102 | **4** | 33,501 B，一致 |
| `GET /api/games?limit=60&sort=metacritic&order=desc` | 102 | **4** | 34,111 B，一致 |
| `GET /api/games?limit=60&platform=PC` / `&q=Game` | 102 | **4** | 34,100 B，一致 |
| `GET /api/games/:id`（详情） | 13 | 13 | 5,052 B，一致 |
| `GET /api/games/:id/neighbors` | 2 | 2 | 166 B，一致 |
| `GET /api/games/:id/media` / 缩略图 | 1 | 1 | 一致 |

**12 条接口的响应字节数与 sha256 前 16 位全部相同** ⇒ 这次改动只改「数据怎么取」，不改「取到什么」。

### 5.7 索引核对：现有索引已覆盖全部逐请求热点查询（`docs/perf/query-plans.txt`）

「SQLite 清理收缩与**索引**」这一项需要的不是「加索引」，而是先回答「现有索引够不够」。
做法：`scripts/perf-bench/seed-plan-db.js` 把 1000 局 / 1500 媒体的基准库复制一份并给
`game_posters`(6000) / `achievements`(3000) / `media_reviews`(4000) / `metadata_cache`(300) /
`rating_targets`(1000) / `auth_sessions`(5) 都填上该规模的合成行（空表的执行计划没有说服力），
再用 `scripts/perf-bench/query-plans.js` **只读**打开，把产品代码里逐字复制过来的 19 条热点 SQL
交给 `EXPLAIN QUERY PLAN`。原始输出 `docs/perf/query-plans.txt`。

逐请求路径（每页要跑很多次的那些）**全部走索引**：

| 热点查询 | 计划 |
| --- | --- |
| 鉴权：`auth_sessions WHERE token = ?` | `SEARCH ... USING INDEX sqlite_autoindex_auth_sessions_1 (token=?)` |
| 元数据缓存命中：`metadata_cache WHERE key = ?` | `SEARCH ... USING INDEX sqlite_autoindex_metadata_cache_1 (key=?)` |
| 会话过期清理 / 缓存过期清理 | 走 `idx_auth_sessions_expiry` / `idx_meta_cache_expiry` |
| 列表海报行（批量 `IN`） | `SEARCH game_posters USING INDEX idx_game_posters_game (game_id=?)` |
| 卡片海报（`CARD_POSTER_SQL`） | 同上 |
| 媒体计数（批量 `IN` + `GROUP BY`） | `SEARCH media USING COVERING INDEX idx_media_game (game_id=?)` |
| 详情媒体列表 / 媒体计数 | `SEARCH media USING INDEX idx_media_game`（计数那条是 COVERING） |
| 评分目标单局 / 整表一次读 | 单局走 `sqlite_autoindex_rating_targets_1`（`game_id` 是主键） |
| 成就：详情页 / `(game_id, tier)` | `idx_achievements_game` / `idx_achievements_game_tier` |
| 媒体评价按 `game_id` | `idx_media_reviews_game` |
| 详情：`games WHERE id = ?`、`media WHERE id = ?` | 走各自主键索引 |

四条**全表扫描是有意为之**，不是漏索引：`SELECT <17 列> FROM games`（画廊排序要先取全部候选行）、
`SELECT * FROM rating_targets`（优化项 2 就是「整表一次读成 Map」）、`SELECT id FROM media`（维护清扫要的 id 全集，
且走的是 covering index）、统计接口的 `COUNT/SUM(size_bytes)` 聚合。千行级表上这些扫描是毫秒以下量级。

**结论：不新增索引。** 计划里唯一的额外动作是 `game_posters` 卡片海报与详情媒体列表各有一句
`USE TEMP B-TREE FOR ORDER BY` —— 那是对**单局**的那几行做排序，加复合索引只为省这一次微排序，
代价却是实打实的索引体积与写放大，与「磁盘占用优化」相冲突。

---

### 5.8 独立审计复核（产品代码 22 文件 / 75 个 hunk，逐 hunk 判定）

本轮改动落定后，我另外让一个**只读**的独立审计过了一遍 `backend/src/**` 与 `web/src/**` 的 diff，任务是
逐 hunk 回答「这是不是纯效率改动」。它给出 **5 处越界 + 3 处可疑**，处置如下（这一节就是那 8 条的去向）：

**保留，但改进措辞（属四项方向点名的范围）**

1. `backend/src/main.ts:71-76` 的 `setHeaders`（`/assets/*` → `immutable`，其余 `no-cache`）—— 属方向 ④
   「缓存策略」。§一 已改掉原来「`Cache-Control` 语义本轮一行未改」的表述，改成事实（见 §一 第二段与
   优化项 10），实测见 5.2。
2. 前端 `lazy()` / `loading="lazy"`（`web/src/App.tsx:25-26`、`web/src/components/MediaGrid.tsx:21,228-230`、
   `web/src/components/PosterCarousel.tsx:218`）—— 属方向 ①「大对象按需加载」，代价（首帧占位）已写进 §一 第 3 条，
   并留下回退点。

**已撤回**

3. `web/src/api/hooks.ts:501,525` 的空闲轮询降频（5s → 15s、20s → 30s）—— 改为保持原值，见优化项 8。

**已加固（代码改动）**

4. `backend/src/common/http/precompressed-static.ts:83` 原文
   `const encoding = /\bbr\b/.test(accepted) ? 'br' : /\bgzip\b/.test(accepted) ? 'gzip' : null;` 忽略 q 值 ⇒
   `Accept-Encoding: gzip;q=0` 仍会被塞 gzip。现在改为 `selectEncodings()`：逐段解析 q（非有限值按 1、clamp 到
   `[0,1]`、同名取最大），`q > 0` 才进候选，按 q 排序（相等时 br 优先）后取首个**存在且不比源文件旧**的变体；
   `*` 故意忽略。实测矩阵见 5.2。
5. `backend/src/database/database.service.ts:74` 的启动期 `wal_checkpoint(TRUNCATE)` 原来没有 guard ⇒ 现在包
   `try/catch` 只 `warn`。实测该 pragma 在写锁竞争下**不抛错**（返回 `{"busy":1,…}`），所以这条是兜底而非必需；
   同一场景下 `VACUUM` 确实抛 `database is locked`（第 15 项的 guard 因此是必需的）。
6. `backend/src/maintenance/maintenance.service.ts:250-251` 的 `proxied/` 清扫按 mtime 删 30 天前的远程图缓存 ——
   源 URL 失效后那可能是唯一副本。现在**可关**：`PROXIED_CACHE_TTL_DAYS=0` 直接跳过这次清扫（缺省仍是 30 天；
   非数字回落 30 天）。默认行为未变，风险由部署者按「是否需要永久离线可用」决定。

**判为不构成回归（记录在案）**

7. `web/src/components/HeroPosterCarousel.tsx` 只加 `decoding="async"`（不加 `loading="lazy"`）—— 恒定轮播必须
   在切换时就绪，这一点代码里已按此执行。
8. 审计同时确认了一批「输出/行为不变」的改动可以直接引用：`games.service.ts` 的投影 + 批次化在
   `docs/perf/list-path-queries.txt` 里 12 条接口的字节与 sha256 **逐字节相同**；`posters/`（用户上传）在任何路径下
   都不被清扫（`posters.service.ts:135`）；被删的 9 个前端导出与 `probeTcp` 在全仓 `*.{ts,tsx,mjs}` 里 0 引用。
   它另外列了 3 项**需要在真机上才看得见**的观感（懒加载帧、首帧占位、轮询回退后的可见延迟）—— 这些只有你
   在真机/浏览器上看才算数。

---

## 六、部署与使用方式不变

* `docker compose up -d` / `docker compose pull` / `docker compose up -d --force-recreate`：完全不变。
* 环境变量：全部为**新增可选**项，不设就用默认值 ——
  `HOUSEKEEPING_INTERVAL_MS`（默认 6 小时，0=仅启动一次）、`PROXIED_CACHE_TTL_DAYS`（默认 30 天；
  **设成 0 就永不清扫** `proxied/` 这份可再下载的远程图缓存 —— 见 5.8 第 6 条）、
  `MAINTENANCE_VACUUM=1`（默认**关闭** = 不 `VACUUM`，见优化项 15；只想临时收缩一次的话，用完删掉这个变量即可）。
  原有 `MAINTENANCE_ON_BOOT=0` 语义不变（顺带关掉回收）。
* 端口、卷、`/api` 路由、登录方式、前端交互：一律不变。
* 部署文件的改动是**纯新增**，可当场复核：`git diff --numstat -- docker-compose.yml docker-compose.deploy.yml`
  ⇒ `9 0` / `10 0`（插入 9+10 行、**删除 0 行**）—— 多出来的只有那段 `logging:` 块与注释，
  `image` / `container_name` / `ports` / `volumes` / `environment` / `extra_hosts` / `restart` 逐字未动。
  `.dockerignore` 的改动是**纯新增排除**（`git diff --numstat -- .dockerignore` ⇒ 19 增 / 2 删，
  那 2 行删除是原来结尾没有换行的 `.idea`（顺手补了换行）与一句注释措辞的微调）：
  新增的是 6 行排除（`windows`、`android`、`dist-image`、`**/dist-desktop`，以及本轮补的
  `.pw`、`.pw-cache`）+ 12 行解释性注释（为什么这几块不进镜像、`.pw` 的回归根因、怎么复现
  上下文 555.0 MiB 的 before），剩下 1 行是原文件末尾那行 `.idea` 因顺手补了换行而被重写；
  `scripts/` **没有**被排除（Dockerfile 要 `COPY scripts/build/`），`backend/`、`web/` 也照旧在上下文里。
* 镜像构建：`bash scripts/rebuild-and-verify.sh`、`SKIP_BUILD=1 bash scripts/package-image.sh` 均可照旧使用；
  新增的预压缩步骤写在 `Dockerfile` 里，不需要额外的构建参数。
  注意：**宿主上手工 `cd web && npm run build` 不会产生 `.br`/`.gz`**（那是镜像构建阶段的一步）；
  想在宿主上验证投递行为，先跑一次 `node scripts/build/precompress.mjs web/dist` 即可。
  `scripts/rebuild-and-verify.sh` 新增了第 5 步体检：直接断言 entry 的 `Content-Encoding`、
  `Cache-Control: immutable`、不压缩回落、以及 `index.html` 的 `no-cache`（本地实测输出见 5.2）。
* 用户侧脚本三处**预检加固**（只改「失败何时被发现」，不改任何行为）：
  * `scripts/rebuild-and-verify.sh`：第 4 步里断言启动期维护日志的那段原本按旧措辞（`cover rotation repaired` /
    `auto-added album frames removed`）匹配，而 1.2.0 的真实措辞是
    `Boot maintenance finished in Xs — auto-added frames removed from the card rotation: N; completion-time backfill …; caches reclaimed: R expired cache row(s), F stale file(s) (B).`
    （无事可做时是 `Boot maintenance finished in Xs — nothing to repair.`，见
    `backend/src/maintenance/maintenance.service.ts:164-175`），照旧写会**每次都误报**「只看到旧措辞」。
    现已按真实措辞断言，并顺带打印回收行数与文件数。另外逐条核对了它期待的 feature 标记：
    镜像返回的 30 条标记里 **15/15 全部存在**（`require('backend/dist/app.controller.js').BACKEND_FEATURES` 比对），
    第 4 步的标记门不会假失败；容器名/服务名（`screenplay`）与端口映射 `${PORT:-3001}:3000` 也已核对一致。
  * `scripts/package-image.sh`：新增**输出目录可写预检**（放在构建之前；失败时给出 `chmod 755` / `sudo chown` /
    换 `OUT_DIR` 三种修法，而不是等 `docker save` 到一半才 Permission denied），以及**脏工作区包名后缀** ——
    有未提交改动时包名变成 `screenplay-1.2.0-<sha>-dirty.tar.gz`：既避免与「同样是 HEAD 的上一版包」重名、
    被第 3 步的 `[ -e "$TARBALL" ]` 直接 `die` 掉，也让包名如实反映它包含未提交内容（本轮产物正是这种情况）。
  * `scripts/perf-baseline.sh`：这是采集「优化前 / 优化后」三项指标的脚本，而**「优化前」只有一次机会**
    （容器一被替换就再也取不到旧镜像的运行时数据），所以用一个假 docker CLI（`/tmp/fakebin/docker`，
    罐装 `info` / `image inspect` / `history` / `stats` / `inspect -f` / `exec` 输出）在宿主上把六节
    **完整干跑**了一遍，因此抓出并修掉 4 个会让 before 白跑的问题：
    ① 参数解析只认 `--load` / `-h`，而操作卡与本节写的是 `--load OUT=docs/perf/before-docker.txt`
    （`OUT=` 当**参数**）—— 会被当成未知参数直接 `exit 2`；现在 `NAME=VALUE` 两种写法都支持
    （环境变量前缀 `OUT=… bash …` 与参数 `bash … OUT=…`，共 8 个键）。
    ② ⑥ 负载节的 RSS 提取用 `awk '/VmRSS/{print $2}'`，但读内存的输出先被 `tr '\n' ' '` 拼成一行 ⇒
    `$2` 恰好是 `VmRSS:` 本身，算术里触发 `scripts/perf-baseline.sh: line N: VmRSS: unbound variable`
    并在**写 `OUT` 之前**退出（整份「优化前」直接丢）；现在按「`VmRSS:` 之后的下一个字段」定位，
    任何非数字输出回落 0。
    ③ ① 镜像节的层大小解析只看**最后一个字符**当单位 ⇒ `178MB` / `12.5MB` / `1.2GB` 全被当成字节数前缀
    （罐装数据实测「各层大小合计」只剩 531 B）；现在按完整后缀（`B` / `kB` / `MB` / `GB` / `TB`）换算，
    同一组罐装数据得到 1.39 GiB。
    ④ `db_wal_bytes` 被 ③（列目录求和）与 ④（SQLite 探针）两处赋值 ⇒ `# KEY=VALUE` 汇总里同键两行、
    值不同，对比可能取错；③ 那处改名 `db_wal_file_bytes`。
    另外加了**退出兜底**（`trap … EXIT` 调 `dump_out`，在 docker 门禁通过之后注册）：即使后面某一步
    出错，已采集到的键值也会落盘，不会「白跑一趟什么都没有」。
    干跑结论：退出码 0、六节齐全、54 个 `KEY=VALUE` 键、无重复键（留档 `docs/perf/baseline-dryrun-keys.txt`，
    并用它当 before/after 冒烟跑通了 `scripts/perf-compare.sh`：三张对比表全部正常出数、退出码 0）；
    操作卡里也补上了「不带 `AUTH_USER`/`AUTH_PASSWORD` 时 `/api/media/*` 三条会 404、
    图片热路径测不到」的提醒。
* 日志轮转配置已用 `docker compose -f docker-compose.yml config -q` 与 `-f docker-compose.deploy.yml config -q`
  校验（两份都退出码 0），解析结果确认 `logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }` 生效
  —— 即 **30 MiB / 容器**上限（改动前 json-file 默认不限制）；逐条留档见 `docs/perf/log-rotation.txt`
  （两份 compose 的原文行号、`config` 解析结果、退出码、`--numstat` 只增不删）。这一项**不需要 docker 守护进程权限**就能复核。
* 三项指标的前后对比：**已实测完成**（2026-10-03，真机）—— 未重建的 1.2.0 容器采
  `docs/perf/before-docker.txt`，重建后采 `docs/perf/after-docker.txt`，一条命令出表 `docs/perf/compare.md`：
  镜像 386.8 → 322.1 MiB（−16.72%）、同口径 60 请求内存增量 RSS −65.7%、`/data` −2.4%、空闲态 WAL −96.2%。
  逐步操作卡（含只读性说明、复采方式、故障排查表）见 `docs/perf/RUN-ON-HOST.md`；要复采时把上面两条
  `perf-baseline.sh` 命令再跑一遍即可（第 3 步不需要重建）。

---

## 七、明确没动的东西（有理由，不是漏掉）

| 项 | 为什么不动 |
| --- | --- |
| `PRAGMA optimize` / 建索引 | 已核对（见 5.7，`docs/perf/query-plans.txt`）：**现有索引已覆盖全部逐请求热点查询**，无需新增索引，所以这一项连「加索引」的必要性都不存在。`PRAGMA optimize` 仍不做：它会创建/刷新 `sqlite_stat1`，改变查询计划与无 ORDER BY 查询的行序，威胁分页 tie-order；DDL 也是冻结项 |
| `PRAGMA synchronous = NORMAL` | 改变断电/崩溃语义，属功能退化风险（列为可选建议） |
| `VACUUM` **无条件/自动**执行 | ~~不动~~ → **改成显式开关**（优化项 15）：`VACUUM` 要重写整库、瞬时再要一份库大小的空闲空间，better-sqlite3 又是同步的，大库上会阻塞启动几十秒到几分钟 —— 这种成本只能由运维主动承担，所以默认关闭 + 一个环境变量按需开启；不想动环境变量也可以手工执行一条等价的 one-shot（运行镜像里**没有** `sqlite3` CLI，用镜像自带的 better-sqlite3：`docker compose stop screenplay` → `docker compose run --rm --entrypoint node screenplay -e "new (require('/app/node_modules/better-sqlite3'))('/data/screenplay.db').exec('VACUUM')"` → `docker compose start screenplay`） |
| `VACUUM` 之外的 `PRAGMA auto_vacuum` | 改它是**库格式级**开关，且必须配一次全量 `VACUUM` 才生效；收益与优化项 15 重叠，却多一条「老库不自动转换」的隐性路径，不做 |
| Node 堆参数（`--max-old-space-size`） | ~~只是「没有堆压力证据」~~ → **已经实测过了，结论仍是「不加」**（这一项不再是「没做」，是「做完后判定不该做」）。`NODE_OPTIONS` 四个变体各跑同一份 1200 次请求负载（真实 `backend/dist`，原始输出 `docs/perf/heap-flags.txt`）：<br>· 默认 RSS 147.9 → 186.8 MiB，`heapUsed` 41.8 → 32.6 MiB，5.37 ms/次<br>· `--max-semi-space-size=8` RSS **238.5 MiB（更差 +28%）**，5.66 ms/次，最慢一次 52.27 ms（新生代太小 → 提前晋升）<br>· `--max-old-space-size=256` RSS 186.3 MiB，5.49 ms/次 —— 堆常驻只有 ~40 MiB，离上限极远，等于把参数写进部署里却永远不生效<br>· `--max-semi-space-size=32` RSS 184.8 MiB，5.47 ms/次（−1.0%，在噪声里）<br>四者活跃句柄都 1 → 1、SQL 形状 29 种，无泄漏。结合 5.3 的长跑（`heapUsed` 34–57 MiB 锯齿、VmRSS 500 次内到平台）与 JXR 解码峰值属**原生缓冲区**（调堆参数不解决），结论：**不写死任何堆参数** —— 唯一实测有效的改动方向（缩小新生代）反而更差 |
| ~~`cardPosters` 的 `/preview` → `thumbUrl`~~ | **已做**（见优化项 7）：用户确认接受画质变化后，在**前端卡片**这一面把 media 帧换成缩略图；后端 `cardPosters` 与 `game.posters` 载荷**未改** |
| 缩略图再做一次「无损高压缩」 | **评估后判定负收益，不做**（方向②点名项之一，见优化项 9 末条与 `docs/perf/thumb-compression.txt`）：生产管线产的 480px WebP q80 缩略图，gzip −0.8% / brotli −1.2%（格式已熵编码）、无损 WebP 重编码 **+308.5%**、源图无损 WebP **+124.5%**；能变小的只有降质量（q70 −12.0%）而那会改画面。缩略图侧的真收益是「卡片改用缩略图」（优化项 7）+「过期衍生件清理」（优化项 4） |
| 每请求写 `auth_sessions.last_seen` | 写放大确实存在，但会改变会话续期语义，且与本次三项指标无关 |
| `IgdbProvider`（`backend/src/metadata/providers/igdb.provider.ts:39` 从未注册）/ `PluginsService` 未接线 | 这是**功能缺口**（README/docs 仍承诺 IGDB），补上是加功能，不是本次范围；已单独列为待办 |
| ~~出页卡片的海报行 + 媒体计数（每请求 100 条小语句）~~ | **已在优化项 1 收走**：改为按页面 id 批量取（`cardPosterRows()` / `mediaCounts()`），102 → 4 条。冻结契约没有被改 —— `cardPosters()` 的函数体与去重/兜底逻辑原封不动，只换了行的来源，12 条接口的响应 sha256 前后一致（`docs/perf/list-path-queries.txt`）。默认排序下剩下的 4 条已是最低限度：games 投影 1 + `rating_targets` 1 + 两次批量查询的 1 + 1 |
| 已加载图片在滚出视口后**主动卸载**（`src=""` / 手动 disconnect）| 方向①里的「非可视区释放」现在由**浏览器原生机制 + `loading="lazy"`** 承担：非可视区的帧根本不发请求、不解码（优化项 6），已经在视口内解码过的位图由浏览器在内存压力下自行淘汰；且 `/assets`、缩略图/海报响应都是 `immutable` 强缓存，滚回来不产生网络请求。手工卸载会让「滚回去」时出现可见的重新解码闪动，属交互时序变化（本轮的硬约束不允许），故不做；若日后真机测出压力，再按「离开视口超过 N 屏才释放」的最小改动加 |
| `React.memo`、共享 IntersectionObserver、请求 `AbortController` | 涉及渲染/交互时序，需要真机浏览器测量才能证明「无退化」；本轮不做，列为可选 |
| Docker **层合并** | 已核对（删除类）：run 阶段唯一的「跨层先加后删」只有那一个 18,471 B 的 `COPY scripts/build/apk-setup.sh`（构建期 apk 换源校验必需，`--mount` 在经典构建器降级路径上不可用），其余全部同层删除 + `scripts/verify-docker-layers.mjs` 的 **33 项**静态断言固化。本轮瘦身分两类：①「删除类」（`npm prune --omit=dev`、删包内死重、删 `.d.ts`、删 `node_modules` 非运行期文件 `*.map`/`*.md`/`*.d.ts`（9.84 MiB））；② 一处**结构改动** —— 运行阶段换最小基础镜像（优化项 16，那是唯一必须动结构才能回收的字节）。不做合并的理由：层数收益只能在有 docker 的机器上用 `docker history` 验证（本轮环境无 docker 权限），而把多条 `RUN` 合并会牺牲既有的缓存分层 —— 现在改后端源码只重跑构建层，依赖安装层仍命中缓存；合并后每次改源码都要重装依赖，构建时间与网络成本反而上升。层数与各层合计体积已由 `scripts/perf-baseline.sh` 的 ① 节采集（`image_layers` / `image_layer_sum_bytes`），before/after 对比表里会直接列出（换基础镜像会改变层清单，具体形态以真机实测为准） |
| ~~删掉运行镜像里的 `npm` / `npx` / `corepack`（yarn/pnpm shim）~~ | **已做 —— 但不是「删」而是「换基础镜像」**（优化项 16）：它们住在**基础镜像层**里，上层 `rm` 只是加一个白洞、基础层字节照旧被下载与落盘 ⇒ 运行阶段改成 `alpine:3.24` + 只 `COPY` 构建阶段的 `node` 二进制，把那一整层 155,819,008 B（148.6 MiB）连同旧的 alpine rootfs 层、yarn 安装层（5,388,288 B）、`docker-entrypoint.sh` 层（3,584 B）一起换掉（**净省 28,995,400 B，全部为实测值**，见优化项 16 的层核算）。前提已逐条核对：本仓没有任何脚本或文档在容器内跑 npm —— 把 `scripts/` 下所有 `docker exec` 的命令行抓出来看只用到 `node` / `sh` / `rm` / `du` / `ls` / `grep` / `cat`，文档里的容器内核查也只用 `grep` / `wc` / `strings`（busybox，换基础镜像前后同样是 alpine），部署命令是 `docker compose`，健康检查用 wget，所以这只是「镜像里少了两个用不到的工具」，与功能无关。风险由三重防线覆盖：构建期 `RUN node -v`、`scripts/verify-docker-layers.mjs` 第 9 组 6 项断言（负例 A–E 全命中，含「把运行阶段改回 `node:22-alpine` 或写错 alpine 版本」）、真机构建后 `scripts/rebuild-and-verify.sh` 的真启动断言 |
| ~~空闲轮询降频（5s → 15s、20s → 30s）~~ | **已撤回**（见优化项 8）：它改的是交互时序、不省内存也不省磁盘，会让「别的客户端造成的变更」更晚出现 —— 与硬约束冲突。代码回到原值 5000 / 20000 ms，想启用只有一行（§八 第 6 条） |

**镜像体积的层语义**（这一轮把三件事一次性核清，避免再做无用功）：

* 镜像体积 = **各层体积之和**。上层 `rm` 只在那一层写一条白洞记录，**基础层字节照样存在**
  ⇒ 「删基础镜像里已有的东西」既不减下载量也不减落盘量。
* 同一阶段内「先由一层加进来、再由后一层删掉」同理：两层都在镜像里，字节没走。
  只有「**在同一个 RUN 里加完即删**」才真的不产生字节（`/var/cache/apk/*`、`/tmp` 里的脚本都属于此类 ✓）。
* build 阶段「先删、再 `COPY --from=build`」是**真瘦身**：`COPY` 只搬删除后的幸存文件
  （`npm prune --omit=dev`；前端包整块 21 个，其中本轮新增的 13 个孤儿包 + 包内死重合计 31,124,449 B，
  `75 个 .d.ts` 的 199,636 B 另计 —— 8 个前端直接依赖是 1.0.0 那轮删的，不在本轮数字里）。

---

## 八、遗留与建议（按收益排序）

1. ~~首页卡片轮播改用缩略图~~ —— **已实施**（优化项 7，用户确认后在前端 `GameCard` 完成）。
   若日后觉得卡片偏软，可回退的最小单位是 `web/src/components/GameCard.tsx` 里的 `cardFrame()`：
   删掉它、恢复 `[...new Set(list)]` 即可，后端与其余界面完全不受影响。
2. **补上 IGDB / Plugins 的功能缺口**（或从 docs 里撤掉承诺）—— 与性能无关，但属「文档与实际不符」。
3. ~~可选 SQLite 收缩~~ —— **已实施**（优化项 15）：`MAINTENANCE_VACUUM=1` 时启动期 `VACUUM`，默认关闭；
   老装机第一次开启通常回收最多（历史删除都堆在空闲页链表里），之后每次启动再跑的收益接近 0，
   所以建议「需要时开一次，之后删掉这个变量」；手工等价的 one-shot 依然可用（运行镜像里没有 `sqlite3` CLI，
   用镜像自带的 better-sqlite3：`docker compose run --rm --entrypoint node screenplay -e "new (require('/app/node_modules/better-sqlite3'))('/data/screenplay.db').exec('VACUUM')"`，先 `stop` 后 `start`）。
4. ~~可选 Node 参数~~ —— **已实测，判定不加**（四个 `NODE_OPTIONS` 变体的数据见上表最后一行与 `docs/perf/heap-flags.txt`）。
   若日后真的出现 GC 抖动，唯一值得试的是 `--max-old-space-size`（不是 `--max-semi-space-size`：缩小新生代实测更差），
   并且要作为可回退的显式改动记录；当前堆常驻 ~40 MiB，写死上限等于永不生效。
5. 可选前端微优化：`React.memo` 包 `GameCard`、共享单个 IntersectionObserver、搜索请求 `AbortController` ——
   都需要真机测量后再定。
6. **可选：空闲轮询降频（一行改动）** —— `web/src/api/hooks.ts` 两处 `refetchInterval` 的空闲档
   `5000` → `15000`（`useMetadataStatus`）与 `20000` → `30000`（`useDurationCoverage`）。本轮按硬约束**撤回**了它
   （见优化项 8）：只省空闲请求量，不落在内存/磁盘三项指标上，却会让别的客户端造成的变更更晚出现在界面上。
   如果这个部署只有你一个人用、且不在意「后台抓取完的进度晚十几秒才更新」，这一行是安全的。
7. **可选：`PROXIED_CACHE_TTL_DAYS=0`** —— 让 `proxied/` 这份远程图缓存永不清扫（默认 30 天），
   适合「源站随时可能挂、那些远程海报需要永久离线可用」的部署；代价是这块缓存只增不减（见 5.8 第 6 条）。
8. **可选：容器稳定后补采一次 after 侧基线** —— §3.2 里「采集时刻 RSS / cgroup 当前占用」两行被 after 容器的
   启动预热污染（采样时才启动几分钟），要拿到严格可比的空闲态快照，只需等容器跑稳后**再跑一次**
   `bash scripts/perf-baseline.sh --load OUT=docs/perf/after-docker.txt`（不用重建），再跑一次 `perf-compare.sh` 即可。
   峰值与同口径增量两类指标不受影响，交付 1 的结论已经站得住。
9. **可选：查清 `db_bytes` 的口径瑕疵** —— §3.3 末尾那条：③ 段 `ls -l /data/*.db` 汇总出 3.4 MB，与探针
   `stat()` 的 256.2 MiB 不符（同容器同时刻，成因未定；对前后差值零影响）。下次真机采集时加一条
   `docker exec screenplay sh -c 'ls -l /data/*.db; stat -c "%n %s" /data/*.db'` 就能一次定位。

---

## 九、变更文件清单

`git diff --stat`（相对上一版 `bc206a3` = `1.2.0` 发布点）：**101 个文件改动，+21383 / −233**
（36 个 `docs/perf/` 实测留档 + 11 个 `scripts/perf-bench/` 基准脚本 + 9 个新增路径：
`backend/src/common/http/precompressed-static.ts`、`backend/scripts/verify/sqlite-vacuum.mjs`、
`scripts/build/precompress.mjs`、`scripts/perf-baseline.sh`、`scripts/perf-compare.sh`、`scripts/verify-suites.sh`、
`scripts/verify-docker-layers.mjs`），`git status` 里没有任何未预期的文件（`node_modules` / `dist-image` / `.pw` 都不在内）；
按用户要求，**我只做本地提交、不推送**（`git push` 由你自己执行，写法见 `docs/UPLOAD.md`）。
发布动作另含版本号 `1.2.0` → **`1.3.0`**（4 个 `package.json` + `windows/src-tauri/tauri.conf.json` +
README / CHANGELOG / `docs/VERIFY.md` + `scripts/rebuild-and-verify.sh` 与 `windows/scripts/prepare-backend.mjs`
里的期望值 + 两处脚本的 Docker Hub 默认命名空间 `wyunki`）。其中包含 **`.source-hash`**（源码指纹，见下）与 `docs/SLIMMING.md`
（补了 `.pw` 搬家那次漏改 `.dockerignore` 的根因说明）。

其中 `backend/scripts/verify/sqlite-vacuum.mjs`（新增离线套件，见 5.1）与 `.env.example`（补三个可选环境变量的注释说明）
属**测试 / 文档侧，不涉及产品行为**：前者只读地驱动编译产物里的 `DatabaseService`，后者只是把注释写清楚，
已确认全仓没有任何测试断言 `.env.example` 的内容。

本轮的改动分两类。**注释 / 文案**（代码逻辑一字未动）：`Dockerfile` 的 build 阶段与 run 阶段注释
（把非运行期文件的旧统计 18.29 MiB 换成去重实测 9.84 MiB；说明 apk 缓存清理是冗余保险、唯一跨层白洞
是 18,471 B 的 apk-setup.sh COPY；第十轮又重写了运行阶段那段注释，把 alpine 版本依据、ffmpeg 漂移告警
与它带来的 +145,408 B 代价写清）、`scripts/verify-docker-layers.mjs` 的提示文案（同上）、以及本报告里的
全部字节更正。**行为改动三处，都不动产品代码**：① `.dockerignore` 新增 `.pw` 与 `.pw-cache`
（优化项 12：构建上下文 555.0 MiB / 363 个文件 → **2.0 MiB / 216 个文件**，省掉每轮白传的 553.0 MiB
Chromium；只影响构建传输，不进镜像）；② `Dockerfile` 运行阶段基础镜像 `alpine:3.22` → **`alpine:3.24`**
（优化项 16：钉住与构建阶段 `node:22-alpine` 同版，消除 ffmpeg 8.1.2-r0 → 6.1.2-r2 的跨大版本降级；
这一处**会**影响镜像内容，是「换最小基础镜像」的一部分）；③ `scripts/verify-docker-layers.mjs` 固化断言
（第 5 组两条 + 第 9 组一条），分层自查因此从 **30 项变 33 项** —— 反向测试：注释掉 `.pw` → 32/1，
再注释掉 `windows` → 31/2；把运行阶段改回 `3.22` → 32/1，恢复后 33/0。`.dockerignore` 上新增的是
`.pw` / `.pw-cache` 两行排除及其解释性注释（最终 `git diff --numstat -- .dockerignore` ⇒ 19 增 / 2 删，
见 §七），其余是就地替换的注释/文案行。

其中 4 个文件是**离线套件脚本的健壮性改动，不涉及产品代码**：`backend/scripts/verify/poster-rotation-e2e.mjs`、
`backend/scripts/verify/media-reviews-e2e.mjs`、`backend/scripts/verify/duration-cache-e2e.mjs`、
`backend/scripts/verify/password-change.mjs` 各把会写测试库的 `DatabaseSync` 构造加上 `{ timeout: 5000 }`
（busy timeout，见 5.1），断言与期望值一字未改。

**`.source-hash` 必须一起更新**（它是被 git 跟踪的文件，也计入上面那 39 个改动文件）：它存的是
`backend/src` + `web/src` 全部 `.ts/.tsx/.css` 按字节序拼接后的 sha256 前 16 位，供
`scripts/docker-deploy.sh` 判断「镜像是不是比仓库旧」。本轮动过产品源码 ⇒ 值从 `6b491bd5f07e46ea`
变成 **`35019ad7abf95fdd`（137 个文件）**。不更新不会让构建失败（`scripts/expected-source-hash.sh` 只打 `WARN`，
恒退出 0），但部署脚本会一直提示「镜像可能过期」；更新一条命令：`node scripts/gen-source-hash.mjs`
（`--check` 只比较）。

另 3 个脚本是**用户侧执行脚本的预检加固，同样不涉及产品代码**：两个已跟踪文件
`scripts/rebuild-and-verify.sh`、`scripts/package-image.sh`，加上未跟踪的新脚本 `scripts/perf-baseline.sh`
（见第六节末条）。改动只把「本可以提前发现的失败」从构建 / 导出 / 采集中途提到开跑前 —— 其中
`perf-baseline.sh` 是用假 docker CLI 把六节**完整干跑**之后才发现并修掉 4 处的（参数形式被拒、
`VmRSS` 字段取错导致 `set -u` 崩溃且不写 `OUT`、层大小单位解析错、`db_wal_bytes` 重复键），
并补了「退出兜底」保证部分数据也会落盘；`bash -n` 全部通过，两份 compose 的 `config -q` 退出码 0。

**后端（10 改 + 4 个离线套件脚本改 + 1 增）**

| 文件 | 改动 |
| --- | --- |
| `backend/src/games/games.service.ts` | 列表接口单次查询 + 轻投影 + `resolveRating()`/`toSummary()` 复用批量评分 + 出页海报行与媒体计数批量取（`cardPosterRows()`/`mediaCounts()`，`ID_CHUNK = 400`）+ 自定义排序事务化 |
| `backend/src/metadata/rating-target.service.ts` | 新增 `all()`（整表一次读成 Map），`get()` 与它共用 `toTarget()` 行映射 |
| `backend/src/database/database.service.ts` | prepared statement 缓存、`busy_timeout`、`temp_store`、启动 `wal_checkpoint(TRUNCATE)`（包 `try/catch`，失败只 `warn`，见 5.8 第 5 条）、可选启动期 `VACUUM`（`vacuumIfRequested()`，`MAINTENANCE_VACUUM=1` 才走，优化项 15） |
| `backend/src/maintenance/maintenance.service.ts` | `reclaimCaches()` + `sweepFiles()` + 6 小时调度（+240 行）；`proxied/` 清扫可用 `PROXIED_CACHE_TTL_DAYS=0` 关掉（见 5.8 第 6 条） |
| `backend/src/maintenance/maintenance.module.ts` | 引入 `MetadataModule` |
| `backend/src/metadata/metadata.module.ts` | 导出 `MetadataCacheService` |
| `backend/src/main.ts` | 挂载 `precompressedStatic()`、`/assets/` 改 `immutable`（`setHeaders`，优化项 10） |
| `backend/src/common/http/proxy-config.ts` | 连接池 agent 单例复用（并删除死代码 `probeTcp`） |
| 新增 `backend/src/common/http/precompressed-static.ts` | 按 `Accept-Encoding`（含 **q 值**排序、q=0 不选）发 `.br`/`.gz` 的中间件 |
| `backend/src/media/media-types.ts`、`backend/src/metadata/providers/metacritic-aliases.ts` | 删除零引用导出 |

**前端（11 改 1 删）**：`web/src/App.tsx`（路由级 `lazy` + `Suspense`）、`web/src/components/GameCard.tsx`（卡帧改缩略图，优化项 7）、
`web/src/components/MediaGrid.tsx`（`VideoPlayer` 懒加载 + decoding）、
`web/src/components/PosterCarousel.tsx`（`loading="lazy"`）、`web/src/components/HeroPosterCarousel.tsx`（只加 `decoding="async"`）、`web/src/pages/GameDetail.tsx`（图片加载/解码属性）、
`web/src/api/hooks.ts`（**空闲轮询保持原值 5000 / 20000 ms**，只补注释 + 删除死导出）、`web/src/components/ui/Card.tsx`、`web/src/lib/galleryState.ts`、
`web/src/types.ts`（删死代码）、`web/README.md`（文件树）、删除 `web/src/components/PosterImage.tsx`。

**构建/部署/文档（12 改 7 增）**：`Dockerfile`（预压缩步骤、瘦身清单、`node_modules` 非运行期文件删除、
`.d.ts` 删除、运行阶段逐文件 COPY，以及运行阶段**换最小基础镜像** `alpine:3.24` + `COPY` 一个 node 二进制 +
`libstdc++` + 构建期 `node -v` 自检）、`.dockerignore`（排除 `windows` / `android` / `dist-image` /
`**/dist-desktop` / `.pw` / `.pw-cache`：上下文 555.0 MiB → 2.0 MiB，见优化项 12）、
`docker-compose.yml`、`docker-compose.deploy.yml`、`scripts/rebuild-and-verify.sh`（启动期日志断言改用真实措辞 +
预检）、`scripts/package-image.sh`（输出目录可写预检 + 脏工作区 `-dirty` 包名）、`scripts/docker-build.sh`
（`RUN_BASE_IMAGE` 从 Dockerfile 派生并打印，避免两处漂移）、`README.md` 与 `docs/UPLOAD.md`（基础镜像描述同步）、
`docs/VERIFY.md`（离线回归命令清单同步）、
`.source-hash`（源码指纹，见上）、
`.env.example`（把 `HOUSEKEEPING_INTERVAL_MS` / `PROXIED_CACHE_TTL_DAYS` / `MAINTENANCE_VACUUM` 注释清楚）、新增
`scripts/build/precompress.mjs`、
新增 `scripts/perf-baseline.sh`、
新增 `scripts/perf-compare.sh`（before/after 对比表）、新增 `scripts/verify-suites.sh`（离线全量回归一键跑，见第五节）、
新增 `scripts/verify-docker-layers.mjs`（Dockerfile 分层自查，纯静态、不需要 docker，**33 项断言 / 9 组**，见 5.1）、
新增 `scripts/perf-bench/`（9 个基准/长跑/回收/查询计划脚本，产物 `docs/perf/list-path-bench.txt`、`docs/perf/leak-soak.txt`、
`docs/perf/maintenance-reclaim.txt`、`docs/perf/query-plans.txt`）、新增 `docs/perf/`（基线数据、`docs/perf/RUN-ON-HOST.md`
宿主机操作卡与本报告）。

## 十、Windows / 桌面包的注意点

`web/dist-desktop` 已随本轮源码改动重新构建通过（根部 `npm run build:web:desktop`，entry 315,927 B + 按需分块，无编译错误），
但仓库里已提交的 `windows/src-tauri/resources/web/` 仍是上一版快照（`index.html` 里引用的是旧的 `index--Fts6Fx4.js`）。
Windows 打包流程本来就会重新生成这一份：`windows/scripts/prepare-frontend.mjs` 会自己跑
`npm --prefix web run build:desktop`、再整目录复制到 `resources/web`（它按目录枚举所有 `.js`/`.css`，
对分块产物天然兼容，本轮不需要改它）。所以**打 Windows 包时照旧先跑一次 `prepare-frontend.mjs` 即可**，
不需要额外步骤；桌面端的 `verify-desktop.mjs` 应在重新生成后再跑。