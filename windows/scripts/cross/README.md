# `scripts/cross/` —— 在 Linux 上交叉编译 Windows 版 `ScreenPlay.exe`（并打 NSIS 安装包）

两条命令（详见 `../../docs/BUILD-WINDOWS.md` §3、§3.6）：

```bash
cd <项目>/windows
bash scripts/cross/cross-build.sh --portable   # exe + 便携 zip
bash scripts/cross/make-setup-cross.sh         # NSIS 安装包（原生 makensis）
```

## 这些垫片在补什么

| 文件 | 作用 |
| --- | --- |
| `cross-build.sh` | 一键脚本：环境检查 → 编译 `fixmode.so` → `rm -rf src-tauri/gen` → `cargo-xwin build` → PE 校验 → 拷到 `dist/` |
| `make-setup-cross.sh` | 用 **Debian 的 Linux 原生 `makensis`** + `tauri bundle --bundles nsis` 打 NSIS 安装包 → `dist/ScreenPlay_<ver>_x64-setup.exe`（自己会下 deb、建 `NSISDIR` 包装脚本、补缺的 `RestartManager.nsh`） |
| `cc.sh` | zig 当主机 C 编译器，并把 cc-rs 传来的 Rust 三元组翻译成 zig 认的写法 |
| `ar.sh` | `zig ar` |
| `llvm-rc.sh` | 假 `llvm-rc` → `zig rc`（`tauri-winres` 缺资源编译器时会 panic `NotAttempted("llvm-rc")`） |
| `clang-cl.sh` | 假 `clang-cl`（cargo-xwin 会把 `CC_x86_64_pc_windows_msvc` 设成它，而本机没有 LLVM） |
| `fixmode.c` | LD_PRELOAD 修丁：本机新建文件权限是 `000`，导致 build script 写出的中间文件读不回来 |

## 实测结果（本机 Linux，无 root、无系统 C 编译器）

* `Finished 'release' profile [optimized] target(s) in 38.33s`
* `ScreenPlay.exe` = **7,436,288 B = 7.09 MiB**（1.3.2 源码），PE32+ x64、`subsystem=GUI`、
  资源目录 10,368 B（`ICON`/`GROUP_ICON`/`VERSION`/`MANIFEST` 全在）
* 便携包 `dist/ScreenPlay_1.3.2_x64-portable.zip` = **114,388,270 B = 109.09 MiB**（11,427 条目）
* NSIS 安装包 `dist/ScreenPlay_1.3.2_x64-setup.exe` = **74,983,691 B = 71.51 MiB**
  （`make-setup-cross.sh`：3.08 的 `makensis` 要对 300 MiB 的 `resources/` 做 LZMA 固实压缩，约 15 分钟）

> 垫片是「让本机这条路径能跑通」的权宜之计：**产物没在本机运行过**（本机没有 Windows/wine），
> 正式交付仍以 Windows 真机 `build-windows.ps1` 构建的产物为准。
