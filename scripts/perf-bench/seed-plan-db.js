/**
 * 给「索引 / 执行计划」证据造一份**每张表都有数据**的库。
 *
 * 为什么需要它：`scripts/perf-bench/query-plans.js` 要回答「现有索引是否覆盖热点
 * 查询」，而空表的执行计划没有说服力（SQLite 对空表的计划与有数据时可能不同）。
 * 本脚本把 `seed-soak-db.js` 生成的 1000 局 / 1500 媒体库**复制**一份，然后往
 * `game_posters` / `achievements` / `media_reviews` / `metadata_cache` /
 * `rating_targets` / `auth_sessions` 里填入该规模的合成行。
 *
 *   node scripts/perf-bench/seed-plan-db.js
 *   BENCH_DB=/tmp/perf-plans/screenplay.db node scripts/perf-bench/query-plans.js
 *
 * 源库用 `SOAK_DB`（默认 `/tmp/perf-soak/screenplay.db`），产物用 `PLAN_DB`
 * （默认 `/tmp/perf-plans/screenplay.db`）。**不改动源库**。
 */
const Module = require('module');
const fs = require('fs');
const path = require('path');

const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'better-sqlite3'
    ? require.resolve(path.resolve(__dirname, '..', '..', 'backend', 'scripts', 'verify', 'sqlite-shim.js'))
    : orig.call(this, r, ...a);
};
const DB = require('better-sqlite3');

const SRC = process.env.SOAK_DB || '/tmp/perf-soak/screenplay.db';
const DEST = process.env.PLAN_DB || '/tmp/perf-plans/screenplay.db';

if (!fs.existsSync(SRC)) {
  console.error(`找不到源库 ${SRC} —— 先跑 node scripts/perf-bench/seed-soak-db.js`);
  process.exit(2);
}
fs.rmSync(path.dirname(DEST), { recursive: true, force: true });
fs.mkdirSync(path.dirname(DEST), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  const from = `${SRC}${suffix}`;
  if (fs.existsSync(from)) fs.copyFileSync(from, `${DEST}${suffix}`);
}

const db = new DB(DEST);
const now = Date.now();
const day = 86_400_000;

const games = db.prepare('SELECT id FROM games ORDER BY name').all().map((r) => r.id);
if (games.length === 0) {
  console.error(`${DEST} 里没有 games —— 源库不对`);
  process.exit(2);
}

const clear = (t) => db.prepare(`DELETE FROM "${t}"`).run();
for (const t of ['game_posters', 'achievements', 'media_reviews', 'metadata_cache', 'rating_targets', 'auth_sessions']) {
  clear(t);
}

// 相册海报：每局 6 张，一半勾选 / 一半在轮播里，源里既有上传海报也有媒体截图。
const insPoster = db.prepare(`INSERT INTO game_posters
  (id, game_id, url, source, media_id, is_selected, in_slideshow, sort_order, created_at)
  VALUES (?,?,?,?,?,?,?,?,?)`);
// 成就：每局 3 个（tier 列由 migrations 的 addColumnIfMissing 加出来）。
const insAch = db.prepare(`INSERT INTO achievements
  (id, game_id, external_id, name, description, icon_url, global_percent, unlocked, tier)
  VALUES (?,?,?,?,?,?,?,?,?)`);
// 媒体评价：前 200 局各 20 条。
const insRev = db.prepare(`INSERT INTO media_reviews
  (id, game_id, source, outlet, score, verdict, review_text, url, author, platform, published_at, sort_order, fetched_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
// 元数据缓存：300 条，一半已过期（清理用的 `expires_at` 索引要能被用上）。
const insCache = db.prepare(`INSERT INTO metadata_cache (key, provider, payload, fetched_at, expires_at)
  VALUES (?,?,?,?,?)`);
const insTarget = db.prepare(`INSERT INTO rating_targets
  (game_id, source, external_id, name, platform, metascore, critic_count, release_date, created_at)
  VALUES (?,?,?,?,?,?,?,?,?)`);
const insSession = db.prepare(`INSERT INTO auth_sessions
  (token, username, provider, created_at, expires_at, last_seen, user_agent)
  VALUES (?,?,?,?,?,?,?)`);

const tiers = ['bronze', 'silver', 'gold', 'platinum'];
const outlets = ['IGN', 'GameSpot', 'Eurogamer', 'PC Gamer', 'Polygon'];

db.transaction(() => {
  for (const [gi, gid] of games.entries()) {
    for (let k = 0; k < 6; k += 1) {
      insPoster.run(`poster-${gid}-${k}`, gid, `/api/media/${gid}-m${k}/preview`,
        k % 3 === 0 ? 'upload' : 'scrape', `${gid}-m${k}`, k < 3 ? 1 : 0, k % 2, k, now - k * 1000);
    }
    for (let k = 0; k < 3; k += 1) {
      insAch.run(`ach-${gid}-${k}`, gid, `ext-${k}`, `成就 ${k}`, `描述 ${k}`,
        `https://cdn.example/${k}.png`, 12.5 + k, k === 0 ? 1 : 0, tiers[(gi + k) % tiers.length]);
    }
    if (gi < 200) {
      for (let k = 0; k < 20; k += 1) {
        insRev.run(`rev-${gid}-${k}`, gid, 'metacritic', outlets[k % outlets.length], 60 + (k % 40),
          'mixed', '评论正文 '.repeat(20), `https://example/${gid}/${k}`, `作者${k}`, 'PC',
          '2024-05-01', k, now - day);
      }
    }
    insTarget.run(gid, 'metacritic', `mc-${gid}`, `游戏 ${gi}`, 'PC', 70 + (gi % 25), 10 + (gi % 40), '2024-01-01', now);
  }
  for (let i = 0; i < 300; i += 1) {
    insCache.run(`cache-key-${i}`, `provider-${i % 4}`, '{"payload":"x"}', now - day, i < 150 ? now - day : now + day);
  }
  for (let i = 0; i < 5; i += 1) {
    insSession.run(`token-${i}`, 'admin', 'system', now, now + day, now, 'jest');
  }
})();

const counts = {};
for (const t of ['games', 'media', 'game_posters', 'achievements', 'media_reviews', 'metadata_cache', 'rating_targets', 'auth_sessions']) {
  counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
}
db.close();
console.log(`已生成 ${DEST}`);
for (const [t, c] of Object.entries(counts)) console.log(`  ${t}: ${c} 行`);