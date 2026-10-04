/**
 * 首次创建账户（Windows 桌面端首次运行）端到端离线验证。
 *
 * 跑法：node backend/scripts/verify/auth-setup.mjs
 *
 * 背景：Windows 桌面端将默认监听局域网 + 默认开启本地账户鉴权，因此服务端在
 * 还没有任何本地账户时，必须允许登录页把「创建账号」交给用户，而不是偷偷播种
 * 一个随机 admin。本套件证明两点：
 *
 *   A. AUTH_ALLOW_SETUP=1 且尚未建号时：
 *      - 登录被挡（401），提示去本机网页创建账户；
 *      - setup 端点能建号，响应体不含 token（安卓端只从 Set-Cookie 取）、
 *        Set-Cookie 带会话令牌；
 *      - 建号后 cookie / Bearer 两条通道都通；
 *      - 再次建号被拒（403）；
 *      - 数据库里恰好一个账户、就是刚建的那个，**没有 admin 行**
 *        （证明「跳过播种」真的生效，而不是照样种了 admin）。
 *
 *   B. 不带 AUTH_ALLOW_SETUP 时（Linux/Docker 回归）：
 *      - allowSetup=false、needsSetup=false、provider=local；
 *      - 自动播种的 admin 仍按 AUTH_ADMIN_PASSWORD 落库并可登录；
 *      - setup 端点关闭（403）。
 *
 * 零网络：只连本机 127.0.0.1。better-sqlite3 用 sqlite-shim.js 的
 * Module._resolveFilename 补丁替换（见 android-auth-bearer.mjs:160-166）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path, { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TMP = path.join(ROOT, '.tmp-auth-setup');
const PORT1 = Number(process.env.PORT || 4471);
const PORT2 = PORT1 + 1;
const SEED = 'seed-Pass-123'; // AUTH_ADMIN_PASSWORD（第二段回归用）
const USER = 'wxuser';
const PASS = 'Lan-Pass-12345';

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`   \x1b[32m✓\x1b[0m ${m}`); pass += 1; };
const bad = (m) => { console.log(`   \x1b[31m✗\x1b[0m ${m}`); fail += 1; };
const info = (m) => console.log(`   ${m}`);
const step = (m) => console.log(`\n\x1b[1m== ${m}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** NestJS 的 @Post 成功默认是 201，不是 200；统一按「2xx」判定。 */
const isOk = (s) => s >= 200 && s < 300;

const children = [];
function killAll() {
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch { /* gone */ }
  }
}

// ------------------------------------------------------------------ HTTP ---

async function getJson(url, opts = {}) {
  const headers = {};
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(url, { headers });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

async function postJson(url, payload, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  const raw = res.headers.get('set-cookie') ?? '';
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body, raw, cookie: raw.split(';')[0] || '' };
}

async function waitReady(base) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  return false;
}

// -------------------------------------------------------------------- DB ---

/** 打开某个隔离实例 DATA_DIR 里的库（node:sqlite，只读检查用）。 */
function withDb(dataDir, fn) {
  const db = new DatabaseSync(path.join(dataDir, 'screenplay.db'), { timeout: 5000 });
  try { return fn(db); } finally { db.close(); }
}

// ----------------------------------------------------------------- process ---

/** 起一个隔离实例：独立 DATA_DIR / MEDIA_DIRS / 端口，真实编译产物。 */
function boot({ dir, port, allowSetup }) {
  const data = path.join(dir, 'data');
  const media = path.join(dir, 'media');
  const webDist = path.join(dir, 'webdist');
  const log = path.join(dir, 'app.log');
  fs.rmSync(dir, { recursive: true, force: true });
  for (const d of [data, media, webDist]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(log, '');

  const runJs = path.join(dir, 'run.js');
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
      DATA_DIR: data,
      MEDIA_DIRS: media,
      WEB_DIST: webDist,
      PORT: String(port),
      NODE_ENV: 'production',
      AUTH_DISABLED: '0',
      AUTH_MODE: 'local',
      AUTH_ADMIN_PASSWORD: SEED,
      AUTH_ALLOWED_USERS: '',
      // 显式设置：第一段开、第二段关（即使外部环境里恰好有 AUTH_ALLOW_SETUP 也不受影响）。
      AUTH_ALLOW_SETUP: allowSetup ? '1' : '',
      RAWG_API_KEY: '',
      RAWG_PROXY: '',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
    },
  });
  children.push(app);
  app.stdout.on('data', (d) => fs.appendFileSync(log, d));
  app.stderr.on('data', (d) => fs.appendFileSync(log, d));
  return { app, base: `http://127.0.0.1:${port}`, data, log };
}

process.on('exit', killAll);

console.log('\x1b[1m准备隔离实例（AUTH_MODE=local + 真实编译产物 backend/dist/main.js）\x1b[0m');

// ===========================================================================
// 场景 A · AUTH_ALLOW_SETUP=1：未建号 → 建号 → 复用
// ===========================================================================

const A = boot({ dir: path.join(TMP, 'setup'), port: PORT1, allowSetup: true });
if (!(await waitReady(A.base))) {
  console.error('后端未就绪，见', A.log);
  killAll();
  process.exit(1);
}
ok('隔离实例已启动（AUTH_ALLOW_SETUP=1，尚未建号）');

step('场景 ① · 未建号时的会话状态与登录被挡');

const sess1 = await getJson(`${A.base}/api/auth/session`);
info(`GET /api/auth/session → HTTP ${sess1.status} ${JSON.stringify(sess1.body)}`);
sess1.status === 200 &&
sess1.body?.enabled === true &&
sess1.body?.mode === 'local' &&
sess1.body?.allowSetup === true &&
sess1.body?.needsSetup === true &&
sess1.body?.authenticated === false
  ? ok('session：enabled/local/allowSetup=true/needsSetup=true/authenticated=false')
  : bad(`session 初始状态不符合预期：${JSON.stringify(sess1.body)}`);

const loginBefore = await postJson(`${A.base}/api/auth/login`, { username: 'admin', password: 'whatever' });
info(`未建号时 POST /api/auth/login → HTTP ${loginBefore.status} ${JSON.stringify(loginBefore.body)}`);
loginBefore.status === 401 && String(loginBefore.body?.message ?? '').includes('创建账户')
  ? ok('未建号时登录被拒（401 + 提示创建账户）')
  : bad(`未建号登录应 401 且提示创建账户：HTTP ${loginBefore.status} ${JSON.stringify(loginBefore.body)}`);

const gAnon = await getJson(`${A.base}/api/games?limit=1`);
info(`无凭证 GET /api/games → HTTP ${gAnon.status}`);
gAnon.status === 401 ? ok('无凭证 GET /api/games → 401（守卫生效）') : bad(`无凭证 GET /api/games → ${gAnon.status}`);

step('场景 ② · setup 入参校验（密码长度 / 用户名格式）');

const shortPw = await postJson(`${A.base}/api/auth/setup`, { username: USER, password: '1234567' });
info(`setup 7 位密码 → HTTP ${shortPw.status} ${JSON.stringify(shortPw.body)}`);
shortPw.status === 400 && String(shortPw.body?.message ?? '').includes('密码至少 8 位')
  ? ok('7 位密码被拒（400 + 密码至少 8 位）')
  : bad(`短密码应 400：HTTP ${shortPw.status} ${JSON.stringify(shortPw.body)}`);

const badName = await postJson(`${A.base}/api/auth/setup`, { username: 'ab!', password: PASS });
info(`setup 非法用户名 ab! → HTTP ${badName.status} ${JSON.stringify(badName.body)}`);
badName.status === 400 && String(badName.body?.message ?? '').includes('用户名')
  ? ok('非法用户名被拒（400 + 用户名提示）')
  : bad(`非法用户名应 400：HTTP ${badName.status} ${JSON.stringify(badName.body)}`);

step('场景 ③ · 建号成功：令牌只在 Set-Cookie，body 不含 token');

const made = await postJson(`${A.base}/api/auth/setup`, { username: USER, password: PASS });
info(`POST /api/auth/setup → HTTP ${made.status} ${JSON.stringify(made.body)}`);
isOk(made.status) && made.body?.ok === true
  ? ok(`建号成功（HTTP ${made.status} + {ok:true}）`)
  : bad(`建号失败：HTTP ${made.status} ${JSON.stringify(made.body)}`);

!(made.body && typeof made.body.token === 'string')
  ? ok('响应体不含 token 字段（安卓端只能从 Set-Cookie 取）')
  : bad('响应体出现 token 字段，安卓端提取逻辑的前提已变');

made.raw.includes('screenplay_session=')
  ? ok(`Set-Cookie 含 screenplay_session`)
  : bad(`Set-Cookie 缺少会话 cookie：${made.raw}`);

made.body?.user?.provider === 'local'
  ? ok("user.provider === 'local'")
  : bad(`user.provider 异常：${JSON.stringify(made.body?.user)}`);

made.body?.user?.username === USER
  ? ok(`user.username === '${USER}'`)
  : bad(`user.username 异常：${JSON.stringify(made.body?.user)}`);

const mTok = /screenplay_session=([^;]+)/.exec(made.raw);
let token = '';
try { token = mTok ? decodeURIComponent(mTok[1].trim()) : ''; } catch { token = mTok ? mTok[1].trim() : ''; }
token ? ok(`从 Set-Cookie 提取到会话令牌（长度 ${token.length}）`) : bad('未能提取会话令牌');

step('场景 ④ · 建号后 cookie 通道即已登录、可访问业务接口');

const sess2 = await getJson(`${A.base}/api/auth/session`, { cookie: made.cookie });
info(`带建号 cookie GET /api/auth/session → ${JSON.stringify(sess2.body)}`);
sess2.body?.authenticated === true && sess2.body?.needsSetup === false && sess2.body?.user?.username === USER
  ? ok('cookie 通道：authenticated=true、needsSetup=false、username 正确')
  : bad(`建号后 session 异常：${JSON.stringify(sess2.body)}`);

const gCookie = await getJson(`${A.base}/api/games?limit=1`, { cookie: made.cookie });
info(`带 cookie GET /api/games → HTTP ${gCookie.status}`);
gCookie.status === 200 ? ok('带 cookie GET /api/games → 200') : bad(`带 cookie GET /api/games → ${gCookie.status}`);

step('场景 ⑤ · 重复建号被拒；Bearer 通道不回归；建号后可正常登录');

const again = await postJson(`${A.base}/api/auth/setup`, { username: 'someone-else', password: PASS });
info(`再次 POST /api/auth/setup → HTTP ${again.status} ${JSON.stringify(again.body)}`);
again.status === 403 && String(again.body?.message ?? '').includes('已经创建过账户')
  ? ok('重复建号被拒（403 + 已经创建过账户）')
  : bad(`重复建号应 403：HTTP ${again.status} ${JSON.stringify(again.body)}`);

const gBearer = await getJson(`${A.base}/api/games?limit=1`, { bearer: token });
info(`仅 Bearer GET /api/games → HTTP ${gBearer.status}`);
gBearer.status === 200 ? ok('仅 Bearer GET /api/games → 200（安卓通道不回归）') : bad(`仅 Bearer GET /api/games → ${gBearer.status}`);

const relogin = await postJson(`${A.base}/api/auth/login`, { username: USER, password: PASS });
info(`建号后 POST /api/auth/login → HTTP ${relogin.status} ${JSON.stringify(relogin.body)}`);
isOk(relogin.status) && relogin.raw.includes('screenplay_session=')
  ? ok(`建号后可正常登录（HTTP ${relogin.status} + Set-Cookie）`)
  : bad(`建号后登录失败：HTTP ${relogin.status} ${JSON.stringify(relogin.body)}`);

step('场景 ⑥ · 数据库落库：恰好一个账户、就是刚建的、没有播种 admin');

const row = withDb(A.data, (db) => ({
  count: db.prepare('SELECT COUNT(*) AS c FROM auth_users').get().c,
  user: db.prepare('SELECT username, password_hash FROM auth_users WHERE username = ?').get(USER),
  admin: db.prepare('SELECT COUNT(*) AS c FROM auth_users WHERE username = ?').get('admin').c,
}));
info(`auth_users 行数=${row.count}，admin 行数=${row.admin}`);
row.count === 1
  ? ok('auth_users 恰好 1 行')
  : bad(`auth_users 有 ${row.count} 行（应为 1）`);
row.user?.username === USER
  ? ok(`唯一账户是 '${USER}'`)
  : bad(`唯一账户异常：${JSON.stringify(row.user)}`);
String(row.user?.password_hash ?? '').startsWith('scrypt$')
  ? ok('password_hash 以 scrypt$ 开头（非明文）')
  : bad(`哈希格式异常：${String(row.user?.password_hash).slice(0, 24)}`);
row.admin === 0
  ? ok("不存在 admin 行（证明「开启 setup 时不播种」生效）")
  : bad('出现了 admin 行——播种未被跳过');

A.app.kill('SIGKILL');
await sleep(600);

// ===========================================================================
// 场景 B · 开关关闭：Linux/Docker 回归
// ===========================================================================

step('场景 ⑦ · 开关关闭回归（未设置 AUTH_ALLOW_SETUP）');

const B = boot({ dir: path.join(TMP, 'off'), port: PORT2, allowSetup: false });
if (!(await waitReady(B.base))) {
  console.error('第二个后端未就绪，见', B.log);
  killAll();
  process.exit(1);
}
ok('第二个隔离实例已启动（未设置 AUTH_ALLOW_SETUP）');

const sess3 = await getJson(`${B.base}/api/auth/session`);
info(`GET /api/auth/session → ${JSON.stringify(sess3.body)}`);
sess3.body?.allowSetup === false && sess3.body?.needsSetup === false && sess3.body?.provider === 'local'
  ? ok('allowSetup=false、needsSetup=false、provider=local')
  : bad(`关闭时 session 状态异常：${JSON.stringify(sess3.body)}`);

const seededHash = withDb(B.data, (db) =>
  db.prepare('SELECT password_hash FROM auth_users WHERE username = ?').get('admin')?.password_hash,
);
String(seededHash ?? '').startsWith('scrypt$')
  ? ok('关闭时仍按 AUTH_ADMIN_PASSWORD 落库 admin（scrypt 哈希）')
  : bad(`关闭时未播种 admin：${String(seededHash).slice(0, 24)}`);

const seededLogin = await postJson(`${B.base}/api/auth/login`, { username: 'admin', password: SEED });
info(`老行为 POST /api/auth/login {admin, 种子密码} → HTTP ${seededLogin.status}`);
isOk(seededLogin.status)
  ? ok('自动播种的 admin 仍可登录（老行为保留）')
  : bad(`播种 admin 登录失败：HTTP ${seededLogin.status} ${JSON.stringify(seededLogin.body)}`);

const offSetup = await postJson(`${B.base}/api/auth/setup`, { username: USER, password: PASS });
info(`开关关闭时 POST /api/auth/setup → HTTP ${offSetup.status} ${JSON.stringify(offSetup.body)}`);
offSetup.status === 403
  ? ok('开关关闭时 setup → 403（未开启首次创建账户）')
  : bad(`开关关闭时 setup 应 403：HTTP ${offSetup.status} ${JSON.stringify(offSetup.body)}`);

// ---------------------------------------------------------------------------
killAll();
await sleep(200);
console.log(`\n\x1b[1m结果：${pass} 项通过 / ${fail} 项失败\x1b[0m`);
if (fail === 0) {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('现场已清理。');
} else {
  console.log(`现场保留：${TMP}（日志 ${A.log} / ${B.log}）`);
}
process.exit(fail === 0 ? 0 : 1);