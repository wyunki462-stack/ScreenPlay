#!/usr/bin/env node
/**
 * 成就图标 URL 归一化（Steam 提供方守卫）+ 存量脏数据修复（启动期迁移）的离线验证。
 *
 * 背景：`SteamProvider.toAchievements()` 把 CDN 模板前缀硬拼在 schema 接口返回的
 * `icon` 上。该字段多数时候是裸文件名（`<hash>.jpg`），但对一部分 app 是**完整
 * URL**，而且仍指向已下线的 `steamcdn-a.akamaihd.net`。拼出来的值成了
 * `…/apps/812140/https://steamcdn-a.akamaihd.net/…/08bdee6f….jpg.jpg` —— 一个 URL
 * 套在另一个 URL 里，CDN 直接 502，这些游戏的成就图标在 Web 端与安卓端全黑。
 * 修复分两处：`common/image-url.ts` 只取文件名重建规范 URL（提供方走它），
 * `DatabaseService` 启动时把库里已有的坏值改回来。
 *
 * 做法（与 `poster-merge-unit.mjs` / `sqlite-vacuum.mjs` 同一套路）：
 *   1. 用 esbuild 把 `backend/src/common/image-url.ts` 的**真实源码**打成 CJS 再
 *      import，对归一化函数逐形状断言（裸名 / 路径 / 绝对 URL / 已嵌套 / 退役主机 /
 *      查询串 / PlayStation PNG / 空值）。
 *   2. 造一个只含 `achievements` 表的临时库（2 条嵌套 + 1 条退役主机 + 规范值 /
 *      PSN PNG / NULL 各 1 条），在子进程里用 sqlite-shim 构造编译产物里的
 *      `DatabaseService` 跑一次 `onModuleInit()`，断言只有坏值被改写、好值一行不动，
 *      再跑第二次证明幂等（不出修复日志、值不变），并检查 `integrity_check` = ok。
 *
 * 用法：npm run build && node backend/scripts/verify/achievement-icon-url.mjs
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const SRC = resolve(repoRoot, 'backend/src/common/image-url.ts');
const SERVICE = resolve(repoRoot, 'backend/dist/database/database.service.js');
const SHIM = resolve(repoRoot, 'backend/scripts/verify/sqlite-shim.js');

let pass = 0;
let fail = 0;
const ok = (m) => {
  pass += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${m}`);
};
const bad = (m, actual, expected) => {
  fail += 1;
  console.log(
    `  \x1b[31m✗\x1b[0m ${m}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`,
  );
};
const eq = (m, actual, expected) => {
  if (actual === expected) ok(`${m} → ${JSON.stringify(actual)}`);
  else bad(m, actual, expected);
};
const step = (m) => console.log(`\n\x1b[1m== ${m}\x1b[0m`);

const CANON = (appid, stem) =>
  `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${appid}/${stem}.jpg`;

// 取自真实库里的一行（生产 DB，appid 812140）。
const HASH = '08bdee6fbec196b65f29410ea6f010c867b59831';
const NESTED = `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/812140/https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/812140/${HASH}.jpg.jpg`;
const RETIRED = `https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/812140/${HASH}.jpg`;
const CANONICAL = CANON('812140', HASH);
const PSN =
  'https://psnobj.prod.dl.playstation.net/psnobj/NPWR52660_00/b97f0589-9e8c-4f2f-98bd-54132fb63c24.png';

// ---- 1. 纯函数：归一化 ------------------------------------------------------------------
console.log('\n\x1b[1m成就图标 URL 归一化验证\x1b[0m');

const tmp = mkdtempSync(join(tmpdir(), 'sp-icon-url-'));
const outfile = join(tmp, 'image-url.cjs');
try {
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [SRC],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
} catch (err) {
  console.error(`esbuild 打包 ${SRC} 失败：${err?.message ?? err}`);
  process.exit(2);
}
const mod = await import(outfile);
const { steamIconFileStem, steamAchievementIconUrl, normalizeSteamAchievementIconUrl, toProxiedImageUrl } = mod;

step('文件名提取（steamIconFileStem）');
eq('裸文件名', steamIconFileStem(`${HASH}.jpg`), HASH);
eq('无扩展名的裸名', steamIconFileStem(HASH), HASH);
eq('完整旧主机 URL', steamIconFileStem(RETIRED), HASH);
eq('已嵌套的坏值', steamIconFileStem(NESTED), HASH);
eq(
  '带查询串的 URL',
  steamIconFileStem(`https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/620/${HASH}.jpg?t=1699999999`),
  HASH,
);
eq('站点内相对路径', steamIconFileStem(`/steamcommunity/public/images/apps/620/${HASH}.jpg`), HASH);
eq('空值 → null', steamIconFileStem(''), null);
eq('只有扩展名 → null', steamIconFileStem('.jpg'), null);
eq('null → null', steamIconFileStem(null), null);

step('规范 URL 构造（steamAchievementIconUrl）');
eq('裸文件名', steamAchievementIconUrl('812140', `${HASH}.jpg`), CANONICAL);
eq('完整旧主机 URL', steamAchievementIconUrl('812140', RETIRED), CANONICAL);
eq('已嵌套的坏值（再执行一次也收敛到同一值）', steamAchievementIconUrl('812140', NESTED), CANONICAL);
eq('规范 URL 再走一遍不变', steamAchievementIconUrl('812140', CANONICAL), CANONICAL);
eq('没有 icon → null', steamAchievementIconUrl('812140', undefined), null);

step('存量值归一化（normalizeSteamAchievementIconUrl）');
eq('嵌套坏值 → 规范 URL', normalizeSteamAchievementIconUrl(NESTED), CANONICAL);
eq(
  '外套 appid 与内层不一致时用内层',
  normalizeSteamAchievementIconUrl(
    `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/999/https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/812140/${HASH}.jpg.jpg`,
  ),
  CANONICAL,
);
eq('退役主机单层 URL → 规范 URL', normalizeSteamAchievementIconUrl(RETIRED), CANONICAL);
eq('已经规范的值原样返回', normalizeSteamAchievementIconUrl(CANONICAL), CANONICAL);
eq('PlayStation PNG 原样返回', normalizeSteamAchievementIconUrl(PSN), PSN);
eq(
  '未知主机原样返回',
  normalizeSteamAchievementIconUrl('https://media.rawg.io/media/games/abc.jpg'),
  'https://media.rawg.io/media/games/abc.jpg',
);
eq('空值 → null', normalizeSteamAchievementIconUrl('   '), null);

step('与既有代理改写互不影响（toProxiedImageUrl）');
eq(
  '规范 URL 仍会被代理成本地地址',
  toProxiedImageUrl(CANONICAL),
  `/api/media/proxy?url=${encodeURIComponent(CANONICAL)}`,
);

// ---- 2. 启动期修复迁移 -----------------------------------------------------------------
step('启动期迁移：用编译产物 + sqlite-shim 跑真 DatabaseService');

if (!existsSync(SERVICE)) {
  console.error('找不到编译产物 backend/dist/database/database.service.js —— 先跑 cd backend && npm run build');
  process.exit(2);
}

const DATA_DIR = mkdtempSync(join(tmpdir(), 'sp-icon-db-'));
const DB_PATH = join(DATA_DIR, 'sp-icon.db');

/** 造库：只有坏值 / 好值各几条，其余列由 DatabaseService 的 addColumnIfMissing 补齐。 */
function seed() {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${DB_PATH}${suffix}`, { force: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`CREATE TABLE achievements (
    id TEXT PRIMARY KEY, game_id TEXT NOT NULL, external_id TEXT,
    name TEXT, description TEXT, icon_url TEXT, global_percent REAL,
    unlocked INTEGER NOT NULL DEFAULT 0, source TEXT)`);
  const ins = db.prepare(
    'INSERT INTO achievements (id, game_id, external_id, name, icon_url, unlocked, source) VALUES (?,?,?,?,?,0,?)',
  );
  ins.run('g1:steam:A', 'g1', 'A', '嵌套 1', NESTED, 'steam');
  ins.run(
    'g1:steam:B',
    'g1',
    'B',
    '嵌套 2（外层 appid 不同）',
    `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/999/https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/812140/${HASH}.jpg.jpg`,
    'steam',
  );
  ins.run('g2:steam:C', 'g2', 'C', '退役主机', RETIRED, 'steam');
  ins.run('g3:steam:D', 'g3', 'D', '本来就对', CANONICAL, 'steam');
  ins.run('g4:psnine:E', 'g4', 'E', 'PlayStation 图标', PSN, 'psnine');
  ins.run('g5:steam:F', 'g5', 'F', '没有图标', null, 'steam');
  db.close();
}

/** 子进程里构造编译产物里的 DatabaseService 并跑一次 onModuleInit()。 */
function boot() {
  const runJs = join(tmp, `run-icon-${Date.now()}.js`);
  writeFileSync(
    runJs,
    `const Module=require('module');const SHIM='${SHIM}';` +
      `const o=Module._resolveFilename;Module._resolveFilename=function(r,...a){return r==='better-sqlite3'?SHIM:o.call(this,r,...a);};` +
      `const { DatabaseService } = require('${SERVICE}');` +
      `const svc=new DatabaseService({ get:(k)=>k==='dataDir'?'${DATA_DIR}':'${basename(DB_PATH)}' });` +
      `svc.onModuleInit();` +
      `const raw=svc.raw;` +
      `const out={` +
      `integrity:raw.prepare('PRAGMA integrity_check').get().integrity_check,` +
      `nested:raw.prepare("SELECT COUNT(*) AS c FROM achievements WHERE icon_url LIKE '%/https://%' OR icon_url LIKE '%/http://%'").get().c,` +
      `rows:raw.prepare('SELECT id, icon_url FROM achievements ORDER BY id').all()};` +
      `console.log('ICON_RESULT '+JSON.stringify(out));\n`,
  );
  return new Promise((done) => {
    const child = spawn(process.execPath, [runJs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MAINTENANCE_ON_BOOT: '0' },
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { out += c.toString(); });
    child.on('close', (code) => {
      const m = /ICON_RESULT (\{.*\})/.exec(out);
      done({ code, out, result: m ? JSON.parse(m[1]) : null });
    });
  });
}

seed();
const first = await boot();
first.code === 0 ? ok('onModuleInit 正常返回（首次启动）') : bad('首次启动退出码', first.code, 0);
if (!first.result) bad('子进程没有输出测量结果', first.out.slice(-400), 'ICON_RESULT …');
else {
  const byId = Object.fromEntries(first.result.rows.map((r) => [r.id, r.icon_url]));
  eq('嵌套值被改成规范 URL', byId['g1:steam:A'], CANONICAL);
  eq('外层 appid 不同也按内层重建', byId['g1:steam:B'], CANONICAL);
  eq('退役主机值被改成规范 URL', byId['g2:steam:C'], CANONICAL);
  eq('本来就规范的值一行不动', byId['g3:steam:D'], CANONICAL);
  eq('PlayStation PNG 一行不动', byId['g4:psnine:E'], PSN);
  eq('NULL 仍为 NULL', byId['g5:steam:F'], null);
  eq('库里不再有 URL 套 URL 的值', first.result.nested, 0);
  eq('完整性检查通过', first.result.integrity, 'ok');
  /Repaired 3 Steam achievement icon URL\(s\)/.test(first.out)
    ? ok('日志给出修复条数（Repaired 3 …）')
    : bad('日志里没有修复行', first.out.slice(-300), /Repaired 3 …/);
}

const second = await boot();
second.code === 0 ? ok('onModuleInit 正常返回（第二次启动）') : bad('第二次启动退出码', second.code, 0);
if (second.result) {
  eq('第二次启动不再改动任何值', second.result.nested, 0);
  eq('第二次启动后表内容与首次一致', JSON.stringify(second.result.rows), JSON.stringify(first.result.rows));
}
/Repaired/.test(second.out)
  ? bad('第二次启动仍在修复（不幂等）', 'Repaired …', '无修复日志')
  : ok('第二次启动没有修复日志（幂等）');

rmSync(tmp, { recursive: true, force: true });

console.log(`\n\x1b[1m结果：${pass} 项通过 / ${fail} 项失败\x1b[0m`);
process.exit(fail);