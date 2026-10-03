#!/usr/bin/env bash
# =============================================================================
# ScreenPlay — 性能 / 占用基线采集（只读，用于优化前后的三项对比数据）
#
#   bash scripts/perf-baseline.sh                    # 被动基线
#   bash scripts/perf-baseline.sh --load             # 追加读负载（看内存增长与回收）
#   AUTH_USER=xxx AUTH_PASSWORD=yyy bash scripts/perf-baseline.sh --load
#   OUT=/tmp/before.txt bash scripts/perf-baseline.sh
#
# 上面这几个 `NAME=VALUE` 既可以当**环境变量前缀**，也可以直接当**参数**写在后面：
#   bash scripts/perf-baseline.sh --load OUT=docs/perf/before-docker.txt
# 两者等价（OUT / REQ_COUNT / BASE_URL / IMAGE / CONTAINER / AUTH_USER /
# AUTH_PASSWORD / MEDIA_HOST_DIR 都支持）。
#
# 采集内容：
#   ① 镜像：体积、层数、创建时间、各层大小合计
#   ② 容器运行：状态/重启次数、docker stats、/proc/1 的 VmRSS/VmHWM、
#      cgroup 内存峰值（memory.peak / max_usage_in_bytes）与当前占用、内存上限
#   ③ 磁盘：/data 各子目录（proxied/thumbnails/covers/previews/posters/db）
#      与宿主机侧产物、媒体库、docker 日志文件
#   ④ SQLite：page_size/page_count/freelist_count/journal_mode/cache_size/
#      mmap_size/表与索引数量/各表行数/dbstat 各对象字节数/WAL 大小
#   ⑤ 热接口：延迟与响应体积（带凭据时含需登录接口）
#   ⑥ --load：连续读请求前后的 RSS/内存增量（缓存与泄漏走向）
#
# 只读保证：容器内仅写 /tmp/.perf-db.js 一个临时脚本，跑完即删；数据库以
# readonly 打开，失败则改用 /tmp 下的副本（绝不写原始数据卷）。
#
# 末尾输出机器可读的 "# KEY=VALUE" 块，便于 before/after diff。
# =============================================================================
set -uo pipefail

IMAGE="${IMAGE:-screenplay:latest}"
CONTAINER="${CONTAINER:-screenplay}"
BASE_URL="${BASE_URL:-http://127.0.0.1:3001}"
MEDIA_HOST_DIR="${MEDIA_HOST_DIR:-}"
# 未显式给定时从 .env 读（compose 用的是 MEDIA_HOST_DIR）
if [ -z "$MEDIA_HOST_DIR" ] && [ -r "$(dirname "${BASH_SOURCE[0]}")/../.env" ]; then
  MEDIA_HOST_DIR="$(sed -n 's/^MEDIA_HOST_DIR=//p' "$(dirname "${BASH_SOURCE[0]}")/../.env" | head -1)"
fi
LOAD=0
REQ_COUNT="${REQ_COUNT:-60}"
OUT="${OUT:-}"

for arg in "$@"; do
  case "$arg" in
    --load) LOAD=1 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    # 容错：也接受把赋值写成**参数**，即两种写法都行 ——
    #   OUT=/tmp/before.txt bash scripts/perf-baseline.sh --load
    #   bash scripts/perf-baseline.sh --load OUT=/tmp/before.txt
    # （报告正文与操作卡里给的是后一种；早期只认环境变量前缀形式，写成参数会被当成
    #   未知参数直接 exit 2 —— 那样用户第一次「优化前」采集会白跑一次，而 before 只有一次机会。）
    OUT=*)           OUT="${arg#OUT=}" ;;
    REQ_COUNT=*)     REQ_COUNT="${arg#REQ_COUNT=}" ;;
    BASE_URL=*)      BASE_URL="${arg#BASE_URL=}" ;;
    IMAGE=*)         IMAGE="${arg#IMAGE=}" ;;
    CONTAINER=*)     CONTAINER="${arg#CONTAINER=}" ;;
    AUTH_USER=*)     AUTH_USER="${arg#AUTH_USER=}" ;;
    AUTH_PASSWORD=*) AUTH_PASSWORD="${arg#AUTH_PASSWORD=}" ;;
    MEDIA_HOST_DIR=*) MEDIA_HOST_DIR="${arg#MEDIA_HOST_DIR=}" ;;
    *) echo "未知参数：$arg（见 --help）" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
info() { printf '\033[1;34m[INFO]\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m[WARN]\033[0m %s\n' "$1"; }
ok()   { printf '\033[1;32m[ OK ]\033[0m %s\n' "$1"; }
kv()   { printf '  %-28s %s\n' "$1" "$2"; }

RESULTS=()
rec() { RESULTS+=("$1=$2"); }

human() { # KB -> human
  awk -v k="$1" 'BEGIN{ if(k>=1048576) printf "%.2f GiB", k/1048576; else if(k>=1024) printf "%.1f MiB", k/1024; else printf "%d KiB", k }'
}
bytes_human() {
  awk -v b="$1" 'BEGIN{ if(b>=1073741824) printf "%.2f GiB", b/1073741824; else if(b>=1048576) printf "%.1f MiB", b/1048576; else if(b>=1024) printf "%.1f KiB", b/1024; else printf "%d B", b }'
}

DOCKER="docker"
if ! $DOCKER info >/dev/null 2>&1; then
  warn "当前账户无法访问 docker（/var/run/docker.sock 权限）。"
  warn "请用能访问 docker 的账户运行，或：sudo -E bash scripts/perf-baseline.sh ${*:-}"
  exit 1
fi

COOKIE_JAR="$(mktemp 2>/dev/null || echo /tmp/sp-perf-cookies.$$)"
# 退出兜底：docker 门禁通过之后再注册；即使后面某一步失败，也把已采集到的 KEY=VALUE 落盘
# —— 「优化前」的采集只有一次机会，不能因为末尾某个小错就丢掉整份数据。
dump_out() {
  [ -n "$OUT" ] || return 0
  [ "${#RESULTS[@]}" -gt 0 ] || return 0
  { printf '# ScreenPlay perf baseline %s\n' "$(date '+%F %T')"
    printf '%s\n' "${RESULTS[@]}" | sort -u
  } > "$OUT" 2>/dev/null || true
}
trap 'rm -f "$COOKIE_JAR"; dump_out' EXIT
curl() { command curl -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$@"; }

login() {
  local u="${AUTH_USER:-}" p="${AUTH_PASSWORD:-}"
  [ -n "$u" ] && [ -n "$p" ] || return 1
  local code
  code="$(command curl -sS -m 25 -o /dev/null -w '%{http_code}' -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
    -X POST "${BASE_URL}/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"${u}\",\"password\":\"${p}\",\"remember\":true}" 2>/dev/null)"
  [ "$code" = "200" ] || [ "$code" = "201" ]
}

# ---------------------------------------------------------------- ① 镜像
step "1/6 镜像"
img_id="$($DOCKER image inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null || true)"
if [ -z "$img_id" ]; then
  warn "镜像 $IMAGE 不存在（先 docker build / 部署）"
  rec image_present 0
else
  read -r img_size img_created img_layers < <($DOCKER image inspect "$IMAGE" \
    --format '{{.Size}} {{.Created}} {{len .RootFS.Layers}}' 2>/dev/null)
  kv "镜像" "$IMAGE"
  kv "镜像 ID" "${img_id:0:19}"
  kv "体积（解压）" "$(bytes_human "${img_size:-0}")"
  kv "层数" "${img_layers:-?}"
  kv "创建时间" "${img_created:-?}"
  layer_sum=0
  while read -r sz; do
    # docker history 给的是 "178MB" / "12.5MB" / "340kB" / "1.2GB" / "0B" 这种人类可读字符串：
    # 先取数字前缀，再按**完整单位后缀**换算（早期版本只看最后一个字符，把 "178MB" 当成 178 B，
    # 合计只剩几百字节的假值）。
    n=$(printf '%s' "$sz" | awk '
      { s=$0; if (match(s, /^[0-9.]+/)) { v=substr(s, RSTART, RLENGTH)+0; u=substr(s, RLENGTH+1) } else { v=0; u="" }
        if (u=="B") b=v;
        else if (u=="kB" || u=="KB" || u=="k") b=v*1024;
        else if (u=="MB" || u=="M") b=v*1048576;
        else if (u=="GB" || u=="G") b=v*1073741824;
        else if (u=="TB" || u=="T") b=v*1099511627776;
        else b=0;
        printf "%d", b }')
    layer_sum=$((layer_sum + ${n:-0}))
  done < <($DOCKER history --no-trunc --format '{{.Size}}' "$IMAGE" 2>/dev/null)
  kv "各层大小合计（含元数据）" "$(bytes_human "$layer_sum")"
  rec image_size_bytes "${img_size:-0}"
  rec image_layers "${img_layers:-0}"
  rec image_layer_sum_bytes "$layer_sum"
fi

# ---------------------------------------------------------------- ② 容器内存
step "2/6 容器运行时内存"
running="$($DOCKER inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)"
if [ "$running" != "true" ]; then
  warn "容器 $CONTAINER 未在运行"
  rec container_running 0
else
  kv "状态/健康/重启次数" "$($DOCKER inspect -f '{{.State.Status}} / {{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}} / {{.RestartCount}}' "$CONTAINER" 2>/dev/null)"
  kv "启动时间" "$($DOCKER inspect -f '{{.State.StartedAt}}' "$CONTAINER" 2>/dev/null)"
  stats="$($DOCKER stats --no-stream --format '{{.MemUsage}} | {{.MemPerc}} | {{.CPUPerc}} | PIDs {{.PIDs}}' "$CONTAINER" 2>/dev/null)"
  kv "docker stats" "${stats:-（取不到）}"
  proc="$($DOCKER exec "$CONTAINER" sh -c 'grep -E "^(VmPeak|VmHWM|VmRSS|VmData):" /proc/1/status' 2>/dev/null || true)"
  echo "$proc" | sed 's/^/  /'
  rss_kb=$(echo "$proc" | awk '/VmRSS/{print $2}')
  hwm_kb=$(echo "$proc" | awk '/VmHWM/{print $2}')
  vmpeak_kb=$(echo "$proc" | awk '/VmPeak/{print $2}')
  # cgroup v2 / v1
  cg="$($DOCKER exec "$CONTAINER" sh -c '
    v2=/sys/fs/cgroup/memory.current; v2p=/sys/fs/cgroup/memory.peak; v2m=/sys/fs/cgroup/memory.max
    v1=/sys/fs/cgroup/memory/memory.usage_in_bytes; v1p=/sys/fs/cgroup/memory/memory.max_usage_in_bytes; v1l=/sys/fs/cgroup/memory/memory.limit_in_bytes
    if [ -f "$v2" ]; then printf "v2 cur=%s peak=%s max=%s" "$(cat $v2)" "$(cat $v2p 2>/dev/null||echo -)" "$(cat $v2m 2>/dev/null||echo -)";
    elif [ -f "$v1" ]; then printf "v1 cur=%s peak=%s max=%s" "$(cat $v1)" "$(cat $v1p 2>/dev/null||echo -)" "$(cat $v1l 2>/dev/null||echo -)";
    else printf "none"; fi' 2>/dev/null || echo none)"
  kv "cgroup 内存" "$cg"
  cg_cur=$(echo "$cg" | sed -n 's/.*cur=\([0-9]*\).*/\1/p')
  cg_peak=$(echo "$cg" | sed -n 's/.*peak=\([0-9]*\).*/\1/p')
  kv "RSS / 峰值 RSS(VmHWM)" "$(bytes_human "$(( ${rss_kb:-0} * 1024 ))") / $(bytes_human "$(( ${hwm_kb:-0} * 1024 ))")"
  kv "VmPeak（虚拟地址空间峰值）" "$(bytes_human "$(( ${vmpeak_kb:-0} * 1024 ))")"
  kv "node 版本 / NODE_OPTIONS" "$($DOCKER exec "$CONTAINER" sh -c 'node -v; echo "NODE_OPTIONS=${NODE_OPTIONS:-（未设置）}"' 2>/dev/null | tr '\n' ' ')"
  rec container_running 1
  rec rss_bytes "$(( ${rss_kb:-0} * 1024 ))"
  rec rss_hwm_bytes "$(( ${hwm_kb:-0} * 1024 ))"
  rec vmpeak_bytes "$(( ${vmpeak_kb:-0} * 1024 ))"
  rec cgroup_current_bytes "${cg_cur:-0}"
  rec cgroup_peak_bytes "${cg_peak:-0}"
fi

# ---------------------------------------------------------------- ③ 磁盘
step "3/6 磁盘占用"
if [ "$running" = "true" ]; then
  total_kb=$($DOCKER exec "$CONTAINER" sh -c 'du -sk /data 2>/dev/null | cut -f1' 2>/dev/null || echo 0)
  kv "/data 合计" "$(human "${total_kb:-0}")"
  rec data_total_kb "${total_kb:-0}"
  echo "  /data 明细（子目录体积）："
  $DOCKER exec "$CONTAINER" sh -c 'du -sk /data/* 2>/dev/null | sort -rn' 2>/dev/null \
    | while read -r kb path; do printf '    %-34s %s\n' "$(basename "$path")" "$(human "$kb")"; done
  echo "  /data 明细（非目录项）："
  $DOCKER exec "$CONTAINER" sh -c 'ls -l /data 2>/dev/null' 2>/dev/null \
    | awk 'NR>1 && $9!="" && $1 !~ /^d/ {printf "    %-34s %s\n", $9, $5}' 
  db_bytes=$($DOCKER exec "$CONTAINER" sh -c 'ls -l /data/*.db 2>/dev/null | awk "{s+=\$5} END{print s+0}"' 2>/dev/null || echo 0)
  wal_bytes=$($DOCKER exec "$CONTAINER" sh -c 'ls -l /data/*.db-wal 2>/dev/null | awk "{s+=\$5} END{print s+0}"' 2>/dev/null || echo 0)
  rec db_bytes "${db_bytes:-0}"
  # 注意：这里叫 *_file_bytes，别和 ④ 探针的 db_wal_bytes 重名 —— 同一个键两处赋值会让
  # "# KEY=VALUE" 汇总里出现两行同键不同值。
  rec db_wal_file_bytes "${wal_bytes:-0}"
  kv "数据库主文件 / WAL" "$(bytes_human "${db_bytes:-0}") / $(bytes_human "${wal_bytes:-0}")"
  # 容器日志体积
  log_path=$($DOCKER inspect -f '{{.LogPath}}' "$CONTAINER" 2>/dev/null || true)
  log_size="（读不到）"
  if [ -n "$log_path" ] && [ -r "$log_path" ]; then
    log_size="$(du -h "$log_path" 2>/dev/null | cut -f1)  ($log_path)"
  elif [ -n "$log_path" ]; then
    log_size="（宿主机权限不足，需 sudo du -h $log_path）"
  fi
  kv "容器日志文件" "$log_size"
  rec container_log_path "${log_path:-}"
fi
kv "compose 日志轮转配置" "$(grep -qE '^\s*logging:' "$ROOT/docker-compose.yml" 2>/dev/null && echo '已配置' || echo '未配置（用 docker 默认 json-file，无上限）')"
echo "  宿主机侧："
for d in "$MEDIA_HOST_DIR" "$ROOT/web/dist" "$ROOT/web/dist-desktop" "$ROOT/backend/dist" "$ROOT/node_modules" "$ROOT/logs" "$ROOT/dist-image" "$ROOT/windows/.cache"; do
  [ -n "$d" ] && [ -e "$d" ] && printf '    %-24s %s\n' "$d" "$(du -sh "$d" 2>/dev/null | cut -f1)"
done
host_media_kb=""
[ -n "$MEDIA_HOST_DIR" ] && host_media_kb=$(du -sk "$MEDIA_HOST_DIR" 2>/dev/null | cut -f1)
rec host_media_kb "${host_media_kb:-0}"
rec web_dist_kb "$(du -sk "$ROOT/web/dist" 2>/dev/null | cut -f1 | tr -d '\n')"
rec node_modules_kb "$(du -sk "$ROOT/node_modules" 2>/dev/null | cut -f1 | tr -d '\n')"

# ---------------------------------------------------------------- ④ SQLite
step "4/6 SQLite 结构与碎片"
if [ "$running" = "true" ]; then
  cat > /tmp/.perf-db.js <<'JS'
// 一次性只读探针：容器内没有宿主的 better-sqlite3 编译产物，这里用的是镜像自带的那个。
// 整段包在 try/catch 里 —— 就算某个 pragma 取不到，也要把已经拿到的数据全打出来，
// 不能因为一行失败让「SQLite 结构与碎片」整节空掉（这份基线只采一次，没法重跑补）。
const fs = require("fs"), path = require("path");
const dir = process.env.DATA_DIR || "/data";
const out = [];
try {
  let file = process.env.DB_FILENAME ? path.join(dir, process.env.DB_FILENAME) : "";
  if (!file || !fs.existsSync(file)) {
    const hit = fs.readdirSync(dir).filter((f) => f.endsWith(".db"))[0];
    file = hit ? path.join(dir, hit) : path.join(dir, "screenplay.db");
  }
  function load() {
    try { return require("/app/node_modules/better-sqlite3"); } catch (e) { return require("better-sqlite3"); }
  }
  const Database = load();
  let db = null, source = file;
  try { db = new Database(file, { readonly: true, fileMustExist: true }); }
  catch (e) {
    // WAL + readonly 需要可写 shm：改用 /tmp 下的副本，绝不动原始数据
    const cp = "/tmp/.perf-db-copy"; fs.rmSync(cp, { recursive: true, force: true }); fs.mkdirSync(cp);
    for (const f of fs.readdirSync(dir)) if (f.startsWith(path.basename(file))) fs.copyFileSync(path.join(dir, f), path.join(cp, path.basename(f)));
    source = path.join(cp, path.basename(file));
    db = new Database(source, { readonly: true, fileMustExist: true });
  }
  const scalar = (v) => {
    if (v === null || v === undefined) return "n/a";
    if (typeof v === "object") { try { return JSON.stringify(v); } catch (e) { return "n/a"; } }
    return v;
  };
  const pragma = (k) => { try { return scalar(db.pragma(k, { simple: true })); } catch (e) { return "n/a"; } };
  const stat = (f) => { try { return fs.statSync(f).size; } catch (e) { return 0; } };
  out.push("db_file=" + file);
  out.push("db_read_via=" + (source === file ? "original(readonly)" : "tmp-copy(readonly)"));
  out.push("db_main_bytes=" + stat(file));
  out.push("db_wal_bytes=" + stat(file + "-wal"));
  out.push("db_shm_bytes=" + stat(file + "-shm"));
  for (const k of ["page_size","page_count","freelist_count","journal_mode","synchronous","cache_size","mmap_size","temp_store","auto_vacuum","user_version","encoding"]) {
    try { out.push("db_" + k + "=" + pragma(k)); } catch (e) { out.push("db_" + k + "=n/a"); }
  }
  const objs = db.prepare("SELECT type,name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  out.push("db_tables=" + objs.filter((o) => o.type === "table").length);
  out.push("db_indexes=" + objs.filter((o) => o.type === "index").length);
  for (const t of objs.filter((o) => o.type === "table")) {
    try { out.push("rows_" + t.name + "=" + db.prepare('SELECT COUNT(*) AS c FROM "' + t.name + '"').get().c); }
    catch (e) { out.push("rows_" + t.name + "=n/a"); }
  }
  try {
    const rows = db.prepare("SELECT name, SUM(pgsize) AS b FROM dbstat GROUP BY name ORDER BY b DESC LIMIT 30").all();
    for (const r of rows) out.push("bytes_" + r.name + "=" + r.b);
  } catch (e) { out.push("dbstat=unavailable"); }
  try { out.push("db_quick_check=" + db.pragma("quick_check").map(function (r) { return Object.values(r).join("/"); }).join("|")); } catch (e) { out.push("db_quick_check=n/a"); }
} catch (err) {
  out.push("db_probe_error=" + String((err && err.message) || err).replace(/[\r\n]+/g, " "));
}
for (const r of out) console.log(r);
JS
  $DOCKER exec -i "$CONTAINER" sh -c 'cat > /tmp/.perf-db.js' < /tmp/.perf-db.js 2>/dev/null || true
  $DOCKER exec "$CONTAINER" node /tmp/.perf-db.js > /tmp/.perf-db.out 2>/tmp/.perf-db.err || true
  if [ -s /tmp/.perf-db.out ]; then
    sed 's/^/  /' /tmp/.perf-db.out
    while IFS='=' read -r k v; do [ -n "$k" ] && rec "$k" "${v%%$'\r'}"; done < /tmp/.perf-db.out
  else
    warn "容器内取 SQLite 统计失败（不影响其它项）"
    sed 's/^/    /' /tmp/.perf-db.err 2>/dev/null | tail -3
  fi
  $DOCKER exec "$CONTAINER" rm -f /tmp/.perf-db.js 2>/dev/null || true
else
  warn "容器未运行，跳过"
fi

# ---------------------------------------------------------------- ⑤ 接口
step "5/6 热接口延迟（已登录：$([ -n "${AUTH_USER:-}" ] && echo 是 || echo 否)）"
authed=0
if login; then authed=1; ok "已登录（$AUTH_USER）"; else warn "未提供 AUTH_USER/AUTH_PASSWORD，仅测公开接口"; fi
gid=""
if [ "$authed" = "1" ]; then
  gid="$(curl -sS -m 20 "${BASE_URL}/api/games?limit=1" 2>/dev/null \
    | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin)
    a=d.get("items") if isinstance(d,dict) else d
    print(a[0]["id"] if a else "")
except Exception: print("")' 2>/dev/null)"
fi
[ -n "$gid" ] || gid=1

# 图片接口要的是 **media id（UUID）**，不是 game id —— 拿第一条媒体的 id 来测，
# 否则那三条只会记下一个 404 的耗时，把「图片渲染件」这一最重要的热路径漏掉。
mid=""
if [ "$authed" = "1" ]; then
  mid="$(curl -sS -m 20 "${BASE_URL}/api/games/${gid}/media" 2>/dev/null \
    | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin)
    a=d.get("items") if isinstance(d,dict) else d
    print(a[0]["id"] if a else "")
except Exception: print("")' 2>/dev/null)"
fi
[ -n "$mid" ] || mid="$gid"
URLS=(
  "/api/health"
  "/api/games?limit=60"
  "/api/games/stats"
  "/api/library/status"
  "/api/settings"
  "/api/games/${gid}"
  "/api/games/${gid}/media"
  "/api/games/${gid}/neighbors"
  "/api/games/${gid}/media-reviews?page=1"
  "/api/media/${mid}/thumbnail"
  "/api/media/${mid}/cover"
  "/api/media/${mid}/preview"
)
printf '  %-42s %-6s %-11s %s\n' "URL" "HTTP" "耗时" "体积"
for u in "${URLS[@]}"; do
  read -r code t sz < <(curl -sS -o /dev/null -m 30 -w '%{http_code} %{time_total} %{size_download}' "${BASE_URL}${u}" 2>/dev/null)
  printf '  %-42s %-6s %-11s %s\n' "$u" "${code:-?}" "${t:-?}s" "$(bytes_human "${sz:-0}")"
  rec "api_${u//[^A-Za-z0-9]/_}_ms" "$(awk -v t="${t:-0}" 'BEGIN{printf "%.1f", t*1000}')"
done

# ---------------------------------------------------------------- ⑥ 负载
if [ "$LOAD" = "1" ] && [ "$running" = "true" ]; then
  step "6/6 读负载测试（${REQ_COUNT} 轮 ≈ $((REQ_COUNT*5)) 次请求）"
  cg_file="/sys/fs/cgroup/memory.current"
  $DOCKER exec "$CONTAINER" sh -c "test -f $cg_file" 2>/dev/null || cg_file="/sys/fs/cgroup/memory/memory.usage_in_bytes"
  read_mem() { $DOCKER exec "$CONTAINER" sh -c "cat $cg_file 2>/dev/null; grep VmRSS /proc/1/status" 2>/dev/null | tr '\n' ' '; }
  # 输出被 tr 拼成一行后，RSS 的数字不是 $2（$2 恰好是 "VmRSS:" 本身）——曾因此在
  # `$(( (${a_rss:-0} - ${b_rss:-0}) * 1024 ))` 里触发 set -u 的 unbound variable，
  # 并在写 OUT 之前退出（现在还有 EXIT 兜底）。这里按「VmRSS: 之后的下一个字段」定位，
  # 并对任何非数字输出回落到 0。
  num1() { printf '%s\n' "$1" | awk '{print $1}' | grep -E '^-?[0-9]+$' || echo 0; }
  rss_kb() { printf '%s\n' "$1" | awk '{for(i=1;i<=NF;i++) if($i=="VmRSS:"){print $(i+1); exit}}' | grep -E '^[0-9]+$' || echo 0; }
  before="$(read_mem)"
  kv "负载前(cgroup, RSS)" "$before"
  ok "发送 ${REQ_COUNT} 次读请求…"
  for i in $(seq 1 "$REQ_COUNT"); do
    for u in "/api/health" "/api/games?limit=60" "/api/games/${gid}/media" "/api/media/${mid}/thumbnail" "/api/games/${gid}/media-reviews?page=1"; do
      curl -s -o /dev/null -m 20 "${BASE_URL}${u}" 2>/dev/null
    done
  done
  sleep 3
  after="$(read_mem)"
  kv "负载后(cgroup, RSS)" "$after"
  b_cur=$(num1 "$before"); a_cur=$(num1 "$after")
  b_rss=$(rss_kb "$before"); a_rss=$(rss_kb "$after")
  delta_cur=$(( a_cur - b_cur ))
  delta_rss=$(( (a_rss - b_rss) * 1024 ))
  kv "cgroup 当前内存增量" "$(bytes_human "$delta_cur")（负值=已回收）"
  kv "RSS 增量" "$(bytes_human "$delta_rss")"
  rec load_cgroup_delta_bytes "$delta_cur"
  rec load_rss_delta_bytes "$delta_rss"
  rec load_requests "$REQ_COUNT"
else
  step "6/6 读负载测试"
  info "未启用（加 --load 启用）"
fi

# ---------------------------------------------------------------- 汇总
step "机器可读汇总（before/after diff 用）"
SUMMARY="$(printf '%s\n' "${RESULTS[@]}" | sort -u)"
if [ -n "$OUT" ]; then printf '# ScreenPlay perf baseline %s\n%s\n' "$(date '+%F %T')" "$SUMMARY" > "$OUT"; ok "已写入 $OUT"; fi
printf '%s\n' "$SUMMARY" | sed 's/^/# /'
echo
ok "基线采集完成（$(date '+%F %T')）"