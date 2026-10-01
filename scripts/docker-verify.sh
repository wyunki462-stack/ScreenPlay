#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# ScreenPlay — 容器内自检（只用 docker 命令）
#
# 回答三个问题，全部在容器里完成，宿主机不需要 node / npm：
#   A. 这个镜像里的代码，解析器功能对不对？（离线夹具，不联网）
#   B. 正在运行的部署，媒体评价接口通不通？
#   C. 前端产物里有没有「媒体评价」这块界面？
#
# 用法：
#   bash scripts/docker-verify.sh                     # 对着运行中的部署自检
#   bash scripts/docker-verify.sh --container 名字     # 指定容器名（默认 screenplay）
#   bash scripts/docker-verify.sh --offline-only      # 只做 A + C（不碰运行中的部署）
#   bash scripts/docker-verify.sh --proxy http://host.docker.internal:7890
#
# 退出码：0 = 全部通过；1 = 有失败项。
# ═════════════════════════════════════════════════════════════════════════════

set -uo pipefail   # 注意：不开 -e。自检脚本要跑完所有项再汇总，中途退出会丢信息。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

CONTAINER="screenplay"
IMAGE_TAG="${IMAGE_TAG:-screenplay:latest}"
OFFLINE_ONLY=0
PROXY_ARGS=()

pass=0
fail=0
skip=0

ok()   { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; pass=$((pass + 1)); }
bad()  { printf '\033[1;31m  ✗\033[0m %s\n' "$*"; fail=$((fail + 1)); }
note() { printf '\033[1;33m  ·\033[0m %s\n' "$*"; skip=$((skip + 1)); }
step() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --container)   CONTAINER="${2:?}"; shift 2 ;;
    --image)       IMAGE_TAG="${2:?}"; shift 2 ;;
    --proxy)       PROXY_ARGS=(--proxy "${2:?}"); shift 2 ;;
    --offline-only) OFFLINE_ONLY=1; shift ;;
    -h|--help)     sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)             printf '未知参数: %s\n' "$1" >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { printf '找不到 docker\n' >&2; exit 2; }
docker info >/dev/null 2>&1 || {
  printf '无法连接 Docker daemon（当前用户不在 docker 组？）\n' >&2
  printf '  sudo usermod -aG docker %s  然后重新登录\n' "$(id -un)" >&2
  exit 2
}

# 镜像必须存在（自检 A/C 都在镜像里跑）
if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  printf '本地没有镜像 %s，先跑 bash scripts/docker-deploy.sh\n' "$IMAGE_TAG" >&2
  exit 2
fi

# ─────────────────────────────────────────────────────────────────────────────
step "A. 解析器离线自检（镜像内夹具，不联网）"
# ─────────────────────────────────────────────────────────────────────────────
# 夹具与测试脚本都在镜像的 /app/backend 下（Dockerfile 的 COPY backend backend 会
# 把它们一起带进去）。跑在一次性容器里，用 /tmp 当数据目录，不碰真实卷。
A_OUT="$(docker run --rm --entrypoint sh "$IMAGE_TAG" -c \
  'cd /app/backend && node scripts/verify/metacritic-reviews-test.mjs 2>&1 && echo "--- api ---" && node scripts/verify/metacritic-api-test.mjs 2>&1' 2>&1)"
A_RC=$?
A_TAIL="$(printf '%s' "$A_OUT" | grep -E '结果|失败|✗' | tail -6)"

if [ "$A_RC" -eq 0 ]; then
  ok "解析器测试通过：$(printf '%s' "$A_OUT" | grep -oE '[0-9]+ 项通过 / [0-9]+ 项失败' | tail -1)"
  ok "官方接口解析测试通过：$(printf '%s' "$A_OUT" | grep -oE '[0-9]+ 项通过 / [0-9]+ 项失败' | head -1)"
else
  bad "解析器测试未通过（exit=$A_RC）"
  printf '%s\n' "$A_TAIL" | sed 's/^/     /'
fi

# ─────────────────────────────────────────────────────────────────────────────
step "B. 运行中的部署：媒体评价接口"
# ─────────────────────────────────────────────────────────────────────────────
if [ "$OFFLINE_ONLY" = 1 ]; then
  note "按 --offline-only 跳过"
elif ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  note "容器 $CONTAINER 不存在，跳过（用 --container 指定名字）"
else
  # 端口从容器映射里读，避免猜
  HOST_PORT="$(docker inspect -f \
    '{{range $p, $conf := .NetworkSettings.Ports}}{{range $conf}}{{.HostPort}}{{end}}{{end}}' \
    "$CONTAINER" 2>/dev/null | head -c 5)"
  HOST_PORT="${HOST_PORT:-3001}"
  BASE="http://127.0.0.1:${HOST_PORT}"

  # 在容器内用 node 发请求，避免依赖宿主机的 curl
  api() {
    docker exec "$CONTAINER" node -e "
      const [url, method, body] = process.argv.slice(1);
      (async () => {
        try {
          const r = await fetch(url, {
            method,
            headers: body ? { 'content-type': 'application/json' } : undefined,
            body: body || undefined,
          });
          const t = await r.text();
          console.log(JSON.stringify({ status: r.status, body: t.slice(0, 400) }));
        } catch (e) { console.log(JSON.stringify({ status: 0, body: String(e.message) })); }
      })();
    " "$1" "${2:-GET}" "${3:-}" 2>/dev/null | tail -1
  }

  # 认证开启时这些接口会 401 —— 那不是功能问题，明确区分开。
  H="$(docker exec "$CONTAINER" node -e "
    fetch('http://127.0.0.1:3000/api/health').then(r=>r.json()).then(d=>console.log(JSON.stringify(d))).catch(e=>console.log('{}'))
  " 2>/dev/null | tail -1)"
  if printf '%s' "$H" | grep -q '"status"'; then
    ok "健康检查通过：$(printf '%s' "$H" | head -c 120)"
  else
    bad "健康检查失败：$(printf '%s' "$H" | head -c 120)"
  fi

  COV="$(api 'http://127.0.0.1:3000/api/games/media-reviews/coverage')"
  CSTAT="$(printf '%s' "$COV" | sed -n 's/.*"status":\([0-9]*\).*/\1/p')"
  case "$CSTAT" in
    200)
      ok "覆盖率接口可用：$(printf '%s' "$COV" | grep -oE '"awaiting":[0-9]+|"total":[0-9]+|"withReviews":[0-9]+' | tr '\n' ' ')"
      ;;
    401)
      note "覆盖率接口返回 401（部署开启了登录，属预期；登录后再看即可）"
      ;;
    *)
      bad "覆盖率接口异常：HTTP ${CSTAT:-?} $(printf '%s' "$COV" | head -c 160)"
      ;;
  esac

  # 任取一个游戏，验证详情接口里带 mediaReviews / mediaReviewsSummary 字段
  GAMES="$(api 'http://127.0.0.1:3000/api/games?pageSize=1')"
  GID="$(printf '%s' "$GAMES" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)"
  if [ -n "$GID" ]; then
    DET="$(api "http://127.0.0.1:3000/api/games/$GID")"
    if printf '%s' "$DET" | grep -q 'mediaReviews'; then
      ok "详情接口含 mediaReviews / mediaReviewsSummary（游戏 $GID）"
      printf '%s' "$DET" | grep -oE '"mediaReviewsSummary":\{[^}]*\}' | head -1 | sed 's/^/     /'
    elif printf '%s' "$DET" | grep -q '"status":401'; then
      note "详情接口 401（部署开启了登录，属预期）"
    else
      bad "详情接口里没有 mediaReviews 字段（旧镜像？）"
    fi

    MR="$(api "http://127.0.0.1:3000/api/games/$GID/media-reviews")"
    if printf '%s' "$MR" | grep -q '"reviews"'; then
      ok "面板读接口可用：$(printf '%s' "$MR" | grep -oE '"reviews":\[[^]]{0,60}' | head -c 80)"
    elif printf '%s' "$MR" | grep -q '"status":401'; then
      note "面板读接口 401（属预期）"
    else
      bad "面板读接口异常：$(printf '%s' "$MR" | head -c 160)"
    fi
  else
    note "库里还没有游戏（或接口 401），跳过详情/面板接口检查"
  fi

  # 批量补全路由必须存在。这里传 limit:0 —— 既验证了路由与鉴权，
  # 又不会真的去抓任何一个游戏（0 个候选）。
  BF="$(api 'http://127.0.0.1:3000/api/games/backfill-ratings' POST '{"scope":"missing","limit":0}')"
  BSTAT="$(printf '%s' "$BF" | sed -n 's/.*"status":\([0-9]*\).*/\1/p')"
  if printf '%s' "$BF" | grep -q '"results"\|"remaining"\|"processed"'; then
    ok "批量补全路由存在（limit:0 空跑，未抓取任何页面）"
  elif [ "$BSTAT" = 401 ] || [ "$BSTAT" = 403 ]; then
    note "批量补全路由存在但需要登录（HTTP $BSTAT，属预期）"
  else
    bad "批量补全路由异常：HTTP ${BSTAT:-?} $(printf '%s' "$BF" | head -c 160)"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
step "C. 前端产物里有没有「媒体评价」界面"
# ─────────────────────────────────────────────────────────────────────────────
if docker run --rm --entrypoint sh "$IMAGE_TAG" -c \
     'grep -rqF "media-reviews-panel" /app/public/assets && grep -rqF "媒体评价" /app/public/assets && grep -rqF "暂无媒体评价" /app/public/assets'; then
  ok "前端产物含面板挂载点与「媒体评价」「暂无媒体评价」文案"
else
  bad "前端产物缺少媒体评价界面（旧镜像？用 docker-build.sh --no-cache 重建）"
fi

for t in media-review-outlet media-review-score media-review-text backfill-media-reviews; do
  if docker run --rm --entrypoint sh "$IMAGE_TAG" -c "grep -rqF '$t' /app/public/assets"; then
    ok "前端产物含 $t"
  else
    bad "前端产物缺少 $t"
  fi
done

# ─────────────────────────────────────────────────────────────────────────────
step "D. 启动期数据修复模块是否在镜像里"
# ─────────────────────────────────────────────────────────────────────────────
if docker run --rm --entrypoint sh "$IMAGE_TAG" -c \
     'test -f /app/backend/dist/maintenance/maintenance.service.js && grep -qF ensureRotationFloor /app/backend/dist/maintenance/maintenance.service.js && grep -qF backfillDurations /app/backend/dist/maintenance/maintenance.service.js'; then
  ok "镜像含 MaintenanceService（海报轮播下限 + 通关时长补全）"
else
  bad "镜像缺少 MaintenanceService —— 存量数据不会被自动修复"
fi

BUILD_INFO="$(docker run --rm --entrypoint sh "$IMAGE_TAG" -c 'cat /app/build-info.json 2>/dev/null || echo "{}"')"
if printf '%s' "$BUILD_INFO" | grep -q sourceHash; then
  ok "构建指纹：$(printf '%s' "$BUILD_INFO" | tr -d '\n ' | head -c 160)"
else
  note "镜像里没有 /app/build-info.json（旧镜像）"
fi

# ─────────────────────────────────────────────────────────────────────────────
step "结果"
# ─────────────────────────────────────────────────────────────────────────────
printf '  \033[1m%s 项通过 / %s 项失败 / %s 项跳过（跳过多为鉴权或环境不满足，非失败）\033[0m\n\n' \
  "$pass" "$fail" "$skip"
[ "$fail" -eq 0 ] || exit 1