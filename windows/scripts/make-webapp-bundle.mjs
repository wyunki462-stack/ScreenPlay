/**
 * make-webapp-bundle.mjs — 组装「零工具链」免安装 zip（备用方案）
 * ------------------------------------------------------------------
 * 与 make-portable.mjs 的区别：
 *   · make-portable.mjs 需要先有 Tauri 编译出的 ScreenPlay.exe（主方案）；
 *   · 本脚本**不需要任何编译产物**：只用已组装好的 `src-tauri/resources/`（后端 + 前端 +
 *     Node 运行时 + ffmpeg）加上 `launcher/`（launch.mjs + ScreenPlay.cmd），打成一个
 *     解压即用的 zip。双击 `ScreenPlay.cmd` 即启动，Edge/Chrome 以 `--app=` 模式开一个
 *     无地址栏窗口，关闭窗口后自动回收后端。
 *
 * 产物：windows/dist/ScreenPlay_<version>_x64-webapp.zip
 * 只用 Node 内置模块 + 系统命令（zip/unzip/chmod/cp），不新增 npm 依赖。
 *
 * 用法：
 *   node windows/scripts/make-webapp-bundle.mjs            # 组装
 *   node windows/scripts/make-webapp-bundle.mjs --list     # 只列出已有产物
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WIN_DIR = path.resolve(__dirname, '..');
const RES = path.join(WIN_DIR, 'src-tauri', 'resources');
const LAUNCHER = path.join(WIN_DIR, 'launcher');
const DIST = path.join(WIN_DIR, 'dist');
const STAGE = path.join(WIN_DIR, '.cache', 'webapp-staging');
const LOG = '[make-webapp-bundle]';
const MAX_ZIP = 200 * 1024 * 1024; // 200 MiB

const log = (m) => console.log(`${LOG} ${m}`);
const warn = (m) => console.warn(`${LOG} WARN ${m}`);
const human = (b) => `${(b / 1024 / 1024).toFixed(2)} MiB`;

const version = JSON.parse(fs.readFileSync(path.join(WIN_DIR, 'package.json'), 'utf8')).version;
const ZIP_NAME = `ScreenPlay_${version}_x64-webapp.zip`;

function fail(step, detail, extra) {
  console.error(`\n${LOG} ✗ 失败于「${step}」`);
  if (detail) console.error(`   ${detail}`);
  if (extra) console.error(`   ${extra}`);
  console.error(`${LOG} 本次未生成任何 zip（不伪造产物）。`);
  process.exit(1);
}

function canRead(p) {
  try { fs.accessSync(p, fs.constants.R_OK); return true; } catch { return false; }
}

function fixPerms(p) {
  try {
    const st = fs.statSync(p);
    const mode = st.isDirectory() ? 0o755 : 0o644;
    fs.chmodSync(p, mode);
  } catch { /* ignore */ }
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const USAGE_TXT = `ScreenPlay Windows 免安装版（浏览器窗口模式）
=================================================

一、怎么用
  1. 把整个文件夹解压到任意位置（不要放在 C:\\Program Files 这类需要管理员权限的目录）；
  2. 双击 ScreenPlay.cmd；
  3. 第一次启动会等几秒（后端要建数据库、扫描媒体库），随后会弹出一个
     没有地址栏的窗口，那就是 ScreenPlay 本体；
  4. 关闭该窗口即退出，后端子进程会被一起回收。

  若系统提示缺少 WebView2：本方案用的是 Edge/Chrome 的 --app 模式，
  只要装过 Edge（Win10/11 自带）即可，无需额外安装。

二、数据放在哪
  默认：%APPDATA%\\ScreenPlay（数据库 screenplay.db、海报、缩略图、缓存都在这里）。
  想改到别的盘（例如 D:\\ScreenPlay-data）：在本目录新建 config.json，写
      { "dataDir": "D:\\\\ScreenPlay-data" }
  可选键（与 Tauri 安装版的 config.json 键名一致）：
      "port": 3000            固定端口（不写则由系统分配空闲端口）
      "auth": "off"           登录开关：off（默认，直接进入界面）/ local（本机账户）/ system
      "mediaDirs": ["D:\\\\Games\\\\shots", "E:\\\\PS5"]   媒体根目录（不写则用 <数据目录>\\media）
      "adminPassword": "..."  仅 auth=local 时可用，指定管理员密码（不写则首次启动随机生成并打印）

三、登录
  默认关闭登录（auth=off，即 AUTH_DISABLED=1）。想开启：把 config.json 里的
  "auth" 改成 "local"（旧写法 "authDisabled": false 也认）后再启动。
  首次启动会生成随机管理员密码，**在启动窗口里打印一次**，同时写入
  <数据目录>\\launcher.log；登录后请立即修改密码。

四、媒体库
  启动后进入「设置 → 媒体库」添加你的截图/视频根目录即可（与 Web 端完全一致）。
  刮削、成就、远程图片代理需要能访问外网；本地库扫描、缩略图、视频播放不需要外网。
  ffmpeg.exe / ffprobe.exe 已随包内置（resources\\bin\\）。

五、和 Tauri 安装包的关系
  本 zip 是「零工具链」备用方案；如果你用 build-windows.ps1 在 Windows 上编译过，
  会额外得到 NSIS 安装包与便携包（ScreenPlay_<版本>_x64-portable.zip），
  那两个是原生窗口 + 单实例，推荐优先使用。

六、排查
  · 启动窗口一闪而过：在该目录按住 Shift 右键 →「在此处打开 PowerShell 窗口」，
    然后运行 .\\ScreenPlay.cmd，就能看到完整报错。
  · 端口被占用：写 config.json 换一个 port，或删掉 port 让它自动选。
`;

function main() {
  if (process.argv.includes('--list')) {
    if (!fs.existsSync(DIST)) return log('windows/dist 不存在（还没有任何产物）');
    const files = fs.readdirSync(DIST).filter((f) => f.endsWith('.zip'));
    if (!files.length) return log('windows/dist 里没有 zip');
    for (const f of files) log(`${f}  ${human(fs.statSync(path.join(DIST, f)).size)}`);
    return;
  }

  // ------------------------------------------------- 0. 前置检查
  if (!fs.existsSync(path.join(RES, 'backend', 'dist', 'main.js'))) {
    fail('检查 resources', `缺少 ${path.join(RES, 'backend', 'dist', 'main.js')}`,
      '请先执行：node windows/scripts/prepare-backend.mjs && node windows/scripts/prepare-frontend.mjs');
  }
  if (!fs.existsSync(path.join(RES, 'web', 'index.html'))) {
    fail('检查 resources', `缺少 ${path.join(RES, 'web', 'index.html')}`,
      '请先执行：node windows/scripts/prepare-frontend.mjs');
  }
  for (const f of ['launch.mjs', 'ScreenPlay.cmd']) {
    if (!fs.existsSync(path.join(LAUNCHER, f))) fail('检查 launcher', `缺少 ${path.join(LAUNCHER, f)}`);
  }

  // ------------------------------------------------- 1. staging
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  log(`step 1: staging → ${STAGE}`);

  // cp -al：硬链接复制，零额外磁盘占用（resources 已在 prepare 阶段 chmod 过，这里只读不改）
  try {
    execFileSync('cp', ['-al', RES, path.join(STAGE, 'resources')], { stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (err) {
    warn(`cp -al 失败（${err.message}），退回真实复制`);
    fs.cpSync(RES, path.join(STAGE, 'resources'), { recursive: true });
  }
  fs.mkdirSync(path.join(STAGE, 'launcher'), { recursive: true });
  for (const f of ['launch.mjs', 'ScreenPlay.cmd']) {
    fs.copyFileSync(path.join(LAUNCHER, f), path.join(STAGE, 'launcher', f));
  }
  fs.writeFileSync(path.join(STAGE, 'ScreenPlay.cmd'), fs.readFileSync(path.join(LAUNCHER, 'ScreenPlay.cmd')));
  fs.writeFileSync(path.join(STAGE, '使用说明.txt'), `\ufeff${USAGE_TXT.replace(/\n/g, '\r\n')}`);
  fs.writeFileSync(path.join(STAGE, 'config.example.json'),
    `${JSON.stringify({ dataDir: 'D:\\\\ScreenPlay-data', port: 3000, auth: 'off', mediaDirs: ['D:\\\\Games\\\\shots'] }, null, 2)}\n`);
  // 注意：config.example.json 只是样例，launcher 读的是同目录的 config.json
  //（包根 config.json 优先，其次 <数据目录>\\config.json；两个都不存在就全用默认）

  // ------------------------------------------------- 2. 可读性预检
  // NAS 上新建文件权限为 0：zip 会静默丢文件，所以先统一修复再逐个确认。
  execFileSync('chmod', ['-R', 'u+rwX', STAGE], { stdio: 'ignore' });
  const unreadable = walk(STAGE).filter((p) => !canRead(p)).slice(0, 5);
  if (unreadable.length) fail('可读性预检', `以下文件不可读：${unreadable.join('、')}`);
  const staged = walk(STAGE).length;
  log(`   staging 就绪：ScreenPlay.cmd + launcher/ + resources/ + 使用说明.txt（${staged} 个文件，全部可读 ✓）`);

  // ------------------------------------------------- 3. zip
  fs.mkdirSync(DIST, { recursive: true });
  const outZip = path.join(DIST, ZIP_NAME);
  fs.rmSync(outZip, { force: true });
  const zipArgs = ['-r', '-9', '-q', outZip, 'ScreenPlay.cmd', 'launcher', 'resources', '使用说明.txt', 'config.example.json'];
  log(`step 2: $ zip ${zipArgs.join(' ')}   (cwd=${path.relative(WIN_DIR, STAGE)})`);
  try {
    execFileSync('zip', zipArgs, { cwd: STAGE, stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (err) {
    fail('打包 zip', `zip ${zipArgs.join(' ')}`, err.message);
  }
  if (!fs.existsSync(outZip)) fail('打包 zip', `命令成功但未生成 ${outZip}`);
  try { fs.chmodSync(outZip, 0o644); } catch (err) { warn(`chmod 0644 失败：${err.message}`); }
  if (!canRead(outZip)) { fixPerms(outZip); if (!canRead(outZip)) fail('可读性', `${outZip} 生成后不可读`); }

  // ------------------------------------------------- 4. 校验
  let names = [];
  try {
    // unzip -l 在 11000+ 条目时会超 Node 默认 maxBuffer → 用 -Z1 只列名字
    names = execFileSync('unzip', ['-Z1', outZip], { maxBuffer: 64 * 1024 * 1024 })
      .toString().split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (err) {
    fail('校验 zip', 'unzip -Z1 失败', err.message);
  }
  const required = [
    'ScreenPlay.cmd', '使用说明.txt', 'config.example.json',
    'launcher/launch.mjs',
    'resources/node/node.exe',
    'resources/backend/dist/main.js',
    'resources/backend/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    'resources/backend/node_modules/sharp/package.json',
    'resources/web/index.html',
    'resources/bin/ffmpeg.exe',
    'resources/bin/ffprobe.exe',
    'resources/build-info.json',
  ];
  const missing = required.filter((r) => !names.includes(r));
  if (missing.length) fail('校验 zip', `产物缺少必需条目：${missing.join('、')}`);
  if (names.length < staged) {
    fail('校验 zip', `zip 内条目 ${names.length} 少于 staging 的 ${staged} 个文件（可能静默丢文件）`);
  }
  const size = fs.statSync(outZip).size;
  log(`step 3: 产物 ${path.relative(WIN_DIR, outZip)}  ${human(size)}  条目 ${names.length}（必需条目 ${required.length}/12 ✓）`);
  if (size > MAX_ZIP) warn(`产物超过 ${human(MAX_ZIP)} 的参考上限（当前 ${human(size)}）`);
  else log(`   ✓ 体积在 ${human(MAX_ZIP)} 参考上限之内`);
  log('完成。把该 zip 拷到 Windows 上解压，双击 ScreenPlay.cmd 即可运行（无需 Rust/编译）。');
}

main();