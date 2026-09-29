/**
 * 需求3「空时长禁止写缓存 + 重试」的真实端到端验证。
 *
 * 跑法：bash scripts/verify-duration-cache.sh（或直接 node 本文件）
 *
 * 它做的是单元测试做不到的事：
 *   1. 用桩服让时长源先返回 200 空结果，再让后端处理 —— 然后**直接读数据库**，
 *      确认 `metadata_cache` 里没有留下任何空的 hltb 记录；
 *   2. 把桩服切成正常，点一次补全接口，确认时长真的出现在接口与缓存里；
 *   3. 再把桩服切回空结果，确认**已经拿到的时长不会被清掉**（缓存里是有值的
 *      那份，不是后到的空值）；
 *   4. 桩服返回 403（token 失效语义）时，确认后端会换 token 重试而不是放弃。
 *
 * 单元测试只能证明 `isCacheableFragment()` 这个函数返回 false；这里证明的是
 * 「形成这个判断的那条链路真的把空值挡在缓存之外」。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path, { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TMP = path.join(ROOT, '.tmp-dc');
const DATA = path.join(TMP, 'data');
const MEDIA = path.join(TMP, 'media');
const PORT = Number(process.env.PORT || 4422);
const STUB_PORT = Number(process.env.STUB_PORT || 4599);
const BASE = `http://127.0.0.1:${PORT}`;
const STUB = `http://127.0.0.1:${STUB_PORT}`;
const GAME = '血源诅咒';

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`   \x1b[32m✓\x1b[0m ${m}`); pass += 1; };
const bad = (m) => { console.log(`   \x1b[31m✗\x1b[0m ${m}`); fail += 1; };
const info = (m) => console.log(`   ${m}`);
const step = (m) => console.log(`\n\x1b[1m== ${m}\x1b[0m`);
/** Comparisons must yield a real boolean, not a truthy value (1 === true is false). */
const truthy = (v) => v === true;

const children = [];
function killAll() {
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch { /* gone */ }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  return false;
}

const api = {
  async get(p) { return (await fetch(`${BASE}${p}`)).json(); },
  async post(p) { const r = await fetch(`${BASE}${p}`, { method: 'POST' }); return { status: r.status, body: await r.json().catch(() => null) }; },
};

async function setStubMode(mode) {
  await fetch(`${STUB}/__mode?set=${mode}`).then((r) => r.json());
}

async function stubStats() {
  return fetch(`${STUB}/__stats`).then((r) => r.json());
}

/** Read the cache table straight from the SQLite file (WAL-aware). */
function cacheRows() {
  const db = new DatabaseSync(path.join(DATA, 'screenplay.db'));
  try {
    return db
      .prepare("SELECT key, provider, payload FROM metadata_cache WHERE provider = 'hltb'")
      .all();
  } finally {
    db.close();
  }
}

function gameRow() {
  const db = new DatabaseSync(path.join(DATA, 'screenplay.db'));
  try {
    return db
      .prepare('SELECT id, name, main_story_hours, duration_source FROM games')
      .all();
  } finally {
    db.close();
  }
}

/** Wait for a bulk job to finish. */
async function waitBulk(label) {
  for (let i = 0; i < 90; i += 1) {
    const s = await api.get('/api/games/refresh-all/status');
    if (!s.running) return s;
    await sleep(1000);
  }
  throw new Error(`${label} 未在预期时间内结束`);
}

// ---------------------------------------------------------------------------
console.log('\x1b[1m准备隔离实例（桩服 + 独立 DATA_DIR）\x1b[0m');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(path.join(MEDIA, GAME), { recursive: true });

// 一张假截图就够了：这里验证的是时长，不是图片
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
fs.writeFileSync(path.join(MEDIA, GAME, 'shot_20260310192530.png'), png);

const stub = spawn(process.execPath, [path.join(ROOT, 'backend/scripts/verify/hltb-stub.mjs'), String(STUB_PORT), 'empty'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(stub);
stub.stdout.on('data', (d) => process.stdout.write(`   [stub] ${d}`));

const runJs = path.join(TMP, 'run.js');
fs.writeFileSync(
  runJs,
  `const Module=require('module');const SHIM='${ROOT}/backend/scripts/achievements/sqlite-shim.js';` +
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
    HLTB_BASE_URL: STUB,
    RAWG_API_KEY: '',
    RAWG_PROXY: '',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    IMAGE_FETCH_ORDER: 'direct',
    CRAWLER_MIN_INTERVAL_MS: '50',
  },
});
children.push(app);
fs.writeFileSync(path.join(TMP, 'log'), '');
app.stdout.on('data', (d) => fs.appendFileSync(path.join(TMP, 'log'), d));
app.stderr.on('data', (d) => fs.appendFileSync(path.join(TMP, 'log'), d));

process.on('exit', killAll);

if (!(await waitFor(`${BASE}/api/health`))) {
  console.error('后端未就绪，见', path.join(TMP, 'log'));
  killAll();
  process.exit(1);
}
ok('隔离实例已启动（时长源指向本地桩服）');

await api.post('/api/library/scan');
await sleep(3000);
const games = await api.get('/api/games?pageSize=50');
const game = games.find((g) => g.name.includes('血源')) ?? games[0];
info(`夹具游戏：${game.name}（${game.id}）`);

// ---------------------------------------------------------------------------
step('场景 A · 时长源返回 200 但 data 为空');
await setStubMode('empty');
const first = await api.get(`/api/games/${game.id}`);
info(`详情接口：mainStoryHours=${first.mainStoryHours} durationSource=${first.durationSource}`);
info(`页面会显示：${JSON.stringify(first.mainStoryHours == null ? '未知' : first.mainStoryHours)}`);
first.mainStoryHours == null ? ok('时长源无数据时，游戏确实没有时长（显示未知）') : bad('桩服空结果下不应有时长');

const rowsA = cacheRows();
const emptyCached = rowsA.filter((r) => {
  try {
    const p = JSON.parse(r.payload);
    return p && typeof p === 'object' && p.mainStoryHours == null && r.key.includes('fetch');
  } catch {
    return false;
  }
});
info(`metadata_cache 中 hltb 记录 ${rowsA.length} 条，其中 mainStoryHours 为空的 fetch 记录 ${emptyCached.length} 条`);
truthy(emptyCached.length === 0)
  ? ok('空时长结果没有被写入缓存（缓存缺陷已修复）')
  : bad(`空时长被写进了缓存：${emptyCached.map((r) => r.key).join(', ')}`);

// ---------------------------------------------------------------------------
step('场景 B · 时长源恢复后，重试/补全能拿到时长');
await setStubMode('ok');
const before = await api.get('/api/games/duration-coverage');
info(`补全前：missing=${before.missing} withDuration=${before.withDuration}/${before.total}`);

const backfill = await api.post('/api/games/backfill-durations');
info(`POST /api/games/backfill-durations → HTTP ${backfill.status} ${JSON.stringify(backfill.body)}`);
await waitBulk('时长补全');
const after = await api.get('/api/games/duration-coverage');
info(`补全后：missing=${after.missing} withDuration=${after.withDuration}/${after.total} sources=${JSON.stringify(after.sources)}`);
truthy(after.withDuration > before.withDuration)
  ? ok(`补全成功：${before.withDuration} → ${after.withDuration} 款有时长`)
  : bad('补全后仍未拿到时长');

const detailB = await api.get(`/api/games/${game.id}`);
info(`详情接口：mainStoryHours=${detailB.mainStoryHours} source=${detailB.durationSource}`);
detailB.mainStoryHours != null ? ok(`拿到时长 ${detailB.mainStoryHours} 小时（来源 ${detailB.durationSource}）`) : bad('仍然没有时长');

const rowsB = cacheRows().filter((r) => r.key.includes('fetch'));
const goodCached = rowsB.filter((r) => {
  try { return JSON.parse(r.payload)?.mainStoryHours != null; } catch { return false; }
});
info(`缓存中 hltb fetch 记录 ${rowsB.length} 条，其中有值的 ${goodCached.length} 条`);
goodCached.length > 0 ? ok('成功结果被写入缓存（下次直接复用）') : bad('成功结果没有进缓存');

// ---------------------------------------------------------------------------
step('场景 C · 时长源再次变空，已有时长不得被清空');
await setStubMode('empty');
await api.post('/api/games/backfill-durations');
await waitBulk('二次补全');
const detailC = await api.get(`/api/games/${game.id}`);
info(`再次补全后：mainStoryHours=${detailC.mainStoryHours} source=${detailC.durationSource}`);
detailC.mainStoryHours != null
  ? ok('已有时长没有被空结果清空（稳定显示，不会变回未知）')
  : bad('已有时长被清空');

const rowsC = cacheRows().filter((r) => r.key.includes('fetch'));
const stillGood = rowsC.filter((r) => {
  try { return JSON.parse(r.payload)?.mainStoryHours != null; } catch { return false; }
});
stillGood.length > 0 ? ok('缓存里保留的仍是有值的记录') : bad('缓存被空结果覆盖');

// ---------------------------------------------------------------------------
step('场景 D · HTTP 403（token 失效）触发换 token 重试');
await setStubMode('forbid');
const statsBefore = await stubStats();
const forbidCall = await api.post(`/api/games/${game.id}/refresh`);
info(`强制刷新：HTTP ${forbidCall.status}`);
await sleep(8000);
const statsAfter = await stubStats();
const initDelta = (statsAfter.hits.init ?? 0) - (statsBefore.hits.init ?? 0);
const searchDelta = (statsAfter.hits.search ?? 0) - (statsBefore.hits.search ?? 0);
info(`403 期间请求：token 端点 +${initDelta}，搜索端点 +${searchDelta}`);
truthy(initDelta > 0 && searchDelta > 0)
  ? ok('403 后会重新取 token 并重试搜索（不是一次失败就放弃）')
  : bad('403 后没有重试');

const detailD = await api.get(`/api/games/${game.id}`);
info(`403 之后：mainStoryHours=${detailD.mainStoryHours}`);
detailD.mainStoryHours != null ? ok('上游失败期间已有时长保持不变') : bad('上游失败导致时长丢失');
!detailD.metaError ? ok('时长源失败没有把整条刮削标记为失败（时长是尽力而为的数据源）') : info(`metaError=${detailD.metaError}`);

// ---------------------------------------------------------------------------
step('场景 E · 页面确实把时长渲染出来（真实浏览器）');
const { chromium } = await import('playwright');
const browser = await chromium.launch({
  executablePath: path.join(ROOT, '.tmp-b/pw/chromium-1134/chrome-linux/chrome'),
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
await setStubMode('ok');
await page.goto(`${BASE}/game/${game.id}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('h1', { timeout: 30000 });
await page.waitForTimeout(2500);
const rendered = await page.locator('div:has(> div:text-is("平均通关时长"))').last().innerText().catch(() => '');
info(`页面渲染：${JSON.stringify(rendered)}`);
/主线\s*[\d.]+\s*小时/.test(rendered) ? ok('页面展示「主线 X 小时」') : bad('页面没有展示主线时长');
const shots = path.join(TMP, 'shots');
fs.mkdirSync(shots, { recursive: true });
await page.screenshot({ path: path.join(shots, 'duration-cache.png'), fullPage: false });
ok(`截图已保存：${path.join(shots, 'duration-cache.png')}`);
await browser.close();

// ---------------------------------------------------------------------------
killAll();
console.log(`\n\x1b[1m结果：${pass} 项通过 / ${fail} 项失败\x1b[0m`);
if (fail === 0) {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('现场已清理。');
} else {
  console.log(`现场保留：${TMP}（日志 ${path.join(TMP, 'log')}）`);
}
process.exit(fail === 0 ? 0 : 1);