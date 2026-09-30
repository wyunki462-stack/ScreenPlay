#!/usr/bin/env bash
# =============================================================================
# ScreenPlay — 判断「代码已生效」与「界面上看得出区别」之间的差距
#
# 用法：bash scripts/verify-ui-change.sh            # 查全部游戏，汇总
#       bash scripts/verify-ui-change.sh 血源诅咒     # 查名字含该串的游戏
#
# 背景：本轮修复部署成功后，用户反馈「和你改之前没啥区别」。三个原因叠在一起让
# 界面难以判断：
#
#   1) 浏览器缓存 —— 普通 F5 有时复用内存里的旧 JS（需 Ctrl+Shift+R）
#   2) **官方刮取海报仍默认进轮播**（293 张全在）。只按需求 21 收口了相册截图，
#      所以卡片依旧是「多帧轮播」，看起来和以前一样；
#   3) 详情页大图区只在「轮播模式」下自动切换。用户是「静态（单张）」，自然不动。
#
# 这个脚本把 2) 和 3) 变成可查的数字，从而把变量收敛到只剩浏览器缓存。
# =============================================================================
set -uo pipefail

CONTAINER="${CONTAINER:-screenplay}"
FILTER="${1:-}"
NODE_SCRIPT=/tmp/sp-ui-change-check.cjs

printf '\n\033[1mScreenPlay 修复可见性核对\033[0m\n'
if [ -n "$FILTER" ]; then
  printf '过滤条件: 名字含「%s」\n' "$FILTER"
else
  printf '范围: 全部游戏（汇总）\n'
fi

docker exec -i "$CONTAINER" sh -c "cat > $NODE_SCRIPT" <<'NODEEOF'
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const filter = process.argv[2] || '';
const db = new DatabaseSync(path.join(process.env.DATA_DIR || '/data', 'screenplay.db'));

const games = db.prepare(
  filter
    ? 'SELECT id,name,poster_mode FROM games WHERE name LIKE ? ORDER BY name'
    : 'SELECT id,name,poster_mode FROM games ORDER BY name',
).all(...(filter ? ['%' + filter + '%'] : []));

if (games.length === 0) {
  console.log('  没有匹配的游戏');
  db.close();
  process.exit(0);
}

const inSlide = db.prepare(
  "SELECT source, COUNT(*) c FROM game_posters WHERE game_id=? AND in_slideshow=1 GROUP BY source",
);
const total = db.prepare('SELECT COUNT(*) c FROM game_posters WHERE game_id=?');
const albumIn = db.prepare(
  "SELECT COUNT(*) c FROM game_posters WHERE game_id=? AND source='media' AND in_slideshow=1",
);
const albumTotal = db.prepare(
  "SELECT COUNT(*) c FROM game_posters WHERE game_id=? AND source='media'",
);

let modeSlideshow = 0;
let modeStatic = 0;
let albumStillIn = 0;

console.log('');
console.log('  游戏名'.padEnd(34) + '登记  轮播  其中官方  其中相册  相册总数  展现模式');
console.log('  ' + '-'.repeat(84));

for (const g of games) {
  const t = total.get(g.id).c;
  const bySrc = Object.fromEntries(inSlide.all(g.id).map((r) => [r.source, r.c]));
  const slide = (bySrc.scraped || 0) + (bySrc.media || 0) + (bySrc.upload || 0);
  const aIn = albumIn.get(g.id).c;
  const aTot = albumTotal.get(g.id).c;
  const mode = g.poster_mode === 'slideshow' ? '轮播' : '静态';
  if (mode === '轮播') modeSlideshow += 1; else modeStatic += 1;
  if (aIn > 0) albumStillIn += 1;
  console.log(
    '  ' + g.name.slice(0, 32).padEnd(34) +
    String(t).padEnd(6) + String(slide).padEnd(6) +
    String(bySrc.scraped || 0).padEnd(10) + String(aIn).padEnd(10) +
    String(aTot).padEnd(10) + mode,
  );
}

console.log('');
console.log('  汇总：');
console.log('    游戏数            : ' + games.length);
console.log('    展现模式=轮播     : ' + modeSlideshow + '   ← 这些游戏的详情页大图区会**自动切换**');
console.log('    展现模式=静态     : ' + modeStatic + '   ← 这些**不会自动切换**（设计如此，不是没修好）');
console.log('    相册截图仍在轮播里: ' + albumStillIn + '   ' + (albumStillIn === 0 ? '\x1b[32m← 本轮修复生效（一张都没有）\x1b[0m' : '\x1b[31m← 修复未生效\x1b[0m'));
db.close();
NODEEOF

docker exec "$CONTAINER" node "$NODE_SCRIPT" "$FILTER" 2>&1 | grep -v ExperimentalWarning | grep -v "trace-warnings" | sed 's/^/  /'
docker exec "$CONTAINER" rm -f "$NODE_SCRIPT" 2>/dev/null || true

printf '\n\033[1m怎么读这个结果\033[0m\n'
printf '  · 「其中相册」全部为 0 → 本轮修复在数据层已生效\n'
printf '  · 「其中官方」不为 0   → 正常。官方刮取海报按设计仍默认进轮播，\n'
printf '                            所以卡片依旧是轮播，看起来和以前一样 —— 这是有意保留的\n'
printf '  · 「展现模式=静态」的游戏，详情页大图区不会自动动。\n'
printf '    要验证自动轮播，请在该游戏详情页把展现模式切成「轮播（自动切换）」。\n'
printf '  · 界面上仍是旧行为 → 先强制刷新（Ctrl+Shift+R / Cmd+Shift+R）\n\n'