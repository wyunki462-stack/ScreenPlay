/**
 * 「修改密码」端到端离线验证。
 *
 * 跑法：node backend/scripts/verify/password-change.mjs
 *
 * 它证明的是单元层面看不到的事情 —— 真实编译产物 + 真实 SQLite 落库：
 *   1. 原密码错误时改密失败，且**数据库哈希没变**、旧密码仍可登录、当前会话没被踢；
 *   2. 新密码过短 / 全空白 / 与原密码相同都被拒，且都不写库；
 *   3. 原密码正确时改密成功，**新哈希落库**（不是明文），
 *      新密码可登录、旧密码不可登录，其它设备的会话被注销、发起改密的会话保留；
 *   4. 进程重启后新密码仍然可用（真持久化，不是内存态）；
 *   5. system 账户（NAS 账户）改密被明确拒绝（code=not_local），不是静默失败；
 *   6. 未登录时是 200 + {ok:false,code:unauthenticated}，不是 401
 *      —— 这一点关键：Web 客户端把任何 401 当成「会话没了」并跳回登录页，
 *      若把「原密码打错」做成 401，用户一输错就会被登出。
 *
 * 零网络：只连本机 127.0.0.1；时长/刮削等外网数据源不参与本流程。
 * better-sqlite3 用 sqlite-shim.js 的 Module._resolveFilename 补丁替换（见
 * duration-cache-e2e.mjs:127-133）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path, { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TMP = path.join(ROOT, '.tmp-pw');
const DATA = path.join(TMP, 'data');
const MEDIA = path.join(TMP, 'media');
const LOG = path.join(TMP, 'log');
const PORT = Number(process.env.PORT || 4433);
const BASE = `http://127.0.0.1:${PORT}`;
const COOKIE = 'screenplay_session';
const SEED = 'seed-Pass-123'; // AUTH_ADMIN_PASSWORD：初始密码
const NEW = 'new-Pass-456'; // 改密后的新密码

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`   \x1b[32m✓\x1b[0m ${m}`); pass += 1; };
const bad = (m) => { console.log(`   \x1b[31m✗\x1b[0m ${m}`); fail += 1; };
const info = (m) => console.log(`   ${m}`);
const step = (m) => console.log(`\n\x1b[1m== ${m}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** NestJS 的 @Post 成功默认是 201，不是 200；这里统一按「2xx 且 ok 字段语义正确」判定。 */
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

async function changePassword(body, cookie) {
  const res = await fetch(`${BASE}/api/auth/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

async function sessionInfo(cookie) {
  const res = await fetch(`${BASE}/api/auth/session`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
  return res.json();
}

// -------------------------------------------------------------------- DB ---

function withDb(fn) {
  const db = new DatabaseSync(path.join(DATA, 'screenplay.db'), { timeout: 5000 }); // busy 5s：测试进程也在写同一个库，避免与在跑的服务撞出 database is locked
  try { return fn(db); } finally { db.close(); }
}

function hashOf(username = 'admin') {
  return withDb((db) =>
    db.prepare('SELECT password_hash FROM auth_users WHERE username = ?').get(username),
  )?.password_hash;
}

function sessionCount(username = 'admin') {
  return withDb((db) =>
    db.prepare('SELECT COUNT(*) AS c FROM auth_sessions WHERE username = ?').get(username),
  ).c;
}

/** Forge a session row claiming the request came in as a NAS system account. */
function insertSystemSession(token) {
  const now = Date.now();
  withDb((db) =>
    db
      .prepare(
        `INSERT INTO auth_sessions (token, username, provider, created_at, expires_at, last_seen, user_agent)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(token, 'admin', 'system', now, now + 3600_000, now, 'password-change-verify'),
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

function startApp(label) {
  const app = spawn(process.execPath, [path.join(TMP, 'run.js')], {
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
  fs.appendFileSync(LOG, `\n--- ${label} (pid ${app.pid}) ---\n`);
  app.stdout.on('data', (d) => fs.appendFileSync(LOG, d));
  app.stderr.on('data', (d) => fs.appendFileSync(LOG, d));
  return app;
}

// ------------------------------------------------------------------- main ---

console.log('\x1b[1m准备隔离实例（AUTH_MODE=local + 独立 DATA_DIR）\x1b[0m');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(MEDIA, { recursive: true });
fs.writeFileSync(LOG, '');

// better-sqlite3 在本机没有编译产物：用 sqlite-shim 替换后加载真实 dist。
const runJs = path.join(TMP, 'run.js');
fs.writeFileSync(
  runJs,
  `const Module=require('module');const SHIM='${ROOT}/backend/scripts/verify/sqlite-shim.js';` +
    `const o=Module._resolveFilename;Module._resolveFilename=function(r,...a){return r==='better-sqlite3'?SHIM:o.call(this,r,...a);};` +
    `require('${ROOT}/backend/dist/main.js');\n`,
);

process.on('exit', killAll);

let app = startApp('boot #1');
if (!(await waitReady())) {
  console.error('后端未就绪，见', LOG);
  killAll();
  process.exit(1);
}
ok('隔离实例已启动（AUTH_MODE=local，编译产物 backend/dist/main.js）');

const seeded = hashOf();
seeded ? ok('按 AUTH_ADMIN_PASSWORD 落库了本地管理员 admin（scrypt 哈希）') : bad('未找到本地管理员 admin');
seeded?.startsWith('scrypt$') ? ok('密码以 scrypt$N$r$p$salt$key 形式存储，非明文') : bad(`哈希格式异常：${String(seeded).slice(0, 24)}`);

// ---------------------------------------------------------------------------
step('场景 0 · 登录与未登录语义');
const loginA = await login(SEED);
info(`POST /api/auth/login（种子密码）→ HTTP ${loginA.status}`);
isOk(loginA.status) && loginA.body?.ok === true
  ? ok('初始密码可正常登录，拿到会话 cookie')
  : bad(`初始密码登录失败：HTTP ${loginA.status} ${JSON.stringify(loginA.body)}`);

const loginB = await login(SEED);
loginB.cookie && loginB.cookie !== loginA.cookie
  ? ok('第二个会话已建立（模拟另一台设备同时登录）')
  : bad('第二个会话 cookie 异常');

const anon = await changePassword({ current: 'whatever', next: NEW }, '');
info(`未登录改密 → HTTP ${anon.status} ${JSON.stringify(anon.body)}`);
isOk(anon.status) && anon.body?.ok === false && anon.body?.code === 'unauthenticated'
  ? ok('未登录改密 → 2xx + {ok:false, code:"unauthenticated"}（不是 401，不会误触登出）')
  : bad('未登录改密应返回 2xx + code=unauthenticated，而不是 401');

// ---------------------------------------------------------------------------
step('场景 ① · 原密码错误：改密失败，旧密码仍可登录');
const hashBefore = hashOf();
const wrong = await changePassword({ current: 'definitely-wrong', next: NEW }, loginA.cookie);
info(`错误原密码 → HTTP ${wrong.status} ${JSON.stringify(wrong.body)}`);
isOk(wrong.status) && wrong.body?.ok === false && wrong.body?.code === 'wrong_current'
  ? ok('原密码错误被拒（code=wrong_current）')
  : bad(`原密码错误未被正确拒绝：${JSON.stringify(wrong.body)}`);

hashOf() === hashBefore
  ? ok('失败请求没有写库（password_hash 与改密前一致）')
  : bad('原密码错误却改写了数据库哈希');

const afterWrong = await login(SEED);
isOk(afterWrong.status)
  ? ok('原密码错误后，旧密码仍可登录')
  : bad(`旧密码失效了：HTTP ${afterWrong.status}`);

(await sessionInfo(loginA.cookie)).authenticated === true
  ? ok('原密码错误不会注销当前会话（用户留在页面上，只是看到错误提示）')
  : bad('原密码错误把当前会话也踢掉了');

// ---------------------------------------------------------------------------
step('场景 ④ · 新密码不合法：过短 / 全空白 / 与原密码相同，都必须被拒');
const short = await changePassword({ current: SEED, next: 'ab' }, loginA.cookie);
info(`过短新密码 → ${JSON.stringify(short.body)}`);
short.body?.ok === false && short.body?.code === 'too_short'
  ? ok('新密码短于 4 位被拒（code=too_short）')
  : bad(`过短新密码未被拒：${JSON.stringify(short.body)}`);

const blank = await changePassword({ current: SEED, next: '    ' }, loginA.cookie);
info(`全空白新密码（4 个空格，长度侥幸 ≥4）→ ${JSON.stringify(blank.body)}`);
blank.body?.ok === false && blank.body?.code === 'blank'
  ? ok('全空白新密码被拒（code=blank）——长度校验不能只看字符数')
  : bad(`全空白新密码未被拒：${JSON.stringify(blank.body)}`);

const same = await changePassword({ current: SEED, next: SEED }, loginA.cookie);
info(`与原密码相同 → ${JSON.stringify(same.body)}`);
same.body?.ok === false && same.body?.code === 'same'
  ? ok('新密码与原密码相同被拒（code=same）')
  : bad(`相同密码未被拒：${JSON.stringify(same.body)}`);

hashOf() === hashBefore ? ok('以上三种拒绝都没有写库') : bad('被拒的请求改写了数据库哈希');

// ---------------------------------------------------------------------------
step('场景 ② · 原密码正确：改密成功、新密码可登录、旧密码不可登录');
const sessionsBefore = sessionCount();
info(`改密前 admin 的会话数：${sessionsBefore}`);
const done = await changePassword({ current: SEED, next: NEW }, loginA.cookie);
info(`正确原密码 → HTTP ${done.status} ${JSON.stringify(done.body)}`);
isOk(done.status) && done.body?.ok === true ? ok('改密成功（2xx + {ok:true}）') : bad(`改密失败：HTTP ${done.status} ${JSON.stringify(done.body)}`);

const hashAfter = hashOf();
hashAfter !== hashBefore && hashAfter.startsWith('scrypt$')
  ? ok('新哈希已落库（password_hash 变了，仍是 scrypt 格式）')
  : bad('数据库里的哈希没有更新');

!(hashAfter ?? '').includes(NEW) ? ok('数据库中没有出现明文新密码') : bad('数据库里出现了明文新密码');

(await sessionInfo(loginA.cookie)).authenticated === true
  ? ok('发起改密的当前会话保持有效（不会被自己踢下线）')
  : bad('改密把当前会话也注销了');

(await sessionInfo(loginB.cookie)).authenticated === false
  ? ok('其它设备的会话已被注销（偷到 cookie 的人被锁在外面）')
  : bad('改密后其它设备的会话仍然有效');

const oldLogin = await login(SEED);
info(`旧密码登录 → HTTP ${oldLogin.status}`);
oldLogin.status === 401 ? ok('旧密码不可再用（401）') : bad(`旧密码仍能登录：HTTP ${oldLogin.status}`);

const newLogin = await login(NEW);
info(`新密码登录 → HTTP ${newLogin.status}`);
isOk(newLogin.status) && newLogin.body?.ok === true ? ok('新密码可正常登录') : bad(`新密码登录失败：HTTP ${newLogin.status} ${JSON.stringify(newLogin.body)}`);

// ---------------------------------------------------------------------------
step('场景 ⑤ · NAS 系统账户：明确拒绝，而不是静默失败');
const SYS_TOKEN = 'verify-system-account-token';
insertSystemSession(SYS_TOKEN);
const sys = await changePassword({ current: NEW, next: 'another-Pass-789' }, `${COOKIE}=${SYS_TOKEN}`);
info(`以 system 身份改密 → HTTP ${sys.status} ${JSON.stringify(sys.body)}`);
sys.body?.ok === false && sys.body?.code === 'not_local'
  ? ok('system 账户改密被明确拒绝（code=not_local，附中文原因）')
  : bad(`system 账户未被拒绝：${JSON.stringify(sys.body)}`);
hashOf() === hashAfter ? ok('被拒绝的 system 请求没有改到本地账户的密码') : bad('system 请求改写了本地哈希');

// ---------------------------------------------------------------------------
step('场景 ③ · 进程重启后新密码仍然可用（真持久化）');
app.kill('SIGKILL');
await sleep(800);
app = startApp('boot #2 (restart, same DATA_DIR)');
if (!(await waitReady())) {
  console.error('重启后后端未就绪，见', LOG);
  killAll();
  process.exit(1);
}
ok('使用同一 DATA_DIR 重启了进程');

hashOf() === hashAfter ? ok('重启后数据库里的哈希不变（密码未被重新初始化）') : bad('重启后哈希变了（初始密码被重新生成？）');

const newAfterRestart = await login(NEW);
info(`重启后新密码登录 → HTTP ${newAfterRestart.status}`);
isOk(newAfterRestart.status)
  ? ok('重启进程后新密码仍可登录（持久化生效，不必再翻启动日志）')
  : bad(`重启后新密码失效：HTTP ${newAfterRestart.status}`);

const oldAfterRestart = await login(SEED);
oldAfterRestart.status === 401
  ? ok('重启后旧密码仍然不可用')
  : bad(`重启后旧密码又能登录了：HTTP ${oldAfterRestart.status}`);

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