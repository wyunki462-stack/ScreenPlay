/**
 * 可选启动期 `VACUUM`（优化项 15：`MAINTENANCE_VACUUM=1`）的离线验证。
 *
 * 跑法：node backend/scripts/verify/sqlite-vacuum.mjs
 *      （或经 `bash scripts/verify-suites.sh` 全量跑）
 *
 * 它验证的是「产品代码里那条开关」而不是 SQLite 本身：
 *   1. **不设** `MAINTENANCE_VACUUM` 时，对一个人为造膨胀的库跑一遍
 *      `DatabaseService.onModuleInit()`：文件**不会**被收缩，日志里也没有 `VACUUM` 行
 *      —— 默认路径与优化前一致（零行为变化）。
 *   2. 设 `MAINTENANCE_VACUUM=1` 时，同一个库被收缩到只剩真实数据、日志出现
 *      `VACUUM finished in … — database … → … (reclaimed …)` 行，并且
 *      `PRAGMA integrity_check` = ok、业务行数一个不少（收缩没有动数据）。
 *
 * 走真 `backend/dist`（better-sqlite3 用 sqlite-shim 替换，本机没有原生产物），
 * 不联网、不起 HTTP、不碰 docker。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path, { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TMP = path.join(ROOT, '.tmp-vacuum');
const SHIM = path.join(ROOT, 'backend/scripts/verify/sqlite-shim.js');
const SERVICE = path.join(ROOT, 'backend/dist/database/database.service.js');
const BLOAT_ROWS = 40_000;
const KEEP_ROWS = 3;

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`   \x1b[32m✓\x1b[0m ${m}`); pass += 1; };
const bad = (m) => { console.log(`   \x1b[31m✗\x1b[0m ${m}`); fail += 1; };
const info = (m) => console.log(`   ${m}`);
const step = (m) => console.log(`\n\x1b[1m== ${m}\x1b[0m`);
const fmt = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;

/** 造一个「表里只剩几行、文件却很大」的库：一堆行写进去再删掉，空闲页留在文件里。 */
function seedBloated(file) {
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE keep(id INTEGER PRIMARY KEY, v TEXT)');
  db.exec('CREATE TABLE bloat(id INTEGER PRIMARY KEY, blob TEXT)');
  db.exec('BEGIN');
  const keep = db.prepare('INSERT INTO keep(v) VALUES (?)');
  for (let i = 0; i < KEEP_ROWS; i += 1) keep.run(`保留行 ${i}`);
  const ins = db.prepare('INSERT INTO bloat(blob) VALUES (?)');
  for (let i = 0; i < BLOAT_ROWS; i += 1) ins.run('x'.repeat(300));
  db.exec('COMMIT');
  db.exec('DELETE FROM bloat');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  return fs.statSync(file).size;
}

/**
 * 在子进程里构造编译产物里的 DatabaseService 并跑一次 onModuleInit()。
 * 必须开子进程：shim 补丁要在 require 之前生效，且每次都要一个干净的模块注册表。
 */
function bootService(dbFile, vacuumFlag) {
  const runJs = path.join(TMP, 'run-vacuum.js');
  fs.writeFileSync(
    runJs,
    `const Module=require('module');const SHIM='${SHIM}';` +
      `const o=Module._resolveFilename;Module._resolveFilename=function(r,...a){return r==='better-sqlite3'?SHIM:o.call(this,r,...a);};` +
      `const fs=require('fs');` +
      `const { DatabaseService } = require('${SERVICE}');` +
      `const svc=new DatabaseService({ get:(k)=>k==='dataDir'?'${TMP}':'${path.basename(dbFile)}' });` +
      `svc.onModuleInit();` +
      `const raw=svc.raw;` +
      `const out={size:fs.statSync('${dbFile}').size,` +
      `integrity:raw.prepare('PRAGMA integrity_check').get().integrity_check,` +
      `keep:raw.prepare('SELECT COUNT(*) AS c FROM keep').get().c};` +
      `console.log('VAC_RESULT '+JSON.stringify(out));\n`,
  );
  const env = { ...process.env, MAINTENANCE_ON_BOOT: '0' };
  delete env.MAINTENANCE_VACUUM;
  if (vacuumFlag) env.MAINTENANCE_VACUUM = '1';
  return new Promise((done) => {
    const child = spawn(process.execPath, [runJs], { stdio: ['ignore', 'pipe', 'pipe'], env });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk) => { out += chunk.toString(); });
    child.on('close', (code) => {
      const match = /VAC_RESULT (\{.*\})/.exec(out);
      done({ code, out, result: match ? JSON.parse(match[1]) : null });
    });
  });
}

// ---------------------------------------------------------------------------
console.log('\n\x1b[1m可选启动期 VACUUM（MAINTENANCE_VACUUM）验证\x1b[0m');
console.log('\n准备隔离现场');

if (!fs.existsSync(SERVICE)) {
  console.error(`找不到编译产物 ${SERVICE} —— 先跑 cd backend && npm run build`);
  process.exit(2);
}
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const dbOff = path.join(TMP, 'vacuum-off.db');
const dbOn = path.join(TMP, 'vacuum-on.db');
const bloatedOff = seedBloated(dbOff);
const bloatedOn = seedBloated(dbOn);
info(`膨胀库（${KEEP_ROWS} 行业务数据 + ${BLOAT_ROWS} 行写入后删除）：${fmt(bloatedOff)}`);

step('场景 A · 不设 MAINTENANCE_VACUUM（默认路径）');
const a = await bootService(dbOff, false);
a.code === 0 ? ok('onModuleInit 正常返回') : bad(`onModuleInit 退出码 ${a.code}`);
a.result ? ok(`能读到库（keep=${a.result.keep} 行）`) : bad('子进程没有输出测量结果');
/VACUUM finished in/.test(a.out)
  ? bad('默认路径居然执行了 VACUUM')
  : ok('默认路径没有出现任何 VACUUM 日志');
if (a.result) {
  a.result.size >= bloatedOff
    ? ok(`默认路径没有收缩文件（${fmt(bloatedOff)} → ${fmt(a.result.size)}，未归还空闲页属预期）`)
    : bad(`默认路径文件反而变小了：${bloatedOff} → ${a.result.size}`);
  a.result.keep === KEEP_ROWS
    ? ok(`业务行数不变（keep=${KEEP_ROWS}）`)
    : bad(`业务行数被改动：${a.result.keep} ≠ ${KEEP_ROWS}`);
}

step('场景 B · MAINTENANCE_VACUUM=1（显式开启）');
const b = await bootService(dbOn, true);
b.code === 0 ? ok('onModuleInit 正常返回（VACUUM 失败也不会让启动失败）') : bad(`onModuleInit 退出码 ${b.code}`);
/VACUUM finished in/.test(b.out)
  ? ok('日志出现 `VACUUM finished in …`')
  : bad('日志里没有 VACUUM 行');
/reclaimed [\d.]+ (B|KB|MB)/.test(b.out)
  ? ok('日志给出了回收量（reclaimed …）')
  : bad('日志没有给出回收量');
/MAINTENANCE_VACUUM|VACUUM skipped/i.test(b.out) && /\bVACUUM skipped/.test(b.out)
  ? bad('VACUUM 报错被跳过（本场景不应失败）')
  : ok('没有出现 `VACUUM skipped`（收缩真的成功了）');
if (b.result) {
  b.result.size < bloatedOn * 0.6
    ? ok(`文件被收缩：${fmt(bloatedOn)} → ${fmt(b.result.size)}（−${(100 - (b.result.size / bloatedOn) * 100).toFixed(1)}%）`)
    : bad(`文件没有明显收缩：${bloatedOn} → ${b.result.size}`);
  b.result.integrity === 'ok'
    ? ok('integrity_check = ok')
    : bad(`integrity_check = ${b.result.integrity}`);
  b.result.keep === KEEP_ROWS
    ? ok(`收缩后业务行数一个不少（keep=${KEEP_ROWS}）`)
    : bad(`收缩后业务行数不对：${b.result.keep} ≠ ${KEEP_ROWS}`);
}

// ---------------------------------------------------------------------------
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n\x1b[1m结果：${pass} 项通过 / ${fail} 项失败\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);