#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# ScreenPlay — 产物自查（在 build 阶段末尾执行，构建失败比部署失败便宜得多）
#
# 为什么需要它：
#   「镜像里还是旧代码」是这类项目最难排查的一类问题 —— 容器起得来、健康检查
#   也过、页面也打得开，只是少一个标签页或一个按钮。原因往往是构建缓存命中了
#   旧的 COPY 层、或某个 workspace 的 build 静默失败了。等到部署完再发现，就得
#   重新走一遍构建 + 重启。
#
#   这里在镜像里、构建成功的那一刻，直接检查**编译产物**（backend/dist 与
#   web/dist）里有没有本轮功能必须存在的符号。没有就立刻让构建失败，并打印
#   缺了哪一项、该看哪个文件。
#
# 用法（由 Dockerfile 调用，也可在容器内手动跑）：
#   sh scripts/verify-build-artifacts.sh            # 默认 /app
#   APP_DIR=/app sh scripts/verify-build-artifacts.sh
#
# 退出码：0 = 全部命中；1 = 有缺失（构建应当失败）。
# ═════════════════════════════════════════════════════════════════════════════

set -eu

APP_DIR="${APP_DIR:-/app}"
BACKEND_DIST="$APP_DIR/backend/dist"
WEB_DIST="$APP_DIR/web/dist"

pass=0
fail=0

ok()   { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; pass=$((pass + 1)); }
bad()  { printf '\033[1;31m  ✗\033[0m %s\n' "$*"; fail=$((fail + 1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# 在编译产物里找一个固定字符串。
# 用 grep -F（固定字符串）而不是正则：产物经过压缩，正则容易被吞。
expect_in_file() {
  _file="$1"; _needle="$2"; _why="$3"
  if [ ! -f "$_file" ]; then
    bad "$(basename "$_file") 不存在（$_why）"
    return
  fi
  if grep -qF -- "$_needle" "$_file"; then
    ok "$(basename "$_file") 含 $_why"
  else
    bad "$(basename "$_file") 缺少 $_why —— 产物像是旧的（构建缓存命中？）"
  fi
}

# ─── 搜索 *.js 时**不能**用 grep --include ───────────────────────────────────
# 本脚本在镜像**构建阶段**运行，那时镜像是 Alpine，grep 来自 busybox
# （Dockerfile 只装了 python3/make/g++/git/ffmpeg，没有装 grep 包）。
# 而 busybox 的 grep **不支持 --include**：
#
#     grep: unrecognized option '--include=*.js'
#
# 它随即以非 0 退出，于是下面每一条断言都被判成「缺失」。原先那句
# 2>/dev/null 又把这唯一的线索吞掉了 —— 症状就变成「前端产物全缺，
# 可产物明明好端端的」，而打印出来的提示还指向「前端没有重新构建」，
# 把人往完全错误的方向带。
#
# 这个坑以前一直没暴露，是因为脚本也在 NAS 上手工跑过 —— 那是 GNU grep，
# 支持 --include。同一个脚本在两种 grep 下行为不同，只在容器里才现形。
#
# 改用 find + xargs（POSIX 与 BusyBox 通吃）：
#   · -Fl         一份文件命中即可，退出码语义明确
#   · -e "$2"     避免符号以 - 开头时被当成选项
#   · 不用 -q     这里只是风格统一，**不是**因为 -q 有问题：实测 busybox
#                 的 -rqF/-rlF 在有/无 --include 时表现一致，去掉 -q 并不能
#                 救回原来那条命令。真正的病根只有 --include 一个。
search_js() {
  find "$1" -type f -name '*.js' -print0 2>/dev/null \
    | xargs -0 grep -Fl -e "$2" 2>/dev/null >/dev/null
}

# 在一棵目录里（含所有 .js，压缩产物在内）找固定字符串。
expect_in_tree() {
  _dir="$1"; _needle="$2"; _why="$3"
  if [ ! -d "$_dir" ]; then
    bad "$_dir 不存在（$_why）"
    return
  fi
  if search_js "$_dir" "$_needle"; then
    ok "web 产物含 $_why"
  else
    bad "web 产物缺少 $_why —— 前端没有重新构建"
  fi
}

head_ "== 1. 目录存在性 =="
[ -f "$BACKEND_DIST/main.js" ] && ok "backend/dist/main.js 存在" \
  || bad "backend/dist/main.js 不存在（nest build 没跑成功？）"
[ -f "$WEB_DIST/index.html" ] && ok "web/dist/index.html 存在" \
  || bad "web/dist/index.html 不存在（vite build 没跑成功？）"

# 这一条最容易被忽略：后端靠 WEB_DIST 指到这个目录来服务前端，
# 目录空着容器也能起来，只是页面 404。
if [ -f "$WEB_DIST/index.html" ] && [ -d "$WEB_DIST/assets" ]; then
  ok "web/dist/assets 存在（前端静态资源已产出）"
else
  bad "web/dist/assets 缺失（前端产物不完整，容器起来后页面会 404）"
fi

head_ "== 2. 本轮功能（媒体评价）在后端产物里 =="
expect_in_file "$BACKEND_DIST/games/games.controller.js" \
  "backfill-ratings" "批量补全路由 backfill-ratings"
expect_in_file "$BACKEND_DIST/games/games.controller.js" \
  "media-reviews" "媒体评价面板路由 media-reviews"
expect_in_file "$BACKEND_DIST/games/media-reviews.service.js" \
  "media_reviews" "媒体评价表名 media_reviews"
expect_in_file "$BACKEND_DIST/metadata/providers/metacritic-reviews.js" \
  "__NEXT_DATA__" "页面内嵌 JSON 解析策略（__NEXT_DATA__）"
expect_in_file "$BACKEND_DIST/metadata/providers/metacritic-reviews.js" \
  "isPlausibleOutlet" "媒体名合理性校验"
# 符号名跟着实现走：`ensureRotationFloor`（兜底把相册截图填满轮播）已按需求 21
# 改为 `ensureCoverInRotation`（只保证封面在轮播里，其余一律等用户勾选）。
# 这里检的是「产物是新的」，所以必须盯当前符号名，否则每次改名都会假报缺失。
expect_in_file "$BACKEND_DIST/maintenance/maintenance.service.js" \
  "ensureCoverInRotation" "启动期封面轮播修复"
expect_in_file "$BACKEND_DIST/maintenance/maintenance.service.js" \
  "backfillDurations" "启动期通关时长补全"

head_ "== 3. 本轮功能（媒体评价）在前端产物里 =="
expect_in_tree "$WEB_DIST" "media-reviews-panel" "媒体评价面板挂载点"
expect_in_tree "$WEB_DIST" "media-review-outlet" "媒体名称渲染"
expect_in_tree "$WEB_DIST" "media-review-score" "媒体打分渲染"
expect_in_tree "$WEB_DIST" "media-review-text" "媒体评价原文渲染"
expect_in_tree "$WEB_DIST" "backfill-media-reviews" "设置页补全按钮"

head_ "== 4. 前端产物里要有中文文案（确认 i18n 打进去了）=="
expect_in_tree "$WEB_DIST" "媒体评价" "「媒体评价」标签文案"
expect_in_tree "$WEB_DIST" "暂无媒体评价" "空状态文案"

printf '\n\033[1m结果：%s 项命中 / %s 项缺失\033[0m\n' "$pass" "$fail"
if [ "$fail" -gt 0 ]; then
  printf '\033[1;31m产物自查未通过 —— 镜像里会有旧代码，构建中止。\033[0m\n'
  printf '排查：1) 确认源码已提交到构建上下文（.dockerignore 是否误排除了 backend/ 或 web/）\n'
  printf '      2) 用 scripts/docker-build.sh --no-cache 重建\n'
  exit 1
fi
printf '\033[1;32m产物自查通过 —— 镜像里确定包含本轮功能。\033[0m\n'