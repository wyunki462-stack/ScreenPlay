#!/usr/bin/env node
/**
 * ScreenPlay Windows 桌面端 · Node 侧构建编排（build-windows.mjs）
 * ---------------------------------------------------------------------------
 * 作用：给「没有 PowerShell / CI / Linux 主机 / 只想脚本化」的场景提供与
 *       build-windows.ps1 等价的编排能力：
 *         1) preflight 环境自检（Node / npm / Rust / Tauri CLI / WebView2 / 网络 / 磁盘）
 *         2) 依次执行 prepare:frontend、prepare:backend
 *         3) 调 Tauri CLI 构建（npx tauri build）
 *         4) 调 scripts/make-portable.mjs 组装免安装包
 *       任一步失败都给出中文可读错误 + 日志文件位置，并以非 0 退出码结束。
 *
 * 用法（在 windows\ 目录下执行）：
 *   node scripts/build-windows.mjs                  # 完整构建
 *   node scripts/build-windows.mjs --skip-tauri     # 不碰 Rust：只跑 prepare + 便携包
 *   node scripts/build-windows.mjs --preflight-only # 只做环境自检
 *   npm run build:win -- --skip-tauri               # 通过 npm script 传参
 *
 * 参数：
 *   --skip-install      跳过 npm install
 *   --skip-prepare      跳过 prepare:frontend / prepare:backend
 *   --skip-tauri        跳过 Tauri 构建（不需要 Rust）
 *   --no-portable       跳过 make-portable.mjs（只出 NSIS 安装包）
 *   --preflight-only    只做环境自检后退出
 *   --dry-run           只打印将要执行的命令，不真正执行
 *   --help              显示帮助
 *
 * 依赖：只用 Node 内置模块（node:fs / node:child_process / node:path ...），不装任何包。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, writeSync, closeSync, statfsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** windows\ 目录（项目根，一切相对它解析） */
const ROOT = path.resolve(__dirname, '..');
/** 仓库根（web/ backend/ 所在处） */
const REPO_ROOT = path.resolve(ROOT, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const IS_WIN = process.platform === 'win32';

const MIN_NODE_MAJOR = 20;
const RECOMMENDED_FREE_GB = 15;

const WEBVIEW2_KEYS = [
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKCU\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
];

// ----------------------------------------------------------------- 参数解析
const argv = process.argv.slice(2);
const FLAGS = {
  skipInstall: argv.includes('--skip-install'),
  skipPrepare: argv.includes('--skip-prepare'),
  skipTauri: argv.includes('--skip-tauri'),
  noPortable: argv.includes('--no-portable'),
  preflightOnly: argv.includes('--preflight-only'),
  dryRun: argv.includes('--dry-run'),
  help: argv.includes('--help') || argv.includes('-h'),
};

const KNOWN_FLAGS = [
  '--skip-install', '--skip-prepare', '--skip-tauri', '--no-portable',
  '--preflight-only', '--dry-run', '--help', '-h',
];
const unknownFlags = argv.filter((a) => a.startsWith('-') && !KNOWN_FLAGS.includes(a));

if (FLAGS.help) {
  printHelp();
  process.exit(0);
}

function printHelp() {
  const lines = [
    'ScreenPlay Windows 桌面端 · Node 构建编排',
    '',
    '用法: node scripts/build-windows.mjs [选项]',
    '',
    '选项:',
    '  --skip-install       跳过 npm install（假定 node_modules 已就绪）',
    '  --skip-prepare       跳过 prepare:frontend / prepare:backend',
    '  --skip-tauri         跳过 Tauri 构建（无需 Rust；便携包需已有 ScreenPlay.exe）',
    '  --no-portable        跳过便携版打包（只出 NSIS 安装包）',
    '  --preflight-only     只做环境自检，不做任何构建',
    '  --dry-run            只打印将要执行的命令',
    '  --help               显示本帮助',
    '',
    '示例:',
    '  node scripts/build-windows.mjs --skip-tauri    # 只想先打包便携版',
    '  node scripts/build-windows.mjs --preflight-only',
    '',
    '等价脚本: windows\\build-windows.ps1（Windows 一键构建，推荐双击 build-windows.cmd）',
    '文档: windows\\docs\\BUILD-WINDOWS.md',
  ];
  console.log(lines.join('\n'));
}

// ----------------------------------------------------------------- 日志
if (!existsSync(DIST_DIR)) mkdirSync(DIST_DIR, { recursive: true });

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const STAMP = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
const LOG_PATH = path.join(DIST_DIR, `build-${STAMP}.log`);

let logFd = null;
try {
  logFd = openSync(LOG_PATH, 'w');
} catch (err) {
  console.error(`[警告] 无法创建日志文件 ${LOG_PATH}: ${err.message}`);
}

/** 同时写屏幕与日志文件的输出函数 */
function out(text) {
  process.stdout.write(text);
  if (logFd !== null) {
    try { writeSync(logFd, text); } catch { /* 忽略日志写失败 */ }
  }
}
function log(line = '') {
  out(`${line}\n`);
}

function closeLog() {
  if (logFd !== null) {
    try { closeSync(logFd); } catch { /* ignore */ }
    logFd = null;
  }
}

// ----------------------------------------------------------------- 进程工具
function quoteArg(a) {
  return /\s/.test(a) ? `"${a}"` : a;
}

/** 同步探测一个短命令（版本号之类），返回 { ok, text } */
function probe(command, args, { timeout = 20000 } = {}) {
  const res = spawnSync(command, args, {
    encoding: 'utf8',
    shell: IS_WIN,
    timeout,
    windowsHide: true,
  });
  if (res.error) return { ok: false, text: '', error: res.error.message };
  const text = `${res.stdout || ''}${res.stderr || ''}`.trim();
  return { ok: res.status === 0, text, status: res.status };
}

/** 流式执行一步（输出实时进屏幕 + 日志） */
function runStep(title, command, args, { hint = '', cwd = ROOT, env = process.env } = {}) {
  return new Promise((resolve) => {
    log('');
    log('------------------------------------------------------------');
    log(`>> ${title}`);
    log(`   命令: ${command} ${args.map(quoteArg).join(' ')}`);
    log(`   目录: ${cwd}`);
    log('------------------------------------------------------------');

    if (FLAGS.dryRun) {
      log('   [dry-run] 未执行');
      resolve(true);
      return;
    }

    const started = Date.now();
    const child = spawn(command, args, { cwd, env, shell: IS_WIN, windowsHide: false });
    let spawnError = null;
    let settled = false;

    const onData = (buf) => out(buf.toString('utf8'));

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    child.on('error', (err) => {
      spawnError = err;
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      const secs = Math.round((Date.now() - started) / 1000);
      if (spawnError) {
        log('');
        log(`  [!!] 无法启动: ${command} —— ${spawnError.message}`);
        FAILED.step = title;
        FAILED.hint = `无法启动 ${command}：请确认它已安装并在 PATH 中（安装后需重开终端）。`;
        resolve(false);
        return;
      }
      if (code !== 0) {
        log('');
        log(`  [!!] 失败步骤: ${title}`);
        log(`       退出码  : ${code}`);
        log(`       耗时    : ${secs} 秒`);
        FAILED.step = title;
        FAILED.hint = hint;
        resolve(false);
        return;
      }
      log(`  [OK] ${title} 完成（耗时 ${secs} 秒）`);
      resolve(true);
    });
  });
}

const FAILED = { step: '', hint: '' };

function failBanner(code = 1) {
  log('');
  log('============================================================');
  log(`  构建失败：${FAILED.step || '未知步骤'}`);
  log('============================================================');
  log(`  原始错误 : ${FAILED.hint || '见日志中的 [!!] 标记行'}`);
  log(`  日志文件 : ${LOG_PATH}`);
  log('  排查建议 :');
  log('    1) 打开上面的日志文件，搜索 "[!!]" 与 "error"，看第一处失败。');
  log('    2) 网络下载失败：改用镜像/代理（registry.npmmirror.com / mirrors.tencent.com / -x http://127.0.0.1:7890）。');
  log('    3) Rust / 链接器报错：需 rustup（MSVC 工具链）+ Visual Studio「使用 C++ 的桌面开发」。');
  log('    4) 缺 WebView2 运行时：https://developer.microsoft.com/microsoft-edge/webview2/');
  log('    5) 只想先打包便携版：加 --skip-tauri 重跑。');
  log(`  完整文档 : ${path.join(ROOT, 'docs', 'BUILD-WINDOWS.md')}`);
  closeLog();
  process.exit(code);
}

// ----------------------------------------------------------------- 网络探测
async function probeNetwork() {
  const targets = [
    ['npm 镜像 registry.npmmirror.com', 'https://registry.npmmirror.com/'],
    ['GitHub github.com', 'https://github.com/'],
  ];
  const results = [];
  for (const [name, url] of targets) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      await fetch(url, { method: 'HEAD', signal: ctrl.signal, redirect: 'manual' });
      results.push({ name, ok: true, detail: '' });
    } catch (err) {
      results.push({ name, ok: false, detail: err?.message || String(err) });
    } finally {
      clearTimeout(timer);
    }
  }
  return results;
}

// ----------------------------------------------------------------- WebView2
function detectWebView2() {
  if (!IS_WIN) return { found: false, detail: '非 Windows 平台，跳过' };
  for (const key of WEBVIEW2_KEYS) {
    const res = probe('reg', ['query', key, '/v', 'pv'], { timeout: 8000 });
    if (res.ok) {
      const m = res.text.match(/pv\s+REG_SZ\s+([^\s]+)/i);
      if (m) return { found: true, detail: m[1] };
    }
  }
  const roots = [
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'EdgeWebView', 'Application') : null,
    process.env['ProgramFiles'] ? path.join(process.env['ProgramFiles'], 'Microsoft', 'EdgeWebView', 'Application') : null,
  ].filter(Boolean);
  for (const r of roots) {
    if (!existsSync(r)) continue;
    try {
      const hit = readdirSync(r).find((d) => existsSync(path.join(r, d, 'msedgewebview2.exe')));
      if (hit) return { found: true, detail: `${path.join(r, hit)}` };
    } catch { /* ignore */ }
  }
  return { found: false, detail: '注册表与文件系统均未发现' };
}

// ----------------------------------------------------------------- 磁盘空间
function freeSpaceGB(dir) {
  try {
    const st = statfsSync(dir);
    return Math.round(((st.bsize * st.bavail) / 1024 ** 3) * 10) / 10;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------- preflight
async function preflight() {
  const blockers = [];
  const warnings = [];

  log('---------- [1/5] 环境自检 (preflight) ----------');

  // Node.js
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor >= MIN_NODE_MAJOR) {
    log(`  [OK] Node.js v${process.versions.node}（${process.execPath}）`);
  } else {
    log(`  [!!] Node.js v${process.versions.node} 版本过低（需要 >= ${MIN_NODE_MAJOR}）`);
    blockers.push(`Node.js 版本过低（当前 v${process.versions.node}）。请安装 Node.js 20/22 LTS：https://nodejs.org/`);
  }

  // npm
  const npm = probe('npm', ['--version']);
  if (npm.ok) log(`  [OK] npm ${npm.text}`);
  else {
    log('  [!!] 未找到 npm');
    blockers.push('未找到 npm。它随 Node.js 一起安装；若装了 Node 仍失败，请检查 PATH。');
  }

  // Rust 工具链
  const rustc = probe('rustc', ['-V']);
  const cargo = probe('cargo', ['-V']);
  if (rustc.ok) log(`  [OK] ${rustc.text}`);
  else log('  [!!] 未找到 rustc');
  if (cargo.ok) log(`  [OK] ${cargo.text}`);
  else log('  [!!] 未找到 cargo');
  if (!rustc.ok || !cargo.ok) {
    if (FLAGS.skipTauri) {
      log('  [--] 缺少 Rust，但已指定 --skip-tauri，本次不调用 Tauri 构建。');
      warnings.push('缺少 Rust 工具链：已用 --skip-tauri 跳过；便携包需要已存在的 ScreenPlay.exe 才能成功。');
    } else {
      blockers.push('未找到 Rust 工具链（rustc/cargo）。安装 https://rustup.rs/（Windows 选 MSVC 工具链）后重开终端重试；或加 --skip-tauri 只打包便携版。');
    }
  }

  // cargo-xwin（Linux 交叉编译方案相关，仅提示）
  if (cargo.ok) {
    const xwin = probe('cargo', ['xwin', '--version'], { timeout: 25000 });
    if (xwin.ok) {
      log(`  [OK] cargo-xwin 可用（${xwin.text}）—— 可在 Linux 上尝试交叉编译，见 docs/BUILD-WINDOWS.md 路径三`);
    } else {
      log('  [--] 未安装 cargo-xwin（仅 Linux 交叉编译方案需要：cargo install cargo-xwin）');
    }
  }

  // Tauri CLI
  const tauriCliDir = path.join(ROOT, 'node_modules', '@tauri-apps', 'cli');
  const tauriCliLocal = existsSync(tauriCliDir);
  if (tauriCliLocal) {
    log('  [OK] @tauri-apps/cli（windows/node_modules 已安装）');
  } else {
    log('  [--] @tauri-apps/cli 未安装，稍后将执行 npm install');
    if (FLAGS.skipInstall && !FLAGS.skipTauri) {
      blockers.push('windows/node_modules/@tauri-apps/cli 不存在，但指定了 --skip-install。请先执行：npm install --ignore-scripts');
    }
  }

  // WebView2
  const wv2 = detectWebView2();
  if (wv2.found) {
    log(`  [OK] WebView2 运行时: ${wv2.detail}`);
  } else if (IS_WIN) {
    log(`  [!!] 未检测到 Microsoft Edge WebView2 运行时（${wv2.detail}）`);
    blockers.push('未检测到 WebView2 运行时（构建后程序会打不开）。安装常青版引导程序：https://developer.microsoft.com/microsoft-edge/webview2/ （直连 https://go.microsoft.com/fwlink/p/?LinkId=2124703）');
  } else {
    log(`  [--] WebView2 检查跳过（${wv2.detail}；仅在 Windows 上需要）`);
  }

  // ffmpeg（可选）
  const ffmpegLocal = path.join(ROOT, 'src-tauri', 'resources', 'bin', 'ffmpeg.exe');
  if (existsSync(ffmpegLocal)) {
    log('  [OK] src-tauri/resources/bin/ffmpeg.exe 已就绪（随包分发）');
  } else if (probe('ffmpeg', ['-version'], { timeout: 8000 }).ok) {
    log('  [--] 仅检测到系统 ffmpeg；打包会自带一份，不影响构建');
  } else {
    log('  [--] 未检测到 ffmpeg / ffprobe（不阻塞构建）');
    warnings.push('ffmpeg/ffprobe 未就绪：由 prepare-backend.mjs 下载 Windows 版到 resources/bin；若被网络阻断请配置镜像/代理。');
  }

  // 磁盘空间
  const freeGB = freeSpaceGB(ROOT);
  if (freeGB !== null) {
    if (freeGB < 8) {
      log(`  [--] 磁盘剩余空间偏少: ${freeGB} GB（建议 >= ${RECOMMENDED_FREE_GB} GB）`);
      warnings.push(`磁盘剩余 ${freeGB} GB，Rust 编译 + 资源组装建议预留 ${RECOMMENDED_FREE_GB} GB 以上。`);
    } else {
      log(`  [OK] 磁盘剩余空间: ${freeGB} GB`);
    }
  }

  // 网络
  if (!FLAGS.preflightOnly && !FLAGS.dryRun) {
    const net = await probeNetwork();
    for (const n of net) {
      if (n.ok) {
        log(`  [OK] 网络可达: ${n.name}`);
      } else {
        log(`  [--] 网络不可达: ${n.name}（${n.detail}）`);
        warnings.push(`无法访问 ${n.name}：请改用镜像/代理（registry.npmmirror.com、mirrors.tencent.com，GitHub 资源加 -x http://127.0.0.1:7890），详见 docs/BUILD-WINDOWS.md。`);
      }
    }
  }

  for (const w of warnings) log(`  [警告] ${w}`);
  return blockers;
}

// ----------------------------------------------------------------- 主流程
async function main() {
  log('============================================================');
  log('  ScreenPlay Windows 桌面端 - Node 构建编排');
  log('============================================================');
  log(`  项目根     : ${ROOT}`);
  log(`  仓库根     : ${REPO_ROOT}`);
  log(`  日志文件   : ${LOG_PATH}`);
  log(`  运行平台   : ${os.platform()} ${os.release()} (${os.arch()})`);
  log(`  Node       : v${process.versions.node}`);
  log(`  开始时间   : ${now.toISOString()}`);
  const skipList = Object.entries(FLAGS)
    .filter(([k, v]) => v === true && k !== 'dryRun' && k !== 'help')
    .map(([k]) => k);
  log(`  开关       : ${skipList.length ? skipList.join(', ') : '(无)'}`);

  if (unknownFlags.length) {
    log(`  [警告] 忽略未知参数: ${unknownFlags.join(' ')}（用 --help 查看支持项）`);
  }

  const blockers = await preflight();

  if (blockers.length > 0) {
    log('');
    log('环境自检未通过，构建终止：');
    blockers.forEach((b, i) => log(`  (${i + 1}) ${b}`));
    log('');
    log(`日志文件: ${LOG_PATH}`);
    log('提示: 只想先打便携包可加 --skip-tauri；完整说明见 windows/docs/BUILD-WINDOWS.md');
    closeLog();
    process.exit(2);
  }
  log('  环境自检通过。');

  if (FLAGS.preflightOnly) {
    log('');
    log(`环境自检通过，未执行任何构建（--preflight-only）。日志: ${LOG_PATH}`);
    closeLog();
    process.exit(0);
  }

  const npmArgsBase = ['--no-audit', '--no-fund'];

  // ------------------------------------------------ [2/5] npm install
  log('');
  log('---------- [2/5] 安装构建依赖 (npm install) ----------');
  const nodeModules = path.join(ROOT, 'node_modules');
  const tauriCliDir = path.join(ROOT, 'node_modules', '@tauri-apps', 'cli');
  if (FLAGS.skipInstall) {
    log('  [--] 已指定 --skip-install，跳过。');
  } else if (existsSync(nodeModules) && existsSync(tauriCliDir)) {
    log('  [--] node_modules 与 @tauri-apps/cli 均已存在，跳过 npm install（强制重装请删除 windows/node_modules）');
  } else {
    // --ignore-scripts：npm 会在 `npm install` 时自动执行名为 prepare 的生命周期脚本，
    // 会把真正的准备工作跑两遍（失败还会连带 install 失败），故显式关闭。
    const ok = await runStep('安装构建依赖（npm install --ignore-scripts）', 'npm',
      ['install', '--ignore-scripts', ...npmArgsBase],
      { hint: 'npm install 失败：多为网络问题。改用镜像 registry.npmmirror.com，或配置代理，见 docs/BUILD-WINDOWS.md。' });
    if (!ok) failBanner(1);
  }

  // ------------------------------------------------ [3/5] prepare
  log('');
  log('---------- [3/5] 准备资源 (prepare:frontend / prepare:backend) ----------');
  if (FLAGS.skipPrepare) {
    log('  [--] 已指定 --skip-prepare，跳过。');
  } else {
    const missing = ['prepare-frontend.mjs', 'prepare-backend.mjs']
      .filter((f) => !existsSync(path.join(ROOT, 'scripts', f)));
    if (missing.length) {
      log(`  [!!] 缺少准备工作脚本: ${missing.map((m) => `scripts/${m}`).join(', ')}`);
      log('       这些脚本负责组装 resources/（前端精简版 + Windows 版后端），缺失时无法产出可分发产物。');
      FAILED.step = '准备资源（缺少 scripts/*.mjs）';
      FAILED.hint = `缺少 ${missing.map((m) => `windows/scripts/${m}`).join(' 与 ')}，请补齐后再构建。`;
      failBanner(1);
    }
    log('  说明: prepare:frontend 生成桌面精简版 web 资源；prepare:backend 组装 Windows 版后端。');

    const okFront = await runStep('前端精简（npm run prepare:frontend）', 'npm', ['run', 'prepare:frontend'],
      { hint: 'prepare:frontend 失败：先在仓库根执行 npm install / npm run build:web:desktop，确认 web 的桌面模式构建成功后再重试（无 dist-desktop 时加 --force-build）。' });
    if (!okFront) failBanner(1);

    const okBack = await runStep('后端组装（npm run prepare:backend）', 'npm', ['run', 'prepare:backend'],
      { hint: 'prepare:backend 失败：常见于 better-sqlite3 预编译包 / sharp win32 可选依赖 / ffmpeg 下载被网络阻断，见 docs/BUILD-WINDOWS.md。' });
    if (!okBack) failBanner(1);
  }

  // ------------------------------------------------ [4/5] tauri build
  log('');
  log('---------- [4/5] 构建安装包 (npx tauri build) ----------');
  if (FLAGS.skipTauri) {
    log('  [--] 已指定 --skip-tauri，跳过 Tauri 构建（便携包将使用已存在的 ScreenPlay.exe）。');
  } else {
    log('  说明: 首次运行会下载 Rust crate 并全量编译，通常 5-20 分钟；之后增量约 1-3 分钟。');
    const ok = await runStep('Tauri 构建（npx tauri build）', 'npx', ['tauri', 'build'],
      { hint: 'Tauri 构建失败：看上方最后一段 Rust 报错。缺 MSVC 链接器 -> 装 VS「使用 C++ 的桌面开发」；crate 下载失败 -> 配置 cargo 镜像/代理；若卡在下载 NSIS（github.com/tauri-apps/binary-releases/.../nsis-3.11.zip）-> 设置系统代理后重试，或见 docs/BUILD-WINDOWS.md 里的便携包方案。' });
    if (!ok) failBanner(1);
  }

  // ------------------------------------------------ [5/5] portable
  log('');
  log('---------- [5/5] 打包便携版 (scripts/make-portable.mjs) ----------');
  if (FLAGS.noPortable) {
    log('  [--] 已指定 --no-portable，跳过。');
  } else {
    const portableScript = path.join(ROOT, 'scripts', 'make-portable.mjs');
    if (!existsSync(portableScript)) {
      log('  [!!] 缺少 scripts/make-portable.mjs（负责组装免安装 zip）');
      FAILED.step = '便携版打包（缺少 scripts/make-portable.mjs）';
      FAILED.hint = '缺少 windows/scripts/make-portable.mjs，请补齐后再构建；或加 --no-portable 只出安装包。';
      failBanner(1);
    }
    const ok = await runStep('便携版打包（node scripts/make-portable.mjs）', process.execPath, ['scripts/make-portable.mjs'],
      { hint: '便携包打包失败：确认 src-tauri/target/release/ScreenPlay.exe 与 src-tauri/resources 已存在（即先跑 prepare 与 tauri build）。' });
    if (!ok) failBanner(1);
  }

  // ------------------------------------------------ 汇总
  log('');
  log('---------- 构建产物 ----------');
  const found = [];
  const nsisDir = path.join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
  const bundleDir = path.join(ROOT, 'src-tauri', 'target', 'release', 'bundle');
  for (const dir of [nsisDir, bundleDir, DIST_DIR]) {
    if (!existsSync(dir)) continue;
    try {
      for (const f of readdirSync(dir)) {
        if (/\.(exe|zip|msi)$/i.test(f)) {
          const full = path.join(dir, f);
          found.push(full);
        }
      }
    } catch { /* ignore */ }
  }
  const unique = [...new Set(found)];
  if (unique.length) {
    for (const f of unique) {
      let size = '';
      try {
        size = `  (${(statSync(f).size / 1024 / 1024).toFixed(1)} MB)`;
      } catch { /* ignore */ }
      log(`  * ${f}${size}`);
    }
  } else {
    log('  未在预期位置找到产物，请检查上面各步骤输出。');
  }

  log('');
  log('============================================================');
  log('  构建完成');
  log('============================================================');
  log(`  产物目录 : ${DIST_DIR}`);
  log(`  日志文件 : ${LOG_PATH}`);
  log(`  结束时间 : ${new Date().toISOString()}`);
  log('  下一步   : 双击安装包安装，或解压便携包后运行 ScreenPlay.exe；');
  log('             产物说明见 windows/docs/ARTIFACTS.md，功能对齐见 windows/docs/PARITY.md。');
  closeLog();
  process.exit(0);
}

main().catch((err) => {
  log('');
  log(`  [!!] 未捕获异常: ${err?.stack || err?.message || String(err)}`);
  FAILED.step = '编排脚本内部异常';
  FAILED.hint = err?.message || String(err);
  failBanner(1);
});