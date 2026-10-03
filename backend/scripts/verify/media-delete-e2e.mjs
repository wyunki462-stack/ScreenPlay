/**
 * 「相册长按删除 → 同步到服务端」服务端支撑 `DELETE /api/media/:id` 端到端离线验证。
 *
 * 跑法：node backend/scripts/verify/media-delete-e2e.mjs
 *
 * 它证明的是单元层面看不到的事情 —— 真实编译产物 + 真实 SQLite + 真实磁盘：
 *   1. AUTH_DISABLED=0 且无凭证时删除被全局会话守卫挡住（Linux/Web 端要求凭证）；
 *   2. 登录拿到会话 Cookie 后删除成功，返回 200 + {ok:true,...}；
 *   3. 索引行（media）被删；
 *   4. 库根目录里的原图、DATA_DIR 下的缩略图（含 JXR 变体）、封面、preview
 *      全部从磁盘消失；
 *   5. 再次删除返回 404；
 *   6. 该游戏媒体列表不再包含被删 id，且详情 mediaCount 减 1；
 *   7. 指向该媒体的 game_posters 行被清掉，games.poster_url 不再指向该 id（回退）；
 *   8. 新起一个 AUTH_DISABLED=1 实例，无任何凭证即可删除（Windows 桌面端路径）。
 *   附：库根目录之外的原图在删除时被跳过（originalSkipped），防止 `../` 逃逸。
 *
 * 零网络：只连本机 127.0.0.1；RAWG_API_KEY 置空，刮削不参与本流程。
 * better-sqlite3 用 sqlite-shim.js 的 Module._resolveFilename 补丁替换（见
 * password-change.mjs:168-175）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path, { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TMP = path.join(ROOT, '.tmp-media-delete');
const DATA = path.join(TMP, 'data');
const MEDIA = path.join(TMP, 'media'); // MEDIA_DIRS 库根目录
const OUTSIDE = path.join(TMP, 'outside'); // 库外目录，用于路径安全校验
const LOG = path.join(TMP, 'log');
const PORT = Number(process.env.PORT || 4455);
const BASE = `http://127.0.0.1:${PORT}`;
const COOKIE = 'screenplay_session';
const SEED = 'seed-Pass-123'; // AUTH_ADMIN_PASSWORD

const GAME_DIR = path.join(MEDIA, 'VerifyGame');
const JXR_VER = '2'; // JXR_PIPELINE_VERSION

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`   \x1b[32m✓\x1b[0m ${m}`); pass += 1; };
const bad = (m) => { console.log(`   \x1b[31m✗\x1b[0m ${m}`); fail += 1; };
const info = (m) => console.log(`   ${m}`);
const step = (m) => console.log(`\n\x1b[1m== ${m}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isOk = (s) => s >= 200 && s < 300;

const children = [];
function killAll() {
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch { /* gone */ }
  }
}

// ------------------------------------------------------------------ HTTP ---

async function login(password, username = 'admin') {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, remember: true }),
  });
  const raw = res.headers.get('set-cookie') ?? '';
  const cookie = raw.split(';')[0] || '';
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body, cookie };
}

async function delMedia(id, cookie) {
  const res = await fetch(`${BASE}/api/media/${id}`, {
    method: 'DELETE',
    headers: cookie ? { Cookie: cookie } : {},
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

async function getJson(url, cookie) {
  const res = await fetch(`${url}`, { headers: cookie ? { Cookie: cookie } : {} });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

async function libraryStatus(cookie) {
  const res = await fetch(`${BASE}/api/library/status`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
  return res.json();
}

/** 等首次扫描跑完，避免扫描线程把手工插入的行当成「消失的文件」清掉。 */
async function waitScanDone(cookie) {
  for (let i = 0; i < 120; i += 1) {
    try {
      const s = await libraryStatus(cookie);
      if (s && s.scanning === false && s.lastScanAt) return true;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  return false;
}

// -------------------------------------------------------------------- DB ---

function withDb(fn) {
  const db = new DatabaseSync(path.join(DATA, 'screenplay.db'), { timeout: 5000 });
  try { return fn(db); } finally { db.close(); }
}

function findGame() {
  return withDb((db) =>
    db.prepare('SELECT id, poster_url FROM games WHERE folder_path = ?').get(GAME_DIR),
  );
}

function findMedia(fileName) {
  return withDb((db) =>
    db.prepare('SELECT id, file_path FROM media WHERE file_name = ?').get(fileName),
  );
}

function mediaRow(id) {
  return withDb((db) => db.prepare('SELECT id FROM media WHERE id = ?').get(id));
}

function posterRowsForMedia(id) {
  return withDb((db) =>
    db.prepare('SELECT COUNT(*) AS c FROM game_posters WHERE media_id = ?').get(id),
  ).c;
}

function gamePosterUrl(gameId) {
  return withDb((db) =>
    db.prepare('SELECT poster_url FROM games WHERE id = ?').get(gameId),
  )?.poster_url;
}

function setGamePosterUrl(gameId, url) {
  withDb((db) => db.prepare('UPDATE games SET poster_url = ? WHERE id = ?').run(url, gameId));
}

function markMetaRefreshed(gameId) {
  withDb((db) =>
    db.prepare('UPDATE games SET last_meta_refresh = ? WHERE id = ?').run(Date.now(), gameId),
  );
}

function insertMedia(row) {
  withDb((db) =>
    db
      .prepare(
        `INSERT INTO media
           (id, game_id, file_name, file_path, type, mime_type, size_bytes,
            file_created_at, duration_seconds, thumb_path, cover_path, sort_order, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id, row.gameId, row.fileName, row.filePath, row.type, row.mimeType,
        row.sizeBytes, Date.now(), null, null, null, 0, Date.now(),
      ),
  );
}

function insertPoster(row) {
  withDb((db) =>
    db
      .prepare(
        `INSERT INTO game_posters
           (id, game_id, url, source, media_id, is_selected, in_slideshow, sort_order, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(row.id, row.gameId, row.url, row.source, row.mediaId, row.isSelected ? 1 : 0, 0, 0, Date.now()),
  );
}

// ---------------------------------------------------------------- process ---

async function waitReady() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  return false;
}

function startApp(label, authDisabled) {
  const app = spawn(process.execPath, [path.join(TMP, 'run.js')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DATA_DIR: DATA,
      MEDIA_DIRS: MEDIA,
      WEB_DIST: path.join(TMP, 'webdist'),
      PORT: String(PORT),
      NODE_ENV: 'production',
      AUTH_DISABLED: authDisabled ? '1' : '0',
      AUTH_MODE: 'local',
      AUTH_ADMIN_PASSWORD: SEED,
      AUTH_ALLOWED_USERS: '',
      RAWG_API_KEY: '',
      RAWG_PROXY: '',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
    },
  });
  children.push(app);
  fs.appendFileSync(LOG, `\n--- ${label} (pid ${app.pid}) ---\n`);
  app.stdout.on('data', (d) => fs.appendFileSync(LOG, d));
  app.stderr.on('data', (d) => fs.appendFileSync(LOG, d));
  return app;
}

// ------------------------------------------------------------------- main ---

console.log('\x1b[1m准备隔离实例（AUTH_MODE=local + 独立 DATA_DIR/MEDIA_DIRS）\x1b[0m');
fs.rmSync(TMP, { recursive: true, force: true }); // 可重复运行：每次先清临时目录
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(GAME_DIR, { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });
fs.mkdirSync(path.join(DATA, 'thumbnails'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'covers'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'previews'), { recursive: true });
fs.writeFileSync(LOG, '');

// 真实媒体文件（库根目录里），扫描会据此建游戏 + 媒体索引行。
fs.writeFileSync(path.join(GAME_DIR, 'photo1.jpg'), Buffer.from('orig-photo-1'));
fs.writeFileSync(path.join(GAME_DIR, 'photo2.jpg'), Buffer.from('orig-photo-2'));
// 库外文件：路径安全校验必须拒绝删除它。
fs.writeFileSync(path.join(OUTSIDE, 'secret.bin'), Buffer.from('do-not-delete'));

// better-sqlite3 在本机没有编译产物：用 sqlite-shim 替换后加载真实 dist。
const runJs = path.join(TMP, 'run.js');
fs.writeFileSync(
  runJs,
  `const Module=require('module');const SHIM='${ROOT}/backend/scripts/verify/sqlite-shim.js';` +
    `const o=Module._resolveFilename;Module._resolveFilename=function(r,...a){return r==='better-sqlite3'?SHIM:o.call(this,r,...a);};` +
    `require('${ROOT}/backend/dist/main.js');\n`,
);

process.on('exit', killAll);

let app = startApp('boot #1 (auth on)', false);
if (!(await waitReady())) {
  console.error('后端未就绪，见', LOG);
  killAll();
  process.exit(1);
}
ok('隔离实例已启动（AUTH_DISABLED=0，编译产物 backend/dist/main.js）');

const loginA = await login(SEED);
isOk(loginA.status) && loginA.cookie
  ? ok('以 AUTH_ADMIN_PASSWORD 登录，拿到会话 cookie')
  : bad(`登录失败：HTTP ${loginA.status} ${JSON.stringify(loginA.body)}`);

if (!(await waitScanDone(loginA.cookie))) {
  console.error('库扫描未完成，见', LOG);
  killAll();
  process.exit(1);
}
ok('首次库扫描已完成（游戏与媒体索引行由真实文件生成）');

const game = findGame();
const m1 = findMedia('photo1.jpg');
const m2 = findMedia('photo2.jpg');
if (!game || !m1 || !m2) {
  console.error('扫描未生成预期的游戏/媒体行，见', LOG, { game, m1, m2 });
  killAll();
  process.exit(1);
}
const GAME_ID = game.id;
const ID1 = m1.id;
const ID2 = m2.id;
info(`gameId=${GAME_ID}`);
info(`被删媒体 id=${ID1}（photo1.jpg）`);

// 造出该媒体 id 对应的缓存文件（缩略图含 JXR 变体、封面、preview）。
const thumb1 = path.join(DATA, 'thumbnails', `${ID1}.webp`);
const thumb1jxr = path.join(DATA, 'thumbnails', `${ID1}v${JXR_VER}.webp`);
const cover1 = path.join(DATA, 'covers', `${ID1}.webp`);
const preview1 = path.join(DATA, 'previews', `${ID1}@fullv${JXR_VER}.webp`);
fs.writeFileSync(thumb1, Buffer.from('thumb'));
fs.writeFileSync(thumb1jxr, Buffer.from('thumb-jxr'));
fs.writeFileSync(cover1, Buffer.from('cover'));
fs.writeFileSync(preview1, Buffer.from('preview'));

// 把封面指向 ID1，并登记一条 source='media' 的悬空海报行（is_selected=1）。
insertPoster({
  id: 'verify-poster-1', gameId: GAME_ID, url: `/api/media/${ID1}/thumbnail`,
  source: 'media', mediaId: ID1, isSelected: true,
});
setGamePosterUrl(GAME_ID, `/api/media/${ID1}/thumbnail`);
markMetaRefreshed(GAME_ID); // 避免 GET /api/games/:id 触发联网刮削

const detailBefore = await getJson(`${BASE}/api/games/${GAME_ID}`, loginA.cookie);
const countBefore = detailBefore.body?.mediaCount;
const listBefore = await getJson(`${BASE}/api/games/${GAME_ID}/media`, loginA.cookie);
info(`删除前 mediaCount=${countBefore}，列表长度=${Array.isArray(listBefore.body) ? listBefore.body.length : 'n/a'}`);

// ---------------------------------------------------------------------------
step('场景 ① · AUTH_DISABLED=0 且无凭证：401（Linux/Web 端要求凭证）');
const anon = await delMedia(ID1, '');
info(`无 cookie DELETE → HTTP ${anon.status}`);
anon.status === 401
  ? ok('无凭证删除被全局会话守卫拒绝（401）')
  : bad(`无凭证删除应返回 401，实际 HTTP ${anon.status}`);
fs.existsSync(m1.file_path) && mediaRow(ID1)
  ? ok('被拒的请求没有删掉文件或索引行（无副作用）')
  : bad('被拒的请求却删除了文件/索引行');

// ---------------------------------------------------------------------------
step('场景 ② · 带会话凭证：200 + {ok:true}，索引行与文件全部消失');
const done = await delMedia(ID1, loginA.cookie);
info(`带 cookie DELETE → HTTP ${done.status} ${JSON.stringify(done.body)}`);
isOk(done.status) && done.body?.ok === true && done.body?.deleted === true
  ? ok('凭证删除成功（200 + {ok:true, deleted:true}）')
  : bad(`凭证删除失败：HTTP ${done.status} ${JSON.stringify(done.body)}`);
typeof done.body?.removedFiles === 'number'
  ? ok(`返回 removedFiles=${done.body.removedFiles}（真实删除的文件数）`)
  : bad('返回缺少 removedFiles');

// ③ 数据库行
!mediaRow(ID1) ? ok('media 索引行已从 SQLite 删除') : bad('media 索引行仍在');

// ④ 磁盘文件
const goneChecks = [
  ['原图（库根目录内）', m1.file_path],
  ['缩略图', thumb1],
  ['缩略图 JXR 变体', thumb1jxr],
  ['封面', cover1],
  ['preview', preview1],
];
let allGone = true;
for (const [label, file] of goneChecks) {
  const gone = !fs.existsSync(file);
  if (!gone) allGone = false;
  info(`${label}：${gone ? '已删除' : '仍在 ' + file}`);
}
allGone ? ok('原图 + 缩略图（含 JXR 变体）+ 封面 + preview 均已从磁盘消失') : bad('仍有缓存/原图文件残留在磁盘');

// ⑤ 幂等：再删一次 → 404
const again = await delMedia(ID1, loginA.cookie);
info(`再次 DELETE → HTTP ${again.status} ${JSON.stringify(again.body)}`);
again.status === 404 ? ok('重复删除返回 404（媒体不存在）') : bad(`重复删除应 404，实际 HTTP ${again.status}`);

// ⑥ 列表与计数
const listAfter = await getJson(`${BASE}/api/games/${GAME_ID}/media`, loginA.cookie);
Array.isArray(listAfter.body) && !listAfter.body.some((x) => x.id === ID1)
  ? ok('GET /api/games/:id/media 不再包含被删 id')
  : bad('媒体列表仍包含被删 id');
const detailAfter = await getJson(`${BASE}/api/games/${GAME_ID}`, loginA.cookie);
detailAfter.body?.mediaCount === 1
  ? ok(`GET /api/games/:id 的 mediaCount 从 ${countBefore} 减为 1`)
  : bad(`mediaCount 未按预期减 1：${detailAfter.body?.mediaCount}`);

// ⑦ 海报悬空引用 + 回退
posterRowsForMedia(ID1) === 0
  ? ok('game_posters 中指向该媒体的行已被清掉（postersRemoved 生效）')
  : bad('仍残留指向被删媒体的 game_posters 行');
const posterUrl = gamePosterUrl(GAME_ID);
!posterUrl || !posterUrl.includes(`/api/media/${ID1}/`)
  ? ok(`games.poster_url 不再指向被删 id（现为 ${posterUrl}）`)
  : bad(`games.poster_url 仍指向被删 id：${posterUrl}`);
posterUrl === `/api/media/${ID2}/thumbnail`
  ? ok('封面已回退到仍在库中的下一张本地图片')
  : info(`封面回退值：${posterUrl}（不强制为 ID2，仅要求不是死链）`);

// ---------------------------------------------------------------------------
step('场景 ⑧ · 库外路径：原图被跳过，不删库外文件（路径安全）');
const OUTSIDE_ID = 'verify-media-outside';
insertMedia({
  id: OUTSIDE_ID, gameId: GAME_ID, fileName: 'secret.bin',
  filePath: path.join(OUTSIDE, 'secret.bin'), type: 'image', mimeType: 'image/jpeg', sizeBytes: 14,
});
const outsideRes = await delMedia(OUTSIDE_ID, loginA.cookie);
info(`库外路径 DELETE → HTTP ${outsideRes.status} ${JSON.stringify(outsideRes.body)}`);
isOk(outsideRes.status) && outsideRes.body?.originalSkipped === true
  ? ok('库外 file_path 被判定为不安全：originalSkipped=true')
  : bad(`库外路径未被跳过：${JSON.stringify(outsideRes.body)}`);
fs.existsSync(path.join(OUTSIDE, 'secret.bin'))
  ? ok('库外文件依然存在（`../` 逃逸被拒绝，没有误删）')
  : bad('库外文件被删除了——路径安全校验失效');
!mediaRow(OUTSIDE_ID) ? ok('即便跳过原图，索引行仍被删除') : bad('索引行未被删除');

// ---------------------------------------------------------------------------
step('场景 ⑨ · Windows 桌面端：AUTH_DISABLED=1，无凭证即可删除');
app.kill('SIGKILL');
await sleep(800);
app = startApp('boot #2 (auth disabled)', true);
if (!(await waitReady())) {
  console.error('重启后后端未就绪，见', LOG);
  killAll();
  process.exit(1);
}
await waitScanDone(loginA.cookie); // boot#2 也会扫一次；等它结束再删
ok('新起了 AUTH_DISABLED=1 实例');

// photo2.jpg 仍在库中，boot#2 扫描会保留 ID2 行。
mediaRow(ID2) ? ok('ID2 索引行在重启扫描后仍存在（未被当成消失文件清掉）') : bad('ID2 索引行在重启后被清掉');

const winDel = await delMedia(ID2, '');
info(`无凭证 DELETE（AUTH_DISABLED=1）→ HTTP ${winDel.status} ${JSON.stringify(winDel.body)}`);
isOk(winDel.status) && winDel.body?.ok === true
  ? ok('Windows 桌面端路径：无任何凭证即可删除（200 + {ok:true}）')
  : bad(`无凭证（AUTH_DISABLED=1）删除失败：HTTP ${winDel.status} ${JSON.stringify(winDel.body)}`);
!mediaRow(ID2) && !fs.existsSync(m2.file_path)
  ? ok('ID2 的索引行与原图均已删除')
  : bad('ID2 的索引行或原图仍有残留');

// ---------------------------------------------------------------------------
killAll();
await sleep(200);
console.log(`\n\x1b[1m结果：${pass} 项通过 / ${fail} 项失败\x1b[0m`);
if (fail === 0) {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('现场已清理。');
} else {
  console.log(`现场保留：${TMP}（日志 ${LOG}）`);
}
process.exit(fail === 0 ? 0 : 1);