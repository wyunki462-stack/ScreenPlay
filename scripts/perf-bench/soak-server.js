/**
 * 真实后端（已编译的 backend/dist）+ 长跑/泄漏扫描用的观测桩。
 *
 *   node scripts/perf-bench/soak-server.js
 *
 * 与产品代码无关，只在进程外挂一层观测：
 *   - SIGUSR1 → 往 $SOAK_MEM_OUT（默认 /tmp/soak-mem.jsonl）追加一行内存/句柄快照
 *     （VmRSS 取自 /proc/self/status，堆数字取自 process.memoryUsage()，句柄数取自
 *     process.getActiveResourcesInfo()，sqlShapes = 累计出现过的不同 SQL 形状数）。
 *   - SIGUSR2 → 把「自上次 dump 以来」的 SQL 执行次数写 $SOAK_SQL_OUT（默认 /tmp/soak-sql.json），
 *     用来隔出单次请求的语句数。
 *
 * 因为宿主没有 better-sqlite3 原生编译产物，这里把 better-sqlite3 指到仓库自带的
 * node:sqlite shim（backend/scripts/verify/sqlite-shim.js）—— 测的是应用层的
 * 缓存/句柄/序列化开销，SQLite 驱动自身的内存行为不在口径内（报告里已注明）。
 *
 * 驱动脚本见 scripts/perf-bench/bench-soak.sh。
 */
const Module = require('module');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SHIM = path.join(ROOT, 'backend', 'scripts', 'verify', 'sqlite-shim.js');
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  return request === 'better-sqlite3' ? SHIM : orig.call(this, request, ...args);
};

const DB = require(SHIM);
const SQL_OUT = process.env.SOAK_SQL_OUT || '/tmp/soak-sql.json';
const MEM_OUT = process.env.SOAK_MEM_OUT || '/tmp/soak-mem.jsonl';

let execs = 0;
const counts = new Map();
const shapes = new Set();
const shape = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const P = DB.prototype;
const origPrepare = P.prepare;
P.prepare = function (sql) {
  const st = origPrepare.call(this, sql);
  const key = shape(sql);
  shapes.add(key);
  for (const m of ['get', 'all', 'run']) {
    if (typeof st[m] === 'function') {
      const o = st[m].bind(st);
      st[m] = (...a) => { execs++; counts.set(key, (counts.get(key) || 0) + 1); return o(...a); };
    }
  }
  return st;
};
if (typeof P.exec === 'function') {
  const oe = P.exec;
  P.exec = function (sql) {
    execs++;
    const key = 'EXEC ' + shape(sql);
    shapes.add(key);
    counts.set(key, (counts.get(key) || 0) + 1);
    return oe.call(this, sql);
  };
}

function vmrss() {
  try {
    const m = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync('/proc/self/status', 'utf8'));
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

process.on('SIGUSR1', () => {
  const mu = process.memoryUsage();
  const rss = vmrss();
  fs.appendFileSync(
    MEM_OUT,
    JSON.stringify({
      at: new Date().toISOString(),
      rssBytes: rss,
      rssMiB: rss === null ? null : +(rss / 1048576).toFixed(1),
      heapUsedMiB: +(mu.heapUsed / 1048576).toFixed(1),
      heapTotalMiB: +(mu.heapTotal / 1048576).toFixed(1),
      externalMiB: +(mu.external / 1048576).toFixed(1),
      arrayBuffersMiB: +(mu.arrayBuffers / 1048576).toFixed(1),
      handles: process.getActiveResourcesInfo().length,
      sqlShapes: shapes.size,
      sqlExecs: execs,
    }) + '\n',
  );
});

process.on('SIGUSR2', () => {
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  fs.writeFileSync(SQL_OUT, JSON.stringify({ total: execs, shapes: shapes.size, top: sorted.slice(0, 8) }, null, 1));
  execs = 0;
  counts.clear();
});

console.log('[soak] ready pid=' + process.pid + ' mem=' + MEM_OUT + ' sql=' + SQL_OUT);
require(path.join(ROOT, 'backend', 'dist', 'main.js'));