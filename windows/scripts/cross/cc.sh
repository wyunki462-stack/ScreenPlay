#!/bin/bash
# 交叉编译用 C 编译器垫片：zig 当 cc。
# cc-rs / build script 会传 Rust 三元组（`--target=x86_64-pc-windows-msvc`），
# zig 只认 LLVM 风格的 `x86_64-windows-msvc`，所以这里做一次翻译。
# 用法：CC=<此脚本> 或把本目录加进 PATH 并软链成 cc。
args=()
for a in "$@"; do
  case "$a" in
    --target=x86_64-unknown-linux-gnu) a="--target=x86_64-linux-gnu" ;;
    --target=x86_64-unknown-linux-musl) a="--target=x86_64-linux-musl" ;;
    --target=x86_64-pc-windows-msvc)   a="--target=x86_64-windows-msvc" ;;
    --target=x86_64-pc-windows-gnu)    a="--target=x86_64-windows-gnu" ;;
  esac
  args+=("$a")
done
export ZIG_GLOBAL_CACHE_DIR=${ZIG_GLOBAL_CACHE_DIR:-/tmp/.zig-cache}
exec "${SP_ZIG:-zig}" cc "${args[@]}"
