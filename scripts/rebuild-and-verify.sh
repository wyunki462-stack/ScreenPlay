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
step 1/5 "环境预检"

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
step 2/5 "重建镜像（docker-build.sh）"

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
step 3/5 "重建并重启容器（docker-deploy.sh）"

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
step 4/5 "体检"

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

# 版本号：1.2.0 起 features 标记就不随版本变了（1.3.0 的性能优化全在内部实现与构建配置，
# 后端没有新增标记），所以「跑的是不是这一版」只能看 version 字段，标记查不出来。
VERSION_OUT="$(printf '%s' "$HEALTH" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("version",""))' 2>/dev/null || true)"
if [ -n "$VERSION_OUT" ]; then
  if [ "$VERSION_OUT" = "1.3.0" ]; then
    ok "版本号：$VERSION_OUT"
  else
    info "版本号是 $VERSION_OUT（期望 1.3.0）—— 若这是旧镜像请重建；若你刻意跑的是别的版本可忽略"
  fi
else
  info "读不到 version 字段（health 返回异常？）"
fi

# 启动期维护的证据：旧规则已经写进库的相册帧要在这里被摘出去，本轮还加了缓存/垃圾文件回收。
#
# 1.2.0 的实际措辞（`backend/src/maintenance/maintenance.service.ts:164-175`）：
#   有活干活时 —— `Boot maintenance finished in Xs — auto-added frames removed from the card
#   rotation: N; completion-time backfill …; caches reclaimed: R expired cache row(s), F stale file(s) (B).`
#   无事可做时 —— `Boot maintenance finished in Xs — nothing to repair.`
# 这里按实际措辞断言（旧的 `cover rotation repaired` / `auto-added album frames removed` 已不存在，
# 照旧写只会每次都误报「只看到旧措辞」）。
printf '\n  \033[1m启动期维护日志：\033[0m\n'
MAINT="$(docker compose logs screenplay 2>/dev/null | grep -E 'Boot maintenance|auto-added frames removed from the card rotation|caches reclaimed|poster rotation topped up' | tail -5)"
if [ -n "$MAINT" ]; then
  printf '%s\n' "$MAINT" | sed 's/^/    /'
  if printf '%s' "$MAINT" | grep -q 'auto-added frames removed from the card rotation'; then
    ok "启动期清理用的是新措辞（auto-added frames removed from the card rotation），不是旧的 topped up"
    PURGED="$(printf '%s' "$MAINT" | grep -oE 'auto-added frames removed from the card rotation: [0-9]+' | grep -oE '[0-9]+' | tail -1)"
    [ -n "$PURGED" ] && info "已从轮播里摘出的旧规则自动补帧：$PURGED 张"
    RECLAIM="$(printf '%s' "$MAINT" | grep -oE 'caches reclaimed: [0-9]+ expired cache row\(s\), [0-9]+ stale file\(s\)' | tail -1)"
    [ -n "$RECLAIM" ] && ok "缓存回收（本轮新增）：$RECLAIM"
  elif printf '%s' "$MAINT" | grep -q 'nothing to repair'; then
    info "本次启动没有需要修复的行（nothing to repair）—— 正常：库里状态本来就干净"
  else
    warn "只看到旧措辞（poster rotation topped up）—— 可能是重启前的历史日志"
  fi
else
  info "没找到启动期维护日志（MAINTENANCE_ON_BOOT=0？或日志已被轮转，可 docker compose logs screenplay | tail）"
fi

# 前端产物投递：本轮性能优化把「运行期现压」换成了「构建期预压缩 + 长缓存」。
# 这里断言的是**投递行为**（有没有 Content-Encoding / 缓存头对不对），不是体积数字 ——
# 体积数字看 docs/perf/after-docker.txt。
step 5/5 "前端产物投递（预压缩 + 静态长缓存）"

HTML_BODY="$(curl -s -m 10 "$BASE/" 2>/dev/null)"
ENTRY_JS="$(printf '%s' "$HTML_BODY" | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)"

if [ -z "$ENTRY_JS" ]; then
  warn "没从首页 HTML 里找到 /assets/index-*.js —— 跳过投递检查"
else
  info "首屏 entry：$ENTRY_JS"
  HDR="$(curl -s -o /dev/null -D - -m 10 -H 'Accept-Encoding: gzip' "$BASE$ENTRY_JS" 2>/dev/null)"
  CE="$(printf '%s' "$HDR" | grep -i '^content-encoding:' | tr -d '\r' | awk '{print $2}')"
  CL="$(printf '%s' "$HDR" | grep -i '^content-length:' | tr -d '\r' | awk '{print $2}')"
  CC="$(printf '%s' "$HDR" | grep -i '^cache-control:' | tr -d '\r' | cut -d' ' -f2-)"
  RAW="$(curl -s -o /dev/null -w '%{size_download}' -m 10 "$BASE$ENTRY_JS" 2>/dev/null)"

  case "$CE" in
    br|gzip) ok "预压缩生效：Content-Encoding: $CE，传输 ${CL:-?} 字节（未压缩 ${RAW:-?} 字节）" ;;
    "")      warn "没有 Content-Encoding —— 镜像里可能没有 .br/.gz（构建期预压缩没跑？）" ;;
    *)       info "Content-Encoding: $CE" ;;
  esac
  case "$CC" in
    *immutable*) ok "entry 缓存头：$CC" ;;
    "")          warn "读不到 entry 的 Cache-Control（静态中间件没生效？）" ;;
    *)           warn "entry 缓存头不是 immutable：$CC" ;;
  esac
  if [ -n "$CL" ] && [ -n "$RAW" ] && [ "$RAW" -gt "$CL" ] 2>/dev/null; then
    ok "不压缩回落正确：无 Accept-Encoding 时返回 $RAW 字节"
  fi
fi

HTML_CC="$(curl -s -o /dev/null -D - -m 10 "$BASE/" 2>/dev/null | grep -i '^cache-control:' | tr -d '\r' | cut -d' ' -f2-)"
case "$HTML_CC" in
  *no-cache*) ok "index.html 缓存头：$HTML_CC（重新部署后能拿到新版本）" ;;
  "")         warn "读不到 index.html 的 Cache-Control" ;;
  *)          warn "index.html 缓存头应为 no-cache，实际：$HTML_CC" ;;
esac

printf '\n\033[1m完成。\033[0m完整日志：%s\n' "$LOG"
printf '有问题把上面这段（或日志文件）贴出来即可。\n\n'