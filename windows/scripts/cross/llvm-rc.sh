#!/bin/bash
# 假的 llvm-rc：本机没有 LLVM 的 llvm-rc，这里把它翻译给 zig 自带的 `zig rc`（rc.exe 兼容实现）。
#
# 背景（embed-resource 3.0.11 在非 Windows 宿主上的 MSVC 路径）：
#   1) 探测：执行 `<rc> -V /?`，要求 stdout 以 "OVERVIEW: LLVM Resource Converter" 开头；
#      若 stdout 里出现 "no-preprocess"，则编译时会追加 /no-preprocess。
#   2) 编译：`<rc> /fo <out> /C 65001 [/no-preprocess] -- <已被 cc 预处理过的 .rc>`；
#      产物通过 `cargo:rustc-link-arg-bins=<out>` 直接交给 lld-link。
# 与 zig rc 的差异（实测）：
#   * zig rc 只认小写 `/c <codepage>`，而且把 `/no-preprocess` 当 `/n` + 余下字符解析
#     （报 `<cli>: error: invalid option: /o-preprocess`）→ 这里改写 /C→/c 并吃掉 /no-preprocess；
#     zig rc 会自己再预处理一遍，它能正常读入带 `# 1 "file"` 行标记的文件（实测）。
#   * zig rc 输出的是 RES 格式（不是 COFF），但 lld-link 按内容识别 .res 可直接链接（实测 OK）。
set -euo pipefail
if [ "${1:-}" = "-V" ]; then
  printf 'OVERVIEW: LLVM Resource Converter (zig rc shim)\nno-preprocess\n'
  exit 0
fi
args=()
for a in "$@"; do
  case "$a" in
    /no-preprocess|/N|-no-preprocess) continue ;;
    /C) args+=("/c"); continue ;;
    *) args+=("$a") ;;
  esac
done
exec "${SP_ZIG:-zig}" rc "${args[@]}"
