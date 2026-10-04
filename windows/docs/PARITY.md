# ScreenPlay Windows 桌面端 · 功能对齐（Parity）

本文档回答一个问题：**Web 端能做的，Windows 桌面端是不是 1:1 都能做？**

结论：**是**（1.3.3 起桌面端与 Web/Linux 使用完全同一套界面，不再有任何构建期界面裁剪，见差异说明 ⑦）。桌面端不是另一套实现，
而是「**同一份 Web 源码的桌面模式产物 + 同一套后端 REST API**」装进 Tauri v2 外壳里。
前端源码不为桌面端分叉（`web/.env.desktop` 现在只决定输出目录 `web/dist-desktop`，不再替换任何模块，见差异 ⑦），后端源码也不改，
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
| 账户相关功能（登录 / 会话 / 退出 / **修改密码**） | 同上；桌面端默认 `auth: "local"`（1.3.2 起），登录与会话行为与 Web 端完全一致（见差异说明 ⑥），设置页同样提供「修改密码」卡片（1.3.3 起，见差异说明 ⑦） | `config.json` 里 `auth` 为默认 `"local"` 重启 → 出现登录页（首启先在网页创建账户）→ 登录后账户相关页面可用，且**设置页有「修改密码」卡片并能改密**；退出登录后可用新密码重新登录 |

> 「设置页」在桌面端与 Web 端逐字相同：1.3.3 起不再裁剪任何入口（含「修改密码」卡片，见差异 ⑦）。
> 壳另改了后端启动时的两个环境变量（差异 ⑥）。

### 1.5 品牌图标（Web / Linux / Windows 三端同源）

| Web 端表现 | 桌面端实现方式 | 验收证据 |
| --- | --- | --- |
| 标签页图标与页眉左上角品牌块是同一枚品牌 mark：紫青对角渐变圆角方块（`#7c3aed → #06b6d4`，圆角 8/36）+ 白色 lucide `Gamepad2`（按 `20/36` 缩放、描边 2） | 同一段几何镜像三处：Web 标签页 `<link rel="icon" href="/favicon.svg">`（真源 `web/public/favicon.svg`）、桌面启动画面内联 SVG（`src-tauri/splash/index.html`）、exe/安装包图标（`src-tauri/icons/{32x32.png,128x128.png,icon.png,icon.ico}`，由 `windows/scripts/gen-icons.mjs` 生成） | `node windows/scripts/verify-icons.mjs` → 32 项像素断言；`node windows/scripts/verify-desktop.mjs --smoke` → 93 项（静态 82 项），含 `GET /favicon.svg` 200；肉眼应与页眉品牌块一致 |

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
| 后端监听 | `backend/src/main.ts` 末尾 `await app.listen(port, host)`，`host = process.env.HOST \|\| '0.0.0.0'` | 桌面端传入 `HOST=<config.host>`：**1.3.2 起默认 `0.0.0.0`（同一局域网可访问）**，写 `127.0.0.1` 回退为仅本机监听 |
| 品牌图标 | 真源 `web/public/favicon.svg`；镜像 `windows/src-tauri/splash/index.html`（内联 SVG）与 `windows/src-tauri/icons/*`（由 `windows/scripts/gen-icons.mjs` 生成，其 `assertBrandSvg()` 对前两处逐字断言） | 三端同一枚图标；改几何必须三处同步，否则 `gen-icons.mjs` 直接报错 |

---

## 3. 桌面端差异与处理

以下 9 条是**全部**差异（其中 ⑦ 是 1.3.3 已取消的旧差异，保留编号供各文档引用）。每一条都是「要么本来就成立、要么在产物里替换、要么用环境变量代替默认行为」，
没有任何一条要求改动 `web/` 或 `backend/` 的源码（1.3.2 的「首次创号」是 Web/后端**共用**的通用能力，
`AUTH_ALLOW_SETUP` 默认关，服务端/容器部署行为不变）。

### ① SPA history 回退

* **情况**：详情页等前端路由是 history 模式，直接访问/刷新非根路径需要服务器回退到 `index.html`。
* **处理**：**后端自带，无需改动**。`backend/src/main.ts:63-73` 已实现「非 `/api` + 接受 `text/html` → `sendFile(index.html)`」。
  桌面端窗口只导航到 `/`，页面内跳转也由同一逻辑兜住。

### ② Plyr 控件图标原本指向 CDN

* **情况**：`web/src/components/VideoPlayer.tsx:24-41` 的 Plyr `options` 里，图标默认从
  `https://cdn.plyr.io/3.8.4/plyr.svg` 加载。桌面端**不应依赖外网**，否则离线时播放器控件会缺图标。
* **处理**：在**构建产物**里替换为本地 `assets/plyr.svg`（由 `scripts/prepare-frontend.mjs` 完成，见 `windows/DESIGN.md` §6）。
  `resources/web/` 内不得再出现 `cdn.plyr.io`，构建时会校验 `scripts/prepare-frontend.mjs` 第 6 步的
  `FORBIDDEN` 列表（1.3.3 起只剩 `cdn.plyr.io` 一项）命中数必须为 `0`。
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
| `HOST` / `AUTH_MODE` / `AUTH_ALLOW_SETUP` / `AUTH_DISABLED` | **默认 `HOST=0.0.0.0` + `AUTH_MODE=local` + `AUTH_ALLOW_SETUP=1`**（1.3.2 起）——对应 `backend/src/config/configuration.ts:150-152`（`:150` `authEnabled`、`:151` `authMode`、`:152` `authAllowSetup`）；`AUTH_ALLOW_SETUP=1` 时后端不播种账户，`POST /api/auth/setup` 由用户在网页上创建第一个账户 | 桌面端默认要让**同一局域网的手机/平板**也能用，所以不再只绑 `127.0.0.1`；一旦对局域网开放就**不能**关鉴权（`config.rs::normalize()` 的安全不变量会自动把 `off` 提升为 `local`） | 只要本机：编辑 `<DATA_DIR>\config.json` 把 `"host"` 改成 `"127.0.0.1"`（可再把 `"auth"` 设为 `"off"`）；想用随机密码而不是自己创号：把 `"allowSetup"` 改成 `false`（密码写 `<DATA_DIR>\初始密码.txt`）；改用系统账户：`"auth": "system"`。**鉴权代码与 Web/Linux 端完全一致，没有分支** |
| `MAINTENANCE_ON_BOOT` | **`0`（不在启动时跑维护）**——`backend/src/maintenance/maintenance.service.ts:69` 有对应分支 | 启动更快：不必每次开窗都等一遍扫描/清理 | 该变量由壳传入，普通用户无需改；要扫库在**设置页 → 媒体库管理**手动触发即可 |

> 其余环境变量（`PORT`、`HOST=<config.host>`、`DATA_DIR`、`MEDIA_DIRS`、`WEB_DIST`、`FFMPEG_PATH`、`FFPROBE_PATH`、
> `BUILD_VERSION`、`BUILD_TIME`）只是把路径指到随包资源与用户数据目录，不改变任何业务默认值。
> 详见 `windows/DESIGN.md` §2 与 §7。

### ⑦ 桌面端与 Web/Linux 完全同一套界面（1.3.3 起取消改密卡片的构建期裁剪）

* **历史（1.2.0 – 1.3.2）**：桌面端曾在**构建期把「修改密码」卡片整模块换成空实现**（不是运行时隐藏）：
  `web/.env.desktop` 的 `VITE_SCREENPLAY_TARGET=desktop` 经 `web/vite.config.ts` 的 `resolve.alias`
  把 `web/src/components/ChangePasswordCard.tsx` 替换为空实现 `web/src/components/ChangePasswordCard.desktop-stub.tsx`，
  并在 `web/src/pages/Settings.tsx` 用运行时门 `{IS_DESKTOP_TARGET ? null : <ChangePasswordCard session={session} />}`
  隐藏卡片；因此当时桌面产物里 `change-password`、`settings.password.` 命中数为 `0`（构建期断言，见 `scripts/prepare-frontend.mjs` 第 6 步）。
* **现状（1.3.3 起）**：那次裁剪被删除——`resolve.alias` 分支、`ChangePasswordCard.desktop-stub.tsx`、运行时门三处都已移除，
  `web/src/pages/Settings.tsx:201` 现在**无条件**渲染 `<ChangePasswordCard session={session} />`，
  桌面产物（`web/dist-desktop`）与 Web/Linux 产物（`web/dist`）是**同一个应用**。`web/.env.desktop` 的
  `VITE_SCREENPLAY_TARGET=desktop` 现在**只决定输出目录**（`web/vite.config.ts` 的 `build.outDir`），
  `web/src/lib/platform.ts` 仍把它暴露为 `IS_DESKTOP_TARGET` 供目标探测，但不再切换任何模块。
* **为什么恢复**：桌面单机版默认 `auth: "local"`，且**由用户首次打开网页时自己创建账户**（`allowSetup: true`；
  只有关掉时才退回「随机生成并写在 `<DATA_DIR>\初始密码.txt`」）——用户对自己的密码有改的需求，界面里必须给入口，
  1.3.3 起三端一致提供。
* **源码锚点**：`web/src/pages/Settings.tsx:201`、`web/vite.config.ts`（`build.outDir`）、`web/.env.desktop`、
  `web/src/lib/platform.ts`（`SCREENPLAY_TARGET` / `IS_DESKTOP_TARGET`）、`web/src/components/ChangePasswordCard.tsx`（现存）。
  Web/Linux 构建（`web/dist`）与后端接口 `POST /api/auth/password` 完全不受影响（三端共用同一份后端）。

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

### ⑨ 默认对局域网开放 + 首次创号 + 防火墙默认放行（`1.3.2`）

* **情况**：桌面端原先只绑 `127.0.0.1` 且把鉴权关掉（见 ⑥ 的旧说明）。实际使用场景是「装在客厅/NAS
  边上那台 Windows 上，手机、平板、电视盒子也要看同一个库」，而只绑回环地址时局域网根本连不上；
  就算绑出去，Windows 防火墙默认还会挡入站，并且第一次监听非回环地址时系统会弹「允许访问」对话框。
* **处理**（三件事一起改）：
  1. **监听地址**默认 `0.0.0.0`：壳 `cmd.env("HOST", &cfg.host)`（`src/backend.rs`）、启动器 `HOST` 同理，
     端口探测也改成绑**真实地址**（`pick_port(&cfg.host, cfg.port)`）。`normalize()` 只把
     `127.0.0.1`/`localhost`/`loopback`/`local-only` 认成「仅本机」，其余一律回到 `0.0.0.0`。
  2. **鉴权**默认 `local` + `allowSetup: true` ⇒ `AUTH_ALLOW_SETUP=1`，第一次打开网页时用户自己创建账户
     （`POST /api/auth/setup`）。**安全不变量**：对局域网开放时不允许 `auth: "off"`，`normalize()` 会自动提升为 `local`。
  3. **防火墙默认放行**：`firewall: "auto"`（默认）时，壳在**起后端之前**查 `ScreenPlay` 规则、缺失则把
     `allow-screenplay.ps1`（TCP `3210-3309`）写进 `<DATA_DIR>\firewall\` 并**提权执行一次**（一次 UAC），
     再写 `attempted.txt` 保证不反复弹窗；拒绝授权/无 PowerShell 都**不阻断启动**（系统会退回自己的对话框）。
     免安装启动器 `launcher/launch.mjs` 用同一套规则与同一个脚本内容。
* **怎么改回来**：`config.json` 里 `"host": "127.0.0.1"`（仅本机，可再把 `"auth"` 设为 `"off"`）、
  `"firewall": "off"`（完全不碰防火墙）、`"allowSetup": false`（改用随机密码 + `<DATA_DIR>\初始密码.txt`）。
* **源码锚点**：`windows/src-tauri/src/config.rs`（`LOOPBACK_HOST`/`LAN_HOST`/`normalize()`/`lan_reachable()`/
  `allow_setup_env()`）、`windows/src-tauri/src/backend.rs`（`pick_port(host, preferred)`、`cmd.env("HOST", &cfg.host)`、
  `crate::firewall::ensure_allowed(...)`、`lan_ipv4()`）、`windows/src-tauri/src/firewall.rs`（`RULE_NAME = "ScreenPlay"`、
  `port_spec()`、`Outcome`）、`windows/launcher/launch.mjs`（`bindHost()`、`ensureFirewall()`、`lanUrls()`）、
  `backend/src/auth/auth.controller.ts:73`（`@Post('setup')`）、`backend/src/auth/auth.guard.ts:26`
  （`/api/auth/setup` 加入 `PUBLIC_PATHS`）、`web/src/pages/Login.tsx`（`needsSetup` 时的「创建账户」表单）。
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
6. 账户（**1.3.2 起默认 `auth: "local"`**，且首次启动在网页里创建账户，不再有 `初始密码.txt`）：
   启动后打开 「本机地址」或「局域网访问地址」（启动日志里有，也可在设置页看）→ 首次进入要求**创建账户** →
   用刚创建的账户登录 → 账户相关页面可用、**设置页有「修改密码」卡片且能改密**（差异 ⑦：1.3.3 起桌面端与 Web/Linux 同一套界面）→
   退出登录 → 用新密码重新登录成功 →〔§1.4 第四条 + 差异 ⑥⑦〕
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
| 修改密码入口 | **1.3.3 起不再是差异**：桌面端与 Web/Linux 用同一套界面，设置页同样提供「修改密码」卡片（差异 ⑦ 说明其历史与现状）；单机版默认 `auth: "local"` + 首启在网页创号，改密在桌面端同样可用 |

---

## 6. 相关文档

* `windows/DESIGN.md` —— 契约（§2 前端零改动、§6 精简、§7 配置）
* `windows/docs/ARTIFACTS.md` —— 产物、数据目录、排障
* `windows/docs/BUILD-WINDOWS.md` —— 构建
* 仓库根 `README.md`、`docs/VERIFY.md` —— 项目定位与验收套件