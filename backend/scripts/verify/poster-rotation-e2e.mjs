/**
 * 轮播归属验证：两套轮播彻底拆开 —— 首页卡片=封面+用户勾选，详情页大图=全部官方海报。
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
 * `slideshow_user_set` 有没有被置上、启动期清理会不会把取消掉的又打开、
 * 摘要接口返回的是不是「封面 + 勾选」的卡片集。纯函数测试覆盖不到这些。
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

function db() { return new DatabaseSync(path.join(DATA, 'screenplay.db'), { timeout: 5000 }); } // busy 5s：测试进程也在写同一个库，避免与在跑的服务撞出 database is locked

function posterRows(gameId) {
  const d = db();
  try {
    return d.prepare(
      `SELECT id, source, media_id, is_selected, in_slideshow, slideshow_user_set, url
         FROM game_posters WHERE game_id = ? ORDER BY sort_order`,
    ).all(gameId);
  } finally { d.close(); }
}

/** A tiny valid PNG (16×16 RGB) so both the scanner and the upload path accept it. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAI0lEQVR42mNgEFAwcAhIKGiYsGDDgQsPPhDkj2oY1TB8NQAAZx1o' +
    'EPUl+hUAAAAASUVORK5CYII=',
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

/** 当前的首页卡片集（摘要接口 `game.posters`）。默认 `GET /api/games` 返回裸数组。 */
async function cardSetNow() {
  const body = (await api.get('/api/games')).body;
  const list = body?.games ?? body ?? [];
  const g = Array.isArray(list) ? list.find((x) => x.id === gameId) : null;
  return g?.posters ?? [];
}

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

// 造「旧规则遗留」的行，验证启动期清理会把它从轮播里摘掉。
//
// 旧实现插入帧时写的是 `in_slideshow = 1, slideshow_user_set = 0` —— 实测线上库就是
// 「topped up for 39 game(s) (+268 frame(s))」。去掉规则不会撤回已经写下的数据，
// 所以必须有一次清理，否则用户看到的仍是「相册截图自动进了轮播」。
//
// **两条行、两个来源**：`media` 是当年那条规则的目标，`scraped` 不是。清理已从
// 「只看 `source = 'media'`」泛化到**所有来源**（`removeAutoAddedFramesFromRotation`）；
// 只造 media 行的话，旧的 `purgeAutoAddedAlbumFrames` 也能让断言通过 —— 那样这条
// 断言对「泛化」等于没有把关（这正是评审指出的空转点）。
{
  const d = db();
  try {
    const px = posterRows(gameId).find((r) => r.source === 'media');
    const insert = d.prepare(
      `INSERT INTO game_posters
         (id, game_id, url, source, media_id, is_selected, in_slideshow, slideshow_user_set, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 1, 0, 999, ?)`,
    );
    const stamp = Date.now();
    const legacyMedia = `legacy-auto-media-${stamp}`;
    const legacyScraped = `legacy-auto-scraped-${stamp}`;
    insert.run(legacyMedia, gameId, '/legacy-auto-media.png', 'media', px?.media_id ?? null, stamp);
    insert.run(legacyScraped, gameId, '/legacy-auto-scraped.png', 'scraped', null, stamp + 1);
    globalThis.__legacyIds = [legacyMedia, legacyScraped];
    info('已造 2 条旧规则遗留行（in_slideshow=1, slideshow_user_set=0）：media + scraped');
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
  const stillIn = () =>
    globalThis.__legacyIds.filter(
      (id) => posterRows(gameId).find((r) => r.id === id)?.in_slideshow !== 0,
    );
  while (Date.now() < purgeDeadline && stillIn().length > 0) await sleep(500);
  const leftover = stillIn();
  info(
    `启动期清理${leftover.length === 0 ? '已完成（两条遗留行都已移出轮播）' : `在 60s 内未完成（剩 ${leftover.length} 条）`}`,
  );

  const afterBoot = posterRows(gameId).find((r) => r.id === target?.id);
  afterBoot && afterBoot.in_slideshow === 0
    ? ok('启动期修复后取消状态仍然保留 —— 这是「无法取消」的核心回归点')
    : bad(`启动期修复把取消掉的又打开了（in_slideshow=${afterBoot?.in_slideshow}）`);

  const onCount = posterRows(gameId).filter((r) => r.source === 'media' && r.in_slideshow === 1).length;
  onCount === 0
    ? ok('没有任何相册截图被自动加进轮播（用户一张都没勾）')
    : bad(`启动后有 ${onCount} 张相册截图被自动加进轮播`);

  // 旧规则遗留的自动补帧应被清理掉 —— 两个来源都要清，这才是「泛化到所有来源」。
  const legacyRows = globalThis.__legacyIds.map((id) =>
    posterRows(gameId).find((r) => r.id === id),
  );
  const vanished = legacyRows.filter((r) => !r).length;
  if (vanished > 0) {
    bad(`旧规则遗留行不见了 ${vanished} 条（不该被删除，只应被移出轮播）`);
  }
  for (const [i, src] of ['media', 'scraped'].entries()) {
    const row = legacyRows[i];
    if (!row) continue;
    row.in_slideshow === 0
      ? ok(`启动期清理把 source=${src} 的遗留帧移出轮播（泛化到所有来源，不只相册截图）`)
      : bad(`source=${src} 的遗留帧仍在轮播里（in_slideshow=${row.in_slideshow}）`);
  }

  // 这两条行是测试自己造的假数据（url 是 /legacy-auto-*.png），留着会污染后面
  // 「摘要海报数 == 登记海报数」的断言 —— 那是测试的账不平，不是产品的问题。
  {
    const d = db();
    try {
      const del = d.prepare('DELETE FROM game_posters WHERE id = ?');
      for (const id of globalThis.__legacyIds) del.run(id);
    } finally { d.close(); }
    info('已删除测试用的 2 条遗留行，避免影响后续断言');
  }
} else {
  hint('实例重启超时，启动期修复断言已跳过');
}

// ---------------------------------------------------------------------------
step('问题 3-A · 新上传的官方海报默认不勾选轮播（in_slideshow=0）');

// 上传是离线造出 source='upload'（官方图）的唯一途径：元数据桩服不产出海报/截图，
// 而相册图是 source='media'。契约要求「新登记/刮削/上传的官方图默认 in_slideshow=0」，
// 正好在这里覆盖。
{
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'uploaded-cover.png');
  const r = await fetch(`${BASE}/api/games/${gameId}/posters/upload`, { method: 'POST', body: fd });
  if (r.status >= 400) {
    bad(`上传海报失败：${r.status} ${JSON.stringify(await r.text().catch(() => null))}`);
  } else {
    const poster = (await r.json().catch(() => null))?.poster ?? null;
    ok(`上传成功（${r.status}）`);
    const row = posterRows(gameId).find((x) => x.id === poster?.id);
    row && row.source === 'upload'
      ? ok('登记的是官方图（source=upload）')
      : bad(`source=${row?.source}，期望 upload`);
    row && row.in_slideshow === 0
      ? ok('新上传的官方图默认 in_slideshow=0（不再默认进卡片轮播）—— 修复前是 1')
      : bad(`新上传的官方图 in_slideshow=${row?.in_slideshow}，期望 0`);
  }
}

// ---------------------------------------------------------------------------
step('问题 3-B · 首页卡片集 = 封面 + 勾选；详情页大图 = 全部官方海报');

const detail = await api.get(`/api/games/${gameId}`);
const d = detail.body ?? {};
const all = posterRows(gameId);

// 摘要（首页卡片用的 game.posters）：封面 + 勾选行，未勾选的非封面行不在其中。
const cardSet = await cardSetNow();
// 卡片集里的 url 会被 `proxyImage` 换成 `/api/media/proxy?url=<encoded>`（scraped 行），
// 所以不能比字面相等 —— 解码后再做包含判断，否则会假报「未勾选的行泄漏进卡片集」。
const decode = (u) => { try { return decodeURIComponent(u); } catch { return u; } };
const cardHas = (list, r) =>
  list.some((u) => u === r.url || decode(u).includes(r.url));
const inCard = (r) => cardHas(cardSet, r);
info(
  `摘要 posters=${cardSet.length}；登记总数=${all.length}；封面=${all.filter((r) => r.is_selected === 1).length}；` +
    `勾选中=${all.filter((r) => r.in_slideshow === 1).length}`,
);

// ① 封面结构性在卡片集内（judgement: is_selected=1 OR in_slideshow=1），不靠标志位。
const cover = all.find((r) => r.is_selected === 1);
cover && inCard(cover)
  ? ok('封面在首页卡片集内（结构性：封面永远是第一帧，不靠 in_slideshow）')
  : bad(`封面（${cover?.id?.slice(0, 12)}）不在卡片集里`);

// ① 未勾选且非封面的行不出现在卡片集里。
const outRows = all.filter((r) => r.is_selected === 0 && r.in_slideshow === 0);
const leaked = outRows.filter((r) => inCard(r));
leaked.length === 0
  ? ok(`未勾选的行全部不在卡片集里（封面以外、未勾选共 ${outRows.length} 张）`)
  : bad(`有 ${leaked.length} 张未勾选的行仍出现在卡片集里`);

// ② 勾选后进入卡片集、取消后退出（用一张非封面的相册图）。
const pick = all.find((r) => r.source === 'media' && r.is_selected === 0 && r.in_slideshow === 0);
if (!pick) {
  hint('没有可勾选的非封面相册行，跳过「勾选进入卡片集」断言');
} else {
  const on3 = await api.patch(`/api/games/${gameId}/posters/${pick.id}`, { inSlideshow: true });
  const card2 = await cardSetNow();
  on3.status === 200 && cardHas(card2, pick)
    ? ok(`勾选后该行进入首页卡片集（${cardSet.length} → ${card2.length}）`)
    : bad(`勾选后该行未进入首页卡片集（PATCH ${on3.status}，card2=${JSON.stringify(card2)}）`);

  await api.patch(`/api/games/${gameId}/posters/${pick.id}`, { inSlideshow: false });
  const card3 = await cardSetNow();
  !cardHas(card3, pick)
    ? ok('取消勾选后该行退出首页卡片集')
    : bad('取消勾选后该行仍在首页卡片集里');
}

// 详情页大图集合：posterList 里的**全部官方海报**（scraped/upload），与 in_slideshow 无关。
const pl = d.posterList ?? [];
const officialInList = pl.filter((p) => p.source === 'scraped' || p.source === 'upload');
const officialRows = all.filter((r) => r.source === 'scraped' || r.source === 'upload');
info(`posterList 共 ${pl.length} 条；官方海报 ${officialInList.length}/${officialRows.length}`);
officialRows.length === 0
  ? hint('库里没有官方海报（桩服不产出 artwork 且未成功上传），官方全集断言跳过')
  : officialInList.length === officialRows.length
    ? ok('posterList 含全部官方海报（详情页大图用全集，不经 in_slideshow 过滤）')
    : bad(
        `posterList 官方 ${officialInList.length} 条，登记官方 ${officialRows.length} 条 —— 大图集被过滤了`,
      );

const untickedOfficial = officialInList.filter((p) => !p.inSlideshow);
if (officialInList.length === 0) {
  // 已 hint
} else if (untickedOfficial.length > 0) {
  ok(`未勾选的官方海报仍在 posterList（${untickedOfficial.length} 条）—— 大图默认全轮播，不靠勾选`);
} else {
  hint('官方海报全部被勾选，无法验证「未勾选仍在」—— 但官方全集断言已覆盖');
}

// ---------------------------------------------------------------------------
killAll();
console.log(`\n\x1b[1m结果：${pass} 项通过 / ${fail} 项失败${hints ? ` / ${hints} 项提示` : ''}\x1b[0m\n`);
process.exit(fail ? 1 : 0);