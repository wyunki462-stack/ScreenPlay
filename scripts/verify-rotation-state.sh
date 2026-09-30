#!/usr/bin/env bash
# =============================================================================
# ScreenPlay — 验证本轮修复是否真的落到运行中的实例上
#
# 用法：bash scripts/verify-rotation-state.sh
#
# 回答三个问题：
#   1) 启动期清理有没有执行、摘掉了多少张旧规则自动加入轮播的相册截图
#   2) 库里还有多少张相册截图「在轮播里但用户从没决定过」（期望 0）
#   3) 摘要海报集是否等于登记总数（即首页卡片不再受轮播勾选影响）
#
# 为什么需要单独一个脚本：这几个结论都要在容器里查数据库，而库在 named volume
# 里，宿主机上拿不到。这里直接 docker exec 进容器用 node:sqlite 查。
# =============================================================================
set -uo pipefail

CONTAINER="${CONTAINER:-screenplay}"
NODE_SCRIPT=/tmp/sp-rotation-check.cjs

printf '\n\033[1mScreenPlay 轮播状态体检\033[0m\n'

printf '\n\033[1m== 1. 启动期修复日志 ==\033[0m\n'
LOGS="$(docker compose logs "$CONTAINER" 2>/dev/null | grep -E 'MaintenanceService' | tail -4)"
if [ -n "$LOGS" ]; then
  printf '%s\n' "$LOGS" | sed 's/^/  /'
else
  printf '  \033[33m!\033[0m 没抓到 MaintenanceService 日志（MAINTENANCE_ON_BOOT=0？或日志被轮转）\n'
fi

# 把查询脚本送进容器再执行 —— 避免在宿主机上处理一大堆嵌套引号。
docker exec -i "$CONTAINER" sh -c "cat > $NODE_SCRIPT" <<'NODEEOF'
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const dir = process.env.DATA_DIR || '/data';
const db = new DatabaseSync(path.join(dir, 'screenplay.db'));
const one = (sql) => db.prepare(sql).get().c;

const line = (label, value) => console.log('  ' + label + value);

console.log('  --- 海报行 ---');
line('总行数                ', one('SELECT COUNT(*) c FROM game_posters'));
line('source=scraped        ', one("SELECT COUNT(*) c FROM game_posters WHERE source='scraped'"));
line('source=media          ', one("SELECT COUNT(*) c FROM game_posters WHERE source='media'"));

console.log('  --- 轮播归属 ---');
line('in_slideshow=1 合计   ', one('SELECT COUNT(*) c FROM game_posters WHERE in_slideshow=1'));
line('  其中 scraped        ', one("SELECT COUNT(*) c FROM game_posters WHERE in_slideshow=1 AND source='scraped'"));
line('  其中 media          ', one("SELECT COUNT(*) c FROM game_posters WHERE in_slideshow=1 AND source='media'"));

console.log('  --- 本轮要消灭的状态 ---');
const bad = one("SELECT COUNT(*) c FROM game_posters WHERE source='media' AND in_slideshow=1 AND slideshow_user_set=0");
if (bad === 0) {
  console.log('  相册截图在轮播里但用户从没决定过: 0   \x1b[32m✓ 已清理干净\x1b[0m');
} else {
  console.log('  相册截图在轮播里但用户从没决定过: ' + bad + '   \x1b[31m✗ 仍在（清理未生效）\x1b[0m');
}
line('用户亲自取消过的(media)', one("SELECT COUNT(*) c FROM game_posters WHERE source='media' AND in_slideshow=0 AND slideshow_user_set=1"));

console.log('  --- 前 3 个游戏的登记数 vs 轮播数 ---');
for (const g of db.prepare('SELECT id,name FROM games LIMIT 3').all()) {
  const t = db.prepare('SELECT COUNT(*) c FROM game_posters WHERE game_id=?').get(g.id).c;
  const s = db.prepare('SELECT COUNT(*) c FROM game_posters WHERE game_id=? AND in_slideshow=1').get(g.id).c;
  console.log('  ' + g.name.slice(0, 26).padEnd(28) + ' 登记=' + t + '  轮播中=' + s);
}
db.close();
NODEEOF

printf '\n\033[1m== 2. 库内轮播状态 ==\033[0m\n'
docker exec "$CONTAINER" node "$NODE_SCRIPT" 2>&1 | sed 's/^/  /'

printf '\n\033[1m== 3. 本轮 feature 标记 ==\033[0m\n'
if command -v curl >/dev/null 2>&1; then
  PORT="${PORT:-3001}"
  curl -s -m 10 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);f=d.get("features",[]);exp=["poster-rotation-cover-only","poster-rotation-user-decided","card-carousel-vs-hero-carousel","review-pagination"];[print("  "+("OK" if e in f else "缺失")+" "+e) for e in exp];print("  全部齐全:", all(e in f for e in exp))' 2>/dev/null \
    || printf '  读不到 health（需要登录？）\n'
else
  printf '  没有 curl，跳过\n'
fi

docker exec "$CONTAINER" rm -f "$NODE_SCRIPT" 2>/dev/null || true

printf '\n\033[1m完成。\033[0m把上面全部输出贴回来即可。\n\n'