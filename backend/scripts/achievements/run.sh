#!/usr/bin/env bash
# 成就/奖杯的离线验证（不需要后端在跑）。
#   bash backend/scripts/achievements/run.sh
# 其中降级与重试两部分会真实联网访问 psnine；Steam 契约与重试用同构报文/本地桩服驱动真实 Provider。
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../../.. && pwd)"
ESB="$ROOT/node_modules/.bin/esbuild"

echo "== 构建被测模块（TS → CJS） =="
cat > .entry-contract.ts <<'TS'
export { SteamProvider } from '../../src/metadata/providers/steam.provider';
export { storeAchievements } from '../../src/trophies/achievement-store';
TS
cat > .entry-trophy.ts <<'TS'
export { TrophiesService, isPlayStation } from '../../src/trophies/trophies.service';
export { PsnineTrophySource } from '../../src/trophies/psnine.source';
export { HttpService } from '../../src/common/http/http.service';
export { parsePsnineHeaderCounts, parsePsnineGamePage } from '../../src/trophies/psnine.parse';
TS
"$ESB" .entry-contract.ts --bundle --format=cjs --platform=node --outfile=contract.cjs \
  --external:better-sqlite3 --define:process.env.NODE_ENV='"development"' >/dev/null
"$ESB" .entry-trophy.ts --bundle --format=cjs --platform=node --outfile=trophy.cjs \
  --external:better-sqlite3 --define:process.env.NODE_ENV='"development"' >/dev/null

echo
echo "== 1/3 Steam 成就契约测试 =="
node steam-contract.mjs || rc=$?
echo
echo "== 2/3 奖杯多源降级测试（真实联网 psnine） =="
node trophy-degrade.mjs || rc=$?
echo
echo "== 3/3 奖杯失败与重试测试（本地桩服，不依赖网络） =="
node trophy-retry.mjs || rc=$?
exit ${rc:-0}
