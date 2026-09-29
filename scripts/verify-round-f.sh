#!/usr/bin/env bash
#
# 本轮三项需求的验证脚本：
#   问题1  手动匹配/刷新后 Metacritic 评分不再偶发丢失（评分完整性校验）
#   问题2  Metacritic 评分手动选择（各平台条目 / 持久化 / 恢复自动匹配）
#   问题3  通关时长 →「平均通关时长」且多源兜底
#
# 用法： bash scripts/verify-round-f.sh
# 全绿时自动清理临时目录；有失败则保留现场便于排查。
#
# 这个脚本会真起一个隔离实例（独立 DATA_DIR / MEDIA_DIRS / 端口），
# 不会碰到生产库，也不会碰 Docker。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-4409}"
BASE="http://127.0.0.1:${PORT}"
TMP="$ROOT/.tmp-round-f"
DATA="$TMP/data"
MEDIA="$TMP/media"
UI="$ROOT/backend/scripts/achievements/ui"
# 从环境变量取；未提供时留空 —— 验证脚本里**不放任何真实密钥**。
# 需要联网抓取的检查组会自动跳过（并在输出里说明原因），不会假装通过。
RAWG_KEY="${RAWG_API_KEY:-}"
# 构建/运行代理同样从环境变量取；默认留空走直连，不写死任何内网地址。
PROXY="${RAWG_PROXY:-}"

pass=0; fail=0
ok()   { printf '   \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '   \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
info() { printf '   %s\n' "$1"; }

cleanup() {
  if [ -f "$TMP/pid" ]; then
    kill "$(cat "$TMP/pid")" 2>/dev/null || true
    sleep 1
  fi
  if [ "$fail" -eq 0 ]; then
    rm -rf "$TMP"
  else
    printf '   现场保留在 %s（日志 %s/log）\n' "$TMP" "$TMP"
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
step 0 "构建后端与前端"
# 构建日志放进 $TMP 内部，否则 cleanup 清不到它（$TMP.build.log 是同级文件）
mkdir -p "$TMP"
if ! (cd "$ROOT" && npm run build -w backend) >"$TMP/build.log" 2>&1; then
  bad "后端构建失败，详见 $TMP/build.log"
  tail -12 "$TMP/build.log" | sed 's/^/    /'
  exit 1
fi
ok "后端构建通过"

# 纯函数单元测试（评分完整性 + 时长来源优先级）
"$ROOT/node_modules/.bin/esbuild" "$ROOT/backend/src/metadata/metadata-merge.ts" \
  --bundle --format=cjs --platform=node \
  --outfile="$ROOT/backend/scripts/verify/merge.cjs" >/dev/null 2>&1 \
  || bad "merge 打包失败"
chmod 644 "$ROOT/backend/scripts/verify/merge.cjs" 2>/dev/null || true
if node "$ROOT/backend/scripts/verify/round-f-merge.js" 2>&1 | sed 's/^/  /'; then
  ok "评分完整性 / 时长优先级 单元测试通过"
else
  bad "单元测试存在失败项（见上方 ✗）"
fi

# ---------------------------------------------------------------------------
step 1 "准备隔离实例"
rm -rf "$TMP"; mkdir -p "$DATA" "$MEDIA/Hades" "$MEDIA/Bloodborne"
node -e "
const sharp=require('$ROOT/node_modules/sharp');
Promise.all(['Hades','Bloodborne'].map(d=>sharp({create:{width:640,height:360,channels:3,
  background:{r:40,g:80,b:140}}}).png().toFile('$MEDIA/'+d+'/s1.png'))).then(()=>{});" 2>/dev/null
cp "$ROOT/backend/scripts/achievements/sqlite-shim.js" "$TMP/" 2>/dev/null || true
cat > "$TMP/run.js" <<'EOF'
// better-sqlite3 在本机没有原生绑定，用 node:sqlite 垫片顶上
const path = require('path'), Module = require('module');
const SHIM = path.join(__dirname, 'sqlite-shim.js');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'better-sqlite3' ? SHIM : orig.call(this, r, ...a);
};
require(path.join(__dirname, '..', 'backend', 'dist', 'main.js'));
EOF
ok "夹具与运行器就绪（端口 $PORT）"

# ---------------------------------------------------------------------------
step 2 "启动实例"
nohup env DATA_DIR="$DATA" MEDIA_DIRS="$MEDIA" PORT="$PORT" NODE_ENV=production \
  AUTH_DISABLED=1 MAINTENANCE_ON_BOOT=0 RAWG_PROXY="$PROXY" RAWG_API_KEY="$RAWG_KEY" \
  node "$TMP/run.js" >"$TMP/log" 2>&1 &
echo $! > "$TMP/pid"

for _ in $(seq 1 45); do
  curl -sS -m 3 "$BASE/api/health" >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -sS -m 3 "$BASE/api/health" >/dev/null 2>&1; then
  bad "实例启动失败"
  grep -aE 'Error|error' "$TMP/log" | head -6 | sed 's/^/    /'
  exit 1
fi
ok "实例已就绪（数据目录 $DATA）"

# 等扫描把夹具入库
n=0
for _ in $(seq 1 40); do
  n=$(curl -sS -m 5 "$BASE/api/games?pageSize=50" 2>/dev/null \
      | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)
  [ "${n:-0}" -ge 2 ] && break
  sleep 1
done
info "扫描入库游戏数：${n:-0}"

# ---------------------------------------------------------------------------
step 3 "问题1：评分不会因刷新/更新被清空"
BASE="$BASE" TEST_DB="$DATA/screenplay.db" \
  timeout 900 node "$ROOT/backend/scripts/verify/round-f-backend.mjs" 2>&1 | sed 's/^/  /'
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] && ok "后端端到端通过" || bad "后端端到端存在失败项（见上方 ✗）"

# ---------------------------------------------------------------------------
step 4 "问题2/问题3：评分弹窗与时长文案（真实 DOM）"
if [ -d "$UI/node_modules" ]; then
  # 子目录里若有 react 副本会触发 Invalid hook call，清掉让它解析到仓库根
  rm -rf "$UI/node_modules/react" "$UI/node_modules/react-dom" "$UI/node_modules/scheduler"

  (cd "$UI" && "$ROOT/node_modules/.bin/esbuild" entry-f.tsx --bundle --format=cjs \
      --platform=node --outfile=out-f.cjs --loader:.tsx=tsx --loader:.ts=ts --jsx=automatic \
      --define:process.env.NODE_ENV='"development"' \
      --external:react --external:react-dom --external:react/jsx-runtime) >/dev/null 2>&1 \
    || bad "评分弹窗测试打包失败"

  if (cd "$UI" && NODE_PATH="$ROOT/node_modules:$UI/node_modules" TEST_DB="$DATA/screenplay.db" \
        timeout 200 node round-f-ui.js 2>&1 \
        | grep -vE 'Warning:|reactjs.org|^ +at ' | sed 's/^/  /'); then
    ok "评分弹窗 DOM 检查通过"
  else
    bad "评分弹窗 DOM 检查有失败项（见上方 ✗）"
  fi
else
  bad "jsdom 不可用，跳过前端检查"
fi

# 「平均通关时长」文案：直接核验两种语言的实际字面量
if grep -q '"detail.playtime": "平均通关时长"' "$ROOT/web/src/i18n/zh/detail.ts"; then
  ok "中文界面文案为「平均通关时长」"
else
  bad "中文「通关时长」文案未更新为「平均通关时长」"
fi
if grep -q '"detail.playtime": "Average playtime"' "$ROOT/web/src/i18n/en/detail.ts"; then
  ok "英文界面文案为「Average playtime」"
else
  bad "英文时长文案未更新"
fi

# ---------------------------------------------------------------------------
step 5 "不影响既有能力：类型检查与 i18n 对齐"
berr=$(cd "$ROOT" && npm run typecheck -w backend 2>&1 | grep -cE 'error TS')
ferr=$(cd "$ROOT/web" && npx tsc --noEmit 2>&1 | grep -cE 'error TS')
[ "$berr" -eq 0 ] && ok "后端 TS 0 错误" || bad "后端 TS $berr 个错误"
[ "$ferr" -eq 0 ] && ok "前端 TS 0 错误" || bad "前端 TS $ferr 个错误"

node -e "
const fs=require('fs'),path=require('path');
const keys=d=>{const o=new Set();for(const f of fs.readdirSync(d).filter(x=>x.endsWith('.ts'))){
  const s=fs.readFileSync(path.join(d,f),'utf8');
  for(const m of s.matchAll(/^\s*\"([^\"]+)\"\s*:/gm))o.add(m[1]);}return o;};
const zh=keys('$ROOT/web/src/i18n/zh'),en=keys('$ROOT/web/src/i18n/en');
const missEn=[...zh].filter(k=>!en.has(k)), missZh=[...en].filter(k=>!zh.has(k));
if(missEn.length||missZh.length){console.log('MISS '+missEn.length+' '+missZh.length);process.exit(1);}
console.log('OK '+zh.size);
" > "$TMP/i18n.txt" 2>&1
if grep -q '^OK' "$TMP/i18n.txt"; then
  ok "i18n 双语对齐（$(cut -d' ' -f2 < "$TMP/i18n.txt") 键）"
else
  bad "i18n 存在缺口：$(cat "$TMP/i18n.txt")"
fi

# ---------------------------------------------------------------------------
printf '\n\033[1m== 结果\033[0m\n'
if [ "$fail" -eq 0 ]; then
  printf '   \033[1;32m%d 组通过 / 0 组失败\033[0m\n\n' "$pass"
  exit 0
fi
printf '   \033[1;31m%d 组通过 / %d 组失败\033[0m\n\n' "$pass" "$fail"
printf '   请把上面失败项的完整输出发出来以便继续排查。\n\n'
exit 1