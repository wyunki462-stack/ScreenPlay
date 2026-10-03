#!/usr/bin/env bash
# 长跑 / 泄漏扫描：反复打真实后端的热接口，按固定间隔采样 RSS、V8 堆、活跃句柄数与 SQL 形状数，
# 看是否有单调增长（泄漏）还是很快进入平台期。不改动任何产品代码，只读观测。
#
#   bash scripts/perf-bench/bench-soak.sh                     # 1500 次请求，采样间隔 250
#   N=3000 STEP=500 bash scripts/perf-bench/bench-soak.sh      # 长一点
#   OUT=docs/perf/leak-soak.txt bash scripts/perf-bench/bench-soak.sh
#
# 依赖：backend/dist/main.js（先跑 npm run build）、web/dist、curl、python3。
# 宿主没有 better-sqlite3 原生产物 ⇒ 走仓库自带的 node:sqlite shim（见 soak-server.js 注释）。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

N="${N:-1500}"
STEP="${STEP:-250}"
PORT="${PORT:-3402}"
DB="${DB:-/tmp/perf-soak/screenplay.db}"
MEDIA_ROOT="${MEDIA_ROOT:-/tmp/perf-soak-media}"
WEB_DIST="${WEB_DIST:-$ROOT/web/dist}"
LOG="${LOG:-/tmp/perf-soak-server.log}"
MEM_OUT="${MEM_OUT:-/tmp/soak-mem.jsonl}"
OUT="${OUT:-}"

fail() { echo "错误：$*" >&2; exit 1; }
[ -f backend/dist/main.js ] || fail "缺少 backend/dist/main.js —— 先在 backend/ 跑 npm run build"
[ -f web/dist/index.html ] || fail "缺少 web/dist/index.html"

# 1) 准备基准库（富 schema：表结构从产品代码的 migrate() 抽取，500 局 + 1500 张真实 JPEG）
if [ ! -f "$DB" ]; then
  echo "== 造基准库 $DB"
  SOAK_DB="$DB" SOAK_MEDIA_ROOT="$MEDIA_ROOT" node scripts/perf-bench/seed-soak-db.js || fail "种库失败"
fi
GID="11111111-2222-3333-4444-000000000000"
MID="99999999-8888-7777-6666-000000000000"

# 2) 起服务
echo "== 起服务（PORT=$PORT）"
: > "$MEM_OUT"
PORT="$PORT" HOST=127.0.0.1 WEB_DIST="$WEB_DIST" DATA_DIR="$(dirname "$DB")" MEDIA_DIRS="$MEDIA_ROOT" \
  AUTH_DISABLED=1 MAINTENANCE_ON_BOOT=0 SOAK_MEM_OUT="$MEM_OUT" SOAK_SQL_OUT=/tmp/perf-soak-sql.json \
  node scripts/perf-bench/soak-server.js > "$LOG" 2>&1 &
SRV=$!
trap 'kill "$SRV" 2>/dev/null' EXIT

for _ in $(seq 1 60); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/health" && break
  sleep 0.5
done
curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/health" || { tail -20 "$LOG"; fail "服务没起来（见 $LOG）"; }
echo "  服务 pid=$SRV，health 200"

# 3) 挑接口：先各探一次，只留返回 200 的（保证扫的是健康请求路径，而不是错误分支）
CANDIDATES=(
  "/api/health"
  "/api/games?limit=60"
  "/api/games?limit=60&page=2"
  "/api/games?limit=24&sort=mediaCount"
  "/api/games?limit=24&sort=name"
  "/api/games?limit=24&sort=metacritic"
  "/api/games?limit=24&sort=custom"
  "/api/games?platform=PC"
  "/api/games?q=Game"
  "/api/games/$GID"
  "/api/games/$GID/media"
  "/api/games/$GID/neighbors"
  "/api/media/$MID/thumbnail"
  "/"
  "/favicon.svg"
)
EPS=()
for u in "${CANDIDATES[@]}"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$u")
  if [ "$code" = "200" ]; then EPS+=("$u"); else echo "  跳过 $u（HTTP $code）"; fi
done
[ "${#EPS[@]}" -gt 0 ] || fail "没有可用的接口"
echo "== 采样 ${N} 次请求，接口 ${#EPS[@]} 条，每 $STEP 次采样一次"

sample() { # sample <已发请求数>
  kill -USR1 "$SRV" 2>/dev/null
  sleep 0.2
  local line
  line=$(tail -1 "$MEM_OUT" 2>/dev/null)
  printf '%-10s %-12s %-12s %-10s %s\n' "$1" \
    "$(grab "$line" rssMiB 9)" "$(grab "$line" heapUsedMiB 14)" \
    "$(grab "$line" handles 10)" "$(grab "$line" sqlShapes 12)" | tee -a "$RUNLOG"
}
grab() { awk -v s="$1" -v k="$2" -v off="$3" 'BEGIN{ if (match(s, "\"" k "\":[0-9.]+")) print substr(s, RSTART+off, RLENGTH-off) }'; }

TIMES=$(mktemp)
RUNLOG=$(mktemp)
echo
echo "请求数      RSS(MiB)     V8堆(MiB)    活跃句柄   SQL形状数"
sample 0
i=0
while [ "$i" -lt "$N" ]; do
  u="${EPS[$((i % ${#EPS[@]}))]}"
  curl -s -o /dev/null -w '%{time_total}\n' "http://127.0.0.1:$PORT$u" >> "$TIMES"
  i=$((i + 1))
  if [ $((i % STEP)) -eq 0 ]; then sample "$i"; fi
done

eval "$(python3 - "$MEM_OUT" "$TIMES" <<'PY'
import json, sys
mem, times = sys.argv[1], sys.argv[2]
lines = [json.loads(l) for l in open(mem) if l.strip()]
first, half, last = lines[0], lines[len(lines) // 2], lines[-1]
ts = [float(x) * 1000 for x in open(times) if x.strip()]
g = lambda d, k, fallback='n/a': d.get(k) if d.get(k) is not None else fallback
print(f"CALLS={len(ts)}")
print(f"TOTAL={sum(ts)/1000:.1f}")
print(f"AVG={sum(ts)/len(ts):.2f}")
print(f"MAX={max(ts):.2f}")
print(f"RSS_START={g(first,'rssMiB')}")
print(f"RSS_HALF={g(half,'rssMiB')}")
print(f"RSS_END={g(last,'rssMiB')}")
print(f"HEAP_START={g(first,'heapUsedMiB')}")
print(f"HEAP_HALF={g(half,'heapUsedMiB')}")
print(f"HEAP_END={g(last,'heapUsedMiB')}")
print(f"H_START={g(first,'handles')}")
print(f"H_END={g(last,'handles')}")
print(f"SHAPES={g(last,'sqlShapes')}")
print(f"SAMPLES={len(lines)}")
PY
)"
GROWTH=$(awk -v a="$RSS_HALF" -v b="$RSS_END" 'BEGIN{ if (a+0 > 0) printf "%.1f", (b-a)/a*100; else print "0" }')
VERDICT="平台期（后半段没有继续增长，未发现泄漏迹象）"
awk -v g="$GROWTH" 'BEGIN{ exit !(g+0 > 3) }' && VERDICT="后半段仍在增长 ${GROWTH}% ‼ 需要人工复核"
rm -f "$TIMES"

{
  echo "采样（每 $STEP 次请求一次）"
  echo "请求数      RSS(MiB)     V8堆(MiB)    活跃句柄   SQL形状数"
  cat "$RUNLOG"
  echo
  echo "ScreenPlay 长跑 / 泄漏扫描 $(date '+%Y-%m-%d %H:%M')"
  echo "请求 $CALLS 次，总耗时 ${TOTAL}s，平均 ${AVG} ms/次，最慢 ${MAX} ms"
  echo "接口（只取返回 200 的）：${EPS[*]}"
  echo "RSS MiB：$RSS_START → 中途 $RSS_HALF → 结束 $RSS_END（后半段变化 ${GROWTH}%）"
  echo "V8 堆 MiB：$HEAP_START → $HEAP_HALF → $HEAP_END"
  echo "活跃句柄：$H_START → $H_END；不同 SQL 形状数：$SHAPES；采样点 $SAMPLES"
  echo "判定：$VERDICT"
  echo
  echo "口径：跑的是真实编译产物 backend/dist/main.js，但 better-sqlite3 由仓库自带的 node:sqlite shim 顶替"
  echo "      （宿主没有原生命令产物）—— 量的是应用层（序列化、缓存、句柄、语句缓存）的内存行为，"
  echo "      SQLite 驱动自身的内存不在口径内。库由 scripts/perf-bench/seed-soak-db.js 造："
  echo "      schema 抽自产品代码的 migrate()，500 局 / 1500 张真实 JPEG；端口 $PORT，AUTH_DISABLED=1，"
  echo "      MAINTENANCE_ON_BOOT=0，单进程串行请求。容器侧口径请用 scripts/perf-baseline.sh。"
  echo
  echo "# KEY=VALUE"
  echo "# soak_requests=$CALLS"
  echo "# soak_ms_per_request=$AVG"
  echo "# soak_rss_start_mib=$RSS_START"
  echo "# soak_rss_end_mib=$RSS_END"
  echo "# soak_rss_growth_pct=$GROWTH"
  echo "# soak_heap_start_mib=$HEAP_START"
  echo "# soak_heap_end_mib=$HEAP_END"
  echo "# soak_sql_shapes=$SHAPES"
  echo "# soak_handles_start=$H_START"
  echo "# soak_handles_end=$H_END"
} | if [ -n "$OUT" ]; then tee "$OUT"; else cat; fi

rm -f "$RUNLOG"
kill "$SRV" 2>/dev/null
echo
echo "（服务已停）"
exit 0