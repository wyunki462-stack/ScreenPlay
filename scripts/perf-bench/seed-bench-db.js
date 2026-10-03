/**
 * 造一个用于列表接口基准的库：500 局游戏（每行带约 3KB 大 TEXT：summary/screenshots/
 * voice_actors/prices）+ 每局 3 条 media，共 1500 条。只为基准脚本服务，与产品数据无关。
 *
 *   node scripts/perf-bench/seed-bench-db.js            # 写到 $BENCH_DB 或 /tmp/screenplay-perf-bench/screenplay.db
 *
 * 想拿这库去跑真实后端（端点级验证）时，加 `BENCH_FOLDER_ROOT=<媒体根>`：每局写一条该根下的
 * 真实目录（并 mkdir 出来）。否则启动扫描会因为 folder_path 不存在而把 500 局全删掉
 * （backend/src/library/library.service.ts:382-386 "Removed missing game"）。
 *
 * 注：这是个最小 schema（没有 aliases/manual_override）。让真实后端启动扫描去扫它时，
 * scanGame 会在 `SELECT id, manual_override FROM games` 处报 "no such column" 并中断，
 * 种子行因此原样保留 —— 端点级验证（HTTP + SQL 计数）正需要这样，不去跑扫描。
 * 用仓库自带的 better-sqlite3 → node:sqlite shim（宿主没有原生编译产物）。
 */
const Module = require('module');
const path = require('path');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'better-sqlite3' ? require.resolve(path.resolve(__dirname, '..', '..', 'backend', 'scripts', 'verify', 'sqlite-shim.js')) : orig.call(this, r, ...a);
};
const DB = require('better-sqlite3');
const fs = require('fs');
const FILE = process.env.BENCH_DB || '/tmp/screenplay-perf-bench/screenplay.db';
fs.mkdirSync(path.dirname(FILE), { recursive: true });
fs.rmSync(FILE, { force: true });
const db = new DB(FILE);
db.exec(`
CREATE TABLE games (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, folder_path TEXT, platform TEXT, platforms TEXT,
  custom_platform TEXT, poster_url TEXT, poster_mode TEXT, ratings TEXT, summary TEXT,
  screenshots TEXT, voice_actors TEXT, prices TEXT, developers TEXT, publishers TEXT,
  release_date TEXT, duration_seconds INTEGER, first_played_at TEXT, last_played_at TEXT,
  meta_error TEXT, custom_order INTEGER, updated_at TEXT, created_at TEXT
);
CREATE TABLE media (id TEXT PRIMARY KEY, game_id TEXT, kind TEXT, file_path TEXT, created_at TEXT);
CREATE INDEX idx_media_game ON media(game_id);
`);
const big = (n, c) => c.repeat(n);
const FOLDER_ROOT = process.env.BENCH_FOLDER_ROOT || null;
const insG = db.prepare(`INSERT INTO games (id,name,folder_path,platform,platforms,custom_platform,poster_url,poster_mode,
  ratings,summary,screenshots,voice_actors,prices,developers,publishers,release_date,duration_seconds,
  first_played_at,last_played_at,meta_error,custom_order,updated_at,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insM = db.prepare('INSERT INTO media (id,game_id,kind,file_path,created_at) VALUES (?,?,?,?,?)');
db.exec('BEGIN');
for (let i = 0; i < 500; i++) {
  const id = `11111111-2222-3333-4444-${String(i).padStart(12, '0')}`;
  const folder = path.join(FOLDER_ROOT || '/media', `Game ${i}`);
  if (FOLDER_ROOT) fs.mkdirSync(folder, { recursive: true });
  insG.run(id, `Game ${i}`, folder, 'PC', '["PC"]', null, `https://media.rawg.io/x${i}.jpg`, 'single',
    JSON.stringify([{ source: 'metacritic', score: 70 + (i % 30), metascore: 60 + (i % 40) }]),
    big(2048, 's'),                                   // summary ~2KB
    JSON.stringify(Array.from({ length: 20 }, (_, k) => `https://x/${i}/${k}.jpg`)), // screenshots ~1KB
    big(512, 'v'),                                    // voice_actors
    JSON.stringify({ steam: '¥ 98' }),                // prices
    'Studio', 'Publisher', '2020-01-01', 3600 + i, `2026-01-0${(i % 9) + 1}T10:00:00Z`,
    `2026-02-0${(i % 9) + 1}T10:00:00Z`, null, i, '2026-03-01T00:00:00Z', '2026-03-01T00:00:00Z');
  for (let m = 0; m < 3; m++) insM.run(`99999999-8888-7777-6666-${String(i * 10 + m).padStart(12, '0')}`, id, 'screenshot', path.join(FOLDER_ROOT || '/media', `Game ${i}`, `s${m}.jpg`), '2026-03-01T00:00:00Z');
} 
db.exec('COMMIT');
console.log('games:', db.prepare('SELECT COUNT(*) c FROM games').get().c, 'media:', db.prepare('SELECT COUNT(*) c FROM media').get().c);
db.close();
