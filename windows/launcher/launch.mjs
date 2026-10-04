#!/usr/bin/env node
/**
 * ScreenPlay 免安装启动器（零工具链备用方案）
 * ------------------------------------------------------------------
 * 用途：当目标 Windows 机器上**没有 Rust/构建工具链**、或不想装 NSIS 安装包时，
 * 直接双击 `ScreenPlay.cmd` 就能用。它做四件事（全部逻辑都在这里，.cmd 只是一行壳）：
 *
 *   1. 选一个空闲端口（在本机地址上净绑定 0，由系统分配，避免端口冲突）；
 *   2. 用随包发布的 `resources/node/node.exe` 拉起 `resources/backend/dist/main.js`
 *      （数据目录、WEB_DIST、ffmpeg 路径等全部沿用后端既有环境变量，不重复实现任何后端逻辑）；
 *   3. 轮询 `GET /api/health` 直到后端就绪（最多 60 秒）；
 *   4. 用 Edge/Chrome 的 `--app=` 模式打开一个**无地址栏的窗口**（看起来就是个桌面应用），
 *      并带独立 `--user-data-dir`（语言/布局等前端本地存储可持久化）。窗口关闭后回收后端子进程树。
 *
 * 1.3.2：默认 `HOST=0.0.0.0`（同一局域网里的手机/平板/电视盒子可以直接访问），并在首次
 * 运行时提权加一条 Windows 防火墙入站放行规则（`ScreenPlay`，TCP 3210-3309），避免系统
 * 弹出「允许访问」对话框。`config.json` 里 `host: "127.0.0.1"` 可切回仅本机、`firewall: "off"`
 * 可让启动器完全不碰防火墙。
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

/**
 * 版号：构建期由 prepare-backend 写进 resources/build-info.json（{version, sourceHash, builtAt, nodeVersion}）。
 * 免安装包/便携包里它就在包根下，直接读；读不到（有人手改包内容）时退回 '0.0.0'，
 * 不写死某个具体版号——否则每次发版都会漏改，桌面端 /api/health 就报旧版本。
 */
function readBuildVersion() {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(RES, 'build-info.json'), 'utf8'));
    if (info && typeof info.version === 'string' && info.version.trim()) return info.version.trim();
  } catch { /* 文件缺失或 JSON 损坏：走下面的兜底 */ }
  return '0.0.0';
}

/* ---------------------------------------------------------------- 配置 */

function defaultDataDir() {
  const base = process.env.APPDATA || process.env.LOCALAPPDATA || os.homedir();
  return path.join(base, 'ScreenPlay');
}

/** 读取一个 config.json（不存在就返回 null，损坏就报错退出，避免静默改变数据目录）。 */
function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    log(`已读取配置：${file}`);
    return v && typeof v === 'object' ? v : null;
  } catch (e) {
    die(`配置文件不是合法 JSON：${file}（${e.message}）`);
  }
}

// 配置来源：包根目录 config.json（优先，随包分发/便携场景）→ <数据目录>/config.json（与 Tauri 壳同一位置）。
// 键名刻意与 Tauri 壳保持一致：dataDir / port / host / auth("off"|"local"|"system") / allowSetup /
// firewall("auto"|"off") / mediaDirs / adminPassword；另外接受 authDisabled(布尔) 作为便利别名。
const pkgCfg = readJson(path.join(ROOT, 'config.json')) || {};
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : pkgCfg.dataDir ? path.resolve(String(pkgCfg.dataDir)) : defaultDataDir();
const cfg = readJson(path.join(DATA_DIR, 'config.json')) || pkgCfg;

/** auth 归一化：兼容 "off"/false、"local"、true。 */
function authMode() {
  if (cfg.authDisabled !== undefined) return cfg.authDisabled ? 'off' : 'local';
  const a = String(cfg.auth ?? 'local').toLowerCase();
  if (a === 'system') return 'system';
  if (a === 'off' || a === 'false' || a === '0' || a === '') return 'off';
  return 'local';
}

/* ------------------------------------------------------------ 监听地址 */

/**
 * 监听地址：默认 `0.0.0.0`（局域网可访问，1.3.2 起），`127.0.0.1` 只认「仅本机」的写法。
 * 与 Tauri 壳 `windows/src-tauri/src/config.rs` 的 normalize() 保持一致。
 */
function bindHost() {
  const h = String(cfg.host ?? '0.0.0.0').trim().toLowerCase();
  return ['127.0.0.1', 'localhost', 'loopback', 'local-only', 'localonly'].includes(h)
    ? '127.0.0.1'
    : '0.0.0.0';
}

const HOST = bindHost();
// 安全不变量（与 Rust 壳一致）：对局域网开放就不允许「无鉴权」。
const AUTH = HOST === '0.0.0.0' && authMode() === 'off' ? 'local' : authMode();
const ALLOW_SETUP = cfg.allowSetup !== false;
const LAN = HOST !== '127.0.0.1';

/* ------------------------------------------------------------ 空闲端口 */

function pickPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    // 按真实监听地址探测：只探测 127.0.0.1 会在「别的进程恰好占着 0.0.0.0:端口」时误判。
    srv.listen(0, HOST, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/* -------------------------------------------------------- 防火墙默认放行 */

const FW_RULE = 'ScreenPlay';
const FW_FIRST = 3210;
const FW_LAST = 3309;
const FW_DIR = path.join(DATA_DIR, 'firewall');
const FW_SCRIPT = path.join(FW_DIR, 'allow-screenplay.ps1');
const FW_FLAG = path.join(FW_DIR, 'attempted.txt');

/** 端口段（与 `src-tauri/src/backend.rs` 的 FIRST_PORT/PORT_PROBE_RANGE 对齐）。 */
function firewallPorts(wantPort) {
  const base = `${FW_FIRST}-${FW_LAST}`;
  return wantPort > 0 && (wantPort < FW_FIRST || wantPort > FW_LAST) ? `${base},${wantPort}` : base;
}

/** 与 Rust 壳 `firewall.rs::write_script` 语义相同：先 New-NetFirewallRule，老系统退回 netsh。 */
function firewallScript(ports) {
  return [
    '# ScreenPlay — 免安装启动器首次运行时自动生成；管理员 PowerShell 可直接重跑本文件。',
    "$ErrorActionPreference = 'Stop'",
    `$name = '${FW_RULE}'`,
    `$ports = '${ports}'`,
    'try {',
    '  if (-not (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)) {',
    '    New-NetFirewallRule -DisplayName $name -Group $name -Direction Inbound -Action Allow `',
    '      -Protocol TCP -LocalPort $ports -Profile Any `',
    "      -Description 'ScreenPlay desktop (LAN access to the bundled server)' | Out-Null",
    '  }',
    '} catch {',
    '  netsh advfirewall firewall show rule name=$name *> $null',
    '  if ($LASTEXITCODE -ne 0) {',
    '    netsh advfirewall firewall add rule name=$name dir=in action=allow `',
    '      protocol=TCP localport=$ports profile=any | Out-Null',
    '  }',
    '}',
    'exit 0',
    '',
  ].join('\r\n');
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function firewallRuleExists() {
  if (!isWin) return false;
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `$r = Get-NetFirewallRule -DisplayName '${FW_RULE}' -ErrorAction SilentlyContinue; if ($r) { exit 0 } else { exit 3 }`],
    { stdio: 'ignore', windowsHide: true, timeout: 15_000 },
  );
  return r.status === 0;
}

/** 确保防火墙放行；失败只提示，不阻断启动（与 Tauri 壳行为一致）。 */
function ensureFirewall(wantPort) {
  if (!isWin || !LAN || String(cfg.firewall ?? 'auto').toLowerCase() === 'off') return;
  if (firewallRuleExists()) {
    log(`防火墙：已存在入站放行规则「${FW_RULE}」`);
    return;
  }
  if (fs.existsSync(FW_FLAG)) {
    log(`防火墙：此前已尝试放行（见 ${FW_FLAG}），本次不重复弹窗`);
    return;
  }
  const ports = firewallPorts(wantPort);
  try {
    fs.mkdirSync(FW_DIR, { recursive: true });
    fs.writeFileSync(FW_SCRIPT, firewallScript(ports), 'utf8');
  } catch (e) {
    log(`防火墙：无法写入 ${FW_SCRIPT}（${e.message}），本次跳过`);
    return;
  }
  log('防火墙：正在请求一次管理员授权以添加放行规则（只弹这一次）…');
  const elevate =
    `Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',` +
    `${psQuote(FW_SCRIPT)} -Verb RunAs -Wait -WindowStyle Hidden`;
  spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', elevate],
    { stdio: 'ignore', windowsHide: true, timeout: 180_000 },
  );
  try {
    fs.writeFileSync(FW_FLAG, `${new Date().toISOString()} — 已尝试自动放行（${FW_RULE} TCP ${ports}）。\r\n重新尝试：删除本文件后重启，或以管理员身份运行同目录的 ${path.basename(FW_SCRIPT)}。\r\n`, 'utf8');
  } catch { /* 标记文件写不出来最多下次再问一遍，不影响运行 */ }
  if (firewallRuleExists()) {
    log(`防火墙：已添加入站放行规则（TCP ${ports}）`);
  } else {
    log(`防火墙：未能自动放行，Windows 可能会弹出「允许访问」对话框，点允许即可；也可用管理员 PowerShell 运行 ${FW_SCRIPT}`);
  }
}

/** 局域网地址（给手机/平板抄地址用）。 */
function lanUrls(port) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(`http://${ni.address}:${port}`);
    }
  }
  return out;
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
  const auth = AUTH;

  // 「默认放行」：先把防火墙规则放好，再让后端开始监听，这样 Windows 不会弹
  // 「允许访问」对话框。失败（比如用户在 UAC 上点了否）不影响启动。
  ensureFirewall(wantPort);

  // 媒体目录：config.json 的 mediaDirs（字符串数组或分号分隔的字符串），
  // 否则退到 <数据目录>\media —— 必须显式给，否则后端会去扫 Linux 默认的 /media。
  const mediaDefault = path.join(DATA_DIR, 'media');
  const mediaDirs = Array.isArray(cfg.mediaDirs)
    ? cfg.mediaDirs.join(';')
    : typeof cfg.mediaDirs === 'string' ? cfg.mediaDirs : mediaDefault;
  if (mediaDirs === mediaDefault) {
    // 默认媒体目录不存在时先建出来，否则后端会跳过扫描并告警。
    try { fs.mkdirSync(mediaDefault, { recursive: true }); } catch { /* 建不出来就交给后端告警 */ }
  }

  log(`数据目录：${DATA_DIR}`);
  log(`媒体目录：${mediaDirs}`);
  log(`监听地址：${HOST}${LAN ? '（局域网可访问）' : '（仅本机）'}`);
  log(`后端端口：${port}${wantPort ? '（来自 config.json）' : '（系统分配的空闲端口）'}`);
  if (auth === 'off') {
    log('鉴权模式：off（仅本机监听时才可能，见 config.json 的 host）');
  } else if (auth === 'local' && ALLOW_SETUP) {
    log('鉴权模式：local —— 首次打开网页时创建账户（config.json 的 allowSetup=true）');
  } else {
    log(`鉴权模式：${auth}（开启后需登录；本机模式备用密码见 <数据目录>\\初始密码.txt 或后端日志）`);
  }

  const env = {
    ...process.env,
    PORT: String(port),
    HOST,
    NODE_ENV: 'production',
    DATA_DIR,
    MEDIA_DIRS: mediaDirs,
    WEB_DIST: webDist,
    MAINTENANCE_ON_BOOT: '0',
    BUILD_VERSION: `${readBuildVersion()}-desktop-portable`,
    ...(auth === 'off' ? { AUTH_DISABLED: '1' } : { AUTH_MODE: auth }),
    ...(auth === 'local' && ALLOW_SETUP ? { AUTH_ALLOW_SETUP: '1' } : {}),
    ...(auth === 'local' && !ALLOW_SETUP && cfg.adminPassword ? { AUTH_ADMIN_PASSWORD: String(cfg.adminPassword) } : {}),
    ...(fs.existsSync(ffmpeg) ? { FFMPEG_PATH: ffmpeg } : {}),
  };
  // auth=off 时不需要账户库（默认只在 host=127.0.0.1 时才可能出现）；local 时默认走
  // AUTH_ALLOW_SETUP=1，在网页上创建账户；关掉 allowSetup 时后端会自行播种 admin 并
  // **把随机密码打印到日志**，我们同时把后端输出落到 <数据目录>\\launcher.log，方便回查。

  const logFile = path.join(DATA_DIR, 'launcher.log');
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  logStream.write(`\n===== ${new Date().toISOString()} 启动（port=${port} auth=${auth}）=====\n`);

  const child = spawn(nodeExe, [entry], {
    cwd: path.join(RES, 'backend'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !isWin, // 非 Windows 下建独立进程组，便于整组回收
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { process.stdout.write(`  [backend] ${d}`); logStream.write(d); });
  child.stderr.on('data', (d) => { process.stderr.write(`  [backend] ${d}`); logStream.write(d); });
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

  if (LAN) {
    const lans = lanUrls(port);
    if (lans.length) log(`局域网访问地址：${lans.join('  ')}（同一局域网里的手机/平板直接填这个地址）`);
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