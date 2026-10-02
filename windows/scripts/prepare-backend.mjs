#!/usr/bin/env node
/**
 * prepare-backend.mjs — 组装 ScreenPlay Windows 桌面端的「内置后端」资源。
 *
 * 契约：windows/DESIGN.md §4（resources/ 布局）
 * 产出（全部落在 windows/src-tauri/resources/ 下）：
 *   node/node.exe                       Node 运行时 win-x64 v22.20.0（仅 node.exe）
 *   backend/dist/**                     nest build 产物（复制 backend/dist，不改仓库）
 *   backend/node_modules/**             Windows 版生产依赖（win32-x64）
 *   backend/package.json                随附版本信息
 *   bin/ffmpeg.exe bin/ffprobe.exe      @ffmpeg-installer / @ffprobe-installer win32-x64
 *   build-info.json                     { version, sourceHash, builtAt, nodeVersion }
 *
 * 特性：
 *   · 幂等 / 可重复运行：已存在的缓存与产出默认跳过并校验大小（--force 强制重做）。
 *   · 所有临时文件与下载缓存在 windows/.cache/ 下（npm 缓存 windows/.cache/npm）。
 *   · 任何一步失败：打印中文可读原因（哪一步 / 哪个 URL / 原始错误）+ 排查建议，exit(1)。
 *   · 绝不修改仓库根 node_modules 与 backend/（只读取 backend/dist 与 backend/package.json）。
 *
 * 用法：node windows/scripts/prepare-backend.mjs [--force] [--skip-npm-install]
 * 只使用 Node 内置模块 + 系统命令（npm/curl/tar/unzip），不新增 npm 依赖。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WIN_DIR = path.resolve(__dirname, '..');
const CACHE = path.join(WIN_DIR, '.cache');
const NPM_CACHE = path.join(CACHE, 'npm');
const PKG_DIR = path.join(CACHE, 'backend-pkg');
const RESOURCES = path.join(WIN_DIR, 'src-tauri', 'resources');
const RES_BACKEND = path.join(RESOURCES, 'backend');
const RES_NODE = path.join(RESOURCES, 'node');
const RES_BIN = path.join(RESOURCES, 'bin');

const PROXY = 'http://127.0.0.1:7890';
const REGISTRY = 'https://registry.npmmirror.com';

const NODE_VERSION = '22.20.0';
const BETTER_SQLITE3_VERSION = '11.10.0';
const BETTER_SQLITE3_ABI = '127'; // Node 22 = ABI 127
const FFMPEG_PKG = '@ffmpeg-installer/win32-x64';
const FFPROBE_PKG = '@ffprobe-installer/win32-x64';

// 环境已实测可达的 URL（直连），按优先级排列
const URL_BETTER_SQLITE3 =
  `https://github.com/WiseLibs/better-sqlite3/releases/download/v${BETTER_SQLITE3_VERSION}` +
  `/better-sqlite3-v${BETTER_SQLITE3_VERSION}-node-v${BETTER_SQLITE3_ABI}-win32-x64.tar.gz`;
const NODE_URLS = [
  `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
  `https://npmmirror.com/mirrors/node/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
];
const FFMPEG_TGZ_URLS = [
  `https://mirrors.tencent.com/npm/${FFMPEG_PKG}/-/win32-x64-4.1.0.tgz`,
];
const FFPROBE_TGZ_URLS = [
  `https://mirrors.tencent.com/npm/${FFPROBE_PKG}/-/win32-x64-5.1.0.tgz`,
];

const LOG_PREFIX = '[prepare-backend]';
const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const skipNpmInstall = argv.includes('--skip-npm-install');
const downloadLog = [];
const stepLog = [];

function log(m) { console.log(`${LOG_PREFIX} ${m}`); }
function warn(m) { console.warn(`${LOG_PREFIX} WARN ${m}`); }
function hr() { console.log('-'.repeat(72)); }
function ok(m) { console.log(`    ${m}`); }

function fail(step, detail, err, hint) {
  console.error(`\n${LOG_PREFIX} ✗ 失败`);
  console.error(`  步骤   : ${step}`);
  console.error(`  详情   : ${detail}`);
  if (err) {
    if (err.stderr) console.error(`  原始错误: ${String(err.stderr).trim().split('\n').slice(-6).join('\n            ')}`);
    console.error(`  错误信息: ${err && err.message ? err.message : String(err)}`);
  }
  if (hint) console.error(`  建议   : ${hint}`);
  console.error(`${LOG_PREFIX} 中止（resources/ 处于不完整状态，请勿打包）。`);
  process.exit(1);
}

function sha256File(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
function human(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(2)} KiB`;
  return `${(b / 1024 / 1024).toFixed(2)} MiB`;
}
function walkFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}
function dirStats(dir) {
  const files = walkFiles(dir);
  const bytes = files.reduce((s, f) => { try { return s + fs.statSync(f).size; } catch { return s; } }, 0);
  return { files: files.length, bytes };
}
function findFile(root, name, maxDepth = 8) {
  const stack = [[root, 0]];
  while (stack.length) {
    const [d, depth] = stack.pop();
    if (depth > maxDepth) continue;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return p;
      if (e.isDirectory()) stack.push([p, depth + 1]);
    }
  }
  return null;
}
function sameSize(a, b) {
  try { return fs.statSync(a).size === fs.statSync(b).size; } catch { return false; }
}
/** 幂等复制：目标已存在且大小相同则跳过。 */
function copyIfNeeded(src, dest, label) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!FORCE && fs.existsSync(dest) && sameSize(src, dest)) {
    ok(`跳过（已存在且大小一致）: ${label}  ${human(fs.statSync(dest).size)}`);
    return 'skipped';
  }
  fs.copyFileSync(src, dest);
  ok(`复制: ${label}  ${human(fs.statSync(dest).size)}`);
  return 'copied';
}

/**
 * 递归修复产物文件权限（chmod -R u+rwX）。
 * 背景：本机 NAS 上 npm 安装产物的 st_mode 报 0000，Node 的 fs.cpSync / copyFileSync 会把这个
 * 模式原样 fchmod 到新文件上，导致复制出来的文件在构建机上真的不可读（zip / cat 报 EACCES，
 * zip 退出码 18 并静默丢文件）。Windows 不使用 Unix 权限位，这里统一 u+rwX 只为让打包工具能读。
 */
function fixPerms(dir) {
  if (!fs.existsSync(dir)) return { ok: false, reason: `${dir} 不存在` };
  try {
    execFileSync('chmod', ['-R', 'u+rwX', dir], { stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
/** 找出目录内不可读的常规文件（最多返回 limit 个路径）。 */
function findUnreadable(dir, limit = 5) {
  const bad = [];
  for (const f of walkFiles(dir)) {
    try { fs.accessSync(f, fs.constants.R_OK); } catch { bad.push(f); if (bad.length >= limit) break; }
  }
  return bad;
}

/** 下载：先直连（HTTP/1.1 → HTTP/2），失败再加代理重试。 */
function download(url, dest, { proxy = null, label = '' } = {}) {
  if (!FORCE && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    const size = fs.statSync(dest).size;
    const sha = sha256File(dest);
    downloadLog.push({ label, url, mode: 'cache-hit', ok: true, bytes: size, sha256: sha, fromCache: true });
    ok(`缓存命中: ${label}  ${size} B (${human(size)})  ${path.relative(WIN_DIR, dest)}`);
    return dest;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const base = ['--tlsv1.2', '-fL', '--retry', '3', '--retry-delay', '2',
    '--connect-timeout', '30', '--max-time', '1800', '-o', dest];
  const attempts = [
    { name: 'http1.1 直连', args: ['--http1.1', ...base] },
    { name: 'http2 直连', args: ['--http2', ...base] },
  ];
  if (proxy) {
    attempts.push({ name: `http1.1 代理 ${proxy}`, args: ['--http1.1', ...base, '-x', proxy] });
    attempts.push({ name: `http2 代理 ${proxy}`, args: ['--http2', ...base, '-x', proxy] });
  }
  const errors = [];
  const t0 = Date.now();
  for (const a of attempts) {
    try {
      execFileSync('curl', [...a.args, url], { stdio: ['ignore', 'pipe', 'pipe'] });
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const size = fs.statSync(dest).size;
      const sha = sha256File(dest);
      const usedProxy = a.name.includes('代理');
      downloadLog.push({ label, url, mode: a.name, ok: true, bytes: size, seconds: elapsed, sha256: sha, proxy: usedProxy ? proxy : null });
      ok(`✓ ${label}`);
      ok(`  URL    : ${url}${usedProxy ? `   (经代理 ${proxy})` : '   (直连)'}`);
      ok(`  方式   : ${a.name}${errors.length ? `（回退 ${errors.length} 次后成功）` : ''}`);
      ok(`  结果   : ${size} B (${human(size)}) / ${elapsed}s / sha256=${sha}`);
      return dest;
    } catch (err) {
      const msg = (err.stderr ? String(err.stderr).trim() : '') || err.message || String(err);
      errors.push(`${a.name}: ${msg.split('\n').filter(Boolean).slice(-2).join(' | ')}`);
      warn(`${label}: ${a.name} 失败 → ${errors[errors.length - 1]}`);
    }
  }
  downloadLog.push({ label, url, mode: 'FAILED', ok: false, errors, proxy: proxy || null });
  fail(`下载 ${label}`, `URL=${url}${proxy ? `（已尝试直连与代理 ${proxy}）` : ''}`,
    new Error(errors.join('\n            ')),
    '检查网络/镜像可达性；GitHub release 需要代理 -x http://127.0.0.1:7890；本步骤失败后其余步骤不会执行。');
}

function run(cmd, args, { cwd = REPO_ROOT, env = null, label = '' } = {}) {
  log(`$ ${cmd} ${args.join(' ')}${cwd !== REPO_ROOT ? `   (cwd=${cwd})` : ''}`);
  try {
    const out = execFileSync(cmd, args, {
      cwd, env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    });
    return out.toString();
  } catch (err) {
    fail(label || `执行 ${cmd}`, `命令=${cmd} ${args.join(' ')}  cwd=${cwd}`, err);
  }
}

function extractTarGz(tgz, destDir, label) {
  fs.mkdirSync(destDir, { recursive: true });
  run('tar', ['-xzf', tgz, '-C', destDir], { label: `解压 ${label}（tar -xzf）` });
}
function extractZip(zipFile, destDir, label) {
  fs.mkdirSync(destDir, { recursive: true });
  const which = spawnSync('bash', ['-lc', 'command -v unzip'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) {
    run('unzip', ['-o', '-q', zipFile, '-d', destDir], { label: `解压 ${label}（unzip）` });
    return;
  }
  warn('未找到 unzip，改用 python3 zipfile 解压');
  run('python3', ['-c', 'import sys,zipfile;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zipFile, destDir],
    { label: `解压 ${label}（python3 zipfile）` });
}

function main() {
  console.log('='.repeat(72));
  console.log(`${LOG_PREFIX} ScreenPlay 桌面端 · Windows 后端资源组装`);
  console.log(`  仓库根       : ${REPO_ROOT}`);
  console.log(`  缓存         : ${CACHE}`);
  console.log(`  npm 缓存     : ${NPM_CACHE}`);
  console.log(`  资源输出     : ${RESOURCES}`);
  console.log(`  Node 运行时  : v${NODE_VERSION} win-x64（ABI ${BETTER_SQLITE3_ABI}）`);
  console.log(`  模式         : ${FORCE ? '--force（强制重做）' : '幂等（已存在则跳过并校验大小）'}`);
  console.log('='.repeat(72));

  for (const d of [CACHE, RESOURCES, RES_BACKEND, RES_NODE, RES_BIN, NPM_CACHE]) fs.mkdirSync(d, { recursive: true });

  // --------------------------------------------------------- 1. backend-pkg/package.json
  const backendPkgPath = path.join(REPO_ROOT, 'backend', 'package.json');
  if (!fs.existsSync(backendPkgPath)) fail('读取 backend/package.json', `文件不存在：${backendPkgPath}`);
  let backendPkg;
  try { backendPkg = JSON.parse(fs.readFileSync(backendPkgPath, 'utf8')); }
  catch (err) { fail('解析 backend/package.json', backendPkgPath, err, '确认 JSON 语法正确。'); }

  const deps = backendPkg.dependencies || {};
  const depNames = Object.keys(deps).sort();
  if (depNames.length !== 18) {
    warn(`backend/package.json dependencies 期望 18 个，实际 ${depNames.length} 个：${depNames.join(', ')}`);
  }
  const depsHash = crypto.createHash('sha256').update(JSON.stringify(deps)).digest('hex').slice(0, 16);
  fs.mkdirSync(PKG_DIR, { recursive: true });
  const winPkg = {
    name: 'screenplay-backend-win-deps',
    version: backendPkg.version || '1.0.0',
    private: true,
    description: 'Windows x64 production dependency closure for ScreenPlay backend (generated by prepare-backend.mjs)',
    dependencies: deps,
  };
  fs.writeFileSync(path.join(PKG_DIR, 'package.json'), JSON.stringify(winPkg, null, 2) + '\n', 'utf8');
  log(`step 1: 生成 windows/.cache/backend-pkg/package.json（${depNames.length} 个依赖，不含 devDependencies，depsHash=${depsHash}）`);
  stepLog.push(`step 1 生成 backend-pkg/package.json：${depNames.length} 个依赖 depsHash=${depsHash}`);

  // --------------------------------------------------------- 2. npm install（win32-x64）
  const nmDir = path.join(PKG_DIR, 'node_modules');
  const installStamp = path.join(PKG_DIR, '.install-stamp');
  const installOk = fs.existsSync(path.join(nmDir, 'better-sqlite3')) && fs.existsSync(installStamp) &&
    fs.readFileSync(installStamp, 'utf8').trim() === depsHash;
  if (skipNpmInstall && installOk) {
    log('step 2: --skip-npm-install，复用已有 node_modules');
    stepLog.push('step 2 npm install：跳过（--skip-npm-install）');
  } else if (!FORCE && installOk) {
    log(`step 2: 幂等跳过 npm install（node_modules 已存在且 depsHash=${depsHash} 匹配）`);
    stepLog.push('step 2 npm install：跳过（幂等命中）');
  } else {
    log('step 2: npm install（win32-x64 生产依赖，registry.npmmirror.com）');
    // 上一次未完成的 node_modules 先清理，保证依赖闭包干净可复现
    if (fs.existsSync(nmDir)) {
      log('    清理上次残留的 node_modules（保证干净闭包）');
      fs.rmSync(nmDir, { recursive: true, force: true });
    }
    // 注意 1：本机 npm_config_cache 环境变量无效，必须显式传 --cache（可写目录）
    // 注意 2：必须 --ignore-scripts。原因是 npm 的 --os/--cpu 只影响「可选依赖的选取」，
    //         安装脚本仍按宿主平台（Linux）执行：better-sqlite3 的 prebuild-install 找不到
    //         linux 预编译就会退回 node-gyp 源码编译，而构建机没有 cc → 失败。
    //         本方案本来就用官方 win32-x64 预编译（step 4）替换二进制，所以脚本无需执行。
    const npmArgs = ['install', '--omit=dev', '--include=optional', '--os=win32', '--cpu=x64', '--ignore-scripts',
      `--registry=${REGISTRY}`, `--cache=${NPM_CACHE}`, '--no-audit', '--no-fund', '--loglevel=warn'];
    const env = { ...process.env, npm_config_os: 'win32', npm_config_cpu: 'x64' };
    const out = run('npm', npmArgs, { cwd: PKG_DIR, env, label: 'npm install（win32-x64 生产依赖, --ignore-scripts）' });
    const trimmed = out.trim();
    if (trimmed) console.log(trimmed.split('\n').map((l) => `      ${l}`).join('\n'));
    fs.writeFileSync(installStamp, depsHash + '\n', 'utf8');
    log('step 2: npm install 完成（--ignore-scripts：原生模块由 step 4 用官方 win32-x64 预编译替换）');
    stepLog.push('step 2 npm install：完成（--ignore-scripts + win32-x64 预编译替换 better-sqlite3）');
  }
  const nmCount = dirStats(nmDir);
  if (!fs.existsSync(path.join(nmDir, 'better-sqlite3'))) {
    fail('校验 npm install 结果', `${path.join(nmDir, 'better-sqlite3')} 不存在`,
      null, '确认 npm install 是否真的成功（见上面的 npm 输出）。');
  }
  log(`    node_modules：${nmCount.files} 个文件 / ${human(nmCount.bytes)}`);

  // --------------------------------------------------------- 3. 复制 node_modules → resources/backend
  log('step 3: 同步 node_modules → resources/backend/node_modules');
  const resNm = path.join(RES_BACKEND, 'node_modules');
  const stampsDir = path.join(CACHE, 'stamps');
  fs.mkdirSync(stampsDir, { recursive: true });
  const copyStamp = path.join(stampsDir, 'node_modules-copy.stamp');
  const resNmStats0 = dirStats(resNm);
  // stamp 形如 "<depsHash>:<同步后文件数>"（文件数取清理符号链接之后的计数，保证下次能命中幂等）
  const [stampHash, stampFiles] = fs.existsSync(copyStamp)
    ? fs.readFileSync(copyStamp, 'utf8').trim().split(':')
    : [null, null];
  const copyOk = stampHash === depsHash && Number(stampFiles) === resNmStats0.files && resNmStats0.files > 0;
  if (!FORCE && copyOk) {
    log(`    幂等跳过：已同步（${resNmStats0.files} 个文件 / ${human(resNmStats0.bytes)}）`);
    stepLog.push('step 3 同步 node_modules：跳过（幂等命中）');
  } else {
    try {
      fs.rmSync(resNm, { recursive: true, force: true });
      fs.cpSync(nmDir, resNm, { recursive: true, dereference: true });
    } catch (err) {
      fail('复制 node_modules', `${nmDir} → ${resNm}`, err, '检查磁盘空间（需 >1 GB 空闲）与权限。');
    }
    stepLog.push('step 3 同步 node_modules：完成');
  }
  const nmCopied = dirStats(resNm);
  log(`    完成：${nmCopied.files} 个文件 / ${human(nmCopied.bytes)}`);

  // node_modules/.bin 里的符号链接对 Windows 运行时无用，且 zip 解压后在 Windows 上会变成
  // 0 字节文件，容易引起误解 → 直接从产物里剔除（backend/dist/main.js 不依赖 .bin）。
  {
    const links = [];
    const stack2 = [resNm];
    while (stack2.length) {
      const d = stack2.pop();
      let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of es) {
        const p = path.join(d, e.name);
        if (e.isSymbolicLink()) links.push(p);
        else if (e.isDirectory()) stack2.push(p);
      }
    }
    for (const l of links) { try { fs.unlinkSync(l); } catch (err) { warn(`删除符号链接失败 ${l}: ${err.message}`); } }
    log(`    清理产物内符号链接 ${links.length} 个（node_modules/.bin 的 win32 无关 shim）`);
    stepLog.push(`step 3b 清理 node_modules 内符号链接：${links.length} 个`);
  }

  // --------------------------------------------------------- 4. better-sqlite3 预编译
  log(`step 4: better-sqlite3 win32-x64 预编译（v${BETTER_SQLITE3_VERSION} / ABI ${BETTER_SQLITE3_ABI}）`);
  const bsTgz = path.join(CACHE, `better-sqlite3-v${BETTER_SQLITE3_VERSION}-node-v${BETTER_SQLITE3_ABI}-win32-x64.tar.gz`);
  download(URL_BETTER_SQLITE3, bsTgz, { proxy: PROXY, label: 'better-sqlite3 官方预编译 tarball' });
  const bsExtract = path.join(CACHE, 'better-sqlite3-extract');
  if (FORCE) fs.rmSync(bsExtract, { recursive: true, force: true });
  const bsExtracted = fs.existsSync(bsExtract) ? findFile(bsExtract, 'better_sqlite3.node') : null;
  if (bsExtracted && !FORCE) {
    ok(`解压缓存命中：${path.relative(bsExtract, bsExtracted)}`);
  } else {
    extractTarGz(bsTgz, bsExtract, 'better-sqlite3 预编译');
  }
  const bsNode = findFile(bsExtract, 'better_sqlite3.node');
  if (!bsNode) fail('定位 better_sqlite3.node', `在 ${bsExtract} 内未找到 better_sqlite3.node`,
    null, '可能是 tarball 布局变化；请检查压缩包内容。');
  const bsDest = path.join(RES_BACKEND, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  copyIfNeeded(bsNode, bsDest, 'better_sqlite3.node → backend/node_modules/better-sqlite3/build/Release/');
  stepLog.push('step 4 better-sqlite3 预编译：就位');

  // --------------------------------------------------------- 5. Node 运行时 node.exe
  log(`step 5: Node 运行时 node.exe（v${NODE_VERSION} win-x64）`);
  const nodeZip = path.join(CACHE, `node-v${NODE_VERSION}-win-x64.zip`);
  let nodeDlOk = !FORCE && fs.existsSync(nodeZip) && fs.statSync(nodeZip).size > 0;
  if (nodeDlOk) {
    download(NODE_URLS[0], nodeZip, { label: 'node win-x64 zip' });
  } else {
    const errs = [];
    for (const u of NODE_URLS) {
      try { download(u, nodeZip, { label: `node win-x64 zip (${new URL(u).host})` }); nodeDlOk = true; break; }
      catch (err) { errs.push(`${u}: ${err.message}`); } // download 内部已 fail，这里不会执行
    }
    if (!nodeDlOk) fail('下载 node 运行时', NODE_URLS.join(' / '), new Error(errs.join('\n')), '直连与 npmmirror 镜像均失败。');
  }
  const nodeExtract = path.join(CACHE, 'node-extract');
  if (FORCE) fs.rmSync(nodeExtract, { recursive: true, force: true });
  if (!findFile(nodeExtract, 'node.exe')) extractZip(nodeZip, nodeExtract, 'node win-x64 zip');
  else ok('解压缓存命中：node.exe');
  const nodeExe = findFile(nodeExtract, 'node.exe');
  if (!nodeExe) fail('定位 node.exe', `在 ${nodeExtract} 内未找到 node.exe`, null, 'zip 布局可能变化。');
  copyIfNeeded(nodeExe, path.join(RES_NODE, 'node.exe'), 'node.exe → resources/node/node.exe（仅 node.exe，其余文件不带以省体积）');
  stepLog.push('step 5 node.exe：就位');

  // --------------------------------------------------------- 6. ffmpeg / ffprobe
  for (const [name, urls, tarball] of [
    ['ffmpeg', FFMPEG_TGZ_URLS, `ffmpeg-installer-win32-x64.tgz`],
    ['ffprobe', FFPROBE_TGZ_URLS, `ffprobe-installer-win32-x64.tgz`],
  ]) {
    const pkgName = name === 'ffmpeg' ? FFMPEG_PKG : FFPROBE_PKG;
    log(`step 6: ${name}.exe（${pkgName}）`);
    const tgz = path.join(CACHE, tarball);
    if (!FORCE && fs.existsSync(tgz) && fs.statSync(tgz).size > 0) {
      download(urls[0], tgz, { label: `${name} tgz（缓存）` });
    } else {
      let done = false;
      for (const u of urls) {
        try { download(u, tgz, { label: `${name} tgz (${new URL(u).host})` }); done = true; break; }
        catch (err) { /* download 内部 fail，正常不会走到这里 */ }
      }
      if (!done) {
        // 备用路径：npm pack（环境已实测可达）
        warn(`${name}: tarball 直链失败，改用 npm pack ${pkgName}`);
        const out = run('npm', ['pack', pkgName, `--registry=${REGISTRY}`, `--cache=${NPM_CACHE}`, '--loglevel=error'],
          { cwd: CACHE, label: `npm pack ${pkgName}` });
        const packed = out.trim().split('\n').filter(Boolean).pop();
        const packedPath = path.join(CACHE, packed);
        if (!packed || !fs.existsSync(packedPath)) {
          fail(`npm pack ${pkgName}`, `未找到产物 ${packedPath}`, null, `确认 ${REGISTRY} 可达。`);
        }
        fs.renameSync(packedPath, tgz);
        ok(`npm pack 成功 → ${path.relative(WIN_DIR, tgz)} (${human(fs.statSync(tgz).size)})`);
        downloadLog.push({ label: `${name} tgz (npm pack)`, url: `${REGISTRY}/${pkgName}`, mode: 'npm-pack', ok: true, bytes: fs.statSync(tgz).size });
      }
    }
    const ex = path.join(CACHE, `${name}-extract`);
    if (FORCE) fs.rmSync(ex, { recursive: true, force: true });
    if (!findFile(ex, `${name}.exe`)) extractTarGz(tgz, ex, `${name} tgz`);
    else ok(`解压缓存命中：${name}.exe`);
    const exe = findFile(ex, `${name}.exe`);
    if (!exe) fail(`定位 ${name}.exe`, `在 ${ex} 内未找到 ${name}.exe`, null, 'tarball 布局可能变化（预期 package/' + name + '.exe）。');
    copyIfNeeded(exe, path.join(RES_BIN, `${name}.exe`), `${name}.exe → resources/bin/`);
  }
  stepLog.push('step 6 ffmpeg/ffprobe：就位');

  // --------------------------------------------------------- 7. backend/dist + package.json
  log('step 7: 复制 backend/dist 与 backend/package.json（只读仓库，不修改）');
  const backendDist = path.join(REPO_ROOT, 'backend', 'dist');
  if (!fs.existsSync(path.join(backendDist, 'main.js'))) {
    fail('校验 backend/dist', `缺少 ${path.join(backendDist, 'main.js')}`, null, '先执行 npm run build:backend（nest build）。');
  }
  const srcDistStats = dirStats(backendDist);
  const dstDist = path.join(RES_BACKEND, 'dist');
  const distStamp = path.join(CACHE, 'stamps', 'backend-dist.stamp');
  const distOk = fs.existsSync(distStamp) && fs.readFileSync(distStamp, 'utf8').trim() === `${srcDistStats.files}:${srcDistStats.bytes}` &&
    dirStats(dstDist).files === srcDistStats.files;
  if (!FORCE && distOk) {
    log(`    幂等跳过：backend/dist 已同步（${srcDistStats.files} 个文件 / ${human(srcDistStats.bytes)}）`);
  } else {
    try {
      fs.rmSync(dstDist, { recursive: true, force: true });
      fs.cpSync(backendDist, dstDist, { recursive: true, dereference: true });
    } catch (err) {
      fail('复制 backend/dist', `${backendDist} → ${dstDist}`, err);
    }
    fs.writeFileSync(distStamp, `${srcDistStats.files}:${srcDistStats.bytes}\n`, 'utf8');
  }
  copyIfNeeded(backendPkgPath, path.join(RES_BACKEND, 'package.json'), 'backend/package.json → resources/backend/package.json');
  const distStats = dirStats(dstDist);
  log(`    backend/dist：${distStats.files} 个文件 / ${human(distStats.bytes)}`);
  stepLog.push(`step 7 backend/dist：${distStats.files} 个文件 / ${human(distStats.bytes)}`);

  // --------------------------------------------------------- 8. build-info.json
  const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const hashPath = path.join(REPO_ROOT, '.source-hash');
  const sourceHash = fs.existsSync(hashPath) ? fs.readFileSync(hashPath, 'utf8').trim() : null;
  const buildInfo = {
    version: rootPkg.version,
    sourceHash,
    builtAt: new Date().toISOString(),
    nodeVersion: NODE_VERSION,
  };
  fs.writeFileSync(path.join(RESOURCES, 'build-info.json'), JSON.stringify(buildInfo, null, 2) + '\n', 'utf8');
  log(`step 8: 写入 build-info.json：${JSON.stringify(buildInfo)}`);
  stepLog.push(`step 8 build-info.json：${JSON.stringify(buildInfo)}`);

  // --------------------------------------------------------- 8b. 修复产物权限
  log('step 8b: 修复产物文件权限（chmod -R u+rwX）');
  log('    原因：本机 NAS 上 npm 产物的 st_mode 为 0000，Node 复制时会把它传播给新文件，');
  log('    结果 resources 内文件在构建机上不可读，make-portable 打包时 zip 会报 Permission denied。');
  const permFix = fixPerms(RESOURCES);
  if (!permFix.ok) {
    fail('修复产物权限（chmod）', `chmod -R u+rwX ${RESOURCES}`, null, permFix.reason);
  }
  const unreadable = findUnreadable(RESOURCES);
  if (unreadable.length) {
    fail('修复产物权限（校验）', `仍有不可读文件`, null,
      `${unreadable.join('、')}\n（若在 Windows / macOS 上运行请忽略此项；Linux 上请检查挂载选项是否为 ro 或 nosuid。）`);
  }
  log('    校验：resources 内所有文件均可读 ✓');
  stepLog.push('step 8b 修复产物权限：chmod -R u+rwX 完成，全部文件可读');

  // 幂等 stamp 在全部写出动作之后落盘：内容 = "<depsHash>:<node_modules 最终文件数>"。
  // （必须在 step 4 写入 better_sqlite3.node 之后再记，否则下次运行文件数不等 → 幂等永不命中。）
  fs.writeFileSync(copyStamp, `${depsHash}:${dirStats(resNm).files}\n`, 'utf8');
  log(`    幂等 stamp：${path.relative(WIN_DIR, copyStamp)} = ${depsHash}:${dirStats(resNm).files}`);

  // --------------------------------------------------------- 9. 校验（DESIGN §4.4）
  log('step 9: 校验关键文件');
  const required = [
    ['node/node.exe', path.join(RES_NODE, 'node.exe')],
    ['backend/dist/main.js', path.join(RES_BACKEND, 'dist', 'main.js')],
    ['backend/package.json', path.join(RES_BACKEND, 'package.json')],
    ['backend/node_modules/better-sqlite3/build/Release/better_sqlite3.node', bsDest],
    ['backend/node_modules/sharp/**', path.join(RES_BACKEND, 'node_modules', 'sharp')],
    ['backend/node_modules/@img/sharp-win32-x64/**', path.join(RES_BACKEND, 'node_modules', '@img', 'sharp-win32-x64')],
    ['bin/ffmpeg.exe', path.join(RES_BIN, 'ffmpeg.exe')],
    ['bin/ffprobe.exe', path.join(RES_BIN, 'ffprobe.exe')],
    ['build-info.json', path.join(RESOURCES, 'build-info.json')],
  ];
  const missing = [];
  for (const [label, p] of required) {
    const exists = fs.existsSync(p);
    console.log(`    ${exists ? '✓' : '✗'} ${label}`);
    if (!exists) missing.push(label);
  }
  if (missing.length) fail('校验关键文件（DESIGN §4.4）', `缺失：${missing.join(', ')}`, null, '重新运行本脚本（可加 --force）。');
  const sharpWinFiles = walkFiles(path.join(RES_BACKEND, 'node_modules', '@img', 'sharp-win32-x64'));
  log(`    @img/sharp-win32-x64：${sharpWinFiles.length} 个文件（含 ${sharpWinFiles.filter((f) => f.endsWith('.node')).length} 个 .node）`);

  // --------------------------------------------------------- 10. 报告
  hr();
  console.log('  下载记录');
  for (const d of downloadLog) {
    console.log(`    ${d.ok ? '✓' : '✗'} ${d.label} [${d.mode}] ${d.ok ? `${d.bytes} B (${human(d.bytes)})` : 'FAILED'}`);
    console.log(`        ${d.url}${d.proxy ? `   代理=${d.proxy}` : ''}${d.fromCache ? '   (缓存命中，未重新下载)' : ''}`);
  }
  hr();
  console.log('  步骤摘要');
  for (const s of stepLog) console.log(`    · ${s}`);
  hr();
  console.log('  resources/ 体积清单（顶层项）');
  const tops = fs.readdirSync(RESOURCES, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  let totalBytes = 0;
  let totalFiles = 0;
  for (const e of tops) {
    const p = path.join(RESOURCES, e.name);
    if (e.isDirectory()) {
      const s = dirStats(p);
      totalBytes += s.bytes; totalFiles += s.files;
      console.log(`    ${(e.name + '/').padEnd(16)} ${String(s.files).padStart(7)} files  ${(s.bytes / 1024 / 1024).toFixed(2).padStart(9)} MiB`);
    } else {
      const sz = fs.statSync(p).size;
      totalBytes += sz; totalFiles += 1;
      console.log(`    ${e.name.padEnd(16)} ${String(1).padStart(7)} file   ${(sz / 1024 / 1024).toFixed(2).padStart(9)} MiB`);
    }
  }
  console.log(`    ${'合计'.padEnd(16)} ${String(totalFiles).padStart(7)} files  ${(totalBytes / 1024 / 1024).toFixed(2).padStart(9)} MiB  (${totalBytes} B)`);
  hr();
  console.log(`  单独计量`);
  console.log(`    resources/backend/node_modules : ${nmCopied.files} files / ${(nmCopied.bytes / 1024 / 1024).toFixed(2)} MiB`);
  console.log(`    resources/backend/dist         : ${distStats.files} files / ${(distStats.bytes / 1024 / 1024).toFixed(2)} MiB`);
  console.log(`    windows/.cache（下载缓存）      : ${dirStats(CACHE).files} files / ${(dirStats(CACHE).bytes / 1024 / 1024).toFixed(2)} MiB`);
  hr();
  log(`完成：${RESOURCES}`);
}

main();