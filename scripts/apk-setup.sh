#!/bin/sh
# =============================================================================
# ScreenPlay — Alpine apk「构建容器内真实可用校验 + 自动故障切换」
#
# 为什么需要它（根因）：
#   宿主机预检 APKINDEX 返回 200，**不代表构建容器能用同一个源**。构建容器有
#   独立的网络命名空间：
#     1) 不继承宿主机的代理配置，且 docker.service 的 HTTP_PROXY 常被写成
#        127.0.0.1:7890 —— 在容器里 127.0.0.1 指的是容器自己，必然连接失败；
#     2) docker.service 的 NO_PROXY 常把国内镜像站列进去，于是 apk 绕过代理直连，
#        而本机容器几乎没有直连出口 → 必然超时。
#   本脚本在**构建容器内部**用 apk 自身做真实下载校验：真正能下完 APKINDEX 并
#   装上包的源才算可用，失败自动切下一个源，彻底摆脱「宿主机 200 / 容器超时」。
#
# 用法（仅由 Dockerfile 调用）：
#   sh /tmp/apk-setup.sh <包名...>
#
# 可用环境变量（均由 Dockerfile 的 build-arg 注入，全部只作用于构建阶段）：
#   HTTP_PROXY / HTTPS_PROXY      主代理（容器可达地址，如 http://<代理主机IP>:7890）
#   HTTP_PROXY_FALLBACK           备用代理
#   NO_PROXY                      直连白名单（本脚本只保留内网/本地项，镜像站一律走代理）
#   APK_MIRROR                    首选源（会排到候选列表最前）
#   APK_MIRRORS                   候选源列表（空格或逗号分隔）
#   APK_PROBE_TIMEOUT             单源连通性探测超时秒数（默认 45）
#   APK_INSTALL_TIMEOUT           单源实际安装超时秒数（默认 900）
#
# 依赖：只用 busybox 内建（sh/awk/printf/timeout），不需要 curl/wget。
#       不引入「要装源工具 → 要能用源 → 要装源工具」的自举死锁。
# =============================================================================

set -u

PKGS="$*"

PROBE_TIMEOUT="${APK_PROBE_TIMEOUT:-45}"
INSTALL_TIMEOUT="${APK_INSTALL_TIMEOUT:-900}"
PROXY_PRIMARY="${HTTP_PROXY:-${http_proxy:-}}"
PROXY_FALLBACK="${HTTP_PROXY_FALLBACK:-}"
NO_PROXY_RAW="${NO_PROXY:-${no_proxy:-}}"
MIRROR_PRIMARY="${APK_MIRROR:-}"
MIRRORS_RAW="${APK_MIRRORS:-}"

# 内置兜底源列表（国内优先；官方源最后，仅作最后的可能性）。
# 注意：mirrors.163.com 已不再提供 /alpine 路径（404），不得加入。
MIRRORS_BUILTIN="mirrors.aliyun.com mirrors.tuna.tsinghua.edu.cn mirrors.ustc.edu.cn mirrors.huaweicloud.com dl-cdn.alpinelinux.org"

PROXY_ENV_FILE="${APK_PROXY_ENV_FILE:-/tmp/screenplay-proxy-env}"

# ─────────────────────────────────────────────────────────────────────────────
# 工具
# ─────────────────────────────────────────────────────────────────────────────
# 列表去重追加：$1=当前列表 $2=待追加元素（空格分隔，元素内不含空格）
list_add() {
  case " $1 " in
    *" $2 "*) printf '%s' "$1" ;;
    *) if [ -z "$1" ]; then printf '%s' "$2"; else printf '%s %s' "$1" "$2"; fi ;;
  esac
}

# 把逗号/换行分隔的列表规范成空格分隔（busybox 有 tr/awk）
normalize_list() {
  printf '%s' "$1" | tr ',;\n\t' '    ' | awk '{ for (i = 1; i <= NF; i++) printf "%s%s", (n++ ? " " : ""), $i }'
}

have_timeout() {
  command -v timeout >/dev/null 2>&1
}

# 带超时执行；无 timeout 内建时退化为直接执行（不影响正确性）
run_limited() {
  _t="$1"; shift
  if have_timeout; then
    timeout "$_t" "$@"
  else
    "$@"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# NO_PROXY 清洗：只保留「内网/本地」条目，镜像站与 registry 一律丢弃
#
# 这是本脚本最关键的一处修复：宿主机 docker.service 的 NO_PROXY 里带了
# mirrors.aliyun.com 等站点，导致构建容器内 apk 绕过代理直连 → 超时。
# NO_PROXY 的语义本就只应是「内网地址」，公网站点必须走代理。
# ─────────────────────────────────────────────────────────────────────────────
is_internal_host() {
  case "$1" in
    localhost|::1|0.0.0.0) return 0 ;;
    host.docker.internal|gateway.docker.internal) return 0 ;;
    *.local|*.lan|*.internal|*.docker.internal|*.home.arpa) return 0 ;;
    127.*|10.*|192.168.*|169.254.*) return 0 ;;
    172.1[6-9].*|172.2[0-9].*|172.3[01].*) return 0 ;;
    *) return 1 ;;
  esac
}

sanitize_no_proxy() {
  _in="$(normalize_list "$1")"
  _out=""
  for _e in $_in; do
    if is_internal_host "$_e"; then
      _out="$(list_add "$_out" "$_e")"
    fi
  done
  printf '%s' "$_out"
}

# ─────────────────────────────────────────────────────────────────────────────
# 从 /proc/net/route 推导容器默认网关
#
# 用途：当代理被写成 127.0.0.1:7890（容器内无意义）时，自动改写成
# <默认网关>:7890。构建容器默认在 bridge 网络，网关就是宿主机上的 docker0
# 地址（如 172.17.0.1），因此这是宿主机代理最常见的容器可达地址。
# 独立成函数以便用固定文件做单元测试。
# ─────────────────────────────────────────────────────────────────────────────
gateway_from_route_file() {
  _f="${1:-/proc/net/route}"
  [ -r "$_f" ] || return 1
  # 默认路由：Destination=00000000，Gateway 为小端十六进制
  _gw="$(awk '$2 == "00000000" { print $3; exit }' "$_f" 2>/dev/null)"
  case "$_gw" in
    [0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]) ;;
    *) return 1 ;;
  esac
  _b0="0x${_gw%??????}"
  _t="${_gw#??}"; _b1="0x${_t%????}"
  _t="${_gw#????}"; _b2="0x${_t%??}"
  _b3="0x${_gw#??????}"
  printf '%d.%d.%d.%d' "$((_b3))" "$((_b2))" "$((_b1))" "$((_b0))" 2>/dev/null || return 1
}

local_gateway() {
  gateway_from_route_file /proc/net/route
}

# 提取 URL 的 host 部分（去掉 scheme、userinfo、port、path）
proxy_host() {
  _u="$1"
  _u="${_u#*://}"
  _u="${_u##*@}"
  _u="${_u%%/*}"
  _u="${_u%%:*}"
  printf '%s' "$_u"
}

# 提取 URL 的端口；无端口时返回空
proxy_port() {
  _u="$1"
  _u="${_u#*://}"
  _u="${_u##*@}"
  _u="${_u%%/*}"
  case "$_u" in
    *:*) _p="${_u##*:}"; case "$_p" in ''|*[!0-9]*) printf '' ;; *) printf '%s' "$_p" ;; esac ;;
    *) printf '' ;;
  esac
}

is_loopback_proxy() {
  case "$(proxy_host "$1")" in
    127.*|localhost|::1|0.0.0.0) return 0 ;;
    *) return 1 ;;
  esac
}

# 把 127.0.0.1:7890 改写成 <容器默认网关>:7890（保留原端口）
repair_loopback_proxy() {
  _p="$1"
  _gw="$(local_gateway)" || return 1
  _port="${_p##*:}"
  case "$_port" in ''|*[!0-9]*) _port=7890 ;; esac
  printf 'http://%s:%s' "$_gw" "$_port"
}

# ─────────────────────────────────────────────────────────────────────────────
# 候选列表
# ─────────────────────────────────────────────────────────────────────────────
build_mirrors() {
  _list=""
  if [ -n "$MIRROR_PRIMARY" ]; then
    _list="$(list_add "$_list" "$MIRROR_PRIMARY")"
  fi
  _raw="$(normalize_list "${MIRRORS_RAW:-$MIRRORS_BUILTIN}")"
  # APK_MIRRORS 为空时上面已回退到内置列表；若 APK_MIRRORS 非空但缺内置源，补在后
  [ -n "$MIRRORS_RAW" ] || _raw="$MIRRORS_BUILTIN"
  for _m in $_raw; do
    _list="$(list_add "$_list" "$_m")"
  done
  printf '%s' "$_list"
}

# 候选代理模式：元素为 URL 或字面量 none（直连）
build_modes() {
  _list=""
  _note=""
  if [ -n "$PROXY_PRIMARY" ]; then
    if is_loopback_proxy "$PROXY_PRIMARY"; then
      _note="loopback"
    else
      _list="$(list_add "$_list" "$PROXY_PRIMARY")"
    fi
  fi
  [ -n "$PROXY_FALLBACK" ] && _list="$(list_add "$_list" "$PROXY_FALLBACK")"

  # 主代理是 127.0.0.1/localhost —— 容器内必然不可用，改写成默认网关地址
  if [ "$_note" = loopback ]; then
    _fixed="$(repair_loopback_proxy "$PROXY_PRIMARY" 2>/dev/null || true)"
    if [ -n "$_fixed" ]; then
      printf '[apk-setup] 代理 %s 是回环地址，在构建容器内不可用 → 自动改写为 %s（容器默认网关）\n' \
        "$PROXY_PRIMARY" "$_fixed" >&2
      _list="$(list_add "$_list" "$_fixed")"
    else
      printf '[apk-setup] 警告：代理 %s 是回环地址且无法推导容器网关，将跳过该代理\n' "$PROXY_PRIMARY" >&2
    fi
  fi

  # 始终把「本容器自己的默认网关」作为兜底候选：无论构建用 bridge 还是
  # BuildKit 自建网桥，网关就是宿主机在该网段上的地址，是最可靠的一跳。
  # 端口沿用已配置代理的端口（若无则用 7890，mihomo/clash 默认端口）。
  _gw="$(local_gateway 2>/dev/null || true)"
  if [ -n "$_gw" ]; then
    _gwport="$(proxy_port "$PROXY_PRIMARY")"
    [ -n "$_gwport" ] || _gwport="$(proxy_port "$PROXY_FALLBACK")"
    [ -n "$_gwport" ] || _gwport=7890
    _list="$(list_add "$_list" "http://$_gw:$_gwport")"
  fi

  _list="$(list_add "$_list" none)"
  printf '%s' "$_list"
}

mode_label() {
  if [ "$1" = none ]; then printf '直连'; else printf '%s' "$1"; fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 代理应用 / 结果落盘
# ─────────────────────────────────────────────────────────────────────────────
apply_proxy() {
  if [ "$1" = none ]; then
    unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
  else
    http_proxy="$1"; https_proxy="$1"; all_proxy="$1"
    HTTP_PROXY="$1"; HTTPS_PROXY="$1"; ALL_PROXY="$1"
    export http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
  fi
  # no_proxy：只放行内网（镜像站必须走代理，见 sanitize_no_proxy 注释）
  no_proxy="$NO_PROXY_CLEAN"; NO_PROXY="$NO_PROXY_CLEAN"
  export no_proxy NO_PROXY
}

write_repos() {
  printf 'https://%s/alpine/v%s/main\nhttps://%s/alpine/v%s/community\n' \
    "$1" "$ALPINE_VER" "$1" "$ALPINE_VER" > "${APK_REPOS_FILE:-/etc/apk/repositories}"
}

# 把「实测可用」的代理配置留给后续构建步骤（npm install 等）复用。
# 只写构建阶段的临时文件，绝不 ENV 进镜像，因此不影响最终容器的入站访问。
# 除已生效代理外，还写出 SCREENPLAY_PROXY_CANDIDATES（全部候选，按可用概率
# 排序），供 npm 步骤在首个代理失效时自行重试。
write_proxy_env_file() {
  : > "$PROXY_ENV_FILE"
  if [ "$1" != none ]; then
    {
      printf "export http_proxy='%s'\n" "$1"
      printf "export https_proxy='%s'\n" "$1"
      printf "export all_proxy='%s'\n" "$1"
      printf "export HTTP_PROXY='%s'\n" "$1"
      printf "export HTTPS_PROXY='%s'\n" "$1"
    } >> "$PROXY_ENV_FILE"
  fi
  printf "export no_proxy='%s'\n" "$NO_PROXY_CLEAN" >> "$PROXY_ENV_FILE"
  printf "export NO_PROXY='%s'\n" "$NO_PROXY_CLEAN" >> "$PROXY_ENV_FILE"

  # 候选列表（排除 none），供后续步骤重试
  _cands=""
  for _c in $MODES; do
    [ "$_c" = none ] && continue
    _cands="$(list_add "$_cands" "$_c")"
  done
  printf "SCREENPLAY_PROXY_CANDIDATES='%s'\n" "$_cands" >> "$PROXY_ENV_FILE"
}

# ─────────────────────────────────────────────────────────────────────────────
# 主流程
# ─────────────────────────────────────────────────────────────────────────────
# Alpine 版本（major.minor），用于拼 /alpine/vX.Y/ 路径。
# 优先用环境变量覆盖（便于测试/离线），否则从镜像内实际发行版读取——
# 不写死版本号，避免基础镜像升级后路径失配。
alpine_version() {
  if [ -n "${ALPINE_VER_OVERRIDE:-}" ]; then
    printf '%s' "$ALPINE_VER_OVERRIDE"
    return 0
  fi
  cut -d. -f1,2 /etc/alpine-release 2>/dev/null || true
}

main() {
  if [ -z "$PKGS" ]; then
    echo "[apk-setup] 错误：未指定要安装的包（用法: sh apk-setup.sh <包名...>）" >&2
    exit 2
  fi

  ALPINE_VER="$(alpine_version)"
  if [ -z "$ALPINE_VER" ]; then
    echo "[apk-setup] 错误：无法从 /etc/alpine-release 读取 Alpine 版本" >&2
    exit 2
  fi

  NO_PROXY_CLEAN="$(sanitize_no_proxy "$NO_PROXY_RAW")"
  MIRRORS="$(build_mirrors)"
  MODES="$(build_modes)"

  _n_mirror=0; for _x in $MIRRORS; do _n_mirror=$((_n_mirror + 1)); done
  _n_mode=0;   for _x in $MODES;   do _n_mode=$((_n_mode + 1)); done
  _total=$((_n_mirror * _n_mode))

  echo "== [apk-setup] alpine=v$ALPINE_VER  待装包: $PKGS =="
  echo "== [apk-setup] 候选源($_n_mirror): $MIRRORS"
  _disp=""
  for _x in $MODES; do _disp="$(list_add "$_disp" "$(mode_label "$_x")")"; done
  echo "== [apk-setup] 代理候选($_n_mode): $_disp"
  if [ -n "$NO_PROXY_RAW" ]; then
    echo "== [apk-setup] NO_PROXY 清洗: [$NO_PROXY_RAW] → [$NO_PROXY_CLEAN]（公网镜像站已移除，确保走代理）"
  fi

  _attempt=0
  _ok=0
  _used_mirror=""
  _used_mode=""

  for _mode in $MODES; do
    for _m in $MIRRORS; do
      _attempt=$((_attempt + 1))
      apply_proxy "$_mode"
      write_repos "$_m"
      printf -- '-- [apk-setup] [%d/%d] 源=%-32s 代理=%-28s ' \
        "$_attempt" "$_total" "$_m" "$(mode_label "$_mode")"

      # 第一段：连通性探测（只下 APKINDEX，快失败、快切换）
      if ! run_limited "$PROBE_TIMEOUT" apk update >/tmp/apk-probe.log 2>&1; then
        printf '索引失败（超时/不可达/源无此路径）\n'
        if [ -s /tmp/apk-probe.log ]; then
          tail -n 3 /tmp/apk-probe.log | sed 's/^/     | /'
        fi
        continue
      fi
      printf '索引OK → '

      # 第二段：真实安装（给足时间，避免慢速可用源被误判）
      if run_limited "$INSTALL_TIMEOUT" apk add --no-cache $PKGS >/tmp/apk-add.log 2>&1; then
        printf '安装成功\n'
        _ok=1; _used_mirror="$_m"; _used_mode="$_mode"
        break
      fi
      printf '安装失败\n'
      if [ -s /tmp/apk-add.log ]; then
        tail -n 5 /tmp/apk-add.log | sed 's/^/     | /'
      fi
      rm -rf /var/cache/apk/* 2>/dev/null || true
    done
    [ "$_ok" = 1 ] && break
  done

  echo
  if [ "$_ok" = 1 ]; then
    # 锁定生效的源，供后续 apk 使用
    write_repos "$_used_mirror"
    rm -rf /var/cache/apk/* 2>/dev/null || true
    write_proxy_env_file "$_used_mode"
    echo "== [apk-setup] 生效：源=$_used_mirror  代理=$(mode_label "$_used_mode")（共尝试 $_attempt/$_total 次）=="
    echo "== [apk-setup] 已写入 $PROXY_ENV_FILE 供后续构建步骤（npm install）复用 =="
    return 0
  fi

  # 全部失败：把源恢复成首选源，避免把「最后一个碰巧试过的源」留在镜像里，
  # 也便于人工按提示重试。
  if [ -n "$MIRROR_PRIMARY" ]; then
    write_repos "$MIRROR_PRIMARY"
  fi

  echo "== [apk-setup] 全部 $_total 种「源 x 代理」组合均失败 ==" >&2
  echo "   排查建议：" >&2
  echo "     1) 构建容器是否真的能连到宿主机代理？用 NAS 内网 IP 或 bridge 网关 + 7890，" >&2
  echo "        不要用 127.0.0.1（那是容器自己）。可用：" >&2
  echo "        bash scripts/docker-build.sh --probe-proxy" >&2
  echo "     2) 本机容器可能没有直连出口，所有外网都必须经代理；请确认代理已注入。" >&2
  echo "     3) 确认 NO_PROXY 未把 mirrors.* 列为直连（本脚本已自动清洗）。" >&2
  echo "     4) 也可显式指定源：APK_MIRROR=mirrors.tuna.tsinghua.edu.cn sh /tmp/apk-setup.sh <包>" >&2
  exit 1
}

# 便于离线单元测试纯函数：APK_SETUP_NO_MAIN=1 时只定义函数不执行
if [ "${APK_SETUP_NO_MAIN:-0}" = 1 ]; then
  return 0 2>/dev/null || exit 0
fi

main "$@"