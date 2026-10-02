# ScreenPlay Windows 桌面端 · 构建指南

本文档说明如何把 ScreenPlay 构建成 Windows 桌面应用（安装包 + 便携包），给三条路径、耗时预期、
网络受限时的替代方案，以及常见报错的对照表。

> 契约文档：`windows/DESIGN.md`（目录职责、`resources/` 布局、启动编排、`config.json`、数据目录、产物）。
> 产物说明与运行要求：`windows/docs/ARTIFACTS.md`。功能对齐表：`windows/docs/PARITY.md`。

---

## 0. 三条路径速览

| 路径 | 适用场景 | 推荐度 | 首次耗时 | 产物 |
| --- | --- | --- | --- | --- |
| ① Windows 本机一键构建 | 手边有 Windows 机器或虚拟机 | **推荐** | 20–40 分钟（含 Rust 全量编译） | `ScreenPlay_<ver>_x64-setup.exe` + `ScreenPlay_<ver>_x64-portable.zip` |
| ② Windows 手动分步 | 想逐步看产出、排错 | 可选 | 与①相同，但可控 | 同① |
| ③ Linux 交叉编译尝试 | 只有 Linux 机器 | 兜底 | 30–60 分钟，且**大概率卡在最后一步** | **只出便携 zip**（NSIS 安装包生成不了） |

三条路径都需要联网。`windows/` 下的所有脚本都**不修改** `web/` 与 `backend/` 的源码，
只是在构建期生成 `windows/src-tauri/resources/` 与 `windows/dist/`。

---

## 1. 路径一：Windows 本机一键构建（推荐）

### 1.1 前置条件

| 依赖 | 版本要求 | 说明 |
| --- | --- | --- |
| Windows | 10 1809+ / 11，x64 | 构建机与运行机都适用 |
| Node.js | **20 或 22 LTS**（≥ 20） | 安装时勾选 “Add to PATH”，装完**重开**命令行窗口 |
| Rust | rustup，MSVC 工具链 | <https://rustup.rs/>，安装时选 `x86_64-pc-windows-msvc` |
| Visual Studio | 生成工具（或 VS 社区版）+「使用 C++ 的桌面开发」工作负载 | 提供 `link.exe`；只装 VS Code **不够** |
| WebView2 运行时 | 常青版 | Win11 自带；Win10 多数已随 Edge 自带；缺失则程序打不开 |
| 磁盘 | 建议 ≥ 15 GB 可用 | Rust 的 `target/` 会吃掉 3–6 GB |
| ffmpeg / ffprobe | 可选 | **不阻塞构建**：`prepare:backend` 会自带一份放进 `resources/bin/` |

检查命令（在 PowerShell 里）：

```powershell
node -v          # 需 >= v20
npm -v
rustc -V
cargo -V
```

WebView2 缺失时：<https://developer.microsoft.com/microsoft-edge/webview2/>
（常青版引导程序直连：<https://go.microsoft.com/fwlink/p/?LinkId=2124703>）

### 1.2 一键构建

双击 `windows\build-windows.cmd`，或在 Windows PowerShell 里执行：

```powershell
cd <项目>\windows
powershell -NoProfile -ExecutionPolicy Bypass -File .\build-windows.ps1
```

脚本会依次做：

1. **环境自检（preflight）**——Node ≥ 20、npm、rustc/cargo、`@tauri-apps/cli`、WebView2、ffmpeg（可选）、磁盘空间；
2. `npm install --ignore-scripts`（仅当 `windows\node_modules` 缺失）；
3. `npm run prepare`（= `prepare:frontend` 前端精简 + `prepare:backend` 后端组装）；
4. `npx tauri build`（Rust 编译 + NSIS 打包）；
5. `npm run portable:win`（生成便携 zip）。

每一步的中文进度与子进程原始输出都会**同时**写到屏幕和
`windows\dist\build-<yyyyMMdd-HHmmss>.log`。任何一步失败立即停止，打印
「失败步骤 + 原始错误 + 日志路径 + 排查建议」并以非 0 退出码结束；结束时打印所有产物的**绝对路径与大小**。

> 为什么是 `npm install --ignore-scripts`？npm 会在 `npm install` 时自动执行**名为 `prepare` 的生命周期脚本**，
> 那会把真正的准备流程跑两遍、且失败会连带 install 一起失败。脚本显式跳过它，
> 由第 3 步单独调用 `npm run prepare`。

### 1.3 耗时预期（16 核 / 32 GB 级别的机器）

| 步骤 | 首次 | 之后（增量） |
| --- | --- | --- |
| preflight | 数秒 | 数秒 |
| `npm install`（仅 Tauri CLI，纯 JS 包） | 10–40 秒 | 跳过 |
| `prepare:frontend`（复制 + 文本处理 web 产物） | 5–20 秒 | 5–20 秒 |
| `prepare:backend`（下载 node.exe/ffmpeg/Windows 版 node_modules） | **3–10 分钟**（取决于带宽） | 30 秒–2 分钟（有缓存时跳过下载） |
| `npx tauri build` | **5–20 分钟**（首次要把几百个 crate 编完） | 1–3 分钟 |
| `portable:win`（压缩 ~320–350 MB 资源） | 1–3 分钟 | 1–3 分钟 |
| **合计** | **约 20–40 分钟** | **约 3–8 分钟** |

### 1.4 参数速查（`build-windows.ps1`）

| 参数 | 作用 |
| --- | --- |
| `-SkipInstall` | 跳过 `npm install`（适用于已经装好、且离线） |
| `-SkipPrepare` | 跳过 `npm run prepare`（复用上次生成的 `resources/`） |
| `-SkipTauri` | 跳过 `npx tauri build`，**只做准备阶段 + 便携包打包**（需要已存在 `ScreenPlay.exe`） |
| `-SkipPortable` | 跳过 `npm run portable:win`，只要 NSIS 安装包 |
| `-Pause` | 结束时等回车（直接双击 `.ps1` 时有用；`.cmd` 入口自带 `pause`） |

---

## 2. 路径二：Windows 手动分步

适合排错：每一步都能单独看到产物落在哪。

```powershell
cd <项目>\windows

# ① 安装构建依赖（只装 @tauri-apps/cli）
npm install --ignore-scripts --no-audit --no-fund
#    产物：windows\node_modules\@tauri-apps\cli\  （及 napi 平台包 @tauri-apps\cli-win32-x64-msvc）

# ② 前端精简：由 web/dist 生成 resources\web\
npm run prepare:frontend
#    产物：windows\src-tauri\resources\web\index.html + web\assets\**

# ③ 后端组装：拉 Windows 版 node/node_modules/ffmpeg，编译后端
npm run prepare:backend
#    产物：windows\src-tauri\resources\{node\node.exe, backend\dist\**, backend\node_modules\**,
#         backend\package.json, bin\{ffmpeg.exe,ffprobe.exe}, build-info.json}
#    缓存：windows\.cache\backend-pkg\ 与 windows\.cache\npm\（可删，删了就要重新下载）

# ④ 编译 + 打包安装包
npx tauri build
#    产物：windows\src-tauri\target\release\ScreenPlay.exe
#         windows\src-tauri\target\release\bundle\nsis\ScreenPlay_<ver>_x64-setup.exe

# ⑤ 组装便携包
npm run portable:win
#    产物：windows\dist\ScreenPlay_<ver>_x64-portable.zip
```

也可以把 ②③ 合成一步：`npm run prepare`。

`build-windows.ps1` / `build-windows.cmd` 只是把上面这五步按顺序跑一遍，加上日志、自检和错误处理。

---

## 3. 路径三：Linux 交叉编译尝试（**只出便携 zip**）

> ⚠️ **先看结论**：这条路径只可能产出**便携 zip**。NSIS 安装包必须在 Windows 上生成。
> 已知阻塞点见 3.4，遇到就按 3.5 处理或直接放弃安装包、只发便携包。

### 3.1 准备 Rust 与 Windows target

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustup target add x86_64-pc-windows-msvc
cargo install cargo-xwin          # 提供 MSVC 交叉编译所需的头文件/SDK 下载
```

### 3.2 准备前端与后端资源（平台无关，Linux 上照跑）

```bash
cd <项目>/windows
npm install --ignore-scripts --no-audit --no-fund
npm run prepare:frontend
npm run prepare:backend     # 这一步会下载 Windows 版 node.exe / ffmpeg / better-sqlite3 预编译包
```

已在本机（Linux）**实测可达**的下载源（走代理时更快，但直连也可）：

| 资源 | 来源 | 实测 |
| --- | --- | --- |
| `node.exe`（v22.20.0 win-x64） | npmmirror 镜像 / nodejs.org | ✅ 可达 |
| `ffmpeg.exe` + `ffprobe.exe` | GitHub release（302 跳转） | ✅ 可达 |
| `better-sqlite3` 预编译包 | GitHub release（ABI 127 / win32-x64） | ✅ 可达（测试脚本另用 `npm pack` 走 npmmirror） |
| **NSIS 打包器** | `github.com/tauri-apps/binary-releases/.../nsis-3.11.zip` | ❌ **直连 `http=000`，必须走代理** |

### 3.3 交叉编译 exe

```bash
cd src-tauri
cargo xwin build --release --target x86_64-pc-windows-msvc
# 产物：src-tauri/target/x86_64-pc-windows-msvc/release/ScreenPlay.exe
```

### 3.4 已知阻塞点（踩坑清单）

1. **NSIS 安装包做不出来**：`tauri build` 在 Windows 之外的平台要下载 NSIS 打包器，
   而该下载源 `https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip`
   **在本机直连返回 `http=000`（拿不到任何响应）**，加代理后可用：
   `curl -x http://127.0.0.1:7890 -L -o nsis-3.11.zip <上面的 URL>`。
   → 所以：**Linux 交叉编译只做便携 zip，NSIS 安装包请在 Windows 上生成。**
2. **需要 MSVC CRT / Windows SDK 头文件与库**：`cargo xwin` 会自行下载（数百 MB），
   但它不会给你 `link.exe`；若上游改动导致 `xwin` 拉不到 SDK，需要手动提供或改用 `cargo-zigbuild`。
3. **打包期资源编译**：`tauri-winres` / `embed-resource` 通常需要 `llvm-rc` 或 `windres`
   （`apt install llvm` 或 `apt install binutils-mingw-w64-x86-64`）。缺了会在 `build.rs` 阶段报错。
4. **`cargo-xwin` 版本漂移**：Tauri v2 的 `build.rs` 行为随版本变化，交叉编译属于「尽力而为」，
   官方不承诺支持。

### 3.5 在 Linux 上手工组装便携包

交叉编译出 `ScreenPlay.exe` 后，便携包结构就是「一个目录 + 两个标记文件」，可以手工组装：

```
ScreenPlay_<ver>_x64-portable/
├── ScreenPlay.exe
├── portable.flag                 # 存在即启用便携模式：DATA_DIR = <exeDir>\data
├── 使用说明.txt
└── resources/
    ├── node/node.exe
    ├── backend/{dist,node_modules,package.json}
    ├── web/{index.html,assets/**}
    ├── bin/{ffmpeg.exe,ffprobe.exe}
    └── build-info.json
```

即：把 `windows/src-tauri/resources/` 整目录拷进去，再把交叉编译出来的 `ScreenPlay.exe` 放到同级。
`npm run portable:win` 做的就是这件事（外加压缩），但它期望的是 Windows 路径下的
`src-tauri/target/release/ScreenPlay.exe`——交叉编译时路径不同，所以走这条路要手工拷。

> 便携包的体积预期见 `windows/docs/ARTIFACTS.md`。

---

## 4. 网络受限：镜像与代理

### 4.1 npm

```bash
# 单次
npm install --registry=https://registry.npmmirror.com

# 或写入用户配置（长期）
npm config set registry https://registry.npmmirror.com
```

`prepare:backend.mjs` 内部装 Windows 版生产依赖时已经固定使用 `registry.npmmirror.com`，
并且把 npm 缓存指向 `windows/.cache/npm`，不会污染全局缓存。

腾讯云镜像备选：`https://mirrors.tencent.com/npm/`。

### 4.2 GitHub 资源（node.exe / ffmpeg / better-sqlite3 / NSIS）

本机实测：**node.exe、ffmpeg、ffprobe、better-sqlite3 预编译包都可达（GitHub release 会 302 跳转）；
只有 NSIS 打包器直连是 `http=000`。**

若你那边 GitHub 整体不通：

```bash
# 用本地代理拉取（示例端口 7890，按你自己的代理端口改）
curl -x http://127.0.0.1:7890 -L -o out.zip https://github.com/<owner>/<repo>/releases/download/<tag>/<file>
```

Windows 上如果 `tauri build` 卡在下载 NSIS（日志里能看到 `nsis-3.11.zip`）：

* **可执行的做法**：在系统设置里配置系统代理（设置 → 网络和 Internet → 代理），
  或者改用便携包方案（`-SkipPortable` 反过来用：只跑 `npm run portable:win`，不生成安装包）。
* 关于「让 tauri/cargo 专门读某个环境变量来走代理」的写法（例如自签 `${env:HTTPS_PROXY}` 之类），
  **未在本机验证**，因此本文档不给出具体变量名与写法，避免误导；请优先使用「设置系统代理」或「只用便携包」。

### 4.3 cargo / crates.io

```bash
# 写入 ~/.cargo/config.toml
[source.crates-io]
replace-with = 'ustc'
[source.ustc]
registry = "sparse+https://mirrors.ustc.edu.cn/crates.io-index/"
```

---

## 5. 常见报错对照表

| 现象 / 报错片段 | 原因 | 处理 |
| --- | --- | --- |
| `未检测到 Microsoft Edge WebView2 运行时`（preflight 报的） | 运行机/构建机没装 WebView2 | 装常青版运行时（链接见 1.1）。Win11 与较新的 Win10 一般自带 |
| 程序安装成功但**双击打不开 / 白屏** | 缺 WebView2；或后端进程起不来 | 先装 WebView2；再看 `<DATA_DIR>\logs\desktop-YYYYMMDD.log` 与 `设置页 → 日志` |
| `error: linker 'link.exe' not found` / `LINK : fatal error` | 缺 MSVC 链接器 | 装 Visual Studio 生成工具 +「使用 C++ 的桌面开发」工作负载，重开命令行 |
| `note: rustc ... requires the MSVC toolchain` | rustup 装的是 GNU 工具链 | `rustup default stable-x86_64-pc-windows-msvc` |
| 下载失败：`ECONNRESET` / `ETIMEDOUT` / `getaddrinfo` | 网络受限 | 见 §4（npm 换镜像、GitHub 走代理） |
| `卡在下载 nsis-3.11.zip` | GitHub binary-releases 不可达（本机实测 `http=000`） | 设置系统代理后重试；或只做便携包（见 §3.4、§4.2） |
| `EADDRINUSE` / 端口被占用 | 配置端口被别的程序占了 | 改 `config.json` 的 `port`（或置 0 让壳自动探测）；见 ARTIFACTS 排障 |
| `better-sqlite3` 编译/加载失败（`NODE_MODULE_VERSION` 不匹配） | 拉到了错 ABI 的预编译包，或混进了 Linux 版 `.node` | 删 `windows/.cache/backend-pkg` 与 `resources/backend/node_modules` 重跑 `prepare:backend`（应取 ABI 127 / win32-x64） |
| `grep -c "cdn.plyr.io" resources/web -r` 不为 0 | 前端精简没生效 | 重跑 `npm run prepare:frontend`；确认产物 JS 已被改写为本地 `assets/plyr.svg` |
| `usage: git` / 找不到资源目录 | 在错的目录执行 | 脚本都以 `$PSScriptRoot`（`windows\`）为根，请在 `windows\` 下执行 |
| 中文在提示符里乱码 | 控制台代码页不是 UTF-8 | 脚本已 `chcp 65001` 并设 `$OutputEncoding`；手工调试时自己执行 `chcp 65001` |

---

## 6. 日志与产物位置

| 内容 | 路径 |
| --- | --- |
| 构建日志 | `windows\dist\build-<yyyyMMdd-HHmmss>.log`（UTF-8 带 BOM，记事本可直接打开） |
| 安装包 | `windows\dist\ScreenPlay_<ver>_x64-setup.exe`，同时也留在 `src-tauri\target\release\bundle\nsis\` |
| 便携包 | `windows\dist\ScreenPlay_<ver>_x64-portable.zip` |
| 中间产物 | `windows\src-tauri\resources\`、`windows\src-tauri\target\`（可整体删除以释放空间） |
| 下载缓存 | `windows\.cache\`（删除后下次构建会重新下载） |
| 运行日志 | `<DATA_DIR>\logs\desktop-YYYYMMDD.log`，也可在应用内 `设置页 → 日志` 查看 |

排错顺序建议：**日志里搜 `[!!]` → 搜 `error` / `ERROR` → 看第一处失败**，然后对照 §5。

---

## 7. 相关文档

* `windows/README.md` —— 目录总览与快速上手
* `windows/docs/ARTIFACTS.md` —— 产物清单、`resources/` 结构、运行要求、数据目录、体积与排障
* `windows/docs/PARITY.md` —— Web 端功能 → 桌面端实现方式 → 验收证据
* `windows/DESIGN.md` —— 唯一契约文档（架构、目录、启动编排、配置、数据目录、硬约束）
* 仓库根 `README.md`、`docs/VERIFY.md` —— 项目定位与验收套件