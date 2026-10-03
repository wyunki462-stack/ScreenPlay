# ScreenPlay Windows 桌面端 · 功能对齐（Parity）

本文档回答一个问题：**Web 端能做的，Windows 桌面端是不是 1:1 都能做？**

结论：**除一处刻意的界面裁剪（桌面端不提供「修改密码」入口，见差异说明 ⑦）外，是**。桌面端不是另一套实现，
而是「**同一份 Web 源码的桌面模式产物 + 同一套后端 REST API**」装进 Tauri v2 外壳里。
前端源码不为桌面端分叉（唯一差别是一次构建期的模块替换，见差异 ⑦），后端源码也不改，
因此不存在“功能重新实现”这件事，也就不存在实现漂移。

* 架构与契约：`windows/DESIGN.md`（§2 前端零改动的原理、§6 前端精简、§7 配置）
* 构建与产物：`windows/docs/BUILD-WINDOWS.md`、`windows/docs/ARTIFACTS.md`

---

## 0. 统一实现方式

**桌面端实现方式（本文档所有功能统一适用）：**

> **复用后端 REST API + 同一份 web 源码的桌面模式产物 `web/dist-desktop`（后端同源托管，见 `windows/DESIGN.md` §2、§6）。**

具体机制：

1. 前端只有一个 API 出口：`web/src/api/client.ts:3` 定义 `const API_BASE = "/api";`，
   `web/src/api/client.ts:23` 的 `fetch(`${API_BASE}${path}`, {...})` 发出所有请求。
   因为是**同源**（相对路径 `/api`），桌面壳把窗口指向 `http://127.0.0.1:<port>/` 时天然成立，**无需任何改动**。
2. 后端同源托管同一份 Web 产物：`backend/src/main.ts:56` 取
   `webDist = process.env.WEB_DIST || path.join(process.cwd(), 'public')`；
   `backend/src/main.ts:57-58` 在 `webDist/index.html` 存在时启用静态托管；
   `backend/src/main.ts:63-73` 对「非 `/api` 且接受 `text/html`」的 GET 回退到 `index.html`（SPA history 路由）。
   桌面端只是把 `WEB_DIST` 指到 `resources/web`（见差异说明 ①）。
3. 鉴权不挡静态资源：`backend/src/auth/auth.guard.ts:29` 的
   `if (!path.startsWith('/api/')) return true;` 让页面与 `assets/*` 直接可访问。
4. 桌面壳负责：拉起后端（`resources/node/node.exe resources/backend/dist/main.js`）、
   健康检查 `GET /api/health`、把窗口导航到该地址。

因此下表「桌面端实现方式」一栏在每行都写成同一句话，只标注该功能**落在哪个页面/交互**上，
便于逐条核对。

---

## 1. 对齐表

### 1.1 图库

| Web 端功能 | 桌面端实现方式 | 验收证据 |
| --- | --- | --- |
| 游戏卡片展示（封面 + 名称 + 时长等） | 复用后端 REST API + 同一份 web 产物（后端同源托管，见 DESIGN §2）；图库页网格由 `resources/web/assets/*.js` 内同一套组件渲染 | 桌面端启动后进入图库，卡片封面全部加载（无破图），点击任意卡片进入详情页 |
| 搜索 / 筛选 / 排序 | 同上；搜索框与筛选器发出的 `/api/*` 请求打到内置后端 | 输入一个已有游戏名 → 列表实时过滤；切换任一排序项 → 列表顺序变化且刷新后保持 |
| 自定义排序（用户自定顺序） | 同上；排序结果由后端持久化，重启后仍生效 | 调整为自定义顺序 → 关闭应用再打开 → 顺序与关闭前一致 |
| 平台筛选（按平台过滤） | 同上 | 选择一个平台（如 PC / PS5）→ 只显示该平台游戏；与其他筛选组合时结果正确 |

### 1.2 详情页

| Web 端功能 | 桌面端实现方式 | 验收证据 |
| --- | --- | --- |
| 四大标签页：媒体 / 时间线 / 成就 / 媒体评价 | 复用后端 REST API + 同一份 web 产物（后端同源托管，见 DESIGN §2）；四个标签页是同源页面内的组件，逐个标签拉各自 `/api/*` 数据 | 打开任一游戏详情页，依次点四个标签，均能出数据、无空白页、无 404 |
| 上一个 / 下一个游戏切换 | 同上；切换时前端路由变化，命中 `backend/src/main.ts:63-73` 的 SPA 回退 | 在详情页点「下一个」→ 进入下一个游戏详情；连续切换 10 次无白屏 |
| 海报大图轮播 | 同上；轮播为前端组件，图片走同源静态资源。**范围是全部官方海报**（官方刮削 + 用户上传，不含相册截图），默认自动轮播，与「编辑海报」面板里的轮播开关无关 | 详情页顶部轮播自动播放（3.5 秒切换），左右箭头与 `x/y` 计数常驻、可手动切换并循环；图片无跨域/混合内容报错（控制台干净） |
| 媒体评价分页展示 | 同上；分页参数由后端支持（PageQuery 契约见 DESIGN §10，桌面端不新增） | 媒体评价标签页滚动/翻页到第 2、3 页，数据不重不漏 |
| 媒体评价 + 平台切换 | 同上 | 在媒体评价里切换平台 → 列表随之切换为该平台的数据 |
| 通关时长（真实时长统计展示） | 同上 | 详情页显示的时长与 Web 端同一游戏显示一致；有媒体文件时数值基于媒体清单计算，而非第三方“平均时长” |

### 1.3 海报管理

| Web 端功能 | 桌面端实现方式 | 验收证据 |
| --- | --- | --- |
| 编辑海报面板 | 复用后端 REST API + 同一份 web 产物（后端同源托管，见 DESIGN §2） | 打开编辑海报面板，能列出候选海报与当前封面，面板不报错 |
| 本地上传 / 从相册选图 | 同上；上传走同源 `/api/*` 上传接口，落盘到 `<DATA_DIR>\posters\`（见 `docs/ARTIFACTS.md` §4） | 从本机选一张图上传 → 设为封面成功；在 `%APPDATA%\ScreenPlay\posters\` 下能看到新文件 |
| 设为封面 | 同上；选择结果由后端持久化 | 设为封面后立即生效；重启应用后封面仍是你选的那张（**这是 1.0.0 修掉的「用户自选海报被元数据覆盖」缺陷**，见仓库根 `README.md`） |
| 卡片轮播配置（选择哪些海报参与**首页卡片**封面轮播） | 同上 | 勾选/取消若干海报 → **首页图库卡片**的轮播内容随之变化；详情页大图不受影响（始终是全部官方海报自动轮播） |
| 用户配置持久化 | 同上；配置存后端数据库（`<DATA_DIR>\screenplay.db`），桌面端不做任何本地改写 | 任意改一轮海报配置 → 退出应用 → 重开 → 配置保留 |

### 1.4 设置页

| Web 端功能 | 桌面端实现方式 | 验收证据 |
| --- | --- | --- |
| 媒体库管理（增删目录、触发扫描） | 复用后端 REST API + 同一份 web 产物（后端同源托管，见 DESIGN §2） | 添加一个媒体目录 → 触发扫描 → 图库出现该目录下的游戏；删除目录后不再扫描（本地文件不被删除） |
| 数据源配置（第三方元数据源开关/密钥等） | 同上 | 修改数据源配置并保存 → 重开应用配置仍在；抓取时按新配置走 |
| 界面语言 | 同上 | 切换语言 → 界面文案立即切换；重开应用后语言保持 |
| 账户相关功能（开启鉴权后的登录 / 会话 / 退出等；**不含修改密码**） | 同上；桌面端默认 `AUTH_MODE=off`，开启 `local`/`system` 后登录与会话行为与 Web 端完全一致（见差异说明 ⑥）。**「修改密码」卡片是唯一被裁掉的界面入口**：单机版密码由首启生成并写在 `<DATA_DIR>\初始密码.txt`，界面上不需要改密（见差异说明 ⑦） | `config.json` 里把 `auth` 设为 `local` 重启 → 出现登录页；用 `<DATA_DIR>\初始密码.txt` 里的密码登录成功；登录后账户相关页面可用，且**设置页没有「修改密码」卡片**；退出登录后可用同一密码重新登录 |

> 「设置页」在桌面端只被裁掉一个入口：「修改密码」卡片（构建期整模块替换，见差异 ⑦）；
> 其余入口与 Web 端逐字相同。壳另改了后端启动时的两个环境变量（差异 ⑥）。

### 1.5 品牌图标（Web / Linux / Windows 三端同源）

| Web 端表现 | 桌面端实现方式 | 验收证据 |
| --- | --- | --- |
| 标签页图标与页眉左上角品牌块是同一枚品牌 mark：紫青对角渐变圆角方块（`#7c3aed → #06b6d4`，圆角 8/36）+ 白色 lucide `Gamepad2`（按 `20/36` 缩放、描边 2） | 同一段几何镜像三处：Web 标签页 `<link rel="icon" href="/favicon.svg">`（真源 `web/public/favicon.svg`）、桌面启动画面内联 SVG（`src-tauri/splash/index.html`）、exe/安装包图标（`src-tauri/icons/{32x32.png,128x128.png,icon.png,icon.ico}`，由 `windows/scripts/gen-icons.mjs` 生成） | `node windows/scripts/verify-icons.mjs` → 32 项像素断言；`node windows/scripts/verify-desktop.mjs --smoke` → 68 项，含 `GET /favicon.svg` 200；肉眼应与页眉品牌块一致 |

> 生成与校验只用 Node 标准库（自写 PNG/ICO 编码器与 PNG 解码器），不引入 sharp/canvas/Playwright。
> **exe 内嵌图标要在 Windows 上重新打包后才会变成新图标**（PNG/ICO 已是 git 跟踪的产物文件）。

---

## 2. 关键源码锚点（便于人工复核）

| 锚点 | 位置 | 作用 |
| --- | --- | --- |
| 唯一 API 出口 | `web/src/api/client.ts:3`（`const API_BASE = "/api";`）、`web/src/api/client.ts:23`（`fetch(`${API_BASE}${path}`, {...})`） | 前端所有请求都走同源 `/api`，因此换壳不需要改前端 |
| 静态托管 + SPA history 回退 | `backend/src/main.ts:56-73`——:56 取 `const webDist = process.env.WEB_DIST \|\| path.join(process.cwd(), 'public')`；:57-58 在 `webDist/index.html` 存在时启用静态托管；:63-73 对「非 `/api` 且接受 `text/html`」的 GET 回退到 `index.html` | 桌面端把 `WEB_DIST` 指到 `resources/web`；详情页等前端路由直接刷新不会 404 |
| 非 API 路径放行 | `backend/src/auth/auth.guard.ts:29`（`if (!path.startsWith('/api/')) return true;`） | 开启鉴权后页面与静态资源仍可访问 |
| Plyr 控件图标 CDN | `web/src/components/VideoPlayer.tsx:24-41`（Plyr `options` 块） | 其默认图标指向 `https://cdn.plyr.io/3.8.4/plyr.svg`，桌面端产物里被替换（差异 ②） |
| 后端监听 | `backend/src/main.ts` 末尾 `await app.listen(port, host)`，`host = process.env.HOST \|\| '0.0.0.0'` | 桌面端传入 `HOST=127.0.0.1` 仅本机监听 |
| 品牌图标 | 真源 `web/public/favicon.svg`；镜像 `windows/src-tauri/splash/index.html`（内联 SVG）与 `windows/src-tauri/icons/*`（由 `windows/scripts/gen-icons.mjs` 生成，其 `assertBrandSvg()` 对前两处逐字断言） | 三端同一枚图标；改几何必须三处同步，否则 `gen-icons.mjs` 直接报错 |

---

## 3. 桌面端差异与处理

以下 6 条是**全部**差异。每一条都是「要么本来就成立、要么在产物里替换、要么用环境变量代替默认行为」，
没有任何一条要求改动 `web/` 或 `backend/` 的源码。

### ① SPA history 回退

* **情况**：详情页等前端路由是 history 模式，直接访问/刷新非根路径需要服务器回退到 `index.html`。
* **处理**：**后端自带，无需改动**。`backend/src/main.ts:63-73` 已实现「非 `/api` + 接受 `text/html` → `sendFile(index.html)`」。
  桌面端窗口只导航到 `/`，页面内跳转也由同一逻辑兜住。

### ② Plyr 控件图标原本指向 CDN

* **情况**：`web/src/components/VideoPlayer.tsx:24-41` 的 Plyr `options` 里，图标默认从
  `https://cdn.plyr.io/3.8.4/plyr.svg` 加载。桌面端**不应依赖外网**，否则离线时播放器控件会缺图标。
* **处理**：在**构建产物**里替换为本地 `assets/plyr.svg`（由 `scripts/prepare-frontend.mjs` 完成，见 `windows/DESIGN.md` §6）。
  `resources/web/` 内不得再出现 `cdn.plyr.io`，构建时会校验 `scripts/prepare-frontend.mjs` 第 6 步的
  `FORBIDDEN` 列表（`cdn.plyr.io`、`change-password`、`settings.password.`）命中数必须为 `0`。
  **不改动 `web/src` 源码**。

### ③ 视频播放依赖后端 HTTP Range

* **情况**：拖动进度条播放本地大视频，需要服务器支持 `Range` 请求（206 分片响应）。
* **处理**：**后端已支持，无需改动**。桌面端播放请求打到同一内置后端，行为与 Web 端一致。

### ④ 产物使用根绝对路径 `/assets/*`

* **情况**：桌面精简版 Web 产物的脚本/样式引用写成 `/assets/*`（根绝对路径）。
* **处理**：**同源托管下无需 `<base>` 标签**。桌面壳把窗口指向 `http://127.0.0.1:<port>/`，
  `/assets/*` 自然解析到内置后端托管的 `resources/web/assets/*`。
  （即使未来改成监听非根路径，也应改后端 `WEB_DIST` 托管前缀，而不是往 `index.html` 塞 `<base>`。）

### ⑤ 移动端媒体查询被剥离

* **情况**：桌面窗口不做手机适配，Web 产物里大量 `@media (max-width: …)` 是死代码。
* **处理**：`scripts/prepare-frontend.mjs` 在**副本**上整块删除这些规则（`windows/DESIGN.md` §6）。
  **逻辑与桌面视觉不变**，只减体积；`web/src` 源码、服务端产物 `web/dist` 与桌面产物 `web/dist-desktop` 互不影响。

### ⑥ 打包时用环境变量代替两个默认行为

| 环境变量 | 桌面端默认值 | 为什么 | 怎么改回来 |
| --- | --- | --- | --- |
| `AUTH_MODE` / `AUTH_DISABLED` | **鉴权关闭（`off`）**——对应 `backend/src/config/configuration.ts:144-145`，`AUTH_DISABLED=1` 时 `authEnabled=false`，`authMode` 只认 `local`，否则 `system` | 桌面端是单人本机应用，首启就要求登录很烦；且本机仅 `127.0.0.1` 监听 | 编辑 `<DATA_DIR>\config.json` 把 `"auth"` 改成 `"local"` 或 `"system"`，重启应用。**测试的鉴权代码与 Web 端完全一致，没有分支** |
| `MAINTENANCE_ON_BOOT` | **`0`（不在启动时跑维护）**——`backend/src/maintenance/maintenance.service.ts:69` 有对应分支 | 启动更快：不必每次开窗都等一遍扫描/清理 | 该变量由壳传入，普通用户无需改；要扫库在**设置页 → 媒体库管理**手动触发即可 |

> 其余环境变量（`PORT`、`HOST=127.0.0.1`、`DATA_DIR`、`MEDIA_DIRS`、`WEB_DIST`、`FFMPEG_PATH`、`FFPROBE_PATH`、
> `BUILD_VERSION`、`BUILD_TIME`）只是把路径指到随包资源与用户数据目录，不改变任何业务默认值。
> 详见 `windows/DESIGN.md` §2 与 §7。

### ⑦ 桌面端不提供「修改密码」入口（唯一的界面裁剪）

* **情况**：Web/Linux 的设置页有「修改密码」卡片（本地账户改本机 SQLite 里的密码）。桌面端是单人单机应用：
  鉴权默认关闭；开启后密码由首次启动随机生成并写在 `<DATA_DIR>\初始密码.txt`，界面上不存在改密的场景。
* **处理**：**构建期整模块替换**（不是运行时隐藏）。`web/.env.desktop` 提供 `VITE_SCREENPLAY_TARGET=desktop`，
  `npm run build:web:desktop`（`vite build --mode desktop`）时 `web/vite.config.ts` 用 `resolve.alias`
  把 `web/src/components/ChangePasswordCard.tsx` 换成空实现
  `web/src/components/ChangePasswordCard.desktop-stub.tsx`；卡片文案随卡片搬到
  `web/src/components/ChangePasswordCard.i18n.ts`，所以桌面产物里 `change-password`、`settings.password.`
  命中数都是 `0`（构建时断言，见 `scripts/prepare-frontend.mjs` 第 6 步）。Web/Linux 构建（`web/dist`）与
  后端接口 `POST /api/auth/password` 完全不受影响，改密功能照旧（两端共用同一份后端）。
* **怎么改回来**：服务端/容器部署照旧用 `web/dist`；桌面端如需该卡片，删掉 `web/vite.config.ts` 里的 alias 分支重建即可。
* **源码锚点**：`web/src/lib/platform.ts`（`SCREENPLAY_TARGET` / `IS_DESKTOP_TARGET`）、`web/vite.config.ts`、
  `web/.env.desktop`、`web/src/pages/Settings.tsx`（`{IS_DESKTOP_TARGET ? null : <ChangePasswordCard session={session} />}`）。

### ⑧ 网页标准拖放排序需要关掉外壳的拖放接管（`1.3.1` 修复）

* **情况**：图库「自定义排序」用的是**网页标准 HTML5 拖放**（`web/src/pages/Home.tsx` 的
  `customMode` + `drag` 属性、`web/src/components/GameCard.tsx` 的 `draggable` / `onDragStart` /
  `onDragOver` / `onDrop`）。Tauri v2 的窗口默认开启「内部拖放接管」：`dragDropEnabled` 默认 `true`，
  此时外壳会**替换 WebView2 的 drop handler** 来生成自己的 `DragDropEvent`，页面里的
  `dragstart` / `dragover` / `drop` 就收不到事件 ⇒ 只有桌面端表现为「按住卡片拖不动、排序不生效」，
  浏览器/Web 端完全正常。这是 Tauri 官方配置项注释里写明的平台约束（原文：
  `Disabling it is required to use HTML5 drag and drop on the frontend on Windows since we replace
  the drag drop handler of WebView2.`）。
* **处理**：窗口配置显式关闭接管 —— `windows/src-tauri/tauri.conf.json` 的窗口对象里
  `"dragDropEnabled": false`。**不改任何前端源码即可恢复拖拽**（源码在 Web 端本来就工作）。
* **为什么不影响别的**：`web/src` 与 `windows/src-tauri/src` 里对 Tauri 文件拖放事件
  （`onDragDropEvent` / `tauri://` / `DragDropEvent`）**零引用**，桌面端没有「把文件拖进窗口」这类
  依赖；关掉接管后网页标准拖放全量可用。
* **顺带的前端修复**（同一版：拖后立即生效、不再闪回）：
  * `web/src/pages/Home.tsx` 的 `commitMove` 在发 `PUT /games/order`（`web/src/api/hooks.ts`
    `useReorderGames`）的同时，把新顺序**直接写进** react-query 的 `["games", filters]` 缓存
    （`queryClient.setQueryData`）；否则请求 settle 时会清掉乐观顺序，在「同意性 refetch」落地前
    闪回旧顺序，看起来像「拖了没生效」。
  * 落库失败时不再静默回滚：提示条显示 `home.custom.saveFailed`（中英同步）。
* **源码锚点**：`windows/src-tauri/tauri.conf.json`（`app.windows[].dragDropEnabled`）、
  `web/src/pages/Home.tsx`（`pendingOrder` / `commitMove` / 网格容器级 `onDragOver`）、
  `web/src/components/GameCard.tsx`（`CardDragProps`、`DropIndicator`）、
  `web/src/api/hooks.ts`（`useReorderGames` → `PUT /games/order`，后端 `games.service.ts` 的 `reorder`）。

---

## 4. 一次能跑完的验收清单

在一台干净的 Windows 10/11 x64 上（已装 WebView2），用**便携包**：

1. 解压 → 双击 `ScreenPlay.exe` → 出现启动画面 → 数秒后进入图库，**无白屏、无英文报错弹窗**。
2. 图库：滚动卡片（封面正常）→ 搜索一个游戏 → 平台筛选 → 改排序 → 重启应用确认排序保持。〔§1.1 五行〕
3. 详情页：四个标签页逐个打开 → 点「下一个」切换若干次 → 看轮播 → 媒体评价翻到第 2 页 → 切平台。〔§1.2 六行〕
4. 海报管理：打开编辑海报 → 本地上传一张图 → 设为封面 → 勾选/取消若干张参与**首页卡片轮播**（完成后卡片封面随之自动切换，详情页大图仍是全部官方海报）→ 重启确认保持。〔§1.3 五行〕
5. 设置页：添加一个媒体目录 → 触发扫描 → 图库出现新游戏 → 切界面语言 → 打开数据源配置。〔§1.4 前三条〕
6. 账户：把 `config.json` 的 `auth` 改成 `local` → 重启 → 用 `<DATA_DIR>\初始密码.txt` 登录 →
   账户相关页面可用、**设置页没有「修改密码」卡片**（验证差异 ⑦）→ 退出登录 → 同一密码重新登录成功 →
   改回 `off`。〔§1.4 第四条 + 差异 ⑥⑦；改密流程本身在 Web/Linux 端验收〕
7. 播一个视频：能播放、能拖进度（验证差异 ③）、控件图标正常且**断网也不缺图标**（验证差异 ②）。
8. 排障入口：设置页 → 日志 能打开日志；`<DATA_DIR>\logs\` 下有当天文件。

对应排障步骤见 `windows/docs/ARTIFACTS.md` §7。

---

## 5. 已知限制（不是功能缺失，是平台边界）

| 项 | 说明 |
| --- | --- |
| 移动端布局 | 桌面产物剥离了 `@media (max-width: …)`；窗口拉到极窄不会变成手机布局（差异 ⑤） |
| 浏览器专属能力 | Web 端若有依赖浏览器下载动作/F12 的流程，桌面端表现为 WebView2 内行为（不影响既有功能） |
| 多屏 / 缩放 | 由 WebView2 与系统 DPI 处理；1.0.0 未做桌面端专属适配 |
| 首次启动略慢 | 需要拉起 Node 后端并等 `GET /api/health` 就绪（最长 90 秒超时保护）；已用 `MAINTENANCE_ON_BOOT=0` 提速（差异 ⑥） |
| 修改密码入口 | 桌面端不提供「修改密码」卡片：单机版密码写在 `<DATA_DIR>\初始密码.txt`（差异 ⑦）；Web/Linux 端功能不变 |

---

## 6. 相关文档

* `windows/DESIGN.md` —— 契约（§2 前端零改动、§6 精简、§7 配置）
* `windows/docs/ARTIFACTS.md` —— 产物、数据目录、排障
* `windows/docs/BUILD-WINDOWS.md` —— 构建
* 仓库根 `README.md`、`docs/VERIFY.md` —— 项目定位与验收套件