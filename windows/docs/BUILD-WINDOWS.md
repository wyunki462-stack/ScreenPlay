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
| ③ Linux 交叉编译 | 只有 Linux 机器 | 可选（**已实测跑通**） | 30–60 分钟（Rust 全量编译）+ 约 15 分钟（打安装包） | `ScreenPlay_<ver>_x64-setup.exe` + `ScreenPlay_<ver>_x64-portable.zip`（另出 `ScreenPlay.exe`） |

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

# ② 前端精简：由 web/dist-desktop 生成 resources\web\
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

## 3. 路径三：Linux 交叉编译（**已实测跑通**，产出 exe + 便携 zip + NSIS 安装包）

> **结论先说**：在无 root、`HOME` 不可写、没有任何系统 C 编译器的 Linux 上，本仓库**已经用它编译出
> 真正的 Windows x64 GUI 可执行文件**，并打出免安装包（体积见 §3.3.2）与 NSIS 安装包（配方见 §3.6）。
>
> 一键脚本：`windows/scripts/cross/cross-build.sh`（4 个垫片 + 1 个 LD_PRELOAD 修丁，见 §3.3.1）；
> 安装包另跑 `windows/scripts/cross/make-setup-cross.sh`（见 §3.6）。

### 3.1 前置条件

```bash
rustup target add x86_64-pc-windows-msvc
cargo install cargo-xwin --locked        # 负责下载 MSVC CRT/SDK 头文件与库
zig version                              # 需要 zig 0.13+：同时充当 cc / ar / rc
```

### 3.2 准备前端与后端资源（平台无关，Linux 上照跑）

```bash
cd <项目>/windows
npm install --ignore-scripts --no-audit --no-fund
npm run prepare:frontend      # 由 web/dist-desktop 生成 resources/web/
npm run prepare:backend       # 下载 Windows 版 node.exe / ffmpeg / ffprobe / better-sqlite3 预编译包
```

已在本机（Linux）**实测可达**的下载源（走代理更快，但直连也可）：

| 资源 | 来源 | 实测 |
| --- | --- | --- |
| `node.exe`（v22.20.0 win-x64） | npmmirror 镜像 | ✅ 可达 |
| `ffmpeg.exe` + `ffprobe.exe` | GitHub release（302 跳转） | ✅ 可达 |
| `better-sqlite3` 预编译包 | npmmirror / GitHub release | ✅ 可达 |
| MSVC CRT / Windows SDK | cargo-xwin 内置下载（`aka.ms`） | ✅ 可达（约 630 MB，1m13s） |
| **NSIS 打包器** | Debian `nsis` 3.08 的 `makensis`（`deb.debian.org`）+ 3.11 包里的 `Include/Win/RestartManager.nsh` | ✅ 直连可达（两个 deb 共约 1.7 MB；见 §3.6） |

### 3.3 交叉编译 exe（一条命令）

```bash
cd <项目>/windows
bash scripts/cross/cross-build.sh            # 只出 exe
bash scripts/cross/cross-build.sh --portable # 出 exe 并顺手打便携 zip
```

脚本做的事：检查工具 → 编译 `fixmode.so` → `rm -rf src-tauri/gen` → `cargo-xwin build --release --locked
--target x86_64-pc-windows-msvc -j 2` → 用 python3 校验 PE（machine/subsystem/资源目录）→ 拷到
`windows/dist/ScreenPlay.exe`（`--portable` 时再跑 `npm run portable:win`）。

可用环境变量（都有默认值）：`SP_WORK`（默认 `/tmp/sp-cross`，**必须放在可写盘**）、`SP_CARGO_HOME` /
`SP_RUSTUP_HOME`、`SP_ZIG`、`SP_JOBS`（默认 2）、`SP_LTO`（默认 `false`，省内存）、`SP_FIXMODE`（默认 1）。

#### 3.3.1 为什么需要那 4 个垫片（`windows/scripts/cross/`）

| 垫片 | 解决什么 | 关键细节 |
| --- | --- | --- |
| `cc.sh` | zig 当主机 C 编译器 | cc-rs 传的是 Rust 三元组 `--target=x86_64-pc-windows-msvc`，zig 只认 `x86_64-windows-msvc`，必须逐参数翻译 |
| `ar.sh` | 静态库打包 | `zig ar` |
| `llvm-rc.sh` | **本机没有 `llvm-rc`**，`tauri-winres 0.3.6` 的 `embed_resource::compile()` 会 panic：`NotAttempted("llvm-rc")` | 伪装成 llvm-rc：探测时打印 `OVERVIEW: LLVM Resource Converter` + `no-preprocess`，编译时把参数转给 `zig rc`（只认小写 `/c`；`/no-preprocess` 会被它当 `/n`+残留字符解析而报 `<cli>: error: invalid option: /o-preprocess`，必须吃掉） |
| `clang-cl.sh` | **cargo-xwin 自己把 `CC_x86_64_pc_windows_msvc` 设成 `clang-cl`**（shell 里 export 的 CC 被覆盖），而本机没有 LLVM | `embed-resource` 要用 cc crate 预处理 `.rc` 并**捕获 stdout**；垫片把 `/imsvc`→`-isystem`、`/I /D /U`→`-I/-D/-U`、丢掉 `-Xclang`+下一参数与 MSVC 专有开关，再 `cc.sh -E -x c` |
| `fixmode.c` | 本机文件系统怪癖：**进程新建的文件权限是 `000`**，于是 build script 写出的 `acl-manifests.json`、`capabilities.json`、`gen/schemas/*.json` 在同一/下一轮构建里读不回来（`Permission denied (os error 13)`） | LD_PRELOAD 拦截 open 系列：创建成功后 `fchmod(fd,0666)`；遇 EACCES 先 `chmod 0666` 再重试一次。构建前还需 `rm -rf src-tauri/gen`（旧 schema 也是 `000`） |

> 资源文件这条链路是通的：`zig rc` 输出 **RES 格式（不是 COFF）**，但 `lld-link` 按内容识别 `.res`
> 可直接链接（实测），所以 `embed-resource` 的 `cargo:rustc-link-arg-bins=<out>` 依然成立。

#### 3.3.2 本机实测结果

| 项目 | 实测值 |
| --- | --- |
| 构建命令 | `cargo-xwin build --release --locked --target x86_64-pc-windows-msvc -j 2` |
| 编译耗时 | `Finished 'release' profile [optimized] target(s) in 39.93s`（依赖已编译完时约 37 s） |
| 产物 | `screenplay.exe` = **7,436,288 B = 7.09 MiB**（1.3.2 源码） |
| PE 校验 | `machine=0x8664`(x64)、PE32+、**`subsystem=2`(GUI，不弹控制台)**、8 节、资源目录 10,368 B |
| 资源内容 | `[3] ICON 7809 B`、`[14] GROUP_ICON 20 B`、`[16] VERSION 488 B`、`[24] MANIFEST 334 B`（**图标/版本信息/manifest 全都在**） |
| 告警 | 只有 `LNK4099`（CRT 库的 PDB 引用缺失），无害 |
| 便携包 | `dist/ScreenPlay_1.0.0_x64-portable.zip` = **114,278,175 B = 108.98 MiB**（11,417 条目，staging 309.94 MiB） |
| 便携包（1.3.2） | `dist/ScreenPlay_1.3.2_x64-portable.zip` = **114,388,270 B = 109.09 MiB**（11,427 条目，staging 310.25 MiB） |
| NSIS 安装包（1.3.2） | `dist/ScreenPlay_1.3.2_x64-setup.exe` = **74,983,691 B ≈ 71.51 MiB**（§3.6 流程，makensis 3.08 + LZMA 固实，sha256 `97127edf…`） |

### 3.4 已知阻塞点（踩坑清单）

1. **NSIS 安装包不需要 wine**：`tauri` 官方那条路会去下 `nsis-3.11.zip` 再跑 `makensis.exe`（那才需要
   wine），而本机直连该 GitHub 地址返回 `http=000`。改成 **Debian 的 Linux 原生 `makensis`（3.08）
   + `tauri bundle --bundles nsis`**，安装包可以完全在 Linux 上生成——配方与两个坑
   （`NSISDIR`、缺 `RestartManager.nsh`）见 §3.6。
2. **需要 MSVC CRT / Windows SDK**：`cargo-xwin` 会自行下载（实测 `⏬ Downloading MSVC CRT...`
   后 1m13s 完成，约 630 MB，落在 `XWIN_CACHE_DIR`），直连可达、不需要代理；但它不给 `link.exe`
   ——链接由 rustc 自带的 `lld-link` 完成。
3. **`cargo-xwin` 版本漂移**：Tauri v2 的 `build.rs`/`tauri-winres` 行为随版本变化，交叉编译属于
   「尽力而为」，官方不承诺支持；本仓库已把可用组合（tauri 2.12.1 + cargo-xwin 0.23.1 + zig 0.13.0）钉住。
4. **构建目录必须可写、且新文件要有写权限**：在共享盘/网络盘（新文件默认 `000`）上直接在仓库里编译，
   rustc 会在写目标文件时报
   `error: output file .../target/release/deps/unicode_ident-*.rcgu.o is not writeable -- check its permissions`。
   → `CARGO_TARGET_DIR` 挪到本机盘（`cross-build.sh` 默认 `/tmp/sp-cross/target`）。
5. **crates.io 直连会限速或偶发挂起**：实测 `static.crates.io` 只有 ~100 KB/s 且会中途卡住。缓解：
   ① `CARGO_HTTP_MULTIPLEXING=false CARGO_HTTP_TIMEOUT=60 CARGO_NET_RETRY=10`；
   ② 先用镜像并行预取 `Cargo.lock` 里缺的 crate 到缓存，再让 cargo 跑（命缓存即不再下载）：
   ```bash
   CACHE=$(ls -d $CARGO_HOME/registry/cache/index.crates.io-* | head -1)
   xargs -P 6 -n 2 sh -c \
     'curl -sS -L --retry 3 --max-time 120 -o '"$CACHE"'/$0-$1.crate \
        https://rsproxy.cn/api/v1/crates/$0/$1/download' < 缺失列表
   ```
   实测 `rsproxy.cn` 约 370 KB/s。**只预取文件、不改 `[source]` 替换**最省事（换源会让 cargo 重下整棵树）。
6. **`--offline` 首次构建不可用**：稀疏索引缓存里没有 tauri 的 Linux 目标依赖，会报
   `error: no matching package named 'gtk' found`。首次构建必须联网更新索引。
7. **`cargo` 不一定在 `CARGO_HOME/bin` 里**：rustup 安装的 `cargo`/`rustc` 在
   `RUSTUP_HOME/toolchains/<toolchain>/bin`，`cargo-xwin` 才在 `CARGO_HOME/bin`。两个目录都要进 `PATH`
   （`cross-build.sh` 已自动处理）。

### 3.5 在 Linux 上手工组装便携包（可选）

`cross-build.sh --portable` 已经会自动完成，手工做的话就是：把 `windows/src-tauri/resources/` 整目录拷进
一个目录，再把 exe 放同级，加两个标记文件：

```
ScreenPlay_1.0.0_x64-portable/
├── ScreenPlay.exe
├── portable.flag                 # 存在即启用便携模式：DATA_DIR = <exeDir>\data
├── 使用说明.txt
└── resources/{node,backend,web,bin,build-info.json}
```

> 便携包的体积预期见 `windows/docs/ARTIFACTS.md`。

### 3.6 在 Linux 上打 NSIS 安装包（`make-setup-cross.sh`）

```bash
cd <项目>/windows
bash scripts/cross/make-setup-cross.sh
# → windows/dist/ScreenPlay_<ver>_x64-setup.exe
```

脚本做的事：校验 `resources/` 与 `cross-build.sh` 已编好的 exe → 准备 `makensis`（缺则自动从
`deb.debian.org` 下载两个 deb 并解包）→ 跑 `npx tauri bundle --target x86_64-pc-windows-msvc
--bundles nsis` → 校验 PE（32 位引导程序 + GUI 子系统）→ 拷进 `windows/dist/`。

要点（都是踩过的坑）：

| 坑 | 现象 | 处理 |
| --- | --- | --- |
| 习惯性用 `tauri build` | `failed to run 'cargo metadata' ... No such file or directory` | 只跑 `tauri bundle`（bundle 阶段仍要宿主 `cargo` 在 `PATH` 上，但不再编译 Rust） |
| `makensis` 找不到自己的库 | `Error: reading stub "/usr/share/nsis/Stubs/zlib-x86-unicode"` | Debian 的 `makensis` 内建默认路径写死 `/usr/share/nsis`；用包装脚本 `export NSISDIR=<解包目录>/usr/share/nsis` 再 `exec` |
| 下载 NSIS 插件 dll 报 `Permission denied (os error 13)` | 本共享盘把新文件建成 `000` | `LD_PRELOAD` `fixmode.so`（`cross-build.sh` 编的那个）+ 把 `HOME`/`XDG_CACHE_HOME` 指到可写盘（脚本默认 `/tmp/sp-home`、`/tmp/sp-cache`） |
| `!include: could not find: "Win\RestartManager.nsh"`（`installer.nsi` 第 27 行） | Debian 的 `nsis-common` 3.08 在 `Include/Win/` 里少了这个文件 | 从 3.11 的 `nsis-common` 包里取出来放进 `Include/Win/`（脚本自动做） |
| 想用更新版 `makensis` | 3.11 的 Debian 包要 GLIBC 2.38（glibc 2.36 的机器跑不了） | 钉 3.08：`v3.08-3+deb12u1` |

预期耗时：`makensis` 要对约 300 MiB 的 `resources/` 做 LZMA 固实压缩，本机实测 **约 15 分钟**；
安装包体积见 `windows/docs/ARTIFACTS.md` §5。

> 安装包是 `installMode=currentUser`（默认装当前用户，可自选目录，一般不需要管理员权限），并按需下载
> WebView2 常青版运行时引导程序。

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
| `卡在下载 nsis-3.11.zip` | GitHub binary-releases 不可达（本机实测 `http=000`） | 在 Linux 上改用 §3.6 的原生 `makensis`；Windows 上设置系统代理后重试，或只做便携包（见 §3.4、§4.2） |
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