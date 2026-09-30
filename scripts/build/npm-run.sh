#!/bin/sh
# =============================================================================
# ScreenPlay — 构建期 npm 执行包装（代理前置校验 + 国内源兜底）
#
# 背景（为什么需要这个脚本）：
#   npm install 必须出网。构建容器有独立 netns，既不继承宿主机代理，通常也没有
#   直连出口。宿主机检测结果不算数，只能在容器内实测。
#
# 修复要点：
#   1) 代理只通过**环境变量**注入 npm，绝不作为 npm 的命令行参数。
#      （旧版本 attempt() 读了 $1 却忘记 shift，导致代理地址被当成 npm 子命令，
#        报 `Unknown command: "http://172.17.0.1:7890"`。）
#   2) 每个代理先做真实连通性探测，探不通的直接跳过，不做无效重试。
#   3) 所有代理都不行时，回退到国内 npm 镜像源（默认 registry.npmmirror.com）
#      直连安装，不依赖代理。
#   4) 未配置代理时（SCREENPLAY_BUILD_PROXY 为空）直接跳过代理逻辑，走国内源。
#
# 用法：
#   sh /tmp/npm-run.sh install --no-audit --no-fund
#   sh /tmp/npm-run.sh run build
#
# 说明：代理与 registry 只作为构建期环境变量，不写入镜像、不改动运行容器的
#       npm 配置，因此完全不影响最终容器的启动与入站访问。
# =============================================================================

set -u

NPM="${NPM_BIN:-npm}"
PROXY_ENV_FILE="${APK_PROXY_ENV_FILE:-/tmp/screenplay-proxy-env}"
PROBE_JS="${PROXY_PROBE_JS:-/tmp/proxy-probe.js}"
NPM_TIMEOUT="${NPM_TIMEOUT:-1800}"
PROBE_TIMEOUT="${PROBE_TIMEOUT:-8000}"

# 源：先试官方，最后兜底国内镜像
OFFICIAL_REGISTRY="${NPM_OFFICIAL_REGISTRY:-https://registry.npmjs.org/}"
MIRROR_REGISTRY="${NPM_MIRROR_REGISTRY:-https://registry.npmmirror.com/}"
OFFICIAL_HOST="registry.npmjs.org"
MIRROR_HOST="registry.npmmirror.com"

# 探测用宿主名（取 registry 的 host）
host_of() {
  _u="$1"
  _u="${_u#*://}"
  _u="${_u%%/*}"
  _u="${_u##*@}"
  _u="${_u%%:*}"
  printf '%s' "$_u"
}

have_timeout() { command -v timeout >/dev/null 2>&1; }
run_limited() {
  _t="$1"; shift
  if have_timeout; then timeout "$_t" "$@"; else "$@"; fi
}

# ─── 候选列表工具（必须在下面组装候选之前定义）────────────────────────────
# 去重 + 去掉 none / 空项，保留顺序
dedupe() {
  _out=""
  for _x in $1; do
    [ -n "$_x" ] || continue
    [ "$_x" = none ] && continue
    _seen=0
    for _y in $_out; do [ "$_y" = "$_x" ] && _seen=1 && break; done
    [ "$_seen" = 0 ] && _out="$_out $_x"
  done
  printf '%s' "$_out"
}

list_prepend() { printf '%s' "$(dedupe "$2 $1")"; }
list_append()  { printf '%s' "$(dedupe "$1 $2")"; }

# ─── 载入 apk 阶段写下的代理结论 ───────────────────────────────────────────
# 候选来源优先级：apk 实测可用 → SCREENPLAY_BUILD_PROXY → build-arg 兜底
PROXY_CANDIDATES=""
SEED_PROXY=""
if [ -f "$PROXY_ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$PROXY_ENV_FILE"
  PROXY_CANDIDATES="${SCREENPLAY_PROXY_CANDIDATES:-}"
  SEED_PROXY="${https_proxy:-${http_proxy:-}}"
fi

# 显式指定的代理优先（要求4：SCREENPLAY_BUILD_PROXY 可自定义）
if [ -n "${SCREENPLAY_BUILD_PROXY:-}" ]; then
  PROXY_CANDIDATES="$(list_prepend "$PROXY_CANDIDATES" "$SCREENPLAY_BUILD_PROXY")"
fi
[ -n "${HTTP_PROXY_FALLBACK:-}" ] &&
  PROXY_CANDIDATES="$(list_append "$PROXY_CANDIDATES" "$HTTP_PROXY_FALLBACK")"
[ -n "${HTTPS_PROXY:-}" ] &&
  PROXY_CANDIDATES="$(list_prepend "$PROXY_CANDIDATES" "$HTTPS_PROXY")"

PROXY_CANDIDATES="$(dedupe "$PROXY_CANDIDATES")"

# ─── 代理连通性前置校验（要求2：探不通就不启用）────────────────────────────
# 用 node 做一次真实 HTTPS 请求（经代理 CONNECT 建隧道）。node:22-alpine 自带
# node，无需 wget/curl。探测目标就是接下来要用的 registry 主机。
proxy_usable_for() {
  _proxy="$1"; _host="$2"
  [ -f "$PROBE_JS" ] || return 0   # 没有探测脚本时不阻塞构建（保守放行）
  node "$PROBE_JS" --proxy "$_proxy" --host "$_host" \
       --timeout "$PROBE_TIMEOUT" >/dev/null 2>&1
}

# ─── 执行一次 npm（关键：代理只走环境变量，npm 参数原样传递）───────────────
# $1 = 代理（none 表示直连）；$2 = registry；其余为 npm 的真实参数
run_npm() {
  _proxy="$1"; _registry="$2"
  shift 2                      # ← 旧版本缺这一步，代理地址才会被当成 npm 子命令

  # 防御性校验：npm 参数里绝不应出现代理地址/URL 形态的子命令。
  # 这是对「代理地址被当成 npm 子命令」那类回归的硬防线，一旦命中立即中止，
  # 不做无意义的重试。
  case "${1:-}" in
    http://*|https://*|socks*://*|*-proxy|none)
      printf '  ❌ 内部错误：npm 首个参数疑似代理地址（%s），已中止\n' "$1" >&2
      exit 9
      ;;
  esac

  if [ "$_proxy" = none ] || [ -z "$_proxy" ]; then
    unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY 2>/dev/null || true
  else
    http_proxy="$_proxy"; https_proxy="$_proxy"; all_proxy="$_proxy"
    HTTP_PROXY="$_proxy"; HTTPS_PROXY="$_proxy"; ALL_PROXY="$_proxy"
    export http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
  fi
  export no_proxy NO_PROXY 2>/dev/null || true

  # registry 用环境变量注入，避免污染 argv（与代理同理）
  npm_config_registry="$_registry"
  export npm_config_registry

  printf '  · registry=%s  %s\n' "$_registry" \
    "$([ "$_proxy" = none ] && echo '直连' || echo "代理=$_proxy")"
  printf '    npm %s\n' "$*"

  run_limited "$NPM_TIMEOUT" "$NPM" "$@"
}

separator() { printf '%s\n' "  ------------------------------------------------------------"; }

main() {
  [ "$#" -gt 0 ] || { echo "[npm-run] 错误：缺少 npm 参数" >&2; exit 2; }
  case "$1" in
    none|http://*|https://*|socks*://*)
      echo "[npm-run] 错误：首个参数必须是 npm 子命令（install/run/...），收到 '$1'" >&2
      exit 2
      ;;
  esac

  echo "== [npm-run] $NPM $* =="

  # ── 阶段0：无代理 → 直接走国内源（要求4）──────────────────────────────
  if [ -z "$PROXY_CANDIDATES" ]; then
    echo "== [npm-run] 未配置代理 → 直接使用国内镜像源直连安装 =="
    if run_npm none "$MIRROR_REGISTRY" "$@"; then
      echo "== [npm-run] ✅ 执行成功（国内镜像源直连）=="
      return 0
    fi
    separator
    echo "== [npm-run] 国内源失败 → 再试官方源直连 =="
    if run_npm none "$OFFICIAL_REGISTRY" "$@"; then
      echo "== [npm-run] ✅ 执行成功（官方源直连）=="
      return 0
    fi
    fail_all
    return 1
  fi

  echo "== [npm-run] 代理候选：$PROXY_CANDIDATES =="

  # ── 阶段1：代理 + 官方源（先用实测可用的代理）────────────────────────
  echo "== [npm-run] 阶段1：前置校验代理连通性（目标 $OFFICIAL_HOST）=="
  USABLE=""
  for _p in $PROXY_CANDIDATES; do
    printf '  探测 %s ... ' "$_p"
    if proxy_usable_for "$_p" "$OFFICIAL_HOST"; then
      echo "可用"
      USABLE="$(list_append "$USABLE" "$_p")"
    else
      echo "不可用（跳过）"
    fi
  done

  if [ -n "$USABLE" ]; then
    echo "== [npm-run] 阶段1：经代理安装（官方源）=="
    for _p in $USABLE; do
      if run_npm "$_p" "$OFFICIAL_REGISTRY" "$@"; then
        echo "== [npm-run] ✅ 执行成功（官方源，经代理 $_p）=="
        return 0
      fi
      separator
    done
  else
    echo "  （无可用代理，跳过该阶段）"
  fi

  # ── 阶段2：代理 + 国内镜像源（代理能连但官方源不稳时的主力方案）─────
  echo "== [npm-run] 阶段2：前置校验代理连通性（目标 $MIRROR_HOST）=="
  USABLE_M=""
  for _p in $PROXY_CANDIDATES; do
    printf '  探测 %s ... ' "$_p"
    if proxy_usable_for "$_p" "$MIRROR_HOST"; then
      echo "可用"
      USABLE_M="$(list_append "$USABLE_M" "$_p")"
    else
      echo "不可用（跳过）"
    fi
  done

  if [ -n "$USABLE_M" ]; then
    echo "== [npm-run] 阶段2：经代理安装（国内镜像源）=="
    for _p in $USABLE_M; do
      if run_npm "$_p" "$MIRROR_REGISTRY" "$@"; then
        echo "== [npm-run] ✅ 执行成功（国内镜像源，经代理 $_p）=="
        return 0
      fi
      separator
    done
  else
    echo "  （无可用代理，跳过该阶段）"
  fi

  # ── 阶段3：国内镜像源直连（最终兜底，不依赖代理）──────────────────────
  echo "== [npm-run] 阶段3：兜底 → 国内镜像源直连（不依赖代理）=="
  if run_npm none "$MIRROR_REGISTRY" "$@"; then
    echo "== [npm-run] ✅ 执行成功（国内镜像源直连）=="
    return 0
  fi
  separator

  # ── 阶段4：官方源直连（最后再试一次）──────────────────────────────────
  echo "== [npm-run] 阶段4：最后尝试官方源直连 =="
  if run_npm none "$OFFICIAL_REGISTRY" "$@"; then
    echo "== [npm-run] ✅ 执行成功（官方源直连）=="
    return 0
  fi

  fail_all
  return 1
}

fail_all() {
  echo "== [npm-run] ❌ 所有方案均失败 ==" >&2
  echo "   已尝试：代理候选（前置校验后）× 官方源 / 国内镜像源，以及两者直连。" >&2
  echo "   排查建议：" >&2
  echo "     1) 指定容器可达的代理（勿用 127.0.0.1，容器内那是容器自己）：" >&2
  echo "        SCREENPLAY_BUILD_PROXY=http://<NAS内网IP>:7890 bash scripts/docker-build.sh" >&2
  echo "     2) 确认代理监听所有网卡（mihomo: mixed-port 需为 *:7890，不能只绑 127.0.0.1）" >&2
  echo "     3) 确认容器能经网关访问宿主机（docker0 网关通常为 172.17.0.1）" >&2
  echo "     4) 确认 registry.npmmirror.com 可达（国内源兜底也失败说明是整体出网问题）" >&2
}

if [ "${APK_SETUP_NO_MAIN:-0}" = 1 ]; then
  return 0 2>/dev/null || exit 0
fi

main "$@"