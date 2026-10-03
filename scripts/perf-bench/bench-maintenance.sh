#!/usr/bin/env bash
# 启动维护（回收）端到端验证：造一个有「过期缓存行 + 孤儿衍生件 + 用户上传海报 + 陌生文件名」
# 的 /data，真启动一次后端，看它删了什么、留了什么、回收了多少字节。
#
#   bash scripts/perf-bench/bench-maintenance.sh
#   OUT=docs/perf/maintenance-reclaim.txt bash scripts/perf-bench/bench-maintenance.sh
#
# 必须留的（下面会逐条断言）：
#   * `keepIds` 里（media 表还在）的 thumbnails/covers/previews —— 哪怕文件很老
#   * 文件名不匹配规则的任何文件（`random.webp`、`notes.txt`）—— 不认识的绝不碰
#   * `proxied/` 里没过期的
#   * `posters/` 整目录 —— 用户上传原图，永不扫
# 必须删的：过期的 metadata_cache 行、规则匹配且 media 行已不存在的衍生件、过期的 proxied/。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

BASE="${BASE:-/tmp/perf-maint}"
DATA="$BASE/data"
MEDIA="$BASE/media"
DB="$DATA/screenplay.db"          # 必须落在 DATA_DIR 里，后端才会用它（configuration 里就是 dataDir/screenplay.db）
PORT="${PORT:-3403}"
LOG="$BASE/server.log"
OUT="${OUT:-}"
OLD="40 days ago"

fail() { echo "错误：$*" >&2; exit 1; }
mk() { # mk <路径> [mtime] —— 写 1KB 内容并设 mtime
  head -c 1024 /dev/zero > "$1"
  touch -d "${2:-$OLD}" "$1"
}
count() { find "$1" -maxdepth 1 -type f 2>/dev/null | wc -l; }
# 统计要排除数据库自身（它就在 DATA_DIR 下，字节数会淹没回收量）
countAll() { find "$DATA" -type f ! -name 'screenplay.db*' | wc -l; }
bytesAll() { du -sb "$DATA"/thumbnails "$DATA"/covers "$DATA"/previews "$DATA"/proxied "$DATA"/posters 2>/dev/null | awk '{s+=$1} END{print s+0}'; }

rm -rf "$BASE"
mkdir -p "$DATA"/{thumbnails,covers,previews,proxied,posters}
SOAK_DB="$DB" SOAK_MEDIA_ROOT="$MEDIA" node scripts/perf-bench/seed-soak-db.js > "$BASE/seed.log" 2>&1 || fail "种库失败"

# 活着的 media id（前 3 条）：它们的衍生件必须留着
LIVE=(99999999-8888-7777-6666-000000000000 99999999-8888-7777-6666-000000000001 99999999-8888-7777-6666-000000000002)
orphan() { # orphan <序号> —— 一个不在 media 表里的合法 UUID
  printf 'aaaaaaaa-bbbb-cccc-dddd-%012d' "$1"
}

for id in "${LIVE[@]}"; do
  mk "$DATA/thumbnails/$id.webp"; mk "$DATA/covers/$id.webp"; mk "$DATA/previews/$id@w2560.webp"
done
for i in $(seq 1 30); do mk "$DATA/thumbnails/$(orphan "$i").webp"; done
for i in $(seq 31 40); do mk "$DATA/covers/$(orphan "$i").webp"; done
for i in $(seq 41 52); do mk "$DATA/previews/$(orphan "$i")@full.webp"; done
for i in $(seq 53 58); do mk "$DATA/previews/$(orphan "$i")@w2560v2.webp"; done
mk "$DATA/thumbnails/random.webp"          # 名字不匹配 → 必须留
mk "$DATA/thumbnails/not-a-uuid.webp"      # 名字不匹配 → 必须留
mk "$DATA/thumbnails/notes.txt"            # 不是 webp → 必须留
for i in $(seq 1 20); do mk "$DATA/proxied/proxy-old-$i.jpg"; done          # 过期 → 删
for i in $(seq 1 5);  do mk "$DATA/proxied/proxy-new-$i.jpg" "now"; done    # 新鲜 → 留
for i in $(seq 1 5);  do mk "$DATA/posters/poster-$i.jpg"; done             # 用户数据 → 永不删

before_files=$(countAll)
before_bytes=$(bytesAll)

# 往 metadata_cache 里塞 100 条过期行 + 50 条未过期行
node - "$DB" <<'PY'
const Module = require('module'), path = require('path');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'better-sqlite3' ? path.resolve('backend/scripts/verify/sqlite-shim.js') : orig.call(this, r, ...a);
};
const db = new (require('better-sqlite3'))(process.argv[2]);
const now = Date.now();
// 走 prepare().run(...)：better-sqlite3 与 shim 都只接散开的参数，不接数组
const ins = db.prepare('INSERT INTO metadata_cache (key,provider,payload,fetched_at,expires_at) VALUES (?,?,?,?,?)');
for (let i = 0; i < 100; i++) ins.run(`expired-${i}`, 'rawg', '{}', now - 1e7, now - 1e6);
for (let i = 0; i < 50; i++) ins.run(`fresh-${i}`, 'rawg', '{}', now, now + 1e7);
console.log('metadata_cache 行数 =', db.prepare('SELECT COUNT(*) AS c FROM metadata_cache').get().c);
PY

echo "== 启动前：$DATA 的五个缓存目录共 $before_files 个文件 / $before_bytes 字节（metadata_cache 另有 150 行）"
echo "== 启动后端（MAINTENANCE_ON_BOOT 默认开启）"

# 走 soak-server.js 起（它把 better-sqlite3 指到 node:sqlite shim；宿主没有原生产物）
PORT="$PORT" HOST=127.0.0.1 WEB_DIST="$ROOT/web/dist" DATA_DIR="$DATA" MEDIA_DIRS="$MEDIA" \
  AUTH_DISABLED=1 SOAK_MEM_OUT="$BASE/mem.jsonl" SOAK_SQL_OUT="$BASE/sql.json" \
  node scripts/perf-bench/soak-server.js > "$LOG" 2>&1 &
SRV=$!
trap 'kill "$SRV" 2>/dev/null' EXIT

curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/health" || { sleep 3; curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/health"; }
for _ in $(seq 1 120); do
  grep -q 'caches reclaimed:' "$LOG" && break
  sleep 1
done
sleep 1
RECLAIM_LINE=$(grep -o 'caches reclaimed: [0-9]* expired cache row(s), [0-9]* stale file(s)' "$LOG" | tail -1)
BOOT_LINE=$(grep -o 'Boot maintenance finished in [0-9.]*s' "$LOG" | tail -1)
[ -n "$RECLAIM_LINE" ] || { tail -20 "$LOG"; fail "没等到回收日志（见 $LOG）"; }

after_bytes=$(bytesAll)
after_files=$(countAll)

ok=0; bad=0
check() { # check <描述> <实际> <期望>
  if [ "$2" = "$3" ]; then ok=$((ok + 1)); printf '  ✅ %-46s %s\n' "$1" "$2";
  else bad=$((bad + 1)); printf '  ❌ %-46s 实际 %s，期望 %s\n' "$1" "$2" "$3"; fi
}
check "thumbnails 剩余（3 活 + 3 陌生名）" "$(count "$DATA/thumbnails")" 6
check "covers 剩余（3 活）" "$(count "$DATA/covers")" 3
check "previews 剩余（3 活）" "$(count "$DATA/previews")" 3
check "proxied 剩余（5 新鲜）" "$(count "$DATA/proxied")" 5
check "posters 完好无损" "$(count "$DATA/posters")" 5
check "陌生名 random.webp 仍在" "$([ -f "$DATA/thumbnails/random.webp" ] && echo yes || echo no)" yes
check "notes.txt 仍在" "$([ -f "$DATA/thumbnails/notes.txt" ] && echo yes || echo no)" yes
check "活文件 <live>.webp 仍在" "$([ -f "$DATA/thumbnails/${LIVE[0]}.webp" ] && echo yes || echo no)" yes
ROWS=$(node - "$DB" <<'PY'
const Module = require('module'), path = require('path');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'better-sqlite3' ? path.resolve('backend/scripts/verify/sqlite-shim.js') : orig.call(this, r, ...a);
};
const db = new (require('better-sqlite3'))(process.argv[2]);
console.log(db.prepare('SELECT COUNT(*) AS c FROM metadata_cache').get().c);
PY
)
check "metadata_cache 剩余行数（过期行已清）" "$ROWS" 50
check "合计文件数" "$after_files" 22

SAVED=$((before_bytes - after_bytes))
{
  echo "ScreenPlay 启动维护（回收）端到端验证 $(date '+%Y-%m-%d %H:%M')"
  echo "日志：$BOOT_LINE"
  echo "     $RECLAIM_LINE"
  echo
  echo "五个缓存目录文件数：$before_files → $after_files（−$((before_files - after_files))）"
  echo "五个缓存目录字节：$before_bytes → $after_bytes（回收 $SAVED 字节 ≈ $((SAVED / 1024)) KiB）"
  echo "metadata_cache：150 行 → $ROWS 行（删掉 100 条过期行）"
  echo
  echo "断言：$ok 项通过 / $bad 项失败"
  echo "口径：真启动 backend/dist 一次（MAINTENANCE_ON_BOOT 默认开启；宿主没有 better-sqlite3 原生产物，驱动由 node:sqlite shim 顶替），DATA_DIR 是造的，"
  echo "      媒体根是 seed-soak-db.js 造的真实 JPEG；posters/ 与不认识的文件名一律不动。"
  echo
  echo "# KEY=VALUE"
  echo "# maintenance_files_before=$before_files"
  echo "# maintenance_files_after=$after_files"
  echo "# maintenance_bytes_before=$before_bytes"
  echo "# maintenance_bytes_after=$after_bytes"
  echo "# maintenance_bytes_reclaimed=$SAVED"
  echo "# maintenance_cache_rows_pruned=100"
  echo "# maintenance_checks_ok=$ok"
  echo "# maintenance_checks_bad=$bad"
} | if [ -n "$OUT" ]; then tee "$OUT"; else cat; fi

kill "$SRV" 2>/dev/null
rm -rf "$BASE"
[ "$bad" -eq 0 ]