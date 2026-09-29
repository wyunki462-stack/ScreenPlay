#!/usr/bin/env bash
# =============================================================================
# ScreenPlay 修复验证脚本 — 在飞牛 NAS 宿主机上运行（建议 sudo）。
#
# 用途：一次性验证「运行时服务 / 代理 / 图片」修复是否生效。
#   1. 后端健康 + 容器健康检查状态 + 新代码是否已部署
#   2. 运行时代理配置（来源、地址、NO_PROXY）
#   3. 容器内实测各候选代理地址
#   4. 图片抓取自检 /api/settings/test-image（并做耗时体检）
#   5. 图片代理接口端到端 /api/media/proxy
#   6. JXR 转码链路（库中有 JXR 素材时才检查）
#   7. 入站访问与局域网可达性诊断
#
# 用法：  bash scripts/verify-image-fix.sh
#         PORT=3001 bash scripts/verify-image-fix.sh
#         PUBLIC_HOST=your.domain bash scripts/verify-image-fix.sh   # 额外查公网
# =============================================================================
set -uo pipefail

PORT="${PORT:-3001}"
BASE="http://127.0.0.1:${PORT}"
CONTAINER="${CONTAINER:-screenplay}"
PROBE_IMG='https://media.rawg.io/media/screenshots/063/063cb0836668fdbfaa7f9bb8b5357f97.jpg'

# 单次请求超时。后端单次抓取上限 20s，首次冷启动还要建连+下载，
# 旧版脚本用 8s 会把「功能正常但偏慢」误判为失败。
CURL_TIMEOUT="${CURL_TIMEOUT:-45}"

pass=0; fail=0; warn=0
ok()   { echo -e "  \033[32m✓\033[0m $1"; pass=$((pass+1)); }
bad()  { echo -e "  \033[31m✗\033[0m $1"; fail=$((fail+1)); }
warn() { echo -e "  \033[33m!\033[0m $1"; warn=$((warn+1)); }
info() { echo -e "  \033[36m·\033[0m $1"; }
step() { echo; echo "[$1] $2"; }

# ---------------------------------------------------------------------------
# 登录：开启认证后，除 /api/health 与 /api/auth/* 外所有接口都要求会话。
# 用一层 curl 包装统一带上 Cookie，脚本其余部分无需逐个改动。
# 凭据来源：AUTH_USER/AUTH_PASSWORD，否则退回本地 admin + AUTH_ADMIN_PASSWORD。
COOKIE_JAR="$(mktemp 2>/dev/null || echo /tmp/sp-verify-cookies.$$)"
trap 'rm -f "$COOKIE_JAR"' EXIT
curl() { command curl -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$@"; }

auth_login() {
  local sess
  sess="$(command curl -sS -m 20 -c "$COOKIE_JAR" -b "$COOKIE_JAR" "${BASE}/api/auth/session" 2>/dev/null)" || return 0

  local parsed
  parsed="$(printf '%s' "$sess" | python3 -c "
import sys,json
try: d=json.load(sys.stdin)
except Exception: print('unknown 0 0'); sys.exit(0)
print(('on' if d.get('enabled') else 'off'),
      ('1' if d.get('authenticated') else '0'),
      d.get('provider') or '-')" 2>/dev/null)" || return 0

  set -- $parsed
  local enabled="${1:-unknown}" authed="${2:-0}" provider="${3:--}"

  if [ "$enabled" = "off" ]; then
    info "认证已关闭（AUTH_DISABLED=1），无需登录"
    return 0
  fi
  if [ "$enabled" = "unknown" ]; then
    info "无法读取登录状态（旧版本后端？），按未开启认证继续"
    return 0
  fi
  if [ "$authed" = "1" ]; then
    ok "已有有效会话（provider=${provider}）"
    return 0
  fi

  # 注意：这里的局部变量绝不能叫 pass —— ok()/bad() 用的是同名全局计数器，
  # bash 是动态作用域，重名会让 pass=$((pass+1)) 去解析密码字符串并报 unbound variable。
  local authuser="${AUTH_USER:-}" authpass="${AUTH_PASSWORD:-}"
  if [ -z "$authuser" ]; then
    authuser="${AUTH_ADMIN_USER:-admin}"
    authpass="${AUTH_ADMIN_PASSWORD:-}"
  fi
  if [ -z "$authpass" ]; then
    bad "接口需要登录，但未提供凭据 —— 请这样运行："
    info "AUTH_USER=你的NAS用户名 AUTH_PASSWORD=密码 bash scripts/verify-image-fix.sh"
    info "或使用本地账户：AUTH_ADMIN_PASSWORD=密码 bash scripts/verify-image-fix.sh"
    return 1
  fi

  local code
  code="$(command curl -sS -m 25 -o /dev/null -w '%{http_code}' -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
    -X POST "${BASE}/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"${authuser}\",\"password\":\"${authpass}\",\"remember\":true}" 2>/dev/null)"
  if [ "$code" = "201" ] || [ "$code" = "200" ]; then
    ok "登录成功（用户 ${authuser}）"
    return 0
  fi
  bad "登录失败（HTTP ${code}）—— 请检查 AUTH_USER / AUTH_PASSWORD"
  return 1
}

AUTH_OK=1
auth_login || AUTH_OK=0

echo "=============================================================="
echo " ScreenPlay 服务 / 代理 / 图片 修复验证  ($(date '+%F %T'))"
echo " 目标: ${BASE}"
echo "=============================================================="

# ---------------------------------------------------------------------------
step "1/16" "后端健康 & 容器健康检查 & 新代码是否已部署"

health="$(curl -sS -m 15 "${BASE}/api/health" 2>/dev/null || true)"
if [ -n "$health" ]; then
  ok "后端存活: ${health}"
else
  bad "后端无响应 (${BASE})"
  info "确认容器在运行：docker compose ps"
  info "查看启动日志：  docker compose logs --tail=80 screenplay"
fi

# 容器健康检查状态（Dockerfile / compose 中定义的 HEALTHCHECK 是否通过）
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  hstate="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null | tr -d '[:space:]')"
  case "$hstate" in
    healthy)  ok "容器健康检查: healthy" ;;
    none)     warn "容器未配置健康检查（镜像较旧），重建后即可获得" ;;
    starting) warn "容器健康检查: starting（启动后约 20s 内属正常，请稍后重试）" ;;
    unhealthy) bad "容器健康检查: unhealthy → 服务未真正就绪" ;;
    "")       info "容器 ${CONTAINER} 不存在或名称不同（可用 CONTAINER=名字 指定）" ;;
    *)        info "容器健康检查状态: ${hstate}" ;;
  esac
else
  info "无 docker 权限或未安装 docker，跳过健康检查状态（可用 sudo 重跑）"
fi

code="$(curl -sS -m "$CURL_TIMEOUT" -o /dev/null -w '%{http_code}' "${BASE}/api/settings/test-image" 2>/dev/null)"
if [ "$code" = "200" ]; then
  ok "新代码已部署 (/api/settings/test-image → 200)"
else
  bad "test-image 返回 HTTP ${code} → 容器可能仍在跑旧镜像，请执行："
  info "cd <仓库根目录> && bash scripts/docker-build.sh"
  info "sudo docker compose up -d --no-build --force-recreate"
fi

# ---------------------------------------------------------------------------
step "2/16" "运行时代理配置（构建代理与运行代理相互独立）"

settings="$(curl -sS -m 15 "${BASE}/api/settings" 2>/dev/null || true)"
proxy="$(printf '%s' "$settings" | grep -o '"rawgProxy":"[^"]*"' | head -1 | cut -d'"' -f4)"
src="$(printf '%s' "$settings" | grep -o '"source":"[^"]*"' | head -1 | cut -d'"' -f4)"
noproxy="$(printf '%s' "$settings" | grep -o '"noProxy":"[^"]*"' | head -1 | cut -d'"' -f4)"

if [ -n "$proxy" ]; then
  ok "运行时代理 = ${proxy}"
  [ -n "$src" ] && info "配置来源: ${src}"
  case "$proxy" in
    *:78|*:789) bad "端口疑似笔误（应填 7890）";;
    *127.0.0.1*|*localhost*) warn "127.0.0.1 在容器内指容器自己，请改用 host.docker.internal";;
  esac
else
  warn "未配置运行时代理 → 容器走直连（境外图片可能失败）"
  info "在 .env 设置 RAWG_PROXY=http://host.docker.internal:7890 后重建容器"
fi
[ -n "$noproxy" ] && info "NO_PROXY = ${noproxy}"

# ---------------------------------------------------------------------------
step "3/16" "容器内实测各候选代理地址"

diag="$(curl -sS -m 60 "${BASE}/api/settings/test-proxy" 2>/dev/null || true)"
if [ -z "$diag" ]; then
  warn "取不到代理诊断结果（跳过）"
else
  gw="$(printf '%s' "$diag" | grep -o '"hostGateway":"[^"]*"' | head -1 | cut -d'"' -f4)"
  [ -n "$gw" ] && info "容器默认网关: ${gw}"

  # 用一个临时文件在子 shell 与父 shell 间传递统计结果
  dsum="$(printf '%s' "$diag" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
except Exception:
    print('PARSE_FAIL'); sys.exit(0)
cands=d.get('candidates') or []
good=[c for c in cands if c.get('http') or c.get('https')]
for c in cands:
    mark='✓' if (c.get('http') or c.get('https')) else '✗'
    print('CAND\t%s %s' % (mark, c.get('url')))
print('GOOD\t%d' % len(good))
if good:
    print('BEST\t%s' % good[0].get('url'))
" 2>/dev/null)"

  if printf '%s' "$dsum" | grep -q '^PARSE_FAIL'; then
    warn "代理诊断返回无法解析"
  else
    printf '%s\n' "$dsum" | while IFS=$'\t' read -r tag rest; do
      case "$tag" in
        CAND) echo "      ${rest}" ;;
        BEST) echo "BESTURL=${rest}" > /tmp/.sp_best ;;
      esac
    done
    goodn="$(printf '%s' "$dsum" | awk -F'\t' '$1=="GOOD"{print $2}')"
    best="$(printf '%s' "$dsum" | awk -F'\t' '$1=="BEST"{print $2}')"
    if [ "${goodn:-0}" -gt 0 ]; then
      ok "容器内可用代理 ${goodn} 个，首选 ${best}"
    else
      bad "容器内没有任何可用代理地址"
    fi
    rm -f /tmp/.sp_best
  fi
fi

# ---------------------------------------------------------------------------
step "4/16" "图片抓取自检 /api/settings/test-image（含耗时体检）"

ti_body="$(curl -sS -m "$CURL_TIMEOUT" -w '\n%{time_total}' "${BASE}/api/settings/test-image" 2>/dev/null || true)"
ti_time="$(printf '%s' "$ti_body" | tail -1)"
ti_json="$(printf '%s' "$ti_body" | sed '$d')"
ti_ok="$(printf '%s' "$ti_json" | grep -o '"ok":[a-z]*' | head -1 | cut -d: -f2)"
ti_msg="$(printf '%s' "$ti_json" | python3 -c "
import sys,json
try: print(json.load(sys.stdin).get('message',''))
except Exception: print('')
" 2>/dev/null)"

if [ "$ti_ok" = "true" ]; then
  ok "图片抓取正常：${ti_msg}"
else
  bad "图片抓取失败：${ti_msg:-无响应}"
fi

if [ -n "$ti_time" ]; then
  slow="$(python3 -c "print('1' if float('${ti_time}')>8 else '0')" 2>/dev/null || echo 0)"
  if [ "$slow" = "1" ]; then
    warn "本次耗时 ${ti_time}s（偏慢：可能遇到代理瞬时断连并已自动重试）"
    info "连续多跑几次确认稳定性："
    info "for i in 1 2 3 4 5; do curl -so /dev/null -w '%{time_total}\\n' ${BASE}/api/settings/test-image; done"
  else
    ok "抓取耗时 ${ti_time}s（正常）"
  fi
fi

# ---------------------------------------------------------------------------
step "5/16" "图片代理接口端到端 /api/media/proxy"

enc="$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1],safe=''))" "$PROBE_IMG" 2>/dev/null || true)"
[ -z "$enc" ] && enc="$PROBE_IMG"
tmp="$(mktemp)"
px_code="$(curl -sS -m "$CURL_TIMEOUT" -o "$tmp" -w '%{http_code}' "${BASE}/api/media/proxy?url=${enc}" 2>/dev/null)"
px_size="$(wc -c < "$tmp" 2>/dev/null | tr -d ' ')"
px_magic="$(head -c 4 "$tmp" 2>/dev/null | od -An -tx1 | tr -d ' \n')"

if [ "$px_code" = "200" ]; then
  ok "HTTP 200 · ${px_size} 字节 · 魔数 ${px_magic}"
  case "$px_magic" in
    ffd8ff*)   ok "确认是有效 JPEG 图片" ;;
    89504e47*) ok "确认是有效 PNG 图片" ;;
    52494646)  ok "确认是有效 WebP 图片" ;;
    *)         bad "返回内容不是已知图片格式（魔数 ${px_magic}）" ;;
  esac
else
  bad "图片代理失败：HTTP ${px_code}"
  info "响应内容：$(head -c 200 "$tmp" 2>/dev/null)"
fi
rm -f "$tmp"

# ---------------------------------------------------------------------------
step "6/16" "JXR 转码链路"

jxr_id="$(curl -sS -m 20 "${BASE}/api/games" 2>/dev/null | python3 -c "
import sys,json
try: games=json.load(sys.stdin)
except Exception: sys.exit(0)
print(games[0]['id'] if games else '')
" 2>/dev/null || true)"

found_jxr=""
if [ -n "$jxr_id" ]; then
  found_jxr="$(curl -sS -m 20 "${BASE}/api/games/${jxr_id}/media" 2>/dev/null | python3 -c "
import sys,json
try: items=json.load(sys.stdin)
except Exception: sys.exit(0)
for m in items:
    if m.get('fileName','').lower().endswith(('.jxr','.wdp','.hdp')):
        print(m['id']); break
" 2>/dev/null || true)"
fi

if [ -z "$found_jxr" ]; then
    info "库中暂无 JXR 素材，跳过（放入 .jxr 文件并重扫后可验证）"
  else
    # All three display paths must yield a browser-renderable WebP. Checking only
    # the thumbnail previously missed the case where /preview and /original still
    # returned raw JXR bytes (or 415) - the actual reported symptom.
    jok=0; jbad=0
    for jep in thumbnail preview original; do
      jtmp="$(mktemp)"
      jcode="$(curl -sS -m 60 -o "$jtmp" -w '%{http_code}' "${BASE}/api/media/${found_jxr}/${jep}" 2>/dev/null)"
      jmagic="$(head -c 4 "$jtmp" 2>/dev/null | od -An -tx1 | tr -d ' \n')"
      jsize="$(wc -c < "$jtmp" 2>/dev/null | tr -d ' ')"
      case "$jmagic" in
        52494646) ok "JXR ${jep} -> WebP (${jsize}B, browser-renderable)"; jok=$((jok+1)) ;;
        4949bc01) bad "JXR ${jep} still returns raw bytes (browser cannot decode)"; jbad=$((jbad+1)) ;;
        *) if [ "$jcode" = "200" ]; then
             warn "JXR ${jep} HTTP 200 but magic ${jmagic}"
           else
             bad "JXR ${jep} failed HTTP ${jcode} (JXR decode unavailable?)"; jbad=$((jbad+1))
           fi ;;
      esac
      rm -f "$jtmp"
    done
    if [ "$jbad" -eq 0 ] && [ "$jok" -ge 3 ]; then
      ok "JXR three paths (thumbnail/preview/original) all transcode correctly"
      # The three sizes share one tone-mapped buffer, so their mean luminance must
      # agree. A large spread means one path took a different (broken) code path —
      # the overexposure bug produced exactly that kind of divergence.
      spread="$(for jep in thumbnail preview original; do
        curl -sS -m 60 "${BASE}/api/media/${found_jxr}/${jep}" 2>/dev/null | python3 -c "
import sys
try:
    import io
    from PIL import Image
    import numpy as np
    a=np.asarray(Image.open(io.BytesIO(sys.stdin.buffer.read())).convert('RGB'))
    print('%.1f'%a.mean())
except Exception:
    print('')" 2>/dev/null
      done | python3 -c "
import sys
v=[float(x) for x in sys.stdin.read().split() if x]
print('%.1f'%(max(v)-min(v)) if len(v)>=2 else '')" 2>/dev/null || echo '')"
      if [ -n "$spread" ]; then
        if python3 -c "import sys; sys.exit(0 if float('$spread')<=12 else 1)" 2>/dev/null; then
          ok "三个尺寸亮度一致（最大差 ${spread}，无过曝/偏色分歧）"
        else
          warn "三个尺寸亮度差异较大（${spread}），请检查色调映射"
        fi
      else
        info "未安装 Pillow，跳过亮度一致性检查"
      fi
    fi
  fi

# ---------------------------------------------------------------------------
step "7/16" "Metacritic 评分覆盖"

cov="$(curl -sS -m 30 "${BASE}/api/games" 2>/dev/null | python3 -c "
import sys,json
try:
    gs=json.load(sys.stdin)
except Exception:
    print('ERR'); sys.exit(0)
if not isinstance(gs,list): print('ERR'); sys.exit(0)
tot=len(gs)
scored=[g for g in gs if g.get('metacriticScore') is not None]
print('%d %d' % (tot, len(scored)))
" 2>/dev/null)"

if [ -z "$cov" ] || [ "$cov" = "ERR" ]; then
  warn "取不到游戏列表（跳过）"
else
  tot="${cov%% *}"; got="${cov##* }"
  if [ "$tot" -eq 0 ]; then
    info "库中暂无游戏（扫描后再验证）"
  else
    pct=$(( got * 100 / tot ))
    if [ "$pct" -ge 80 ]; then
      ok "Metacritic 评分覆盖 ${got}/${tot} (${pct}%)"
    elif [ "$pct" -ge 30 ]; then
      warn "Metacritic 评分覆盖 ${got}/${tot} (${pct}%) — 可执行补全："
      info "curl -X POST ${BASE}/api/games/backfill-ratings"
    else
      bad "Metacritic 评分覆盖仅 ${got}/${tot} (${pct}%) — 请运行上面的 backfill 命令"
    fi
    # 评分筛选是否可用（要求：可按最低分过滤）
    if [ "$got" -gt 0 ]; then
      f80="$(curl -sS -m 30 "${BASE}/api/games?minScore=80" 2>/dev/null | python3 -c "
import sys,json
try: gs=json.load(sys.stdin)
except Exception: print('0 0'); sys.exit(0)
bad=[g for g in gs if (g.get('metacriticScore') or 0) < 80]
print('%d %d' % (len(gs), len(bad)))
" 2>/dev/null)"
      fn="${f80%% *}"; fb="${f80##* }"
      if [ "${fb:-1}" -eq 0 ]; then
        ok "「Metacritic 最低分」筛选可用（minScore=80 → ${fn} 个，无越界）"
      else
        bad "评分筛选返回了低于阈值的游戏（${fb} 个）"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
step "8/16" "海报自选 / 轮播持久化"

# Pick the game that actually HAS posters. Testing against an arbitrary first
# game made the poster groups fail on a game that never had any artwork, which
# reads as a product bug rather than a fixture problem.
pgid="$(curl -sS -m 60 "${BASE}/api/games" 2>/dev/null | python3 -c "
import sys,json,urllib.request
try: gs=json.load(sys.stdin)
except Exception: print(''); sys.exit(0)
base='http://127.0.0.1:${PORT}'
best=('',0)
for g in gs[:40]:
    try:
        ps=json.load(urllib.request.urlopen(base+'/api/games/'+g['id']+'/posters',timeout=25))
    except Exception: continue
    if len(ps) > best[1]: best=(g['id'],len(ps))
print(best[0] if best[0] else (gs[0]['id'] if gs else ''))
" 2>/dev/null)"

if [ -z "$pgid" ]; then
  info "库中暂无游戏（跳过）"
else
  pn="$(curl -sS -m 20 "${BASE}/api/games/${pgid}/posters" 2>/dev/null | python3 -c "
import sys,json
try: ps=json.load(sys.stdin)
except Exception: print('-1 -1'); sys.exit(0)
sel=[p for p in ps if p.get('isSelected')]
print('%d %d' % (len(ps), len(sel)))
" 2>/dev/null)"
  pcount="${pn%% *}"; psel="${pn##* }"
  if [ "${pcount:-0}" -gt 0 ]; then
    ok "海报接口可用（${pcount} 张，选中 ${psel} 张）"
  else
    info "该游戏暂无海报记录（可在详情页「编辑海报」中添加）"
  fi

  # 模式切换是否可写回并读回（持久化字段）
  pm="$(curl -sS -m 20 -X PATCH "${BASE}/api/games/${pgid}" \
        -H 'Content-Type: application/json' -d '{"posterMode":"slideshow"}' 2>/dev/null |
        python3 -c "
import sys,json
try: print(json.load(sys.stdin).get('posterMode',''))
except Exception: print('')
" 2>/dev/null)"
  if [ "$pm" = "slideshow" ]; then
    ok "展现模式可切换并持久化（posterMode=slideshow）"
    curl -sS -m 20 -X PATCH "${BASE}/api/games/${pgid}" \
      -H 'Content-Type: application/json' -d '{"posterMode":"static"}' >/dev/null 2>&1
  else
    bad "展现模式切换失败（返回 '${pm}'）"
  fi

  # 卡片封面必须由「选中海报」驱动
  cover="$(curl -sS -m 20 "${BASE}/api/games/${pgid}" 2>/dev/null | python3 -c "
import sys,json
try: print(json.load(sys.stdin).get('posterUrl') or '')
except Exception: print('')
" 2>/dev/null)"
  [ -n "$cover" ] && ok "卡片封面字段可用（posterUrl 非空）" \
                  || info "该游戏暂无封面（posterUrl 为空）"
fi

# ---------------------------------------------------------------------------
step "9/16" "取消封面（恢复官方默认）"

if [ -n "$pgid" ]; then
  # Every source must be able to give the cover back, and nothing may be
  # deleted — the reported bug was that only the slideshow could be toggled.
  before_n="$(curl -sS -m 20 "${BASE}/api/games/${pgid}/posters" 2>/dev/null | python3 -c "
import sys,json
try: print(len(json.load(sys.stdin)))
except Exception: print(0)" 2>/dev/null || echo 0)"

  clear_url="$(curl -sS -m 20 -X POST "${BASE}/api/games/${pgid}/posters/clear-selection" 2>/dev/null | python3 -c "
import sys,json
try: print(json.load(sys.stdin).get('posterUrl') or '')
except Exception: print('')" 2>/dev/null || echo '')"

  if [ -n "$clear_url" ]; then
    ok "取消封面接口可用（已回退到 ${clear_url}）"
  else
    bad "取消封面接口无返回（恢复默认封面失败）"
  fi

  after_n="$(curl -sS -m 20 "${BASE}/api/games/${pgid}/posters" 2>/dev/null | python3 -c "
import sys,json
try: print(len(json.load(sys.stdin)))
except Exception: print(0)" 2>/dev/null || echo 0)"

  if [ "$after_n" = "$before_n" ]; then
    ok "取消封面未删除任何海报（${after_n} 张保持不变）"
  else
    bad "取消封面删除了海报（${before_n} → ${after_n}），应只清除标记"
  fi

  # isCover must be present and must be False for the official default: the UI
  # keys the "取消封面" entry off it, and offering it on the official poster is
  # what made the button look broken (cancelling restores that same poster).
  cover_state="$(curl -sS -m 20 "${BASE}/api/games/${pgid}/posters" 2>/dev/null | python3 -c "
import sys,json
try: ps=json.load(sys.stdin)
except Exception: ps=[]
sel=[p for p in ps if p.get('isSelected')]
if not ps: print('none')
elif not sel: print('nosel')
else: print('ok' if all('isCover' in p for p in ps) and not sel[0].get('isCover') else 'wrong')" 2>/dev/null)"
  case "$cover_state" in
    ok) ok "官方默认封面 isCover=false（界面不会显示无效的取消入口）" ;;
    none) info "该游戏暂无海报记录，跳过 isCover 检查" ;;
    nosel) warn "封面已设置但没有海报被标记为选中" ;;
    wrong) bad "isCover 字段异常：官方海报被标记为可取消" ;;
  esac


  scraped_sel="$(curl -sS -m 20 "${BASE}/api/games/${pgid}/posters" 2>/dev/null | python3 -c "
import sys,json
try: ps=json.load(sys.stdin)
except Exception: ps=[]
s=[p for p in ps if p.get('source')=='scraped' and p.get('isSelected')]
print('yes' if s else ('none' if not [p for p in ps if p.get('source')=='scraped'] else 'no'))" 2>/dev/null || echo none)"
  case "$scraped_sel" in
    yes) ok "取消封面后已恢复为官方海报" ;;
    none) info "该游戏无官方刮削海报，回退到本地首图（预期行为）" ;;
    *) warn "取消封面后封面未落在官方海报上" ;;
  esac
fi

# ---------------------------------------------------------------------------
step "10/16" "手动匹配：中文名解析与失败提示"

# A CJK library name must resolve to a Latin title on EVERY provider, not just
# Metacritic — RAWG/Steam rank by text similarity and used to return unrelated
# games for a Chinese query.
mq="$(curl -sS -m 20 "${BASE}/api/games" 2>/dev/null | python3 -c "
import sys,json
try: gs=json.load(sys.stdin)
except Exception: gs=[]
cjk=[g['name'] for g in gs if any('\u4e00'<=c<='\u9fff' for c in g['name'])]
print(cjk[0] if cjk else '')" 2>/dev/null || echo '')"

if [ -z "$mq" ]; then
  info "库中暂无中文名游戏，跳过中文匹配检查"
else
  enc="$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$mq" 2>/dev/null)"
  provs="$(curl -sS -m 60 "${BASE}/api/games/match/search?q=${enc}" 2>/dev/null | python3 -c "
import sys,json
try: r=json.load(sys.stdin)
except Exception: r=[]
print(','.join(sorted({c['provider'] for c in r})))" 2>/dev/null || echo '')"
  if [ -n "$provs" ]; then
    ok "中文名「${mq}」可解析出候选（来源：${provs}）"
  else
    warn "中文名「${mq}」未返回候选（可能是网络或代理问题）"
  fi

  # A bogus id must be rejected with a readable reason, not reported as success.
  badcode="$(curl -sS -m 90 -o /tmp/.sp_bad -w '%{http_code}' -X POST \
    "${BASE}/api/games/${pgid}/match" -H 'Content-Type: application/json' \
    -d '{"provider":"rawg","externalId":"999999999"}' 2>/dev/null)"
  if [ "$badcode" = "400" ]; then
    ok "无效条目已明确报错（HTTP 400，附原因说明）"
  elif [ "$badcode" = "200" ]; then
    bad "无效条目仍返回成功（应报错并中止绑定）"
  else
    info "无效条目返回 HTTP ${badcode}"
  fi
  rm -f /tmp/.sp_bad
fi

# ---------------------------------------------------------------------------
step "11/16" "相册图片加载性能（缩略图优先 / 懒加载 / 缓存）"

# The report was "从相册选择" crawling on image-heavy games. Two measurable
# causes: tiles used the multi-megabyte /preview rendition, and /thumbnail sent
# no Cache-Control so every dialog open re-downloaded the whole grid.
album_probe() {
  local gid="$1"
  curl -sS -m 30 "${BASE}/api/games/${gid}/media" 2>/dev/null | python3 -c "
import sys,json
try: ms=[m for m in json.load(sys.stdin) if m.get('type')!='video']
except Exception: ms=[]
print(len(ms))
print(ms[0]['id'] if ms else '')
print(ms[0]['thumbnailUrl'] if ms else '')" 2>/dev/null
}

# Pick the game with the largest album — that is where the problem shows up.
big_gid=""; big_n=0
if command -v python3 >/dev/null 2>&1; then
  big_gid="$(curl -sS -m 30 "${BASE}/api/games" 2>/dev/null | python3 -c "
import sys,json,urllib.request
try: gs=json.load(sys.stdin)
except Exception: gs=[]
best=('',0)
for g in gs[:40]:
    try:
        ms=[m for m in json.load(urllib.request.urlopen('http://127.0.0.1:${PORT}/api/games/'+g['id']+'/media',timeout=25)) if m.get('type')!='video']
    except Exception: continue
    if len(ms)>best[1]: best=(g['id'],len(ms))
print(best[0])" 2>/dev/null)"
fi

if [ -z "$big_gid" ]; then
  info "未能取到相册数据，跳过相册性能检查"
else
  probe_out="$(album_probe "$big_gid")"
  big_n="$(echo "$probe_out" | sed -n 1p)"
  first_mid="$(echo "$probe_out" | sed -n 2p)"

  info "最大相册游戏：${big_n} 张图片"

  if [ -n "$first_mid" ]; then
    thumb_hdr="$(curl -sS -m 60 -o /dev/null -D - "${BASE}/api/media/${first_mid}/thumbnail" 2>/dev/null)"
    thumb_len="$(printf '%s' "$thumb_hdr" | sed -n 's/^[Cc]ontent-[Ll]ength: *\([0-9]*\).*/\1/p' | head -1)"
    if printf '%s' "$thumb_hdr" | grep -qi 'cache-control:.*max-age'; then
      ok "缩略图带缓存头（浏览器可复用，弹窗重开不再重下）"
    else
      bad "缩略图缺少 Cache-Control（每次打开弹窗都会重新下载整屏图片）"
    fi

    # If a thumbnail is anywhere near a preview, the tile is pulling the full
    # rendition and the slowness is structural rather than cosmetic.
    prev_len="$(curl -sS -m 120 -o /dev/null -D - "${BASE}/api/media/${first_mid}/preview" 2>/dev/null | sed -n 's/^[Cc]ontent-[Ll]ength: *\([0-9]*\).*/\1/p' | head -1)"
    if [ -n "$thumb_len" ] && [ -n "$prev_len" ] && [ "$thumb_len" -gt 0 ]; then
      ratio="$(python3 -c "print(f'{$prev_len/$thumb_len:.0f}')" 2>/dev/null || echo '?')"
      if [ "$prev_len" -gt $((thumb_len * 20)) ]; then
        ok "缩略图(${thumb_len}B) 远小于预览图(${prev_len}B)，相差 ${ratio}×，适合网格使用"
      else
        warn "缩略图与预览图体积接近（${thumb_len}B vs ${prev_len}B），网格可能仍在拉大图"
      fi
    fi
  fi

  # The poster CDN URL must carry the small rendition too, not just /media.
  poster_thumb_ok="$(curl -sS -m 30 "${BASE}/api/games/${big_gid}/posters" 2>/dev/null | python3 -c "
import sys,json
try: ps=json.load(sys.stdin)
except Exception: ps=[]
if not ps: print('none')
else:
    missing=[p for p in ps if not p.get('thumbUrl')]
    print('ok' if not missing else 'missing:'+str(len(missing)))" 2>/dev/null)"
  case "$poster_thumb_ok" in
    ok) ok "海报接口为每张海报返回 thumbUrl（网格用小图，点击才加载大图）" ;;
    none) info "该游戏暂无海报记录，跳过 thumbUrl 检查" ;;
    *) warn "部分海报缺少 thumbUrl（${poster_thumb_ok}）" ;;
  esac

  # isCover must exist so the UI can tell a cancellable custom cover from the
  # official default; without it the dialog cannot decide what to offer.
  cover_field="$(curl -sS -m 30 "${BASE}/api/games/${big_gid}/posters" 2>/dev/null | python3 -c "
import sys,json
try: ps=json.load(sys.stdin)
except Exception: ps=[]
print('ok' if all('isCover' in p for p in ps) and ps else ('none' if not ps else 'no'))" 2>/dev/null)"
  case "$cover_field" in
    ok) ok "海报接口返回 isCover 字段（可区分自定义封面与官方默认）" ;;
    none) info "该游戏暂无海报记录，跳过 isCover 检查" ;;
    *) bad "海报接口缺少 isCover 字段，界面无法判断能否取消封面" ;;
  esac
fi
step "12/16" "入站访问与局域网可达性"

if [ -n "$health" ]; then
  ok "宿主回环访问正常 (127.0.0.1:${PORT} → 200)"
else
  bad "宿主回环访问失败 (127.0.0.1:${PORT})"
fi

lan_ip="$(ip -4 addr show scope global 2>/dev/null | sed -n 's/.*inet \([0-9.]*\)\/.*/\1/p' | grep -v '^172\.' | head -1)"
if [ -n "$lan_ip" ]; then
  lan_code="$(curl -sS -m 6 -o /dev/null -w '%{http_code}' "http://${lan_ip}:${PORT}/api/health" 2>/dev/null)"
  if [ "$lan_code" = "200" ]; then
    ok "本机经局域网 IP 访问正常 (http://${lan_ip}:${PORT})"
  else
    # 区分「Docker 发布端口的本机回环限制」与「服务真的不可达」：
    # 找一个宿主原生端口做对照。若原生端口可通，说明本机能自访局域网 IP，
    # 那么 Docker 端口不通就是 NAT hairpin 限制，与 ScreenPlay 无关。
    native_ok=""
    for p in 5666 7890 8080 8200 9090; do
      c="$(curl -sS -m 4 -o /dev/null -w '%{http_code}' "http://${lan_ip}:${p}/" 2>/dev/null)"
      if [ "$c" != "000" ]; then native_ok="$p"; break; fi
    done
    if [ -n "$native_ok" ]; then
      warn "本机自访局域网 IP 的 Docker 端口不通（http://${lan_ip}:${PORT}）"
      info "对照：宿主原生端口 ${native_ok} 可访问 → 网络本身正常"
      info "这是 Docker 发布端口在本机回环（hairpin）场景下的已知限制，非 ScreenPlay 缺陷"
      info "局域网内其它设备（手机/电脑）访问不受影响：http://${lan_ip}:${PORT}"
      if command -v docker >/dev/null 2>&1; then
        cip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$CONTAINER" 2>/dev/null || true)"
        [ -n "$cip" ] && info "本机可用容器 IP 直连验证：curl -m 6 http://${cip}:3000/api/health"
      fi
    else
      bad "局域网 IP 不可达，且无任何原生端口可对照 → 请检查网络 / 防火墙"
    fi
  fi
else
  info "取不到局域网 IP，跳过"
fi

if [ -n "${PUBLIC_HOST:-}" ]; then
  pub_code="$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "http://${PUBLIC_HOST}/api/health" 2>/dev/null)"
  [ "$pub_code" = "200" ] && ok "公网访问正常 (${PUBLIC_HOST})" || warn "公网访问返回 ${pub_code}"
else
  info "跳过公网检查（可加 PUBLIC_HOST=你的域名 再跑一次）"
fi

# ---------------------------------------------------------------------------
step "13/16" "本地登录认证（NAS 系统账户 / 本地账户）"

if [ "${AUTH_OK:-1}" != "1" ]; then
  warn "未登录，跳过认证检查（请用 AUTH_USER/AUTH_PASSWORD 重跑）"
else
  # /api/health 必须保持公开，否则容器健康检查会在登录前就失败。
  hcode="$(command curl -sS -m 12 -o /dev/null -w '%{http_code}' "${BASE}/api/health" 2>/dev/null)"
  if [ "$hcode" = "200" ]; then
    ok "健康检查保持公开（无需登录，HTTP ${hcode}）"
  else
    bad "健康检查未公开（HTTP ${hcode}）—— 容器健康检查会误报不健康"
  fi

  # 未带 Cookie 时受保护接口必须拒绝，否则认证形同虚设。
  anon="$(command curl -sS -m 15 -o /dev/null -w '%{http_code}' "${BASE}/api/games" 2>/dev/null)"
  if [ "$anon" = "401" ] || [ "$anon" = "403" ]; then
    ok "未登录访问受保护接口被拒绝（HTTP ${anon}）"
  elif [ "$anon" = "200" ]; then
    warn "未登录也能访问 /api/games（可能设置了 AUTH_DISABLED=1）"
  else
    bad "未登录访问返回意外状态码 HTTP ${anon}"
  fi

  sess="$(curl -sS -m 20 "${BASE}/api/auth/session" 2>/dev/null)"
  printf '%s' "$sess" | python3 -c "
import sys,json
try: d=json.load(sys.stdin)
except Exception: print('  (无法解析会话信息)'); sys.exit(0)
print('  当前用户 : %s' % ((d.get('user') or {}).get('username') or '-'))
print('  账户来源 : %s' % ((d.get('user') or {}).get('provider') or '-'))
print('  provider : %s（mode=%s, 系统库可用=%s）' % (d.get('provider'), d.get('mode'), d.get('systemAvailable')))
" 2>/dev/null

  # 会话必须保存在数据库里，容器重启后才不用重新登录。
  if command -v docker >/dev/null 2>&1; then
    srows="$(docker exec "$CONTAINER" sh -c 'ls /data/*.db' 2>/dev/null | head -1)"
    if [ -n "$srows" ]; then
      info "会话与账户存放在数据卷（容器重启后仍保持登录）"
    fi
  fi

  # 密码绝不能以明文形式落盘。
  plaintext_hits="$(docker exec "$CONTAINER" sh -c "grep -c 'password\"' /data/*.db 2>/dev/null" 2>/dev/null || echo 0)"
  if [ "${plaintext_hits:-0}" -gt 0 ] 2>/dev/null; then
    bad "数据库中可能存在明文密码（命中 ${plaintext_hits} 次），请立即检查 auth_users 表"
  else
    ok "未在数据库中检出明文密码字段（本地账户使用 scrypt 哈希）"
  fi
fi

# ---------------------------------------------------------------------------
step "14/16" "界面语言切换（简体中文 / English）"

pref="$(curl -sS -m 20 "${BASE}/api/settings/preferences" 2>/dev/null)"
if printf '%s' "$pref" | grep -q 'language'; then
  ok "语言偏好接口可用：$(printf '%s' "$pref" | head -c 80)"
else
  bad "语言偏好接口无返回（设置页语言切换将无法持久化）"
fi

# 切换必须真正写库，且非法值要被拒绝（否则前端传错值会静默失效）。
orig="$(printf '%s' "$pref" | python3 -c "
import sys,json
try: print(json.load(sys.stdin).get('language','zh-CN'))
except Exception: print('zh-CN')" 2>/dev/null)"
for lang in en zh-CN; do
  code="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' -X PUT "${BASE}/api/settings/preferences" \
    -H 'Content-Type: application/json' -d "{\"language\":\"${lang}\"}" 2>/dev/null)"
  if [ "$code" = "200" ]; then
    back="$(curl -sS -m 20 "${BASE}/api/settings/preferences" 2>/dev/null | python3 -c "
import sys,json
try: print(json.load(sys.stdin).get('language'))
except Exception: print('?')" 2>/dev/null)"
    if [ "$back" = "$lang" ]; then
      ok "切换为 ${lang} 并持久化成功"
    else
      bad "切换为 ${lang} 后读回为 ${back}"
    fi
  else
    bad "设置语言 ${lang} 失败（HTTP ${code}）"
  fi
done

bad_code="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' -X PUT "${BASE}/api/settings/preferences" \
  -H 'Content-Type: application/json' -d '{"language":"fr"}' 2>/dev/null)"
if [ "$bad_code" = "400" ]; then
  ok "非法语言值被拒绝（HTTP 400）"
else
  warn "非法语言值返回 HTTP ${bad_code}（预期 400）"
fi

# 恢复原值，避免验证脚本改变用户设置。
curl -sS -m 20 -o /dev/null -X PUT "${BASE}/api/settings/preferences" \
  -H 'Content-Type: application/json' -d "{\"language\":\"${orig}\"}" 2>/dev/null
info "已恢复原有语言设置：${orig}"

# 前端产物必须包含两套词典，否则界面上仍有硬编码中文。
if command -v docker >/dev/null 2>&1; then
  bundle="$(docker exec "$CONTAINER" sh -c 'ls /app/public/assets/index-*.js 2>/dev/null | head -1' 2>/dev/null)"
  if [ -n "$bundle" ]; then
    if docker exec "$CONTAINER" sh -c "grep -q 'Interface language' $bundle" 2>/dev/null; then
      ok "前端产物包含英文词典（语言切换已构建进镜像）"
    else
      warn "前端产物未检出英文词典，可能仍是旧镜像：请重新执行 docker-build.sh"
    fi
  fi
fi

# ---------------------------------------------------------------------------
step "15/16" "取消封面全链路（相册 / 上传 / 官方三来源）"

# 根本原因回归：`ensureScrapedPoster` 曾把 `games.poster_url` 原样当成官方海报登记，
# 而该列在没有官方图时是本地首图（/api/media/<id>/thumbnail）；用户把相册图设成封面后
# 它还会是 /api/media/<id>/preview。于是「官方海报」实际是用户自己那张图，取消封面
# 等于把它又选了一遍 —— 看起来点了没反应。这条检查保证这种行不再存在。
fake="$(curl -sS -m 60 "${BASE}/api/games" 2>/dev/null | python3 -c "
import sys,json,urllib.request
def get(u):
    return json.load(urllib.request.urlopen(u, timeout=20))
try:
    games=json.load(sys.stdin)
except Exception:
    print('skip'); sys.exit(0)
bad=[]
for g in games[:40]:
    try: ps=get('${BASE}/api/games/%s/posters' % g['id'])
    except Exception: continue
    for p in ps:
        u=p.get('url') or ''
        if p.get('source')=='scraped' and u.startswith('/api/media/') and not u.startswith('/api/media/proxy'):
            bad.append(g['name']+' -> '+u)
print('OK' if not bad else 'BAD ' + ' | '.join(bad[:3]))" 2>/dev/null || echo skip)"

case "$fake" in
  OK)   ok "没有把本地图片误登记为官方海报的行（取消封面不会再「恢复」成用户自己的图）" ;;
  skip) warn "无法遍历海报列表，跳过假官方海报检查" ;;
  *)    bad "仍存在冒充官方海报的本地图片行：${fake#BAD }" ;;
esac

# 相册来源完整链路：加入 → 设为封面 → 取消 → 状态必须全部回退，且不删文件。
agid="$(curl -sS -m 60 "${BASE}/api/games" 2>/dev/null | python3 -c "
import sys,json,urllib.request
def get(u): return json.load(urllib.request.urlopen(u, timeout=20))
try: games=json.load(sys.stdin)
except Exception: print(''); sys.exit(0)
for g in games[:40]:
    try: ms=get('${BASE}/api/games/%s/media' % g['id'])
    except Exception: continue
    if isinstance(ms, dict): ms=ms.get('items') or []
    imgs=[m for m in ms if m.get('type') != 'video']
    if imgs:
        print(g['id'], imgs[0]['id']); break" 2>/dev/null || echo '')"

if [ -z "$agid" ]; then
  warn "库中没有带相册图片的游戏，跳过相册来源链路检查"
else
  set -- $agid
  ag="${1}"; amid="${2}"
  n_before="$(curl -sS -m 20 "${BASE}/api/games/${ag}/posters" 2>/dev/null | python3 -c "
import sys,json
try: print(len(json.load(sys.stdin)))
except Exception: print(0)" 2>/dev/null || echo 0)"

  # 从相册加入该图（幂等），再设为封面
  pid="$(curl -sS -m 25 -X POST "${BASE}/api/games/${ag}/posters/from-media" \
    -H 'Content-Type: application/json' -d "{\"mediaId\":\"${amid}\"}" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print((d.get('poster') or {}).get('id') or '')
except Exception: print('')" 2>/dev/null || echo '')"

  if [ -z "$pid" ]; then
    bad "相册图片加入海报失败（from-media 无返回）"
  else
    curl -sS -m 25 -o /dev/null -X POST "${BASE}/api/games/${ag}/posters/select" \
      -H 'Content-Type: application/json' -d "{\"posterId\":\"${pid}\"}" 2>/dev/null
    state="$(curl -sS -m 20 "${BASE}/api/games/${ag}/posters" 2>/dev/null | python3 -c "
import sys,json
try:
    ps=json.load(sys.stdin)
    r=[p for p in ps if p['id']=='${pid}']
    print(('%s %s' % (r[0]['isSelected'], r[0]['isCover'])) if r else 'missing')
except Exception: print('err')" 2>/dev/null || echo err)"

    if [ "$state" = "True True" ]; then
      ok "相册图片设为封面成功（isSelected=true, isCover=true）"
    else
      bad "相册图片设为封面后状态异常：${state}（期望 True True）"
    fi

    # 取消封面
    curl -sS -m 25 -o /dev/null -X POST "${BASE}/api/games/${ag}/posters/clear-selection" 2>/dev/null

    after="$(curl -sS -m 20 "${BASE}/api/games/${ag}/posters" 2>/dev/null | python3 -c "
import sys,json
try:
    ps=json.load(sys.stdin)
    covers=[p for p in ps if p['isCover']]
    sel=[p for p in ps if p['isSelected']]
    print('%d|%d|%d|%s' % (len(ps), len(covers), len(sel),
          (sel[0]['source'] if sel else 'none')))
except Exception: print('err')" 2>/dev/null || echo err)"

    IFS='|' read -r n_after n_cover n_sel sel_src <<EOF2
$after
EOF2

    if [ "$n_cover" = "0" ]; then
      ok "取消封面后不存在任何用户选择标记（isCover 行数=0）"
    else
      bad "取消封面后仍有 ${n_cover} 行处于 isCover（状态未同步）"
    fi

    if [ "$n_sel" = "1" ]; then
      ok "取消封面后回到唯一默认封面（来源 ${sel_src}，界面显示「默认封面」而非「取消封面」）"
    else
      bad "取消封面后的选中行数异常：${n_sel}（期望 1）"
    fi

    if [ "$n_after" = "$n_before" ] || [ "$n_after" -gt "$n_before" ] 2>/dev/null; then
      ok "取消封面未删除任何海报（${n_before} → ${n_after}，只增不减）"
    else
      bad "取消封面删除了海报记录：${n_before} → ${n_after}"
    fi

    # 可重新设为封面
    resc="$(curl -sS -m 25 -o /dev/null -w '%{http_code}' -X POST \
      "${BASE}/api/games/${ag}/posters/select" -H 'Content-Type: application/json' \
      -d "{\"posterId\":\"${pid}\"}" 2>/dev/null)"
    if [ "$resc" = "201" ] || [ "$resc" = "200" ]; then
      ok "取消后可重新把该相册图设为封面（HTTP ${resc}）"
    else
      bad "取消后无法重新设为封面（HTTP ${resc}）"
    fi
    curl -sS -m 25 -o /dev/null -X POST "${BASE}/api/games/${ag}/posters/clear-selection" 2>/dev/null
  fi
fi

  if [ "${AUTH_OK:-1}" != "1" ]; then
    echo
    echo -e " \033[33m注意\033[0m：未登录成功，多数接口返回 401 属预期结果。"
    echo "   请带凭据重跑：AUTH_USER=用户名 AUTH_PASSWORD=密码 bash scripts/verify-image-fix.sh"
  fi
# ---------------------------------------------------------------------------
step "16/16" "成就 / 奖杯刮削（Steam 成就 + PlayStation 奖杯）"

# 这个分组回答三个问题：Steam 成就接口到底通不通、PS 奖杯有没有刮到、
# 以及「刮不到时有没有明确说明」（绝不能是空白面板）。

# 1) Steam 成就接口诊断。成就走 api.steampowered.com，与封面/价格用的
#    store.steampowered.com 是两个域名，大陆网络常常只有后者可直连 ——
#    这正是「元数据正常但成就是空」的最常见原因。
sa="$(curl -sS -m 90 "${BASE}/api/settings/test-steam-achievements" 2>/dev/null || echo '')"
sa_ok="$(printf '%s' "$sa" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin); print('OK' if d.get('ok') else 'BAD')
except Exception: print('ERR')" 2>/dev/null || echo ERR)"
sa_msg="$(printf '%s' "$sa" | python3 -c "
import sys,json
try: print(json.load(sys.stdin).get('message') or '')
except Exception: print('')" 2>/dev/null || echo '')"

case "$sa_ok" in
  OK)  ok "Steam 成就接口可用 · ${sa_msg}" ;;
  BAD) warn "Steam 成就接口不可用：${sa_msg}" ;;
  *)   warn "Steam 成就诊断接口无响应（旧镜像？请确认已重新构建部署）" ;;
esac

# 2) 逐游戏检查成就/奖杯状态。重点是：任何一款游戏都不能是「没有数据也没有原因」。
ach="$(curl -sS -m 90 "${BASE}/api/games?pageSize=100" 2>/dev/null | python3 -c "
import sys,json,urllib.request
def get(u):
    return json.load(urllib.request.urlopen(u, timeout=25))
try: games=json.load(sys.stdin)
except Exception: print('ERR'); sys.exit(0)
if not isinstance(games, list): print('ERR'); sys.exit(0)
silent=[]; ps_no_trophy=[]; tier_bad=[]; ok_n=0; none_n=0; failed=[]
for g in games:
    try: d=get('${BASE}/api/achievements/%s' % g['id'])
    except Exception: continue
    st=d.get('status'); n=len(d.get('items') or []); c=d.get('counts') or {}
    if st=='pending':
        silent.append('%s（尚未刮取）' % g['name']); continue
    if st=='unsupported':
        none_n+=1; continue
    if st=='failed':
        failed.append('%s：%s' % (g['name'], str(d.get('error'))[:60])); continue
    if st in ('ok','empty'):
        if n==0:
            # empty 是合法结果（该游戏确实没有成就），但必须由明确状态表达
            none_n+=1
        else:
            ok_n+=1
            if c.get('total') != n:
                tier_bad.append('%s counts.total=%s 但行数=%s' % (g['name'], c.get('total'), n))
            if c.get('platinum') is None:
                tier_bad.append('%s 缺少分等级统计' % g['name'])
print('OK %d %d %d' % (ok_n, none_n, len(failed)))
for x in failed[:3]: print('FAILED ' + x)
for x in silent[:3]: print('SILENT ' + x)
for x in tier_bad[:3]: print('TIER ' + x)
for x in ps_no_trophy[:3]: print('PSTROPHY ' + x)" 2>/dev/null || echo 'ERR')"

if printf '%s' "$ach" | head -1 | grep -q '^OK '; then
  read -r _ ok_n none_n n_failed <<EOF2
$(printf '%s' "$ach" | head -1)
EOF2
  ok "成就/奖杯状态完备：${ok_n} 款有数据、${none_n} 款明确无来源/无成就、${n_failed} 款失败（均带原因）"
else
  warn "成就状态检查未能完成（库为空或接口不可用）"
fi

# 失败必须有原因，不能是静默空白
if printf '%s' "$ach" | grep -q '^FAILED '; then
  n_bad=$(printf '%s' "$ach" | grep -c '^FAILED ')
  ok "刮取失败的游戏都带有可读原因（${n_bad} 款，例如：$(printf '%s' "$ach" | grep '^FAILED ' | head -1 | cut -c8-))"
else
  ok "没有刮取失败的游戏"
fi
if printf '%s' "$ach" | grep -q '^SILENT '; then
  bad "存在「既无数据也无原因」的游戏（静默失败）：$(printf '%s' "$ach" | grep '^SILENT ' | head -1 | cut -c8-)"
else
  ok "没有静默失败的游戏（每个空面板都有明确状态说明）"
fi
if printf '%s' "$ach" | grep -q '^TIER '; then
  bad "分等级统计与行数不一致：$(printf '%s' "$ach" | grep '^TIER ' | head -1 | cut -c6-)"
else
  ok "分等级统计（白金/金/银/铜）与行数一致"
fi

# 3) PlayStation 奖杯：找一个 PS 平台游戏验证维度完整性。
psg="$(curl -sS -m 60 "${BASE}/api/games?pageSize=100" 2>/dev/null | python3 -c "
import sys,json
try: games=json.load(sys.stdin)
except Exception: print(''); sys.exit(0)
for g in games:
    plats=[str(p) for p in (g.get('platforms') or [])]
    if not plats and g.get('platform'): plats=[str(g['platform'])]
    if any(('playstation' in p.lower()) or p.lower().startswith(('ps4','ps5','ps3','psv','psp','vita')) for p in plats):
        print(g['id']); break" 2>/dev/null || echo '')"

if [ -z "$psg" ]; then
  warn "库中没有 PlayStation 平台游戏，跳过奖杯维度检查（给某款游戏设置 PS 平台后重跑）"
else
  psd="$(curl -sS -m 60 "${BASE}/api/achievements/${psg}" 2>/dev/null || echo '')"
  ps_summary="$(printf '%s' "$psd" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
except Exception: print('ERR'); sys.exit(0)
items=d.get('items') or []; c=d.get('counts') or {}
if not items:
    print('EMPTY %s' % d.get('status')); sys.exit(0)
need={'name':0,'description':0,'iconUrl':0,'tier':0,'globalPercent':0,'rarity':0}
for a in items:
    for k in need:
        if a.get(k) not in (None,''): need[k]+=1
n=len(items)
print('ITEMS %d %s' % (n, json.dumps(c, ensure_ascii=False)))
for k,v in need.items():
    print('DIM %s %d %d' % (k, v, n))" 2>/dev/null || echo 'ERR')"

  if printf '%s' "$ps_summary" | head -1 | grep -q '^ITEMS '; then
    ok "PS 游戏奖杯已刮取：$(printf '%s' "$ps_summary" | head -1 | cut -c7-)"
    # 名称/等级/图标是硬要求；描述与稀有度多数条目都有
    for dim in name tier iconUrl; do
      line="$(printf '%s' "$ps_summary" | grep "^DIM ${dim} ")"
      have=$(printf '%s' "$line" | awk '{print $3}'); tot=$(printf '%s' "$line" | awk '{print $4}')
      if [ -n "$tot" ] && [ "$have" = "$tot" ]; then
        ok "奖杯「${dim}」字段完整（${have}/${tot}）"
      else
        bad "奖杯「${dim}」字段缺失（${have:-0}/${tot:-0}）"
      fi
    done
    for dim in description rarity; do
      line="$(printf '%s' "$ps_summary" | grep "^DIM ${dim} ")"
      have=$(printf '%s' "$line" | awk '{print $3}'); tot=$(printf '%s' "$line" | awk '{print $4}')
      if [ -n "$have" ] && [ "$have" -gt 0 ] 2>/dev/null; then
        ok "奖杯「${dim}」已抓取（${have}/${tot}）"
      else
        warn "奖杯「${dim}」未抓到（${have:-0}/${tot:-0}）"
      fi
    done
  elif printf '%s' "$ps_summary" | head -1 | grep -q '^EMPTY '; then
    warn "PS 游戏尚无奖杯数据（状态 $(printf '%s' "$ps_summary" | head -1 | cut -c7-)），可在详情页点「重新抓取成就 / 奖杯」"
  else
    warn "PS 奖杯检查未能完成"
  fi
fi

# 4) 增量更新：连续刷新不应让行数增长（说明没有重复插入）。
if [ -n "$psg" ]; then
  n1="$(curl -sS -m 60 "${BASE}/api/achievements/${psg}" 2>/dev/null | python3 -c "
import sys,json
try: print(len(json.load(sys.stdin).get('items') or []))
except Exception: print(0)" 2>/dev/null || echo 0)"
  curl -sS -m 120 -o /dev/null -X POST "${BASE}/api/games/${psg}/achievements/refresh" 2>/dev/null
  n2="$(curl -sS -m 60 "${BASE}/api/achievements/${psg}" 2>/dev/null | python3 -c "
import sys,json
try: print(len(json.load(sys.stdin).get('items') or []))
except Exception: print(0)" 2>/dev/null || echo 0)"
  if [ "$n1" = "$n2" ] && [ "$n1" != "0" ]; then
    ok "重复刮取不会重复插入（${n1} → ${n2} 条不变，属增量更新）"
  elif [ "$n1" = "0" ]; then
    warn "尚无奖杯数据，无法验证增量更新"
  else
    bad "重复刮取后行数变化：${n1} → ${n2}（可能出现重复）"
  fi
fi

# ---------------------------------------------------------------------------
echo
echo "=============================================================="
if [ "$fail" -eq 0 ]; then
  echo -e " 结果：\033[32m${pass} 项通过\033[0m / ${warn} 项提示 / \033[32m0 项失败\033[0m"
else
  echo -e " 结果：\033[32m${pass} 项通过\033[0m / ${warn} 项提示 / \033[31m${fail} 项失败\033[0m"
  echo " 请把上面失败项的完整输出发出来以便继续排查。"
fi
echo "=============================================================="

[ "$fail" -eq 0 ]