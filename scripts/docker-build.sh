#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# ScreenPlay — Docker 构建脚本（代理注入 + 源可用性校验 + 故障自动切换）
#
# 解决的问题：
#   1) 宿主机预检镜像/软件源「正常」，但容器内构建阶段 apk 源超时失败。
#      根因是构建容器有独立网络命名空间，不继承宿主机代理；且 docker.service
#      里的代理常被写成 127.0.0.1:7890 —— 在容器内那是容器自己，必然连不上。
#      同时 NO_PROXY 常把 mirrors.* 列为直连，而本机容器几乎没有直连出口。
#   2) 源不可用时无法自动切换，只能人工改配置。
#
# 本脚本做的事：
#   1) 自动探测「容器可达」的宿主机代理地址，并以 --build-arg 注入
#      HTTP_PROXY / HTTPS_PROXY / NO_PROXY（可用环境变量覆盖；可显式关闭）。
#   2) Alpine 软件源在**构建容器内部**做真实可用校验并自动切换（由
#      scripts/build/apk-setup.sh 在容器内执行），不再依赖宿主机预检结果。
#   3) 默认启用 BuildKit；检测到旧版 Docker 时自动降级为经典构建器。
#   4) 代理仅在构建期生效（Dockerfile 只用 ARG + 行内环境变量），
#      不写进运行镜像，最终容器的入站访问不受影响。
#
# 用法：
#   scripts/docker-build.sh                  # 探测 → 注入 → 构建
#   scripts/docker-build.sh --dry-run        # 只探测并打印将要执行的命令
#   scripts/docker-build.sh --probe-proxy    # 只探测代理可达性并给出建议
#   scripts/docker-build.sh --no-proxy       # 不注入任何代理（保持原行为）
#   scripts/docker-build.sh --classic        # 强制经典构建器
#   scripts/docker-build.sh --buildkit       # 强制 BuildKit
#   scripts/docker-build.sh --no-cache       # 强制无缓存构建
#   scripts/docker-build.sh --prune-cache    # 同时清空构建缓存
#   scripts/docker-build.sh -t 名称           # 指定镜像标签
#
# 相关环境变量：
#   SCREENPLAY_BUILD_PROXY   显式指定构建期代理（如 http://<代理主机IP>:7890）
#                            设为空字符串 = 不注入代理
#   SCREENPLAY_PROXY_FALLBACK 备用代理（主代理失败时容器内会再试它）
#   APK_MIRROR               首选 Alpine 源（排到候选列表最前）
#   APK_MIRRORS              候选 Alpine 源（空格/逗号分隔）
#   REGISTRY                 镜像仓库前缀（覆盖 Docker Hub）
#   SKIP_PROXY_INJECT=1      等同于 --no-proxy
#   NPM_MIRROR_REGISTRY      构建期 npm 国内兜底源（默认 https://registry.npmmirror.com/）
#   NPM_BINARY_MIRROR        better-sqlite3 预编译包（GitHub Releases 资产）的镜像源
#                            （默认 https://registry.npmmirror.com/-/binary/better-sqlite3；
#                             留空 = 保持上游默认 GitHub Releases）
#   PROXY_TEST_URL           代理探测用的测试地址
# ═════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# 可配置项
# ─────────────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DOCKERFILE="${DOCKERFILE:-$PROJECT_DIR/Dockerfile}"
IMAGE_TAG="${IMAGE_TAG:-screenplay:latest}"
APK_SETUP_SCRIPT="$SCRIPT_DIR/build/apk-setup.sh"   # 构建期脚本统一在 scripts/build/

BASE_IMAGE="node:22-alpine"   # 基础镜像（官方命名空间）
BASE_NAMESPACE="library"      # Docker Hub 官方镜像的命名空间
BASE_REPO="library/node"      # 镜像清单仓库路径（namespace/repo）
BASE_TAG="22-alpine"
OFFICIAL_APK_HOST="dl-cdn.alpinelinux.org"

# Docker 镜像源备选（按优先级）
DOCKER_MIRRORS=(
  docker.fnnas.com
  hub-mirror.daocloud.io
  docker.1ms.run
)

# Alpine 软件源备选（按优先级）
# 已实测：tuna/ustc 可用（ustc 对 User-Agent 敏感，用 curl 裸请求可能 403，
# 但 apk 的 Wget UA 可正常访问 → 这也是必须「在容器内用 apk 真实校验」的原因）。
# mirrors.163.com 已不再提供 /alpine 路径（404），故从列表移除。
ALPINE_MIRRORS=(
  mirrors.aliyun.com
  mirrors.tuna.tsinghua.edu.cn
  mirrors.ustc.edu.cn
  mirrors.huaweicloud.com
)

# 校验超时（秒）
TIMEOUT=10
# 宿主 mihomo/clash 默认混合端口
PROXY_PORT_DEFAULT="${PROXY_PORT_DEFAULT:-7890}"
# 代理可用性测试地址
PROXY_TEST_URL="${PROXY_TEST_URL:-https://mirrors.aliyun.com/alpine/}"
# 默认 NO_PROXY：只含内网/本地；公网镜像站一律走代理（容器内无直连出口）。
DEFAULT_NO_PROXY="localhost,127.0.0.1,::1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,.local,host.docker.internal"

# 运行时标志
DRY_RUN=0
PRUNE_CACHE=0
FORCE_NO_CACHE=0
BUILDER_MODE="auto"    # auto | buildkit | classic
SKIP_PROXY=0
PROBE_ONLY=0

# ─────────────────────────────────────────────────────────────────────────────
# 小工具（诊断输出统一到 stderr，避免污染命令替换）
# ─────────────────────────────────────────────────────────────────────────────
info()  { printf '\033[1;34m[INFO]\033[0m %s\n' "$*" >&2; }
ok()    { printf '\033[1;32m[ OK ]\033[0m %s\n' "$*" >&2; }
warn()  { printf '\033[1;33m[WARN]\033[0m %s\n' "$*" >&2; }
fail()  { printf '\033[1;31m[FAIL]\033[0m %s\n' "$*" >&2; }
err()   { printf '\033[1;31m[ERRO]\033[0m %s\n' "$*" >&2; }

now_ms() { date +%s%3N; }

usage() {
  sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

host_arch() {
  case "$(uname -m)" in
    x86_64|amd64)   echo x86_64 ;;
    aarch64|arm64)  echo aarch64 ;;
    armv7l)         echo armv7 ;;
    i686|i386)      echo x86 ;;
    *)              echo x86_64 ;;
  esac
}

# 版本比较：ver_ge <实际> <要求>
ver_ge() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]
}

# 列出本机可用 shell 解释器（写仓库文件用，busybox 内建即可）
have_docker() { command -v docker >/dev/null 2>&1; }

# ─────────────────────────────────────────────────────────────────────────────
# 地址探测
# ─────────────────────────────────────────────────────────────────────────────

# 默认路由所用网卡的主 IPv4（即宿主机内网 IP）
primary_ipv4() {
  local iface
  iface="$(ip -4 route show default 2>/dev/null | awk '{print $5; exit}')"
  [ -n "$iface" ] || return 1
  ip -4 addr show "$iface" 2>/dev/null \
    | sed -n 's/.*inet \([0-9.]*\)\/.*/\1/p' | head -1
}

# Docker 默认 bridge（docker0）的网关地址 —— 构建容器访问宿主机的稳定入口
docker_bridge_gateway() {
  local gw
  gw="$(ip -4 addr show docker0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\)\/.*/\1/p' | head -1)"
  if [ -z "$gw" ] && have_docker; then
    gw="$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || true)"
  fi
  if [ -n "$gw" ]; then printf '%s' "$gw"; fi
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# 连通性探测（宿主机侧）
# ─────────────────────────────────────────────────────────────────────────────

# 通用 HTTP 探测：仅在完整下载成功且 2xx 时返回 200；否则返回真实状态码或 000。
http_probe() {
  local url="$1"; shift
  local code rc=0
  code="$(curl -s -m "$TIMEOUT" -o /dev/null -w '%{http_code}' "$@" "$url" 2>/dev/null)" || rc=$?
  if [ "$rc" = 0 ]; then echo "${code:-000}"; else echo 000; fi
}

manifest_http_status() {
  local host="$1" repo="$2" tag="$3"
  local headers realm service token resp
  local accept='Accept: application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json'

  headers="$(curl -s -m "$TIMEOUT" -D - -o /dev/null "https://$host/v2/" 2>/dev/null)" || true
  if [ -z "$headers" ]; then echo 000; return; fi
  realm="$(printf '%s\n' "$headers" | tr -d '\r' | sed -n 's/.*realm="\([^"]*\)".*/\1/p' | head -1)"
  service="$(printf '%s\n' "$headers" | tr -d '\r' | sed -n 's/.*service="\([^"]*\)".*/\1/p' | head -1)"

  if [ -z "$realm" ] || [ -z "$service" ]; then
    http_probe "https://$host/v2/$repo/manifests/$tag" -H "$accept"
    return
  fi

  resp="$(curl -s -m "$TIMEOUT" "${realm}?service=${service}&scope=repository:${repo}:pull" 2>/dev/null)" || true
  token="$(printf '%s' "$resp" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  [ -z "$token" ] && token="$(printf '%s' "$resp" | sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  if [ -z "$token" ]; then echo 401; return; fi

  http_probe "https://$host/v2/$repo/manifests/$tag" -H "Authorization: Bearer $token" -H "$accept"
}

# ─────────────────────────────────────────────────────────────────────────────
# 代理候选：容器视角可达性
# ─────────────────────────────────────────────────────────────────────────────

# 本机已存在的基础镜像名（用于起临时容器做真实探测）
local_base_image() {
  local cand
  for cand in "$BASE_IMAGE" "docker.io/$BASE_NAMESPACE/$BASE_IMAGE"; do
    if docker image inspect "$cand" >/dev/null 2>&1; then
      printf '%s' "$cand"
      return 0
    fi
  done
  return 1
}

# 用临时容器真实测试代理是否可用（容器视角，最可靠）
container_probe_proxy() {
  local proxy="$1" image="$2" out
  out="$(timeout $((TIMEOUT * 3)) docker run --rm --network bridge \
      -e "http_proxy=$proxy" -e "https_proxy=$proxy" \
      -e "HTTP_PROXY=" -e "HTTPS_PROXY=" -e "NO_PROXY=" -e "no_proxy=" \
      --entrypoint sh "$image" -c \
      "wget -q -T $TIMEOUT -O /dev/null '$PROXY_TEST_URL' >/dev/null 2>&1 && echo OK || echo FAIL" 2>/dev/null || true)"
  [ "$(printf '%s' "$out" | tr -d '\r\n')" = OK ]
}

# 宿主机侧回退探测：用 curl 经该代理取测试地址
host_probe_proxy() {
  local proxy="$1"
  curl -s -m "$TIMEOUT" -o /dev/null -x "$proxy" "$PROXY_TEST_URL" 2>/dev/null
}

# 生成代理候选列表（按优先级，已去重）
# 顺序依据「容器视角可靠性」：docker0 网关 > host.docker.internal > NAS 内网 IP
proxy_candidates() {
  local list="" gw lan
  gw="$(docker_bridge_gateway || true)"
  lan="$(primary_ipv4 || true)"

  if [ -n "$gw" ];  then list="$list http://$gw:$PROXY_PORT_DEFAULT"; fi
  list="$list http://host.docker.internal:$PROXY_PORT_DEFAULT"
  if [ -n "$lan" ] && [ "$lan" != "$gw" ]; then list="$list http://$lan:$PROXY_PORT_DEFAULT"; fi

  # 去重输出
  local seen="" p
  for p in $list; do
    case " $seen " in *" $p "*) continue ;; esac
    seen="$seen $p"
    printf '%s\n' "$p"
  done
}

# 该地址是否是「仅容器内可解析」的名字（宿主机 curl 探测无意义）
is_container_only_name() {
  case "$1" in
    *host.docker.internal*|*gateway.docker.internal*) return 0 ;;
    *) return 1 ;;
  esac
}

# 候选代理排序：能真实连通的排在前面（容器探测优先，宿主机探测兜底）
# 判定三态：OK / UNKNOWN（宿主机无法判定，如 host.docker.internal）/ FAIL
rank_proxy_candidates() {
  local raw_cands="$1" image=""
  image="$(local_base_image || true)"

  if [ -n "$image" ]; then
    info "使用临时容器实测代理可达性（镜像：$image）…"
  else
    warn "本机无 $BASE_IMAGE 本地镜像或无法访问 docker → 改用宿主机 curl 探测（仅供参考）"
  fi

  local good="" unknown="" bad="" p
  for p in $raw_cands; do
    local verdict
    if [ -n "$image" ]; then
      # 有镜像 → 能真实做容器探测，结论非 OK 即 FAIL
      if container_probe_proxy "$p" "$image"; then verdict=OK; else verdict=FAIL; fi
    elif is_container_only_name "$p"; then
      # 无镜像且宿主机解析不了 Docker 内置名 → 无法判定，保留待容器内实测
      verdict=UNKNOWN
    elif host_probe_proxy "$p" >/dev/null; then
      verdict=OK
    else
      verdict=FAIL
    fi

    case "$verdict" in
      OK)      ok   "  代理可用    ：$p"; good="$good $p" ;;
      UNKNOWN) info "  代理未判定  ：$p（仅容器内可解析，宿主机无法探测；将注入并由容器内实测）"; unknown="$unknown $p" ;;
      FAIL)    warn "  代理不可用  ：$p"; bad="$bad $p" ;;
    esac
  done

  # 顺序：已确认可用 > 未判定 > 不可用（不可用仍保留，容器内脚本还会再试）
  printf '%s %s %s' "$good" "$unknown" "$bad" | tr -s ' ' '\n' | sed '/^$/d'
}

# ─────────────────────────────────────────────────────────────────────────────
# 构建器选择（BuildKit 默认开启，旧版自动降级）
# ─────────────────────────────────────────────────────────────────────────────
resolve_builder_mode() {
  local want="$BUILDER_MODE"
  local server_ver
  server_ver="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"

  # 用户显式用环境变量关掉 BuildKit 时尊重用户选择
  if [ "${DOCKER_BUILDKIT:-}" = "0" ] && [ "$want" = auto ]; then
    warn "检测到 DOCKER_BUILDKIT=0（环境变量）→ 使用经典构建器"
    printf 'classic'; return 0
  fi

  case "$want" in
    classic) printf 'classic'; return 0 ;;
    buildkit) printf 'buildkit'; return 0 ;;
  esac

  # 默认启用 BuildKit；只有在「确证」Docker 过旧时才降级。
  # 读不到版本（如当前用户无 docker 权限）时仍按 BuildKit 走，
  # 因为构建失败会自动降级重试，把判断交给真实结果而不是猜测。
  if [ -z "$server_ver" ]; then
    warn "无法读取 Docker 版本（可能是当前用户无 docker 权限）→ 仍使用 BuildKit，失败会自动降级"
    printf 'buildkit'; return 0
  fi
  if ver_ge "$server_ver" "18.09"; then
    printf 'buildkit'
  else
    warn "Docker $server_ver 不支持 BuildKit（需 >= 18.09）→ 自动降级为经典构建器"
    printf 'classic'
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 主流程
# ─────────────────────────────────────────────────────────────────────────────
main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run)       DRY_RUN=1; shift ;;
      --no-cache)      FORCE_NO_CACHE=1; shift ;;
      --prune-cache)   PRUNE_CACHE=1; shift ;;
      --no-proxy)      SKIP_PROXY=1; shift ;;
      --classic)       BUILDER_MODE=classic; shift ;;
      --buildkit)      BUILDER_MODE=buildkit; shift ;;
      --probe-proxy)   PROBE_ONLY=1; shift ;;
      -t|--image)      IMAGE_TAG="${2:?}"; shift 2 ;;
      -f)              DOCKERFILE="${2:?}"; shift 2 ;;
      -h|--help)       usage 0 ;;
      *)               err "未知参数: $1"; usage 2 ;;
    esac
  done

  [ -f "$DOCKERFILE" ] || { err "找不到 Dockerfile: $DOCKERFILE"; exit 2; }
  [ -f "$APK_SETUP_SCRIPT" ] || { err "找不到换源脚本: $APK_SETUP_SCRIPT"; exit 2; }
  command -v curl   >/dev/null 2>&1 || { err "缺少 curl"; exit 2; }
  have_docker || { err "缺少 docker 命令"; exit 2; }

  local gp
  gp="$(git -C "$PROJECT_DIR" rev-parse --short HEAD 2>/dev/null || echo '-')"
  info "目标 Dockerfile : $DOCKERFILE"
  info "项目目录        : $PROJECT_DIR  (git $gp)"
  info "架构            : $(host_arch) | 基础镜像 $BASE_IMAGE"

  # ── 第一步：代理探测与注入 ──────────────────────────────────────────────
  echo
  info "【第一步】构建期代理注入（构建容器有独立 netns，必须显式注入）"

  # 诊断：daemon 自身的代理配置。若写成 127.0.0.1 或把公网源列入 NO_PROXY，
  # 正是「宿主机预检正常 / 容器内超时」的根因，这里直接指出并给出修法。
  diagnose_daemon_proxy

  local PROXY_PRIMARY="" PROXY_FALLBACK="" NO_PROXY_VALUE="$DEFAULT_NO_PROXY"

  if [ "$SKIP_PROXY" = 1 ] || [ "${SKIP_PROXY_INJECT:-0}" = 1 ]; then
    warn "已按参数要求跳过代理注入（--no-proxy / SKIP_PROXY_INJECT=1）"
  elif [ -n "${SCREENPLAY_BUILD_PROXY+x}" ] && [ -z "${SCREENPLAY_BUILD_PROXY}" ]; then
    warn "SCREENPLAY_BUILD_PROXY 为空 → 不注入代理"
  else
    local cands
    if [ -n "${SCREENPLAY_BUILD_PROXY:-}" ]; then
      info "使用环境变量指定的构建期代理：$SCREENPLAY_BUILD_PROXY"
      cands="$SCREENPLAY_BUILD_PROXY"
      [ -n "${SCREENPLAY_PROXY_FALLBACK:-}" ] && cands="$cands $SCREENPLAY_PROXY_FALLBACK"
    else
      info "自动探测容器可达的宿主机代理（端口 $PROXY_PORT_DEFAULT）…"
      # shellcheck disable=SC2046
      cands="$(rank_proxy_candidates "$(proxy_candidates | tr '\n' ' ')")"
    fi

    PROXY_PRIMARY="$(printf '%s\n' $cands | sed '/^$/d' | head -1)"
    PROXY_FALLBACK="$(printf '%s\n' $cands | sed '/^$/d' | sed -n '2p')"

    if [ -n "$PROXY_PRIMARY" ]; then
      ok "主代理：$PROXY_PRIMARY"
      [ -n "$PROXY_FALLBACK" ] && ok "备用代理：$PROXY_FALLBACK"
    else
      warn "未探测到可用代理 → 不注入（若容器内 apk 超时，请用 SCREENPLAY_BUILD_PROXY 指定）"
    fi
    # 保留宿主 NO_PROXY 的内网部分（公网镜像站会在容器内被清洗掉）
    [ -n "${NO_PROXY:-}" ] && NO_PROXY_VALUE="$NO_PROXY"
  fi

  # 显式指定代理时的可达性提示（不阻塞）
  if [ -n "$PROXY_PRIMARY" ] && [ -n "${SCREENPLAY_BUILD_PROXY:-}" ]; then
    if probe_proxy_quick "$PROXY_PRIMARY"; then
      ok "代理连通性检查通过"
    else
      warn "代理连通性检查未通过，仍会注入（容器内会自动尝试其它候选与直连）"
    fi
  fi

  if [ "$PROBE_ONLY" = 1 ]; then
    echo
    info "【--probe-proxy】容器视角代理可达性结论："
    printf '  推荐填入 RAWG_PROXY（运行容器用）：http://host.docker.internal:%s\n' "$PROXY_PORT_DEFAULT"
    printf '  构建期注入（本机自动探测）：%s\n' "${PROXY_PRIMARY:-（无）}"
    printf '  注意：不要用 127.0.0.1 —— 容器内那是容器自己。\n'
    return 0
  fi

  # ── 第二步：Docker 镜像源（宿主机预检，用于选择 FROM 前缀） ──────────────
  echo
  local DOCKER_MIRROR="" ALPINE_MIRROR="" DOCKER_HUB_OK=0
  info "【第二步】Docker 镜像源探测（决定 FROM 前缀）"
  local t0 t1 code ms
  t0="$(now_ms)"; code="$(manifest_http_status registry-1.docker.io "$BASE_REPO" "$BASE_TAG")"; t1="$(now_ms)"
  ms=$((t1 - t0))
  if [ "$code" = "200" ]; then
    ok "Docker Hub 可用（清单 HTTP 200，${ms}ms）→ 使用官方"
    DOCKER_HUB_OK=1
  else
    warn "Docker Hub 不可用（HTTP $code，${ms}ms）→ 切换到镜像站"
    for m in "${DOCKER_MIRRORS[@]}"; do
      t0="$(now_ms)"; code="$(manifest_http_status "$m" "$BASE_REPO" "$BASE_TAG")"; t1="$(now_ms)"
      ms=$((t1 - t0))
      if [ "$code" = "200" ]; then
        ok "镜像站 $m 有效（HTTP 200，${ms}ms）→ 启用"
        DOCKER_MIRROR="$m"; break
      fi
      warn "镜像站 $m 无效（HTTP $code，${ms}ms）→ 跳过"
    done
    if [ -z "$DOCKER_MIRROR" ]; then
      warn "所有镜像站均不可用，仍尝试官方源（若失败请检查网络/代理）"
    fi
  fi

  # ── 第三步：Alpine 源 —— 交由容器内真实校验 ─────────────────────────────
  echo
  info "【第三步】Alpine 软件源：容器内真实校验 + 自动故障切换"
  info "  候选源（按优先级）：${ALPINE_MIRRORS[*]}"
  info "  由 scripts/build/apk-setup.sh 在构建容器内用 apk 真实下载 APKINDEX 并试装，"
  info "  宿主机预检结果不作为可用依据，避免「宿主 200 / 容器超时」的假阳性。"

  # 宿主机侧仅作参考展示（不影响构建结果）
  if [ -n "${VERBOSE_PROBE:-}" ]; then
    for m in "$OFFICIAL_APK_HOST" "${ALPINE_MIRRORS[@]}"; do
      t0="$(now_ms)"
      code="$(http_probe "https://$m/alpine/")"
      t1="$(now_ms)"
      info "  [参考] $m → HTTP $code（$((t1 - t0))ms）"
    done
  fi

  # 首选源：默认交给容器内列表顺序决定；APK_MIRROR 可覆盖
  local APK_MIRROR_PREF="${APK_MIRROR:-}"
  local APK_MIRRORS_LIST="${APK_MIRRORS:-${ALPINE_MIRRORS[*]}}"

  # ── 第四步：构建器与构建命令 ────────────────────────────────────────────
  echo
  local mode registry="docker.io/$BASE_NAMESPACE/"
  mode="$(resolve_builder_mode)"
  [ -n "$DOCKER_MIRROR" ] && registry="$DOCKER_MIRROR/$BASE_NAMESPACE/"

  info "【第四步】最终配置："
  ok "  构建器        : $mode$([ "$mode" = buildkit ] && echo '（BuildKit）' || echo '（经典）')"
  ok "  镜像源        : ${DOCKER_MIRROR:-官方 registry-1.docker.io}"

  local probe_image
  probe_image="$(local_base_image || true)"
  local no_cache=""
  if [ "$FORCE_NO_CACHE" = 1 ]; then no_cache="--no-cache"; fi

  # 组装构建参数
  local build_args=(
    --build-arg "REGISTRY=$registry"
    --build-arg "APK_MIRROR=$APK_MIRROR_PREF"
    --build-arg "APK_MIRRORS=$APK_MIRRORS_LIST"
  )
  # 让构建容器内可解析 host.docker.internal（与 docker-compose 的 extra_hosts 一致；
  # 老版本 Docker 不支持该关键字，故仅在成功时追加）。
  local add_host_args=()
  if docker build --help 2>/dev/null | grep -q -- '--add-host'; then
    add_host_args=(--add-host "host.docker.internal:host-gateway")
  fi

  if [ -n "$PROXY_PRIMARY" ]; then
    build_args+=(
      --build-arg "HTTP_PROXY=$PROXY_PRIMARY"
      --build-arg "HTTPS_PROXY=$PROXY_PRIMARY"
      --build-arg "SCREENPLAY_BUILD_PROXY=$PROXY_PRIMARY"
    )
    [ -n "$PROXY_FALLBACK" ] && build_args+=(--build-arg "HTTP_PROXY_FALLBACK=$PROXY_FALLBACK")
    build_args+=(--build-arg "NO_PROXY=$NO_PROXY_VALUE")
    ok "  构建期代理    : $PROXY_PRIMARY"
    info "  NO_PROXY      : $NO_PROXY_VALUE"
    info "                  （容器内会自动清洗掉公网镜像站，确保它们走代理）"
  else
    ok "  构建期代理    : 不注入"
    # 必须显式传空值：Docker 会把 daemon 自己的 HTTP_PROXY/HTTPS_PROXY 作为
    # 「预定义 build-arg」自动注入。若这里什么都不传，daemon 里常见的
    # 127.0.0.1:7890 就会进入构建容器（容器内=容器自己）→ apk 必然超时。
    # 同时清空 SCREENPLAY_BUILD_PROXY，让 npm 阶段直接走国内镜像源兜底。
    build_args+=(
      --build-arg "HTTP_PROXY="
      --build-arg "HTTPS_PROXY="
      --build-arg "NO_PROXY="
      --build-arg "HTTP_PROXY_FALLBACK="
      --build-arg "SCREENPLAY_BUILD_PROXY="
    )
    info "  已显式传入空代理值，覆盖 Docker daemon 可能注入的 127.0.0.1（容器内无效）"
  fi
  # npm 国内镜像源：所有代理方案失败时兜底直连安装（仅构建期生效）
  build_args+=(--build-arg "NPM_MIRROR_REGISTRY=${NPM_MIRROR_REGISTRY:-https://registry.npmmirror.com/}")

  # better-sqlite3 预编译包换源（GitHub Releases 资产，npmmirror 有完整镜像）。
  #
  # 为什么必须有：npm 只能保证 registry 可达，而 better-sqlite3 的原生包走
  # prebuild-install → GitHub Releases；取不到就退化成 node-gyp 源码编译，再去
  # unofficial-builds.nodejs.org 下 node 头文件 —— 构建容器这两处通常都不通
  # （实测直连超时），整条 npm install 就挂在 better-sqlite3 上。
  # 指向 npmmirror 的 binary 镜像后，直接用「镜像 + ABI + libc」拼出的 URL 取
  # 预编译包（node:22-alpine 对应 linuxmusl-x64，见 Dockerfile 的同名注释）。
  # 置为空串 = 保持上游默认（GitHub Releases）。
  build_args+=(--build-arg "NPM_BINARY_MIRROR=${NPM_BINARY_MIRROR:-https://registry.npmmirror.com/-/binary/better-sqlite3}")

  # apk-setup.sh 的内容要参与 Docker 层缓存键。
  #
  # 原因：Docker 对 `COPY <单个文件>` 的缓存键只含文件名（文件名已编码在指令里），
  # 内容变了也照样命中旧层 —— 于是脚本改了却从未生效。实测踩过：给 apk-setup.sh
  # 加了实时进度输出，构建日志里仍是旧行为（「索引OK →」后面什么都没有），排查了
  # 一轮才发现是缓存语义，不是脚本写错。
  #
  # 这里按脚本内容算一个哈希传进去（Dockerfile 里有一条 RUN 引用它），哈希一变
  # 缓存即失效。算不出来时退化为原行为（把 apk-setup.sh 的 COPY 行也一起改动即可
  # 强制失效），不会让构建失败。
  local apk_setup_hash=""
  if [ -f "$PROJECT_DIR/scripts/build/apk-setup.sh" ]; then
    apk_setup_hash="$(sha256sum "$PROJECT_DIR/scripts/build/apk-setup.sh" 2>/dev/null | cut -c1-16 || true)"
  fi
  if [ -n "$apk_setup_hash" ]; then
    build_args+=(--build-arg "APK_SETUP_VERSION=$apk_setup_hash")
  fi
  ok "  npm 兜底源    : ${NPM_MIRROR_REGISTRY:-https://registry.npmmirror.com/}"
  ok "  npm 原生包源  : ${NPM_BINARY_MIRROR:-https://registry.npmmirror.com/-/binary/better-sqlite3}"

  # 版本号：从根 package.json 读，避免版本在多个地方各写一遍。
  # 它最终变成镜像里的 BUILD_VERSION 环境变量，/api/health 会返回它 ——
  # 于是「这个镜像是什么版本」一条 curl 就能确认。读不到时回退到 0.0.0-dev，
  # 不让构建失败（版本号标错远比构建挂掉轻）。
  local pkg_version
  pkg_version="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PROJECT_DIR/package.json" | head -1)"
  pkg_version="${BUILD_VERSION:-${pkg_version:-0.0.0-dev}}"
  build_args+=(--build-arg "BUILD_VERSION=$pkg_version")
  ok "  应用版本      : $pkg_version"
  ok "  Alpine 源候选 : $APK_MIRRORS_LIST"
  ok "  镜像标签      : $IMAGE_TAG"

  # 合并为最终参数数组（--add-host 在前，build-arg 在后）
  local all_args=()
  [ "${#add_host_args[@]}" -gt 0 ] && all_args+=("${add_host_args[@]}")
  all_args+=("${build_args[@]}")

  if [ "$DRY_RUN" = 1 ]; then
    echo
    info "【--dry-run】将执行的构建命令（不执行，可直接复制）："
    echo
    printf 'DOCKER_BUILDKIT=%s docker build%s' \
      "$([ "$mode" = buildkit ] && echo 1 || echo 0)" "${no_cache:+ $no_cache}"
    local a
    for a in "${all_args[@]}"; do
      printf ' \\\n  %q' "$a"
    done
    printf ' \\\n  -t %q %q\n\n' "$IMAGE_TAG" "$PROJECT_DIR"
    return 0
  fi

  echo
  run_build "$mode" "$no_cache" "${all_args[@]}"
}

# 快速代理探测（宿主机 curl，仅用于提示）
probe_proxy_quick() {
  host_probe_proxy "$1" >/dev/null 2>&1
}

# ─────────────────────────────────────────────────────────────────────────────
# 诊断 Docker daemon 的代理配置（只读，给出明确修法）
# ─────────────────────────────────────────────────────────────────────────────
diagnose_daemon_proxy() {
  local found=0 f val

  # 1) systemd drop-in（daemon 进程自身的环境变量）
  for f in /etc/systemd/system/docker.service.d/*.conf \
           /lib/systemd/system/docker.service.d/*.conf \
           /usr/lib/systemd/system/docker.service.d/*.conf; do
    [ -f "$f" ] || continue
    grep -qE 'HTTP_PROXY|HTTPS_PROXY' "$f" 2>/dev/null || continue
    found=1
    info "  发现 daemon 代理配置：$f"
    while IFS= read -r line; do
      clean="$(printf '%s' "$line" | tr -d '"')"

      # 先判 NO_PROXY：它天然含 127.0.0.1，不能被回环规则误伤
      case "$line" in
        *NO_PROXY*|*no_proxy*)
          case "$clean" in
            *mirrors.*|*registry.npmmirror.com*|*docker.1ms.run*)
              warn "    ⚠ NO_PROXY 把公网镜像站列为直连：$clean"
              warn "      本机容器通常没有直连出口 → apk 绕过代理后必然失败。"
              warn "      本脚本已在容器内自动清洗该列表（只保留内网项），无需手改。"
              ;;
          esac
          continue
          ;;
      esac

      # 再判代理地址是否为回环（只对 *_PROXY= 这类赋值行有意义）
      case "$line" in
        *HTTP_PROXY=*|*HTTPS_PROXY=*|*FTP_PROXY=*|*ALL_PROXY=*|*http_proxy=*|*https_proxy=*)
          case "$clean" in
            *127.0.0.1*|*localhost*)
              warn "    ⚠ 代理被写成回环地址：$clean"
              warn "      容器内的 127.0.0.1 指的是容器自己 → 构建期 apk/npm 必然超时。"
              warn "      这正是「宿主机预检正常、容器内超时」的直接原因。"
              warn "      修法（二选一）："
              warn "        a) 改成容器可达地址："
              warn "           Environment=HTTP_PROXY=http://$(primary_ipv4 || echo 宿主机内网IP):$PROXY_PORT_DEFAULT"
              warn "        b) 直接删除该文件（本脚本会显式注入正确代理）："
              warn "           sudo rm $f && sudo systemctl daemon-reload && sudo systemctl restart docker"
              ;;
          esac
          ;;
      esac
    done < "$f"
  done

  # 2) daemon.json 的 proxies 字段
  if [ -r /etc/docker/daemon.json ]; then
    val="$(grep -o '"proxies"[^}]*}' /etc/docker/daemon.json 2>/dev/null || true)"
    if [ -n "$val" ]; then
      case "$val" in
        *'{}'*|*'{}'*) : ;;  # 空对象，未配置
        *127.0.0.1*|*localhost*)
          found=1
          warn "  发现 /etc/docker/daemon.json 的 proxies 使用回环地址：$val"
          warn "      同样无法被构建容器使用，建议改为内网 IP 或移除。"
          ;;
      esac
    fi
  fi

  if [ "$found" = 0 ]; then
    info "  未发现会导致「容器内代理失效」的 daemon 代理配置"
  fi
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# 执行构建（含 BuildKit 失败自动降级重试）
# ─────────────────────────────────────────────────────────────────────────────
run_build() {
  local mode="$1" no_cache="$2"; shift 2
  local build_args=("$@")
  local rc=0

  if [ "$PRUNE_CACHE" = 1 ]; then
    info "按要求清空构建缓存…"
    docker builder prune -af >/dev/null 2>&1 || true
  fi

  info "开始构建（构建器：$mode${no_cache:+，--no-cache}）…"
  info "  日志中的 '[apk-setup]' 行为容器内真实换源过程，失败会自动切下一个源。"
  echo

  local log; log="$(mktemp)"
  set +e
  DOCKER_BUILDKIT=$([ "$mode" = buildkit ] && echo 1 || echo 0) \
    docker build $no_cache "${build_args[@]}" -t "$IMAGE_TAG" "$PROJECT_DIR" 2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}
  set -e

  # BuildKit 本身不可用（而非构建内容出错）时自动降级为经典构建器重试
  if [ "$rc" != 0 ] && [ "$mode" = buildkit ]; then
    if grep -qiE 'buildkit|failed to solve|unknown flag|not supported|unsupported' "$log" \
       && ! grep -qiE 'no such package|Operation timed out|unable to select packages' "$log"; then
      warn "疑似 BuildKit 环境问题 → 自动降级为经典构建器重试"
      echo
      set +e
      DOCKER_BUILDKIT=0 docker build $no_cache "${build_args[@]}" -t "$IMAGE_TAG" "$PROJECT_DIR" 2>&1 | tee "$log"
      rc=${PIPESTATUS[0]}
      set -e
      mode="classic（已降级）"
    fi
  fi

  echo
  if [ "$rc" = 0 ]; then
    ok "构建成功：$IMAGE_TAG（构建器：$mode）"
    docker image prune -f >/dev/null 2>&1 || true
    echo
    info "下一步："
    printf '  sudo docker compose up -d --no-build --force-recreate\n'
    echo
    warn "注意：构建代理只在编译期有效，容器运行时不会继承它。"
    printf '  刮削 / 图片下载走的是「运行时代理」，需在 .env 单独配置（优先级最高）：\n'
    printf '    RAWG_PROXY=http://host.docker.internal:%s\n' "$PROXY_PORT_DEFAULT"
    printf '  仅配构建代理的话，容器启动后仍是直连，境外图片会失败。\n'
    printf '  启动完成后运行：bash scripts/verify-image-fix.sh\n'
    return 0
  fi

  fail "构建失败（exit=$rc）"
  echo "----- 错误片段（末尾 40 行）-----"
  tail -n 40 "$log" || true
  echo "---------------------------------"

  if grep -qiE 'Operation timed out|Temporary failure in name resolution|unable to select packages|no such package' "$log"; then
    err "根因定位：容器内 apk 下载失败，通常是「构建容器拿不到代理」。"
    err "  1) 用 NAS 内网 IP 或 bridge 网关 + 端口指定代理（勿用 127.0.0.1）："
    err "     SCREENPLAY_BUILD_PROXY=http://$(primary_ipv4 || echo 宿主机内网IP):$PROXY_PORT_DEFAULT bash scripts/docker-build.sh"
    err "  2) 先验证哪些地址在容器视角可用：bash scripts/docker-build.sh --probe-proxy"
    err "  3) 确认 mihomo 在运行且监听 *:$PROXY_PORT_DEFAULT"
  elif grep -qiE 'manifest unknown|not found|pull access denied' "$log"; then
    err "根因定位：基础镜像拉取失败，请检查镜像站 REGISTRY 前缀或 Docker 代理。"
  else
    err "根因定位：请检查上方错误片段（常见：镜像站限流/签名不符、npm 依赖源不可达）。"
  fi
  return 1
}

main "$@"