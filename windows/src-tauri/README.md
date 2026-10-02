# `windows/src-tauri` — ScreenPlay 桌面壳（Tauri v2）

本目录是 Windows 桌面端的 Tauri 外壳，契约见 `windows/DESIGN.md`（§2 架构 / §5 启动编排 / §7 config / §8 数据目录 / §10 硬约束）。

## 构建与自检

```bash
# 正规构建（Windows 主机，或 Linux 上交叉编译）
cd windows/src-tauri
cargo build --release --target x86_64-pc-windows-msvc

# 打包（NSIS）
cd windows && npx tauri build --target x86_64-pc-windows-msvc
```

## ⚠️ 未能编译验证（重要）

**本次交付未做任何真实编译验证**：交付时本机（Linux 开发容器）**没有可用的 Rust 工具链**——
`/tmp/cargo/bin/` 不存在、`/tmp/rustup` 为空、`command -v cargo rustc` 无输出，因此
`cargo check --target x86_64-pc-windows-msvc` 一次都没有跑过，`src/main.rs`、`src/backend.rs`、
`src/config.rs` 是否真的能通过 `cargo check` **尚未证实**。

作为替代，做了以下**可实测**的静态核对（结论均为实测，非推测）：

| 检查项 | 手段 | 结果 |
| --- | --- | --- |
| `tauri.conf.json` 是否符合官方 schema | 官方 `@tauri-apps/cli@2.12.1` 附带的 `config.schema.json`，用 ajv 校验 | **VALID** |
| `capabilities/default.json` | `JSON.parse` | 通过 |
| Rust 源码括号配平 | 自写词法检查（剥离注释/字符串/字符字面量） | 4 个文件全部配平 |
| Tauri v2 API 签名是否用对 | 下载 `tauri-2.12.0` / `tauri-plugin-single-instance-2.2.0` / `dpi-0.1.2` 真实源码逐条比对 | 已据此修掉 4 个真实缺陷（见下） |
| 图标文件 | 真实运行 `node windows/scripts/gen-icons.mjs` + `file(1)` | 4 个文件生成正确 |

### 未在本机验证的点（逐条）

1. **整包是否能编译**：无工具链，`cargo check` 未运行。这是最大的一条。
2. **MSRV**：`tauri 2.12.0` 自身是 `edition = "2024"` + `rust-version = "1.90"`（已从真实 crate 源码核实），
   所以构建机需要 **rustc ≥ 1.90**；`Cargo.toml` 的 `rust-version` 已按此设为 `1.90`，但本机没验证过。
3. **Windows 专有 FFI/分支**（`#[cfg(windows)]`，Linux 上根本不参与编译）：
   `bcrypt` 的 `BCryptGenRandom`（`config.rs`）、`kernel32` 的 `GetLocalTime` 与 `SYSTEMTIME` 布局（`config.rs`）、
   `CommandExt::creation_flags(CREATE_NO_WINDOW)`（`backend.rs`）、`taskkill /PID <pid> /T /F`（`backend.rs`）、
   `explorer <dir>`（`backend.rs`）。源码中均已用 `// 待 Windows 端验证` 标注。
4. **自定义命令是否需要 ACL 条目**：已从 `tauri-2.12.0/src/webview/mod.rs:2085` 的判定
   `if (plugin_command.is_some() || has_app_acl_manifest || !is_local) && … { reject }`
   与 `tauri-utils-2.10.0/src/acl/mod.rs:352-353` 的 `has_app_manifest(acl) = acl.contains_key("__app-acl__")`
   读出结论：**splash（`tauri://localhost`，本地源）+ 应用未定义 `permissions/` 清单 ⇒ 自定义命令不做 ACL 检查**，
   故 `capabilities/default.json` 只给 `core:default` 是够的。但这条没在真实构建上跑过。
   附带结论：主窗口导航到 `http://127.0.0.1:<port>/` 后属于**远程源**，任何 IPC 都会被拒——
   这与 DESIGN §2「主界面不需要 IPC」一致（前端只走同源 `/api`）。
   若真机上报 “Command … not allowed by ACL”，修法是加一个 `permissions/` 应用权限清单。
5. **窗口 `eval` 导航**：`WebviewWindow::eval` 与 `navigate` 都已确认存在（`webview_window.rs:2581` / `:2516`）；
   这里选了 `eval("window.location.replace(...)")`（`navigate` 需要先构造 `url::Url`）。
   `app.security.csp` 为 `null`，理论上不会拦 `eval`；真机行为未验证。
6. **NSIS 打包与 `bundle.resources` 落盘**：`{"resources/": "resources/"}` 的对象映射语法已由官方 schema 认可，
   但 `resources/` 目录本身由同事的 `windows/scripts/*.mjs` 产出（当前不存在），因此**打包链路完全未跑过**。
7. **`resources/` 资源清单**：`node/node.exe`、`backend/dist/main.js`、`web/`、`bin/ffmpeg.exe`、`build-info.json`
   都由 prepare 脚本产出；壳在缺文件时会给出中文错误并提示重跑 `windows/scripts/prepare-backend.mjs`。

### 已核实的关键事实（来自真实源码，非推测）

- `/api/health` 返回 `{"status":"ok","uptime":…,"version":…,"buildTime":…,"features":[…]}`，**没有 `ok` 字段**
  （`backend/src/app.controller.ts:73-92`）→ 就绪判定用 HTTP 200 **且** body 含 `"status":"ok"`。
- `tauri::app_data_dir()` 解析为 `<roaming>\<identifier>`，即 `%APPDATA%\com.screenplay.desktop`，
  **不是** `%APPDATA%\ScreenPlay`（`tauri-2.12.0/src/path/desktop.rs:251`）→ `config::reanchor_appdata` 是必需的。
- `single_instance::init` 闭包签名 `FnMut(&AppHandle<R>, Vec<String>, String)` 与代码一致
  （`tauri-plugin-single-instance-2.2.0/src/lib.rs:31`）。
- 本次静态核对**修掉的 4 个真实缺陷**：`set_min_size` 参数是 `Option<S>`；`BackendStatus` 漏了
  `rename_all = "camelCase"`（splash 读 `status.logPath`/`status.dataDir`）；`kill_tree` 里
  `["/PID", &pid.to_string(), …]` 混用 `&str`/`&String` 无法编译；`Cargo.toml` 里空的 `[lib]` 表会让 cargo
  去找不存在的 `src/lib.rs`。