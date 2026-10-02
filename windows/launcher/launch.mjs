#!/usr/bin/env node
/**
 * ScreenPlay 免安装启动器（零工具链备用方案）
 * ------------------------------------------------------------------
 * 用途：当目标 Windows 机器上**没有 Rust/构建工具链**、或不想装 NSIS 安装包时，
 * 直接双击 `ScreenPlay.cmd` 就能用。它做四件事（全部逻辑都在这里，.cmd 只是一行壳）：
 *
 *   1. 选一个空闲端口（净绑定 127.0.0.1:0 由系统分配，避免端口冲突）；
 *   2. 用随包发布的 `resources/node/node.exe` 拉起 `resources/backend/dist/main.js`
 *      （数据目录、WEB_DIST、ffmpeg 路径等全部沿用后端既有环境变量，不重复实现任何后端逻辑）；
 *   3. 轮询 `GET /api/health` 直到后端就绪（最多 60 秒）；
 *   4. 用 Edge/Chrome 的 `--app=` 模式打开一个**无地址栏的窗口**（看起来就是个桌面应用），
 *      并带独立 `--user-data-dir`（语言/布局等前端本地存储可持久化）。窗口关闭后回收后端子进程树。
 *
 * 与 Tauri 壳的关系：Tauri（`src-tauri/`）是**主方案**，提供真正的原生窗口与单实例；
 * 本启动器是**备用方案**，不需要任何编译产物，用同一份 `resources/` 即可运行。
 *
 * 环境变量（便于本机自测，Windows 上无需设置）：
 *   SP_NODE=<node 可执行文件>   覆盖 resources/node/node.exe（例如本机 node）
 *   SP_NO_BROWSER=1            不打开浏览器，只启动后端并打印地址（等待 Ctrl+C）
 *   SP_BROWSER=<浏览器可执行文件>  覆盖自动探测结果
 *   SP_SKIP_SMOKE=1            跳过启动后的 /api/health 断言
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === 'win32';

/**
 * 定位「包根目录」（含 resources/ 的那一层）。三种布局都支持：
 *   1) 免安装 zip： <包>/launcher/launch.mjs + <包>/resources/   → 根 = HERE 的上级
 *   2) 壳内捆绑：   <包>/launcher/launch.mjs + <包>/launcher/resources/（若将来挪进 launcher）→ 根 = HERE
 *   3) 仓库源码：   windows/launcher/launch.mjs + windows/src-tauri/resources/  → 根 = HERE/../src-tauri
 */
function findRoot() {
  const up = path.dirname(HERE);
  const candidates = [
    [HERE, path.join(HERE, 'resources')],
    [up, path.join(up, 'resources')],
    [path.join(HERE, '..', 'src-tauri'), path.join(HERE, '..', 'src-tauri', 'resources')],
  ];
  for (const [root, res] of candidates) {
    if (fs.existsSync(path.join(res, 'backend', 'dist', 'main.js'))) return root;
  }
  return up;
}
const ROOT = findRoot();
const RES = path.join(ROOT, 'resources');

function log(msg) { process.stdout.write(`[ScreenPlay] ${msg}\n`); }
function die(msg) { process.stderr.write(`[ScreenPlay] 错误：${msg}\n`); process.exit(1); }

/* ---------------------------------------------------------------- 配置 */

/** 读取包根目录的 config.json（可选，键与 Tauri 壳一致）：
 *  { "dataDir": "D:\\ScreenPlay-data", "port": 3000, "authDisabled": true } */
function readConfig() {
  const p = path.join(ROOT, 'config.json');
  if (!fs.existsSync(p)) return {};
  try {
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    log(`已读取 config.json：${p}`);
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch (e) {
    die(`config.json 不是合法 JSON：${e.message}`);
  }
}

const cfg = readConfig();

function defaultDataDir() {
  const base = process.env.APPDATA || process.env.LOCALAPPDATA || os.homedir();
  return path.join(base, 'ScreenPlay');
}

// 数据目录优先级：环境变量 DATA_DIR（与后端同名，便于脚本/自测覆盖） > config.json 的 dataDir > %APPDATA%\ScreenPlay
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : cfg.dataDir ? path.resolve(String(cfg.dataDir)) : defaultDataDir();

/* ------------------------------------------------------------ 空闲端口 */

function pickPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/* ------------------------------------------------------------ 路径检查 */

const nodeExe = process.env.SP_NODE
  || path.join(RES, 'node', isWin ? 'node.exe' : 'node');
const entry = path.join(RES, 'backend', 'dist', 'main.js');
const webDist = path.join(RES, 'web');
const ffmpeg = path.join(RES, 'bin', isWin ? 'ffmpeg.exe' : 'ffmpeg');

for (const [label, p] of [['Node 运行时', nodeExe], ['后端入口', entry], ['前端产物', webDist]]) {
  if (!fs.existsSync(p)) die(`缺少${label}：${p}\n  请先在本仓库执行：node windows/scripts/prepare-backend.mjs && node windows/scripts/prepare-frontend.mjs`);
}

/* --------------------------------------------------------- 启动后端 */

function killTree(pid) {
  if (!pid) return;
  if (isWin) {
    // 后端可能拉起 ffmpeg 子进程，按进程树回收
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
  }
}

function health(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function findBrowser() {
  if (process.env.SP_BROWSER) return process.env.SP_BROWSER;
  if (!isWin) return null;
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const wantPort = Number(cfg.port) > 0 ? Number(cfg.port) : 0;
  const port = wantPort || (await pickPort());
  const authDisabled = cfg.authDisabled === undefined ? true : !!cfg.authDisabled;

  log(`数据目录：${DATA_DIR}`);
  log(`后端端口：${port}${wantPort ? '（来自 config.json）' : '（系统分配的空闲端口）'}`);

  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    NODE_ENV: 'production',
    DATA_DIR,
    WEB_DIST: webDist,
    MAINTENANCE_ON_BOOT: '0',
    BUILD_VERSION: '1.0.0-desktop-portable',
    AUTH_DISABLED: authDisabled ? '1' : '0',
    ...(fs.existsSync(ffmpeg) ? { FFMPEG_PATH: ffmpeg } : {}),
  };
  // AUTH_DISABLED=1 时不需要账户库；否则后端按既有逻辑读系统账户或回退本地账户。

  const child = spawn(nodeExe, [entry], {
    cwd: path.join(RES, 'backend'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !isWin, // 非 Windows 下建独立进程组，便于整组回收
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => process.stdout.write(`  [backend] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`  [backend] ${d}`));
  child.on('exit', (code) => {
    if (!shuttingDown) log(`后端进程已退出（code=${code}）`);
  });

  let shuttingDown = false;
  const shutdown = (why) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`正在关闭（${why}）…`);
    killTree(child.pid);
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', () => shutdown('Ctrl+C'));
  process.on('SIGTERM', () => shutdown('收到终止信号'));

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  let ready = null;
  process.stdout.write('[ScreenPlay] 正在等待后端就绪 …\n');
  while (Date.now() < deadline) {
    ready = await health(port);
    if (ready) break;
    if (child.exitCode !== null) die(`后端启动失败（退出码 ${child.exitCode}），请查看上面的日志`);
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!ready) die('后端 60 秒内没有通过健康检查，请查看上面的日志');

  if (process.env.SP_SKIP_SMOKE !== '1') {
    log(`后端就绪：version=${ready.version} status=${ready.status} 功能标记=${(ready.features || []).length} 个`);
  }

  if (process.env.SP_NO_BROWSER === '1') {
    log(`已跳过浏览器（SP_NO_BROWSER=1）。请在浏览器打开：${url}`);
    await new Promise(() => {}); // 等待 Ctrl+C
    return;
  }

  const browser = findBrowser();
  const profileDir = path.join(DATA_DIR, 'browser');
  if (browser) {
    fs.mkdirSync(profileDir, { recursive: true });
    log(`以应用窗口模式启动：${browser}`);
    const args = [
      `--app=${url}`,
      `--user-data-dir=${profileDir}`,
      '--window-size=1280,900',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,DefaultBrowserSettingEnforcement',
    ];
    const win = spawn(browser, args, { stdio: 'ignore', detached: false });
    win.on('exit', () => shutdown('窗口已关闭'));
    win.on('error', (e) => die(`无法启动浏览器：${e.message}`));
  } else {
    log('未找到 Edge/Chrome，改用系统默认浏览器打开。');
    if (isWin) {
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
    log(`请在浏览器打开：${url}（本窗口保持运行，按 Ctrl+C 退出）`);
    await new Promise(() => {});
  }
}

main().catch((e) => die(e?.stack || String(e)));