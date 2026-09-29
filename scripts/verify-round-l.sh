#!/usr/bin/env bash
#
# 本轮三项需求的「真实浏览器」验收脚本。
#
#   需求1  游戏详情页 上一个 / 下一个 切换（含首尾循环、跟随图库筛选与排序、切换后置顶）
#   需求2  游戏详情页 官方海报轮播（大图区左右箭头、循环、计数；重新刮削不删用户配置）
#   需求3  HLTB 人均通关时长展示（含存量一键批量补全、空时长缓存缺陷、重试）
#   需求4  保护存量游戏手动修改的名称（manual_override）
#
# 与之前几轮的区别：**不再用 jsdom**。它起一个隔离实例（独立 DATA_DIR / MEDIA_DIRS /
# 端口），跑的是真正的构建产物（backend/dist + web/dist），然后用真实 Chromium 打开
# 页面、真实点击、真实取 DOM 尺寸与截图。jsdom 只能证明「组件逻辑对」，
# 证明不了「部署后页面上看得见」。
#
# 用法： bash scripts/verify-round-l.sh
# 全绿时自动清理现场；有失败则保留现场与截图便于排查。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-4401}"
BASE="http://127.0.0.1:${PORT}"
TMP="$ROOT/.tmp-round-l"
DATA="$TMP/data"
MEDIA="$TMP/media"
SHOTS="$TMP/shots"

# 真实数据源：本机可直连 RAWG/HLTB（不走代理，宿主机 host.docker.internal 在本机不可解析）
RAWG_KEY="${RAWG_API_KEY:-$(grep -E '^RAWG_API_KEY=' "$ROOT/.env" 2>/dev/null | cut -d= -f2)}"
CHROME="${CHROME_PATH:-$ROOT/.tmp-b/pw/chromium-1134/chrome-linux/chrome}"

# 夹具：中文目录名是有意为之 —— 需求点名「血源诅咒」，而且别名表 / 规范名
# 这条链路只有用中文名才会被真正走一遍。
FIXTURES=("血源诅咒" "赛博朋克2077" "艾尔登法环" "Hades" "宇宙机器人")

pass=0; fail=0
ok()   { printf '   \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '   \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
info() { printf '   %s\n' "$1"; }

stop() { [ -f "$TMP/pid" ] && { kill "$(cat "$TMP/pid")" 2>/dev/null || true; sleep 1; }; }
cleanup() {
  stop
  if [ "$fail" -eq 0 ]; then rm -rf "$TMP"; else printf '   现场保留在 %s（日志 %s/log，截图 %s）\n' "$TMP" "$TMP" "$SHOTS"; fi
}
trap cleanup EXIT

step 0 "构建"
if ! (cd "$ROOT" && npm run build) >"$TMP-build.log" 2>&1; then
  mkdir -p "$TMP"; mv "$TMP-build.log" "$TMP/build.log"
  bad "构建失败，详见 $TMP/build.log"; tail -12 "$TMP/build.log" | sed 's/^/    /'; fail=1; exit 1
fi
rm -f "$TMP-build.log"
ok "后端 dist + 前端 dist 构建通过"

# 构建产物里必须真的带上三项功能的代码（防「源码改了但产物是旧的」）
BUNDLE="$(ls "$ROOT"/web/dist/assets/index-*.js | head -1)"
for marker in hero-carousel nav-prev nav-next backfill-durations duration-coverage; do
  if grep -q "$marker" "$BUNDLE"; then ok "前端产物包含 $marker"; else bad "前端产物缺少 $marker（构建未生效）"; fi
done
if grep -q "duration-coverage" "$ROOT/backend/dist/games/games.controller.js"; then
  ok "后端产物包含 duration-coverage 路由"
else
  bad "后端产物缺少 duration-coverage 路由"
fi

step 1 "准备隔离实例"
rm -rf "$TMP"; mkdir -p "$DATA" "$MEDIA" "$SHOTS"
for f in "${FIXTURES[@]}"; do mkdir -p "$MEDIA/$f"; done
# 真实 PNG（ffmpeg 一定有），文件名带拍摄时间戳 → 时长/时间线链路走真实逻辑
i=0
for f in "${FIXTURES[@]}"; do
  i=$((i+1))
  ffmpeg -y -v error -f lavfi -i "color=c=0x1a2a4a:s=1280x720" -frames:v 1 \
    "$MEDIA/$f/游戏截图_2026030${i}_192530.png" 2>/dev/null || \
    cp "$ROOT/web/dist/index.html" "$MEDIA/$f/游戏截图_2026030${i}_192530.png"
done
ok "夹具媒体库就绪（${#FIXTURES[@]} 个游戏）"

# 仓库根通过 argv 传入（而不是写死在生成的脚本里），heredoc 里用 $1 展开。
# 路径带引号 —— 仓库路径里可能出现空格。
cat > "$TMP/run.js" <<'EOF'
// better-sqlite3 在本机没有原生绑定，用 node:sqlite 垫片顶上。
// 跑的是 backend/dist/main.js —— 和 Docker 镜像里 CMD 执行的是同一份产物。
const Module = require('module');
const ROOT = process.argv[2];
if (!ROOT) throw new Error('用法: node run.js <仓库根目录>');
const SHIM = require('node:path').join(ROOT, 'backend/scripts/achievements/sqlite-shim.js');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'better-sqlite3' ? SHIM : orig.call(this, r, ...a);
};
require(require('node:path').join(ROOT, 'backend/dist/main.js'));
EOF

nohup env \
  DATA_DIR="$DATA" MEDIA_DIRS="$MEDIA" WEB_DIST="$ROOT/web/dist" \
  PORT="$PORT" NODE_ENV=production AUTH_DISABLED=1 MAINTENANCE_ON_BOOT=0 \
  RAWG_API_KEY="$RAWG_KEY" RAWG_PROXY="" HTTP_PROXY="" HTTPS_PROXY="" \
  IMAGE_FETCH_ORDER=direct BUILD_TIME="$(date -Is)" \
  node "$TMP/run.js" "$ROOT" >>"$TMP/log" 2>&1 &
echo $! > "$TMP/pid"

ready=0
for _ in $(seq 1 45); do curl -sS -m 3 "$BASE/api/health" >/dev/null 2>&1 && { ready=1; break; }; sleep 1; done
if [ "$ready" != 1 ]; then bad "后端未就绪，见 $TMP/log"; exit 1; fi
ok "隔离实例已启动（$BASE）"

FEATURES="$(curl -s "$BASE/api/health")"
for f in hero-poster-carousel duration-coverage-api duration-backfill-ui; do
  case "$FEATURES" in *"$f"*) ok "运行实例声明能力 $f";; *) bad "运行实例缺少能力 $f";; esac
done

step 2 "扫描媒体库"
curl -s -m 20 -X POST "$BASE/api/library/scan" >/dev/null
for _ in $(seq 1 30); do
  n="$(curl -s "$BASE/api/games?pageSize=100" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)"
  [ "$n" = "${#FIXTURES[@]}" ] && break
  sleep 1
done
info "库中游戏数：$n / ${#FIXTURES[@]}"

# 先跑一次全量刮削 + 一次时长补全：让「血源诅咒」拿真实官方海报与 HLTB 时长
curl -s -m 30 -X POST "$BASE/api/games/refresh-all" >/dev/null
for _ in $(seq 1 90); do
  running="$(curl -s "$BASE/api/games/refresh-all/status" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("running"))' 2>/dev/null || echo True)"
  [ "$running" = "False" ] && break
  sleep 2
done
curl -s -m 30 -X POST "$BASE/api/games/backfill-durations" >/dev/null
for _ in $(seq 1 90); do
  running="$(curl -s "$BASE/api/games/refresh-all/status" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("running"))' 2>/dev/null || echo True)"
  [ "$running" = "False" ] && break
  sleep 2
done
curl -s "$BASE/api/games/duration-coverage" | python3 -m json.tool | sed 's/^/    /'

step 3 "真实 Chromium 逐项验收（三项需求 + 命名保护）"
if [ ! -x "$CHROME" ]; then
  bad "找不到 Chromium（$CHROME）。可设置 CHROME_PATH 指向已安装的 chrome。"
  exit 1
fi
CHROME_PATH="$CHROME" node "$ROOT/scripts/verify-browser.mjs" "$BASE" "$SHOTS" | sed 's/^/  /'
browser_rc=${PIPESTATUS[0]}
bash_rc=0
if [ "$browser_rc" -eq 0 ]; then ok "浏览器验收全部通过"; else bad "浏览器验收存在失败项"; bash_rc=1; fi

step 3b "全量遍历：逐个游戏打开详情页验证海报轮播（需求：不能只测个别游戏）"
CHROME_PATH="$CHROME" node "$ROOT/scripts/verify-all-games.mjs" "$BASE" "$SHOTS" | sed 's/^/  /'
all_rc=${PIPESTATUS[0]}
if [ "$all_rc" -eq 0 ]; then ok "全部游戏轮播/切换/时长逐项通过"; else bad "存在未通过的游戏"; fi

step 3c "用户配置保护：关闭轮播项 / 换封面后重新刮削"
if CHROME_PATH="$CHROME" node "$ROOT/scripts/verify-poster-config.mjs" "$BASE" | sed 's/^/  /'; then
  ok "重新刮削不覆盖用户已选配置"
else
  bad "用户配置在重新刮削后被改动"
fi

step 4 "时长缓存缺陷（桩服，离线可复现）"
if node "$ROOT/backend/scripts/verify/duration-cache-e2e.mjs" | sed 's/^/  /'; then
  ok "空时长不入缓存 / 重试 / 不丢已有时长 全部通过"
else
  bad "时长缓存缺陷套件存在失败项"
fi

printf '\n\033[1m结果：%d 项通过 / %d 项失败\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1