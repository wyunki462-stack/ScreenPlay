#!/usr/bin/env bash
# =============================================================================
# ScreenPlay — 媒体评价数据体检
#
# 用法：bash scripts/verify-media-reviews.sh            # 汇总
#       bash scripts/verify-media-reviews.sh 血源        # 只看名字含该串的
#
# 为什么需要它：界面上「只有一条媒体评价」有两种完全不同的成因，修法也不同：
#
#   A) 库里就只有 1 行 —— 数据层没抓到。旧代码只解析落地页、不翻 /critic-reviews/
#      分页，所以一部 65 家媒体的游戏只存下 1 条。这种情况下要点「重新抓取媒体评价」
#      才会写入全量；库里不会自己变多。
#   B) 库里有很多行、界面只显示几条 —— 渲染层的截断（本轮已改为分页：默认 5 条，
#      展开 10 条，每页最多 10 条）。
#
# 这个脚本只看数据库，所以能直接把 A 和 B 分开。
# =============================================================================
set -uo pipefail

CONTAINER="${CONTAINER:-screenplay}"
FILTER="${1:-}"
NODE_SCRIPT=/tmp/sp-reviews-check.cjs

printf '\n\033[1mScreenPlay 媒体评价数据体检\033[0m\n'

docker exec -i "$CONTAINER" sh -c "cat > $NODE_SCRIPT" <<'NODEEOF'
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const filter = process.argv[2] || '';
const db = new DatabaseSync(path.join(process.env.DATA_DIR || '/data', 'screenplay.db'));

const games = db.prepare(
  filter
    ? 'SELECT id,name,ratings FROM games WHERE name LIKE ? ORDER BY name'
    : 'SELECT id,name,ratings FROM games ORDER BY name',
).all(...(filter ? ['%' + filter + '%'] : []));

if (games.length === 0) {
  console.log('  没有匹配的游戏');
  db.close();
  process.exit(0);
}

const cnt = db.prepare('SELECT COUNT(*) c FROM media_reviews WHERE game_id=?');
const withScore = db.prepare(
  'SELECT COUNT(*) c FROM media_reviews WHERE game_id=? AND score IS NOT NULL',
);
const withText = db.prepare(
  "SELECT COUNT(*) c FROM media_reviews WHERE game_id=? AND review_text IS NOT NULL AND review_text <> ''",
);
const lastAt = db.prepare('SELECT MAX(fetched_at) m FROM media_reviews WHERE game_id=?');

let totalRows = 0;
let gamesWith = 0;
let gamesOne = 0;
const oneRow = [];

console.log('');
console.log('  游戏名'.padEnd(34) + '评价数  有打分  有正文  最近抓取');
console.log('  ' + '-'.repeat(78));

for (const g of games) {
  const n = cnt.get(g.id).c;
  totalRows += n;
  if (n > 0) gamesWith += 1;
  if (n === 1) { gamesOne += 1; oneRow.push(g.name); }
  const ts = lastAt.get(g.id).m;
  const when = ts ? new Date(ts).toLocaleString() : '—';
  // 只打印有评价的，否则几百个 0 会把输出淹掉
  if (n > 0) {
    console.log(
      '  ' + g.name.slice(0, 32).padEnd(34) +
      String(n).padEnd(8) + String(withScore.get(g.id).c).padEnd(8) +
      String(withText.get(g.id).c).padEnd(8) + when,
    );
  }
}

console.log('');
console.log('  汇总：');
console.log('    游戏总数            : ' + games.length);
console.log('    有媒体评价的游戏    : ' + gamesWith);
console.log('    评价行总数          : ' + totalRows);
console.log('    只有 1 条的游戏     : ' + gamesOne);
if (gamesOne > 0 && gamesOne <= 12) {
  console.log('      → ' + oneRow.slice(0, 12).join('、'));
}
console.log('');
if (totalRows <= gamesWith && gamesWith > 0) {
  console.log('  \x1b[33m判断：每个有评价的游戏都只有 1 条 → 属于 A（数据层没抓到）\x1b[0m');
  console.log('  \x1b[33m      在详情页点「重新抓取媒体评价」，用新代码重新抓全量。\x1b[0m');
} else if (totalRows > gamesWith) {
  console.log('  \x1b[32m判断：存在多条评价的游戏 → 属于 B，库里数据是够的\x1b[0m');
  console.log('  \x1b[32m      界面按默认 5 条 / 展开 10 条 / 每页 10 条分页显示。\x1b[0m');
}
db.close();
NODEEOF

docker exec "$CONTAINER" node "$NODE_SCRIPT" "$FILTER" 2>&1 | grep -v ExperimentalWarning | grep -v "trace-warnings" | sed 's/^/  /'
docker exec "$CONTAINER" rm -f "$NODE_SCRIPT" 2>/dev/null || true
printf '\n'