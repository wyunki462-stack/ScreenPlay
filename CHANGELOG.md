# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。在 `1.0.0` 之前，版号中的
次版本号对应**功能迭代轮次**，同时以 `-beta.N` 标注测试阶段；自 `1.0.0` 起进入正式版：
功能号递增代表新增能力，修补号代表兼容的缺陷修复。

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

[1.0.0]: https://github.com/wyunki462-stack/ScreenPlay/releases/tag/v1.0.0
[0.6.0-beta.1]: https://github.com/wyunki462-stack/ScreenPlay/releases/tag/v0.6.0-beta.1
[0.6.1]: https://github.com/wyunki462-stack/ScreenPlay/releases/tag/v0.6.1