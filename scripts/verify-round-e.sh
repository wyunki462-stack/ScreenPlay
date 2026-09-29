#!/usr/bin/env bash
# ScreenPlay 第二轮修复的端到端验证。
#
#   bash scripts/verify-round-e.sh
#
# 问题1  手动匹配换游戏后旧刮削数据全量清除，用户数据保留
# 问题2  任天堂游戏可搜到多个候选、metacritic 条目可绑定、失败提示可操作
# 问题3  成就手动选择弹窗的搜索提示为通用文案
#
# 会真实联网（RAWG / Metacritic / psnine）。退出码非 0 表示有失败项。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-4407}"
BASE="http://127.0.0.1:${PORT}"
TMP="$ROOT/.tmp-round-e"
NPM_CACHE="${NPM_CACHE:-/tmp/npm-cache-sp3}"

pass=0; fail=0
say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
good() { pass=$((pass+1)); printf '   \033[32m✓\033[0m %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '   \033[31m✗\033[0m %s\n' "$*"; }

cleanup() {
  if [ -f "$TMP/pid" ]; then
    kill "$(cat "$TMP/pid")" 2>/dev/null || true
    sleep 1
  fi
  # 有失败时保留现场（日志、库快照）便于排查，全绿则清理干净
  if [ "$fail" -eq 0 ]; then
    rm -rf "$TMP"
  else
    printf '   现场保留在 %s（日志 ${TMP}/log.1 log.2）\n' "$TMP"
  fi
}
trap cleanup EXIT

boot() {
  nohup env DATA_DIR="$TMP/data" MEDIA_DIRS="$TMP/media" PORT="$PORT" \
    NODE_ENV=production AUTH_DISABLED=1 MAINTENANCE_ON_BOOT=0 RAWG_PROXY="$PROXY" \
    node "$TMP/run.js" > "$TMP/log.$1" 2>&1 &
  echo $! > "$TMP/pid"
}

wait_health() {
  for _ in $(seq 1 60); do
    curl -sS -m 3 "$BASE/api/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

# 等扫描把夹具写进库（/api/health 通过 ≠ 扫描完成）
wait_games() {
  local want="$1" n=0
  for _ in $(seq 1 40); do
    n=$(curl -sS -m 5 "$BASE/api/games?pageSize=50" 2>/dev/null \
        | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)
    [ "${n:-0}" -ge "$want" ] && return 0
    sleep 1
  done
  return 1
}

stop_app() { [ -f "$TMP/pid" ] && { kill "$(cat "$TMP/pid")" 2>/dev/null || true; sleep 2; }; }

say "0. 准备"
rm -rf "$TMP"; mkdir -p "$TMP/data" "$TMP/media/E-Rematch Fixture"
# 默认留空走直连；要经代理跑就设 RAWG_PROXY。
PROXY="${RAWG_PROXY:-}"
info "代理: $PROXY"

node -e '
const path = require("node:path");
const ROOT = process.cwd();   // 脚本总是从仓库根运行
const sharp = require(ROOT + "/node_modules/sharp");
const dir = path.join(ROOT, ".tmp-round-e/media/E-Rematch Fixture");
const cols = [[30,70,130],[130,60,40],[50,120,80]];
Promise.all(cols.map((c,i)=>sharp({create:{width:640,height:360,channels:3,background:{r:c[0],g:c[1],b:c[2]}}})
  .png().toFile(dir+"/shot"+(i+1)+".png"))).then(()=>console.log("   夹具图片 3 张已生成"));
' || { bad "生成夹具图片失败"; exit 1; }

cp backend/scripts/achievements/sqlite-shim.js "$TMP/"
cat > "$TMP/run.js" <<'JS'
const path = require('path'), Module = require('module');
const SHIM = path.join(__dirname, 'sqlite-shim.js');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) { return r === 'better-sqlite3' ? SHIM : orig.call(this, r, ...a); };
require(path.join(__dirname, '..', 'backend', 'dist', 'main.js'));
JS

say "1. 构建后端"
if npm run build -w backend --cache "$NPM_CACHE" >/dev/null 2>&1; then
  good "后端构建通过"
else
  bad "后端构建失败"; exit 1
fi

say "2. 第一次启动：让扫描建立夹具与本地媒体"
boot 1
if wait_health && wait_games 1; then
  good "扫描完成，夹具与本地媒体已入库"
else
  bad "后端或扫描未就绪"; tail -20 "$TMP/log.1" | sed 's/^/     /'; exit 1
fi
stop_app

say "3. 注入「旧游戏的刮削残留」与「用户的本地配置」"
TEST_DB="$TMP/data/screenplay.db" node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.TEST_DB);
const now = Date.now();
const g = db.prepare("SELECT id FROM games LIMIT 1").get();
if (!g) { console.error("   没有夹具游戏"); process.exit(1); }
const gid = g.id;
const media = db.prepare("SELECT id FROM media WHERE game_id = ? ORDER BY sort_order LIMIT 1").get(gid);

db.prepare(`UPDATE games SET name = ?, platforms = ?, custom_platform = 1,
  screenshots = ?, ratings = ?, prices = ?, summary = ?, duration_seconds = 3600,
  achievements_status = ?, trophy_source = ?, poster_url = ? WHERE id = ?`).run(
  "E-Rematch Fixture", JSON.stringify(["Nintendo Switch"]),
  JSON.stringify(["https://old.example/old-shot-1.jpg","https://old.example/old-shot-2.jpg"]),
  JSON.stringify([{ source: "rawg", metascore: 55 }]),
  JSON.stringify([{ source: "steam", price: 99 }]),
  "旧游戏的简介（应当被清除）",
  "ok", "psnine",
  media ? `/api/media/${media.id}/preview` : "https://old.example/old-cover.jpg",
  gid);

// 旧的官方刮削海报（应当被删除）
for (const [i, sel] of [[1,0],[2,0]]) {
  db.prepare(`INSERT OR REPLACE INTO game_posters
    (id, game_id, url, source, media_id, is_selected, is_user_choice, in_slideshow, sort_order, created_at)
    VALUES (?,?,?,?,NULL,?,0,1,?,?)`).run(
    `oldscraped${i}`, gid, `https://old.example/scraped-${i}.jpg`, "scraped", sel, 10+i, now);
}
// 用户上传的海报，且是用户手动选的封面（应当保留并保持选中）
if (media) {
  db.prepare(`INSERT OR REPLACE INTO game_posters
    (id, game_id, url, source, media_id, is_selected, is_user_choice, in_slideshow, sort_order, created_at)
    VALUES (?,?,?,?,?,1,1,0,50,?)`).run(
    "userupload1", gid, `/api/media/${media.id}/preview`, "upload", media.id, now);
}
// 旧的成就残留
for (const i of [1,2,3]) {
  db.prepare(`INSERT OR REPLACE INTO achievements (id, game_id, external_id, name, description, icon_url, global_percent, unlocked)
    VALUES (?,?,?,?,?,?,?,0)`).run(`oldach${i}`, gid, `ext${i}`, `旧成就 ${i}`, "旧游戏成就", null, 12.5);
}
db.prepare(`INSERT OR REPLACE INTO achievement_links (game_id, source, external_id, name, created_at)
  VALUES (?,?,?,?,?)`).run(gid, "psnine", "5818", "血源诅咒", now);

const s = db.prepare(`SELECT (SELECT COUNT(*) FROM game_posters WHERE game_id=?) p,
  (SELECT COUNT(*) FROM game_posters WHERE game_id=? AND source IN (?,?) AND is_selected=1) us,
  (SELECT COUNT(*) FROM media WHERE game_id=?) m,
  (SELECT COUNT(*) FROM achievements WHERE game_id=?) a,
  (SELECT COUNT(*) FROM achievement_links WHERE game_id=?) l`).get(gid,gid,"upload","media",gid,gid,gid);
console.log(`   注入完成：刮削海报 2 / 用户选中封面 ${s.us} / 本地媒体 ${s.m} / 旧成就 ${s.a} 行 / 手动成就目标 ${s.l}`);
if (!(s.us > 0 && s.a > 0 && s.l > 0)) { console.error("   注入不完整"); process.exit(1); }
' || { bad "注入失败"; exit 1; }
good "旧刮削残留与用户配置均已注入"

say "4. 第二次启动并跑后端端到端"
boot 2
if wait_health && wait_games 1; then
  good "后端就绪"
else
  bad "后端未就绪"; tail -20 "$TMP/log.2" | sed 's/^/     /'; exit 1
fi

BASE="$BASE" TEST_DB="$TMP/data/screenplay.db" \
  node backend/scripts/verify/round-e-backend.mjs 2>&1 | sed 's/^/   /'
backend_rc=${PIPESTATUS[0]}
[ "$backend_rc" -eq 0 ] && good "后端端到端通过" || bad "后端端到端有失败项"

say "5. 前端：成就弹窗搜索提示（问题3）"
if [ -d backend/scripts/achievements/ui/node_modules ]; then
  info "复用已有 jsdom"
else
  info "安装 jsdom…"
  ( cd backend/scripts/achievements/ui && npm install --no-save --cache "$NPM_CACHE" >/dev/null 2>&1 ) || true
fi
UI="$ROOT/backend/scripts/achievements/ui"
if [ -d "$UI/node_modules" ]; then
  # 子目录里若出现 react 副本会触发 Invalid hook call，清掉让它解析到仓库根目录
  rm -rf "$UI/node_modules/react" "$UI/node_modules/react-dom" "$UI/node_modules/scheduler"

  (cd "$UI" && "$ROOT/node_modules/.bin/esbuild" entry-e.tsx --bundle --format=cjs \
      --platform=node --outfile=out-e.cjs --loader:.tsx=tsx --loader:.ts=ts --jsx=automatic \
      --define:process.env.NODE_ENV='"development"' \
      --external:react --external:react-dom --external:react/jsx-runtime) >/dev/null 2>&1 \
    || bad "弹窗测试打包失败"

  if (cd "$UI" && NODE_PATH="$ROOT/node_modules:$UI/node_modules" TEST_DB="$TMP/data/screenplay.db" \
        timeout 200 node round-e-ui.js 2>&1 \
        | grep -vE 'Warning:|reactjs.org|^ +at ' | sed 's/^/   /'); then
    good "弹窗文案检查通过"
  else
    bad "弹窗文案检查有失败项（见上方 ✗）"
  fi
else
  bad "jsdom 不可用，跳过前端检查"
fi

say "结果"
printf '   \033[1m%s 组通过 / %s 组失败\033[0m\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || { echo "   请把上面失败项的完整输出发出来以便继续排查。"; echo; }
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
