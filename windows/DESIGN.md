# ScreenPlay Windows 桌面端 · 设计与约定（唯一契约文档）

> 本文件是 `windows/` 目录实现的总契约。任何脚本 / Rust 代码 / 文档都必须与这里一致；如需偏离，先改本文件。

## 0. 三条已定决策（用户确认）

1. 技术栈：**Tauri v2**（体积小，取代 Electron）。
2. 后端：**内置打包**——把现有 NestJS 后端（`backend/`）连同 Windows 版运行时一起打进安装包，本机启动。
3. 交付：Windows 端一键构建脚本 + 产物说明 + 这次**尽力**在本机（Linux）交叉编译出免安装包；失败必须给出精确阻塞点。

## 1. 功能与 UI 目标（用户硬要求）

- 功能完整对齐 Web 端：图库（卡片/搜索/筛选/排序/自定义排序/平台筛选）、详情页四大标签页（媒体/时间线/成就/媒体评价）、上一个/下一个游戏切换、海报大图轮播、媒体评价分页 + 平台切换、通关时长、海报管理（编辑面板、本地上传、相册选图、设为封面、轮播配置、用户配置持久化）、设置页（媒体库管理、数据源配置、界面语言、账户相关全部功能）。
- **全部复用现有后端 REST API，不重复开发后端逻辑，数据行为与 Web 端一致。**
- UI 1:1 复刻 Web 端深色主题（配色、组件样式、布局、间距、交互）。
- 精简：移除移动端适配冗余、非必要装饰性动画；精简依赖；优化启动速度与内存；保留核心功能。
- 交付：构建脚本、产物说明、运行要求，功能完整可用、无缺失、无 UI 差异。

## 2. 核心架构（为什么前端零改动即可 1:1）

后端自己就托管前端静态文件并做 SPA history 回退：

- `backend/src/main.ts:56` `webDist = process.env.WEB_DIST || path.join(process.cwd(), 'public')`
- `backend/src/main.ts:57-58` 仅当 `webDist/index.html` 存在才 `useStaticAssets(webDist)`
- `backend/src/main.ts:63-73` GET 且路径非 `/api/` 且 `accepts('html')` → `res.sendFile(webDist/index.html)`（history 路由自带回退）
- `backend/src/auth/auth.guard.ts:29` 非 `/api/` 路径放行

前端唯一 API 出口是同源相对路径 `/api`（`web/src/api/client.ts:3,23`），媒体 URL 全部由后端 JSON 下发。**因此：只要窗口指向 `http://127.0.0.1:<port>`，前端源码一行都不用改。**

```
Tauri 进程 (ScreenPlay.exe)
 ├─ splash 窗口（Tauri 本地源 tauri://localhost，可用 IPC：显示"启动中 / 失败重试 / 查看日志"）
 │    └─ 后端健康后 window.navigate("http://127.0.0.1:<port>/") → 主界面（远程源，不需要 IPC）
 └─ 子进程 node.exe backend/dist/main.js
      env: PORT/HOST=127.0.0.1/DATA_DIR/MEDIA_DIRS/WEB_DIST/AUTH_*/MAINTENANCE_ON_BOOT=0/
           BUILD_VERSION/BUILD_TIME/FFMPEG_PATH/FFPROBE_PATH + PATH 前置 <resources>/bin
```

要点：**主界面（127.0.0.1 源）不需要任何 Tauri IPC/插件**；只有 splash 用 IPC。后端无单实例锁、无优雅关闭（`backend/src/main.ts:83` 直接 listen，无信号处理），所以**单实例与子进程回收由壳负责**。

## 3. 目录结构与职责

```
windows/
  DESIGN.md                  ← 本文件
  README.md                  交付总览（给用户看的中文说明）
  package.json               仅 devDep: @tauri-apps/cli；npm scripts 总入口
  .gitignore                 忽略 .cache/ dist/ src-tauri/resources/ src-tauri/target/ node_modules/
  build-windows.ps1          一键构建（prepare → tauri build → portable zip）
  build-windows.cmd          双击入口（转调 ps1，-ExecutionPolicy Bypass）
  scripts/
    prepare-frontend.mjs     构建 web/dist 并生成"桌面精简版"（见 §6），输出到 resources/web/
    prepare-backend.mjs      组装 resources/ 下 Windows 后端（见 §4）
    make-portable.mjs        组装免安装 zip（exe + resources + 使用说明.txt + portable.flag）
    build-windows.mjs        ps1 调用的 Node 侧编排（可选，允许直接用 ps1 调 tauri）
  src-tauri/
    Cargo.toml  build.rs  tauri.conf.json
    capabilities/default.json
    icons/                    icon.ico / icon.png / 32x32.png / 128x128.png（可由脚本生成）
    splash/index.html         splash（本地源）
    src/main.rs               入口：单实例、配置加载、后端编排、窗口导航
    src/backend.rs            资源定位、端口选择、node 启动、健康检查、日志、进程树回收
    src/config.rs             config.json 读写（mode/port/mediaDirs/auth 等）
    resources/                ★构建产物（gitignore）：见 §4
  dist/                       ★构建产物（gitignore）：setup.exe / portable.zip
  docs/
    BUILD-WINDOWS.md          构建脚本与打包方案（含 Linux 交叉编译方案与备用路径）
    ARTIFACTS.md              构建产物说明与运行要求（清单、体积、环境要求、数据目录、排障）
    PARITY.md                 与 Web 端功能/UI 对齐验证表 + 四个待处理点的处理方式
```

## 4. resources/ 布局（安装包内随 exe 一起分发的部分）

```
src-tauri/resources/
  node/node.exe                     nodejs.org win-x64（v22.20.0）
  backend/dist/**                   nest build 产物（backend/dist）
  backend/node_modules/**           Windows 版生产依赖（见下）
  backend/package.json              随附（版本信息）
  web/index.html web/assets/**      web/dist 的"桌面精简版"
  bin/ffmpeg.exe bin/ffprobe.exe    @ffmpeg-installer/win32-x64 + @ffprobe-installer/win32-x64
  build-info.json                   { version, sourceHash, builtAt, nodeVersion }
```

Windows 生产依赖安装方式（不要动仓库的 node_modules）：

1. `windows/.cache/backend-pkg/package.json`：按 `backend/package.json` 的 18 个 deps 原版本号生成（**不含 devDependencies**）。
2. 在该目录执行：`npm install --omit=dev --include=optional --os=win32 --cpu=x64 --registry=https://registry.npmmirror.com --cache <windows/.cache/npm>`（npm 11 支持 `--os/--cpu` 覆盖，可得 `@img/sharp-win32-x64` 等 win32 可选依赖）。
3. better-sqlite3：取官方预编译 `https://github.com/WiseLibs/better-sqlite3/releases/download/v11.10.0/better-sqlite3-v11.10.0-node-v127-win32-x64.tar.gz`（Node 22 = ABI 127，免 node-gyp），解出 `build/Release/better_sqlite3.node` 放到 `node_modules/better-sqlite3/build/Release/`。
4. 校验：`node_modules/better-sqlite3/build/Release/better_sqlite3.node`、`node_modules/@img/sharp-win32-x64/**`、`node_modules/sharp/**` 三者必须存在，否则 prepare 失败退出。
5. 网络注意：GitHub 与 nodejs.org 可达；`github.com/tauri-apps/binary-releases/...`（NSIS）需要代理 `-x http://127.0.0.1:7890`；npm 走 `registry.npmmirror.com`/`mirrors.tencent.com`。

## 5. 启动编排（`src/backend.rs` 的行为契约）

1. 解析资源根：开发用 `CARGO_MANIFEST_DIR/resources`，发布用 exe 同目录 `resources/`（Tauri `bundle.resources` 映射）。找不到 → 报错页。
2. 读 `config.json`（见 §7）。若 `mode === "external"`：跳过 3–6，直接用 `baseUrl` 开窗。
3. 选端口：`config.port > 0` 用之；否则从 3210 起探测第一个可绑定端口（`TcpListener::bind(("127.0.0.1", p))` 后立即释放）。
4. 起子进程：`node.exe <resources>/backend/dist/main.js`，`current_dir = <resources>/backend`，**CREATE_NO_WINDOW**，stdout/stderr 重定向到 `<DATA_DIR>/logs/desktop-<date>.log`。
5. 环境变量（除继承外）：
   - `PORT=<p>` `HOST=127.0.0.1`
   - `DATA_DIR`（§8） `MEDIA_DIRS=<DATA_DIR>\media`（若 config 配了更多则以 `;` 连接）
   - `WEB_DIST=<resources>/web`
   - `NODE_ENV=production`
   - `FFMPEG_PATH=<resources>/bin/ffmpeg.exe` `FFPROBE_PATH=<resources>/bin/ffprobe.exe`
   - `PATH=<resources>/bin;%PATH%`
   - `MAINTENANCE_ON_BOOT=0`
   - `BUILD_VERSION=<build-info.json.version>` `BUILD_TIME=<builtAt>`
   - 认证：`auth === "local"` → `AUTH_MODE=local` 且 `AUTH_ADMIN_PASSWORD=<config 生成并持久化的密码>`；`auth === "off"`（默认）→ `AUTH_DISABLED=1`；`auth === "system"` → `AUTH_MODE=system`
6. 轮询 `GET http://127.0.0.1:<p>/api/health`（250ms 一次，最长 90s）→ 200 且 body 内 `"status":"ok"` → 导航主窗口；超时 → splash 显示失败原因 + 日志路径 + 重试按钮。
   （实测 `backend/src/app.controller.ts:73-92` 返回 `{"status":"ok","uptime":…,"version":…,"buildTime":…,"features":[…]}`，**没有** `ok` 字段，只有 `status`；`version` 来自 `BUILD_VERSION`，桌面壳必须注入该变量以便排障。）
7. 退出：窗口关闭 / 托盘退出 / 单实例二次启动 → 先 `taskkill /PID <pid> /T /F`（Windows）回收 node 进程树，再退出；`Ctrl+C`/信号亦处理。
8. 单实例：优先 `tauri-plugin-single-instance`（官方插件，Windows 用命名互斥体）；重复启动时聚焦已有窗口并退出本进程。

## 6. 前端"桌面精简"（`scripts/prepare-frontend.mjs`）

在 **副本** 上做构建后处理，**绝不改 `web/` 源码**（保证 Web 端产物字节不变）：

1. 在 `web/` 执行现有构建（`npm --prefix web run build`，产物 `web/dist`），复制到 `src-tauri/resources/web/`。
2. 精简：删除 `@media (max-width: …)` / `@media (max-width: …) and …` 整块（桌面窗口固定，移动端断点无意义）；其余 CSS 原样保留（视觉 1:1）。
3. 离线化：把产物中 `https://cdn.plyr.io/3.8.4/plyr.svg` 替换为相对路径 `assets/plyr.svg`，并把本地 svg（从 npm `plyr` 包或内联生成）放进 `web/assets/`。
4. 校验：`web/index.html` 存在且引用 `/assets/*.js`、`/assets/*.css`；`grep -c "cdn.plyr.io" resources/web -r` 必须为 0；打印前后体积对比。

## 7. `config.json`（壳的配置，位置见 §8）

```json
{
  "mode": "embedded",
  "port": 0,
  "baseUrl": "",
  "auth": "off",
  "mediaDirs": [],
  "closeToTray": false
}
```
- `mode`: `embedded`（内置后端）| `external`（连已有服务，用 `baseUrl`）。
- `auth`: `off`（默认，AUTH_DISABLED=1）| `local`（内置登录，首启生成随机 admin 密码并写入 `DATA_DIR/初始密码.txt`）| `system`。
- 首次运行自动生成该文件；损坏时回退默认并备份为 `config.json.bak`。

## 8. 数据目录（决定用户数据放哪）

- 默认：`%APPDATA%\ScreenPlay`（Tauri `app_data_dir`）；含 `screenplay.db`、`posters/`、`proxied/`、`thumbnails/`、`logs/`、`media/`。
- **免安装（便携）模式**：exe 同目录存在 `portable.flag` 或 `data\` 目录时，`DATA_DIR = <exeDir>\data`。
- `MEDIA_DIRS` 默认指向 `<DATA_DIR>\media`（保证非空且可写），用户可在设置页"媒体库管理"里增删真实媒体目录。

## 9. 产物

- 安装包：`windows/dist/ScreenPlay_<version>_x64-setup.exe`（Tauri NSIS，`perMachine=false`，可自选目录）。
- 免安装：`windows/dist/ScreenPlay_<version>_x64-portable.zip`（含 `ScreenPlay.exe` + `resources/` + `portable.flag` + `使用说明.txt`）。
- 二者都不含 Playwright/Web 端 node_modules/typescript 等开发依赖。

## 10. 硬约束

- 不改 `web/`、`backend/` 源码；不新增后端逻辑；不改动 API 契约。
- `windows/` 内所有文件用 UTF-8；中文文档；脚本必须能在 Windows PowerShell 5.1 下运行（不依赖 pwsh 7）。
- 体积目标：便携包压缩后 ≤ 200 MB（node ≈ 110 MB 解压、node_modules ≈ 90–115 MB、ffmpeg+ffprobe ≈ 120 MB 解压是主要项）；超出必须说明。
- 网络受限环境：所有下载走 §4 的镜像/代理，失败要给出可读错误。