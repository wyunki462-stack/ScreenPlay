#!/usr/bin/env bash
# 在 Linux 主机上用 makensis 生成 Windows NSIS 安装包
#   → windows/dist/ScreenPlay_<版本>_x64-setup.exe
#
# 前置条件
#   * 先跑过 windows/scripts/cross/cross-build.sh（目标目录里已有 release/screenplay.exe）
#   * windows/src-tauri/resources/ 已就绪（npm run prepare:frontend && npm run prepare:backend）
#   * windows/node_modules 里有 @tauri-apps/cli（没有就 ./这个脚本 会提示装）
#   * 首次联网：下载 nsis_tauri_utils.dll（约 34 KB）+ Debian 的 nsis 包（约 1.7 MB）
#
# 为什么不用 `tauri build`：`tauri build` 在 Linux 上会去编译 Windows 目标，且它给 cargo 套的
# wrapper 一旦找不到宿主 cargo 就报 `failed to run 'cargo metadata'`。这里只用 bundle 阶段
# （`tauri bundle --bundles nsis`），直接打包 cross-build.sh 已经编译好的 exe。
#
# 常用环境变量（均有默认值）
#   SP_WORK=/tmp/sp-cross        工作区，必须与 cross-build.sh 的 CARGO_TARGET_DIR 一致
#   SP_NSIS_DIR=/tmp/nsis308     makensis 解包目录
#   SP_SHIM_DIR=/tmp/bin         垫片目录（会写入 makensis 包装脚本）
#   SP_TAURI_CACHE=/tmp/sp-cache tauri 缓存（放 NSIS 插件 dll；必须可写）
#   SP_HOME=/tmp/sp-home         也是 tauri 缓存的根；本机 $HOME 不可写时必须指定
#   SP_ZIG=zig                   用来编 fixmode.so（可留空则不做权限修补）
#   SP_NSIS_DEB / SP_NSIS_COMMON_DEB / SP_NSIS_INCLUDE_DEB  直接给本地 deb 文件，跳过下载
#
# 用法：bash scripts/cross/make-setup-cross.sh
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)          # windows/scripts/cross
WINDOWS_DIR=$(cd "$HERE/../.." && pwd)       # windows/
SRC_TAURI="$WINDOWS_DIR/src-tauri"

WORK=${SP_WORK:-/tmp/sp-cross}
NSIS_DIR=${SP_NSIS_DIR:-/tmp/nsis308}
SHIM_DIR=${SP_SHIM_DIR:-/tmp/bin}
TAURI_CACHE=${SP_TAURI_CACHE:-/tmp/sp-cache}
export HOME=${SP_HOME:-${HOME:-$WORK/home}}
export XDG_CACHE_HOME=${SP_TAURI_CACHE:-/tmp/sp-cache}
export npm_config_cache=${npm_config_cache:-/tmp/sp-npm-cache}
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$WORK/target}
# `tauri bundle` 自己会跑 `cargo metadata`，所以宿主 cargo 也必须在 PATH 上
export RUSTUP_HOME=${SP_RUSTUP_HOME:-${RUSTUP_HOME:-$HOME/.rustup}}
export CARGO_HOME=${SP_CARGO_HOME:-${CARGO_HOME:-$HOME/.cargo}}
export PATH="$CARGO_HOME/bin:$PATH"
if ! command -v cargo >/dev/null 2>&1 && [ -d "$RUSTUP_HOME/toolchains" ]; then
  TC=$(ls -d "$RUSTUP_HOME"/toolchains/*/bin 2>/dev/null | head -1)
  [ -n "${TC:-}" ] && export PATH="$TC:$PATH"
fi
DEB_BASE=${SP_DEB_BASE:-https://deb.debian.org/debian/pool/main/n/nsis}
NSIS_VER=${SP_NSIS_VERSION:-3.08-3+deb12u1}
NSIS_COMMON_VER=${SP_NSIS_COMMON_VERSION:-3.08-3+deb12u1}
# 3.11 的包只为拿一个包含文件：Debian 的 3.08 包缺 Include/Win/RestartManager.nsh，
# 而 tauri 生成的 installer.nsi 第 27 行 !include 了它。
INCLUDE_VER=${SP_NSIS_INCLUDE_VERSION:-3.11-1}

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少 $1" >&2; exit 1; }; }
need python3; need dpkg-deb; need node; need npx
command -v cargo >/dev/null 2>&1 || { echo "缺少 cargo（tauri bundle 要用它跑 cargo metadata）：用 SP_CARGO_HOME / SP_RUSTUP_HOME 指向工具链，见脚本头部" >&2; exit 1; }

VERSION=$(python3 -c "import json;print(json.load(open('$SRC_TAURI/tauri.conf.json'))['version'])")
EXE="$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/screenplay.exe"
echo "== 目标 =="
echo "版本      : $VERSION"
echo "exe       : $EXE"
echo "工作区    : $WORK"

# 1) 检查前置产物
if [ ! -f "$EXE" ]; then
  echo "没有 $EXE —— 先跑：bash $HERE/cross-build.sh" >&2
  exit 1
fi
for f in "$SRC_TAURI/resources/node/node.exe" "$SRC_TAURI/resources/backend/dist/main.js"; do
  [ -f "$f" ] || { echo "缺少资源：$f" >&2
    echo "先跑：cd $WINDOWS_DIR && npm run prepare:frontend && npm run prepare:backend" >&2; exit 1; }
done
if [ ! -e "$WINDOWS_DIR/node_modules/@tauri-apps/cli" ]; then
  echo "缺少 @tauri-apps/cli，请先执行：" >&2
  echo "  cd $WINDOWS_DIR && npm install --ignore-scripts --no-audit --no-fund \\" >&2
  echo "    --cache $npm_config_cache --registry=https://registry.npmmirror.com" >&2
  echo "  chmod -R u+rwX node_modules   # 本共享盘新建文件是 000，必须 chmod" >&2
  exit 1
fi

# 2) 准备 makensis
mkdir -p "$NSIS_DIR" "$SHIM_DIR" "$TAURI_CACHE" "$HOME"
MAKENSIS="$SHIM_DIR/makensis"
USE_SYSTEM=0
# 系统自带 makensis 也能用（只要它带 Include/ 与 Stubs/）：先探测
if command -v makensis >/dev/null 2>&1 && makensis -VERSION >/dev/null 2>&1; then
  USE_SYSTEM=1
  MAKENSIS=$(command -v makensis)
fi
if [ "$USE_SYSTEM" = 0 ] && [ ! -x "$NSIS_DIR/usr/bin/makensis" ]; then
  fetch_deb() { # fetch_deb <文件名>
    local f="$1"
    if [ -f "/tmp/$f" ]; then echo "  用已有 /tmp/$f"; return 0; fi
    echo "  下载 $DEB_BASE/$f"
    curl -fsSL --retry 3 --max-time 300 -o "/tmp/$f" "$DEB_BASE/$f"
  }
  need curl
  echo "== 下载并解包 makensis（Debian $NSIS_VER）=="
  fetch_deb "nsis_${NSIS_VER}_amd64.deb"
  fetch_deb "nsis-common_${NSIS_COMMON_VER}_all.deb"
  dpkg-deb -x "/tmp/nsis_${NSIS_VER}_amd64.deb" "$NSIS_DIR"
  dpkg-deb -x "/tmp/nsis-common_${NSIS_COMMON_VER}_all.deb" "$NSIS_DIR"
fi
if [ "$USE_SYSTEM" = 0 ] && [ ! -f "$NSIS_DIR/usr/share/nsis/Include/Win/RestartManager.nsh" ]; then
  echo "== 补 Include/Win/RestartManager.nsh（3.08 包缺，用 $INCLUDE_VER 的包）=="
  f="nsis-common_${INCLUDE_VER}_all.deb"
  if [ ! -f "/tmp/$f" ]; then
    echo "  下载 $DEB_BASE/$f"
    curl -fsSL --retry 3 --max-time 300 -o "/tmp/$f" "$DEB_BASE/$f"
  fi
  TMPX="$WORK/nsis-include"
  rm -rf "$TMPX"; mkdir -p "$TMPX"
  dpkg-deb -x "/tmp/$f" "$TMPX"
  cp "$TMPX/usr/share/nsis/Include/Win/RestartManager.nsh" "$NSIS_DIR/usr/share/nsis/Include/Win/"
  chmod 644 "$NSIS_DIR/usr/share/nsis/Include/Win/RestartManager.nsh"
  rm -rf "$TMPX"
fi
if [ "$USE_SYSTEM" = 0 ] && [ ! -x "$MAKENSIS" ]; then
  # Debian 的 makensis 内置默认路径是 /usr/share/nsis，所以必须显式导出 NSISDIR
  cat > "$MAKENSIS" <<EOF
#!/bin/sh
export NSISDIR="$NSIS_DIR/usr/share/nsis"
exec "$NSIS_DIR/usr/bin/makensis" "\$@"
EOF
  chmod 755 "$MAKENSIS"
fi
echo "== makensis =="
echo "包装脚本  : $MAKENSIS"
echo "NSISDIR   : $NSIS_DIR/usr/share/nsis"
echo "makensis  : $("$MAKENSIS" -VERSION)"
echo "dll 缓存  : $TAURI_CACHE/tauri/NSIS/Plugins/x86-unicode/additional"

# 3) 权限修补（同 cross-build.sh：本共享盘新建文件是 000）
export PATH="$SHIM_DIR:$PATH"
if [ -n "${SP_ZIG:-zig}" ] && command -v "${SP_ZIG:-zig}" >/dev/null 2>&1; then
  FIX="$WORK/fixmode.so"
  [ -f "$FIX" ] || "${SP_ZIG:-zig}" cc -shared -fPIC -O1 -o "$FIX" "$HERE/fixmode.c"
  export LD_PRELOAD="$FIX"
else
  echo "提示：没有 zig，跳过 fixmode.so（下载/写缓存可能报 os error 13）" >&2
fi

# 4) 打包（只走 bundle 阶段，复用已编好的 exe）
cd "$WINDOWS_DIR"
echo "== tauri bundle --bundles nsis =="
npx tauri bundle --target x86_64-pc-windows-msvc --bundles nsis

OUT="$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/bundle/nsis/ScreenPlay_${VERSION}_x64-setup.exe"
[ -f "$OUT" ] || { echo "没找到产物：$OUT" >&2; exit 1; }

# 5) 校验 + 拷到 windows/dist/
mkdir -p "$WINDOWS_DIR/dist"
cp "$OUT" "$WINDOWS_DIR/dist/ScreenPlay_${VERSION}_x64-setup.exe"
chmod 644 "$WINDOWS_DIR/dist/ScreenPlay_${VERSION}_x64-setup.exe"
echo "== 校验 =="
python3 - "$WINDOWS_DIR/dist/ScreenPlay_${VERSION}_x64-setup.exe" <<'PY'
import struct, sys, hashlib
p = sys.argv[1]
d = open(p, 'rb').read(0x400)
e = struct.unpack_from('<I', d, 0x3c)[0]
assert d[:2] == b'MZ' and d[e:e+4] == b'PE\0\0', '不是 PE 文件'
mach = struct.unpack_from('<H', d, e+4)[0]
subsys = struct.unpack_from('<H', d, e+24+68)[0]
assert mach == 0x14c, 'NSIS 引导程序应为 32 位 PE：%#x' % mach
assert subsys == 2, '不是 GUI 子系统：%d' % subsys
raw = open(p, 'rb').read()
print('  machine=0x14c(x86 引导) subsystem=2(GUI)')
print('  大小 %.2f MiB (%d B)' % (len(raw)/1048576, len(raw)))
print('  sha256 %s' % hashlib.sha256(raw).hexdigest())
PY
echo "== 已放到 $WINDOWS_DIR/dist/ScreenPlay_${VERSION}_x64-setup.exe =="