#!/usr/bin/env node
/**
 * ScreenPlay Windows 桌面端交付自检
 *
 * 用法（在 windows/ 目录下）：
 *   node scripts/verify-desktop.mjs               # 只做静态自检（资源完整性 + 产物内容）
 *   node scripts/verify-desktop.mjs --smoke       # 额外：用本机 node 启动打包后的后端 dist，做真实 HTTP 端到端烟测
 *   node scripts/verify-desktop.mjs --exe <路径>  # 额外：检查已构建的 ScreenPlay.exe 及其同目录 resources/
 *   node scripts/verify-desktop.mjs --json        # 机器可读输出（CI 用）
 *
 * 设计约束：不改动 web/、backend/ 源码；只读仓库其它部分；所有临时文件写在 windows/.cache/ 下。
 * 退出码：0 = 全部通过；1 = 有失败项。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WIN = path.resolve(HERE, '..');
const ROOT = path.resolve(WIN, '..');
const RES = path.join(WIN, 'src-tauri', 'resources');
const CACHE = path.join(WIN, '.cache');
const argv = process.argv.slice(2);
const wantSmoke = argv.includes('--smoke');
const asJson = argv.includes('--json');
const exeIdx = argv.indexOf('--exe');
const exePath = exeIdx >= 0 ? argv[exeIdx + 1] : null;

let pass = 0;
const failures = [];
const notes = [];

function ok(label, extra = '') {
  pass += 1;
  if (!asJson) console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`);
}
function bad(label, detail = '') {
  failures.push({ label, detail });
  if (!asJson) console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}
function check(cond, label, detail = '') {
  cond ? ok(label, detail) : bad(label, detail);
  return !!cond;
}
function section(title) {
  if (!asJson) console.log(`\n【${title}】`);
}
function sizeOf(p) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const q = path.join(p, e.name);
    total += e.isDirectory() ? sizeOf(q) : fs.statSync(q).size;
  }
  return total;
}
function countFiles(p) {
  let n = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const q = path.join(p, e.name);
    if (e.isDirectory()) n += countFiles(q);
    else n += 1;
  }
  return n;
}
const mib = (b) => (b / 1048576).toFixed(1) + ' MiB';

// ───────────────────────── 1. 静态自检 ─────────────────────────
section('资源完整性（src-tauri/resources）');
if (!fs.existsSync(RES)) {
  bad('resources/ 目录存在', `${RES} 不存在：请先运行 node scripts/prepare-backend.mjs 与 prepare-frontend.mjs`);
} else {
  const web = path.join(RES, 'web');
  const indexHtml = path.join(web, 'index.html');
  check(fs.existsSync(indexHtml), '前端入口 resources/web/index.html 存在');
  if (fs.existsSync(indexHtml)) {
    const html = fs.readFileSync(indexHtml, 'utf8');
    check(/\/assets\/[^"]+\.js/.test(html), 'index.html 引用 /assets/*.js');
    check(/\/assets\/[^"]+\.css/.test(html), 'index.html 引用 /assets/*.css');
    notes.push(html.includes('name="viewport"')
      ? 'index.html 仍含 viewport meta（桌面壳可去掉，不影响样式）'
      : 'index.html 已去掉 viewport meta（桌面精简生效）');
  }
  const assetsDir = path.join(web, 'assets');
  check(fs.existsSync(assetsDir), 'resources/web/assets/ 存在');
  if (fs.existsSync(assetsDir)) {
    const files = fs.readdirSync(assetsDir);
    check(files.some((f) => f.endsWith('.js')), 'assets 内含 js 产物');
    check(files.some((f) => f.endsWith('.css')), 'assets 内含 css 产物');
    const jsFiles = files.filter((f) => f.endsWith('.js'));
    const cdnHits = jsFiles.reduce((n, f) => n + (fs.readFileSync(path.join(assetsDir, f), 'utf8').match(/cdn\.plyr\.io/g) || []).length, 0);
    check(cdnHits === 0, '产物内无 cdn.plyr.io 外链（离线可用）', `命中 ${cdnHits}`);
    check(fs.existsSync(path.join(assetsDir, 'plyr.svg')), '本地 plyr.svg 已就位');
  }

  const nodeExe = path.join(RES, 'node', 'node.exe');
  check(fs.existsSync(nodeExe), '内置 Node 运行时 resources/node/node.exe 存在');
  const mainJs = path.join(RES, 'backend', 'dist', 'main.js');
  check(fs.existsSync(mainJs), '后端入口 resources/backend/dist/main.js 存在');
  const bs3 = path.join(RES, 'backend', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  check(fs.existsSync(bs3), 'better-sqlite3 Windows 原生绑定存在（免 node-gyp）');
  const sharpWin = path.join(RES, 'backend', 'node_modules', '@img', 'sharp-win32-x64');
  check(fs.existsSync(sharpWin), 'sharp Windows 预编译包存在（@img/sharp-win32-x64）');
  for (const bin of ['ffmpeg.exe', 'ffprobe.exe']) {
    check(fs.existsSync(path.join(RES, 'bin', bin)), `内置 ${bin} 存在（视频缩略图/封面/时长）`);
  }
  const info = path.join(RES, 'build-info.json');
  if (check(fs.existsSync(info), 'build-info.json 存在')) {
    try {
      const j = JSON.parse(fs.readFileSync(info, 'utf8'));
      check(!!j.version, 'build-info.json 含 version', String(j.version));
      check(!!j.sourceHash, 'build-info.json 含 sourceHash', String(j.sourceHash));
    } catch (e) {
      bad('build-info.json 可解析', e.message);
    }
  }

  // 开发依赖绝不能被带进安装包
  const nm = path.join(RES, 'backend', 'node_modules');
  if (fs.existsSync(nm)) {
    for (const banned of ['typescript', 'vite', 'playwright-core', '@nestjs/cli', 'ts-node', 'react', 'react-dom']) {
      const p = path.join(nm, banned);
      check(!fs.existsSync(p), `未携带开发/前端依赖：${banned}`);
    }
  }

  section('体积清单（解压后）');
  const rows = [];
  for (const rel of ['node', 'backend/dist', 'backend/node_modules', 'web', 'bin']) {
    const p = path.join(RES, rel);
    if (fs.existsSync(p)) {
      const b = sizeOf(p);
      let detail = mib(b);
      try {
        detail += ` / ${countFiles(p)} 文件`;
      } catch {}
      rows.push({ 项: rel, 体积: detail });
    } else {
      rows.push({ 项: rel, 体积: '缺失' });
    }
  }
  const total = sizeOf(RES);
  rows.push({ 项: '合计（解压）', 体积: `${mib(total)} / ${countFiles(RES)} 文件` });
  if (!asJson) {
    console.table(rows);
  }
  notes.push(`打包后压缩体积通常会降到解压体积的 35%–45%（zip/tar.gz 口径）。`);
}

// ───────────────────────── 2. 已构建 exe（可选） ─────────────────────────
if (exePath) {
  section(`构建产物检查：${exePath}`);
  const ex = path.resolve(exePath);
  check(fs.existsSync(ex), 'exe 存在', ex);
  if (fs.existsSync(ex)) {
    const st = fs.statSync(ex);
    notes.push(`exe 体积 ${mib(st.size)}`);
    const sideRes = path.join(path.dirname(ex), 'resources');
    check(fs.existsSync(sideRes), 'exe 同目录存在 resources/（Tauri bundle.resources 已就位）', sideRes);
    if (fs.existsSync(sideRes)) {
      check(fs.existsSync(path.join(sideRes, 'node', 'node.exe')), '同目录 resources/node/node.exe 存在');
      check(fs.existsSync(path.join(sideRes, 'backend', 'dist', 'main.js')), '同目录 resources/backend/dist/main.js 存在');
      check(fs.existsSync(path.join(sideRes, 'web', 'index.html')), '同目录 resources/web/index.html 存在');
    }
  }
}

// ───────────────────────── 3. 真实启动烟测（可选） ─────────────────────────
async function smoke() {
  section('端到端烟测（用本机 node 启动打包后的后端 dist）');
  const smokeDir = path.join(CACHE, 'smoke');
  const appDir = path.join(smokeDir, 'app');
  const dataDir = path.join(smokeDir, 'data');
  fs.rmSync(smokeDir, { recursive: true, force: true });
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const distSrc = path.join(RES, 'backend', 'dist');
  if (!fs.existsSync(distSrc)) {
    bad('烟测前置：resources/backend/dist 存在', distSrc);
    return;
  }
  fs.cpSync(distSrc, path.join(appDir, 'dist'), { recursive: true });
  const pkg = path.join(RES, 'backend', 'package.json');
  if (fs.existsSync(pkg)) fs.copyFileSync(pkg, path.join(appDir, 'package.json'));

  // 用仓库的 Linux/本机版 node_modules（打包进去的是 Windows 版，本机跑不了）
  const repoNm = path.join(ROOT, 'node_modules');
  const backendNm = path.join(ROOT, 'backend', 'node_modules');
  const nmSource = fs.existsSync(path.join(repoNm, 'sharp')) ? repoNm : backendNm;
  if (!fs.existsSync(nmSource)) {
    bad('烟测前置：本机 node_modules 可用', nmSource);
    return;
  }
  fs.symlinkSync(nmSource, path.join(appDir, 'node_modules'), 'dir');
  ok('烟测环境已就绪', `node_modules ← ${nmSource}`);

  const bs3Host = path.join(nmSource, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  const shim = path.join(ROOT, 'backend', 'scripts', 'verify', 'sqlite-shim.js');
  const entry = path.join(appDir, 'dist', 'main.js');
  let mainArg = entry;
  if (!fs.existsSync(bs3Host) && fs.existsSync(shim)) {
    // 与仓库既有离线校验（backend/scripts/verify/*.mjs）完全相同的做法：
    // 写一个 run.js 改写 Module._resolveFilename，把 better-sqlite3 指到 JS 垫片。
    const runJs = path.join(smokeDir, 'run.js');
    fs.writeFileSync(
      runJs,
      `const Module=require('module');const SHIM=${JSON.stringify(shim)};` +
        `const o=Module._resolveFilename;Module._resolveFilename=function(r,...a){return r==='better-sqlite3'?SHIM:o.call(this,r,...a);};` +
        `require(${JSON.stringify(entry)});\n`,
    );
    mainArg = runJs;
    notes.push('本机 better-sqlite3 无编译绑定，已按仓库既有约定用 backend/scripts/verify/sqlite-shim.js 顶替（仅影响本机自检，不影响 Windows 产物）');
  }

  const port = 3120 + Math.floor(Math.random() * 60);
  const logFile = path.join(smokeDir, 'backend.log');
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [mainArg], {
    cwd: appDir,
    stdio: ['ignore', out, out],
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      DATA_DIR: dataDir,
      WEB_DIST: path.join(RES, 'web'),
      AUTH_DISABLED: '1',
      MAINTENANCE_ON_BOOT: '0',
      BUILD_VERSION: 'desktop-selfcheck',
      BUILD_TIME: new Date().toISOString(),
    },
  });
  const done = (code) => {
    try {
      child.kill('SIGKILL');
    } catch {}
    process.exitCode = code;
  };
  child.on('exit', (c) => {
    if (c !== null && c !== 0) notes.push(`后端进程提前退出，code=${c}，日志见 ${logFile}`);
  });

  const get = (p) => new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: { Accept: '*/*' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message, body: '' }));
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
  });

  let health = null;
  for (let i = 0; i < 240; i += 1) {
    // 最多等 60 秒
    const r = await get('/api/health');
    if (r.status === 200) {
      health = r;
      break;
    }
    await new Promise((r2) => setTimeout(r2, 250));
  }
  if (!check(!!health, 'GET /api/health 返回 200（后端起来了）', health ? '' : `最后错误：${(await get('/api/health')).error || '未知'}`)) {
    notes.push(`启动日志（末 20 行）：\n${fs.readFileSync(logFile, 'utf8').split('\n').slice(-20).join('\n')}`);
    done(1);
    return;
  }
  try {
    const j = JSON.parse(health.body);
    check(j.version === 'desktop-selfcheck', '/api/health 回显 BUILD_VERSION', String(j.version));
    check(!!j.features || !!j.ok || j.status === 'ok', '/api/health 结构正常', Object.keys(j).join(','));
  } catch (e) {
    bad('/api/health 返回可解析 JSON', e.message);
  }

  const root = await get('/');
  check(root.status === 200 && /<div id="root"/.test(root.body), 'GET / 返回前端 index.html');
  const assetMatch = root.body.match(/\/assets\/[^"]+\.js/);
  if (check(!!assetMatch, 'index.html 内有可用的 js 资源路径')) {
    const a = await get(assetMatch[0]);
    check(a.status === 200 && a.body.length > 1000, `GET ${assetMatch[0]} 正常返回`, `status=${a.status} len=${a.body.length}`);
  }
  const deep = await get('/games/1');
  check(deep.status === 200 && /<div id="root"/.test(deep.body), '前端 history 回退：GET /games/1 也返回 index.html（深链可用）');
  const api = await get('/api/games');
  check(api.status === 200, 'GET /api/games 返回 200（数据接口可用）', `status=${api.status}`);
  const plyr = await get('/assets/plyr.svg');
  check(plyr.status === 200, 'GET /assets/plyr.svg 正常返回（离线图标）', `status=${plyr.status}`);

  done(failures.length ? 1 : 0);
}

// ───────────────────────── 主流程 ─────────────────────────
if (wantSmoke) {
  if (!fs.existsSync(path.join(RES, 'web'))) {
    bad('烟测前置：resources/web 存在', '请先跑 prepare-frontend.mjs');
  } else {
    await smoke();
  }
}

const summary = {
  passed: pass,
  failed: failures.length,
  failures,
  notes,
};
if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`\n结果：${pass} 项通过 / ${failures.length} 项失败`);
  for (const n of notes) console.log(`  · ${n}`);
  if (failures.length) {
    console.log('\n失败明细：');
    for (const f of failures) console.log(`  - ${f.label}${f.detail ? '：' + f.detail : ''}`);
  }
}
process.exit(failures.length ? 1 : 0);