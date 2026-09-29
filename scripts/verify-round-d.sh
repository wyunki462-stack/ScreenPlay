#!/usr/bin/env bash
# =============================================================================
# ScreenPlay 需求验证脚本（需求一 / 二 / 三）
#
# 用途：在一台机器上自建隔离实例，端到端验证本轮三项改动，并给出结论。
#
#   一、游戏卡片统一 16:9 横向比例（cover 居中裁切、信息不遮挡海报）
#   二、成就标签页「手动选择游戏」：候选搜索 → 选定 → 重新抓取 → 配置持久化
#   三、成就抓取失败统一提示，前端不暴露数据源站点名
#
# 验证方式是「真实链路」：自建实例 → 真实联网抓取 psnine → 真实渲染 React 组件。
# 因此结论可直接对应到用户看到的界面，而不是只测到函数层。
#
# 用法：  bash scripts/verify-round-d.sh
#         PORT=4500 bash scripts/verify-round-d.sh          # 换端口
#         SKIP_UI=1 bash scripts/verify-round-d.sh          # 只跑后端 E2E
#
# 说明：脚本会自行 build、建夹具、起进程、跑完自动清理，可重复执行。
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-4405}"
BASE="http://127.0.0.1:${PORT}"
WORK="${ROOT}/.tmp-round-d"
MEDIA="${WORK}/media"
DATA="${WORK}/data"
TEST_DB="${DATA}/screenplay.db"
LOG="${WORK}/backend.log"

AUTH_DISABLED=1 MAINTENANCE_ON_BOOT=0
export BASE TEST_DB

pass=0; fail=0
ok()   { echo -e "  \033[32m✓\033[0m $1"; pass=$((pass+1)); }
bad()  { echo -e "  \033[31m✗\033[0m $1"; fail=$((fail+1)); }
info() { echo -e "  \033[36m·\033[0m $1"; }
step() { echo; echo "[$1] $2"; }

cleanup() {
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    wait "$PID" 2>/dev/null
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
step 0 "构建后端（前端组件由 esbuild 现场打包，无需先 build web）"
if ! (cd "$ROOT" && npm run build -w backend) >"${WORK}.build.log" 2>&1; then
  bad "后端构建失败，详见 ${WORK}.build.log"
  tail -12 "${WORK}.build.log" | sed 's/^/    /'
  exit 1
fi
ok "后端构建通过"

# ---------------------------------------------------------------------------
step 1 "准备隔离实例（夹具文件夹必须是真实目录，否则启动扫描会把它清掉）"
rm -rf "$WORK"
mkdir -p "$DATA" "$MEDIA/Bloodborne" "$MEDIA/007 First Light" "$MEDIA/Portal 2"

node -e "
const sharp = require('${ROOT}/node_modules/sharp');
(async () => {
  for (const d of ['Bloodborne', '007 First Light', 'Portal 2']) {
    await sharp({ create: { width: 640, height: 360, channels: 3, background: { r: 30, g: 70, b: 140 } } })
      .png().toFile('${MEDIA}/' + d + '/s.png');
  }
})();" || { bad "生成夹具图片失败（需要 sharp）"; exit 1; }

cp "${ROOT}/backend/scripts/achievements/sqlite-shim.js" "${WORK}/sqlite-shim.js"
cat > "${WORK}/run.js" <<EOF
// 本机没有 better-sqlite3 原生绑定，用 node:sqlite 顶替。
const path = require('path');
const Module = require('module');
const SHIM = path.join(__dirname, 'sqlite-shim.js');
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'better-sqlite3') return SHIM;
  return orig.call(this, request, ...rest);
};
require('${ROOT}/backend/dist/main.js');
EOF
ok "夹具就绪：Bloodborne / 007 First Light / Portal 2（各含 1 张 640x360 图片）"

# ---------------------------------------------------------------------------
step 2 "启动实例并等待就绪"
DATA_DIR="$DATA" MEDIA_DIRS="$MEDIA" PORT="$PORT" NODE_ENV=production \
  AUTH_DISABLED="$AUTH_DISABLED" \
  RAWG_PROXY="${RAWG_PROXY:-}" \
  nohup node "${WORK}/run.js" >"$LOG" 2>&1 &
PID=$!

ready=0
for _ in $(seq 1 40); do
  if curl -sS -m 3 "${BASE}/api/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != 1 ]; then
  bad "实例启动超时，日志尾部："
  tail -18 "$LOG" | sed 's/^/    /'
  exit 1
fi
ok "实例已就绪：${BASE}"

for route in "/api/achievements/:gameId/candidates" "/api/achievements/:gameId/target"; do
  if grep -aq "Mapped {${route}" "$LOG"; then ok "新接口已注册：${route}"
  else bad "接口未注册：${route}"; fi
done

# ---------------------------------------------------------------------------
step 3 "平台标注（PS 游戏才会走奖杯抓取）"
# 健康检查通过 ≠ 启动扫描结束：游戏是逐个入库的，必须等三个夹具都在，
# 否则后入库的那个会被误判成「找不到夹具」。
for _ in $(seq 1 30); do
  n="$(curl -sS -m 5 "${BASE}/api/games?pageSize=50" 2>/dev/null \
        | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)"
  [ "${n:-0}" -ge 3 ] && break
  sleep 1
done
if [ "${n:-0}" -ge 3 ]; then
  ok "启动扫描完成，已入库 ${n} 个夹具"
else
  bad "启动扫描未完成（仅入库 ${n:-0} 个）"
fi

# 走 HTTP 接口而不是直接写库：实例运行期间 SQLite 文件是锁住的，
# 而且这样更贴近真实使用路径（与前端 PlatformDialog 一致）。
BASE="$BASE" node -e "
const FOLDER = { 'Bloodborne': ['PlayStation 4'], '007 First Light': ['PlayStation 5'], 'Portal 2': ['PC'] };
(async () => {
  const list = await (await fetch(process.env.BASE + '/api/games?pageSize=50')).json();
  for (const [folder, platforms] of Object.entries(FOLDER)) {
    const g = list.find((x) => (x.folderPath || '').endsWith('/' + folder));
    if (!g) { console.log('    ✗ 找不到夹具 ' + folder); process.exitCode = 1; continue; }
    const res = await fetch(process.env.BASE + '/api/games/' + g.id, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platforms }),
    });
    if (!res.ok) { console.log('    ✗ ' + folder + ' 标注失败 HTTP ' + res.status); process.exitCode = 1; continue; }
    console.log('    · ' + folder + ' → ' + platforms.join(', '));
  }
})();" 2>&1 | sed 's/^/  /'
if [ "${PIPESTATUS[0]}" = 0 ]; then
  ok "已标注：Bloodborne=PS4、007 First Light=PS5、Portal 2=PC"
else
  bad "标注平台失败"
fi

# ---------------------------------------------------------------------------
step 4 "需求二 / 三：后端端到端（真实联网 psnine）"
if (cd "${ROOT}/backend/scripts/achievements" && BASE="$BASE" TEST_DB="$TEST_DB" \
      timeout 600 node manual-target.mjs 2>&1 | sed 's/^/  /'); then
  ok "后端 E2E 全部通过"
else
  bad "后端 E2E 存在失败项（见上方 ✗）"
fi

# ---------------------------------------------------------------------------
if [ "${SKIP_UI:-0}" != 1 ]; then
  step 5 "需求一 / 二 / 三：前端真实 DOM（真实渲染 + 真实接口）"
  UI="${ROOT}/backend/scripts/achievements/ui"
  if [ ! -d "${UI}/node_modules/jsdom" ] && [ ! -d "${ROOT}/node_modules/jsdom" ]; then
    info "首次运行，安装 jsdom 测试依赖…"
    # 固定的 cache 目录：默认的 ~/.npm-cache 在部分 NAS 账户下不可写
    (cd "$UI" && npm install --no-save --no-audit --no-fund \
        --cache "${NPM_CACHE:-/tmp/npm-cache-sp3}" \
        jsdom@24 @testing-library/react@14 @testing-library/dom@9) >"${WORK}.npm.log" 2>&1 \
      || { bad "测试依赖安装失败，详见 ${WORK}.npm.log"; tail -6 "${WORK}.npm.log" | sed 's/^/    /'; }
    # 子目录里重复的 react 会导致 Invalid hook call，必须删掉让解析回到根目录
    rm -rf "${UI}/node_modules/react" "${UI}/node_modules/react-dom" "${UI}/node_modules/scheduler"
  fi

  (cd "$UI" && "${ROOT}/node_modules/.bin/esbuild" entry.tsx --bundle --format=cjs \
      --platform=node --outfile=out.cjs --loader:.tsx=tsx --loader:.ts=ts --jsx=automatic \
      --define:process.env.NODE_ENV='"development"' \
      --external:react --external:react-dom --external:react/jsx-runtime) >/dev/null 2>&1 \
    || bad "前端测试打包失败"

  if (cd "$UI" && NODE_PATH="${ROOT}/node_modules:${UI}/node_modules" BASE="$BASE" TEST_DB="$TEST_DB" \
        timeout 500 node test-ui.js 2>&1 \
        | grep -vE 'Warning:|reactjs.org|^ +at ' | sed 's/^/  /'); then
    ok "前端 DOM 验证全部通过"
  else
    bad "前端 DOM 验证存在失败项（见上方 ✗）"
  fi
else
  info "已跳过前端 DOM 验证（SKIP_UI=1）"
fi

# ---------------------------------------------------------------------------
echo
echo "=============================================================="
echo -e " 结果：\033[32m${pass} 组通过\033[0m / \033[31m${fail} 组失败\033[0m"
echo "=============================================================="
rm -f "${WORK}.build.log" "${WORK}.npm.log"

[ "$fail" -eq 0 ] || exit 1