#!/usr/bin/env bash
# =============================================================================
# ScreenPlay — 一键「重建镜像 + 重启容器 + 体检」
#
# 用法（在 NAS 宿主机上，需要 docker 组权限）：
#
#     bash scripts/rebuild-and-verify.sh
#
# 可选环境变量：
#     NO_CACHE=1    强制无缓存构建（怀疑产物是旧的时候用）
#     PORT=3001     健康检查端口
#     SKIP_VERIFY=1 只重建重启，不做体检
#
# 输出同时写进 logs/rebuild-<时间戳>.log，出问题直接把那个文件贴出来即可。
#
# 为什么要有这个脚本：
#   `docker-build.sh` 与 `docker-deploy.sh` 分开跑时，最容易出的事是**构建成功但忘了
#   部署**（或反之）—— 容器于是继续跑旧镜像，而页面看起来一切正常。这里把两步串起来，
#   并在最后用 feature 标记回答那个唯一重要的问题：**跑的是不是新镜像**。
#
#   feature 标记是唯一可靠的判据：`buildTime` 恒为 "dev"（Dockerfile 没注入
#   BUILD_TIME），`.source-hash` 只能在镜像内比对。features 列表一定跟着镜像走。
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-3001}"
BASE="http://127.0.0.1:${PORT}"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG_DIR="$ROOT/logs"
LOG="$LOG_DIR/rebuild-$STAMP.log"

# 本轮新增的 feature 标记。出现这些 = 镜像里有本轮修复。
EXPECTED_FEATURES=(
  # 第十轮：两套轮播拆分（勾选/开关只管首页卡片；详情页大图 = 全部官方海报恒定自动）。
  # `poster-rotation-cover-only` / `poster-rotation-user-decided` / `card-arrows-need-slideshow`
  # 三个旧标记已退役（封面改为结构性、开关与标记改名），继续期待它们只会让体检假失败。
  card-rotation-user-ticks
  card-rotation-cover-always
  card-rotation-user-decided
  hero-rotation-all-official
  card-carousel-vs-hero-carousel
  card-arrows-need-slideshow-mode
  # 第十轮：设置页「修改密码」（接口 + 界面）。缺任意一条都说明镜像不是这一版。
  password-change-api
  password-change-ui
  review-pagination
  # 0.6.2：评价抓全的第二层修复 + 平台切换。缺了这两条就说明镜像不是这一版。
  review-listing-fallback
  review-platform-filter
  # 0.6.3：评价改走官方 JSON 接口（HTML 里已经没有可翻页的评价列表）+ 卡片箭头跟随
  # 展现模式。缺了这两条，说明容器跑的仍是 0.6.2 —— 那个版本在这个站点形态下抓不到
  # 完整评价（这正是「怎么修都只有一条」的原因）。
  reviews-api-source
  # 0.6.4：详情页评分区与评价面板的三处界面改动（去掉用户评分列 / 搜索+排序 / 点页码跳页）。
  ratings-no-user-score
  reviews-ui-search-sort
  reviews-page-jump
)

mkdir -p "$LOG_DIR" && chmod 755 "$LOG_DIR" 2>/dev/null

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
info() { printf '  \033[36m·\033[0m %s\n' "$1"; }
step() { printf '\n\033[1m[%s] %s\033[0m\n' "$1" "$2"; }

# 所有输出同时进日志文件。用 tee -a 而不是重定向，保持终端可见。
run_logged() {
  "$@" 2>&1 | tee -a "$LOG"
  return "${PIPESTATUS[0]}"   # tee 的退出码恒为 0，必须取管道里命令的那个
}

printf '\n\033[1mScreenPlay 重建 + 重启 + 体检\033[0m\n'
info "日志：$LOG"
info "代码：$(git -c safe.directory='*' log --oneline -1 2>/dev/null || echo '（非 git 目录）')"

{
  echo "=== rebuild-and-verify $STAMP ==="
  echo "commit: $(git -c safe.directory='*' log --oneline -1 2>/dev/null)"
} >> "$LOG"

# ---------------------------------------------------------------------------
step 1/4 "环境预检"

if ! docker info >/dev/null 2>&1; then
  bad "连不上 Docker daemon（当前用户不在 docker 组？）"
  info "确认：groups | grep docker   —— 没有的话需要以 root 执行 usermod -aG docker \$USER 后重新登录"
  exit 1
fi
ok "Docker daemon 可访问"

for f in scripts/docker-build.sh scripts/docker-deploy.sh; do
  if [ ! -f "$ROOT/$f" ]; then bad "缺少 $f"; exit 1; fi
done
ok "构建/部署脚本齐全"

if [ -n "$(git -c safe.directory='*' status --porcelain 2>/dev/null)" ]; then
  warn "工作区有未提交改动 —— 构建会包含它们（通常无妨，只是提醒）"
fi

# 记录构建前的容器启动时刻，稍后用来确认「真的换了容器」
OLD_STARTED="$(docker inspect -f '{{.State.StartedAt}}' screenplay 2>/dev/null || echo '')"
OLD_IMAGE="$(docker inspect -f '{{.Image}}' screenplay 2>/dev/null || echo '')"
[ -n "$OLD_STARTED" ] && info "当前容器启动于：$OLD_STARTED" || info "当前没有名为 screenplay 的容器"

# ---------------------------------------------------------------------------
step 2/4 "重建镜像（docker-build.sh）"

BUILD_ARGS=()
[ "${NO_CACHE:-0}" = "1" ] && BUILD_ARGS+=(--no-cache)

if run_logged bash "$ROOT/scripts/docker-build.sh" "${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}"; then
  ok "镜像构建成功"
else
  bad "镜像构建失败 —— 看上面最后一段输出（产物自查 / 源码指纹 / apk / npm）"
  info "完整日志：$LOG"
  exit 1
fi

# ---------------------------------------------------------------------------
step 3/4 "重建并重启容器（docker-deploy.sh）"

# 必须 force-recreate：compose 里的 /media 映射改过（现在指向真实相册目录），
# 只 restart 不会换挂载。
if run_logged bash "$ROOT/scripts/docker-deploy.sh"; then
  ok "容器已重建"
else
  bad "容器重建失败"
  info "完整日志：$LOG"
  exit 1
fi

NEW_STARTED="$(docker inspect -f '{{.State.StartedAt}}' screenplay 2>/dev/null || echo '')"
NEW_IMAGE="$(docker inspect -f '{{.Image}}' screenplay 2>/dev/null || echo '')"
if [ -n "$OLD_STARTED" ] && [ "$NEW_STARTED" = "$OLD_STARTED" ]; then
  warn "容器启动时刻没变 —— 可能并没有真的重建（检查 docker-deploy.sh 的输出）"
else
  ok "容器启动时刻已更新：$NEW_STARTED"
fi
if [ -n "$OLD_IMAGE" ] && [ "$OLD_IMAGE" = "$NEW_IMAGE" ] && [ -n "$NEW_IMAGE" ]; then
  info "容器用的镜像 ID 未变（不是问题：同 tag 重建仍可能复用同一个 image id 的层）"
fi

[ "${SKIP_VERIFY:-0}" = "1" ] && { printf '\n完成（SKIP_VERIFY=1，跳过体检）\n'; exit 0; }

# ---------------------------------------------------------------------------
step 4/4 "体检"

# 等健康检查就绪（启动期修复是异步的，这里只等 HTTP 起来）
info "等待 $BASE/api/health 就绪…"
ready=0
for _ in $(seq 1 60); do
  if curl -sf -m 5 "$BASE/api/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done

if [ "$ready" != "1" ]; then
  bad "健康检查在 120s 内没有就绪"
  info "容器日志：docker compose logs --tail 80 screenplay"
  exit 1
fi
ok "健康检查就绪"

HEALTH="$(curl -s -m 10 "$BASE/api/health" 2>/dev/null)"
FEATURES="$(printf '%s' "$HEALTH" | python3 -c 'import sys,json;print("\n".join(json.load(sys.stdin).get("features",[])))' 2>/dev/null)"

if [ -z "$FEATURES" ]; then
  bad "读不到 features 列表（health 返回异常）"
  info "$HEALTH"
else
  missing=0
  printf '  \033[1m预期 feature 标记：\033[0m\n'
  for f in "${EXPECTED_FEATURES[@]}"; do
    if printf '%s\n' "$FEATURES" | grep -qx "$f"; then
      printf '    \033[32m✓\033[0m %s\n' "$f"
    else
      printf '    \033[31m✗\033[0m %s  ← 缺失\n' "$f"
      missing=$((missing + 1))
    fi
  done

  if [ "$missing" -eq 0 ]; then
    ok "这是新镜像（预期 ${#EXPECTED_FEATURES[@]} 个标记全部存在）"
  else
    bad "有 $missing 个标记缺失 —— 容器跑的不是本轮镜像"
    info "常见原因：构建产物被旧镜像覆盖 / 部署时用了旧 tag / 构建缓存。"
    info "试试：NO_CACHE=1 bash scripts/rebuild-and-verify.sh"
  fi
fi

# 版本号：1.2.0 的 features 列表与 1.0.0 完全相同（本轮改动全在前端产物与桌面端，
# 后端没有新增标记），所以「跑的是不是 1.2.0」只能看 version 字段，标记查不出来。
VERSION_OUT="$(printf '%s' "$HEALTH" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("version",""))' 2>/dev/null || true)"
if [ -n "$VERSION_OUT" ]; then
  if [ "$VERSION_OUT" = "1.2.0" ]; then
    ok "版本号：$VERSION_OUT"
  else
    info "版本号是 $VERSION_OUT（期望 1.2.0）—— 若这是旧镜像请重建；若你刻意跑的是别的版本可忽略"
  fi
else
  info "读不到 version 字段（health 返回异常？）"
fi

# 启动期清理的证据。旧规则已经写进库的相册帧要在这里被摘出去。
printf '\n  \033[1m启动期修复日志：\033[0m\n'
MAINT="$(docker compose logs screenplay 2>/dev/null | grep -E "cover rotation repaired|auto-added album frames removed|Boot maintenance" | tail -5)"
if [ -n "$MAINT" ]; then
  printf '%s\n' "$MAINT" | sed 's/^/    /'
  if printf '%s' "$MAINT" | grep -q "cover rotation repaired"; then
    ok "启动期修复用的是新措辞（cover rotation repaired），不是旧的 topped up"
    PURGED="$(printf '%s' "$MAINT" | grep -oE 'auto-added album frames removed: [0-9]+' | grep -oE '[0-9]+' | tail -1)"
    [ -n "$PURGED" ] && info "已从轮播里摘出的旧规则自动补帧：$PURGED 张"
  else
    warn "只看到旧措辞（poster rotation topped up）—— 可能是重启前的历史日志"
  fi
else
  warn "没找到启动期修复日志（MAINTENANCE_ON_BOOT=0？或日志已被轮转）"
fi

printf '\n\033[1m完成。\033[0m完整日志：%s\n' "$LOG"
printf '有问题把上面这段（或日志文件）贴出来即可。\n\n'