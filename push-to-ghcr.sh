#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# ScreenPlay — 把本地镜像上传到 GitHub 容器仓库（GHCR）
#
#     bash push-to-ghcr.sh
#
# 为什么需要它：
#   本机到 ghcr.io 的连接**不稳定**（实测直连约 4/6 成功、经代理约 1/3），
#   而 584MB 的镜像推送需要持续几分钟、涉及几十个层。单次 push 几乎必然
#   中途断开，表现为 TLS handshake timeout / EOF。
#
#   对策：docker push 是**按层**传输的。重复推同一镜像时，已经传完的层会被
#   跳过，所以循环重试能逐层推进、最终完成。docker login 同理 —— 它只发一个
#   很小的认证请求，重试几次就能过。
#
# ⚠️ 前置：token 只勾 write:packages + read:packages，不要勾 repo。
#    不要把 token 写进本脚本或任何命令历史里。
# ═════════════════════════════════════════════════════════════════════════════

set -uo pipefail

# ── 可调参数 ────────────────────────────────────────────────────────────────
GH_USER="${GH_USER:-wyunki462-stack}"
IMAGE="${IMAGE:-screenplay:latest}"
REGISTRY_IMG="ghcr.io/${GH_USER}/screenplay"
TAG_LATEST="${REGISTRY_IMG}:latest"
TAG_VERSION="${REGISTRY_IMG}:$(cd "$(dirname "$0")" && python3 -c "import json;print(json.load(open('package.json'))['version'])" 2>/dev/null || echo '0.6.0-beta.1')"

LOGIN_TRIES="${LOGIN_TRIES:-15}"
PUSH_TRIES="${PUSH_TRIES:-40}"
SLEEP_BETWEEN="${SLEEP_BETWEEN:-5}"

say()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── 前置检查 ────────────────────────────────────────────────────────────────
say "前置检查"
command -v docker >/dev/null 2>&1 || die "找不到 docker"
docker info >/dev/null 2>&1 || die "连不上 Docker daemon（你可能不在 docker 组，或 daemon 没启动）"
docker image inspect "$IMAGE" >/dev/null 2>&1 \
  || die "本地没有镜像 $IMAGE。先在仓库目录执行：docker build -t $IMAGE ."
ok "镜像 $IMAGE 存在（$(docker image inspect -f '{{.Size}}' "$IMAGE" | awk '{printf "%.0f MB", $1/1024/1024}')）"

printf '  目标: %s\n' "$TAG_LATEST"
printf '        %s\n' "$TAG_VERSION"

# ── 登录 ────────────────────────────────────────────────────────────────────
# 已经登录过就跳过（凭据缓存在 ~/.docker/config.json）。
if grep -qs '"ghcr.io"' "${HOME}/.docker/config.json" 2>/dev/null; then
  ok "已存在 ghcr.io 登录凭据，跳过登录"
else
  say "登录 ghcr.io（需要 PAT，密码处输入；权限只需 write:packages）"
  logged_in=0
  for i in $(seq 1 "$LOGIN_TRIES"); do
    printf '  第 %d/%d 次登录尝试... ' "$i" "$LOGIN_TRIES"
    # 凭据在 stdin 交互输入；每次重试都提示一次密码
    if docker login ghcr.io -u "$GH_USER"; then
      echo; ok "登录成功"; logged_in=1; break
    fi
    echo "失败（多为网络抖动），${SLEEP_BETWEEN}s 后重试"
    sleep "$SLEEP_BETWEEN"
  done
  [ "$logged_in" = 1 ] || die "登录 $LOGIN_TRIES 次均失败。若报 EOF/TLS timeout 多为网络问题；
   若报 unauthorized 则是用户名/PAT 不对；若报 permission_denied 则是 PAT 缺少 write:packages。"
fi

# ── 打 tag ──────────────────────────────────────────────────────────────────
say "打 tag"
docker tag "$IMAGE" "$TAG_LATEST"   && ok "$TAG_LATEST"
docker tag "$IMAGE" "$TAG_VERSION"  && ok "$TAG_VERSION"

# ── 推送（逐层推进）─────────────────────────────────────────────────────────
push_one() {
  _img="$1"
  printf '\n\033[1m-- 推送 %s --\033[0m\n' "$_img"
  for i in $(seq 1 "$PUSH_TRIES"); do
    printf '  第 %d/%d 次...\n' "$i" "$PUSH_TRIES"

    # ⚠️ 必须捕获 docker 自己的退出码。
    # 若写成 `if docker push ... | tee log | tail -4; then`，判断的是**管道最后
    # 一个命令（tail）**的退出码 —— tail 永远成功，于是失败也会被当成成功，
    # 循环第一轮就会「完成」，而镜像其实没推上去。
    # 所以这里：先把输出落盘，再单独取 PIPESTATUS[0]。
    _out="$(mktemp)"
    docker push "$_img" >"$_out" 2>&1
    _rc=${PIPESTATUS[0]:-$?}
    tail -4 "$_out" | sed 's/^/     /'

    if [ "$_rc" -eq 0 ]; then
      rm -f "$_out"; ok "推送完成"; return 0
    fi

    # 认证类错误重试没有意义，立即给出可操作的结论
    if grep -qE 'denied|unauthorized|insufficient_scope' "$_out"; then
      printf '\n'; grep -E 'denied|unauthorized|insufficient_scope' "$_out" | head -2 | sed 's/^/     /'
      rm -f "$_out"
      die "认证/权限被拒，重试无用：
   · denied: permission_denied  → PAT 缺少 write:packages
   · unauthorized               → 用户名或 PAT 不对、或 PAT 已过期
   · insufficient_scope         → PAT 权限范围不够
   去 https://github.com/settings/tokens 检查后再跑。"
    fi

    rm -f "$_out"
    echo "     网络失败，${SLEEP_BETWEEN}s 后重试（已传完的层会被跳过）"
    sleep "$SLEEP_BETWEEN"
  done
  return 1
}

say "推送镜像（断线会自动重试，已传完的层不会重复传）"
push_one "$TAG_LATEST" || die "推送 latest 失败（$PUSH_TRIES 次）。若全是 EOF/TLS timeout，
   说明链路太不稳定，考虑改用内网传输：bash transfer-image.sh 用户@目标设备"
push_one "$TAG_VERSION" || warn "版本 tag 推送失败，但 latest 已成功；可稍后重跑本脚本补上"

# ── 收尾 ────────────────────────────────────────────────────────────────────
say "完成"
ok "$TAG_LATEST"
ok "$TAG_VERSION"
cat <<'NEXT'

下一步：把包设为公开，否则别的设备拉不了
  https://github.com/users/wyunki462-stack/packages/container/screenplay/settings
  → 页面最下方 Danger Zone → Change visibility → Public

目标设备上：
  docker pull ghcr.io/wyunki462-stack/screenplay:latest
NEXT