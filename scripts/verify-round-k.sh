#!/usr/bin/env bash
#
# 本轮四项优化的验证脚本：
#   需求1  详情页默认从顶部开始浏览
#   需求2  详情页「上一个 / 下一个」导航（遵循图库排序与筛选）
#   需求3  大幅提升平均通关时长覆盖率
#   需求4  自动刮取的全部海报纳入「编辑海报」管理列表
#
# 用法： bash scripts/verify-round-k.sh
# 全绿时自动清理临时目录；有失败则保留现场便于排查。
#
# 会真起一个隔离实例（独立 DATA_DIR / MEDIA_DIRS / 端口），不碰生产库，也不碰 Docker。
# 夹具用的是需求里点名的那几个游戏，其中「逆转裁判456」故意用中文目录名 —— 时长库只索引
# 拉丁标题，用英文名做夹具会把中文名这条链路整个掩盖掉。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-4421}"
BASE="http://127.0.0.1:${PORT}"
TMP="$ROOT/.tmp-round-k"
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

stop() { [ -f "$TMP/pid" ] && { kill "$(cat "$TMP/pid")" 2>/dev/null || true; sleep 1; }; }
cleanup() {
  stop
  if [ "$fail" -eq 0 ]; then rm -rf "$TMP"; else printf '   现场保留在 %s（日志 %s/log）\n' "$TMP" "$TMP"; fi
}
trap cleanup EXIT

start() {
  nohup env DATA_DIR="$DATA" MEDIA_DIRS="$MEDIA" PORT="$PORT" NODE_ENV=production \
    AUTH_DISABLED=1 MAINTENANCE_ON_BOOT=0 RAWG_PROXY="$PROXY" RAWG_API_KEY="$RAWG_KEY" \
    node "$TMP/run.js" >>"$TMP/log" 2>&1 &
  echo $! > "$TMP/pid"
  for _ in $(seq 1 45); do curl -sS -m 3 "$BASE/api/health" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}

# ---------------------------------------------------------------------------
step 0 "构建"
mkdir -p "$TMP"
if ! (cd "$ROOT" && npm run build -w backend) >"$TMP/build.log" 2>&1; then
  bad "后端构建失败，详见 $TMP/build.log"; tail -12 "$TMP/build.log" | sed 's/^/    /'; exit 1
fi
ok "后端构建通过"

"$ROOT/node_modules/.bin/esbuild" "$ROOT/backend/src/metadata/metadata-merge.ts" \
  --bundle --format=cjs --platform=node --outfile="$ROOT/backend/scripts/verify/merge.cjs" >/dev/null 2>&1
chmod 644 "$ROOT/backend/scripts/verify/merge.cjs" 2>/dev/null || true
if node "$ROOT/backend/scripts/verify/round-f-merge.js" 2>&1 | sed 's/^/  /'; then
  ok "时长合并 / 评分完整性 单元测试通过"
else
  bad "单元测试存在失败项"
fi

# ---------------------------------------------------------------------------
step 1 "准备隔离实例（含需求点名的游戏）"
FIXTURES=("Hades" "Bloodborne" "Cyberpunk 2077" "Astro Bot" "Astro's Playroom" "007 First Light" "逆转裁判456")
rm -rf "$TMP"; mkdir -p "$DATA" "$MEDIA"
for f in "${FIXTURES[@]}"; do mkdir -p "$MEDIA/$f"; done
node -e "
const sharp=require('$ROOT/node_modules/sharp');
const dirs=$(printf '%s\n' "${FIXTURES[@]}" | python3 -c 'import sys,json;print(json.dumps([l.rstrip(chr(10)) for l in sys.stdin]))');
Promise.all(dirs.map(d=>sharp({create:{width:640,height:360,channels:3,background:{r:40,g:80,b:140}}})
  .png().toFile('$MEDIA/'+d+'/s1.png'))).then(()=>{});" 2>/dev/null
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
ok "已生成 ${#FIXTURES[@]} 个夹具"

# ---------------------------------------------------------------------------
step 2 "启动实例并扫描"
start || { bad "实例启动失败"; grep -aE 'Error' "$TMP/log" | head -6 | sed 's/^/    /'; exit 1; }
n=0
for _ in $(seq 1 40); do
  n=$(curl -sS -m 5 "$BASE/api/games?pageSize=50" 2>/dev/null \
      | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)
  [ "${n:-0}" -ge "${#FIXTURES[@]}" ] && break
  sleep 1
done
ok "扫描入库 $n 个游戏"

# ---------------------------------------------------------------------------
step 3 "需求2 / 需求3 / 需求4：后端端到端"
BASE="$BASE" TEST_DB="$DATA/screenplay.db" \
  timeout 1500 node "$ROOT/backend/scripts/verify/round-k-backend.mjs" 2>&1 | sed 's/^/  /'
[ "${PIPESTATUS[0]}" -eq 0 ] && ok "后端端到端通过" || bad "后端端到端存在失败项（见上方 ✗）"

# ---------------------------------------------------------------------------
step 4 "需求1 / 需求2：真实 DOM（置顶 + 导航按钮）"
if [ -d "$UI/node_modules" ]; then
  rm -rf "$UI/node_modules/react" "$UI/node_modules/react-dom" "$UI/node_modules/scheduler"
  (cd "$UI" && "$ROOT/node_modules/.bin/esbuild" entry-k.tsx --bundle --format=cjs \
      --platform=node --outfile=out-k.cjs --loader:.tsx=tsx --loader:.ts=ts --jsx=automatic \
      --define:process.env.NODE_ENV='"development"' \
      --external:react --external:react-dom --external:react/jsx-runtime) >/dev/null 2>&1 \
    || bad "详情页测试打包失败"
  if (cd "$UI" && NODE_PATH="$ROOT/node_modules:$UI/node_modules" TEST_DB="$DATA/screenplay.db" \
        timeout 200 node round-k-ui.js 2>&1 \
        | grep -vE 'Warning:|reactjs.org|^ +at ' | sed 's/^/  /'); then
    ok "详情页置顶与导航 DOM 检查通过"
  else
    bad "详情页 DOM 检查有失败项"
  fi
else
  bad "jsdom 不可用，跳过前端检查"
fi

# ---------------------------------------------------------------------------
step 5 "需求4：容器重启后海报配置不丢失"
# 按游戏 id 统计官方海报数量并排序输出。
# 不能拿游戏名做键：重启后规范化名称会把「First Light」改成「007 First Light」，
# 那是正确行为，用它做键会把「名称变了」误判成「海报丢了」。
count_scraped() {
  curl -sS -m 10 "$BASE/api/games?pageSize=50" | python3 -c "
import sys,json,urllib.request
d=json.load(sys.stdin)
out=[]
for g in d:
    det=json.load(urllib.request.urlopen('$BASE/api/games/'+g['id'], timeout=10))
    n=len([p for p in (det.get('posterList') or []) if p['source']=='scraped'])
    if n>1: out.append('%s=%d' % (g['id'][:8], n))
print(','.join(sorted(out)))" 2>/dev/null
}
before=$(count_scraped)
# count_scraped 只收集「有 2 张以上官方海报」的游戏。没有 RAWG_API_KEY 时
# 刮削源只返回一张图，集合为空 —— 这时没有可比对的对象，记为跳过而不是失败。
# 仓库里不保存真实密钥，公开克隆后就是这个状态；假装通过会是更糟的选择。
if [ -z "$before" ]; then
  info "• 跳过重启保留性比对：当前库中没有「多张官方海报」的游戏（未提供 RAWG_API_KEY 时如此）"
else
  stop; start || { bad "重启失败"; exit 1; }
  after=$(count_scraped)
  if [ "$before" = "$after" ]; then
    ok "重启后官方海报数量与该游戏 id 一一对应，全部保留（$after）"
  else
    bad "重启后官方海报数量变化：$before → $after"
  fi
fi

# ---------------------------------------------------------------------------
step 6 "不影响既有能力：类型检查与 i18n 对齐"
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

grep -q '"state.unknown": "未知"' "$ROOT/web/src/i18n/zh/common.ts" \
  && ok "无时长数据仍显示「未知」" || bad "「未知」占位文案缺失"

# ---------------------------------------------------------------------------
printf '\n\033[1m== 结果\033[0m\n'
if [ "$fail" -eq 0 ]; then
  printf '   \033[1;32m%d 组通过 / 0 组失败\033[0m\n\n' "$pass"
  exit 0
fi
printf '   \033[1;31m%d 组通过 / %d 组失败\033[0m\n\n' "$pass" "$fail"
exit 1