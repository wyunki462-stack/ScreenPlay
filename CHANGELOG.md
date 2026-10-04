# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。在 `1.0.0` 之前，版号中的
次版本号对应**功能迭代轮次**，同时以 `-beta.N` 标注测试阶段；自 `1.0.0` 起进入正式版：
功能号递增代表新增能力，修补号代表兼容的缺陷修复。

---

## [1.3.1+2] — 2026-10-04（安卓端：连 Linux 后端的五项体验修复）

**只动安卓端 Flutter 客户端（`flutter/`），后端、Web、Linux 镜像、Windows 桌面端一行未改**
（`node scripts/gen-source-hash.mjs --check` 仍是 `a0e18c54d5340a97`，137 个文件；`/api/health` 在
Linux 端仍是 `1.3.0`）。安卓端 `versionName` 保持 `1.3.1`（三端版号一致），只把 build number 升到
`1.3.1+2`（`versionCode` 2 / 分包后 2002），便于区分安装包。变更点全量说明见
[`flutter/docs/ANDROID-1.3.1.md`](flutter/docs/ANDROID-1.3.1.md) §9。

### 修复（用户报障 5 项，均在真实 Linux 后端上复现取证后修复）

1. **连 Linux 后端后大部分海报不显示**：两个根因 —— (a) `/api/media/*`、`/api/media/proxy`、
   `/api/posters/*` 等图片端点都要求凭证，而 `CachedNetworkImage` 走 dart:io、**不经过 Dio 拦截器**
   ⇒ 一律 401（实测同图带凭证 `200 image/jpeg 52,927 B`、不带凭证 `401`；Windows 端 `AUTH_DISABLED=1`
   才不暴露）；(b) 列表里的 `posters[]` 没被 App 读，卡片退化成海报接口的**远端 CDN 直链**，手机在大陆
   网络下基本取不到。修法：新增 `imageHeaders`（Bearer + Cookie）与 `imageSource()`（远端图统一走
   后端 `/api/media/proxy`）、`cardImageSource()`（`/preview` → `/thumbnail`，与 Web `cardFrame()` 逐字一致）、
   `cardPosterSources()`（封面 + `game.posters` 去重，与 Web `cardPosters()` 同源同序）；新增
   `AuthedImage` 并替换 App 内 **7 处** `CachedNetworkImage`（卡片 / 视频封面 / 相册封面 / 大图查看器 /
   详情头部海报 / 媒体 PageView / 成就图标）；首页卡片海报改为列表直传。
2. **点任意卡片都「加载详情失败」**：详情内嵌 `achievements[]` 是 **snake_case**，而 `Achievement.fromJson`
   只读 `json['gameId'] as String` ⇒ `type 'Null' is not a subtype of type 'String'`，且 `_parseList` 当时
   没有逐项容错 ⇒ 一行坏数据打挂整个 `GameDetail`（39 个游戏里 34 个点开必失败；Web 不读这个数组、
   Windows 测试库没有成就数据，所以只有安卓端暴露）。修法：成就字段同时接受 camelCase ∪ snake_case、
   `_parseList` 逐项 try/catch、`GameSummary` / `Poster` 去掉 `as String` 硬转。**后端 DTO 未改**。
3. **只有卡片下方文字能进详情**：多海报轮播层上的手势吸收层把点击吃掉了（`onTap: () {}`），改为转交
   卡片的 `onTap`。**只注册 onTap 不注册长按**，以免与自定义排序的 `LongPressDraggable` 抢手势。
4. **应用图标与左上角图标未统一**：新增零依赖生成器 `scripts/brand-icons.mjs`（断言 `web/public/favicon.svg`
   的品牌常量并把 SVG 路径转成 Dart `Path` / 安卓 VectorDrawable），产出安卓自适应图标的前景（品牌 Gamepad2
   字形，替换旧的紫色三角）、背景（品牌对角渐变 #7c3aed→#06b6d4）、单色层与 `mipmap-anydpi-v26/ic_launcher.xml`；
   App 内新增 `BrandMark`（与 Web 页眉同一套比例 20/36），用于首页 AppBar leading 与连接页 / 登录页头图。
5. **首页新增下拉刷新（与后端全量同步）**：网格套 `RefreshIndicator` +
   `AlwaysScrollableScrollPhysics`；触发时 `POST /api/library/scan`（与 Web「重新扫描」同一端点，后端是
   后台任务、实测 24–26 ms 返回）→ 重取游戏列表与统计 → 清掉本地自定义顺序覆盖，失败弹「同步失败」。

### 验证

- `cd flutter && flutter analyze`：**0 error / 0 warning**（7 条 `deprecated_member_use` info 为既有写法）。
- `cd flutter && flutter test`：**43 项通过 / 1 项跳过**（新增 `models_parse_test.dart` 13 例、
  `api_client_urls_test.dart` 16 例、`brand_mark_test.dart` 10 例、`game_card_tap_test.dart` 4 例
  —— 最后一组直接点海报区与信息行验证「整卡可点」、并断言海报区吸收层不注册长按、横向滑动不进详情；
  跳过的是真后端用例的占位）。
- 连真实 Linux 后端（Docker 复现环境，39 游戏 / 1917 媒体）的端到端用例 `flutter/test/live_backend_test.dart`：
  **7/7 通过**（`--dart-define=SP_LIVE_BASE=http://127.0.0.1:3007`）—— 列表 39 个游戏全部可解析且海报来源
  全部指向本服务端（合计 41 张 / 无海报 0 个）；**逐个游戏详情 39/39 解析成功**（其中 34 个带成就）；
  抽检 10 张封面带凭证 `200 image/jpeg|webp`、**不带凭证 401**；远端 CDN 海报经代理 `200 image/jpeg`；
  成就图标抽样鉴权失败 0；`POST /api/library/scan` 24–26 ms 返回。
- `node scripts/brand-icons.mjs --check`：✓ 产物与 `web/public/favicon.svg` 一致。
- 整仓离线全量回归 `bash scripts/verify-suites.sh`：**18 项通过 / 0 项失败 / 508 条断言**（235 s；后端与
  Web 一行未改，与 1.3.1 首发同一批套件）。
- 安卓包：`app-arm64-v8a-release.apk` 21,243,136 B / `app-armeabi-v7a-release.apk` 18,800,086 B /
  `app-x86_64-release.apk` 22,427,527 B；`aapt2 dump badging` ⇒ `versionCode 2002` / `versionName 1.3.1` /
  `minSdk 28` / `targetSdk 34`，权限集合与首发包逐条相同；`apksigner verify` ⇒ `Verifies`（v2 方案，
  debug keystore 同上版）。真机交互验收（整卡点击手感、下拉刷新手势、launcher 图标观感、大陆网络下海报加载）
  仍待用户设备执行。

### 顺带记录（不在本轮范围、未改后端）

- **服务端成就图标数据缺陷**：`GET /api/games/:id` 内嵌 `achievements[].icon_url` 有 **1409/1738（81%）**
  是「域名+路径后又拼一个完整 URL」的双重地址（尾巴指向已下线的 `steamcdn-a.akamaihd.net`），怎么取都 502；
  正确形式实测可用（`https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/<appid>/<hash>.jpg`
  → `200 image/jpeg 18,633 B`）。`media[].coverUrl`（0/335 坏）与 `/posters` 的 `url`（0/536 坏）都正常，
  缺陷只集中在成就图标，**Web 端同样显示裂图**，App 退回奖杯占位图标、不劣于 Web。建议后续在后端爬虫侧加
  绝对 URL 守卫 + 一次性迁移归一化。
- 合并清单里的 `READ_EXTERNAL_STORAGE`（`maxSdkVersion=28`）由插件清单合并带入，为**首发包既有**项，
  非本轮新增（此前文档只记了主清单的 3 项权限，已在 `flutter/docs/ANDROID-1.3.1.md` 按实测补齐）。

---

## [1.3.1] — 2026-10-04（安卓端 Flutter 客户端首发）

**本轮新增安卓端首个客户端（`flutter/`，版号 `1.3.1`）**，并为此在后端做了**两个纯加法改动**：
新增 `DELETE /api/media/:id`、认证接口的会话三端点补上 `Authorization: Bearer` 识别。
**Linux 服务端 / Docker 镜像 / Windows 桌面端的服务版号一律不变**（`/api/health` 在 Linux 端仍是
`1.3.0`，根 `package.json` 与 `windows/**` 一字未动），Windows 安装包本版**不重发**。
HTTP 接口只增不改、DTO 与状态码未动、数据库结构零改动（无新表新列）。

### 新增

- **安卓端客户端（Flutter 3.24.5，minSdk 28 / targetSdk 34，20 个 Dart 文件 / 6118 行）**：
  - 连接：填 `IP:端口` 后探测 `GET /api/auth/session` —— `enabled=false`（Windows 桌面端内置后端
    `AUTH_DISABLED=1`）直接进首页；`enabled=true`（Linux 端）转登录页，复用既有登录接口与会话校验。
    令牌同时以 `Authorization: Bearer` 与 `Cookie: screenplay_session` 携带。
  - 图库：默认一行 2 个卡片（宽 ≥600 三列、≥900 四列），搜索/筛选/排序（新增「自定义排序」）；
    卡片海报**左右滑动**切换，**长按卡片拖拽**调整自定义顺序并即时 `PUT /api/games/order`（乐观 + 失败回滚）。
  - 相册：图片/视频**长按删除**（确认弹窗）；「删除同步到服务端」默认开启 ⇒ 调 `DELETE /api/media/:id`
    删除服务端文件与索引；关闭 ⇒ 只清本机缓存并从列表本地隐藏，不发网络请求。
  - 大图（捏合缩放 + 预览图/原图切换）、视频全屏播放（`/stream`）、**系统分享面板**、**保存到系统相册**；
    **客户端不含任何上传路径**。
  - 清晰度：设置页「WiFi 下自动加载原图」（默认开）⇒ WiFi/以太网取原图、移动数据取低分辨率预览图；
    关闭后一律原图。内存 + 磁盘三级缓存；退后台取消非必要请求、快速滚动不预取离屏项。
  - 权限只加 `ACCESS_NETWORK_STATE` 与 `WRITE_EXTERNAL_STORAGE(maxSdkVersion=28)`，不申请定位/相机/传感器/读取相册。
- **后端**：`DELETE /api/media/:id`（删磁盘文件 + 删 DB 行 + 清缩略图/预览缓存，附带清理
  `game_posters.media_id` 悬挂引用与 `games.poster_url` 回退；原图删除带媒体库根路径校验），
  返回 `{ok,id,deleted,removedFiles,postersRemoved,originalSkipped}`；认证三端点同识别 Cookie 与 Bearer。

### 验证

- `cd flutter && flutter analyze`：**0 error / 0 warning**（7 条 info 为 riverpod 2.6.1 弃用提示）。
- `node backend/scripts/verify/media-delete-e2e.mjs`：**22 项通过 / 0 失败**（含无凭证 401 / 带 Cookie 200 /
  磁盘与 DB 行消失 / 二次删除 404 / 悬挂海报清理 / `AUTH_DISABLED=1` 免凭证 200）。
- `node backend/scripts/verify/android-auth-bearer.mjs`：**19 项通过 / 0 失败**（Bearer-only 的
  `session` / `logout` / `password`，Cookie 路径回归）。
- `npm --prefix backend run build`、`npx tsc --noEmit`：EXIT 0。
- 整仓离线全量回归 `bash scripts/verify-suites.sh`（已把上面两个新套件加进套件清单，16 项 → 18 项）：
  **18 项通过 / 0 项失败 / 508 条断言 / 211 s**。
- 安卓包：`cd flutter && flutter build apk --release --split-per-abi` 成功，产出三个 ABI 分包：
  `app-arm64-v8a-release.apk` 21,240,968 B / `app-armeabi-v7a-release.apk` 18,797,918 B /
  `app-x86_64-release.apk` 22,359,823 B（`release` 用 debug keystore 签名，可侧载、不适用于上架）。
  `aapt2 dump badging` 复核：`package com.screenplay.app`、`versionName 1.3.1`、`minSdk 28`、
  `targetSdk 34`、权限只有 `INTERNET` + `ACCESS_NETWORK_STATE` + `WRITE_EXTERNAL_STORAGE(maxSdk 28)`；
  `apksigner verify --verbose` ⇒ `Verifies`（v2 方案）。真机交互验收（拖拽手感、分享面板、存相册、
  移动数据取预览图）待用户设备执行。

### 有意保留

- 未开启 R8 / `minifyEnabled` / `shrinkResources`：无正式 keystore、无真机回归混淆后的插件反射，
  体积靠 `--split-per-abi` 与精简依赖控制。
- 安卓端 `gradle.properties` / `gradle-wrapper.properties` 的国内镜像与内存参数：交付前已还原为仓库原值。
- 变更点全量说明见 [`flutter/docs/ANDROID-1.3.1.md`](flutter/docs/ANDROID-1.3.1.md)。

---

## [1.3.1] — 2026-10-03

**仅 Windows 端修复，Linux 版本无变更。** 桌面端版号 `1.3.0` → `1.3.1`，Linux 服务端、Docker 镜像、
构建脚本与后端代码**一行未动**（`/api/health` 在 Linux 端仍是 `1.3.0`，`backend` / `web` 的版号也保持
`1.3.0`）。桌面端自本版起有**独立版号线**（`windows/package.json` + `Cargo.toml` + `tauri.conf.json`
三处同步，见 [`README.md`](README.md)「桌面端版号线」），这样「只修 Windows 端」的小版本不会牵动
Linux 端版号。HTTP 接口、数据库结构、DTO 与三端功能一致性均未变；三处修复都在共享前端源码里
（Web / Linux 重新构建时会一并带上），但**本版不重发** Linux 镜像。

### 修复

1. **图库「自定义排序」拖不动（Windows 桌面端）**：根因是 Tauri v2 窗口默认开启「内部拖放接管」
   （`dragDropEnabled` 默认 `true`，外壳会替换 WebView2 的 drop handler），页面里的标准 HTML5 拖放
   事件收不到 ⇒ 浏览器里正常、只有桌面端拖不动。`windows/src-tauri/tauri.conf.json` 显式关闭接管后
   拖拽恢复；同时 `web/src/pages/Home.tsx` 在 `PUT /games/order` 发出后把新顺序**直接写进**
   `["games", filters]` 缓存（否则请求 settle 时会清掉乐观顺序、在列表刷新落地前闪回旧顺序，
   看起来像「拖了没生效」），并在落库失败时给出提示条；拖拽占位符与插入指示线保持原样。
   细节与源码锚点见 [`windows/docs/PARITY.md`](windows/docs/PARITY.md) §3 ⑧。
2. **游戏详情页加载过慢**：详情页不再**整页**等 `GET /api/games/:id` —— 先用图库列表缓存立刻画出封面与
   基础信息（标题区显示「元数据补全中…」），只有详情才有的区块（时间线 / 评分 / 媒体评价 / 成就）
   各自在数据到位前显示骨架屏，相册 tab 只依赖它自己的查询、可先行渲染；
   `GET /api/games/:id/neighbors` 延后到浏览器空闲时（`requestIdleCallback`，带超时兜底）再发；
   相册卡片改用仓库自带的 `LazyImage` 按需加载、大图查看器按需挂载；详情相关查询缓存延长
   （`staleTime` 5 分钟 / `gcTime` 30 分钟），缩略图与封面继续吃后端已有的
   `Cache-Control: public, max-age=2592000, immutable` ⇒ 二次进入同一详情页不再重复发起请求。
3. **空相册文件夹点进去也长时间等待**：空文件夹在这套代码里就是一张 `mediaCount = 0` 的游戏卡
   （扫描到 0 个文件也建行），慢的真正原因是详情页首访要等一轮外网元数据刮削（后端行为，本版不改）。
   前端改为：`mediaCount = 0` 时相册区**零请求**直接渲染空态「暂无图片」，不再等任何加载；
   新增 i18n 键 `media.emptyFolder`（中英同步），并给卡片加了「空」标记。

### 有意保留（后端 / Linux 侧，本版禁止改动）

- `GET /api/games/:id` 首次访问仍会在请求线程里 `await` 整轮元数据刮削
  （`backend/src/games/games.service.ts:482-494` 的 `last_meta_refresh == null` 分支）；
  前端只能做到「不等它也能先把页面画出来」。
- `/api/media/:id/preview` 没有 `Cache-Control` ⇒ 大图查看器每次重下；可缓存的缩略图/封面不受影响。

### 产物

- Windows：`ScreenPlay_1.3.1_x64-portable.zip`（免安装，解压即用）与 `ScreenPlay.exe`
  （PE 文件版本 / 产品版本均为 `1.3.1`）；需要安装包时在 Windows 上跑 `windows\build-windows.ps1`。
- Linux：**无新版产物**，`1.3.0` 镜像照旧（`wyunki/screenplay:1.3.0` 与 `latest`）。

## [1.3.0] — 2026-10-03

**Linux 端全量性能优化**：功能、交互、数据结构、HTTP 接口**一律未变**（同一套前端源码、同一套 DTO
与状态码、同一份数据库 schema），改的只有运行内存、镜像/磁盘占用、依赖与缓存策略。
逐项明细见 [`docs/perf/PERF-REPORT.md`](docs/perf/PERF-REPORT.md)，真机前后对照见
[`docs/perf/compare.md`](docs/perf/compare.md)，自己复核的步骤见
[`docs/perf/RUN-ON-HOST.md`](docs/perf/RUN-ON-HOST.md)。

### 实测结果（真机容器对照：`1.2.0` → `1.3.0`）

- **镜像**：解压后 386.8 → 322.1 MiB（**−16.7%**），层数 13 → 12。运行阶段不再带 npm/corepack/yarn
  与旧 alpine rootfs；基础镜像与构建阶段对齐到 `alpine:3.24`（同一套 apk 仓库，`ffmpeg 8.1.2-r0`，
  换基线的**包级等价性**已逐包核对，见报告 §3.1.2）。
- **内存**：同样 60 次列表请求造成的内存增量 VmRSS **−65.7%**、cgroup **−58.8%**；`GET /api/games?limit=60`
  的 SQL 从 **651 条降到 4 条**（−99.4%），响应字节完全不变（60 张卡片 / 34,100 B）。压测 3000 次请求
  后 RSS 到平台、无句柄/连接泄漏。
- **磁盘**：`/data` 总量 −2.4%；启动期 `wal_checkpoint(TRUNCATE)` 让空闲态 WAL 4.1 MiB → 157 KiB（−96.2%）；
  启动维护清理过期缓存与衍生文件（本次 100 条缓存行 + 78 个陈旧文件），**上传的海报一张未动**。
- **接口**：12 条热接口耗时均不高于优化前（`/api/games?limit=60` 13.9 → 9.6 ms，`/api/health` 4.1 → 1.7 ms）。
- **静态资源**：前端产物预压缩（brotli/gzip）按 `Accept-Encoding`（含 q 值）协商下发，`Vary` 与 CORS
  正确合并，仍带 `immutable`；首屏原始 354,585 B → br 89,431 B / gzip 103,800 B。
- **日志**：两份 compose 补 `logging` 上限（`json-file`，3 × 10 MiB/容器），此前不轮转。
- **依赖**：`npm audit` 无新增漏洞，未新增/未升级任何依赖；桌面端与后端行为不变。

### 考虑过但没做（理由见报告 §七）

- Node 堆参数：实测四个变体（`--max-old-space-size=256`、`--max-semi-space-size=8/32`）都不优于默认，不加。
- 缩略图进一步压缩：已成 WebP q80 再无损重编码反而 **+308%**；降质量属有损，不做。
- Docker 层合并的进一步动作、`PRAGMA optimize`/`synchronous=NORMAL`/`auto_vacuum`：已到收益边界或
  有风险，保持现状。

## [1.2.0] — 2026-10-02

新增 **Windows 桌面端**（Tauri v2 壳 + 内置后端的完整源码与构建方案）、**三端左上角品牌图标统一**、
设置页改密（桌面端按平台剔除），并修掉「首页卡片开启轮播后上一张/下一张点不动」。
后端接口与 `web/src` 源码不分叉；本轮**没有新增后端 feature 标记**，所以「跑的是不是这一版」只看
`version`（`/api/health`）。另修掉一处**构建期**缺陷：构建机没有外网出口时镜像构建会失败，见
[构建与镜像](#构建与镜像)。
 
### Windows 桌面端（`windows/`）

- 新增 `windows/`：Tauri v2 壳 + **内置后端**的 Windows 桌面端源码与构建方案。启动时壳在本地
  随机端口拉起随包发布的 NestJS 后端（`backend/dist`、`node.exe`、Windows 版 `better-sqlite3`/`sharp`
  预编译产物、`ffmpeg.exe`/`ffprobe.exe`），健康检查通过后主窗口指向 `http://127.0.0.1:<port>`，
  因此**前端零改动、接口与数据行为与 Web 端一致**；四种入口（登录/`AUTH_DISABLED`）与时区、
  语言、设置项全部沿用后端既有实现。
- 数据默认落 `%APPDATA%\ScreenPlay`（`config.json` 可改），程序目录只读，可整体拷贝免安装运行；
  离线可用（库扫描、缩略图/海报生成、Range 流、本地账户、设置），仅刮削/成就/远程图片代理需要外网。
- 精简：不打包开发依赖与 Web 端专属运行时依赖，图标本地化（不再请求 `cdn.plyr.io`），
  去掉 viewport meta 与一条移动端媒体查询（Tailwind 的 `min-width` 断点保留，桌面布局不变）。
- 交付：`windows/build-windows.ps1`（PowerShell 7 与 Windows PowerShell 5.1 均可用）、
  `windows/scripts/*.mjs`（资源组装、图标生成、打包、自检）、
  `windows/docs/{BUILD-WINDOWS,ARTIFACTS,PARITY}.md`。
  产物：NSIS 安装包 + 免安装 zip；**仓库不含构建出的二进制**（exe/zip 都在 `windows/dist/` 且已 gitignore）。
  原生壳 exe 在 Windows 上构建，**也可以用 `windows/scripts/cross/cross-build.sh` 在 Linux 上交叉编译**
  （zig 冒充 cc/ar/rc + 4 个垫片；实测 exe 7.04 MiB、便携 zip 108.98 MiB）；NSIS 安装包只能在 Windows 上出。
  另提供**零工具链备用包** `ScreenPlay_<ver>_x64-webapp.zip`（`npm run bundle:webapp`）：
  不需要 Rust/编译，解压双击 `ScreenPlay.cmd` 就用同一份 `resources/`（内置后端 + Edge `--app` 窗口），
  用于目标机器上装不了构建工具链时的兜底。

### 品牌图标统一（Web / Linux / Windows 桌面端）

- 三处左上角图标统一为同一枚品牌 mark：**紫青对角渐变圆角方块 + 白色手柄**
  （`#7c3aed → #06b6d4`，圆角 8/36，lucide `Gamepad2` 按 20/36 缩放、描边 2），
  与首页顶栏左上角品牌块同源。矢量真源是 `web/public/favicon.svg`（Web 端标签页
  `<link rel="icon">` 与 Windows 启动画面 `windows/src-tauri/splash/index.html` 的内联 SVG
  逐字镜像同一段几何）。
- Windows 侧 4 个栅格图标（`windows/src-tauri/icons/{32x32.png,128x128.png,icon.png,icon.ico}`）
  由 `windows/scripts/gen-icons.mjs` 按同一几何重新绘制（零依赖、自带 PNG/ICO 编码器与自检）；
  新增 `windows/scripts/verify-icons.mjs` 做像素级校验（渐变方向、圆角透明、白色字形、无旧版深色底）
  并接入 `windows/scripts/verify-desktop.mjs`；三端几何由 `gen-icons.mjs` 的 `assertBrandSvg()` 逐字断言防漂移。
- exe/安装包内嵌的图标要在 Windows 上（或交叉编译）重新打包后才生效。

### 修改密码（设置页）

- 设置页新增「修改密码」卡片：填**原密码 + 新密码 + 确认新密码**，前端先本地校验（原密码非空、
  新密码至少 4 位、两次输入一致），再由后端核准。改完**立即生效**，重启或重建容器后仍是新密码 ——
  不必再从容器启动日志里翻初始密码（`AUTH_DISABLED=1` 只是应急免登录开关，不能替代改密）。
- `POST /api/auth/password` 从骨架补成可用：本地（scrypt）账户校验原密码后写入新哈希，
  成功后**注销该账户的其它会话**（被盗 cookie 立刻失效），只保留发起改密的当前会话。
- 失败**不再用 401 表达**，一律 2xx + `{ok:false, code, error}`：`unauthenticated` / `not_local` /
  `wrong_current` / `blank` / `too_short` / `too_long` / `same`。因为 Web 端把任何 401 当
  「会话已失效」并跳回登录页 —— 修复前输错一次原密码就会被登出，这正是要改掉的行为。
  新密码 4~128 位、不能与原密码相同；NAS 系统账户明确提示「请在 NAS 上修改」而不是报 401。
- Web 端按 `code` 取本地化文案（中文/英文各 21 个 `settings.password.*` 键），
  未知 `code` 才回落后端 message，英文页面不会蹦中文。
- **Windows 桌面端不提供「修改密码」入口**（唯一的按平台界面裁剪）：桌面产物由 `web/dist-desktop`
  （`npm run build:web:desktop`）生成，构建期把改密卡片模块换成空实现
  （`web/.env.desktop` 的 `VITE_SCREENPLAY_TARGET=desktop` → `web/vite.config.ts` 的 `resolve.alias` →
  `ChangePasswordCard.desktop-stub.tsx`），所以桌面安装包里**既没有入口也没有相应文案与前端代码**；
  Web/Linux 端照旧保留。后端接口与 `web/src` 源码不分叉，详情见 `windows/docs/PARITY.md` 差异 ⑦。

### 轮播职责拆分：首页卡片 vs 详情页大图

- 两套轮播彻底解耦。此前它们共用一套「勾选 + 展现模式」配置、互相干扰：
  - **首页卡片封面轮播** —— 由「编辑海报」里的「轮播」勾选与展现模式（现更名**首页卡片轮播**）
    共同决定：勾选哪几张，卡片就轮播哪几张（当前封面始终在内）；没有勾选时卡片就是一张静态封面、
    不显示上一张/下一张；相册截图依旧默认不勾选。
  - **详情页官方海报大图轮播** —— 默认自动轮播**全部官方海报**（官方刮削 + 用户上传，
    **不含**相册截图），左右箭头与 `x/y` 计数常驻、可循环、3.5 秒一张；不再有配置入口，
    也不受「编辑海报」里的开关影响。
- 后端：卡片集合判据改为「用户勾选 ∪ 当前封面」（`in_slideshow = 1 OR is_selected = 1`）；
  `game.posters` 字段名与响应结构不变，方法 `slideshowPosters()` → `cardPosters()`；
  新登记的官方海报**不再默认进入轮播**（`in_slideshow` 默认 0）；启动期把历史上「程序替用户决定」的
  行统一摘出（只动 `slideshow_user_set = 0` 的行，用户亲手勾选/取消的一律保留，幂等并记条数日志）；
  不再强制把封面写进轮播集合（封面已是集合的结构性一员）。
- 前端：详情页大图组件去掉 `mode`/`data-mode`，只看张数（`count > 1` 即自动轮播）；
  「编辑海报」面板与卡片注释、中英文案改口为「首页卡片轮播」。
- 修复：**开启卡片轮播后，首页卡片的上一张/下一张点不动** —— 箭头位于整张卡片的详情页链接内，
  点击冒泡后被外层 `<Link>` 吞掉，表现为「点一下就跳进详情页」。现在箭头与圆点的点击先
  `preventDefault()` + `stopPropagation()` 再翻页（`web/src/components/PosterCarousel.tsx` 的
  `onControlClick`），并补了离线断言：点箭头后计数前进且路径不变，点卡片其它区域仍正常跳详情页。
- 功能标记（`/api/health` 的 `features`）随语义更新；`docs/API.md`、`docs/VERIFY.md`、`README.md` 同步。

### 构建与镜像

- 修掉「构建机没有外网出口时镜像构建失败」：`better-sqlite3` 的预编译包**不在 npm registry 上**，
  它随 GitHub Releases 发布（由 `prebuild-install` 下载）；取不到时 npm 会退化成 node-gyp 源码
  编译，再去 `unofficial-builds.nodejs.org` 下 Node 头文件 —— 构建容器的这两处都没有出口，于是
  `npm install` 连环超时（`ETIMEDOUT` / `ECONNRESET`），报错停在与真正原因无关的位置。
  现在构建期把 `prebuild-install` 指向 npmmirror 的原生包镜像：`Dockerfile` 的
  `ARG NPM_BINARY_MIRROR` → `ENV npm_config_better_sqlite3_binary_host_mirror`（**只针对
  `better-sqlite3`**；不全局设 `npm_config_build_from_source`，那会把 `sharp` 一起拖进源码编译），
  `scripts/docker-build.sh` 默认传
  `NPM_BINARY_MIRROR=https://registry.npmmirror.com/-/binary/better-sqlite3`（显式传空 = 回退上游
  默认）。musl 目标（Alpine）会正确取到 `…-linuxmusl-x64.tar.gz`，零编译、不碰头文件下载。
- `scripts/build/npm-run.sh` 补 `npm_config_proxy` / `npm_config_https_proxy`：此前只导出
  `http_proxy` / `https_proxy`，而 `prebuild-install` 与 `node-gyp` 只认 npm 配置里的代理
  （`npm_config_*`，见 `node-gyp/lib/download.js`），所以明明注入了代理，这两个原生安装步骤
  实际仍在直连 —— 这正是上面那条失败链路的另一半原因。

---

## [1.0.0] — 2026-10-02

**首个正式版。** 接口（`/api/*`）与数据表结构自本版起进入稳定状态，此后只按语义化版本递增。
内容上是**瘦身 + 去重 + 一处修复**，没有新增功能：清掉仓库与镜像里已经用不到的东西（依赖、
构建配置、文件与目录结构），按用户要求合并 6 组重复实现，并修掉「用户自选海报被元数据覆盖」。
分两轮做：第一轮只动依赖、构建配置、文件与目录结构，**源码零行为改动**（前端产物
`index-DZEuyZR6.js` 与 0.6.4 哈希完全一致）；第二轮合并去重并修缺陷，因此前端产物变为
`index-Ca5ByDzf.js`。**界面与接口自始至终没有变化**：唯一的数据行为变化就是那处缺陷修复本身。
逐项清单、体积对比与验收证据见 [`docs/SLIMMING.md`](docs/SLIMMING.md)。

### 依赖

- 根 `package.json`：`playwright-core`（原本被误标成运行时依赖）删掉，改为 `devDependencies`
  里的 `playwright`；`backend/package.json`：删掉 `@nestjs/serve-static`（静态资源走的是
  `backend/src/main.ts:58 app.useStaticAssets(webDist)`，这个包从未被 import）；
  `web/package.json`：删掉本不该出现在工作区里的 `playwright`。
- 保留但已核实用途的依赖：`plyr`（`web/src/components/VideoPlayer.tsx:4` 引 `plyr/dist/plyr.css`）、
  `prop-types`（`plyr-react` 的 esm 入口引用）、`reflect-metadata` / `rxjs`
  （`@nestjs/core` 的 peerDependency）。

### 构建与镜像

- `backend/tsconfig.build.json`：`sourceMap: false`、`incremental: false` —— 镜像里不再带 73 个
  `.map` 与 `tsconfig.build.tsbuildinfo`（构建产物断言只检查 `*.js`，运行时报错靠行号也读不到映射）。
- `Dockerfile` 的 `run` 阶段不再整棵树照搬 `node_modules`，改为 `npm prune --omit=dev` 之后再删掉
  只有前端运行时才需要的包（`react*`、`@tanstack`、`lucide-react`、`plyr*`、`react-photo-view`）；
  `backend/dist` 的产物里没有任何 `require()` 指向它们。
- 同一步里加了**原生依赖自检**：`better-sqlite3` 若缺编译产物就 `npm rebuild`，随后用 `node -e`
  真开一个内存库写入读回，并 `require('sharp')`，任一步失败都让构建失败 —— 避免出现「镜像能构建、
  一启动却打不开数据库」这类只在运行时才暴露的问题。
- **发布后实测**：`1.0.0` 与 `latest` 在 GHCR 与 Docker Hub 同为 digest
  `sha256:f4a18a209b36cae89a24fa6e3f27965195863afd0bb264fd15fab51ac8ef26e3`，13 层合计
  **421,100,544 B = 401.6 MiB**（`0.6.4` 为 599,668,224 B = 571.9 MiB，**−29.8%**），镜像内
  `BUILD_VERSION=1.0.0`；降幅全部落在 `node_modules` 层（282.2 → 112.6 MiB）。

### 文件

- 删除 37 个只服务于一次性轮次验证的文件（`scripts/verify-round-{d,e,f,g,k,l}.sh`、
  `scripts/verify-all-games.mjs`、`scripts/verify-media-reviews-ui.mjs`、
  `scripts/verify-poster-config.mjs`、`backend/scripts/verify/round-*-backend.mjs` 等）与整套
  `backend/scripts/achievements/` 工具包；它们原本断言的覆盖已由保留下来的离线套件承担，
  对照关系写在 `docs/VERIFY.md` 顶部。
- 归位而非删除：`sqlite-shim.js`（本机没有编译产物时给 `node:sqlite` 用的兼容垫片）移到
  `backend/scripts/verify/`；Playwright 浏览器从 `.tmp-b/pw` 移到 `.pw/`（`.gitignore` 已忽略），
  4 处引用路径同步更新。
- `docs/UPLOAD-0.6.4.md` → `docs/UPLOAD.md`（去掉版号，命令按 `package.json` 现版本自动取值）；
  `docs/VERIFY.md` 的跑法改写成「离线套件」与「已部署实例自检」两段。

### 代码（去重，6 组）

保留行为不变，只让每种实现各留一份：

- **metacritic 关键词变体**：`backend/src/metadata/providers/metacritic-aliases.ts` 新增
  `titleQueryCandidates()`（「别名 → 拉丁片段 → 原文」的顺序只写一次），`titleQueryVariants()` 与
  `metacritic.provider.ts` 的 `searchVariants()` 都改为消费它 —— 过去这两个文件各写了一遍
  「三步策略 + 长度阈值」。
- **平台回退**：后端新增 `backend/src/common/game-row.ts`（`parseStringArray()` / `platformsOfRow()`），
  删掉 `games.service.ts` 的私有 `platformsOf` + `displayPlatforms` + 本地 `parseArray`，
  以及 `trophies.service.ts` 里同名的本地 `platformsOf`；前端新增 `web/src/lib/platforms.ts`
  （`platformTags()`），`GameCard.tsx` 与 `GameDetail.tsx` 删掉各自的逐字相同副本。
- **评分色调**：`RatingPickDialog.tsx` 不再自带 75/50 阈值，改用 `web/src/lib/utils.ts` 的
  `metacriticTone()` + 本组件专属类名表。
- **Escape 关闭 / 轮播定时器**：新增 `web/src/lib/hooks.ts`（`useEscapeClose()` / `useRotationTimer()`），
  `PlatformDialog.tsx`、`PosterDialog.tsx`、`HeroPosterCarousel.tsx`、`PosterCarousel.tsx` 改为调用 ——
  两个轮播的定时器过去各写一遍（含 hover 暂停与手动翻页后的冷却），已经漂移过一次。
- **代理探针**：`backend/src/common/http/proxy-config.ts` 的 `probeHttpProxy` / `probeHttpsProxy`
  改为共用 `probeProxy(url, useTls, …)`，对外签名不变。

### 修复

- **用户自己选的海报不再被元数据覆盖。** `MetadataService.persist()` 的注释一直写着「只有本地海报
  还在时才用元数据填充海报」，但那条判断算出的变量从未被使用：UPDATE 的参数直接传了
  `fragment.poster`，于是只要 provider 返回海报，用户手动填的外链海报（含 `/api/media/proxy`
  包装的）就会被静默换掉。现在规则抽成纯函数 `mergePoster()`
  （`backend/src/metadata/metadata-merge.ts`）并真正接进 SQL 参数，判定复用既有的
  `isLocalFileUrl()`：自家下载的海报（`/api/media/…`、`/api/posters/…`）仍可被新抓取替换，
  空白位仍由 provider 填充。
- 新增离线套件 `backend/scripts/verify/poster-merge-unit.mjs`（10 项）：用 esbuild 打包真实源码断言
  规则本身，并对编译产物做静态断言，确保 `persist()` 真的调用它、参数首位不再是 `fragment.poster`
  （IGDB 的 base URL 写死、无法像 HLTB / Metacritic 那样指到桩服，这条链路没法离线端到端驱动）。

### 验证

- `npm run build`、`npx tsc --noEmit -p backend/tsconfig.json`、`npx tsc --noEmit -p web/tsconfig.json`
  全部通过。
- 10 个离线套件 / 382 条断言全绿：媒体评价抓取→解析→落库→接口、解析器纯函数、官方接口、
  抓取编排、轮播归属、SSR、通关时长缓存（含真实浏览器）、媒体评价分页与搜索排序（真实 Chromium）、
  海报归属规则（`poster-merge-unit.mjs`）。
- 另用「生产依赖子集」起了一次完整应用做冒烟：`/api/health` 返回 200 且 27 个 feature 标记齐全，
  `/`、`/api/games`、`/api/settings`、`/api/library/status` 均 200，数据目录与数据库建表正常。

## [0.6.4] — 2026-10-01

**界面版。** 0.6.3 解决的是「媒体评价抓得全不全」，这一版动的全是**用户能看见的界面**，
不涉及抓取链路。

### 界面

- **详情页评分区去掉「用户评分」列**。Metacritic 现在不再提供可用的用户分（旧解析器从
  RSC 里捞到的那个数字其实是列索引），界面上却一直摆着一列「—/10」，看起来像抓取失败。
  评分区现在只剩 Metascore、评论数与分级。
  - 后端字段 `userScore` / `userCount` **保留**（接口与离线测试仍在使用），只是不再渲染。
- **媒体评价页码可点**。原来是纯文本「第 N / M 页」，只能靠上一页/下一页一页页挪；现在
  渲染成页码按钮：页数 ≤7 时全部铺开，更多时保留首页、末页与当前页相邻页，中间用省略号；
  点了直接跳页，当前页带 `aria-current="page"`（读屏能听出在第几页）。
- **媒体评价面板加搜索 + 排序**。
  - 搜索按**媒体名**过滤，忽略大小写与首尾空白；**只有媒体名参与匹配** —— 正文匹配会让
    「为什么这条会出现」难以解释（搜「PC」时正文里偶然提到 PC 的评价混进来，看着就像
    筛选坏了）。
  - 排序五种：站点顺序（默认，不擅自改动抓取结果）、评分从高到低 / 从低到高、时间从新到
    旧 / 从旧到新。
  - 两者都在**已经取回的那份列表**上本地生效，不再请求后端，且都排在平台筛选**之后**
    （用户的心智顺序是「先选平台，再在这个平台里找某家媒体 / 换个排法」）。
  - 缺值（没有分数 / 没有日期）的条目**一律垫底**，不跟着升降序翻转 —— 否则「评分从低到
    高」会把没打分的排到最前，看起来像「这些是最差的一组」。排序不改动原数组，平台计数与
    总条数仍按原列表算。
  - 搜索无命中时给**专门的空态**，与「该平台暂无评价」分开说 —— 复用同一句话会让人以为
    是平台变了。

### 验证

- `backend/scripts/verify/review-pagination-test.mjs`：为三个新纯函数 `filterByOutlet` /
  `sortReviews` / `pagerPages` 增加 33 条断言（含「不原地排序」「缺值垫底」「省略号只在
  必要处出现」），**65 → 98 项全通过**。
- `backend/scripts/verify/requirements-ui.mjs`（真实 Chromium）：新增「需求 4」——搜 `ign`
  只剩 IGN、五种排序各自的首条媒体正确、点页码「2」直接跳到第 2 页且 `aria-current`
  跟着走、搜不到时出现专用空态，**40 → 58 项全通过**。
- 测试数据：`backend/scripts/verify/ssr-hooks-stub.mjs` 的 13 条评价原先 `publishedAt`
  全是 `2024-09-05`，现改为**互不相同**（序号越小日期越新）—— 否则「按时间排序」在界面上
  看不出任何变化，浏览器断言分辨不出它是生效了还是压根没动。
- health 新增三个标记：`ratings-no-user-score`、`reviews-ui-search-sort`、
  `reviews-page-jump`，`scripts/rebuild-and-verify.sh` 的 `EXPECTED_FEATURES` 已同步。

---

## [0.6.3] — 2026-10-01

**修复版（0.6.2 上线后的第二轮实测）。** 0.6.2 部署完成后，`007 初露锋芒` 的媒体评价
仍然只有 **1 条**（Metascore 上写着 99 个评论），首页卡片的切换箭头也依旧常驻。定位后
确认：前两轮「跟分页器」的思路建立在一个**已经不存在的前提**上。

### 修复

- **媒体评价只抓到 1 条（第三轮，这次换了数据源）**
  - 真实原因：Metacritic 的游戏页与 `critic-reviews` 列表页**都不再包含评价列表的
    HTML**。评价由 Nuxt 在客户端调一个 JSON 接口渲染，页面里只剩组件占位；旧的 DOM
    选择器在新版 markup 上一条也匹配不到。而 `?page=` / `?offset=` 在 HTML 路由上也
    不再生效：实测 `critic-reviews/?page=2` 与第 1 页字节数几乎相同（返回同样的 10 条），
    `?offset=10` 返回 0 条。
  - 于是前两轮的修复（跟随分页器、落地页没有分页器时补探列表页）**都抓不到东西**：
    它们在 HTML 里找分页器，而 HTML 里已经没有分页器了。这也解释了为什么离线夹具一直
    通过、线上一直只有 1 条 —— 夹具是按当时（已过时）的站点形态写的。
  - 现在直接调用站点页面自己在用的那个接口（公开、无需 key）：
    `https://backend.metacritic.com/reviews/metacritic/critic/games/<slug>/web?offset=N&limit=10&filterBySentiment=all&sort=score&componentName=critic-reviews&componentDisplayName=critic+Reviews&componentType=ReviewList`
    - `offset=0` 实测返回 `totalResults: 99` + 10 条；翻页按返回体里的 `links.next.href`
      走，`links.last.href` 是末页（`offset=90`）。
    - `limit` 会被服务端忽略（传 100 仍只回 10 条），所以**按实际返回条数前进**，不按
      `limit` 推导页码，否则会漏页。
    - 兜底保留：接口拿不到时仍解析 HTML，并且这次把**列表页解析出的评价也并入**
      （旧代码在这条分支上会直接把列表页的结果丢掉）。
    - 新标记 `reviews-api-source`。
  - 顺带把 HTML 解析器补上新版 markup（`data-testid="review-card"` / `review-quote-text`
    / `review-card-date` / `review-platform` / `review-full-review-link`、评分徽章
    `.c-siteReviewScore`），让兜底路径在真实页面上也能出东西而不是 0 条。

- **首页卡片箭头改为跟随展现模式**
  - `0.6.2` 的口径是「可浏览张数 > 1 就渲染箭头」，于是**没设轮播**的静态封面也常驻
    两枚箭头（截图里就是这个现象）。本轮按实测反馈改成：**设为轮播才显示
    上一张/下一张**，静态封面不显示；0 张 / 1 张图仍然不显示。计数器保留 —— 它说明
    这个游戏有多张海报可看，是点进详情的理由。
  - 详情页大图区**不受影响**：两种模式下都保留箭头（那里图大，翻页有意义）。
  - 新标记 `card-arrows-need-slideshow`。

### 变更

- 版本号 `0.6.2` → `0.6.3`（`package.json` / `backend` / `web` 三处同步）。
- 「编辑海报」弹窗里的说明文案补上「上面的展现模式也决定首页卡片封面是否显示箭头」
  （`zh` / `en` 同步）。
- `scripts/rebuild-and-verify.sh` 的 `EXPECTED_FEATURES` 增加本轮两个标记：部署后
  只要 `curl …/api/health` 里能看到 `reviews-api-source`，就说明跑的是 0.6.3。

### 验证

全部离线可跑，**不访问任何真实站点**：

| 脚本 | 覆盖 | 结果 |
| --- | --- | --- |
| `backend/scripts/verify/metacritic-api-test.mjs` | 官方接口解析 + 翻页 + **测试隔离**（**本轮新增**） | 38 项通过 / 0 失败 |
| `backend/scripts/verify/metacritic-crawl-test.mjs` | 抓取编排（接口优先 / HTML 兜底） | 13 项通过 / 0 失败 |
| `backend/scripts/verify/metacritic-reviews-test.mjs` | 评价解析（纯函数，含新版 markup） | 63 项通过 / 0 失败 |
| `backend/scripts/verify/review-pagination-test.mjs` | 分页 + 平台筛选 | 65 项通过 / 0 失败 |
| `backend/scripts/verify/media-reviews-e2e.mjs` | 抓取 → 落库 → 接口（**本轮修好**，见下） | 63 项通过 / 0 失败 |
| `backend/scripts/verify/requirements-ui.mjs` | 三项需求（**真实 Chromium**，含静态封面不显示箭头） | 40 项通过 / 0 失败 |
| `backend/scripts/verify/poster-ui-ssr.mjs` | 海报 UI（SSR 真实组件） | 10 项通过 / 0 失败 |

`backend` `tsc` 0 错误；`web` `tsc` 0 错误；`vite build` 通过。

本轮同时修掉两个**测试基建**的缺陷 —— 它们正是「离线全绿、线上没修好」的一部分原因：

- 接口 origin 原先写死在 `backend.metacritic.com`，而离线套件只把 **HTML** 基址指向本地
  桩服。于是 `media-reviews-e2e` 一边声称「只访问本地桩服」，一边真的从线上取回了 99 条
  评价，断言以「期望 3 条、实际 10 条」这种莫名其妙的方式失败（数字还在两轮之间变来变
  去）。现在：HTML 基址被改写时接口跟着走，`metacritic-api-test.mjs` 用**子进程**锁住这
  条规则（模块在 require 时读环境变量，同进程改不回去）。
- 桩服对**任何** slug 的 `/game/<slug>/critic-reviews/` 都返回 astro-bot 的分页夹具，
  于是 0.6.2 加上「落地页没有分页器就补探列表页」之后，血源诅咒（期望 3 条）顺着别人的
  列表页一路翻到 p6、落库 69 条 —— 看起来像抓取越界，其实是夹具串台。现在按 slug 分开：
  只有 astro-bot 的列表页分页，其余 slug 的列表页是「没有评价也没有分页器」。
  这两个缺陷与本轮改动无关，但在同一个套件里，所以一并修掉并写进这里。

> 线上实测用的证据（本轮排查时抓的真实返回，已作为夹具固化）：
> `/game/007-first-light/` 与 `/game/007-first-light/critic-reviews/` 的 HTML 里，
> 新版卡片分别是 14 张 / 10 张，而旧选择器解析出的评价数分别是 1 / 0；
> 同一个 slug 走接口拿到 `totalResults: 99`，按 `links.next` 翻页可拿到全部。

## [0.6.2] — 2026-10-01

**修复版。** 针对 `0.6.1` 发布后实测暴露的三项问题：媒体评价仍然抓不全、媒体评价无法
按平台查看、首页卡片在没有轮播图时仍显示切换箭头。

> 为什么不是继续叫 `0.6.1`：`0.6.1` 的镜像已经推上 GHCR 与 Docker Hub，同号再推会让
> 「标签相同、内容不同」，排障时无法判断线上跑的是哪一版。本轮又新增了平台选择器这个
> 功能，因此按语义化版本上一个补丁位。

### 修复

- **媒体评价仍然只抓到少数几条（第二轮修复）**
  - 上一版给抓取加上了分页跟进，但**只在落地页自己带分页器时才会走**。真实站点上大量
    游戏的落地页并不带分页器 —— 分页器长在 `/game/<slug>/critic-reviews/` 这个列表页上，
    于是抓取在读完落地页的 2 条后就停了。新增：落地页没有分页器时，补一次列表页请求，
    若列表页可分页则从那里继续翻。
  - 顺带修正一个会让翻页**提前一轮就停**的计数错误：列表页的分页器把「第 1 页」也列成
    `?page=1`，而「当前已抓到第几页」原先从 0 起算，导致第 1 页被重复抓取一次后直接
    判定「没有前进」而收尾（66 条退化成 2 条）。现在落地页即算第 1 页，并对
    「目标页码不大于当前页码」显式跳出。
  - 离线验证：新增夹具 `landing-no-pager.html`（**故意不带任何分页器**，复刻真实站点
    形态）+ 新脚本 `metacritic-crawl-test.mjs`。同一份夹具下修复前 2 条、修复后 66 条。

- **媒体评价页新增平台切换**
  - 面板上出现平台下拉框，切换后只显示该平台的评价，条数标注随之变化。
  - 选项只列**评价里真实出现过的平台**（并带条数），不是游戏自身的平台列表 —— M 站对
    同一款游戏在不同平台下收录的媒体不同，按游戏平台列会让用户切过去只看到空列表。
  - `platform` 为空的评价不单列成「未知平台」选项，它们始终留在「全部平台」里。
  - 切换平台会把页码收回第 1 页，避免停在上一个平台的页码上。
  - 该筛选在**前端**完成（`platform` 字段本就在返回体里）。后端契约与全局的
    「共 N 条媒体评价」总数保持不变，因此不受抓取侧 `MAX_REVIEWS` 截断的影响。

- **首页卡片：没有可轮播的图时不再显示切换箭头**
  - 此前箭头常驻。现在只有**可浏览张数 > 1** 时才渲染 —— 0 张（走字母占位）和 1 张
    （无可翻页对象）都不渲染。
  - 同时补上了原先**只是打印、并未断言**的那条检查：`poster-ui-ssr.mjs` 里
    「单张图时按钮数 = 0」原本是 `info()`，即使回归了也照样报「8 项通过 / 0 项失败」。

### 变更

- 首页卡片仍使用**全部已登记海报**轮播（沿用上一轮解耦后的行为，不因本轮改动收窄）。
- 版本号 `0.6.1` → `0.6.2`（`package.json` / `backend` / `web` 三处同步）。

### 验证

全部离线可跑，**不访问任何真实站点**：

| 脚本 | 覆盖 | 结果 |
| --- | --- | --- |
| `backend/scripts/verify/metacritic-reviews-test.mjs` | 评价解析（纯函数） | 63 项通过 / 0 失败 |
| `backend/scripts/verify/metacritic-crawl-test.mjs` | 抓取编排（**本轮新增**） | 13 项通过 / 0 失败 |
| `backend/scripts/verify/review-pagination-test.mjs` | 分页 + 平台筛选 | 65 项通过 / 0 失败 |
| `backend/scripts/verify/requirements-ui.mjs` | 三项需求（**真实 Chromium**） | 36 项通过 / 0 失败 |
| `backend/scripts/verify/poster-rotation-e2e.mjs` | 海报轮播后端行为 | 16 项通过 / 0 失败 |
| `backend/scripts/verify/poster-ui-ssr.mjs` | 海报 UI（SSR 真实组件） | 10 项通过 / 0 失败 |

`backend` `tsc` 0 错误；`web` `tsc` 0 错误；`vite build` 通过；
i18n `zh`/`en` 对齐 133/133（含新增 5 个平台筛选 key）。

## [0.6.1] — 2026-09-30

**修复版。** 针对 `0.6.0-beta.1` 发布后实测暴露的问题：海报轮播的归属规则、媒体评价
只显示一条、以及构建与部署链路上几个会误导排查的问题。

> 版本号说明：`0.6.0` 是第 6 轮（媒体评价）。本次全部是修复、没有新增功能模块，
> 按语义化版本落在补丁位，因此是 `0.6.1` 而不是新的次版本。

### 修复

- **海报轮播：相册截图不再被自动塞进轮播**
  - 旧规则"把轮播帧数补到 `2 + 相册图数`"会用本地相册截图大量填充轮播。轮播现在
    只放**封面 + 用户亲手勾选的图**。
  - **启动期做一次清理**，把旧规则已经写进库的那些帧摘出来。只摘"机器替你决定"的
    （`slideshow_user_set = 0`），**用户亲手勾选过的一律保留** —— 实测库里 8 行属于
    用户自己取消的，清理后全部原样保留。
  - 已知代价（**有意接受**）：某个游戏的官方源只给出一张图、用户又没勾选任何图时，
    详情页大图区只有一帧。首页卡片不受影响 —— 它用全部已登记海报，官方截图仍逐张轮播。
- **两个轮播解耦**：首页卡片与详情页大图区此前共用同一份轮播逻辑，改动会互相牵连。
  现在各自独立取数，互不影响。
- **媒体评价只显示一条 → 现已抓全**
  - 根因：列表页只印出前几条评论，其余在分页里。改为按
    `/game/<slug>/critic-reviews/?page=N` 翻页抓取（上限 200 条 / 20 页，页间限速）。
  - 界面支持分页浏览：默认显示 5 条，点「展开」显示 10 条，**一页最多 10 条**，
    可前后翻页。
- **界面三则**
  - 首页卡片不再显示下方的圆点指示器（详情页大图区保留 —— 那里需要它表达"可翻页"）。
  - 「编辑海报」里**每一张图**都能取消展示，按钮样式与删除海报一致（垃圾桶）。相册
    来源的图同样可以取消，取消后仍可从相册重新添加。
- **启动期清理的日志不再漏报**：清理确实执行了（实测相册帧从 268 行降到 0），
  日志却写"nothing to repair"。日志条件补上被清理的计数。

### 变更

- **构建期脚本改为目录 COPY**（`scripts/build/`）
  - 此前 `verify-build-artifacts.sh` 与 apk 脚本放在一起逐文件 COPY，而它是"每轮都改"
    的文件，一改就让 apk 层缓存失效、经代理重装 150MB+ 的编译工具链，表现为
    "卡在某一步很久没输出"。
  - 现在构建期脚本集中在 `scripts/build/`，用一次目录 COPY 引入，边界清晰：
    部署/验证类脚本再怎么改都不会连带打穿 apk 与 npm install 层。
- **apk 安装过程可见**：安装输出此前被重定向到日志文件，`APK_INSTALL_TIMEOUT` 内屏幕
  上一个字都没有，十几分钟无输出会被当成卡死。现在实时显示，同时保留日志供诊断；
  超时从 900s 降到 240s —— 一个源装不完就切下一个，而不是让人干等。
- **新增部署/发布脚本**：`rebuild-and-verify.sh`（重建+重启+体检）、
  `verify-rotation-state.sh`、`verify-media-reviews.sh`、`verify-ui-change.sh`、
  `diagnose-image-check.sh`、`package-image.sh`（打可搬运的镜像包 + 生成上传说明书）。

### 安全 / 仓库整理

- 从 git 历史中移除误入库的 167MB 镜像 tar 包，并补上忽略规则。
- 补齐 `.dockerignore`（`logs/`、`.tmp*`、私人备份目录）：构建上下文从 700MB+ 降到约 17MB。
- `.gitignore` 显式忽略 `media/` —— 它是相册挂载点，此前仅靠"空目录不被跟踪"才没被上传。

## [0.6.0-beta.1] — 2026-09-29

**Beta 测试版。** 第 6 轮迭代：媒体评价（Metacritic 评论原文）、海报轮播全量修复、
Docker 化构建与启动期存量数据修复，并完成面向公开发布的脱敏整理。

### 新增

- **媒体评价模块**（详情页「媒体评价」标签页）
  - 展示**媒体名称 / 媒体打分 / 媒体评价原文**三段式信息，按分数从高到低排列
  - 空状态区分四种来源：`ok`（本次抓到）/ `empty`（源站确无）/ `failed`（抓取失败）/
    `unsupported`（未绑定条目或站点无该条目）
  - **`empty` 与 `failed` 都不会删除已存的评价行** —— 源站抖动不会让历史数据消失，
    只有手动重新匹配才会清理
  - 抓取失败时提示里带具体原因（403 / 限流 / 不可达），而不是笼统的"暂无数据"
- **独立的 Metacritic 评论爬虫**
  `backend/scripts/crawlers/metacritic-media-reviews.mjs`，遵守站点限速
  （`CRAWLER_MIN_INTERVAL_MS`，默认 ≥1s）
- **数据表与接口**
  - 新表 `media_reviews`，新增 `games.reviews_status` / `reviews_error` /
    `reviews_fetched_at` / `reviews_count` 四列
  - `GET  /api/games/media-reviews/coverage` 覆盖率
  - `GET  /api/games/:id/media-reviews` 单个游戏
  - `POST /api/games/:id/media-reviews/refresh` 单个重新抓取
  - `POST /api/games/backfill-ratings` 批量补全
- **启动期存量数据修复**（`backend/src/maintenance/maintenance.service.ts`）
  - **海报轮播下限**：每次启动、等首轮媒体扫描结束后，把轮播帧数低于
    `2 + 相册图数`（上限 8）的游戏用本地相册截图补足。纯数据库操作、只增不删、
    幂等，因此每次启动都检查
  - **通关时长补全**：首次启动执行一次（在 `settings` 表记标记），对仍无时长的
    游戏重新问数据源
  - 解决一个真实缺口：修复后的 provider 只会影响**新刮削**的游戏，
    `last_meta_refresh` 已写上的存量游戏永远不会被重新处理
  - 可用 `MAINTENANCE_ON_BOOT=0` 整体关闭；等待扫描的上限由
    `MAINTENANCE_SCAN_TIMEOUT_MS` 控制
- **Docker 化构建与部署**（宿主机不需要 node / npm）
  - `scripts/docker-deploy.sh`：构建 → 指纹校验 → 重建容器 → 等健康检查 →
    确认启动期修复已执行
  - `scripts/docker-verify.sh`：部署后自检，全部在容器内运行
  - `scripts/verify-build-artifacts.sh`：**构建阶段**产物自查，缺符号即让构建失败

### 修复

- **构建缓存命中旧 `COPY` 层时镜像静默带旧代码**：在 build 阶段末尾增加产物自查，
  直接检查 `backend/dist` 与 `web/dist` 里是否存在本轮功能必须的符号
  （路由名、表名、前端 `data-testid`、中文文案，共 17 项），缺一个就让构建失败。
  宁可构建失败，也不要部署完才发现少一个标签页
- **`docker compose build` 路径下 npm 兜底源与构建代理静默失效**：
  `docker-compose.yml` 传了 `NPM_MIRROR_REGISTRY` / `SCREENPLAY_BUILD_PROXY`，
  但 Dockerfile 只在第一个 `FROM` **之后**声明它们 —— 按 Docker 规则，`FROM` 之后
  声明的 `ARG` 无法由 `build.args` 赋值，传进来的值会被当作"未使用的构建参数"丢弃。
  只有 `scripts/docker-build.sh`（显式 `--build-arg`）那条路径是好的，
  `docker compose build` 则表现为国内网络下构建超时且看不出原因。已把两个 `ARG`
  提到 `FROM` 之前，并补齐超时参数
- **启动期修复在扫描开始前就退出，导致整个功能静默失效**：
  `onApplicationBootstrap` 在 `app.listen()` **期间**执行，而首轮扫描原先在
  `listen()` **之后**才启动。于是修复逻辑看到 `isScanning() === false`，
  误判为"扫描已完成"，在空库上得出"没什么可修的"，0.2 秒退出。
  修了两处：`main.ts` 把 `startScan()` 提到 `listen()` 之前；停止条件改为
  `!isScanning() && hasScanned()`（并给 `LibraryService` 增加 `hasScanned()`，
  因为只看 `isScanning()` 无法区分"还没开始"和"已结束"）
- 统一接口对「无分数但有原文」的评价的处理（不应因缺分数而丢弃整条评论）

### 变更

- 详情页标签文案「评价」→「**媒体评价**」，与聚合 Metascore 明确区分
- `GET /api/health` 增加 `buildTime` 与 `features` 字段：**"部署的镜像是哪一版"
  变成一条 `curl` 就能判断的事**，不必再靠读代码猜
- 版本号可通过 `BUILD_VERSION` 注入镜像（构建脚本从根 `package.json` 读取）

### 安全 / 脱敏（面向公开发布）

- 移除验证脚本中硬编码的真实 API 密钥与内网代理地址，改为从环境变量读取；
  缺少凭据时相关检查组**明确跳过并说明原因**，不假装通过
- 登录页用户名占位符由真实账户名改为通用示例
- 移除与项目无关的个人 NAS 代理配置；`/vol2/...` 等个人绝对路径改为相对推导
  或可覆盖的环境变量
- `docker-compose.yml` 的媒体挂载路径改用 `MEDIA_HOST_DIR` 变量，不再写死个人目录
- 收紧 `.gitignore`：忽略各轮次生成的 `out-*.cjs` 打包产物、`.tmp*` 工作区与本地备份

---

## 历史轮次

以下轮次在建立版本号体系前完成，归档记录见 [`docs/VERIFY.md`](docs/VERIFY.md)。

| 轮次 | 主题 | 主要能力 |
| --- | --- | --- |
| 1 | 基础骨架 | 媒体目录扫描、游戏识别与匹配、相册展示与播放、SQLite 持久化 |
| 2 | 界面语言与封面 | 简体中文 / English 双语（399 键对齐）、取消封面 / 恢复默认 |
| 3 | 登录认证 | NAS 本地系统账户登录（PAM 体系同一批账户）、会话管理 |
| 4 | 海报与成就 | 海报自选、幻灯片轮播、Steam 成就全量刮削、手动选择游戏 |
| 5 | 奖杯与布局 | PlayStation 奖杯刮削（psnine）、游戏卡片统一 16:9 横向比例 |

---

[1.2.0]: https://github.com/wyunki462-stack/ScreenPlay/releases/tag/v1.2.0
[1.0.0]: https://github.com/wyunki462-stack/ScreenPlay/releases/tag/v1.0.0
[0.6.0-beta.1]: https://github.com/wyunki462-stack/ScreenPlay/releases/tag/v0.6.0-beta.1
[0.6.1]: https://github.com/wyunki462-stack/ScreenPlay/releases/tag/v0.6.1