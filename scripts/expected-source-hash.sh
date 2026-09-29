#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# ScreenPlay — 源码指纹比对（在 build 阶段的末尾执行）
#
# 回答一个问题：**这个镜像里的源码，和仓库里提交的那份，是不是同一份？**
#
# 「镜像里还是旧代码」是最难查的一类问题：容器起得来、健康检查也过、页面也打得
# 开，只是少一个标签页。所以这里把构建期算出的指纹（/app/build-info.json）
# 和仓库里提交的期望值（.source-hash）都打出来，让「镜像里的到底是哪份源码」
# 变成一眼可见的事实，而不是需要靠猜。
#
# 不一致**不让构建失败**：指纹过期本身不是错误（例如源码改完忘了更新
# .source-hash），而构建中止会让用户拿不到镜像、更没法验证。
# .source-hash 不存在时也只提示，不失败（老 checkout 兼容）。
#
# 用法（由 Dockerfile 调用）：sh scripts/expected-source-hash.sh
# 退出码：恒为 0。
# ═════════════════════════════════════════════════════════════════════════════

set -u

BUILD_INFO="${BUILD_INFO:-/app/build-info.json}"
EXPECTED_FILE="${EXPECTED_FILE:-/tmp/expected.source-hash}"

actual=""
if [ -f "$BUILD_INFO" ]; then
  actual="$(sed -n 's/.*"sourceHash"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$BUILD_INFO" | head -1)"
fi

if [ -z "$actual" ]; then
  printf '\033[1;33m[WARN]\033[0m 读不到 %s 里的 sourceHash —— 无法给出指纹\n' "$BUILD_INFO"
  exit 0
fi

if [ ! -f "$EXPECTED_FILE" ]; then
  printf '\033[1;33m[WARN]\033[0m 仓库里没有 .source-hash —— 本次镜像指纹为 %s\n' "$actual"
  printf '   （该文件用于让部署脚本判断镜像是否过期；缺失不影响构建与运行。）\n'
  exit 0
fi

expected="$(tr -d '[:space:]' < "$EXPECTED_FILE")"

if [ "$expected" = "$actual" ]; then
  printf '\033[1;32m[ OK ]\033[0m 源码指纹与 .source-hash 一致：%s\n' "$actual"
else
  printf '\n\033[1;33m[WARN] 源码指纹与 .source-hash 不一致\033[0m\n'
  printf '  仓库期望：%s\n' "$expected"
  printf '  本次镜像：%s\n' "$actual"
  printf '  镜像仍会构建成功 —— 打进镜像的就是本次的实际源码。\n'
  printf '  若你在提交前改过 backend/src 或 web/src，请同步更新 .source-hash，\n'
  printf '  否则 scripts/docker-deploy.sh 会提示「镜像可能过期」。\n\n'
fi

# 恒成功：这个脚本的职责是「报告」，不是「把关」。把关由
# scripts/verify-build-artifacts.sh 负责（那一个缺符号就真的失败）。
exit 0