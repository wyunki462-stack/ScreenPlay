/**
 * 内存口径：同进程连续 200 次「列表请求」的 VmHWM（进程 RSS 峰值）与耗时，
 * 旧实现 / 新实现分进程各跑一次（避免互相污染 RCU/缓存）。
 *
 *   node --expose-gc scripts/perf-bench/bench-peak-memory.js old
 *   node --expose-gc scripts/perf-bench/bench-peak-memory.js new
 *
 * 同样跑在宿主 node:sqlite shim 上，只用于比较两种实现的相对差距。
 */
// 内存口径：同一个进程内连续 200 次「列表请求」的峰值 RSS / VmHWM，旧实现 vs 新实现分进程跑。
// 用法：node --expose-gc /tmp/perf-bench/bench2.js old   |   ... new
const Module = require('module');
const path = require('path');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'better-sqlite3' ? require.resolve(path.resolve(__dirname, '..', '..', 'backend', 'scripts', 'verify', 'sqlite-shim.js')) : orig.call(this, r, ...a);
};
const DB = require('better-sqlite3');
const fs = require('fs');
const MODE = process.argv[2] === 'old' ? 'old' : 'new';
const ROUNDS = 200;
const DBFILE = process.env.BENCH_DB || '/tmp/screenplay-perf-bench/screenplay.db';

const GALLERY_COLUMNS = ['id','name','folder_path','platform','platforms','custom_platform','poster_url','poster_mode',
  'ratings','developers','publishers','release_date','duration_seconds','first_played_at','last_played_at',
  'meta_error','custom_order'].join(', ');

const db = new DB(DBFILE, { readonly: true });
const selAll = db.prepare('SELECT * FROM games');
const selCols = db.prepare('SELECT ' + GALLERY_COLUMNS + ' FROM games');
const cntStmt = db.prepare('SELECT COUNT(*) AS c FROM media WHERE game_id = ?');
const summarize = (r, mediaCount) => ({ id: r.id, name: r.name, platform: r.platform, mediaCount, ratings: r.ratings });

const hwm = () => {
  const m = /VmHWM:\s+(\d+) kB/.exec(fs.readFileSync('/proc/self/status', 'utf8'));
  return m ? Number(m[1]) * 1024 : 0;
};
const mb = (b) => (b / 1048576).toFixed(1) + ' MiB';

if (global.gc) { global.gc(); global.gc(); }
const baseHwm = hwm();
const t0 = process.hrtime.bigint();
for (let i = 0; i < ROUNDS; i++) {
  if (MODE === 'old') {
    const rows = selAll.all();
    const out = rows.map((r) => summarize(r, cntStmt.get(r.id).c));
    if (out.length !== 500) process.exit(5);
  } else {
    const rows = selCols.all();
    const out = rows.map((r) => summarize(r, null));
    if (out.length !== 500) process.exit(5);
  }
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const peakHwm = hwm();
const mu = process.memoryUsage();
console.log(`[${MODE}] ${ROUNDS} 次列表：总耗时 ${ms.toFixed(0)} ms（${(ms / ROUNDS).toFixed(2)} ms/次）| VmHWM ${mb(peakHwm)}（起跑前 ${mb(baseHwm)}）| heapUsed ${mb(mu.heapUsed)} / rss ${mb(mu.rss)}`);
db.close();