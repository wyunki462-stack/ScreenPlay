#!/bin/bash
# 假的 clang-cl：cargo-xwin 会把 CC_x86_64_pc_windows_msvc 设成 clang-cl，
# 但本机没有 LLVM。只有 embed-resource「用 cc crate 预处理 .rc」这一步会走到这里
# （它要的是 stdout 上的预处理结果），所以把 clang-cl 风格参数翻译成 zig cc 即可。
# 其它 C 代码不会用它（宿主依赖走 CC，见 cc.sh）。
[ -n "${SP_CROSS_LOG:-}" ] && echo "clang-cl ARGS: $*" >> "$SP_CROSS_LOG"
skip=0
args=()
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$a" in
    /imsvc) skip=1 ;;                                   # /imsvc <dir> → -isystem <dir>
    /imsvc*) args+=("-isystem" "${a#/imsvc}") ;;
    -Xclang) skip=1 ;;                                  # -Xclang + 下一个参数（cc_xc 传的是 -xc）
    -xc|-x|c) ;;                                        # 语言由下面统一指定
    --) ;;                                              # cc-rs 给 clang-cl 加的路径分隔符
    /I*) args+=("-I${a#/I}") ;;
    /D*) args+=("-D${a#/D}") ;;
    /U*) args+=("-U${a#/U}") ;;
    /O*|/MD|/MDd|/MT|/MTd|/Z7|/Zi|/nologo|/GS|/EH*|/std:*|/GR) ;;   # MSVC 专有开关，预处理阶段无意义
    -E|-P|/EP|/E|/P) ;;                                 # 统一由下面补 -E
    *) args+=("$a") ;;
  esac
done
exec "$(dirname "$0")/cc.sh" -E -x c "${args[@]}"
