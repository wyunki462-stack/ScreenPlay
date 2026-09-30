#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# ScreenPlay — 打一个可搬运的镜像包（给另一台机器手动拷过去用）
#
# 在 **NAS（能构建镜像的那台）** 上运行：
#
#     bash scripts/package-image.sh
#
# 它做四件事：
#   1) 构建镜像（复用 scripts/docker-build.sh，含代理探测与换源）
#   2) 校验镜像里确实有本轮功能（用 FEATURE 标记，不是靠构建成功就假定）
#   3) docker save | gzip 导出到 dist-image/
#   4) 生成一份「在目标机器上执行」的命令清单 + sha256 校验文件
#
# 和 transfer-image.sh 的区别：
#   transfer-image.sh 走 rsync 直接推到同局域网的另一台设备；
#   本脚本只**打包**，适合「拷到 Windows 电脑再用 Docker Desktop 推到仓库」这类
#   目标设备不在同一网络、或需要人工搬运的场景。
#
# 可选参数（环境变量）：
#   IMAGE=screenplay:latest        要打包的镜像
#   OUT_DIR=dist-image             输出目录
#   SKIP_BUILD=1                   不重新构建，直接打包已存在的镜像
#   GH_USER=wyunki462-stack        GHCR 命名空间
#   DOCKERHUB_USER=<用户名>         Docker Hub 命名空间（用于生成推送命令；可留空）
# ═════════════════════════════════════════════════════════════════════════════

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

IMAGE="${IMAGE:-screenplay:latest}"
OUT_DIR="${OUT_DIR:-dist-image}"
GH_USER="${GH_USER:-wyunki462-stack}"
DOCKERHUB_USER="${DOCKERHUB_USER:-}"

say()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "找不到 docker 命令"
docker info >/dev/null 2>&1 || die "无法访问 docker daemon。
    本脚本必须在**能跑 docker 的终端**里执行（NAS 上以 wyunki-nas 身份，
    该账号在 docker 组里）。如果你是在受限会话里运行，请换到你自己的 shell。"

VERSION="$(python3 -c "import json;print(json.load(open('package.json'))['version'])" 2>/dev/null || echo '0.0.0')"
# 取当前提交号用于文件名与说明书。
#
# 不能只写 `git rev-parse --short HEAD || echo nogit`：仓库属主与执行用户不同时，
# git 会以 "detected dubious ownership" 拒绝操作，而 `|| echo nogit` 会把这个失败
# **静默吞掉** —— 包名里出现 "nogit"，人却看不出是权限问题还是真没提交。
# 实测就是踩了这个：这个仓库的 .git 属主是另一个用户。
#
# 三级回退：显式声明 safe.directory → 环境已有配置 → 直接读 refs 文件。
_proj="$PROJECT_DIR"
SHORT_SHA="$(git -c safe.directory="$_proj" rev-parse --short HEAD 2>/dev/null \
  || git rev-parse --short HEAD 2>/dev/null \
  || head -c 7 ".git/refs/heads/main" 2>/dev/null \
  || true)"
if [ -z "$SHORT_SHA" ]; then
  warn "取不到当前提交号（既不能 git 操作，也读不到 .git/refs/heads/main）"
  warn "  包名里会用 unknown 代替。若这是权限问题，构建能继续，但没法追溯来源。"
  SHORT_SHA="unknown"
fi
STAMP="$(date +%Y%m%d-%H%M%S)"
BASENAME="screenplay-${VERSION}-${SHORT_SHA}"
TARBALL="${OUT_DIR}/${BASENAME}.tar.gz"

# ── 1. 构建 ──────────────────────────────────────────────────────────────────
if [ "${SKIP_BUILD:-0}" = "1" ]; then
  say "跳过构建（SKIP_BUILD=1）"
  docker image inspect "$IMAGE" >/dev/null 2>&1 \
    || die "本地没有镜像 $IMAGE，但还是要求跳过构建。先构建一次，或去掉 SKIP_BUILD。"
  ok "使用已存在的镜像 $IMAGE"
else
  say "构建镜像 $IMAGE"
  printf '   版本 %s · 提交 %s\n' "$VERSION" "$SHORT_SHA"
  printf '   构建日志会同时存到 logs/package-<时间戳>.log\n\n'
  mkdir -p logs 2>/dev/null || true
  BUILD_LOG="$PROJECT_DIR/logs/package-${STAMP}.log"
  # 日志目录可能不可写（比如在受限会话里跑、或 logs/ 属主不是当前用户）。
  # 此时仍要构建，只是日志落到 OUT_DIR；两者都不可写就直接不存日志。
  if ! { : > "$BUILD_LOG"; } 2>/dev/null; then
    mkdir -p "$OUT_DIR" 2>/dev/null || true
    BUILD_LOG="$PROJECT_DIR/$OUT_DIR/package-${STAMP}.log"
    { : > "$BUILD_LOG"; } 2>/dev/null || BUILD_LOG=""
  fi

  # 复用仓库既有的构建脚本：它负责代理探测、apk 换源、npm 源兜底等。
  #
  # 注意这里**不能**写成 `if ! bash ... | tee "$BUILD_LOG"; then`：
  # 管道的退出码会受 tee 影响 —— tee 写日志失败（权限/磁盘满）时整条管道判为失败，
  # 于是「构建其实成功了」被误报成「构建失败」。实测踩过一次：
  # logs/ 属主是另一个用户，tee 报 Permission denied，脚本随即宣称构建失败，
  # 而上面几行明明刚打印过"构建成功"。所以把两者的退出码分开取。
  # 先输出到临时文件，跑完再读回屏幕。这样：
  #   · 构建的退出码由普通命令单独取得，不受任何过滤器影响；
  #   · 不会出现「tee 还在异步写、脚本已经往下走」的竞态
  #     （进程替换 > >(tee ...) 就有这个竞态）。
  # 这个写法来自 scripts/build/apk-setup.sh —— 那边同样是在管道退出码上踩过坑之后
  # 改成"重定向 + 读回"的。
  BUILD_TMP="$(mktemp 2>/dev/null || echo "/tmp/sp-build-$$.log")"
  set +e
  bash scripts/docker-build.sh -t "$IMAGE" >"$BUILD_TMP" 2>&1
  BUILD_RC=$?
  set -e
  cat "$BUILD_TMP" 2>/dev/null || true
  rm -f "$BUILD_TMP" 2>/dev/null || true

  if [ "$BUILD_RC" != 0 ]; then
    die "构建失败（docker-build.sh 退出码 $BUILD_RC）。完整日志：${BUILD_LOG:-未记录}
    常见原因与对策见 README 的「构建排错」一节。"
  fi
  ok "构建完成${BUILD_LOG:+，日志：$BUILD_LOG}"
fi

# ── 2. 校验镜像里真的有本轮功能 ───────────────────────────────────────────────
#
# 「构建成功」不等于「镜像里有这轮改的东西」—— 构建缓存命中旧层时，构建照样成功，
# 但内容可能是旧的。所以这里按 FEATURE 标记实测，而不是假定。
say "校验镜像内容"

# 运行时镜像里的产物位置（与 Dockerfile 一致）：
#   web 产物 → /app/public        （COPY --from=build /app/web/dist /app/public）
#   backend 产物 → /app/backend/dist
#
# 注意这两组标记分别只存在于其中一侧，所以分开查：
#   · BACKEND_FEATURES 是 app.controller.ts 里的版本标记字符串，编译进
#     /app/backend/dist/app.controller.js；
#   · 前端标记是界面/文案符号，打包进 /app/public/assets/*.js。
# 一开始我把两者都往 /app/dist 里找，那是错的路径 —— 那样会永远报"缺少"。
BACKEND_FEATURES="card-carousel-no-dots album-frame-removable review-paged-ui boot-purge-logged"
# 本轮界面改动必须在产物里出现的关键符号
FRONTEND_FEATURES="media-reviews-expand media-reviews-page"

MISSING=""
container_has() {  # $1 = 要搜的字面串, $2 = 搜索目录
  docker run --rm --entrypoint sh "$IMAGE" \
    -c "grep -rlF '$1' $2 2>/dev/null | head -1" 2>/dev/null | grep -q .
}

for f in $BACKEND_FEATURES; do
  if container_has "$f" /app/backend/dist; then
    ok "后端标记 $f"
  else
    printf '\033[1;31m  ✗ 镜像缺少后端标记 %s\033[0m\n' "$f"
    MISSING="$MISSING $f"
  fi
done

for f in $FRONTEND_FEATURES; do
  if container_has "$f" /app/public; then
    ok "前端符号 $f"
  else
    printf '\033[1;31m  ✗ 镜像缺少前端符号 %s\033[0m\n' "$f"
    MISSING="$MISSING $f"
  fi
done

if [ -n "$MISSING" ]; then
  die "镜像里缺少这些本轮标记：$MISSING
    这通常意味着构建缓存命中了旧层。用 --no-cache 重建一次：
      bash scripts/docker-build.sh --no-cache -t $IMAGE
    不要把这样的包传出去 —— 装上去会发现界面没变化。"
fi

# 架构检查：目标机大多是 x86_64（Windows Docker Desktop 也是），
# 不匹配的话 docker load 之后根本起不来。
ARCH="$(docker image inspect "$IMAGE" --format '{{.Architecture}}' 2>/dev/null || echo '?')"
printf '   镜像架构: %s（目标机需一致）\n' "$ARCH"
[ "$ARCH" = "amd64" ] || warn "架构不是 amd64，拷到 Windows 上可能跑不起来"

# ── 3. 导出 ──────────────────────────────────────────────────────────────────
say "导出镜像 → $TARBALL"
mkdir -p "$OUT_DIR"
[ -e "$TARBALL" ] && die "目标文件已存在：$TARBALL
    换个 OUT_DIR，或先删掉它。"
docker save "$IMAGE" | gzip > "$TARBALL" \
  || die "导出失败（磁盘空间？）"
ok "导出完成：$(du -h "$TARBALL" | cut -f1)"

# ── 4. 校验和 + 命令清单 ─────────────────────────────────────────────────────
say "生成校验和与命令清单"
( cd "$OUT_DIR" && sha256sum "$(basename "$TARBALL")" > "$(basename "$TARBALL").sha256" )
ok "校验和：$(cat "${TARBALL}.sha256" | cut -c1-24)…"

GH_IMG="ghcr.io/${GH_USER}/screenplay"
if [ -n "$DOCKERHUB_USER" ]; then
  DH_IMG="${DOCKERHUB_USER}/screenplay"
else
  DH_IMG="<你的DockerHub用户名>/screenplay"
fi

NOTES="${OUT_DIR}/${BASENAME}-如何上传.txt"
cat > "$NOTES" <<NOTES_EOF
ScreenPlay 镜像包 —— ${VERSION}（提交 ${SHORT_SHA}）
导出时间：$(date '+%Y-%m-%d %H:%M:%S')
文件：$(basename "$TARBALL")   大小：$(du -h "$TARBALL" | cut -f1)

═══════════════════════════════════════════════════════════════════════════
在 Windows 电脑上（需已装 Docker Desktop 并已启动）
═══════════════════════════════════════════════════════════════════════════

0) 先校验文件完整（可选但推荐，防止拷贝过程损坏）

   PowerShell:
     Get-FileHash .\\$(basename "$TARBALL") -Algorithm SHA256

   结果应等于 .sha256 文件里的值。不一致就重新拷一次，不要继续。

1) 载入镜像

   docker load -i $(basename "$TARBALL")

   载入成功后应能看到：
     Loaded image: ${IMAGE}

2) 推到 GitHub 容器仓库（GHCR）

   先登录。凭据用 GitHub 的 Personal Access Token（PAT），
   **只要勾 write:packages 和 read:packages，不要勾 repo**：

     docker login ghcr.io -u ${GH_USER}
     （提示 Password 时粘贴 PAT）

   然后打标签并推送：

     docker tag ${IMAGE} ${GH_IMG}:latest
     docker tag ${IMAGE} ${GH_IMG}:${VERSION}
     docker push ${GH_IMG}:latest
     docker push ${GH_IMG}:${VERSION}

   推送完成后到 https://github.com/users/${GH_USER}/packages 确认。
   注意：新推的 package 默认是 private，要公开的话在包设置里改成 public。

   ── 如果推送中断 ──
   docker push 是**按层**传的，重复推同一镜像时已传完的层会跳过。
   所以直接重跑上面的 docker push 即可逐层推进，不要从头再来。
   （本仓库的 push-to-ghcr.sh 就是自动化这个重试的，在 Linux 上可以用；
     Windows 上手动重跑几次通常就够了。）

3) 推到 Docker Hub

   先在 https://hub.docker.com/settings/security 建一个 Access Token，
   然后：

     docker login -u <你的DockerHub用户名>
     docker tag ${IMAGE} ${DH_IMG}:latest
     docker tag ${IMAGE} ${DH_IMG}:${VERSION}
     docker push ${DH_IMG}:latest
     docker push ${DH_IMG}:${VERSION}

   Docker Hub 免费账号的镜像默认公开。仓库要在网页上先建好
   （名字填 screenplay），否则首次推送会报 denied。

═══════════════════════════════════════════════════════════════════════════
在目标机器上运行（不构建，直接用镜像）
═══════════════════════════════════════════════════════════════════════════

   cp .env.deploy.example .env      # 然后改 MEDIA_HOST_DIR（必填）
   docker compose -f docker-compose.deploy.yml up -d --no-build --force-recreate

   起来后自检：
     curl -s http://127.0.0.1:3001/api/health

   如果是从仓库直接拉（不用本 tar 包），把 compose 里的 image 换成
     ${GH_IMG}:${VERSION}
   或
     ${DH_IMG}:${VERSION}

═══════════════════════════════════════════════════════════════════════════
⚠️ 安全提醒
═══════════════════════════════════════════════════════════════════════════

  · PAT 和 Access Token 都不要写进任何脚本、也不要提交进 git。
  · 之前如果在聊天或公开地方粘贴过 token，请去设置里撤销后重新生成。
  · 本文件不含任何凭据，可以安全地跟 tar 包放在一起。
NOTES_EOF

ok "命令清单：$NOTES"

# ── 汇总 ─────────────────────────────────────────────────────────────────────
say "完成"
printf '  镜像    : %s\n' "$IMAGE"
printf '  包      : %s（%s）\n' "$TARBALL" "$(du -h "$TARBALL" | cut -f1)"
printf '  校验和  : %s\n' "${TARBALL}.sha256"
printf '  说明书  : %s\n' "$NOTES"
echo
printf '  下一步：把上面两个文件（%s 与 .sha256）拷到 Windows 电脑，\n' "$(basename "$TARBALL")"
printf '  然后照着说明书的第 1→2→3 步做。\n'
if [ -z "$DOCKERHUB_USER" ]; then
  echo
  warn "说明书里的 Docker Hub 部分用的是占位用户名。
    想让它直接写好，带上你的用户名重跑本脚本（不重新构建）：
      DOCKERHUB_USER=你的用户名 SKIP_BUILD=1 OUT_DIR=$OUT_DIR bash scripts/package-image.sh"
fi
echo