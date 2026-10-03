/**
 * 安卓端（Flutter）凭证通道：`Authorization: Bearer <token>` 端到端离线验证。
 *
 * 跑法：node backend/scripts/verify/android-auth-bearer.mjs
 *
 * 背景：安卓端没有 cookie jar。登录只能在响应里拿 `Set-Cookie: screenplay_session=<token>`，
 * 之后所有请求靠 `Authorization: Bearer <token>` 带凭证（见 flutter/lib/core/api_client.dart
 * 的 `login()` / `_extractSessionToken()`）。所以服务端必须保证：
 *   1. 登录响应把会话令牌放在 Set-Cookie 里（响应体仍然不含 token 字段）；
 *   2. 仅凭 Bearer 头即可通过全局会话守卫（AuthGuard.currentUser 支持该通道）；
 *   3. `GET /api/auth/session` 也要认 Bearer，否则安卓端「会话仍有效」的判定永远为 false，
 *      有令牌的用户会被登录守卫反复踢回登录页（本项即回归此兼容点）；
 *   4. `POST /api/auth/logout` 认 Bearer，退出登录能真正吊销服务端会话；
 *   5. cookie 通道（Web / 浏览器）行为完全不变。
 *
 * 零网络：只连本机 127.0.0.1；RAWG_API_KEY 置空。better-sqlite3 用 sqlite-shim.js 的
 * Module._resolveFilename 补丁替换（见 password-change.mjs:168-175）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path, { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TMP = path.join(ROOT, '.tmp-android-auth');
const DATA = path.join(TMP, 'data');
const MEDIA = path.join(TMP, 'media');
const LOG = path.join(TMP, 'log');
const GAME_DIR = path.join(MEDIA, 'VerifyGame');
const PORT = Number(process.env.PORT || 4466);
const BASE = `http://127.0.0.1:${PORT}`;
const SEED = 'seed-Pass-123'; // AUTH_ADMIN_PASSWORD
const FIXTURE_BEARER = 'bearer-delete.jpg';
const FIXTURE_COOKIE = 'cookie-delete.jpg';

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`   \x1b[32m✓\x1b[0m ${m}`); pass += 1; };
const bad = (m) => { console.log(`   \x1b[31m✗\x1b[0m ${m}`); fail += 1; };
const info = (m) => console.log(`   ${m}`);
const step = (m) => console.log(`\n\x1b[1m== ${m}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const children = [];
function killAll() {
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch { /* gone */ }
  }
}

// ------------------------------------------------------------------ HTTP ---

/** 只发 Bearer 头，不带任何 cookie —— 这就是安卓端的调用形态。 */
function bearerFetch(url, token, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { ...init, headers });
}

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: SEED, remember: true }),
  });
  const raw = res.headers.get('set-cookie') ?? '';
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body, raw, cookie: raw.split(';')[0] || '' };
}

async function getJson(url, opts = {}) {
  const headers = opts.cookie ? { Cookie: opts.cookie } : {};
  const res = opts.bearer
    ? await bearerFetch(url, opts.bearer, { headers })
    : await fetch(url, { headers });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

async function delMedia(id, opts = {}) {
  const headers = opts.cookie ? { Cookie: opts.cookie } : {};
  const res = opts.bearer
    ? await bearerFetch(`${BASE}/api/media/${id}`, opts.bearer, { method: 'DELETE', headers })
    : await fetch(`${BASE}/api/media/${id}`, { method: 'DELETE', headers });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

async function postJson(url, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers ?? {}) };
  if (opts.cookie) headers.Cookie = opts.cookie;
  const res = opts.bearer
    ? await bearerFetch(url, opts.bearer, { method: 'POST', headers })
    : await fetch(url, { method: 'POST', headers });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

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

/** 等首次扫描跑完，避免扫描线程把手工查看的索引行当成「消失的文件」清掉。 */
async function waitScanDone(cookie) {
  for (let i = 0; i < 120; i += 1) {
    try {
      const s = await getJson(`${BASE}/api/library/status`, { cookie });
      if (s.body && s.body.scanning === false && s.body.lastScanAt) return true;
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

function findMedia(fileName) {
  return withDb((db) =>
    db.prepare('SELECT id, file_path FROM media WHERE file_name = ?').get(fileName),
  );
}

function mediaRow(id) {
  return withDb((db) => db.prepare('SELECT id FROM media WHERE id = ?').get(id));
}

function sessionRow(token) {
  return withDb((db) =>
    db.prepare('SELECT token FROM auth_sessions WHERE token = ?').get(token),
  );
}

// ----------------------------------------------------------------- process ---

fs.rmSync(TMP, { recursive: true, force: true });
for (const d of [DATA, MEDIA, GAME_DIR, path.join(TMP, 'webdist'), path.join(DATA, 'thumbnails')]) {
  fs.mkdirSync(d, { recursive: true });
}
fs.writeFileSync(LOG, '');
fs.writeFileSync(path.join(GAME_DIR, FIXTURE_BEARER), Buffer.from('bearer-fixture'));
fs.writeFileSync(path.join(GAME_DIR, FIXTURE_COOKIE), Buffer.from('cookie-fixture'));

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
    WEB_DIST: path.join(TMP, 'webdist'),
    PORT: String(PORT),
    NODE_ENV: 'production',
    AUTH_DISABLED: '0',
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
app.stdout.on('data', (d) => fs.appendFileSync(LOG, d));
app.stderr.on('data', (d) => fs.appendFileSync(LOG, d));
process.on('exit', killAll);

console.log('\x1b[1m准备隔离实例（AUTH_MODE=local + 真实编译产物 backend/dist/main.js）\x1b[0m');
if (!(await waitReady())) {
  console.error('后端未就绪，见', LOG);
  killAll();
  process.exit(1);
}
ok('隔离实例已启动（AUTH_DISABLED=0，Linux 端要求凭证）');

// ---------------------------------------------------------- ① 守卫与登录 ---
step('场景 ① · 无凭证被挡住 / 登录响应把令牌放在 Set-Cookie');

const bare = await getJson(`${BASE}/api/games?limit=5`);
info(`无凭证 GET /api/games → HTTP ${bare.status}`);
bare.status === 401 ? ok('无凭证 → 401（守卫生效）') : bad(`无凭证 → ${bare.status}`);

const loginA = await login();
info(`POST /api/auth/login → HTTP ${loginA.status} body=${JSON.stringify(loginA.body)}`);
loginA.status === 201 || loginA.status === 200
  ? ok(`登录成功（HTTP ${loginA.status}）`)
  : bad(`登录失败：HTTP ${loginA.status} ${JSON.stringify(loginA.body)}`);
!(loginA.body && typeof loginA.body.token === 'string')
  ? ok('响应体不含 token 字段（安卓端只能从 Set-Cookie 取，与 Web 端一致）')
  : bad('响应体出现 token 字段，安卓端提取逻辑的前提已变');

const m = /screenplay_session=([^;]+)/.exec(loginA.raw);
let token = '';
try { token = m ? decodeURIComponent(m[1].trim()) : ''; } catch { token = m ? m[1].trim() : ''; }
info(`Set-Cookie: ${loginA.raw}`);
token ? ok(`从 Set-Cookie 提取到会话令牌（长度 ${token.length}）`) : bad('未能提取会话令牌');
/^[A-Za-z0-9_-]+$/.test(token)
  ? ok('令牌为 base64url 字符集（encodeURIComponent / decodeComponent 无副作用）')
  : bad(`令牌含需要转义的字符：${token}`);

// ------------------------------------------------------- ② 仅 Bearer 通道 ---
step('场景 ② · 仅 Authorization: Bearer（无任何 cookie）即可通过守卫');

const gamesBearer = await getJson(`${BASE}/api/games?limit=5`, { bearer: token });
info(`仅 Bearer GET /api/games → HTTP ${gamesBearer.status}`);
gamesBearer.status === 200 ? ok('仅 Bearer → 200（安卓端凭证通道可用）') : bad(`仅 Bearer → ${gamesBearer.status}`);

const sessBearer = await getJson(`${BASE}/api/auth/session`, { bearer: token });
info(`仅 Bearer GET /api/auth/session → ${JSON.stringify(sessBearer.body)}`);
sessBearer.body?.authenticated === true && sessBearer.body?.user?.username === 'admin'
  ? ok('仅 Bearer 下 /api/auth/session authenticated=true（本次新增的兼容点；否则安卓端会反复被踢回登录页）')
  : bad(`仅 Bearer 下 /api/auth/session 未认定已登录：${JSON.stringify(sessBearer.body)}`);

const sessCookie = await getJson(`${BASE}/api/auth/session`, { cookie: loginA.cookie });
sessCookie.body?.authenticated === true
  ? ok('cookie 通道 /api/auth/session 行为不变（Web 端回归）')
  : bad(`cookie 通道 session 异常：${JSON.stringify(sessCookie.body)}`);

// ------------------------------------------------------- ③ 删除接口鉴权 ---
step('场景 ③ · DELETE /api/media/:id 的两种凭证形态');

const ghost = '00000000-0000-0000-0000-000000000000';
const noCredDel = await delMedia(ghost);
info(`无凭证 DELETE → HTTP ${noCredDel.status}`);
noCredDel.status === 401 ? ok('无凭证 DELETE → 401') : bad(`无凭证 DELETE → ${noCredDel.status}`);

const bearerGhost = await delMedia(ghost, { bearer: token });
info(`仅 Bearer DELETE（不存在的 id）→ HTTP ${bearerGhost.status} ${JSON.stringify(bearerGhost.body)}`);
bearerGhost.status === 404
  ? ok('仅 Bearer DELETE → 404 Media not found（说明已通过鉴权、只是没这条媒体）')
  : bad(`仅 Bearer DELETE → ${bearerGhost.status} ${JSON.stringify(bearerGhost.body)}`);

// ----------------------------------------------- ④ 仅 Bearer 真删一条媒体 ---
step('场景 ④ · 仅 Bearer 端到端删除（磁盘文件 + 索引行）');

if (!(await waitScanDone(loginA.cookie))) {
  bad('首次扫描未在预期时间内结束');
} else {
  const row = findMedia(FIXTURE_BEARER);
  if (!row) {
    bad(`扫描后找不到 ${FIXTURE_BEARER} 的索引行`);
  } else {
    info(`索引行 ${row.id} → ${row.file_path}`);
    const res = await delMedia(row.id, { bearer: token });
    info(`仅 Bearer DELETE → HTTP ${res.status} ${JSON.stringify(res.body)}`);
    res.status === 200 && res.body?.ok === true
      ? ok('仅 Bearer 删除成功（200 + {ok:true}）')
      : bad(`仅 Bearer 删除失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
    !mediaRow(row.id) ? ok('media 索引行已删除') : bad('media 索引行仍存在');
    !fs.existsSync(row.file_path) ? ok('库根目录里的原图已删除') : bad('原图仍在磁盘上');
  }
}

// -------------------------------------------- ⑤ cookie 通道回归 + 登出 ---
step('场景 ⑤ · cookie 通道回归（Web 端不受影响）');

const row2 = findMedia(FIXTURE_COOKIE);
if (!row2) {
  bad(`找不到 ${FIXTURE_COOKIE} 的索引行`);
} else {
  const res = await delMedia(row2.id, { cookie: loginA.cookie });
  info(`带 Cookie DELETE → HTTP ${res.status} ${JSON.stringify(res.body)}`);
  res.status === 200 && res.body?.ok === true
    ? ok('带 Cookie 删除成功（Web 端通路未受影响）')
    : bad(`带 Cookie 删除失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
}

step('场景 ⑥ · 仅 Bearer 退出登录：服务端会话真正吊销');

sessionRow(token) ? ok('登出前 auth_sessions 里存在该会话行') : bad('登出前找不到会话行');
const logout = await postJson(`${BASE}/api/auth/logout`, { bearer: token });
info(`仅 Bearer POST /api/auth/logout → HTTP ${logout.status} ${JSON.stringify(logout.body)}`);
logout.status === 200 || logout.status === 201
  ? ok(`仅 Bearer 登出成功（HTTP ${logout.status}，Nest POST 默认 201）`)
  : bad(`仅 Bearer 登出 → ${logout.status}`);
!sessionRow(token) ? ok('登出后 auth_sessions 会话行已删除（不是空操作）') : bad('登出后会话行仍在');

const afterLogout = await getJson(`${BASE}/api/games?limit=5`, { bearer: token });
info(`登出后仅 Bearer GET /api/games → HTTP ${afterLogout.status}`);
afterLogout.status === 401
  ? ok('登出后旧令牌 → 401（安卓端「退出登录」真实生效）')
  : bad(`登出后旧令牌仍可访问：${afterLogout.status}`);

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