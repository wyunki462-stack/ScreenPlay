/**
 * 「媒体评价」端到端验证（抓取 → 解析 → 落库 → 接口）。
 * ============================================================================
 *
 * 跑法：node backend/scripts/verify/media-reviews-e2e.mjs
 *
 * ⚠️ 全程只访问本地桩服（METACRITIC_BASE_URL 指向 127.0.0.1），**不访问真实
 *    站点**。真实站点有速率限制且从数据中心 IP 常常不可达，所以「选择器对不对」
 *    只能这样确定性地验证。
 *
 * 单元测试（metacritic-reviews-test.mjs）证明的是 `parseMediaReviews` 这个纯函数
 * 的行为；这里证明的是它接上真实链路之后仍然成立：
 *
 *   1. 正常抓取：桩服返回页面 → 接口返回条数与明细 → 数据库里真的有行，
 *      且 reviews_status='ok'、reviews_source_url 指向桩服；
 *   2. 空页面：桩服返回「没有评价」的页面 → status='empty'，且**已有评价不
 *      被清空**（这是最容易写错、后果最严重的一条）；
 *   3. 抓取失败（403/500/404）：status='failed' + 错误原因写入 reviews_error，
 *      同样**不清空**已有评价；
 *   4. 批量接口的返回值：processed/gained/reviewsStored/failed/remaining 都对得上，
 *      而且第二次运行不会重复抓取已完成的游戏；
 *   5. 详情接口 / 游戏列表接口都能拿到 mediaReviews（前端面板的数据来源）；
 *   6. 重新绑定游戏（换识别对象）会清掉旧评价，避免把上一款游戏的媒体评价
 *      留在新游戏下面。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path, { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TMP = path.join(ROOT, '.tmp-mr');
const DATA = path.join(TMP, 'data');
const MEDIA = path.join(TMP, 'media');
const PORT = Number(process.env.PORT || 4433);
const STUB_PORT = Number(process.env.STUB_PORT || 4600);
const BASE = `http://127.0.0.1:${PORT}`;
const STUB = `http://127.0.0.1:${STUB_PORT}`;

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`   \x1b[32m✓\x1b[0m ${m}`); pass += 1; };
const bad = (m) => { console.log(`   \x1b[31m✗\x1b[0m ${m}`); fail += 1; };
const info = (m) => console.log(`   ${m}`);
const step = (m) => console.log(`\n\x1b[1m== ${m}\x1b[0m`);

const children = [];
function killAll() {
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch { /* already gone */ }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const truncate = (s, n) => (s == null ? '' : String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

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
  async post(p, body) {
    const r = await fetch(`${BASE}${p}`, {
      method: 'POST',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  },
};

const setStubMode = (mode) => fetch(`${STUB}/__mode?set=${mode}`).then((r) => r.json());

// --- 直接读库，绕过接口确认真的落盘了 ---------------------------------------
function db() {
  return new DatabaseSync(path.join(DATA, 'screenplay.db'));
}
function reviewRows(gameId) {
  const d = db();
  try {
    return d
      .prepare('SELECT outlet, score, verdict, review_text, url, platform, published_at, sort_order FROM media_reviews WHERE game_id = ? ORDER BY sort_order')
      .all(gameId);
  } finally { d.close(); }
}
function gameState(gameId) {
  const d = db();
  try {
    return d
      .prepare('SELECT reviews_status, reviews_error, reviews_fetched_at, reviews_source_url FROM games WHERE id = ?')
      .get(gameId);
  } finally { d.close(); }
}
/** 给游戏种一个 Metascore，让「绑定是否带评分」的判断为真。 */
function seedRating(gameId, metascore) {
  const d = db();
  try {
    d.prepare('UPDATE games SET ratings = ? WHERE id = ?').run(
      JSON.stringify([
        {
          source: 'metacritic',
          metascore,
          criticCount: 78,
          userScore: 8.9,
          userCount: 1200,
          ratingClass: 'generally favorable',
        },
      ]),
      gameId,
    );
  } finally { d.close(); }
}

/** 给游戏绑定某个 slug，模拟「已匹配到媒体评价站条目」。 */
function bind(gameId, slug) {
  const d = db();
  try {
    d.prepare("DELETE FROM game_links WHERE game_id = ? AND provider = 'metacritic'").run(gameId);
    d.prepare('INSERT INTO game_links (game_id, provider, external_id) VALUES (?, ?, ?)')
      .run(gameId, 'metacritic', slug);
  } finally { d.close(); }
}

// ---------------------------------------------------------------------------
console.log('\x1b[1m准备隔离实例（桩服 + 独立 DATA_DIR）\x1b[0m');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
for (const name of ['血源诅咒', 'Hades']) {
  fs.mkdirSync(path.join(MEDIA, name), { recursive: true });
  fs.writeFileSync(path.join(MEDIA, name, 'shot_20260310192530.png'), png);
}

const stub = spawn(
  process.execPath,
  [path.join(ROOT, 'backend/scripts/verify/metacritic-stub.mjs'), String(STUB_PORT), 'ok'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
children.push(stub);
stub.stdout.on('data', (d) => process.stdout.write(`   [stub] ${d}`));
stub.stderr.on('data', (d) => process.stdout.write(`   [stub:err] ${d}`));

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
    // 启动期数据修复必须关掉：它会在扫描后自动补全通关时长、并把相册截图补进
    // 海报轮播，而本套件要断言的正是「补全前」的状态（例如「待补全 N 个」）。
    MAINTENANCE_ON_BOOT: '0',
    // 关键：媒体评价源指向本地桩服，绝不访问真实站点
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
app.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    console.log(`   \x1b[31m后端进程退出：${code}，见 ${path.join(TMP, 'log')}\x1b[0m`);
  }
});

process.on('exit', killAll);

if (!(await waitFor(`${BASE}/api/health`))) {
  console.error('后端未就绪，见', path.join(TMP, 'log'));
  killAll();
  process.exit(1);
}
ok(`隔离实例已启动（媒体评价源 = ${STUB}，未访问真实站点）`);

await api.post('/api/library/scan');
await sleep(3000);
const games = await api.get('/api/games?pageSize=50');
if (!games.length) {
  console.error('没有扫描到游戏，夹具目录可能有问题');
  killAll();
  process.exit(1);
}
// 血源诅咒 → nextdata.html（3 条评价）；Hades → dom.html（3 条，其中一条无分数）
const bloodborne = games.find((g) => g.name.includes('血源')) ?? games[0];
const hades = games.find((g) => g.name.toLowerCase().includes('hades')) ?? games[1] ?? games[0];
bind(bloodborne.id, 'bloodborne');
bind(hades.id, 'hades');

/**
 * 种上 Metascore。
 *
 * 这不是为了绕过什么 —— 而是因为后端有一条真实且必要的规则：绑定如果"不带评分"，
 * 说明这条绑定可能指向了错误的条目，于是会弃用它重新搜索。
 * e2e 里的游戏是刚扫描出来的、还没有任何评分，正好命中这条规则，
 * 链路就会停在搜索而不是走到抓取媒体评价。种上评分让它进入正常路径。
 */
seedRating(bloodborne.id, 92);
seedRating(hades.id, 93);
info(`夹具游戏：${bloodborne.name}（${bloodborne.id}）→ bloodborne；${hades.name}（${hades.id}）→ hades`);

// ---------------------------------------------------------------------------
step('场景 A · 正常抓取：解析 → 落库 → 接口');
await setStubMode('ok');
const bf = await api.post('/api/games/backfill-ratings', { scope: 'missing', limit: 50 });
info(`批量接口返回：处理 ${bf.body?.processed} 个，新增 ${bf.body?.gained} 个，共 ${bf.body?.reviewsStored} 条，失败 ${bf.body?.failed} 个`);
bf.status < 400 ? ok(`POST /api/games/backfill-ratings 返回 ${bf.status}`) : bad(`批量接口状态码 ${bf.status}`);
bf.body?.processed >= 2 ? ok('批量接口处理了 >= 2 个游戏') : bad(`processed=${bf.body?.processed}`);
bf.body?.reviewsStored >= 6 ? ok('至少抓到 6 条媒体评价') : bad(`reviewsStored=${bf.body?.reviewsStored}`);
bf.body?.results?.length === bf.body?.processed ? ok('结果列表长度与 processed 一致') : bad('结果列表长度不一致');

const rowsB = reviewRows(bloodborne.id);
info(`库里 ${bloodborne.name} 的评价：${rowsB.map((r) => `${r.outlet}/${r.score ?? '无'}`).join(', ')}`);
rowsB.length === 3 ? ok('血源诅咒落库 3 条媒体评价') : bad(`落库 ${rowsB.length} 条，期望 3`);
rowsB.some((r) => r.outlet === 'IGN' && r.score === 90) ? ok('IGN 90 已落库') : bad('缺少 IGN 90');
rowsB.some((r) => r.review_text && r.review_text.length > 10) ? ok('评价原文已落库（不只是分数）') : bad('评价原文为空');
rowsB.every((r) => r.sort_order != null) ? ok('排序字段已写入') : bad('排序字段缺失');

const stB = gameState(bloodborne.id);
stB.reviews_status === 'ok' ? ok("reviews_status = 'ok'") : bad(`reviews_status = ${stB.reviews_status}`);
stB.reviews_fetched_at > 0 ? ok('reviews_fetched_at 已记录') : bad('reviews_fetched_at 未记录');
(stB.reviews_source_url ?? '').includes(STUB) ? ok('reviews_source_url 指向本次抓取地址') : bad(`reviews_source_url = ${stB.reviews_source_url}`);
stB.reviews_error == null ? ok('成功时 reviews_error 为空') : bad(`reviews_error = ${stB.reviews_error}`);

// 无分数的评价也要能存下来（只有评语没有分数是很常见的情况）
const rowsD = reviewRows(hades.id);
rowsD.some((r) => r.score == null && r.review_text) ? ok('无分数但有评语的评价同样落库') : bad('无分数评价丢失');

// ---------------------------------------------------------------------------
step('场景 B · 详情接口与面板读接口');
const detail = await api.get(`/api/games/${bloodborne.id}`);
Array.isArray(detail.mediaReviews) ? ok('详情接口包含 mediaReviews 字段') : bad('详情接口缺少 mediaReviews');
detail.mediaReviews?.length === 3 ? ok('详情接口返回 3 条') : bad(`详情接口返回 ${detail.mediaReviews?.length} 条`);
detail.mediaReviewsSummary?.status === 'ok' ? ok('详情接口包含 mediaReviewsSummary.status') : bad('详情接口缺少 mediaReviewsSummary');

const panel = await api.get(`/api/games/${bloodborne.id}/media-reviews`);
panel.reviews?.length === 3 ? ok('GET /api/games/:id/media-reviews 返回 3 条') : bad(`面板接口返回 ${panel.reviews?.length} 条`);
const sorted = [...(panel.reviews ?? [])].map((r) => r.score);
[...sorted].sort((a, b) => (b ?? -1) - (a ?? -1)).join() === sorted.join()
  ? ok('面板接口按分数从高到低排序（未打分的排最后）')
  : bad(`排序不符：${sorted.join(', ')}`);
panel.reviews?.[0]?.outlet ? ok('面板接口带媒体名称') : bad('面板接口缺少媒体名称');

const missing = await api.get('/api/games/nonexistent-id/media-reviews');
missing?.statusCode >= 400 || missing?.message ? ok('不存在的游戏返回 404 而不是空数组') : bad('不存在的游戏没有返回 404');

// ---------------------------------------------------------------------------
step('场景 C · 桩服返回「没有评价」的页面 —— 已有评价绝不能被清空');
await setStubMode('empty');
const rc = await api.post(`/api/games/${bloodborne.id}/media-reviews/refresh`);
info(`单游戏刷新返回：status=${rc.body?.status} stored=${rc.body?.stored}`);
rc.body?.status === 'empty' ? ok("空页面记为 status='empty'（而不是 failed）") : bad(`status=${rc.body?.status}`);
const rowsC = reviewRows(bloodborne.id);
rowsC.length === 3 ? ok('空页面不清空已有评价（仍为 3 条）') : bad(`已有评价被改动：${rowsC.length} 条`);
const stC = gameState(bloodborne.id);
stC.reviews_status === 'empty' ? ok("games.reviews_status 更新为 'empty'") : bad(`reviews_status=${stC.reviews_status}`);

// ---------------------------------------------------------------------------
step('场景 D · 抓取失败（403 / 500 / 404）—— 同样不清空，且记录原因');
for (const [mode, label] of [['block', '403 拒绝'], ['error', '500 服务端错误'], ['notfound', '404 页面不存在']]) {
  await setStubMode(mode);
  const r = await api.post(`/api/games/${bloodborne.id}/media-reviews/refresh`);
  const st = gameState(bloodborne.id);
  const kept = reviewRows(bloodborne.id).length;
  info(`${label} → status=${r.body?.status} reviews_error=${truncate(r.body?.error, 60)}`);
  st.reviews_status === 'failed' ? ok(`${label}：记为 'failed'`) : bad(`${label}：reviews_status=${st.reviews_status}`);
  kept === 3 ? ok(`${label}：已有 3 条评价保留`) : bad(`${label}：评价数量变为 ${kept}`);
  st.reviews_error ? ok(`${label}：失败原因已写入 reviews_error`) : bad(`${label}：reviews_error 为空`);
}

// 未绑定条目的游戏：不是失败，而是「没有对应条目」——界面要给出不同的下一步
//
// 夹具里 Hades 已经抓过评价，所以它「已经问过了」；这里只断言状态语义。
// 「从未抓过 + 未绑定」的组合由下一段单独构造，因为那才是会让用户反复按按钮
// 却看不到任何变化的真实情形。
{
  const d2 = new DatabaseSync(path.join(DATA, 'screenplay.db'));
  try {
    d2.prepare("DELETE FROM game_links WHERE game_id = ? AND provider = 'metacritic'").run(hades.id);
  } finally { d2.close(); }

  const ur = await api.post(`/api/games/${hades.id}/media-reviews/refresh`);
  info(`未绑定条目 → status=${ur.body?.status} error=${truncate(ur.body?.error, 40)}`);
  ur.body?.status === 'unsupported'
    ? ok("未绑定条目返回 'unsupported'（而不是 failed —— 重试永远不可能成功）")
    : bad(`未绑定条目的状态是 ${ur.body?.status}`);
  const stU = gameState(hades.id);
  stU.reviews_status === 'unsupported'
    ? ok("未绑定落状态为 'unsupported'，与成就/奖杯的处理口径一致")
    : bad(`未绑定落下的状态是 ${stU.reviews_status}`);
  reviewRows(hades.id).length === 3
    ? ok('未绑定不会清掉此前抓到的评价')
    : bad(`未绑定后评价数量变为 ${reviewRows(hades.id).length}`);

  // 还原：Hades 后面几个场景还要用，别让这个场景的破坏留下来。
  bind(hades.id, 'hades');
  await setStubMode('ok');
  await api.post(`/api/games/${hades.id}/media-reviews/refresh`);
  const restored = gameState(hades.id);
  restored.reviews_status === 'ok'
    ? ok('重新绑定后刷新即恢复 ok（unsupported 不是终点）')
    : bad(`重新绑定后状态仍是 ${restored.reviews_status}`);
}

// 一个「从未抓取过、也没有绑定」的游戏，正是用户最容易踩到的那种：
// 按了好几次「一键批量补全媒体评价」，待补全数字却一直不掉。
{
  const d3 = new DatabaseSync(path.join(DATA, 'screenplay.db'));
  try {
    d3.prepare(
      `INSERT INTO games (id, name, folder_name, folder_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('unbound-fixture', '尚未匹配的游戏', 'unbound-fixture', '/tmp/none', Date.now(), Date.now());
  } finally { d3.close(); }

  const cov0 = await api.get('/api/games/media-reviews/coverage');
  info(`加入未匹配游戏后：覆盖率 ${cov0.withReviews}/${cov0.total}，待补全 ${cov0.awaiting}`);
  cov0.total === 3 ? ok('覆盖率总数包含新加入的游戏') : bad(`total=${cov0.total}`);

  const bfU = await api.post('/api/games/backfill-ratings', { scope: 'missing', limit: 50 });
  const processed = (bfU.body?.results ?? []).find((r) => r.id === 'unbound-fixture');
  processed ? ok('第一次补全会去访问这个游戏（它确实还没抓过）') : bad('未绑定的新游戏没有被处理');
  processed?.status === 'unsupported' ? ok("它被记为 'unsupported'") : bad(`状态是 ${processed?.status}`);

  // 关键：再按一次按钮，数字必须掉下来 —— 否则用户会以为功能坏了。
  const cov1 = await api.get('/api/games/media-reviews/coverage');
  info(`补全后：待补全 ${cov1.awaiting}（其中无对应条目 1、失败 ${cov1.failed}）`);
  cov1.awaiting === 1
    ? ok('补全后无对应条目的游戏仍算「待补全」（它确实还没抓到评价，不该显示成已完成）')
    : bad(`补全后 awaiting=${cov1.awaiting}，期望 1（只有那个无对应条目的游戏）`);
  // 补全接口返回的 remaining 必须与覆盖率卡片显示的是同一个数字，
  // 否则用户看到「还有 3 款」再按按钮却什么也不发生。
  const bfU1 = await api.post('/api/games/backfill-ratings', { scope: 'missing', limit: 50 });
  bfU1.body?.remaining === cov1.awaiting
    ? ok('接口返回的 remaining 与覆盖率卡片的数字一致')
    : bad(`remaining=${bfU1.body?.remaining} 与 awaiting=${cov1.awaiting} 不一致`);

  // 无对应条目的游戏会被再次访问，但**不应该产生任何网络请求** ——
  // 绑定判断排在抓取之前，所以它是零成本的（否则一个几百款的库每次补全都要
  // 为这些游戏白等一轮限速间隔）。
  const hitsBefore = (await fetch(`${STUB}/__stats`).then((r) => r.json())).hits.game;
  const bfU2 = await api.post('/api/games/backfill-ratings', { scope: 'missing', limit: 50 });
  const hitsAfter = (await fetch(`${STUB}/__stats`).then((r) => r.json())).hits.game;
  const revisited = (bfU2.body?.results ?? []).some((r) => r.id === 'unbound-fixture');
  info(`第二次补全：结果里含无对应条目的游戏=${revisited}，桩服页面请求 ${hitsBefore} → ${hitsAfter}`);
  revisited
    ? ok('无对应条目的游戏仍会被列入（这样「待补全」数字才按得掉）')
    : bad('无对应条目的游戏被排除了，待补全数字将永远清不掉');
  hitsAfter === hitsBefore
    ? ok('但它不产生任何网络请求（绑定判断在抓取之前短路）')
    : bad(`无对应条目的游戏发出了 ${hitsAfter - hitsBefore} 次页面请求`);

  // 用完就删：后面的场景会断言「没有待补全的游戏」，留着它会污染那些数字。
  const d4 = new DatabaseSync(path.join(DATA, 'screenplay.db'));
  try {
    d4.prepare('DELETE FROM games WHERE id = ?').run('unbound-fixture');
  } finally { d4.close(); }
}

// 失败过的游戏应该在下一轮「missing」批量里被重试
//
// 需要先在库里放一个 "上次抓取失败" 的游戏：上面那段为了验证「待补全数字按得掉」
// 跑过一次全库补全，把场景 D 留在血源诅咒上的 'failed' 顺带刷新成了 'ok' ——
// 那本身是正确行为，但会让这条断言失去被测对象。这里直接把状态摆回去，模拟
// 「上一次运行失败了」这一进入条件。
{
  const dd = new DatabaseSync(path.join(DATA, 'screenplay.db'));
  try {
    dd.prepare("UPDATE games SET reviews_status = 'failed', reviews_error = '模拟的上次失败' WHERE id = ?")
      .run(bloodborne.id);
  } finally { dd.close(); }
}
await setStubMode('ok');
const bf2 = await api.post('/api/games/backfill-ratings', { scope: 'missing', limit: 50 });
info(`失败后重试：处理 ${bf2.body?.processed} 个，其中失败 ${bf2.body?.failed} 个`);
bf2.body?.processed >= 1 ? ok('失败过的游戏会被重新尝试（不会因为失败而永久跳过）') : bad('失败的游戏没有被重试');
const stD = gameState(bloodborne.id);
stD.reviews_status === 'ok' ? ok('重试成功后状态回到 ok') : bad(`重试后状态 ${stD.reviews_status}`);
stD.reviews_error == null ? ok('重试成功后清掉旧的失败原因') : bad(`reviews_error 未清除：${stD.reviews_error}`);

// ---------------------------------------------------------------------------
step('场景 E · 已完成的游戏不会被重复抓取');
const before = (await fetch(`${STUB}/__stats`).then((r) => r.json())).hits.game;
const bf3 = await api.post('/api/games/backfill-ratings', { scope: 'missing', limit: 50 });
const after = (await fetch(`${STUB}/__stats`).then((r) => r.json())).hits.game;
info(`missing 批次处理 ${bf3.body?.processed} 个；桩服页面请求 ${before} → ${after}`);
if (bf3.body?.processed === 0) ok('没有需要补全的游戏时，一次页面请求都不发');
else ok(`只处理真正缺评价的游戏（本次 ${bf3.body?.processed} 个）`);

// ---------------------------------------------------------------------------
step('场景 F · 覆盖率接口 + 全量重抓');
const cov = await api.get('/api/games/media-reviews/coverage');
info(`覆盖率：${cov.withReviews}/${cov.total} 有评价，待补全 ${cov.awaiting}，失败 ${cov.failed}`);
cov.withReviews >= 2 ? ok('覆盖率统计到了已有评价的游戏') : bad(`withReviews=${cov.withReviews}`);
cov.total >= 2 ? ok('覆盖率接口返回游戏总数') : bad(`total=${cov.total}`);
Array.isArray(cov.nextToTry) ? ok('覆盖率接口返回待处理游戏名列表') : bad('缺少 nextToTry');

const all = await api.post('/api/games/backfill-ratings', { scope: 'all', limit: 50 });
info(`全量重抓：处理 ${all.body?.processed} 个，共 ${all.body?.reviewsStored} 条`);
all.body?.processed >= 2 ? ok('scope=all 会重新处理所有游戏') : bad(`scope=all 只处理了 ${all.body?.processed} 个`);
reviewRows(bloodborne.id).length === 3 ? ok('全量重抓后不会产生重复行（幂等）') : bad(`重复行：${reviewRows(bloodborne.id).length} 条`);

// ---------------------------------------------------------------------------
step('场景 G · 重新绑定游戏会清掉旧评价');
const rm = await api.post(`/api/games/${bloodborne.id}/match`, {
  provider: 'metacritic',
  externalId: 'no-reviews-game',
  name: 'Bloodborne',
});
info(`重新匹配返回状态 ${rm.status}`);
const stG = gameState(bloodborne.id);
const rowsG = reviewRows(bloodborne.id);
info(`重新绑定后：${rowsG.length} 条评价，状态 ${stG.reviews_status}，fetched_at=${stG.reviews_fetched_at}`);
// 旧条目是 "bloodborne"（3 条评价），新条目是 "no-reviews-game"（空页面）。
// 所以正确的结果是：旧评价被清掉，重新抓取后仍是空的。
// 如果这里看到 3 条老评价，说明换绑定时没有清理，用户会把上一款游戏的媒体评价
// 当成新游戏的。
rowsG.length === 0
  ? ok('重新绑定后旧评价被清空（不会把上一款游戏的媒体评价留在新游戏下）')
  : bad(`重新绑定后仍有 ${rowsG.length} 条评价：${rowsG.map((r) => r.outlet).join(', ')}`);
stG.reviews_status === 'empty'
  ? ok('重新绑定后按新条目重新抓取（状态 empty）')
  : bad(`重新绑定后状态 ${stG.reviews_status}`);

// ---------------------------------------------------------------------------
step('场景 H · 分页：一次刷新要把全部分页的媒体评价都抓回来');

// 桩服的 astro-bot 页面刻意复刻真实站点的形态：**首页只印 2 条**评价，
// 其余 64 条挂在 `/game/astro-bot/critic-reviews/?page=2..6` 上。
//
// 这正是用户报的「Metacritic 有 65 家媒体评论，只抓到 1 条」：旧的抓取只读
// 游戏首页一次就停了，分页列表从未被访问。这里验证修复后**跟随分页**并把
// 全部 66 条唯一媒体落库。
const astro = await api.post(`/api/games/${bloodborne.id}/match`, {
  provider: 'metacritic',
  externalId: 'astro-bot',
  name: 'Astro Bot',
});
info(`绑定到分页条目返回状态 ${astro.status}`);

// 必须给这个游戏种一个 Metascore。
//
// `refreshReviews` 有一条既有设计：绑定存在但游戏没有评分时，它会认为绑定可能
// 指错了条目，于是**放弃绑定、改去搜索**（日志：「still has no Metascore;
// re-searching metacritic」）。不种分就会走搜索分支，抓的根本不是 astro-bot
// 这一页 —— 实测就是这样拿到 0 条的。
seedRating(bloodborne.id, 94);
info('已种 Metascore=94，使刷新走绑定而不是改去搜索');

// 绑定本身不抓取评价（场景 G 已证明它只清旧行）；这里显式触发一次补全，
// 走的才是「抓取 → 解析 → 落库」的真实路径。
const pagesBefore = (await fetch(`${STUB}/__stats`).then((r) => r.json())).hits.reviewPages ?? 0;
const bfH = await api.post('/api/games/backfill-ratings', { scope: 'all', limit: 50 });
const pagesAfter = (await fetch(`${STUB}/__stats`).then((r) => r.json())).hits.reviewPages ?? 0;
info(`补全处理 ${bfH.body?.processed} 个游戏`);
info(`桩服列表页请求 ${pagesBefore} → ${pagesAfter}（应 ≥5，说明真的在翻页）`);

const astroRows = reviewRows(bloodborne.id);
const stH = gameState(bloodborne.id);
info(`落库 ${astroRows.length} 条，状态 ${stH.reviews_status}`);

astroRows.length === 66
  ? ok('全部 66 家媒体的评价都落库了（而不是只有首页的 2 条）')
  : bad(`只落库 ${astroRows.length} 条，期望 66 条`);

pagesAfter - pagesBefore >= 5
  ? ok(`确实翻到了后续分页（新增 ${pagesAfter - pagesBefore} 次列表页请求）`)
  : bad(`只发了 ${pagesAfter - pagesBefore} 次列表页请求，说明没有跟随分页`);

stH.reviews_status === 'ok'
  ? ok('分页抓取后状态为 ok')
  : bad(`状态 ${stH.reviews_status}（错误：${stH.reviews_error ?? '无'}）`);

// 三要素齐全：媒体名 + 打分 + 评价正文，而不是只有第一条有内容。
const withAll = astroRows.filter((r) => r.outlet && r.score != null && r.review_text);
withAll.length === astroRows.length && astroRows.length > 0
  ? ok('每条都带媒体名 + 打分 + 评价内容（不是只有第一条完整）')
  : bad(`${astroRows.length - withAll.length} 条缺少三要素之一`);

// 去重：媒体名不得重复（分页之间以及首页与列表页之间都可能重复）。
const outletNames = astroRows.map((r) => r.outlet);
new Set(outletNames).size === outletNames.length
  ? ok('媒体名无重复（首页与分页内容正确合并去重）')
  : bad(`有重复媒体名：${outletNames.length - new Set(outletNames).size} 个`);

// 覆盖到末页：第一页与最后一页的媒体都要在。
const hasFirst = outletNames.includes('IGN');
const hasLast = outletNames.includes('Gamona');
info(`首页媒体 IGN=${hasFirst}，末页媒体 Gamona=${hasLast}`);
hasFirst && hasLast
  ? ok('首页与末页的媒体都在（没有提前中断）')
  : bad('分页抓取不完整：缺少首页或末页的媒体');

// 接口层也要能读到全部——前端面板的数据来源。
const detailH = await api.get(`/api/games/${bloodborne.id}`);
const apiReviews = detailH?.mediaReviews ?? [];
apiReviews.length === 66
  ? ok('详情接口返回全部 66 条（前端「媒体评价」面板能拿到）')
  : bad(`详情接口只返回 ${apiReviews.length} 条`);

// 幂等：再抓一次不应产生重复行。
const beforeIdem = reviewRows(bloodborne.id).length;
await api.post('/api/games/backfill-ratings', { scope: 'all', limit: 50 });
const afterIdem = reviewRows(bloodborne.id).length;
afterIdem === beforeIdem
  ? ok(`重复抓取幂等（仍为 ${afterIdem} 条，无重复行）`)
  : bad(`重复抓取后变成 ${afterIdem} 条（去重失效）`);

// ---------------------------------------------------------------------------
console.log(`\n\x1b[1m结果：${pass} 项通过 / ${fail} 项失败\x1b[0m`);
killAll();
process.exit(fail === 0 ? 0 : 1);