#!/usr/bin/env bash
# =============================================================================
# ScreenPlay — 把两次 `perf-baseline.sh` 的采集结果拼成「优化前后对比表」
#
#   bash scripts/perf-compare.sh docs/perf/before-docker.txt docs/perf/after-docker.txt
#   bash scripts/perf-compare.sh before.txt after.txt docs/perf/对比.md
#
# 输入：perf-baseline.sh 末尾那段 `# KEY=VALUE`（带不带 `# ` 前缀都认）。
# 输出：Markdown —— 三项主指标（镜像体积 / 运行内存峰值 / 磁盘占用）+ 明细附录。
# 只读这两个文件，不碰 docker、不碰容器。
# =============================================================================
set -uo pipefail

A="${1:-}"; B="${2:-}"; OUT="${3:-}"
[ -n "$A" ] && [ -n "$B" ] || { sed -n '2,12p' "$0"; exit 2; }
for f in "$A" "$B"; do [ -r "$f" ] || { echo "读不到：$f" >&2; exit 2; }; done

# KEY=VALUE → 去掉 `# ` 前缀、注释行、空行；同一个 key 出现多次时以第一次为准
load() { sed -n 's/^[[:space:]]*#[[:space:]]*//p; s/^[[:space:]]*//p' "$1" \
         | awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/ && $2 != "" { if (!($1 in seen)) { seen[$1]=1; print } }'; }

va="$(load "$A")"; vb="$(load "$B")"
get() { printf '%s\n' "$2" | awk -F= -v k="$1" '$1==k { sub(/^[^=]*=/,""); print; exit }'; }

# 字节数 → 人类可读（支持负数差值：先取绝对值，符号保留 —— 否则 awk 对负数比较全不成立，
# 差值列会退化成「-41706652 B」这种原始字节数）
hb() { awk -v b="${1:-0}" 'BEGIN{ s=""; if (b < 0) { s="-"; b = -b } if(b>=1073741824) printf "%s%.2f GiB", s, b/1073741824;
  else if(b>=1048576) printf "%s%.1f MiB", s, b/1048576; else if(b>=1024) printf "%s%.1f KiB", s, b/1024; else printf "%s%d B", s, b }'; }
num() { [[ "${1:-}" =~ ^-?[0-9]+(\.[0-9]+)?$ ]]; }

# 一行明细：key 显示名 | 单位换算 | 是否越大越好（0 = 越小越好；**传非 0 表示不做方向判断**，
# 用于「层数」「page_size/cache_size/mmap_size/journal_mode」这类只有「变了/没变」而无关好坏的行，
# 免得给中性变化打上 ⚠️/✅）
row() {
  local key="$1" label="$2" unit="${3:-bytes}" dir="${4:-0}"
  local a b pa pb d pct mark
  a="$(get "$key" "$va")"; b="$(get "$key" "$vb")"
  [ -n "$a" ] || a="—"; [ -n "$b" ] || b="—"
  if [ "$unit" = "bytes" ]; then
    [ "$a" = "—" ] && pa="—" || pa="$(hb "$a")"
    [ "$b" = "—" ] && pb="—" || pb="$(hb "$b")"
  elif [ "$unit" = "kb" ]; then
    [ "$a" = "—" ] && pa="—" || pa="$(hb "$((a * 1024))")"
    [ "$b" = "—" ] && pb="—" || pb="$(hb "$((b * 1024))")"
  else
    pa="$a"; pb="$b"
  fi
  d="—"; pct=""
  if num "$a" && num "$b"; then
    local dnum cmp
    dnum="$(awk -v a="$a" -v b="$b" 'BEGIN{ print b-a }')"
    case "$unit" in
      bytes) d="$(hb "$(awk -v x="$dnum" 'BEGIN{ printf "%.0f", x }')")" ;;
      kb)    d="$(hb "$(awk -v x="$dnum" 'BEGIN{ printf "%.0f", x*1024 }')")" ;;
      *)     d="$(awk -v x="$dnum" -v c="$a$b" 'BEGIN{ printf (c ~ /\./) ? "%.1f" : "%.0f", x }')" ;;
    esac
    if [ "$a" != "0" ]; then
      pct="$(awk -v x="$a" -v y="$b" 'BEGIN{ p=(y-x)*100/x; if (p > 0.05 || p < -0.05) printf "%+.1f%%", p }')"
    fi
    # 方向标记（用 awk 比较，避免 bash 只能比整数）
    cmp="$(awk -v a="$a" -v b="$b" 'BEGIN{ if (b<a) print "lt"; else if (b>a) print "gt"; else print "eq" }')"
    # 方向判定：dir=0 判断「越小越好」并加 ✅/⚠️；dir=2 是结构性/中性行（层数、PRAGMA 原值），
    # 只报差值、不判方向也不给百分比 —— 「层数 -1」说成「缩小」或「-7.7%」都没有意义。
    if [ "$dir" = "0" ]; then
      case "$cmp" in lt) mark="✅ 缩小" ;; gt) mark="⚠️ 增大" ;; *) mark="持平" ;; esac
    elif [ "$dir" = "2" ]; then
      if [ "$cmp" = "eq" ]; then mark="持平"; else mark="（不判方向）"; fi
      pct=""
    else
      case "$cmp" in lt) mark="缩小" ;; gt) mark="增大" ;; *) mark="持平" ;; esac
    fi
    d="$d  $pct  $mark"
  fi
  printf '| %s | %s | %s | %s |\n' "$label" "$pa" "$pb" "$d"
}

{
  echo "# ScreenPlay 优化前后对比（容器侧实测）"
  echo
  echo "- 优化前：\`$A\`（$(sed -n '1p' "$A" | sed 's/^# //')）"
  echo "- 优化后：\`$B\`（$(sed -n '1p' "$B" | sed 's/^# //')）"
  echo "- 生成：\`bash scripts/perf-compare.sh\` —— 只读这两个文件"
  echo
  echo "## 一、镜像体积"
  echo
  echo "| 项目 | 优化前 | 优化后 | 变化（差值 / 百分比） |"
  echo "| --- | --- | --- | --- |"
  row image_size_bytes "镜像解压体积"
  row image_layer_sum_bytes "各层大小合计"
  row image_layers "层数" plain 2
  echo
  echo "## 二、运行内存峰值"
  echo
  echo "| 项目 | 优化前 | 优化后 | 变化（差值 / 百分比） |"
  echo "| --- | --- | --- | --- |"
  row rss_hwm_bytes "VmHWM（进程 RSS 峰值）"
  row cgroup_peak_bytes "cgroup 内存峰值（含内核/页缓存）"
  row rss_bytes "VmRSS（采集时刻 RSS）"
  row cgroup_current_bytes "cgroup 当前占用"
  row vmpeak_bytes "VmPeak（虚拟地址空间峰值）"
  row load_cgroup_delta_bytes "读负载后 cgroup 增量"
  row load_rss_delta_bytes "读负载后 RSS 增量"
  echo
  echo "## 三、磁盘占用"
  echo
  echo "| 项目 | 优化前 | 优化后 | 变化（差值 / 百分比） |"
  echo "| --- | --- | --- | --- |"
  row data_total_kb "/data 合计" kb
  row db_main_bytes "SQLite 主文件（探针 stat，权威口径）" bytes
  row db_bytes "SQLite 主文件（③ 段 ls -l 汇总，口径存疑）" bytes 2
  row db_wal_file_bytes "SQLite WAL（采集时刻，空闲态）" bytes
  row db_wal_bytes "SQLite WAL（读负载后探针）" bytes
  row db_page_count "页数（page_count）" plain
  row db_freelist_count "空闲页（freelist_count）" plain
  echo
  echo "> 关于上面两组同名指标：③ 段用容器里 \`ls -l /data/*.db | awk {s+=\$5}\` 汇总、④ 段探针用"
  echo "> \`stat()\`，同一容器同一时刻附近却给出不同的数（实测 3,399,680 B vs 268,697,600 B），成因未定；"
  echo "> 本表**以探针的 stat 为准**，并保留 ③ 段数值供对照。WAL 同理：读负载后两边都停在 1000 页"
  echo "> 自动 checkpoint 阈值（4 MiB），真正体现启动 \`wal_checkpoint(TRUNCATE)\` 的是「采集时刻」那一行。"
  echo
  echo "> 容器侧「/data 子目录明细」「宿主侧产物」见两份原始基线文件；镜像瘦身明细见 \`docs/perf/PERF-REPORT.md\` 3.1。"
  echo
  echo "## 四、附录：SQLite 与热接口"
  echo
  echo "| 项目 | 优化前 | 优化后 | 变化（差值 / 百分比） |"
  echo "| --- | --- | --- | --- |"
  row db_page_size "page_size" plain 2
  row db_cache_size "cache_size" plain 2
  row db_mmap_size "mmap_size" plain 2
  row db_journal_mode "journal_mode" plain 2
  echo
  echo "**接口耗时（ms）**"
  echo
  echo "| 接口 | 优化前 | 优化后 | 变化（差值 / 百分比） |"
  echo "| --- | --- | --- | --- |"
  printf '%s\n' "$va" | awk -F= '/^api_[A-Za-z0-9_]*_ms=/ { print $1 }' | while read -r k; do row "$k" "$k" plain; done
  echo
  echo '> 接口键名沿用采集端的写法（`perf-baseline.sh` 把 URL 里所有非字母数字字符换成 `_`，再包上 `api_` 前缀与 `_ms` 后缀），'
  echo '> 所以 `api__api_games_limit_60_ms` 就是 `GET /api/games?limit=60`；只有出现在优化前基线里的接口才列出。'
  echo '>'
  echo '> 附录里的 `cache_size` / `mmap_size` / `synchronous` / `temp_store` 是**探针那条只读连接自己**的 per-connection'
  echo '> 取值（SQLite 不把它们写进库文件），不代表应用进程的设置；`journal_mode` / `user_version` / `page_size` /'
  echo '> `auto_vacuum` 是库文件里的持久属性，看到的就是真实值。'
} > "${OUT:-/dev/stdout}"

if [ -n "$OUT" ]; then echo "已写入 $OUT"; else echo; fi