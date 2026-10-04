/**
 * 成就抓取基准 —— 离线、可复现的 before/after 对比。
 *
 * 跑法：
 *   node backend/scripts/verify/steam-achievements-bench.mjs --mode=before --n=30 --delay=250 --ttl-check --assert-ttl
 *   node backend/scripts/verify/steam-achievements-bench.mjs --mode=after  --n=30 --delay=250 --ttl-check --assert-ttl
 *
 * 它做的事：
 *   1. 起两个 Steam 桩服实例（store 一个 origin、api 另一个 origin —— 必须分开，
 *      因为 HttpService 按 origin 分桶限流，合成一个 origin 会低估并发收益）；
 *   2. 直接往临时 SQLite 库里塞 N 行 games + game_links(provider='steam')，并给
 *      main_story_hours 预置非空值（跳过 backfillDuration，避免把 HLTB 的耗时混进来）；
 *   3. 起后端（桩服 + 假 key，AUTH_DISABLED=1），驱动批量刷新并轮询
 *      /api/games/refresh-all/status 直到结束；
 *   4. 输出机器可读行：
 *        # PARAMS …
 *        # BENCH  <mode> total_ms=… reqs=… api_reqs=… p50_ms=…
 *        # BENCH2 <mode> …（--ttl-check，第二轮 = 已有库再点一次「刷新全部」）
 *        # BENCH_TTL … （--assert-ttl，TTL 复用的回归断言）
 *
 * 两轮的口径是被**钉死**的，不依赖「跑的时候代码改到哪一步」：
 *   before = 改动前的语义：`POST /api/games/refresh-all?achievements=force`（每轮无
 *            条件重抓成就）+ Steam 间隔 1200ms（= 改动前的生产默认值）
 *   after  = 新语义：`POST /api/games/refresh-all`（默认按 15 天 TTL 复用）+
 *            Steam 专用间隔 350ms
 *
 * 关于间隔参数：HttpService 的**全局**间隔（CRAWLER_MIN_INTERVAL_MS）在两轮里都
 * 保持很低（默认 25ms），目的是把恒常启用、与本次改动无关的 HLTB / Metacritic 请求
 * 屏蔽掉；真正代表生产节奏的是 **Steam 专用间隔**（CRAWLER_MIN_INTERVAL_STEAM_MS）。
 * 其余环境完全一致，因此两轮差值只归因于本次优化。
 *
 * 另外：两轮用的都是**同一份构建**（after 的代码）。before 只是把节奏与 TTL 口径调
 * 回改动前，所以它衡量的是「同样的代码、去掉优化参数」——见产物里的口径说明。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path, { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TMP = path.join(ROOT, '.tmp-steam-bench');
const DATA = path.join(TMP, 'data');
const MEDIA = path.join(TMP, 'media');

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? '1'];
  }),
);
const num = (k, d) => (args.has(k) ? Number(args.get(k)) : d);

const MODE = args.get('mode') === 'after' ? 'after' : 'before';
const N = Math.min(50, Math.max(1, num('n', 30)));
const DELAY = num('delay', 250);
const DLC = Math.max(0, num('dlc', 0));
const PORT = num('port', 4522);
const STORE_PORT = num('store-port', 4610);
const API_PORT = num('api-port', 4611);
/** Steam-only cadence: production value before the change vs the new default. */
const STEAM_INTERVAL = num('steam-interval', MODE === 'before' ? 1200 : 350);
/** Mute non-Steam origins (they are unrelated to this change). */
const GLOBAL_INTERVAL = num('global-interval', 25);
const TTL_CHECK = args.has('ttl-check');
const DEBUG = args.has('debug');
const ASSERT_TTL = args.has('assert-ttl');
/**
 * Achievements cadence 口径 (pinned, not a side effect of when the code landed):
 *
 *   before = the pre-change semantics — every sweep force-refreshed achievements
 *            (`POST /api/games/refresh-all?achievements=force`) and the Steam
 *            origins were paced at the global 1200ms.
 *   after  = the new default — a bulk sweep reuses an achievements tier younger
 *            than its 15-day TTL, and Steam has its own 350ms pace.
 */
const ACH_MODE = MODE === 'before' ? 'force' : 'ttl';
const ACH_QUERY = ACH_MODE === 'force' ? '?achievements=force' : '';
/** Bump when steam-stub.mjs changes shape — recorded in the artifact. */
const STUB_VERSION = 'steam-stub-v1';
const RUN_AT = new Date().toISOString();

const BASE = `http://127.0.0.1:${PORT}`;
const STORE = `http://127.0.0.1:${STORE_PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;
/** Nothing listens here: HLTB/Metacritic fail instantly and cannot skew the run. */
const DEAD = 'http://127.0.0.1:9';

const children = [];
function killAll() {
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch { /* gone */ }
  }
}
process.on('exit', killAll);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, tries = 120) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  return false;
}

async function waitBulk(label = '') {
  const t = Date.now();
  for (let i = 0; i < 600; i += 1) {
    const s = await fetch(`${BASE}/api/games/refresh-all/status`).then((r) => r.json());
    if (DEBUG) console.log(`    [wait${label}] +${Date.now() - t}ms ${JSON.stringify(s)}`);
    // `done >= total` too: boot housekeeping can start its own backfill job (and
    // then clear the shared `running` flag) right as a sweep begins.
    if (!s.running && s.done >= s.total) return s;
    await sleep(100);
  }
  throw new Error('bulk refresh 未在预期时间内结束');
}

async function stats(base) {
  return fetch(`${base}/__stats`).then((r) => r.json());
}

function dbHandle() {
  return new DatabaseSync(path.join(DATA, 'screenplay.db'), { timeout: 5000 });
}

function seed(n) {
  const db = dbHandle();
  const now = Date.now();
  const game = db.prepare(
    `INSERT OR REPLACE INTO games
       (id, folder_name, folder_path, name, platform, main_story_hours,
        duration_seconds, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'PC', 10, 0, ?, ?)`,
  );
  const link = db.prepare(
    `INSERT OR REPLACE INTO game_links (game_id, provider, external_id) VALUES (?, 'steam', ?)`,
  );
  db.exec('BEGIN');
  try {
    for (let i = 0; i < n; i += 1) {
      const id = `bench-${String(i + 1).padStart(3, '0')}`;
      game.run(id, id, path.join(MEDIA, id), `Bench Game ${i + 1}`, now, now);
      link.run(id, String(5000 + i));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.close();
  }
}

function readCounts() {
  const db = dbHandle();
  try {
    const ach = db.prepare('SELECT COUNT(*) AS c FROM achievements').get().c;
    const ok = db.prepare(
      "SELECT COUNT(*) AS c FROM games WHERE achievements_status = 'ok'",
    ).get().c;
    const fresh = db.prepare(
      'SELECT COUNT(*) AS c FROM games WHERE last_achievements_refresh IS NOT NULL',
    ).get().c;
    return { achievements: Number(ach), statusOk: Number(ok), refreshed: Number(fresh) };
  } finally {
    db.close();
  }
}

function p50(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** Per-game Steam span: first request (store) → last request (api), same appid. */
function perGameSpans(storeStats, apiStats) {
  const spans = [];
  for (const [appid, s] of Object.entries(storeStats.timeline)) {
    const a = apiStats.timeline[appid];
    if (!a) continue;
    spans.push(Math.max(a.last, s.last) - Math.min(a.first, s.first));
  }
  return spans;
}

// ---------------------------------------------------------------------------
console.log(
  `# PARAMS mode=${MODE} n=${N} delay_ms=${DELAY} dlc=${DLC} steam_interval_ms=${STEAM_INTERVAL} ` +
    `global_interval_ms=${GLOBAL_INTERVAL} achievements=${ACH_MODE} stub=${STUB_VERSION} at=${RUN_AT}`,
);

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(MEDIA, { recursive: true });

const storeStub = spawn(
  process.execPath,
  [path.join(ROOT, 'backend/scripts/verify/steam-stub.mjs'), String(STORE_PORT), 'store', '0'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
const apiStub = spawn(
  process.execPath,
  [path.join(ROOT, 'backend/scripts/verify/steam-stub.mjs'), String(API_PORT), 'api', '0'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
children.push(storeStub, apiStub);
for (const [tag, child] of [['store', storeStub], ['api', apiStub]]) {
  child.stdout.on('data', (d) => process.stdout.write(`   [stub:${tag}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`   [stub:${tag}] ${d}`));
}

const runJs = path.join(TMP, 'run.js');
fs.writeFileSync(
  runJs,
  `const Module=require('module');const SHIM='${ROOT}/backend/scripts/verify/sqlite-shim.js';` +
    `const o=Module._resolveFilename;Module._resolveFilename=function(r,...a){return r==='better-sqlite3'?SHIM:o.call(this,r,...a);};` +
    `require('${ROOT}/backend/dist/main.js');\n`,
);

const app = spawn(process.execPath, [runJs], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    DATA_DIR: DATA,
    MEDIA_DIRS: MEDIA,
    WEB_DIST: path.join(ROOT, 'web/dist'),
    PORT: String(PORT),
    NODE_ENV: 'production',
    AUTH_DISABLED: '1',
    // Boot housekeeping also drives `backfillDurations()` — a bulk job that shares
    // `bulkProgress` with refresh-all and would overwrite this run's status (and
    // its completion-time retry passes). This is the repo's test convention.
    MAINTENANCE_ON_BOOT: '0',
    HOUSEKEEPING_INTERVAL_MS: '0',
    STEAM_API_KEY: 'stub-key',
    STEAM_STORE_BASE_URL: STORE,
    STEAM_API_BASE_URL: API,
    HLTB_BASE_URL: DEAD,
    METACRITIC_BASE_URL: DEAD,
    TROPHY_PSNINE_DISABLED: '1',
    RAWG_API_KEY: '',
    RAWG_PROXY: '',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    IMAGE_FETCH_ORDER: 'direct',
    STEAM_IMAGE_HOSTS: '',
    CRAWLER_MIN_INTERVAL_MS: String(GLOBAL_INTERVAL),
    CRAWLER_MIN_INTERVAL_STEAM_MS: String(STEAM_INTERVAL),
  },
});
children.push(app);
const logPath = path.join(TMP, 'log');
fs.writeFileSync(logPath, '');
app.stdout.on('data', (d) => fs.appendFileSync(logPath, d));
app.stderr.on('data', (d) => fs.appendFileSync(logPath, d));

if (!(await waitFor(`${BASE}/api/health`))) {
  console.error('后端未就绪，见', logPath);
  killAll();
  process.exit(1);
}
console.log(`  后端就绪：${BASE}`);

await fetch(`${STORE}/__config?delay=${DELAY}&dlc=${DLC}`).then((r) => r.json());
await fetch(`${API}/__config?delay=${DELAY}&dlc=${DLC}`).then((r) => r.json());

seed(N);
console.log(`  已写入 ${N} 个游戏（每个预置 main_story_hours=10，Steam 绑定 5000…${5000 + N - 1}）`);

async function sweep(label) {
  await fetch(`${STORE}/__reset`);
  await fetch(`${API}/__reset`);
  const t0 = Date.now();
  await fetch(`${BASE}/api/games/refresh-all${ACH_QUERY}`, { method: 'POST' }).then((r) => r.json());
  await waitBulk(label);
  const total = Date.now() - t0;
  const sStore = await stats(STORE);
  const sApi = await stats(API);
  const reqs =
    sStore.hits.storesearch + sStore.hits.appdetails + sApi.hits.schema + sApi.hits.percentages;
  const apiReqs = sApi.hits.schema + sApi.hits.percentages;
  const spans = perGameSpans(sStore, sApi);
  const out = {
    label,
    total_ms: total,
    reqs,
    api_reqs: apiReqs,
    p50_ms: p50(spans),
    store_reqs: sStore.hits.appdetails + sStore.hits.storesearch,
    games_measured: spans.length,
  };
  console.log(
    `  ${label}: total=${total}ms reqs=${reqs} (store=${out.store_reqs} api=${apiReqs}) ` +
      `p50=${out.p50_ms}ms games=${out.games_measured}`,
  );
  return out;
}

const first = await sweep('sweep1');
const counts = readCounts();
console.log(
  `  DB: achievements=${counts.achievements} 行, achievements_status='ok'=${counts.statusOk}, ` +
    `last_achievements_refresh 非空=${counts.refreshed}`,
);

console.log(
  `\n# BENCH ${MODE} total_ms=${first.total_ms} reqs=${first.reqs} api_reqs=${first.api_reqs} ` +
    `p50_ms=${first.p50_ms} n=${N} delay_ms=${DELAY} dlc=${DLC} ` +
    `steam_interval_ms=${STEAM_INTERVAL} achievements=${ACH_MODE} store_reqs=${first.store_reqs}`,
);

if (TTL_CHECK) {
  // 第二轮：库里已建立 15 天新鲜度。这段才是真实世界最常见的情形（用户对已有
  // 库点「刷新全部」）：before 会整轮重抓，after 应把 Steam 成就请求降到 ~0。
  const second = await sweep('sweep2');
  console.log(
    `\n# BENCH2 ${MODE} total_ms=${second.total_ms} reqs=${second.reqs} ` +
      `api_reqs=${second.api_reqs} p50_ms=${second.p50_ms} achievements=${ACH_MODE}`,
  );
}

if (ASSERT_TTL) {
  // TTL 复用的回归断言。前置条件：sweep1 已给每个游戏盖上新鲜的 ok。
  // 把一个游戏改成「新鲜但上次抓取失败」，它必须被重抓；而新鲜且 ok 的邻居必须
  // 被跳过。收紧后的判定要求 achievements_status ∈ {ok, empty}，因为失败同样会
  // 盖时间戳（见 metadata.service.ts 的 achievementsAreFresh + setAchievementStatus）。
  const failedId = 'bench-001'; // → appid 5000
  const okId = 'bench-002'; // → appid 5001
  {
    const db = dbHandle();
    db.prepare(
      `UPDATE games SET achievements_status = 'failed',
         achievements_error = 'stub: simulated previous failure',
         last_achievements_refresh = ?
       WHERE id = ?`,
    ).run(Date.now(), failedId);
    db.close();
  }
  await fetch(`${STORE}/__reset`);
  await fetch(`${API}/__reset`);
  const t0 = Date.now();
  await fetch(`${BASE}/api/games/refresh-all${ACH_QUERY}`, { method: 'POST' }).then((r) =>
    r.json(),
  );
  await waitBulk('ttl');
  const sApi = await stats(API);
  const repulled = Boolean(sApi.timeline['5000']);
  const skipped = !sApi.timeline['5001'];
  const apiReqs = sApi.hits.schema + sApi.hits.percentages;
  // Exactly one game was allowed to re-scrape: 5000's schema + percentages.
  const pass = repulled && skipped && apiReqs === 2;
  const state = readCounts();
  console.log(
    `\n# BENCH_TTL ${MODE} repulled_5000=${repulled} skipped_5001=${skipped} ` +
      `api_reqs=${apiReqs} total_ms=${Date.now() - t0} ok_rows=${state.statusOk} pass=${pass}`,
  );
  console.log(
    `# BENCH_TTL_DETAIL 期望：失败且新鲜 ⇒ 重抓；ok 且新鲜 ⇒ 跳过；全库只应有 1 个游戏重抓（2 个 api 请求）`,
  );
  if (!pass && MODE === 'after') process.exitCode = 1;
}

killAll();