#!/usr/bin/env node
/**
 * ScreenPlay 桌面端「局域网 + 首次创号」端到端自检（1.3.2 起）
 *
 * 为什么需要它：1.3.2 把默认监听地址从 `127.0.0.1` 改成 `0.0.0.0`，并把鉴权默认从「关闭」
 * 改成「首次打开网页时创建账户」。这两件事分别写在 Windows 壳（`src-tauri/src/*.rs`）与
 * 免安装启动器（`launcher/launch.mjs`）里；`scripts/verify-desktop.mjs` 的「1.3.2 行为断言」
 * 只能读源码文本，所以这里**真的把启动器跑起来**，验证运行时行为：
 *
 *   1) 启动器日志显示默认监听 `0.0.0.0` 并打印局域网访问地址；
 *   2) 后端确实绑在 0.0.0.0 —— 用本机局域网 IP 与回环 IP 都能打开 Web 首页；
 *   3) 首次启动不播种随机密码：`/api/auth/session` 报 `needsSetup: true`、`allowSetup: true`；
 *   4) `POST /api/auth/setup` 能创建账户（201 + `Set-Cookie`，响应体不含 token）；
 *   5) 建号后接口需登录：无凭证 401、带 cookie 200、再次 setup 403。
 *
 * 平台：Linux/macOS/Windows 都能跑（「防火墙默认放行」只在 Windows 生效，本脚本不去碰防火墙，
 * 那一项留给真机验收）。前置条件：仓库里已有 `backend/dist`（`npm run build:backend`）与
 * `windows/src-tauri/resources/backend/dist`（`npm run --prefix windows prepare:backend` 或
 * `scripts/prepare-backend.mjs` 单独跑；直接跑构建脚本体也可用 rsync 覆盖，见 RELEASE-1.3.2.md）。
 *
 * 用法：node windows/scripts/verify-lan.mjs [--keep]
 *   --keep  保留临时数据目录（便于排查；会打印路径）
 * 环境：SP_WINDOWS_DIR 覆盖 windows/ 目录（默认取本文件上一级）。
 * 退出码：0 = 全通过；1 = 有失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WIN = process.env.SP_WINDOWS_DIR ? path.resolve(process.env.SP_WINDOWS_DIR) : path.resolve(HERE, '..');
const ROOT = path.resolve(WIN, '..');
const LAUNCHER = path.join(WIN, 'launcher', 'launch.mjs');
// 宿主 Node 缺 better-sqlite3 原生绑定时的垫片（与其余离线套件同一份实现）。
const SHIM = path.join(ROOT, 'backend', 'scripts', 'verify', 'sqlite-shim.js');
const keep = process.argv.includes('--keep');

let pass = 0;
const failures = [];
const notes = [];
const ok = (label, extra = '') => { pass += 1; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`); };
const bad = (label, detail = '') => { failures.push({ label, detail }); console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); };
const check = (cond, label, detail = '') => { (cond ? ok : bad)(label, detail); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 本机局域网 IPv4（第一个非 internal 地址），用来证明「真的绑到 0.0.0.0」。 */
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) return ni.address;
  }
  return null;
}

console.log('【桌面端 1.3.2 局域网 + 首次创号 端到端自检】');
if (!fs.existsSync(LAUNCHER)) {
  console.error(`  ✗ 找不到启动器：${LAUNCHER}`);
  process.exit(1);
}
const bundledDist = path.join(WIN, 'src-tauri', 'resources', 'backend', 'dist', 'main.js');
if (!fs.existsSync(bundledDist)) {
  notes.push(`缺少 ${bundledDist}：先跑 windows/scripts/prepare-backend.mjs（或构建脚本），否则本套件无法验证运行时行为。`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-verify-lan-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const shimRequire = path.join(tmp, 'shim-require.js');
fs.writeFileSync(
  shimRequire,
  'const Module = require("module");\n' +
    `const SHIM = ${JSON.stringify(SHIM)};\n` +
    'const orig = Module._resolveFilename;\n' +
    'Module._resolveFilename = function (request, ...rest) {\n' +
    "  return request === 'better-sqlite3' ? SHIM : orig.call(this, request, ...rest);\n" +
    '};\n',
);
console.log(`  临时数据目录：${dataDir}\n`);

const child = spawn(process.execPath, [LAUNCHER], {
  cwd: WIN,
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    DATA_DIR: dataDir,
    SP_NO_BROWSER: '1',
    SP_NODE: process.execPath,
    ...(fs.existsSync(SHIM) ? { NODE_OPTIONS: `--require ${shimRequire}` } : {}),
  },
});

let out = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => { out += d; });
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => { out += d; });

/** 收尾：整个进程组一起杀（启动器 + 它拉起的后端）。 */
const stop = () => {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
};
process.on('exit', stop);

/** 等启动器打印出端口（「后端端口：NNNNN」）。 */
async function waitForPort(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const m = out.match(/后端端口：(\d+)/);
    if (m) return Number(m[1]);
    await sleep(300);
  }
  return null;
}

const port = await waitForPort();
if (!port) {
  bad('启动器成功拉起后端（能解析出端口）', out.split('\n').filter(Boolean).slice(-12).join(' | '));
} else {
  ok('启动器成功拉起后端', `端口 ${port}`);
  check(/监听地址：0\.0\.0\.0（局域网可访问）/.test(out), '启动器日志显示默认监听 0.0.0.0');
  check(/鉴权模式：local/.test(out), '启动器日志显示默认鉴权为 local（不再 off）');
  // 「局域网访问地址」是后端就绪之后才打印的，所以这里要等一会儿再断言。
  let lanLine = '';
  for (let i = 0; i < 240 && !lanLine; i += 1) {
    lanLine = (out.match(/局域网访问地址：(\S+)/) || [])[1] || '';
    if (!lanLine) await sleep(250);
  }
  check(!!lanLine, '启动器打印局域网访问地址', lanLine);

  const base = `http://127.0.0.1:${port}`;
  const req = async (p, init = {}, baseUrl = base) => {
    try {
      const r = await fetch(baseUrl + p, { ...init, signal: AbortSignal.timeout(8000) });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* html 等非 JSON 响应 */ }
      return { status: r.status, headers: r.headers, text, json };
    } catch (e) {
      return { status: 0, error: e.message, text: '', json: null };
    }
  };

  let health = null;
  for (let i = 0; i < 160 && !health; i += 1) {
    const r = await req('/api/health');
    if (r.status === 200) health = r;
    else await sleep(250);
  }
  check(!!health, 'GET /api/health 200（后端已就绪）', health ? `version=${health.json?.version}` : '');
  if (health) {
    const v = String(health.json?.version || '');
    check(v.endsWith('-desktop-portable'), '健康检查回显便携版号', v);
    if (!v.startsWith('1.3.2')) {
      notes.push(
        `后端回显版号是 ${v}（非 1.3.2）：src-tauri/resources/build-info.json 是构建产物（由 scripts/prepare-backend.mjs step 8 按 windows/package.json 生成），跑一次 prepare-backend 即可刷新。本套件只验证运行时行为，不因版号失败。`,
      );
    }
  }

  // ① 真的绑到 0.0.0.0：换成本机局域网 IP 也能打开 Web 首页
  const ip = lanIp();
  if (ip) {
    const viaLan = await req('/', {}, `http://${ip}:${port}`);
    check(viaLan.status === 200 && /<div id="root"/.test(viaLan.text), `局域网地址可打开 Web 首页（http://${ip}:${port}/）`, `status=${viaLan.status}`);
  } else {
    notes.push('本机没有非 internal 的 IPv4 地址，跳过「局域网 IP 可访问」断言。');
  }

  // ② 首次启动：未登录 + 等待创号（不播种随机密码）
  const s1 = await req('/api/auth/session');
  check(s1.status === 200 && s1.json?.authenticated === false, '首次启动未被当作已登录', JSON.stringify(s1.json));
  check(s1.json?.needsSetup === true, '会话报 needsSetup=true（等待创建账户）', JSON.stringify(s1.json));
  check(s1.json?.allowSetup === true, '会话报 allowSetup=true', JSON.stringify(s1.json));
  const noAuth = await req('/api/games');
  check(noAuth.status === 401, '未登录访问 /api/games 返回 401（对局域网不裸奔）', `status=${noAuth.status}`);

  // ③ 首次创号
  const setup = await req('/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'lancheck', password: 'lan-Pass-123' }),
  });
  check(setup.status === 201, 'POST /api/auth/setup 返回 201', `status=${setup.status} body=${setup.text.slice(0, 120)}`);
  check(!/"token"\s*:/.test(setup.text), 'setup 响应体不含 token（token 只在 Set-Cookie）', setup.text.slice(0, 80));
  const setCookie = setup.headers?.get?.('set-cookie') || '';
  check(/screenplay_session=/.test(setCookie), 'setup 下发 screenplay_session cookie', setCookie.split(';')[0]);
  check(/HttpOnly/i.test(setCookie), '会话 cookie 带 HttpOnly');

  // ④ 建号后：带 cookie 放行、不带仍拒绝、不再是 needsSetup、重复 setup 被拒
  const cookie = setCookie.split(';')[0];
  const withCookie = await req('/api/games', { headers: { Cookie: cookie } });
  check(withCookie.status === 200, '带 cookie 访问 /api/games 200（账户生效）', `status=${withCookie.status}`);
  const stillNo = await req('/api/games');
  check(stillNo.status === 401, '不带 cookie 仍返回 401', `status=${stillNo.status}`);
  const s2 = await req('/api/auth/session', { headers: { Cookie: cookie } });
  check(s2.json?.authenticated === true, '建号后会话变为已登录', JSON.stringify(s2.json));
  check(s2.json?.needsSetup !== true, '建号后 needsSetup 不再为 true');
  const again = await req('/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'other', password: 'lan-Pass-456' }),
  });
  check(again.status === 403, '已有账户后再次 setup 被拒（403）', `status=${again.status} body=${again.text.slice(0, 80)}`);

  notes.push('「防火墙默认放行」只在 Windows 生效：请在真实 Windows 机器上确认局域网连接时不会弹「允许访问」。');
}

stop();
if (keep) {
  notes.push(`已保留临时目录：${tmp}`);
} else {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响结论 */ }
}

console.log(`\n【结果】${pass} 项通过 / ${failures.length} 项失败`);
for (const n of notes) console.log(`  · ${n}`);
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? '：' + f.detail : ''}`);
}
process.exit(failures.length ? 1 : 0);