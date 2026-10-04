# ScreenPlay Windows 桌面端（`windows/`）

这个目录把 ScreenPlay 打包成一个 **Windows 桌面应用**：外壳用 Tauri v2（Rust），
内置一份 Node.js 运行时与编译好的 NestJS 后端，界面就是项目里那份 Web 前端。

**一句话**：`windows/` 只负责「打包与启动」，不包含任何业务逻辑。

> 上游文档：仓库根 [`README.md`](../README.md)（项目定位、版号、迭代历史）。
> 本目录的契约文档：[`windows/DESIGN.md`](DESIGN.md)——所有目录职责、启动编排、配置与数据目录都以它为准。

---

## 目录里有什么

| 路径 | 作用 |
| --- | --- |
| `build-windows.cmd` | **双击这个就能构建**（`build-windows.ps1` 的带 `pause` 入口） |
| `build-windows.ps1` | 一键构建脚本（Windows PowerShell 5.1）：环境自检 → 准备资源 → 编译 → 打包 |
| `scripts/prepare-frontend.mjs` | 把 `web/dist-desktop` 生成**桌面精简版**（去移动端媒体查询、Plyr 图标改本地） |
| `scripts/gen-icons.mjs` | 按 Web 品牌几何（`web/public/favicon.svg`）生成/重建 `src-tauri/icons/` 4 个图标（零依赖） |
| `scripts/verify-icons.mjs` | 图标像素自检：尺寸、圆角透明、渐变色与方向、白色字形、无旧版深色底（32 项） |
| `scripts/prepare-backend.mjs` | 组装 Windows 版后端运行时（`node.exe`、Windows 生产依赖、`ffmpeg`） |
| `scripts/make-portable.mjs` | 把 exe + `resources/` 打成一个便携 zip |
| `scripts/make-webapp-bundle.mjs` | 组装**零工具链**免安装 zip（不需要 exe，解压双击 `ScreenPlay.cmd` 即用） |
| `scripts/cross/` | **Linux 交叉编译套件**：在非 Windows 主机上编译真 `ScreenPlay.exe`（`cross-build.sh` + 4 个垫片），并打 NSIS 安装包（`make-setup-cross.sh` + 原生 `makensis`） |
| `scripts/verify-desktop.mjs` | 交付自检：资源完整性、体积清单、禁带依赖、`--smoke` 真启动一次后端、1.3.2 默认行为（局域网 / 防火墙 / 首次创号）源码断言 |
| `scripts/verify-lan.mjs` | 端到端自检：真拉一次免安装启动器，验「绑 `0.0.0.0` + 局域网 IP 能打开网页 + 首次创号 + cookie 鉴权」 |
| `launcher/` | 备用启动器：`ScreenPlay.cmd` + `launch.mjs`（选空闲端口 → 起内置后端 → Edge `--app` 窗口） |
| `scripts/build-windows.mjs` | Node 侧的编排脚本（`npm run build:win`，`build-windows.ps1` 的等价实现） |
| `src-tauri/` | 外壳本体：`main.rs` / `backend.rs`（启动编排）/ `config.rs` / `tauri.conf.json` / `splash/` |
| `src-tauri/resources/` | **构建产物**：随 exe 分发的运行资源（构建时生成，不进版本库） |
| `dist/` | **构建产物**：安装包、便携包、构建日志 |
| `docs/` | 构建指南、产物说明、功能对齐表 |
| `DESIGN.md` | 契约文档（唯一真相来源） |

---

## 零工具链免安装包（不用 Rust，建议先试这个）

目标机器上没装 Rust / VS 构建工具，或者只是想先把界面跑起来看看时，**不需要编译**：

```bash
# 任意有 Node 20+ 的机器（Windows / Linux / macOS 都行）
cd <项目>/windows
node scripts/prepare-frontend.mjs     # 生成桌面精简版前端 resources/web
node scripts/prepare-backend.mjs      # 下载 node.exe + Windows 生产依赖 + ffmpeg/ffprobe（约 87 MB）
node scripts/make-webapp-bundle.mjs   # → dist/ScreenPlay_1.0.0_x64-webapp.zip（实测 106.89 MiB）
```

把 zip 拷到 Windows 上解压，双击 `ScreenPlay.cmd`：

1. `launch.mjs` 按 `config.json` 里的 `host`（默认 `0.0.0.0`）要一个空闲端口（避免 3000 被占）；
2. Windows 且 `host` 不是回环、`firewall` 不是 `off` 时，先用提权 PowerShell 放行入站 TCP `3210-3309`，
   再拉起后端 —— **先放行、再监听**，系统就不会再弹「允许访问」对话框；
3. 用包内 `resources\node\node.exe` 拉起 `resources\backend\dist\main.js`
   （`DATA_DIR`、`WEB_DIST`、`FFMPEG_PATH`、`HOST`、`AUTH_*` 全部走后端既有环境变量，不重复实现后端逻辑）；
4. 轮询 `GET /api/health` 直到后端就绪，并打印 `http://<本机局域网 IP>:<端口>/`；
5. 用 Edge/Chrome 的 `--app=` 打开**无地址栏窗口**（带独立 `--user-data-dir`，前端本地设置可持久化）；
   关闭窗口时用 `taskkill /T` 回收后端子进程树。

与 Tauri 版的差别只有「壳能力」：没有原生窗口、单实例、托盘、无边框拖拽这些；内置后端、
数据目录、离线能力、界面与交互完全一致。数据默认 `%APPDATA%\ScreenPlay`，可在包根目录放
`config.json` 改（`dataDir` / `port` / `host` / `firewall` / `auth` / `allowSetup` / `mediaDirs` /
`adminPassword`，键名与语义跟 Tauri 版一致）；包根没有再读 `<数据目录>\config.json`。
默认是 `host=0.0.0.0` + `auth=local` + `allowSetup=true`：**同一局域网都能访问，首次打开网页时创建账户**。
后端输出会同时写到 `<数据目录>\launcher.log`，排查启动问题先看它。

> 数据目录也可用环境变量 `DATA_DIR` 覆盖（与后端同名，便于脚本化部署）。
> 本机（Linux）自测方式：`SP_NODE=$(command -v node) SP_NO_BROWSER=1 DATA_DIR=/tmp/sp node launcher/launch.mjs`。

---

## 构建自检（交付前跑）

```bash
cd <项目>/windows
node scripts/verify-desktop.mjs            # 资源完整性 + 体积清单 + 禁带开发依赖 + 品牌图标像素自检 + 1.3.2 默认行为断言（80 项）
node scripts/verify-desktop.mjs --smoke    # 再用本机 node 真启动打包后的后端跑一遍接口（共 91 项）
node scripts/verify-desktop.mjs --exe      # 校验 dist 里的 exe / zip 产物
node scripts/verify-lan.mjs                # 局域网 + 首次创号端到端（20 项；需先跑 prepare-backend.mjs）
```

`--smoke` 会复制 `resources/backend/dist` 到 `windows/.cache/smoke/`，用仓库里的 `node_modules`
与 `backend/scripts/verify/sqlite-shim.js`（本机没有 better-sqlite3 编译产物时的既有约定）启动，
断言 `/api/health`、`/`、`/assets/*`、SPA 深链 `/games/1`、`/api/games`、`/assets/plyr.svg`、
`/favicon.svg`。
**不影响 Windows 产物**，只验证打包后的文件本身是完整可跑的一套。

---

## 一键构建（Windows，出原生 Tauri 版）

### 需要先装好

1. **Node.js 20 或 22 LTS**（<https://nodejs.org/>，勾选 Add to PATH，装完重开窗口）
2. **Rust**（<https://rustup.rs/>，选 `x86_64-pc-windows-msvc`）
3. **Visual Studio 生成工具 / VS 社区版** +「使用 C++ 的桌面开发」工作负载（提供 `link.exe`）
4. **WebView2 运行时**（Win11 自带；Win10 通常随 Edge 自带，缺了程序打不开）

### 然后

双击 `build-windows.cmd`，或在 PowerShell 里：

```powershell
cd <项目>\windows
powershell -NoProfile -ExecutionPolicy Bypass -File .\build-windows.ps1
```

脚本会自检环境、装依赖、准备资源、编译、打包，**任何一步失败都会停下来告诉你原因和日志路径**。
首次约 20–40 分钟（Rust 要全量编译），之后约 3–8 分钟。

常用开关：`-SkipTauri`（只准备资源 + 打便携包）、`-SkipPrepare`（复用上次资源）、`-Pause`（结束时等回车）。
完整说明（含 **Linux 交叉编译** 与网络镜像/代理方案、常见报错对照表）见
[`docs/BUILD-WINDOWS.md`](docs/BUILD-WINDOWS.md)。

> 没有 Windows 机器？Linux 上也能出**真正的 Windows exe 和 NSIS 安装包**：
> `bash scripts/cross/cross-build.sh --portable` 出 exe + 便携 zip，再 `bash scripts/cross/make-setup-cross.sh`
> 出安装包（用 zig 冒充 cc/ar/rc + 4 个垫片，`makensis` 走 Debian 的 Linux 原生版，见
> [`docs/BUILD-WINDOWS.md`](docs/BUILD-WINDOWS.md) §3 与 §3.6）。
> 实测结果：exe **7.09 MiB**（PE32+ x64 GUI，图标/版本/manifest 均在）、便携 zip **约 109 MiB**、
> 安装包 **约 71.5 MiB**（体积与哈希的现场值见 [`docs/ARTIFACTS.md`](docs/ARTIFACTS.md) §5）。

---

## 构建产物在哪

| 产物 | 位置 |
| --- | --- |
| 安装包 | `windows/dist/ScreenPlay_<版本>_x64-setup.exe` |
| 便携包 | `windows/dist/ScreenPlay_<版本>_x64-portable.zip` |
| 零工具链包 | `windows/dist/ScreenPlay_<版本>_x64-webapp.zip`（不用 Rust/编译，解压双击 `ScreenPlay.cmd`） |
| 构建日志 | `windows/dist/build-<时间戳>.log`（UTF-8，记事本可直接看） |

脚本结束时会把每个产物的**绝对路径与大小**打印出来。

---

## 怎么运行

* **安装包**：双击 `ScreenPlay_<版本>_x64-setup.exe`，可自选安装目录（默认装当前用户，一般不用管理员）。
  装完从开始菜单启动。
* **便携包**：解压到任意可写目录（U 盘也行），双击 `ScreenPlay.exe`。
  **不需要**安装 Node.js 或 Rust —— 运行时都随包带上了。

启动时外壳会：显示启动画面 → **先确保防火墙放行**（首次会请求一次管理员授权，见下）→ 拉起内置后端
→ 等 `/api/health` 就绪 → 打开主界面。

默认监听 `0.0.0.0`（局域网可访问，`1.3.2` 起）：同一局域网里的手机、平板、电视盒子用浏览器打开
`http://<这台电脑的局域网 IP>:<端口>` 就能用（启动日志、应用内「设置」与 `<数据目录>\logs\desktop-*.log`
都会打印这个地址）。想改回仅本机：把 `config.json` 的 `"host"` 改成 `"127.0.0.1"`，重启即可。

**首次启动会让你创建账户**：默认 `auth: "local"` + `allowSetup: true`，第一次打开网页时自己填
用户名和密码（不再是「随机密码写进文本文件」那套）。因为默认对局域网开放，鉴权**不再**默认关闭；
若确实要在无鉴权状态下用，就把 `"host"` 改回 `"127.0.0.1"` 并把 `"auth"` 设为 `"off"`。

**防火墙默认放行**（`1.3.2` 起）：首次启动会请求一次管理员授权（UAC），添加一条名为 `ScreenPlay`
的入站放行规则（TCP `3210-3309`），局域网设备访问时既不会被挡住，也不会看到 Windows 自己的
「允许访问」对话框。**拒绝授权不影响使用**（系统会退回它自带的对话框，点「允许」即可）。
只问一次：标记文件在 `<数据目录>\firewall\attempted.txt`，手工重跑脚本在同目录 `allow-screenplay.ps1`。

运行要求（系统版本、WebView2、磁盘/内存占用）见 [`docs/ARTIFACTS.md`](docs/ARTIFACTS.md) §3。

---

## 数据放在哪

| 模式 | 位置 |
| --- | --- |
| 安装版（默认） | `%APPDATA%\ScreenPlay\`（内含 `config.json`、`screenplay.db`、`posters/`、`logs/`、`media/` …） |
| 便携版 | 解压目录下的 `data\`（因为包里带了 `portable.flag`），拷走整个目录即完成迁移 |

卸载**不会**删除数据；备份只需要拷数据目录。细节见 [`docs/ARTIFACTS.md`](docs/ARTIFACTS.md) §4、§6。

常用配置（`config.json`）：换端口、`mode: "external"` 连 NAS 上已有的 ScreenPlay 服务、开启登录鉴权。
见 [`docs/ARTIFACTS.md`](docs/ARTIFACTS.md) §4.3 与 §7。

---

## 遇到问题看哪篇

| 我想知道… | 看这里 |
| --- | --- |
| 每个版本改了什么、为什么这么改 | [`docs/RELEASE-1.3.2.md`](docs/RELEASE-1.3.2.md)（1.3.2：默认局域网访问 + 防火墙默认放行 + 首次创号）、[`docs/RELEASE-1.3.1.md`](docs/RELEASE-1.3.1.md)（1.3.1：三项 Windows 端修复 + 版号分离） |
| 怎么构建、构建失败怎么办 | [`docs/BUILD-WINDOWS.md`](docs/BUILD-WINDOWS.md)（三条路径 + 镜像代理 + 报错对照表） |
| 产物的结构、运行要求、体积、数据目录、升级卸载备份、排障 | [`docs/ARTIFACTS.md`](docs/ARTIFACTS.md) |
| Web 端的功能在桌面端是不是都有、有哪些差异 | [`docs/PARITY.md`](docs/PARITY.md) |
| 外壳内部怎么设计的（启动编排、资源布局、配置项） | [`DESIGN.md`](DESIGN.md) |
| 应用运行日志 | 应用内 `设置页 → 日志`，或 `<数据目录>\logs\desktop-YYYYMMDD.log` |
| 构建日志 | `windows/dist/build-<时间戳>.log`（搜 `[!!]` 找第一处失败） |

---

## 设计说明：为什么 Web / 后端源码一行都不用改

桌面端**不重写**任何界面，也不给后端加接口。做法是复用：

1. **同一份 Web 源码**：桌面端用**桌面模式**构建产物 `web/dist-desktop`（`npm run build:web:desktop`
   = `vite build --mode desktop`），`scripts/prepare-frontend.mjs` 再对它做**构建后处理**（剥离移动端媒体查询、
   把 Plyr 控件图标从 CDN 改成随包的本地图标），产出的仍是同一个前端应用；源码 `web/` 不为桌面端分叉。
   桌面模式与 Web 端只有一处构建期差异：把「修改密码」卡片模块换成空实现（`windows/DESIGN.md` §6、
   `windows/docs/PARITY.md` 差异 ⑦）—— 桌面端默认由用户**首次打开网页时自己创建账户**
   （`config.json` 的 `allowSetup: true`；只有显式关掉它才会退回「生成随机密码写到 `<DATA_DIR>\初始密码.txt`」），
   所以界面上不需要「修改密码」入口。
2. **同一套后端**：直接把 `backend/` 编译产物 + Windows 版生产依赖打进 `resources/`，
   由外壳用它自带的 `node.exe` 启动；`backend/` 源码不动。
3. **同源托管**：后端本来就托管 Web 产物，前端的 API 出口是相对路径 `/api`
   （`web/src/api/client.ts:3,23`），静态托管与 SPA history 回退后端自带
   （`backend/src/main.ts:56-73`），非 API 路径放行也有现成逻辑
   （`backend/src/auth/auth.guard.ts:29`）。外壳只需把窗口指向
   `http://127.0.0.1:<端口>/`，功能就 1:1 成立。

因此「Web 端 → 桌面端」不存在重新实现，也就不存在功能漂移。逐条对齐证据见
[`docs/PARITY.md`](docs/PARITY.md)。

外壳只在**启动时**用环境变量替代两个默认行为（可改回来，代码没有分支）：
`AUTH_MODE` 默认关闭（本机单人应用，想开就在 `config.json` 里改 `"auth": "local"` 或 `"system"`）、
`MAINTENANCE_ON_BOOT=0`（启动更快，扫描从设置页手动触发）。

---

## 维护者须知

* 本目录所有文件**必须 UTF-8**；`build-windows.ps1` 必须能被 **Windows PowerShell 5.1** 直接跑
  （不要用 pwsh 7 专有语法，如 `&&`、`||`、`??`、三元 `?:`）。
* 构建产物目录（`dist/`、`src-tauri/resources/`、`src-tauri/target/`、`.cache/`、`node_modules/`）
  已在 `.gitignore` 中忽略，不要提交。
* 改动外壳行为时，先改 [`DESIGN.md`](DESIGN.md)（契约），再改代码与文档。