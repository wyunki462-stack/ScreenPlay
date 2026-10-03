/**
 * 量化「列表接口」两种实现的差别：旧版（`SELECT * FROM games` + 每行一次
 * `countByGame`）× 新版（17 列投影，仅 sort=mediaCount 时才 count）。
 * 口径：SQL 执行条数（在 shim 的 Statement.get/all/run 上计数）、读入行数、
 * 物化的字符串字节数、5 次中位耗时。先跑 seed-bench-db.js，再跑本脚本。
 *
 *   node scripts/perf-bench/bench-list-path.js
 *
 * 注意：跑在宿主 node:sqlite 驱动上（容器里是真 better-sqlite3），绝对值不代表容器，
 * 两组实现同口径，比值可信。
 */
// 量化对比：列表接口「旧实现（SELECT * + 每行 countByGame）」vs「新实现（17 列投影 + 按需 count）」
// 用仓库同一套 shim（node:sqlite 驱动）+ 同一份 500 局 / 1500 媒体的库，先于真实容器运行给出可引用数字。
const Module = require('module');
const path = require('path');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'better-sqlite3' ? require.resolve(path.resolve(__dirname, '..', '..', 'backend', 'scripts', 'verify', 'sqlite-shim.js')) : orig.call(this, r, ...a);
};
const DB = require('better-sqlite3');
const FILE = process.env.BENCH_DB || '/tmp/screenplay-perf-bench/screenplay.db';

// 与 backend/src/games/games.service.ts 的 GALLERY_COLUMNS 逐字一致
const GALLERY_COLUMNS = ['id','name','folder_path','platform','platforms','custom_platform','poster_url','poster_mode',
  'ratings','developers','publishers','release_date','duration_seconds','first_played_at','last_played_at',
  'meta_error','custom_order'].join(', ');

let execs = 0;
const counts = new Map();
const P = DB.prototype;
const origPrepare = P.prepare;
P.prepare = function (sql) {
  const st = origPrepare.call(this, sql);
  const key = String(sql).replace(/\s+/g, ' ').trim();
  for (const m of ['get', 'all', 'run']) {
    if (typeof st[m] === 'function') {
      const o = st[m].bind(st);
      st[m] = (...a) => { execs++; counts.set(key, (counts.get(key) || 0) + 1); return o(...a); };
    }
  }
  return st;
};

const db = new DB(FILE, { readonly: true });
const bytesOf = (rows) => rows.reduce((s, r) => s + Object.values(r).reduce((t, v) => t + (typeof v === 'string' ? Buffer.byteLength(v) : 0), 0), 0);
const summarize = (r, mediaCount) => ({
  id: r.id, name: r.name, platform: r.platform, folderPath: r.folder_path,
  durationSeconds: r.duration_seconds ?? null, mediaCount, ratings: r.ratings,
});

// —— 旧实现（HEAD 版）：SELECT * 全表 + 每行一次 COUNT ——
const selAll = db.prepare('SELECT * FROM games');
const cntStmt = db.prepare('SELECT COUNT(*) AS c FROM media WHERE game_id = ?');
function oldList(pageSize = 50) {
  const rows = selAll.all();
  const summaries = rows.map((r) => summarize(r, cntStmt.get(r.id).c));
  return { rowsRead: rows.length, bytesRead: bytesOf(rows), page: summaries.slice(0, pageSize).length };
}

// —— 新实现：17 列投影 + 仅在 sort=mediaCount 时才 count ——
const selCols = db.prepare('SELECT ' + GALLERY_COLUMNS + ' FROM games');
function newList(pageSize = 50, withMediaCount = false) {
  const rows = selCols.all();
  const summaries = rows.map((r) => summarize(r, withMediaCount ? cntStmt.get(r.id).c : null));
  return { rowsRead: rows.length, bytesRead: bytesOf(rows), page: summaries.slice(0, pageSize).length };
}

function measure(label, fn) {
  const times = [];
  let last = null;
  let q = 0;
  for (let i = 0; i < 5; i++) {
    execs = 0; counts.clear();
    const t = process.hrtime.bigint();
    last = fn();
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
    q = execs;
  }
  times.sort((a, b) => a - b);
  return { label, sql: q, medianMs: +times[2].toFixed(1), ...last };
}

const fmt = (n) => n.toLocaleString('en-US');
const out = [measure('旧 SELECT * + 每行 COUNT', () => oldList()),
             measure('新 17 列投影（默认排序）', () => newList()),
             measure('新 17 列投影（sort=mediaCount）', () => newList(50, true))];
for (const r of out) {
  console.log(`${r.label}: SQL 执行 ${fmt(r.sql)} 条 | 读入 ${fmt(r.rowsRead)} 行 | 物化 TEXT ${fmt(r.bytesRead)} B (${(r.bytesRead / 1048576).toFixed(2)} MiB) | 返回 ${r.page} 条 | 中位耗时 ${r.medianMs} ms`);
}
const [a, b] = out;
console.log(`\nSQL 条数 ${fmt(a.sql)} → ${fmt(b.sql)}（-${((1 - b.sql / a.sql) * 100).toFixed(1)}%）`);
console.log(`TEXT 物化 ${fmt(a.bytesRead)} → ${fmt(b.bytesRead)} B（-${((1 - b.bytesRead / a.bytesRead) * 100).toFixed(1)}%）`);
console.log(`中位耗时 ${a.medianMs} → ${b.medianMs} ms（-${((1 - b.medianMs / a.medianMs) * 100).toFixed(1)}%）`);
console.log('行数（games）：', db.prepare('SELECT COUNT(*) c FROM games').get().c, ' 媒体：', db.prepare('SELECT COUNT(*) c FROM media').get().c);
db.close();