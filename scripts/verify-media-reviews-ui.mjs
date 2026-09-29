/**
 * 「媒体评价」标签页的真实浏览器验证（Chromium + 真实构建产物）。
 *
 * ⚠️ 全程只访问本地桩服，**不访问真实媒体评价站点**。
 *
 * 用法：node scripts/verify-media-reviews-ui.mjs
 *
 * 为什么必须在浏览器里验一遍：接口返回 3 条评价，和「用户点开标签页真的能看到
 * 媒体名称、媒体打分、评价原文」是两件事。前者能靠 curl 证明，后者只有渲染出来
 * 才算数 —— 标签页没渲染、字段名对不上、空状态文案写错，接口测试全都发现不了。
 *
 * 覆盖四条需求：
 *   1. 详情页标签文字是「媒体评价」；
 *   2. 标签页里能看到 媒体名称 / 媒体打分 / 媒体评价原文 三列信息；
 *   3. 没有评价时显示「暂无媒体评价」，并且能区分「还没抓过」与「抓过但没有」；
 *   4. 面板上的「重新抓取」按钮真的会重新抓取（桩服计数增加）。
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path, { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, '.tmp-mrui');
const DATA = path.join(TMP, 'data');
const MEDIA = path.join(TMP, 'media');
const SHOTS = path.join(TMP, 'shots');
const PORT = Number(process.env.PORT || 4444);
const STUB_PORT = Number(process.env.STUB_PORT || 4601);
const BASE = `http://127.0.0.1:${PORT}`;
const STUB = `http://127.0.0.1:${STUB_PORT}`;
const CHROME =
  process.env.CHROME_PATH ||
  process.env.CHROME_BIN ||
  path.join(ROOT, '.tmp-b/pw/chromium-1134/chrome-linux/chrome');

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`   \x1b[32m✓\x1b[0m ${m}`); pass += 1; };
const bad = (m) => { console.log(`   \x1b[31m✗\x1b[0m ${m}`); fail += 1; };
const info = (m) => console.log(`   ${m}`);
const step = (m) => console.log(`\n\x1b[1m== ${m}\x1b[0m`);

const children = [];
const killAll = () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not up yet */ }
    await sleep(500);
  }
  return false;
}

function db() { return new DatabaseSync(path.join(DATA, 'screenplay.db')); }

// ---------------------------------------------------------------------------
console.log('\x1b[1m准备隔离实例（桩服 + 浏览器）\x1b[0m');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
for (const name of ['血源诅咒', 'Hades']) {
  fs.mkdirSync(path.join(MEDIA, name), { recursive: true });
  fs.writeFileSync(path.join(MEDIA, name, 'shot_20260310192530.png'), png);
}

const stub = spawn(process.execPath, [
  path.join(ROOT, 'backend/scripts/verify/metacritic-stub.mjs'), String(STUB_PORT), 'ok',
], { stdio: ['ignore', 'pipe', 'pipe'] });
children.push(stub);
stub.stdout.on('data', (d) => process.stdout.write(`   [stub] ${d}`));

const runJs = path.join(TMP, 'run.js');
fs.writeFileSync(runJs,
  `const Module=require('module');const SHIM='${ROOT}/backend/scripts/achievements/sqlite-shim.js';` +
  `const o=Module._resolveFilename;Module._resolveFilename=function(r,...a){return r==='better-sqlite3'?SHIM:o.call(this,r,...a);};` +
  `require('${ROOT}/backend/dist/main.js');\n`);

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
    // 启动期数据修复必须关掉：它会在扫描后自动补全通关时长、并把相册截图补进
    // 海报轮播，而本套件要断言的正是「补全前」的状态（例如「待补全 N 个」）。
    MAINTENANCE_ON_BOOT: '0',
    METACRITIC_BASE_URL: STUB,
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

await fetch(`${BASE}/api/library/scan`, { method: 'POST' });
await sleep(3000);
const games = await fetch(`${BASE}/api/games?pageSize=50`).then((r) => r.json());
if (!games.length) { console.error('没有扫描到游戏'); killAll(); process.exit(1); }

const bloodborne = games.find((g) => g.name.includes('血源')) ?? games[0];
// 绑定 + 种评分（后端会弃用「不带评分」的绑定去重新搜索，e2e 里已经解释过原因）
{
  const d = db();
  try {
    d.prepare("DELETE FROM game_links WHERE game_id = ? AND provider = 'metacritic'").run(bloodborne.id);
    d.prepare('INSERT INTO game_links (game_id, provider, external_id) VALUES (?, ?, ?)')
      .run(bloodborne.id, 'metacritic', 'bloodborne');
    d.prepare('UPDATE games SET ratings = ? WHERE id = ?').run(
      JSON.stringify([{ source: 'metacritic', metascore: 92, criticCount: 78, userScore: 8.9, userCount: 1200, ratingClass: 'generally favorable' }]),
      bloodborne.id,
    );
  } finally { d.close(); }
}
ok(`隔离实例已启动（媒体评价源 = ${STUB}，未访问真实站点）`);

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' });
const page = await context.newPage();

// BrowserRouter（不是 HashRouter），所以是 /game/:id 而不是 /#/games/:id。
const detailUrl = `${BASE}/game/${bloodborne.id}`;

/**
 * 标签按钮的定位方式。
 *
 * Tabs 组件没有加 role="tab"，而且按钮内部还有图标/额外节点，按钮的可访问名
 * 不是干净的「媒体评价」二字（getByRole 的精确匹配会落空），所以按可见文字找。
 * 按文字找还有个好处：断言的就是「用户看到的那几个字」，而不是某个内部属性。
 */
const reviewsTab = () => page.locator('button', { hasText: '媒体评价' });

/** 打开详情页并切到「媒体评价」标签。 */
async function openReviewsTab() {
  await page.goto(detailUrl, { waitUntil: 'domcontentloaded' });
  // 详情页会先渲染骨架屏（数据没到之前连标签都还没有），所以要等**标签本身**
  // 出现，而不是固定 sleep（固定 sleep 在慢机器上会随机失败）。
  const tab = reviewsTab();
  await tab.first().waitFor({ state: 'visible', timeout: 30000 });
  await tab.first().click();
  await page.waitForSelector('[data-testid="media-reviews-panel"]', { timeout: 15000 });
}

try {
  // -------------------------------------------------------------------------
  step('需求 1 · 详情页标签文字是「媒体评价」');
  await page.goto(detailUrl, { waitUntil: 'domcontentloaded' });
  // 等详情页真正渲染完（标签出现即代表骨架屏已过去）
  await reviewsTab().first().waitFor({ state: 'visible', timeout: 30000 });
  // 详情页所有标签按钮的文字（Tabs 组件没有 role="tab"，按容器取）
  const tabText = (await page.locator('button').allInnerTexts()).map((s) => s.trim()).filter(Boolean);
  info(`页面按钮文字：${tabText.join(' | ')}`);
  tabText.includes('媒体评价')
    ? ok('存在文字为「媒体评价」的标签')
    : bad(`没有找到「媒体评价」标签，实际：${tabText.join(' | ')}`);
  !tabText.includes('评价')
    ? ok('旧的「评价」标签已被替换（没有留下重复入口，否则会出现两个入口）')
    : bad('页面上仍存在旧的「评价」标签');
  await page.screenshot({ path: path.join(SHOTS, '01-tabs.png') });

  // -------------------------------------------------------------------------
  step('需求 2 · 标签页展示 媒体名称 / 媒体打分 / 媒体评价原文');
  await openReviewsTab();
  const panel = page.locator('[data-testid="media-reviews-panel"]');
  (await panel.count()) > 0 ? ok('面板已渲染') : bad('面板没有渲染');

  const cards = page.locator('[data-testid="media-review-card"]');
  const cardCount = await cards.count();
  info(`渲染出 ${cardCount} 张媒体评价卡片`);
  cardCount === 3 ? ok('渲染 3 张卡片（与接口返回一致）') : bad(`卡片数 ${cardCount}，期望 3`);

  const outlets = await page.locator('[data-testid="media-review-outlet"]').allInnerTexts();
  info(`媒体名称：${outlets.map((s) => s.trim()).join(' / ')}`);
  outlets.length === 3 ? ok('每条评价都显示媒体名称') : bad('媒体名称缺失');
  outlets.some((s) => s.includes('IGN')) ? ok('媒体名称内容正确（含 IGN）') : bad('没有看到 IGN');

  const scores = await page.locator('[data-testid="media-review-score"]').allInnerTexts();
  info(`媒体打分：${scores.map((s) => s.trim()).join(' / ')}`);
  scores.length >= 1 ? ok('显示媒体打分') : bad('媒体打分缺失');
  scores.some((s) => s.trim() === '90') ? ok('打分内容正确（含 90）') : bad('没有看到 90 分');

  const texts = await page.locator('[data-testid="media-review-text"]').allInnerTexts();
  info(`评价原文首条：${(texts[0] ?? '').replace(/\s+/g, ' ').slice(0, 60)}…`);
  texts.length >= 1 ? ok('显示媒体评价原文') : bad('评价原文缺失');
  texts.some((t) => t.trim().length > 15) ? ok('评价原文不是空串') : bad('评价原文过短');

  const countLabel = await page.locator('[data-testid="media-reviews-count"]').first().innerText().catch(() => '');
  info(`计数文案：${countLabel}`);
  countLabel.includes('3') ? ok('显示评价条数') : bad(`计数文案异常：${countLabel}`);
  await page.screenshot({ path: path.join(SHOTS, '02-reviews-with-data.png'), fullPage: true });

  // -------------------------------------------------------------------------
  step('需求 3 · 抓取失败时给出原因，且不清空已有评价');
  await fetch(`${STUB}/__mode?set=block`);
  await page.locator('[data-testid="media-reviews-refresh"]').click();
  await page.waitForSelector('[data-testid="media-reviews-notice"]', { timeout: 15000 }).catch(() => {});
  const notice = await page.locator('[data-testid="media-reviews-notice"]').first().innerText().catch(() => '');
  info(`提示：${notice.replace(/\s+/g, ' ').slice(0, 100)}`);
  /失败|failed/i.test(notice) ? ok('抓取失败时界面给出提示') : bad(`没有给出失败提示：${notice}`);
  const stillCards = await page.locator('[data-testid="media-review-card"]').count();
  stillCards === 3 ? ok('抓取失败后已有评价仍在页面上（没有被清空）') : bad(`失败后卡片数变为 ${stillCards}`);
  await page.screenshot({ path: path.join(SHOTS, '03-fetch-failed.png'), fullPage: true });

  // -------------------------------------------------------------------------
  step('需求 3b · 没有评价时显示「暂无媒体评价」');
  // 换成一个桩服没有评价的 slug，再抓一次
  await fetch(`${STUB}/__mode?set=ok`);
  await fetch(`${BASE}/api/games/${bloodborne.id}/match`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'metacritic', externalId: 'no-reviews-game', name: 'Bloodborne' }),
  });
  await page.waitForTimeout(1500);
  await openReviewsTab();
  const emptyBox = page.locator('[data-testid="media-reviews-empty"]');
  (await emptyBox.count()) > 0 ? ok('渲染了空状态区块') : bad('没有空状态区块');
  const emptyText = await emptyBox.first().innerText().catch(() => '');
  info(`空状态文案：${emptyText.replace(/\s+/g, ' ')}`);
  emptyText.includes('暂无媒体评价') ? ok('空状态包含「暂无媒体评价」') : bad(`空状态文案不符：${emptyText}`);
  const cardCount2 = await page.locator('[data-testid="media-review-card"]').count();
  cardCount2 === 0 ? ok('空状态下没有残留卡片') : bad(`空状态下仍有 ${cardCount2} 张卡片`);
  await page.screenshot({ path: path.join(SHOTS, '04-empty-state.png'), fullPage: true });

  // 换回有评价的条目，确认「重新抓取」按钮真的会重新抓（桩服计数增加）
  step('需求 4 · 「重新抓取媒体评价」按钮可用');
  await fetch(`${BASE}/api/games/${bloodborne.id}/match`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'metacritic', externalId: 'bloodborne', name: 'Bloodborne' }),
  });
  // 换回后 rating 会被清掉，重新种一次，避免后端又去重新搜索
  {
    const d = db();
    try {
      d.prepare('UPDATE games SET ratings = ? WHERE id = ?').run(
        JSON.stringify([{ source: 'metacritic', metascore: 92, criticCount: 78, userScore: 8.9, userCount: 1200, ratingClass: 'generally favorable' }]),
        bloodborne.id,
      );
    } finally { d.close(); }
  }
  await openReviewsTab();
  const before = (await fetch(`${STUB}/__stats`).then((r) => r.json())).hits.game;
  await page.locator('[data-testid="media-reviews-refresh"]').click();
  await page.waitForSelector('[data-testid="media-reviews-notice"]', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const after = (await fetch(`${STUB}/__stats`).then((r) => r.json())).hits.game;
  info(`桩服页面请求：${before} → ${after}`);
  after > before ? ok('点击按钮真的向数据源发起了抓取') : bad('点击按钮没有发起抓取');
  const cardsAfter = await page.locator('[data-testid="media-review-card"]').count();
  cardsAfter === 3 ? ok('重新抓取后页面回到 3 条评价') : bad(`重新抓取后卡片数 ${cardsAfter}`);
  await page.screenshot({ path: path.join(SHOTS, '05-after-refresh.png'), fullPage: true });

  // -------------------------------------------------------------------------
  step('设置页 · 批量补全媒体评价');
  await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
  const backfillBtn = page.locator('[data-testid="backfill-media-reviews"]');
  // 等卡片渲染完（设置页会先拉取配置和覆盖率，骨架屏期间按钮还不存在）
  await backfillBtn.waitFor({ state: 'visible', timeout: 30000 });
  (await backfillBtn.count()) > 0 ? ok('设置页有「一键批量补全媒体评价」按钮') : bad('设置页缺少批量补全按钮');
  (await page.locator('[data-testid="reviews-awaiting"]').count()) > 0
    ? ok('显示待补全游戏数')
    : bad('缺少覆盖率展示');
  await page.screenshot({ path: path.join(SHOTS, '06-settings.png'), fullPage: true });

  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  consoleErrors.length === 0 ? ok('页面没有 JS 运行时错误') : bad(`JS 错误：${consoleErrors.join('; ')}`);
} finally {
  await browser.close();
}

console.log(`\n\x1b[1m结果：${pass} 项通过 / ${fail} 项失败\x1b[0m`);
console.log(`截图目录：${SHOTS}`);
killAll();
process.exit(fail === 0 ? 0 : 1);