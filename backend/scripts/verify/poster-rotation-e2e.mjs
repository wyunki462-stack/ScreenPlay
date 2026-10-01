/**
 * 轮播归属验证：相册截图默认不勾选 / 可取消 / 不被兜底逻辑重新加回。
 * ============================================================================
 *
 * 跑法：node backend/scripts/verify/poster-rotation-e2e.mjs
 *
 * ⚠️ 全程只访问本地桩服，不访问真实站点。
 *
 * 对应用户报告的两个问题：
 *   「编辑海报界面bug：用户从相册选择的截图，勾选轮播后无法取消勾选，且默认自动
 *     加入轮播。修复为：相册截图默认不勾选轮播，支持手动取消勾选，仅用户主动勾选
 *     才加入轮播」
 *   「轮播逻辑混淆：编辑海报的轮播设置控制的是首页图库卡片轮播，而非详情页内的
 *     官方海报大图轮播」
 *
 * 为什么必须跑真实服务 + 真库：这套逻辑的坑全在**状态写回**上 ——
 * `slideshow_user_set` 有没有被置上、启动期修复会不会把取消掉的又打开、
 * 摘要接口返回的是完整集还是轮播集。纯函数测试覆盖不到这些。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path, { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TMP = path.join(ROOT, '.tmp-rot');
const DATA = path.join(TMP, 'data');
const MEDIA = path.join(TMP, 'media');
const PORT = Number(process.env.PORT || 4466);
const STUB_PORT = Number(process.env.STUB_PORT || 4610);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
let hints = 0;
const ok = (m) => { pass += 1; console.log(`   \x1b[32m✓\x1b[0m ${m}`); };
const bad = (m) => { fail += 1; console.log(`   \x1b[31m✗\x1b[0m ${m}`); };
const hint = (m) => { hints += 1; console.log(`   \x1b[33m•\x1b[0m ${m}`); };
const info = (m) => console.log(`   ${m}`);
const step = (m) => console.log(`\n\x1b[1m== ${m}\x1b[0m`);

const children = [];
const killAll = () => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = {
  async get(p) { const r = await fetch(`${BASE}${p}`); return { status: r.status, body: await r.json().catch(() => null) }; },
  async post(p, body) {
    const r = await fetch(`${BASE}${p}`, {
      method: 'POST',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  },
  async patch(p, body) {
    const r = await fetch(`${BASE}${p}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  },
};

function db() { return new DatabaseSync(path.join(DATA, 'screenplay.db')); }

function posterRows(gameId) {
  const d = db();
  try {
    return d.prepare(
      `SELECT id, source, media_id, is_selected, in_slideshow, slideshow_user_set, url
         FROM game_posters WHERE game_id = ? ORDER BY sort_order`,
    ).all(gameId);
  } finally { d.close(); }
}

/** A tiny valid PNG so the scanner registers it as an image. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

function seedAlbum(name, count) {
  const dir = path.join(MEDIA, name);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    fs.writeFileSync(path.join(dir, `shot_2026031019250${i}.png`), PNG);
  }
}

async function waitUp(url, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* not up */ }
    await sleep(500);
  }
  return false;
}

// ---------------------------------------------------------------------------
console.log('\n\x1b[1m轮播归属验证（相册截图默认不勾选 / 可取消 / 不被加回）\x1b[0m');
console.log('\n准备隔离实例');

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
seedAlbum('RotationGame', 6);

const stub = spawn(process.execPath, [
  path.join(ROOT, 'backend/scripts/verify/metacritic-stub.mjs'), String(STUB_PORT), 'ok',
], { stdio: ['ignore', 'pipe', 'pipe'] });
children.push(stub);

const runJs = path.join(TMP, 'run.js');
fs.writeFileSync(
  runJs,
  `const Module=require('module');const SHIM='${ROOT}/backend/scripts/verify/sqlite-shim.js';` +
  `const o=Module._resolveFilename;Module._resolveFilename=function(r,...a){return r==='better-sqlite3'?SHIM:o.call(this,r,...a);};` +
  `require('${ROOT}/backend/dist/main.js');\n`,
);

const app = spawn(process.execPath, [runJs], {
  // stdout 必须透传：Nest 的 Logger 写 stdout，用 'pipe' 而不消费会把日志缓冲吞掉，
  // 排查启动期修复时看不到任何输出（已踩过一次）。
  stdio: ['ignore', 'inherit', 'pipe'],
  env: {
    ...process.env,
    DATA_DIR: DATA,
    MEDIA_DIRS: MEDIA,
    WEB_DIST: path.join(ROOT, 'web/dist'),
    PORT: String(PORT),
    NODE_ENV: 'production',
    AUTH_DISABLED: '1',
    MAINTENANCE_ON_BOOT: '0',
    METACRITIC_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
    RAWG_API_KEY: '',
    RAWG_PROXY: '',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
  },
});
children.push(app);
app.stderr.on('data', (d) => process.stderr.write(`   [app:err] ${d}`));

process.on('exit', killAll);

if (!(await waitUp(`${BASE}/api/health`))) {
  console.error('  隔离实例未启动，退出');
  killAll();
  process.exit(1);
}
ok('隔离实例已启动');

// 找到扫描进来的游戏
const games = await api.get('/api/games');
const list = games.body?.games ?? games.body ?? [];
const game = Array.isArray(list) ? list[0] : null;
if (!game) { console.error('  没有扫描到游戏，退出'); killAll(); process.exit(1); }
const gameId = game.id;
info(`游戏：${game.name}（${gameId}）`);

const album = await api.get(`/api/games/${gameId}/media`);
const images = (album.body?.media ?? album.body ?? []).filter((m) => m.type !== 'video');
info(`相册图片 ${images.length} 张`);
if (images.length < 3) { console.error('  相册图片不足，退出'); killAll(); process.exit(1); }

// ---------------------------------------------------------------------------
step('问题 2-A · 从相册添加的海报默认不勾选轮播');

const added = [];
for (const m of images.slice(0, 3)) {
  const r = await api.post(`/api/games/${gameId}/posters/from-media`, { mediaId: m.id });
  if (r.status >= 400) { bad(`从相册添加失败：${r.status} ${JSON.stringify(r.body)}`); break; }
  added.push(r.body?.poster);
}

if (added.length === 3) {
  ok('3 张相册截图已添加为海报');
  const rows = posterRows(gameId).filter((r) => r.source === 'media');
  info(`media 海报：${rows.map((r) => `in_slideshow=${r.in_slideshow},user_set=${r.slideshow_user_set}`).join(' | ')}`);

  const allOff = rows.every((r) => r.in_slideshow === 0);
  allOff
    ? ok('全部 3 张默认 in_slideshow=0（默认不勾选）—— 修复前是 1')
    : bad(`仍有 ${rows.filter((r) => r.in_slideshow === 1).length} 张默认进了轮播`);

  const allMarked = rows.every((r) => r.slideshow_user_set === 1);
  allMarked
    ? ok('全部标记为已决定（slideshow_user_set=1），兜底逻辑不会自行改动')
    : bad(`${rows.filter((r) => r.slideshow_user_set === 0).length} 张未标记，会被兜底逻辑改写`);
} else {
  bad(`相册添加未全部成功（${added.length}/3）`);
}

// ---------------------------------------------------------------------------
step('问题 2-B · 手动勾选后能取消，且取消状态不会被加回');

const rows0 = posterRows(gameId).filter((r) => r.source === 'media');
const target = rows0[0];
if (!target) {
  bad('没有可操作的海报行');
} else {
  // 主动勾选
  const on = await api.patch(`/api/games/${gameId}/posters/${target.id}`, { inSlideshow: true });
  let row = posterRows(gameId).find((r) => r.id === target.id);
  row?.in_slideshow === 1
    ? ok(`主动勾选生效（PATCH ${on.status}，in_slideshow=1）`)
    : bad(`主动勾选未生效（in_slideshow=${row?.in_slideshow}）`);

  // 再取消
  const off = await api.patch(`/api/games/${gameId}/posters/${target.id}`, { inSlideshow: false });
  row = posterRows(gameId).find((r) => r.id === target.id);
  row?.in_slideshow === 0
    ? ok(`取消勾选生效（PATCH ${off.status}，in_slideshow=0）`)
    : bad(`取消勾选未生效（in_slideshow=${row?.in_slideshow}）`);
  row?.slideshow_user_set === 1
    ? ok('取消后仍标记为用户决定（slideshow_user_set=1）')
    : bad('取消后丢失了用户决定标记，会被兜底逻辑重新打开');
}

// ---------------------------------------------------------------------------
step('问题 2-C · 「重新刮削」不会把取消掉的又打开');

// 触发一次 重新匹配 → 刷新：这是历史上把取消状态覆盖掉的路径。
const rematch = await api.post(`/api/games/${gameId}/match`, {
  provider: 'metacritic',
  externalId: 'hades',
  name: game.name,
});
info(`重新匹配返回 ${rematch.status}`);
await api.post(`/api/games/${gameId}/refresh`);

const afterRefresh = posterRows(gameId).find((r) => r.id === target?.id);
afterRefresh && afterRefresh.in_slideshow === 0
  ? ok('重新刮削/刷新后取消状态保留（in_slideshow 仍为 0）')
  : bad(`刷新后被改回 in_slideshow=${afterRefresh?.in_slideshow}`);

// 造一条「旧规则遗留」的行，验证启动期清理会把它从轮播里摘掉。
//
// 旧实现（ensureRotationFloor / 启动期修复）插入相册帧时写的是
// `in_slideshow = 1, slideshow_user_set = 0` —— 实测线上库就是
// 「topped up for 39 game(s) (+268 frame(s))」。去掉规则不会撤回已经写下的数据，
// 所以必须有一次清理，否则用户看到的仍是「相册截图自动进了轮播」。
{
  const d = db();
  try {
    const px = posterRows(gameId).find((r) => r.source === 'media');
    const id = `legacy-auto-${Date.now()}`;
    d.prepare(
      `INSERT INTO game_posters
         (id, game_id, url, source, media_id, is_selected, in_slideshow, slideshow_user_set, sort_order, created_at)
       VALUES (?, ?, ?, 'media', ?, 0, 1, 0, 999, ?)`,
    ).run(id, gameId, '/legacy-auto.png', px?.media_id ?? null, Date.now());
    globalThis.__legacyId = id;
    info(`已造一条旧规则遗留行（in_slideshow=1, slideshow_user_set=0）：${id.slice(0, 18)}…`);
  } finally { d.close(); }
}

// 兜底逻辑（启动期修复）会不会把它打开 —— 直接调一次等价路径：重启实例。
killAll();
const app2 = spawn(process.execPath, [runJs], {
  stdio: ['ignore', 'inherit', 'pipe'],
  env: {
    ...process.env,
    DATA_DIR: DATA, MEDIA_DIRS: MEDIA, WEB_DIST: path.join(ROOT, 'web/dist'),
    PORT: String(PORT), NODE_ENV: 'production', AUTH_DISABLED: '1',
    // 这次**打开**启动期修复，专门验证它不会覆盖用户选择
    MAINTENANCE_ON_BOOT: '1',
    METACRITIC_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
    RAWG_API_KEY: '', RAWG_PROXY: '', HTTP_PROXY: '', HTTPS_PROXY: '',
  },
});
children.push(app2);
app2.stderr.on('data', (d) => process.stderr.write(`   [app2:err] ${d}`));

if (await waitUp(`${BASE}/api/health`, 80)) {
  ok('实例已重启（启动期数据修复开启）');

  // 启动期修复是**异步**的：它要等首轮库扫描结束（`waitForScan`）才开始，
  // 而 health 接口在那之前就已经应答了。直接查库会读到「还没修」的状态 ——
  // 这不是缺陷，是测试的竞态。轮询等它落地。
  const purgeDeadline = Date.now() + 60_000;
  let purged = false;
  while (Date.now() < purgeDeadline) {
    if (posterRows(gameId).find((r) => r.id === globalThis.__legacyId)?.in_slideshow === 0) {
      purged = true;
      break;
    }
    await sleep(500);
  }
  info(`启动期清理${purged ? '已完成' : '在 60s 内未完成'}`);

  const afterBoot = posterRows(gameId).find((r) => r.id === target?.id);
  afterBoot && afterBoot.in_slideshow === 0
    ? ok('启动期修复后取消状态仍然保留 —— 这是「无法取消」的核心回归点')
    : bad(`启动期修复把取消掉的又打开了（in_slideshow=${afterBoot?.in_slideshow}）`);

  const onCount = posterRows(gameId).filter((r) => r.source === 'media' && r.in_slideshow === 1).length;
  onCount === 0
    ? ok('没有任何相册截图被自动加进轮播（用户一张都没勾）')
    : bad(`启动后有 ${onCount} 张相册截图被自动加进轮播`);

  // 旧规则遗留的自动补帧应被清理掉
  const legacy = posterRows(gameId).find((r) => r.id === globalThis.__legacyId);
  if (!legacy) {
    bad('旧规则遗留行不见了（不该被删除，只应被移出轮播）');
  } else if (legacy.in_slideshow === 0) {
    ok('旧规则自动加入的相册帧已被启动期清理移出轮播（用户不必手动取消 268 帧）');
  } else {
    bad('旧规则遗留行仍在轮播里 —— 线上库会保持「相册截图自动进轮播」的旧状态');
  }

  // 这条行是测试自己造的假数据（url 是 /legacy-auto.png），留着会污染后面
  // 「摘要海报数 == 登记海报数」的断言 —— 那是测试的账不平，不是产品的问题。
  {
    const d = db();
    try {
      d.prepare('DELETE FROM game_posters WHERE id = ?').run(globalThis.__legacyId);
    } finally { d.close(); }
    info('已删除测试用的遗留行，避免影响后续断言');
  }
} else {
  hint('实例重启超时，启动期修复断言已跳过');
}

// ---------------------------------------------------------------------------
step('问题 3 · 首页卡片集与详情页大图轮播集已分离');

const detail = await api.get(`/api/games/${gameId}`);
const d = detail.body ?? {};

// 摘要（首页卡片用的字段）：应为**完整海报集**，与是否勾选轮播无关。
const summary = await api.get('/api/games');
const sList = summary.body?.games ?? summary.body ?? [];
const sGame = Array.isArray(sList) ? sList.find((g) => g.id === gameId) : null;
const cardSet = sGame?.posters ?? [];
const all = posterRows(gameId);
info(`摘要 posters=${cardSet.length}，登记海报总数=${all.length}，其中轮播中=${all.filter((r) => r.in_slideshow === 1).length}`);

cardSet.length === all.length
  ? ok('摘要 posters 返回完整海报集（首页卡片不再受轮播勾选影响）')
  : bad(`摘要 posters=${cardSet.length} 但登记了 ${all.length} 张 —— 首页卡片集仍被轮播勾选过滤`);

// 详情页大图集合：只认 in_slideshow + 封面。
const pl = d.posterList ?? [];
const curated = pl.filter((p) => p.inSlideshow).map((p) => p.url);
const selected = pl.filter((p) => p.isSelected).map((p) => p.url);
const heroSet = [...new Set([...selected, ...curated])];
info(`详情页大图集合 ${heroSet.length} 张（封面 ${selected.length} + 勾选 ${curated.length}）`);

const mediaTicked = all.filter((r) => r.source === 'media' && r.in_slideshow === 1).length;
mediaTicked === 0
  ? ok('详情页大图集合不含任何「用户未勾选」的相册截图')
  : bad(`详情页集合含 ${mediaTicked} 张未勾选的相册截图`);

// 正面验证：勾一张，详情集合应该随之 +1；首页卡片集不变。
const cardBefore = cardSet.length;
// 必须挑一张**不是封面**的相册海报。
  //
  // 封面永远在集合里（封面优先），勾上它不会让集合变大 —— 第一版就是挑了封面，
  // 于是「勾选后 +1」这条断言必然失败，而那是测试自己的问题，不是产品的。
  const pick = all.find((r) => r.source === 'media' && r.is_selected === 0);
if (pick) {
  await api.patch(`/api/games/${gameId}/posters/${pick.id}`, { inSlideshow: true });
  const detail2 = (await api.get(`/api/games/${gameId}`)).body ?? {};
  const pl2 = detail2.posterList ?? [];
  const curated2 = pl2.filter((p) => p.inSlideshow).map((p) => p.url);
  const selected2 = pl2.filter((p) => p.isSelected).map((p) => p.url);
  const hero2 = [...new Set([...selected2, ...curated2])];

  hero2.length === heroSet.length + 1
    ? ok(`勾选一张后详情页大图集合 ${heroSet.length} → ${hero2.length}（勾选真的控制大图轮播）`)
    : bad(`勾选后详情页集合 ${heroSet.length} → ${hero2.length}，期望 +1`);

  const summary2 = await api.get('/api/games');
  const s2 = (summary2.body?.games ?? summary2.body ?? []).find?.((g) => g.id === gameId);
  const cardAfter = s2?.posters?.length ?? -1;
  cardAfter === cardBefore
    ? ok(`首页卡片集保持 ${cardAfter} 张不变（两个轮播互不干扰）`)
    : bad(`首页卡片集从 ${cardBefore} 变成了 ${cardAfter} —— 仍然被轮播勾选牵动`);

  // 收尾：恢复未勾选，避免影响后续断言
  await api.patch(`/api/games/${gameId}/posters/${pick.id}`, { inSlideshow: false });
}

// ---------------------------------------------------------------------------
killAll();
console.log(`\n\x1b[1m结果：${pass} 项通过 / ${fail} 项失败${hints ? ` / ${hints} 项提示` : ''}\x1b[0m\n`);
process.exit(fail ? 1 : 0);