# `scripts/cross/` —— 在 Linux 上交叉编译 Windows 版 `ScreenPlay.exe`

一条命令（详见 `../../docs/BUILD-WINDOWS.md` §3）：

```bash
cd <项目>/windows
bash scripts/cross/cross-build.sh --portable
```

## 这些垫片在补什么

| 文件 | 作用 |
| --- | --- |
| `cross-build.sh` | 一键脚本：环境检查 → 编译 `fixmode.so` → `rm -rf src-tauri/gen` → `cargo-xwin build` → PE 校验 → 拷到 `dist/` |
| `cc.sh` | zig 当主机 C 编译器，并把 cc-rs 传来的 Rust 三元组翻译成 zig 认的写法 |
| `ar.sh` | `zig ar` |
| `llvm-rc.sh` | 假 `llvm-rc` → `zig rc`（`tauri-winres` 缺资源编译器时会 panic `NotAttempted("llvm-rc")`） |
| `clang-cl.sh` | 假 `clang-cl`（cargo-xwin 会把 `CC_x86_64_pc_windows_msvc` 设成它，而本机没有 LLVM） |
| `fixmode.c` | LD_PRELOAD 修丁：本机新建文件权限是 `000`，导致 build script 写出的中间文件读不回来 |

## 实测结果（本机 Linux，无 root、无系统 C 编译器）

* `Finished 'release' profile [optimized] target(s) in 39.93s`
* `ScreenPlay.exe` = **7,381,504 B = 7.04 MiB**，PE32+ x64、`subsystem=GUI`、
  资源目录 8,968 B（`ICON`/`GROUP_ICON`/`VERSION`/`MANIFEST` 全在）
* 便携包 `dist/ScreenPlay_1.0.0_x64-portable.zip` = **114,278,175 B = 108.98 MiB**
* 做不出 NSIS 安装包（需要 wine + makensis）→ 在 Windows 上跑 `build-windows.ps1`

> 垫片是「让本机这条路径能跑通」的权宜之计：**产物没在本机运行过**（本机没有 Windows/wine），
> 正式交付仍以 Windows 真机 `build-windows.ps1` 构建的产物为准。
