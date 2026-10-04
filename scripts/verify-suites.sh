#!/usr/bin/env bash
# 离线全量回归：后端/前端类型检查 + 17 个离线套件 + 前端产物投递检查 + Dockerfile 分层自查
# （共 21 项；「项数」以本文件 run() 调用为准，别照抄注释里的数字）。
#
#   bash scripts/verify-suites.sh                    # 打到 stdout
#   bash scripts/verify-suites.sh docs/perf/suites-after.txt
#
# 只读：不碰 docker、不碰容器，全部在本机跑（套件自带 better-sqlite3 shim）。
# 退出码 = 失败项个数（0 = 全绿）。输出格式与 docs/perf/suites-before.txt 一致，
# 便于和优化前基线逐条比对。
set -u
cd "$(dirname "$0")/.." || exit 2
OUT="${1:-}"
if [ -n "$OUT" ]; then exec >"$OUT" 2>&1; fi

echo "# 离线全量回归 $(date '+%F %T')"
echo "# 退出码取 node/sh 自身状态（不用管道，避免被 tail 掩盖）"
pass=0
fail=0
failed_names=""
started=$(date +%s)

run() {
  local name="$1"
  shift
  echo
  echo "### $name"
  "$@"
  local code=$?
  echo
  echo "退出码=$code"
  if [ "$code" -eq 0 ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    failed_names="$failed_names $name"
  fi
}

run "typecheck-backend" npx tsc --noEmit -p backend/tsconfig.json
run "typecheck-web" npx tsc --noEmit -p web/tsconfig.json
for s in review-pagination-test metacritic-reviews-test metacritic-api-test metacritic-crawl-test \
  media-reviews-e2e duration-cache-e2e poster-rotation-e2e poster-ui-ssr \
  requirements-ui poster-merge-unit achievement-icon-url password-change sqlite-vacuum \
  media-delete-e2e android-auth-bearer auth-setup library-browse; do
  run "$s" node "backend/scripts/verify/$s.mjs"
done
run "verify-build-artifacts" env APP_DIR="$PWD" sh scripts/verify-build-artifacts.sh
run "verify-docker-layers" node scripts/verify-docker-layers.mjs

echo
echo "# 汇总：$(($(date +%s) - started))s，$pass 项通过 / $fail 项失败"
[ -n "$failed_names" ] && echo "# 失败项：$failed_names"
exit "$fail"