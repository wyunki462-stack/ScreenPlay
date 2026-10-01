#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# ScreenPlay — 把本地镜像推到镜像仓库（带重试，专治「TLS 中断 / 网络抖动」）
#
# 为什么需要它：
#   docker push 是**按层**上传的，中途被网络打断时已传完的层不会白费，
#   直接重跑同一条 push 就会接着传。手工盯着重跑很烦，而且 latest 标签必须
#   **最后**推，否则会出现「latest 指向一个版本标签还没推上去的镜像」。
#   本脚本把「重试 + 版本标签优先 + latest 兜底」固定下来。
#
# 用法：
#   bash scripts/push-to-ghcr.sh                    # 默认镜像 screenplay:latest，版本号读 package.json
#   bash scripts/push-to-ghcr.sh screenplay:0.6.4 0.6.4
#   GH_USER=wyunki462-stack DOCKERHUB_USER=xxx bash scripts/push-to-ghcr.sh
#   RETRIES=8 SLEEP=10 bash scripts/push-to-ghcr.sh
#
# 环境变量：
#   GH_USER          GHCR 命名空间（默认 wyunki462-stack）
#   DOCKERHUB_USER   Docker Hub 命名空间；为空则只推 GHCR
#   RETRIES          每个标签最多尝试几次（默认 5）
#   SLEEP            两次尝试之间等待秒数（默认 5）
#   SKIP_GHCR=1      只推 Docker Hub
#   DRY_RUN=1        只打印将要执行的命令，不真的推
#
# 本脚本**不代你登录**（避免 PAT 被写进任何文件/历史），先手动登：
#   docker login ghcr.io -u <你的GitHub用户名>   # PAT 勾 write:packages + read:packages
#   docker login -u <你的DockerHub用户名>         # Docker Hub Access Token
# ═════════════════════════════════════════════════════════════════════════════

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

IMAGE="${1:-${IMAGE:-screenplay:latest}}"
VERSION="${2:-}"

GH_USER="${GH_USER:-wyunki462-stack}"
DOCKERHUB_USER="${DOCKERHUB_USER:-}"
RETRIES="${RETRIES:-5}"
SLEEP="${SLEEP:-5}"
SKIP_GHCR="${SKIP_GHCR:-0}"
DRY_RUN="${DRY_RUN:-0}"

say()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── 前置检查 ────────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "找不到 docker 命令"
docker info >/dev/null 2>&1 || die "无法访问 docker daemon（当前用户是否在 docker 组里？）"

if [ -z "$VERSION" ]; then
  VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$PROJECT_DIR/package.json" | head -1)"
  [ -n "$VERSION" ] || die "读不出 package.json 里的版本号，请显式传入：bash scripts/push-to-ghcr.sh <镜像> <版本>"
fi

# ── 目标仓库列表 ────────────────────────────────────────────────────────────
TARGETS=()
[ "$SKIP_GHCR" = "1" ] || TARGETS+=("ghcr.io/${GH_USER}/screenplay")
if [ -n "$DOCKERHUB_USER" ]; then
  TARGETS+=("${DOCKERHUB_USER}/screenplay")
elif [ "$SKIP_GHCR" = "1" ]; then
  die "SKIP_GHCR=1 但没给 DOCKERHUB_USER，没有可推的仓库"
fi

say "准备推送"
ok "镜像      : ${IMAGE}"
ok "版本      : ${VERSION}"
ok "目标仓库  : ${TARGETS[*]}"
ok "重试策略  : 每个标签最多 ${RETRIES} 次，间隔 ${SLEEP}s"

# ── 重试推送 ────────────────────────────────────────────────────────────────
push_once() {
  local ref="$1" i out rc
  for ((i = 1; i <= RETRIES; i++)); do
    if [ "$DRY_RUN" = "1" ]; then
      printf '  (dry-run) docker push %s\n' "$ref"
      return 0
    fi
    out="$(docker push "$ref" 2>&1)"; rc=$?
    if [ $rc -eq 0 ]; then
      ok "已推送 ${ref}（第 ${i} 次）"
      return 0
    fi
    warn "${ref} 第 ${i}/${RETRIES} 次失败：$(printf '%s\n' "$out" | tail -1)"
    if printf '%s' "$out" | grep -qiE "denied|unauthorized|authentication required"; then
      die "认证被拒 —— 先 docker login（GHCR 用 PAT 且需 write:packages 权限；
     Docker Hub 需要先在网页上建好 screenplay 仓库）"
    fi
    [ "$i" -lt "$RETRIES" ] && sleep "$SLEEP"
  done
  return 1
}

FAILED=()
for repo in "${TARGETS[@]}"; do
  say "→ ${repo}"
  if [ "$DRY_RUN" != "1" ]; then
    docker tag "$IMAGE" "${repo}:${VERSION}" || die "docker tag 失败：${repo}:${VERSION}"
  else
    printf '  (dry-run) docker tag %s %s:%s\n' "$IMAGE" "$repo" "$VERSION"
  fi
  # 先推版本标签：这样 latest 永远指向一个「已经确认推上去」的版本
  push_once "${repo}:${VERSION}" || { FAILED+=("${repo}:${VERSION}"); continue; }

  if [ "$DRY_RUN" != "1" ]; then
    docker tag "$IMAGE" "${repo}:latest" >/dev/null 2>&1 || true
  else
    printf '  (dry-run) docker tag %s %s:latest\n' "$IMAGE" "$repo"
  fi
  push_once "${repo}:latest" || FAILED+=("${repo}:latest")
done

# ── 汇总 ────────────────────────────────────────────────────────────────────
say "结果"
if [ ${#FAILED[@]} -eq 0 ]; then
  ok "全部标签推送成功"
  printf '  去 https://github.com/users/%s/packages 或 https://hub.docker.com/ 确认。\n' "$GH_USER"
  printf '  注意：GHCR 新包默认 private，要公开得在包设置里改。\n'
else
  warn "以下标签没推成功（已推上去的层不会白费，重跑本脚本即可接着传）："
  printf '    %s\n' "${FAILED[@]}"
  exit 1
fi
