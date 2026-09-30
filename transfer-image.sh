#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# ScreenPlay — 一键把镜像传到目标设备
#
# 在 **NAS（已构建好镜像的那台）** 上运行：
#
#     bash transfer-image.sh 用户@目标设备IP
#
# 例：
#     bash transfer-image.sh test0@192.168.1.50
#
# 它做三件事：
#   1) docker save 导出镜像为 tar.gz
#   2) rsync 传到目标设备（断线可续：重复运行会从断点继续）
#   3) 在目标设备上 docker load 并起服务
#
# 为什么不用 docker push 到 ghcr.io：
#   实测本机到 ghcr.io 的连接约 1/3 概率失败；经代理连 github.com 是 0/3。
#   584MB 的长连接在这样链路上几乎不可能传完。rsync 走内网，与这些无关。
# ═════════════════════════════════════════════════════════════════════════════

set -euo pipefail

REMOTE="${1:-}"
IMG="${IMG:-screenplay:latest}"
TAR="${TAR:-/tmp/screenplay-image.tar.gz}"

die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
say() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

[ -n "$REMOTE" ] || die "用法: bash transfer-image.sh 用户@目标设备IP"
command -v docker >/dev/null 2>&1 || die "找不到 docker"
command -v rsync  >/dev/null 2>&1 || die "找不到 rsync（NAS 上装一下：apt install rsync / opkg install rsync）"

docker image inspect "$IMG" >/dev/null 2>&1 \
  || die "本地没有镜像 $IMG。先在仓库目录跑: docker build -t $IMG ."

# ── 1. 导出 ─────────────────────────────────────────────────────────────────
say "导出镜像 $IMG → $TAR"
if [ -s "$TAR" ]; then
  printf '   已存在（%s），跳过导出。想重新导出先删掉它。\n' "$(du -h "$TAR" | cut -f1)"
else
  docker save "$IMG" | gzip > "$TAR"
  printf '   完成：%s\n' "$(du -h "$TAR" | cut -f1)"
fi

# ── 2. 传输（断线可续）──────────────────────────────────────────────────────
say "传送到 $REMOTE（断线就重跑本脚本，会从断点继续）"
rsync -avP --partial --timeout=120 --inplace "$TAR" "$REMOTE:/tmp/" \
  || die "rsync 失败。检查：目标设备 IP/用户名对不对、SSH 通不通、磁盘空间够不够。"

# ── 3. 远端导入并启动 ───────────────────────────────────────────────────────
say "在 $REMOTE 上导入并启动"
ssh "$REMOTE" bash -s <<'REMOTE_SCRIPT'
set -euo pipefail

TAR=/tmp/screenplay-image.tar.gz
DIR="$HOME/screenplay"
mkdir -p "$DIR"
cd "$DIR"

echo "-- 导入镜像 --"
gunzip -c "$TAR" | docker load

echo "-- 写 compose 文件 --"
cat > screenplay.yml <<'YAML'
services:
  screenplay:
    image: screenplay:latest
    container_name: screenplay
    restart: unless-stopped
    ports:
      - "3001:3000"
    environment:
      PORT: 3000
      DATA_DIR: /data
      MEDIA_DIRS: /media
      WEB_DIST: /app/public
      AUTH_MODE: local
    volumes:
      - "${MEDIA_HOST_DIR}:/media:ro"
      - screenplay-data:/data
    healthcheck:
      test: ["CMD-SHELL", "wget -q -O /dev/null --tries=1 --timeout=4 http://127.0.0.1:3000/api/health || exit 1"]
      interval: 30s
      timeout: 5s
      start_period: 20s
      retries: 3
volumes:
  screenplay-data:
YAML

# .env 只在不存在时创建，避免覆盖你已经改好的配置
if [ -f .env ]; then
  echo "-- .env 已存在，保持不动 --"
  cat .env
else
  cat > .env <<'ENVFILE'
# ★★ 必填：改成这台设备上**真实存在**的游戏截图目录 ★★
# 目录不存在的话 Docker 会建一个空目录挂进去，容器能起来但游戏库永远是空的。
MEDIA_HOST_DIR=/请改成你真实的截图目录
ENVFILE
  echo "-- 已生成 .env，请编辑它填 MEDIA_HOST_DIR --"
fi

echo
echo "======== 下一步 ========"
echo "1) 编辑 $DIR/.env，把 MEDIA_HOST_DIR 改成真实目录"
echo "2) cd $DIR && docker compose -f screenplay.yml up -d"
echo "3) docker compose -f screenplay.yml logs screenplay | grep -i admin  # 取首次登录密码"
REMOTE_SCRIPT

say "完成"
printf '镜像已传到 %s 并导入。\n' "$REMOTE"
printf '剩下只需在目标设备上：cd ~/screenplay && 编辑 .env && docker compose up -d\n'