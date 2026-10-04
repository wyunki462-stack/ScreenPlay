#!/usr/bin/env bash
# 在 Linux 主机上交叉编译 ScreenPlay 桌面壳（Tauri v2，MSVC 目标）→ windows/dist/ScreenPlay.exe
#
# 前置条件
#   * rustup（stable 工具链）+ 目标：rustup target add x86_64-pc-windows-msvc
#   * cargo-xwin：cargo install cargo-xwin --locked
#   * zig 0.13 或更新（提供 cc / ar / rc；用 SP_ZIG 指向其可执行文件）
#   * 首次构建需要联网：cargo-xwin 会下载 MSVC CRT/SDK（约 630 MB）到 XWIN 缓存
#
# 常用环境变量（均有默认值）
#   SP_WORK=/tmp/sp-cross    可写工作区（**必须**在可写盘上：本共享盘把新建文件建成 000）
#   SP_CARGO_HOME / SP_RUSTUP_HOME   rustup/cargo 家目录（默认沿用环境变量，否则 ~/.cargo、~/.rustup）
#   SP_ZIG=zig               zig 可执行文件
#   SP_JOBS=2                并行度（1–2 GB 空闲内存建议 2）
#   SP_LTO=false             关掉 release LTO 以省内存（默认 false，稳；想更快可设 true）
#   SP_FIXMODE=1             修补「新建文件权限 000」的文件系统怪癖（默认开）
#
# 用法：bash scripts/cross/cross-build.sh [--portable]
set -euo pipefail

WITH_PORTABLE=0
[ "${1:-}" = "--portable" ] && WITH_PORTABLE=1

HERE=$(cd "$(dirname "$0")" && pwd)          # windows/scripts/cross
WINDOWS_DIR=$(cd "$HERE/../.." && pwd)       # windows/
SRC_TAURI="$WINDOWS_DIR/src-tauri"

WORK=${SP_WORK:-/tmp/sp-cross}
mkdir -p "$WORK"
export RUSTUP_HOME=${SP_RUSTUP_HOME:-${RUSTUP_HOME:-$HOME/.rustup}}
export CARGO_HOME=${SP_CARGO_HOME:-${CARGO_HOME:-$HOME/.cargo}}
export PATH="$CARGO_HOME/bin:$PATH"
# rustup 的 cargo/rustc 在 RUSTUP_HOME/toolchains/<toolchain>/bin 里（不在 CARGO_HOME/bin），补进 PATH
if ! command -v cargo >/dev/null 2>&1 && [ -d "$RUSTUP_HOME/toolchains" ]; then
  TC=$(ls -d "$RUSTUP_HOME"/toolchains/*/bin 2>/dev/null | head -1)
  [ -n "${TC:-}" ] && export PATH="$TC:$PATH"
fi
export SP_ZIG=${SP_ZIG:-zig}
export ZIG_GLOBAL_CACHE_DIR=${ZIG_GLOBAL_CACHE_DIR:-$WORK/zig-cache}
export XWIN_CACHE_DIR=${XWIN_CACHE_DIR:-$WORK/xwin-cache}
export XWIN_ARCH=x86_64
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$WORK/target}
export CARGO_HTTP_MULTIPLEXING=false CARGO_HTTP_TIMEOUT=60 CARGO_NET_RETRY=10
export CARGO_PROFILE_RELEASE_LTO=${SP_LTO:-false}
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少 $1（见脚本头部前置条件）" >&2; exit 1; }; }
need cargo; need cargo-xwin; need "$SP_ZIG"; need python3
echo "== 工具 =="
echo "cargo      : $(cargo --version)"
echo "cargo-xwin : $(cargo-xwin --version)"
echo "zig        : $($SP_ZIG version 2>/dev/null || echo '?') @ $SP_ZIG"
echo "工作区     : $WORK"

# 1) C 编译器 / archiver 垫片（zig 冒充）
export CC="$HERE/cc.sh" AR="$HERE/ar.sh" CXX="$HERE/cc.sh"
# 2) 资源编译器垫片（embed-resource 在 MSVC 路径上找 llvm-rc）
export RC="$HERE/llvm-rc.sh"
# 3) cargo-xwin 会把 CC_x86_64_pc_windows_msvc 设成 clang-cl；本机没 LLVM，用垫片接住
export CC_x86_64_pc_windows_msvc="$HERE/clang-cl.sh"
# 4) 文件系统怪癖修补：这个共享盘把「进程新建的文件」建成 000，
#    于是 build script 写出的 acl-manifests.json / gen/schemas/*.json 在同一构建里读不回来。
#    用 LD_PRELOAD 在 open 成功后 fchmod 0666（失败则 chmod 后重试一次）。
if [ "${SP_FIXMODE:-1}" = "1" ]; then
  FIX="$WORK/fixmode.so"
  [ -f "$FIX" ] || "$SP_ZIG" cc -shared -fPIC -O1 -o "$FIX" "$HERE/fixmode.c"
  export LD_PRELOAD="$FIX"
fi

cd "$SRC_TAURI"
rm -rf gen                     # 旧 schema 是 000 权限，留着会让下一次构建写不进去
echo "== 交叉编译 =="
cargo-xwin build --release --locked --target x86_64-pc-windows-msvc -j "${SP_JOBS:-2}"

EXE="$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/screenplay.exe"
[ -f "$EXE" ] || { echo "没找到产物：$EXE" >&2; exit 1; }
echo "== 校验 PE =="
python3 - "$EXE" <<'PY'
import struct, sys
d = open(sys.argv[1], 'rb').read()
e = struct.unpack_from('<I', d, 0x3c)[0]
assert d[:2] == b'MZ' and d[e:e+4] == b'PE\0\0', '不是 PE 文件'
mach, nsec = struct.unpack_from('<HH', d, e+4)
opt = e + 24
subsys = struct.unpack_from('<H', d, opt+68)[0]
rrva, rsz = struct.unpack_from('<II', d, opt+112+2*8)
assert mach == 0x8664, '不是 x64：%#x' % mach
assert subsys == 2, '不是 GUI 子系统：%d' % subsys
assert rsz, '没有资源目录（图标/版本信息/manifest 丢失）'
print('  machine=0x8664(x64) 节数=%d subsystem=2(GUI) 资源目录 %d B' % (nsec, rsz))
print('  大小 %.2f MiB (%d B)' % (len(d)/1048576, len(d)))
PY

mkdir -p "$WINDOWS_DIR/dist"
cp "$EXE" "$WINDOWS_DIR/dist/ScreenPlay.exe"
chmod 644 "$WINDOWS_DIR/dist/ScreenPlay.exe"
echo "== 已放到 $WINDOWS_DIR/dist/ScreenPlay.exe =="

if [ "$WITH_PORTABLE" = 1 ]; then
  cd "$WINDOWS_DIR"
  echo "== 打免安装包 =="
  npm run portable:win
fi
