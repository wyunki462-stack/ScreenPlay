#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# ScreenPlay — 从 GitHub 拉取源码并构建镜像
#
# 配套文件：screenplay.yml（部署定义）、.env（配置，由 .env.deploy.example 复制）
#
# 为什么需要这个脚本： Docker Compose **不支持**「build 时自动 git clone」——
#   build.context 只能指向本地路径。所以「从 GitHub 拉」必须由这一步先把
#   源码 clone 下来，再用 clone 出来的目录当构建上下文。
#
#   clone 下来的仓库是**完整的构建上下文**：Dockerfile、package.json、
#   package-lock.json、backend/、web/、scripts/ 全在里面，所以不需要再从
#   别处同步任何文件。
#
# 用法：
#     bash fetch-and-build.sh
#
# 可用环境变量（都有合理默认值）：
#     GIT_REPO    仓库地址，默认官方仓库
#     GIT_BRANCH  分支，默认 main
#     SRC_DIR     源码目录，默认 ./screenplay-src（相对本脚本所在目录）
#     IMAGE_TAG   镜像名，默认 screenplay:latest（须与 screenplay.yml 一致）
#
# 退出码：0 = 成功；非 0 = 失败（每一步都会说明原因）
# ═════════════════════════════════════════════════════════════════════════════

set -euo pipefail

GIT_REPO="${GIT_REPO:-https://github.com/wyunki462-stack/ScreenPlay.git}"
GIT_BRANCH="${GIT_BRANCH:-main}"
IMAGE_TAG="${IMAGE_TAG:-screenplay:latest}"

# 脚本所在目录 —— 所有相对路径都基于它，这样从任何 cwd 调用都不会出错。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# ⚠️ 变量名**不能**叫 GIT_DIR —— 那是 git 自己保留的环境变量，git 会把它
# 当成「.git 元数据目录」本身（而不是工作树根目录），于是所有 git 命令都去找
# $GIT_DIR/HEAD，报出完全没有指向性的 `fatal: not a git repository`。
# 只要用户环境里恰好存在 GIT_DIR（git hooks、部分 CI、某些部署工具都会设），
# 脚本就会这样失败。这里用 SRC_DIR 避开。
SRC_DIR="${SRC_DIR:-$SCRIPT_DIR/screenplay-src}"

say()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── 前置检查 ────────────────────────────────────────────────────────────────
say "检查依赖"
command -v git  >/dev/null 2>&1 || die "找不到 git 命令。请先安装 git，或改用 docker save/load 方式传镜像。"
command -v docker >/dev/null 2>&1 || die "找不到 docker 命令。"
info "git    : $(git --version)"
info "docker : $(docker --version)"

if ! docker info >/dev/null 2>&1; then
  printf '\n\033[1;31m✗ 无法连接 Docker daemon。\033[0m\n' >&2
  if docker info 2>&1 | grep -q 'permission denied'; then
    printf '  当前用户不在 docker 组里。修法（执行一次，然后**重新登录**）：\n' >&2
    printf '    sudo usermod -aG docker %s\n' "$(id -un)" >&2
  else
    docker info 2>&1 | sed 's/^/  /' | head -5 >&2
  fi
  exit 2
fi
info "daemon : 连接正常"

# ── 拉取源码 ────────────────────────────────────────────────────────────────
say "从 GitHub 拉取源码"
info "仓库 : $GIT_REPO"
info "分支 : $GIT_BRANCH"
info "目录 : $SRC_DIR"

if [ -d "$SRC_DIR/.git" ]; then
  info "已存在，改为拉取最新提交（--depth 1 只取最新，省带宽）"
  git -C "$SRC_DIR" fetch --depth 1 origin "$GIT_BRANCH" \
    || die "git fetch 失败。常见原因：网络抖动（GitHub 的 TLS 连接不稳，重试即可）、或代理配置有误。"
  # 硬重置：本目录只用于构建，不该有你手改的内容；写进 .git 的都是仓库里的版本。
  git -C "$SRC_DIR" reset --hard FETCH_HEAD
  git -C "$SRC_DIR" clean -fd >/dev/null
else
  # 目录存在但不是 git 仓库（可能是空目录或误建）→ 先确认它确实是空的，避免误删用户数据
  if [ -e "$SRC_DIR" ]; then
    if [ -n "$(ls -A "$SRC_DIR" 2>/dev/null)" ]; then
      die "$SRC_DIR 已存在且非空，但它不是 git 仓库。请手工确认后移走，或设 SRC_DIR 指向别处。"
    fi
    rmdir "$SRC_DIR" 2>/dev/null || true
  fi
  git clone --depth 1 --branch "$GIT_BRANCH" "$GIT_REPO" "$SRC_DIR" \
    || die "git clone 失败。常见原因：网络抖动（GitHub 的 TLS 连接不稳，重试即可）、或无法访问 GitHub。"
fi

SRC_REV="$(git -C "$SRC_DIR" rev-parse --short HEAD)"
SRC_DATE="$(git -C "$SRC_DIR" log -1 --format=%cs)"
info "已就绪：$SRC_REV（$SRC_DATE）"

# ── 构建镜像 ────────────────────────────────────────────────────────────────
say "构建镜像（耗时较长：要装系统依赖 + npm 依赖 + 编译前后端）"
info "镜像名 : $IMAGE_TAG"
info "上下文 : $SRC_DIR"

# 用 clone 出来的仓库当上下文，-f 指向它自带的 Dockerfile。
docker build -t "$IMAGE_TAG" -f "$SRC_DIR/Dockerfile" "$SRC_DIR" \
  || die "docker build 失败。若报错里出现 npm error / error TS，多半是构建期网络问题：
   国内网络可加构建代理（注意**不能**填 127.0.0.1，那是容器自己）：
     SCREENPLAY_BUILD_PROXY=http://host.docker.internal:7890 bash fetch-and-build.sh
   目标设备上 host.docker.internal 由 screenplay.yml 的 extra_hosts 指向宿主机。"

say "完成"
info "源码版本 : $SRC_REV（$SRC_DATE）"
info "镜像     : $IMAGE_TAG"
printf '\n下一步：\n'
printf '  1) cp .env.deploy.example .env  并改 MEDIA_HOST_DIR\n'
printf '  2) docker compose -f screenplay.yml up -d --no-build\n'
printf '  3) docker compose -f screenplay.yml logs screenplay | grep -i admin   # 首次启动的 admin 密码\n'