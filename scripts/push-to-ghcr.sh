#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# ScreenPlay — 把本地镜像推到镜像仓库（Docker Hub / GHCR），带重试
#
# 为什么需要它：
#   本机到 ghcr.io / registry-1.docker.io 的链路**不稳定**（TLS 会被中间盒打断，
#   表现为 TLS handshake timeout / EOF），而镜像推送要持续几分钟、涉及几十个层，
#   单次 push 几乎必然中途断开。docker push 是**按层**传输的，重复推同一镜像时
#   已传完的层会被跳过 —— 所以循环重试能逐层推进、最终完成。
#   另外 latest 必须**最后**推：否则 latest 会指向一个版本标签还没推上去的镜像。
#
# 用法：
#   bash scripts/push-to-ghcr.sh                    # 默认镜像 screenplay:latest，版本号读 package.json
#   bash scripts/push-to-ghcr.sh screenplay:1.0.0 1.0.0
#   GH_USER=wyunki462-stack DOCKERHUB_USER=xxx bash scripts/push-to-ghcr.sh
#   RETRIES=8 SLEEP=10 bash scripts/push-to-ghcr.sh
#   DRY_RUN=1 bash scripts/push-to-ghcr.sh          # 只打印将要执行的命令
#
# 环境变量：
#   GH_USER          GHCR 命名空间（默认 wyunki462-stack）
#   DOCKERHUB_USER   Docker Hub 命名空间；为空则只推 GHCR
#   RETRIES          每个标签最多尝试几次（默认 8）
#   SLEEP            两次尝试之间等待秒数（默认 5）
#   LOGIN_TRIES      登录最多尝试几次（默认 8）
#   PUSH_LATEST=0    只推版本标签，不推 latest
#   SKIP_GHCR=1      只推 Docker Hub
#   DRY_RUN=1        只打印命令
#
# 凭据：脚本只在**还没登录**时才调 `docker login`（凭据缓存在 ~/.docker/config.json）。
#   也**不会**把 token 写进任何文件或命令历史 —— 交互式输入。
#   · GHCR      → 用户名 = GitHub 用户名，密码 = PAT，权限只需 write:packages + read:packages
#   · Docker Hub→ 用户名/密码 = Docker Hub 用户名 / Access Token（仓库要先在网页上建好）
# ═════════════════════════════════════════════════════════════════════════════

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

IMAGE="${1:-${IMAGE:-screenplay:latest}}"
VERSION="${2:-}"

GH_USER="${GH_USER:-wyunki462-stack}"
DOCKERHUB_USER="${DOCKERHUB_USER:-}"
RETRIES="${RETRIES:-8}"
SLEEP="${SLEEP:-5}"
LOGIN_TRIES="${LOGIN_TRIES:-8}"
PUSH_LATEST="${PUSH_LATEST:-1}"
SKIP_GHCR="${SKIP_GHCR:-0}"
DRY_RUN="${DRY_RUN:-0}"

say()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── 前置检查 ────────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "找不到 docker 命令"
docker info >/dev/null 2>&1 || die "连不上 Docker daemon：
   · 不在 docker 组 → sudo usermod -aG docker \$USER 后重新登录
   · daemon 没启动   → sudo systemctl start docker"
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "本地没有镜像 $IMAGE —— 先构建：
   bash scripts/docker-build.sh"
say "前置检查"
ok "镜像 ${IMAGE} 存在（$(docker image inspect -f '{{.Size}}' "$IMAGE" | awk '{printf "%.0f MB", $1/1024/1024}')）"

if [ -z "$VERSION" ]; then
  VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$PROJECT_DIR/package.json" | head -1)"
  [ -n "$VERSION" ] || die "读不出 package.json 里的版本号，请显式传入：bash scripts/push-to-ghcr.sh <镜像> <版本>"
fi

# ── 目标仓库 ────────────────────────────────────────────────────────────────
TARGETS=()                       # "registry|login_user|repo"
[ "$SKIP_GHCR" = "1" ] || TARGETS+=("ghcr.io|${GH_USER}|ghcr.io/${GH_USER}/screenplay")
if [ -n "$DOCKERHUB_USER" ]; then
  TARGETS+=("index.docker.io|${DOCKERHUB_USER}|${DOCKERHUB_USER}/screenplay")
elif [ "$SKIP_GHCR" = "1" ]; then
  die "SKIP_GHCR=1 但没给 DOCKERHUB_USER，没有可推的仓库"
fi

say "准备推送"
ok "镜像      : ${IMAGE}"
ok "版本      : ${VERSION}"
for t in "${TARGETS[@]}"; do ok "目标仓库  : ${t##*|}"; done
ok "重试策略  : 每个标签最多 ${RETRIES} 次，间隔 ${SLEEP}s"

# ── 登录（只在本机还没有凭据时）──────────────────────────────────────────────
ensure_login() {
  local registry="$1" user="$2"
  [ "$DRY_RUN" = "1" ] && { printf '  (dry-run) docker login %s -u %s\n' "$registry" "$user"; return 0; }
  if grep -qs "\"$registry\"" "${HOME}/.docker/config.json" 2>/dev/null; then
    ok "${registry} 已有登录凭据，跳过登录"
    return 0
  fi
  warn "本机没有 ${registry} 凭据，现在登录（${LOGIN_TRIES} 次重试；密码：GHCR 用 PAT / Docker Hub 用 Access Token）"
  local i
  for ((i = 1; i <= LOGIN_TRIES; i++)); do
    printf '  第 %d/%d 次登录…\n' "$i" "$LOGIN_TRIES"
    if [ "$registry" = "index.docker.io" ]; then
      docker login -u "$user" && { ok "登录成功"; return 0; }
    else
      docker login "$registry" -u "$user" && { ok "登录成功"; return 0; }
    fi
    echo "    失败（多为网络抖动），${SLEEP}s 后重试"
    sleep "$SLEEP"
  done
  die "登录 ${registry} 失败 ${LOGIN_TRIES} 次：EOF/TLS timeout = 链路问题（考虑给 docker daemon 配 https-proxy）；
   unauthorized = 用户名/密码不对；permission_denied/insufficient_scope = PAT 权限不够。"
}

# ── 推送（逐层推进）─────────────────────────────────────────────────────────
push_once() {
  local ref="$1" i out rc
  for ((i = 1; i <= RETRIES; i++)); do
    if [ "$DRY_RUN" = "1" ]; then
      printf '  (dry-run) docker push %s\n' "$ref"
      return 0
    fi
    out="$(mktemp)"
    docker push "$ref" >"$out" 2>&1
    rc=$?
    tail -3 "$out" | sed 's/^/     /'
    if [ $rc -eq 0 ]; then
      rm -f "$out"; ok "已推送 ${ref}（第 ${i} 次尝试）"
      return 0
    fi
    if grep -qiE 'denied|unauthorized|insufficient_scope|authentication required' "$out"; then
      printf '\n'; grep -iE 'denied|unauthorized|insufficient_scope|authentication required' "$out" | head -2 | sed 's/^/     /'
      rm -f "$out"
      die "认证/权限被拒，重试无用：
   · denied / permission_denied → GHCR 的 PAT 缺少 write:packages，或 Docker Hub 上还没建 screenplay 仓库
   · unauthorized               → 用户名或 token 不对 / 已过期
   · insufficient_scope         → token 权限范围不够
   登录网页检查后再跑：https://github.com/settings/tokens 或 https://hub.docker.com/settings/security"
    fi
    rm -f "$out"
    warn "${ref} 第 ${i}/${RETRIES} 次失败（已传完的层会跳过）"
    [ "$i" -lt "$RETRIES" ] && sleep "$SLEEP"
  done
  return 1
}

FAILED=()
for t in "${TARGETS[@]}"; do
  registry="${t%%|*}"; rest="${t#*|}"; login_user="${rest%%|*}"; repo="${rest#*|}"
  say "→ ${repo}"
  ensure_login "$registry" "$login_user"

  if [ "$DRY_RUN" = "1" ]; then
    printf '  (dry-run) docker tag %s %s:%s\n  (dry-run) docker tag %s %s:latest\n' "$IMAGE" "$repo" "$VERSION" "$IMAGE" "$repo"
  else
    docker tag "$IMAGE" "${repo}:${VERSION}" || die "docker tag 失败：${repo}:${VERSION}"
    # 先推版本标签：这样 latest 永远指向一个「已经确认推上去」的版本
  fi
  push_once "${repo}:${VERSION}" || { FAILED+=("${repo}:${VERSION}"); continue; }

  [ "$PUSH_LATEST" = "0" ] && continue
  [ "$DRY_RUN" = "1" ] || docker tag "$IMAGE" "${repo}:latest" >/dev/null 2>&1 || true
  push_once "${repo}:latest" || FAILED+=("${repo}:latest")
done

# ── 汇总 ────────────────────────────────────────────────────────────────────
say "结果"
if [ ${#FAILED[@]} -eq 0 ]; then
  ok "全部标签推送成功"
  cat <<NEXT

  去确认一下：
    GHCR        https://github.com/users/${GH_USER}/packages
    Docker Hub  https://hub.docker.com/r/${DOCKERHUB_USER:-<你的DockerHub用户名>}/screenplay/tags

  注意：GHCR 新包默认 private，别的设备拉不了 —— 进包设置改公开：
    https://github.com/users/${GH_USER}/packages/container/screenplay/settings
    → Danger Zone → Change visibility → Public

  目标设备上：
    docker pull ghcr.io/${GH_USER}/screenplay:${VERSION}
NEXT
else
  warn "以下标签没推成功（已推上去的层不会白费，重跑本脚本即可接着传）："
  printf '    %s\n' "${FAILED[@]}"
  printf '\n  若报的全是 EOF / TLS handshake timeout，说明链路太不稳，两条路选一条：\n'
  printf '    ① 给 docker daemon 配代理（见 docs/UPLOAD.md 的 B5 段）后重跑\n'
  printf '    ② 走内网：bash scripts/package-image.sh 打包，或 bash transfer-image.sh 用户@目标设备IP\n'
  exit 1
fi
