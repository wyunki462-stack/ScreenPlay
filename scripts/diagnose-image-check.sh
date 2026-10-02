#!/usr/bin/env bash
# =============================================================================
# ScreenPlay — 逐条复现 docker-deploy.sh 的产物检查，并保留 stderr
#
# 背景：`docker-deploy.sh` 用 `if ! docker run --entrypoint sh ... -c '<检查>'` 判断
# 镜像里有没有本轮产物。它把 docker run 的 stdout/stderr 都吞掉了，所以失败时只看到
# 一句「缺少产物」，看不到真实原因。
#
# 这个表单逐条分开跑，每条都打印：
#   · 退出码
#   · stderr（docker 自己的报错往往在这里）
#
# 用法：bash scripts/diagnose-image-check.sh
# =============================================================================
set -uo pipefail

IMAGE_TAG="${IMAGE_TAG:-screenplay:latest}"

step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

run_check() {
  local label="$1"
  shift
  printf '\n\033[1m--- %s ---\033[0m\n' "$label"
  printf '  命令: docker run --rm --entrypoint sh %s -c %q\n' "$IMAGE_TAG" "$1"

  local out rc errfile
  errfile="$(mktemp)"
  out="$(docker run --rm --entrypoint sh "$IMAGE_TAG" -c "$1" 2>"$errfile")"
  rc=$?

  printf '  退出码: %s\n' "$rc"
  [ -n "$out" ] && printf '  stdout: %s\n' "$out" || printf '  stdout: （空）\n'
  if [ -s "$errfile" ]; then
    printf '  \033[31mstderr:\033[0m\n'
    sed 's/^/    /' "$errfile"
  else
    printf '  stderr: （空）\n'
  fi
  rm -f "$errfile"
  return "$rc"
}

printf '\n\033[1m镜像产物检查 · 逐条复现\033[0m\n'
printf '镜像: %s\n' "$IMAGE_TAG"

step "0. 镜像基本信息"
docker image inspect -f '  ID:        {{.Id}}' "$IMAGE_TAG" 2>&1 || true
docker image inspect -f '  Created:   {{.Created}}' "$IMAGE_TAG" 2>&1 || true
docker image inspect -f '  Entrypoint:{{.Config.Entrypoint}}' "$IMAGE_TAG" 2>&1 || true
docker image inspect -f '  WorkingDir:{{.Config.WorkingDir}}' "$IMAGE_TAG" 2>&1 || true

step "1. docker run 本身能不能跑起来"
if run_check "最简命令（echo ok）" 'echo ok'; then
  printf '  \033[32m✓\033[0m docker run 可用\n'
else
  printf '  \033[31m✗\033[0m docker run 都跑不起来 —— 后面所有检查都会跟着失败，问题不在检查项本身\n'
fi

step "2. docker-deploy.sh 的四个检查项，逐条跑"
run_check "A. maintenance.service.js" 'test -f /app/backend/dist/maintenance/maintenance.service.js'
run_check "B. removeAutoAddedFramesFromRotation" 'grep -rqF "removeAutoAddedFramesFromRotation" /app/backend/dist'
run_check "C. /app/public/assets" 'test -f /app/public/assets'
run_check "D. slideshowItemHint" 'grep -rqF "slideshowItemHint" /app/public/assets'

step "3. 出问题的那条路径到底长什么样"
run_check "ls /app/public" 'ls -la /app/public'
run_check "ls /app/public/assets" 'ls -la /app/public/assets'
run_check "test -d /app/public/assets" 'test -d /app/public/assets && echo "是目录"'
run_check "test -e /app/public/assets" 'test -e /app/public/assets && echo "存在"'
run_check "readlink /app/public/assets" 'readlink -f /app/public/assets 2>&1 || echo "（不是符号链接）"'

printf '\n\033[1m完成。把上面全部输出贴回来即可。\033[0m\n\n'