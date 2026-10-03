/**
 * 「索引是否覆盖热点查询」的证据生成器（只读）。
 *
 * Step 3 交付里「SQLite 清理收缩与索引」需要一个可引用的证据：现有索引清单、
 * 各表行数、每条热点 SQL 的真实 `EXPLAIN QUERY PLAN`。本脚本只做三件事：
 *   1. 从 `sqlite_master` 读出所有索引（含 DDL 原文）；
 *   2. 数每个表的行数（判断「全表扫描」在这个规模上是否真的可接受）；
 *   3. 把产品代码里逐字复制过来的热点 SQL 交给 SQLite，打印它的执行计划。
 *
 *   node scripts/perf-bench/query-plans.js            # 输出到 stdout
 *   node scripts/perf-bench/query-plans.js > docs/perf/query-plans.txt
 *
 * 环境变量 `BENCH_DB` 指定库文件，默认 `/tmp/perf-soak/screenplay.db`
 * （由 `scripts/perf-bench/seed-soak-db.js` 生成：1000 局 / 1500 媒体的等效库）。
 * 库文件**以只读方式**打开，绝不写入。
 *
 * 宿主没有 better-sqlite3 的编译产物，所以和其余离线脚本一样走
 * `backend/scripts/verify/sqlite-shim.js`（node:sqlite 适配层）。计划文本是
 * SQLite 自己给的，与驱动无关。
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

const FILE = process.env.BENCH_DB || '/tmp/perf-soak/screenplay.db';
if (!fs.existsSync(FILE)) {
  console.error(`找不到基准库 ${FILE} —— 先跑 node scripts/perf-bench/seed-soak-db.js`);
  process.exit(2);
}

const db = new DB(FILE, { readonly: true, fileMustExist: true });

// 与 backend/src/games/games.service.ts 的 GALLERY_COLUMNS 逐字一致。
const GALLERY_COLUMNS = ['id', 'name', 'folder_path', 'platform', 'platforms', 'custom_platform', 'poster_url',
  'poster_mode', 'ratings', 'developers', 'publishers', 'release_date', 'duration_seconds', 'first_played_at',
  'last_played_at', 'meta_error', 'custom_order'].join(', ');

/** 产品代码里的热点 SQL（逐字复制；字面量参数用 'x'/'a','b','c' 代表）。 */
const QUERIES = [
  ['列表接口 · 一次取出全部候选行', `SELECT ${GALLERY_COLUMNS} FROM games`],
  ['详情接口 · 按 id 取一行', `SELECT * FROM games WHERE id = 'x'`],
  ['列表接口 · 出页海报行（批量 IN）', `SELECT game_id, id, url, source, media_id FROM game_posters
   WHERE (is_selected = 1 OR in_slideshow = 1) AND game_id IN ('a','b','c')
   ORDER BY game_id ASC, is_selected DESC, sort_order ASC, created_at ASC`],
  ['卡片海报 · 单局（CARD_POSTER_SQL）', `SELECT game_id, id, url, source, media_id FROM game_posters
   WHERE game_id = 'x' AND (is_selected = 1 OR in_slideshow = 1)
   ORDER BY is_selected DESC, sort_order ASC, created_at ASC`],
  ['列表接口 · 媒体计数（批量 IN）', `SELECT game_id, COUNT(*) AS c FROM media WHERE game_id IN ('a','b','c') GROUP BY game_id`],
  ['详情接口 · 媒体列表', `SELECT * FROM media WHERE game_id = 'x' ORDER BY sort_order ASC, file_created_at ASC`],
  ['详情接口 · 媒体计数', `SELECT COUNT(*) AS c FROM media WHERE game_id = 'x'`],
  ['媒体 · 按 id 取一行', `SELECT * FROM media WHERE id = 'x'`],
  ['评分目标 · 单局', `SELECT * FROM rating_targets WHERE game_id = 'x'`],
  ['评分目标 · 整表一次读（优化项）', `SELECT * FROM rating_targets`],
  ['元数据缓存 · 命中查询', `SELECT payload, fetched_at, expires_at FROM metadata_cache WHERE key = 'k'`],
  ['元数据缓存 · 过期清理（启动 / 周期回收）', `DELETE FROM metadata_cache WHERE expires_at < 1`],
  ['会话 · 每个鉴权请求一次 token 查询', `SELECT username, provider, expires_at FROM auth_sessions WHERE token = 't'`],
  ['会话 · 过期清理', `DELETE FROM auth_sessions WHERE expires_at <= 1`],
  ['成就 · 详情页取一局', `SELECT * FROM achievements WHERE game_id = 'x'`],
  ['成就 · 按 (game_id, tier)', `SELECT * FROM achievements WHERE game_id = 'x' AND tier = 'gold'`],
  ['媒体评价 · 按 game_id', `SELECT * FROM media_reviews WHERE game_id = 'x'`],
  ['维护 · 全库媒体 id 集合（孤儿件清扫用）', `SELECT id FROM media`],
  ['统计接口 · 聚合', `SELECT COUNT(*) AS c, COALESCE(SUM(size_bytes), 0) AS totalSize FROM media`],
];

const out = [];
const line = (s = '') => out.push(s);

line('# 热点查询执行计划与索引清单（只读采集）');
line();
line(`库文件：${FILE}（只读打开，未被修改）`);
line(`文件大小：${fs.statSync(FILE).size} B`);
line('数据来源：合成基准库 —— `scripts/perf-bench/seed-plan-db.js` 把 `seed-soak-db.js` 的');
line('1000 局 / 1500 媒体库复制一份，再给 `game_posters` / `achievements` / `media_reviews` /');
line('`metadata_cache` / `rating_targets` / `auth_sessions` 填入该规模的合成行（真实装机量与');
line('行数不同，但索引选择与行数无关，只与查询形状有关）。');
line(`生成时间：${new Date().toISOString()}（宿主 node ${process.version}）`);
line();
line('本文件回答一个问题：**现有的索引是否覆盖了产品代码里所有热点查询**。');
line('「SCAN」在 SQLite 的计划文本里表示全表扫描，「SEARCH」表示走了索引。');
line('全表扫描在 `games`（千行级）这类表上是合理的；要担心的是逐请求路径上的大表扫描。');
line();

line('## 1. 索引清单');
line();
const indexes = db.prepare(`SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' ORDER BY tbl_name, name`).all();
for (const ix of indexes) {
  line(`- ${ix.tbl_name}: \`${ix.name}\``);
  if (ix.sql) line(`  \`${String(ix.sql).replace(/\s+/g, ' ')}\``);
  else line('  （SQLite 自动创建：PK / UNIQUE 约束）');
}
line();

line('## 2. 各表行数');
line();
const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
line('| 表 | 行数 |');
line('| --- | --- |');
for (const t of tables) {
  const n = db.prepare(`SELECT COUNT(*) AS c FROM "${t.name}"`).get().c;
  line(`| \`${t.name}\` | ${n} |`);
}
line();

line('## 3. 逐条执行计划');
line();
for (const [label, sql] of QUERIES) {
  const flat = sql.replace(/\s+/g, ' ').trim();
  line(`### ${label}`);
  line();
  line('```sql');
  line(flat);
  line('```');
  let plan;
  try {
    plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
  } catch (err) {
    line(`（无法取计划：${err.message}）`);
    line();
    continue;
  }
  for (const row of plan) line(`- ${row.detail}`);
  const scanned = plan.filter((r) => /^SCAN/.test(r.detail)).map((r) => r.detail);
  line(`- 判定：${scanned.length === 0 ? '**走索引（无全表扫描）**' : `含全表扫描 → ${scanned.join('；')}`}`);
  line();
}

db.close();
process.stdout.write(`${out.join('\n')}\n`);