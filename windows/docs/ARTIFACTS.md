# ScreenPlay Windows 桌面端 · 产物说明与运行要求

本文档说明构建产物是什么、装在哪、运行时需要什么、数据放在哪、多大，以及出问题时怎么查。
构建方法见 `windows/docs/BUILD-WINDOWS.md`；功能对齐见 `windows/docs/PARITY.md`。

---

## 1. 产物清单

| 产物 | 文件名 | 位置 | 说明 |
| --- | --- | --- | --- |
| **安装包** | `ScreenPlay_<version>_x64-setup.exe` | `windows/dist/`（同时留在 `windows/src-tauri/target/release/bundle/nsis/`） | Tauri NSIS 安装程序，`perMachine=false`：默认装到当前用户目录，**可自选安装路径**，一般不需要管理员权限 |
| **便携包** | `ScreenPlay_<version>_x64-portable.zip` | `windows/dist/` | 解压即用，不写注册表；含 `portable.flag`，数据默认落在解压目录旁的 `data\` |
| 可执行文件 | `ScreenPlay.exe` | `windows/src-tauri/target/release/`（便携包内为根目录） | 桌面壳（Rust + Tauri v2） |
| 随包资源 | `resources/` | 安装包内随 `ScreenPlay.exe` 分发；便携包内是同名子目录 | 见 §2 |
| 构建日志 | `build-<yyyyMMdd-HHmmss>.log` | `windows/dist/` | 一次构建一份 |

`<version>` 与项目版号一致（例如 `1.0.0`），来自构建时的 `package.json` / `Cargo.toml`。

**两个产物都不包含**：Playwright 与测试依赖、Web 端的 `node_modules`、TypeScript 源码与编译器、
Rust 源码与 `target/`。用户机器上**不需要**安装 Node.js、Rust 或任何开发工具。

---

## 2. 便携包目录结构 与 `resources/` 内部结构

### 2.1 便携包

```
ScreenPlay_<version>_x64-portable/
├── ScreenPlay.exe              # 桌面壳
├── portable.flag               # 便携模式标记（存在即启用，见 §4）
├── 使用说明.txt                # 面向用户的三行说明
└── resources/                  # 随包分发的运行时资源（§2.2）
```

### 2.2 `resources/` 布局（安装包与便携包一致，定义见 `windows/DESIGN.md` §4）

| 子项 | 内容 | 用途 |
| --- | --- | --- |
| `node/node.exe` | Node.js Windows x64 单文件运行时（v22.20.0） | 启动内置后端；用户机器无需装 Node |
| `backend/dist/**` | 编译后的 NestJS 后端 JS | 后端主程序 |
| `backend/node_modules/**` | **Windows** 生产依赖（`--omit=dev --include=optional --os=win32 --cpu=x64`） | 含 `better-sqlite3` 预编译 `.node`、`@img/sharp-win32-x64`、`sharp` |
| `backend/package.json` | 后端清单副本 | 供运行时与诊断用 |
| `web/index.html` + `web/assets/**` | **桌面精简版** Web 产物（后端同源托管） | 主界面；已替换 Plyr 图标为本地 `assets/plyr.svg`、剥离移动端媒体查询 |
| `bin/ffmpeg.exe`、`bin/ffprobe.exe` | 静态版 ffmpeg 工具 | 视频缩略图 / 时长解析；`PATH` 会前置该目录 |
| `build-info.json` | `{version, sourceHash, builtAt, nodeVersion}` | 构建溯源；出问题时报给维护者 |

---

## 3. 运行要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | **Windows 10 1809（build 17763）及以上，或 Windows 11，x64** |
| WebView2 运行时 | 必需。Win11 与较新的 Win10 随 Microsoft Edge 自带；缺失时程序无法显示界面，装常青版运行时：<https://developer.microsoft.com/microsoft-edge/webview2/>（直连 <https://go.microsoft.com/fwlink/p/?LinkId=2124703>） |
| Node.js | **不需要**（已随包分发 `node.exe`） |
| Rust / 编译工具 | **不需要** |
| 其他运行库 | 无（SQLite 与图像处理均已静态打包进 `resources/`） |
| 磁盘占用 | 安装包：见 §5；安装后展开约 320–350 MB（主要为 `node.exe`、`node_modules`、`ffmpeg`）；数据库与缩略图会随媒体库增长 |
| 内存占用 | 主进程（WebView2）+ 后端 Node 进程，空闲约 200–400 MB，扫描/转码时更高 |
| 端口 | 默认从 **3210** 起自动探测空闲端口，仅监听 `127.0.0.1`（`embedded` 模式）；端口冲突时壳会自动换端口 |
| 网络 | 仅在使用联网元数据源 / 下载代理媒体时需要 |

---

## 4. 数据目录与便携模式（对应 `windows/DESIGN.md` §8）

### 4.1 默认（安装版）

```
%APPDATA%\ScreenPlay\                 <- 即 Tauri 的 app_data_dir，记作 <DATA_DIR>
├── config.json                       # 壳的配置（§4.3）
├── screenplay.db                     # 数据库（含 WAL 等附属文件）
├── posters/                          # 用户上传/选择的游戏海报
├── proxied/                          # 代理缓存下来的第三方媒体
├── thumbnails/                       # 缩略图缓存
├── logs/                             # desktop-YYYYMMDD.log
└── media/                            # 默认媒体库目录（可在设置页改/加）
```

* 配置项 `MEDIA_DIRS` 默认指向 `<DATA_DIR>\media`；可在设置页把媒体库指到 NAS 上的共享目录。
* 卸载应用**不会**删除 `%APPDATA%\ScreenPlay\`（用户数据保留）。

### 4.2 便携模式

当 `ScreenPlay.exe` 同目录下**存在 `portable.flag` 或 `data\` 目录**时自动启用：

```
<解压目录>\ScreenPlay.exe
<解压目录>\portable.flag
<解压目录>\data\                     <- DATA_DIR 指向这里，内容与 §4.1 相同
<解压目录>\resources\
```

* 适合 U 盘 / 移动硬盘：拷走整个目录即完成迁移，不污染宿主机的 `%APPDATA%`。
* 注意：便携包解压到**只读介质**或 `Program Files` 下会失败，请解压到用户可写目录。

### 4.3 `config.json`（壳的配置，位置见 §4.1/§4.2）

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

| 键 | 取值 | 说明 |
| --- | --- | --- |
| `mode` | `embedded`（默认）/ `external` | `embedded` = 壳自己拉起随包后端；`external` = **不启动后端**，直接连 `baseUrl` 指向的已有服务（例如 NAS 上跑着的 ScreenPlay） |
| `port` | `0` = 自动探测；或固定端口（如 `3210`） | 端口冲突时改这里 |
| `baseUrl` | 形如 `http://192.168.1.10:3210` | 仅 `external` 模式使用 |
| `auth` | `off`（默认）/ `local` / `system` | 桌面端默认关闭鉴权，见 `windows/docs/PARITY.md` 差异说明 ⑥ |
| `mediaDirs` | 媒体库目录列表 | 空 = 用 `<DATA_DIR>\media` |
| `closeToTray` | `true` / `false` | 关闭窗口时是否最小化到托盘 |

配置损坏时壳会**回退到默认值**并把原文件备份为 `config.json.bak`，不会直接崩。

---

## 5. 体积

> 下表**解压后一列已按实测填写**（`node scripts/prepare-backend.mjs` / `prepare-frontend.mjs` 的真跑结果，
> 2026-10-02，Node 运行时 v22.20.0）；**zip 内一列只给合计**——逐项压缩体积没有单独称重，
> 不编数字，合计来自真跑 `make-portable.mjs` / `make-webapp-bundle.mjs` 的产物。
> `node_modules` 的体积与文件数会随 npm 解析结果小幅浮动（同一台机器两次装机差过 ~2 MiB），
> 以你本机 `prepare-backend.mjs` 的输出为准即可，量级不会变。

| 组成项 | 路径 | 解压后（实测） | zip 内 |
| --- | --- | --- | --- |
| Node 运行时 | `resources/node/node.exe` | **81.62 MiB** / 1 文件 | — |
| 后端生产依赖 | `resources/backend/node_modules/**` | **81.44 MiB** / 10,300 文件（18 个依赖，230 packages 装机） | — |
| ffmpeg + ffprobe | `resources/bin/{ffmpeg,ffprobe}.exe` | **138.72 MiB**（61.47 + 77.24）/ 2 文件 | — |
| Web 产物（精简版） | `resources/web/**` | **0.60 MiB** / 5 文件（`index.html` 443 B、CSS 71.56 KB、JS 532.92 KB、`assets/plyr.svg`、`assets/blank.mp4`） | — |
| 后端 JS / 清单 | `resources/backend/dist/**` + `package.json`、`build-info.json` | **0.84 MiB** / 148 文件（`dist` 无 `.map`） | — |
| **`resources/` 合计** | 上五项 | **303.22 MiB = 317,945,062 B** / 10,456 文件 | — |
| 桌面壳 | `ScreenPlay.exe`（Tauri v2 release，`strip=true`+`lto`） | 需在 Windows 上编译后称重（预期 5–15 MiB） | — |
| **便携包合计** | `resources/` + `ScreenPlay.exe` + 标记文件 + 说明 | **≈303 MiB + 壳** | **zip 106.90 MiB = 112,088,975 B**（用占位 exe 真跑 `make-portable.mjs` 实测，条目 11,417；压缩率 35.3%） |
| **零工具链包**（备用方案，无需 Rust） | `resources/` + `launcher/` + `ScreenPlay.cmd` | **303.22 MiB + 0.1 MiB** / 10,463 文件（staging 计数） | **zip 106.89 MiB**（真跑 `make-webapp-bundle.mjs` 实测，条目 11,420） |
| 安装包 | `ScreenPlay_<ver>_x64-setup.exe` | — | 与便携包同量级（内容相同，仅多一层自解压） |

* `windows/DESIGN.md` §10 的**硬指标**是「便携包压缩后 ≤ 200 MB」。实测 **106.9 MiB（约 112 MB）**，
  余量充足。若构建后明显超出，按经验先查：误把 devDependencies 或 Web 端 `node_modules` 打进包、
  ffmpeg 换了带全部编码器的巨型静态版。
* 体积大头是 ffmpeg/ffprobe（138.72 MiB 解压后）与 Node 运行时（81.62 MiB），两者合计占 74%。
* 用户可以自行“瘦身”：删除 `resources/bin/ffmpeg.exe` 与 `ffprobe.exe` 会省下约 139 MB，
  代价是视频缩略图与时长解析不可用（截图与视频播放仍正常，播放走的是浏览器/WebView 自带解码）。

---

## 6. 升级 / 卸载 / 备份

### 升级

* **安装版**：直接运行新版本的 `ScreenPlay_<ver>_x64-setup.exe` 覆盖安装即可；
  `%APPDATA%\ScreenPlay\` 中的数据（数据库、海报、配置）会被保留。
  数据库结构升级由后端在启动时自行处理。
* **便携版**：把新 `zip` 解压到**另一个目录**，再把旧目录下的 `data\` 整个拷过去，然后删掉旧目录。
  （直接覆盖 `resources/` 与 `ScreenPlay.exe` 也可以，但先备份 `data\` 更稳。）
* 升级前建议先做一次备份（见下）。

### 卸载

* **安装版**：Windows「设置 → 应用」里卸载 ScreenPlay（或在开始菜单用卸载快捷方式）。
  卸载**不会**删除 `%APPDATA%\ScreenPlay\`。
  想彻底清干净，卸载后手动删除 `%APPDATA%\ScreenPlay\`。
* **便携版**：删除解压目录即可（数据在同目录的 `data\`，一并删除即彻底清理）。

### 备份

需要备份的只有**数据目录**：

1. 先退出 ScreenPlay（确保数据库没有正在写）；
2. 拷贝整个 `%APPDATA%\ScreenPlay\`（或便携模式的 `<解压目录>\data\`）到别处；
3. 最省事的做法：只备份 `screenplay.db` + `posters/`；
   `thumbnails/`、`proxied/` 是可再生的缓存，`logs/` 只用于排障，都可不必备份。

> 注意：如果媒体库目录（`mediaDirs`）指向 NAS 或别的磁盘，那是**你自己的媒体文件**，
> 应用不会改动它们，按你原有的方案备份即可。

---

## 7. 排障

| 现象 | 怎么办 |
| --- | --- |
| 界面起不来 / 白屏 / 一直停在启动画面 | 1) 装 WebView2 运行时（§3）；2) 看日志（下一条）；3) 点启动画面上的「查看日志」按钮 |
| 要拿日志 | ① 应用内：**设置页 → 日志**；② 文件：`<DATA_DIR>\logs\desktop-YYYYMMDD.log`（安装版即 `%APPDATA%\ScreenPlay\logs\`） |
| 后端起不来 / 界面提示后端未就绪 | 看日志里后端子进程的输出；常见原因：杀软拦截了 `resources\node\node.exe`、`resources\` 被杀软删除、`DATA_DIR` 无写权限 |
| 端口冲突（`EADDRINUSE`） | 编辑 `<DATA_DIR>\config.json`，把 `port` 改成别的值（或设 `0` 让它自动探测），重启应用 |
| 想连 NAS 上已有的 ScreenPlay 服务 | 把 `config.json` 改成 `"mode": "external", "baseUrl": "http://<NAS IP>:<端口>"`（并确认 NAS 上的服务允许来自本机的连接），重启后壳不再启动本地后端 |
| 想开登录鉴权 | 把 `"auth"` 从 `off` 改成 `local`（首启生成随机 admin 密码，写在 `<DATA_DIR>\初始密码.txt`）或 `system`。详见 `windows/docs/PARITY.md` 差异说明 ⑥ |
| 视频播不了 | 桌面端播放依赖后端 HTTP Range 请求，后端已支持；若仍失败，确认 `resources\bin\ffmpeg.exe` 存在且杀软没删它 |
| 视频没有缩略图 / 时长不对 | 多半是 `resources\bin\ffmpeg.exe`、`ffprobe.exe` 缺失或被拦截；重新解压一份便携包覆盖即可 |
| 中文路径的媒体库扫不到 | 确认媒体库目录名与文件名是 UTF-8 / 正常中文，且应用对该路径有读权限；如仍异常请把日志报给维护者 |
| 便携包放 U 盘后启动失败 | 确认 U 盘不是只读（便携模式要写 `data\`）；或把 zip 解压到本机磁盘 |
| 数据想搬家 | 退出应用 → 拷贝 `data\`（或 `%APPDATA%\ScreenPlay\`）→ 覆盖到新位置的同名目录 |

---

## 8. 相关文档

* `windows/docs/BUILD-WINDOWS.md` —— 怎么构建（三条路径、镜像代理、报错对照表）
* `windows/docs/PARITY.md` —— Web 端功能对齐与桌面端差异
* `windows/README.md` —— 目录总览
* `windows/DESIGN.md` —— 契约文档（`resources/` 布局、启动编排、`config.json`、数据目录、硬约束）