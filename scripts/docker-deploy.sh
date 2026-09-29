#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# ScreenPlay — 一键部署（只用 Docker 命令，宿主机不需要 node / npm / 任何构建工具）
#
# 做四件事：
#   1) 构建镜像（复用 scripts/docker-build.sh 的代理注入 + 换源 + 产物自查）
#   2) 用该镜像重建容器（docker compose up -d --no-build）
#   3) 等健康检查通过，并确认「启动期数据修复」真的跑过
#   4) 打印指纹与状态摘要
#
# 用法：
#   bash scripts/docker-deploy.sh                 # 构建 + 部署 + 校验
#   bash scripts/docker-deploy.sh --no-build      # 只用现有镜像重建容器（跳过构建）
#   bash scripts/docker-deploy.sh --no-cache      # 无缓存重建（怀疑镜像里是旧代码时）
#   bash scripts/docker-deploy.sh --prune-cache   # 先清构建缓存再重建
#   bash scripts/docker-deploy.sh --tag v0.6      # 同时打一个带版本号的标签
#
# 环境变量：
#   DATASET_PORT / PORT   宿主机端口（默认取 .env 的 PORT，否则 3001）
#   HEALTH_TIMEOUT        等健康检查的秒数（默认 180）
#   SCREENPLAY_BUILD_PROXY 容器可达的构建期代理（交给 docker-build.sh）
#   COMPOSE_FILE          compose 文件（默认 docker-compose.yml）
#
# 退出码：0 = 已更新并可用；1 = 构建/启动/健康检查失败；2 = 用法或环境问题。
# ═════════════════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

IMAGE_TAG="${IMAGE_TAG:-screenplay:latest}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
DO_BUILD=1
VERSION_TAG=""
EXTRA_BUILD_ARGS=()

info() { printf '\033[1;34m[INFO]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[ OK ]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[WARN]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[ERRO]\033[0m %s\n' "$*"; }
step() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

usage() {
  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

# ─────────────────────────────────────────────────────────────────────────────
# 0. 前置检查
# ─────────────────────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build)    DO_BUILD=0; shift ;;
    --no-cache)    EXTRA_BUILD_ARGS+=(--no-cache); shift ;;
    --prune-cache) EXTRA_BUILD_ARGS+=(--prune-cache); shift ;;
    -t|--tag)      VERSION_TAG="${2:?--tag 需要一个值}"; shift 2 ;;
    -h|--help)     usage 0 ;;
    *)             err "未知参数: $1"; usage 2 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { err "找不到 docker 命令"; exit 2; }

# 先确认 daemon 真的能连上。这一步的报错信息比后面任何一步都清楚：
# 「permission denied ... docker.sock」= 当前用户不在 docker 组。
if ! docker info >/dev/null 2>&1; then
  err "无法连接 Docker daemon。"
  if docker info 2>&1 | grep -q 'permission denied'; then
    printf '  当前用户不在 docker 组里。修法（在 NAS 上执行一次）：\n'
    printf '    sudo usermod -aG docker %s\n' "$(id -un)"
    printf '  然后**重新登录**（或 newgrp docker）再跑本脚本。\n'
  else
    docker info 2>&1 | sed 's/^/  /' | head -5
  fi
  exit 2
fi

# compose v2 是 `docker compose`；老版是 `docker-compose`。
if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
  warn "使用旧版 docker-compose（建议升级到 compose v2）"
else
  err "找不到 docker compose（需要 compose v2，或 docker-compose）"
  exit 2
fi

[ -f "$COMPOSE_FILE" ] || { err "找不到 $COMPOSE_FILE"; exit 2; }

# 宿主机端口：优先环境变量 → .env 的 PORT → 3001
HOST_PORT="${PORT:-}"
if [ -z "$HOST_PORT" ] && [ -f .env ]; then
  HOST_PORT="$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*\([0-9]\{1,5\}\).*/\1/p' .env | tail -1)"
fi
HOST_PORT="${HOST_PORT:-3001}"

# ─────────────────────────────────────────────────────────────────────────────
step "1/4 构建镜像"
# ─────────────────────────────────────────────────────────────────────────────
if [ "$DO_BUILD" = 1 ]; then
  info "交给 scripts/docker-build.sh（自动探测容器可达代理 + 容器内真实换源 + 产物自查）"
  # --dry-run 之外的参数原样透传
  bash "$SCRIPT_DIR/docker-build.sh" -t "$IMAGE_TAG" ${EXTRA_BUILD_ARGS[@]+"${EXTRA_BUILD_ARGS[@]}"}
  ok "镜像已构建：$IMAGE_TAG"
else
  warn "按 --no-build 跳过构建，直接使用现有镜像 $IMAGE_TAG"
  docker image inspect "$IMAGE_TAG" >/dev/null 2>&1 || {
    err "本地没有镜像 $IMAGE_TAG，无法跳过构建。"
    exit 2
  }
fi

if [ -n "$VERSION_TAG" ]; then
  docker tag "$IMAGE_TAG" "$VERSION_TAG"
  ok "已同时打标签：$VERSION_TAG"
fi

# ─────────────────────────────────────────────────────────────────────────────
step "2/4 指纹校验（镜像里的源码是否与工作区一致）"
# ─────────────────────────────────────────────────────────────────────────────
# 镜像在 build 阶段把源码内容哈希写进了 /app/build-info.json；部署前把它读出来。
IMAGE_INFO="$(docker run --rm --entrypoint sh "$IMAGE_TAG" -c 'cat /app/build-info.json 2>/dev/null || echo "{}"')"
IMAGE_HASH="$(printf '%s' "$IMAGE_INFO" | sed -n 's/.*"sourceHash"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
IMAGE_BUILT="$(printf '%s' "$IMAGE_INFO" | sed -n 's/.*"builtAt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"

if [ -n "$IMAGE_HASH" ]; then
  ok "镜像指纹 sourceHash=$IMAGE_HASH（构建于 ${IMAGE_BUILT:-未知}）"
else
  warn "镜像里没有 /app/build-info.json（旧镜像？）——无法判断是否过期"
fi

# .source-hash 是仓库里跟源码一起提交的期望指纹。它不一致只说明「源码在生成
# 指纹之后又被改过」，不一定是错，所以只警告不中断。
if [ -f .source-hash ] && [ -n "$IMAGE_HASH" ]; then
  EXPECTED="$(tr -d '[:space:]' < .source-hash)"
  if [ "$EXPECTED" = "$IMAGE_HASH" ]; then
    ok "与仓库期望指纹一致（.source-hash）"
  else
    warn "与仓库期望指纹不一致：期望 $EXPECTED，镜像 $IMAGE_HASH"
    warn "  镜像仍然可用；但若你刚改过源码，请确认这次构建确实重跑了（可加 --no-cache）"
  fi
fi

# 镜像里是否有本轮功能的关键产物 —— 和 build 阶段那道自查互相印证，
# 用来兜住「宿主机上用了别的途径构建」的情形。
if docker run --rm --entrypoint sh "$IMAGE_TAG" -c \
     'test -f /app/backend/dist/maintenance/maintenance.service.js && test -f /app/public/assets && grep -rqF "media-reviews-panel" /app/public/assets'; then
  ok "镜像内含媒体评价前端产物 + 启动期修复模块"
else
  err "镜像里缺少本轮功能的产物（前端 media-reviews-panel 或 maintenance.service.js）"
  err "请用 scripts/docker-build.sh --no-cache 重建后重试。"
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
step "3/4 重建容器"
# ─────────────────────────────────────────────────────────────────────────────
info "docker compose up -d --no-build --force-recreate（复用上面构建好的镜像）"
"${DC[@]}" -f "$COMPOSE_FILE" up -d --no-build --force-recreate
ok "容器已重建"

# ─────────────────────────────────────────────────────────────────────────────
step "4/4 等待服务就绪 + 确认数据修复已执行"
# ─────────────────────────────────────────────────────────────────────────────
HEALTH_URL="http://127.0.0.1:${HOST_PORT}/api/health"
info "轮询 $HEALTH_URL（最多 ${HEALTH_TIMEOUT}s）"

# 用 curl；没有 curl 就用 wget。二者都没有时才退回只看 docker 的 health 状态。
probe_health() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -m 4 "$HEALTH_URL" >/dev/null 2>&1
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O /dev/null --tries=1 --timeout=4 "$HEALTH_URL" 2>/dev/null
  else
    # 没有 HTTP 客户端：用容器自己的健康状态近似
    [ "$(docker inspect -f '{{.State.Health.Status}}' screenplay 2>/dev/null)" = healthy ]
  fi
}

ready=0
for i in $(seq 1 "$HEALTH_TIMEOUT"); do
  if probe_health; then ready=1; break; fi
  if [ $((i % 15)) -eq 0 ]; then info "  已等待 ${i}s…"; fi
  sleep 1
done

if [ "$ready" = 1 ]; then
  ok "服务已就绪：$HEALTH_URL"
else
  err "等待 ${HEALTH_TIMEOUT}s 后仍未就绪。最近 40 行日志："
  "${DC[@]}" -f "$COMPOSE_FILE" logs --tail=40 screenplay | sed 's/^/  /'
  exit 1
fi

# 「存量数据回填」是否真的跑了：`MaintenanceService` 每次启动都会打印一行。
# 有这行 = 海报轮播下限确实被检查过；没有 = 容器可能跑的还是旧镜像。
sleep 2
LOGS="$("${DC[@]}" -f "$COMPOSE_FILE" logs --tail=300 screenplay 2>&1 || true)"

if printf '%s' "$LOGS" | grep -q 'Boot maintenance'; then
  printf '%s' "$LOGS" | grep 'Boot maintenance' | tail -1 | sed 's/^/  /'
  ok "启动期数据修复已执行（海报轮播 + 通关时长）"
else
  warn "日志里没有看到 'Boot maintenance' —— 可能："
  warn "  · 日志已被 --tail 截断（用 docker compose logs screenplay 看全量）"
  warn "  · 或镜像里还是旧代码（旧版没有这个模块）"
fi

if printf '%s' "$LOGS" | grep -q 'MAINTENANCE_ON_BOOT=0'; then
  warn "检测到 MAINTENANCE_ON_BOOT=0：启动期数据修复被显式关闭了"
fi

# 后端启动失败时给出的最常见原因，直接指出来
if printf '%s' "$LOGS" | grep -qiE 'EADDRINUSE|Cannot find module|Error:'; then
  warn "日志里出现了错误关键字，请检查："
  printf '%s' "$LOGS" | grep -iE 'EADDRINUSE|Cannot find module|Error:' | tail -5 | sed 's/^/  /'
fi

# ─────────────────────────────────────────────────────────────────────────────
step "完成"
# ─────────────────────────────────────────────────────────────────────────────
printf '  访问地址   : http://<NAS-IP>:%s\n' "$HOST_PORT"
printf '  镜像       : %s%s\n' "$IMAGE_TAG" "${VERSION_TAG:+ （同时标记为 $VERSION_TAG）}"
printf '  源码指纹   : %s\n' "${IMAGE_HASH:-未知}"
printf '  容器状态   : %s\n' "$(docker inspect -f '{{.State.Status}} / health={{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}' screenplay 2>/dev/null || echo 未知)"
echo
printf '  后续常用命令（全部只需 docker）：\n'
printf '    docker compose logs -f screenplay              # 跟踪日志\n'
printf '    docker compose restart screenplay              # 重启（会再跑一次启动期修复）\n'
printf '    docker inspect -f "{{.State.Health.Status}}" screenplay   # 健康状态\n'
printf '    bash scripts/docker-verify.sh                  # 容器内功能自检\n'
echo