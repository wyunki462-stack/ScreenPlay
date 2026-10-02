#!/usr/bin/env node
/**
 * make-portable.mjs — 组装 ScreenPlay Windows 免安装（便携）zip。
 *
 * 契约：windows/DESIGN.md §9（产物）
 *   windows/dist/ScreenPlay_<version>_x64-portable.zip
 *     ├─ ScreenPlay.exe            Tauri 产物（windows/dist 下）
 *     ├─ resources/                内置后端 + node.exe + ffmpeg/ffprobe + 精简版 web/
 *     ├─ portable.flag             空文件：标记便携模式（DATA_DIR = <exeDir>\data）
 *     └─ 使用说明.txt               中文说明（UTF-8 BOM + CRLF，Windows 记事本友好）
 *
 * 若 windows/dist 下还没有 exe：打印明确提示并 exit 1（绝不伪造产物）。
 * 打包前做可读性预检：不可读文件会被 zip 静默丢弃（退出码 18），此处先自动 chmod 修复，仍不可读则失败。
 * 用法：node windows/scripts/make-portable.mjs
 * 只使用 Node 内置模块 + 系统命令（zip），不新增 npm 依赖。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WIN_DIR = path.resolve(__dirname, '..');
const DIST = path.join(WIN_DIR, 'dist');
const CACHE = path.join(WIN_DIR, '.cache');
const STAGE = path.join(CACHE, 'portable-staging');
const RESOURCES_CANDIDATES = [
  path.join(WIN_DIR, 'src-tauri', 'resources'),
  path.join(DIST, 'resources'),
];

const LOG_PREFIX = '[make-portable]';
function log(m) { console.log(`${LOG_PREFIX} ${m}`); }
function warn(m) { console.warn(`${LOG_PREFIX} WARN ${m}`); }
function human(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(2)} KiB`;
  return `${(b / 1024 / 1024).toFixed(2)} MiB`;
}
function walkFiles(dir) {
  const acc = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else acc.push(p);
    }
  }
  return acc;
}
function dirStats(dir) {
  const acc = walkFiles(dir);
  return { files: acc.length, bytes: acc.reduce((s, f) => { try { return s + fs.statSync(f).size; } catch { return s; } }, 0) };
}
function fail(step, detail, extra) {
  console.error(`\n${LOG_PREFIX} FAILED`);
  console.error(`  step   : ${step}`);
  console.error(`  detail : ${detail}`);
  if (extra) console.error(`  error  : ${extra}`);
  process.exit(1);
}

/** 递归修复文件权限（chmod -R u+rwX）。 */
function fixPerms(dir) {
  try {
    execFileSync('chmod', ['-R', 'u+rwX', dir], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
function canRead(p) {
  try { fs.accessSync(p, fs.constants.R_OK); return true; } catch { return false; }
}
/** 找出目录内不可读的常规文件（最多 limit 个）。 */
function findUnreadable(dir, limit = 5) {
  const bad = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        try { fs.accessSync(p, fs.constants.R_OK); } catch { bad.push(p); if (bad.length >= limit) return bad; }
      }
    }
  }
  return bad;
}

const USAGE_TXT = [
  'ScreenPlay Windows 免安装版 · 使用说明',
  '========================================',
  '',
  '一、怎么运行',
  '  1. 解压整个压缩包到任意目录（例如 D:\\ScreenPlay）。',
  '  2. 双击 ScreenPlay.exe 即可运行，无需安装。',
  '  3. 同目录下的 resources\\ 文件夹必须和 exe 放在一起，不能单独移动。',
  '',
  '二、数据放在哪里',
  '  · 本便携版的数据全部保存在 exe 同目录的 data\\ 文件夹里（数据库、海报、缩略图、日志等）。',
  '  · 想整体搬迁，直接把整个文件夹拷走即可。',
  '  · 想恢复“安装版”行为（数据放 %APPDATA%\\ScreenPlay），删掉便携标记文件 portable.flag',
  '    和 data\\ 文件夹即可。',
  '',
  '三、首次启动比较慢',
  '  · 第一次启动需要初始化数据库并扫描媒体库，可能需要几十秒到几分钟，请耐心等待',
  '    启动画面（显示“启动中”）。',
  '  · 之后启动会快很多。',
  '',
  '四、运行环境要求',
  '  · Windows 10 1809 及以上 / Windows 11，64 位。',
  '  · 需要 Microsoft Edge WebView2 运行时（Win11 与较新的 Win10 已自带；',
  '    若提示缺少，请安装微软官方的 “WebView2 Runtime” 后重试）。',
  '',
  '五、ffmpeg 已内置',
  '  · 转码/生成缩略图所需的 ffmpeg.exe 与 ffprobe.exe 已随包内置在 resources\\bin\\，',
  '    无需另行安装，也不依赖系统 PATH。',
  '',
  '六、常见问题',
  '  · 启动失败：查看 data\\logs\\desktop-<日期>.log 里的错误信息。',
  '  · 端口被占用：程序会自动从 3210 起向后寻找可用端口，一般无需手动处理。',
  '  · 杀毒软件误报：把整个解压目录加入白名单即可。',
  '',
  `版本 / 构建信息：见 resources\\build-info.json`,
  '',
].join('\r\n');

function findExe() {
  const found = [];
  const stack = [[DIST, 0]];
  while (stack.length) {
    const [d, depth] = stack.pop();
    if (depth > 6) continue;
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isFile() && e.name.toLowerCase() === 'screenplay.exe') found.push(p);
      else if (e.isDirectory() && e.name !== 'resources') stack.push([p, depth + 1]);
    }
  }
  // 优先 windows/dist/ScreenPlay.exe（免安装 exe），其次任意 NSIS 输出目录里的 exe
  return found.sort((a, b) => a.length - b.length)[0] || null;
}

function stageWithHardlinks(src, destLink) {
  // cp -al：硬链接复制，零额外磁盘占用（同一文件系统）
  const r = spawnSync('cp', ['-al', src, destLink], { encoding: 'utf8' });
  return r.status === 0;
}

function main() {
  console.log('='.repeat(72));
  console.log(`${LOG_PREFIX} ScreenPlay 免安装包组装`);
  console.log(`  dist        : ${DIST}`);
  console.log('='.repeat(72));

  const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const version = rootPkg.version || '0.0.0';

  fs.mkdirSync(DIST, { recursive: true });
  // 本机 NAS：新建文件会继承所在目录的权限位，dist 目录权限为 0 时 zip 产物也会是 0
  // （于是 unzip 校验自己打不开 zip）。打包前先把 dist 恢复到 u+rwx，不影响产物内容。
  if (!canRead(DIST) || !fixPerms(DIST)) warn(`无法修复目录权限：${DIST}（若在 Windows 上可忽略）`);
  log(`step 0: dist 目录权限已确认（${DIST}）`);

  // ------------------------------------------------------- 1. 定位 exe
  const exe = findExe();
  if (!exe) {
    console.error('');
    console.error(`${LOG_PREFIX} 未找到 ScreenPlay.exe，无法组装便携包。`);
    console.error('');
    console.error('  windows/dist 下目前的内容：');
    const list = fs.existsSync(DIST) ? fs.readdirSync(DIST) : [];
    if (list.length === 0) console.error('    （空目录）');
    else for (const n of list) console.error(`    ${n}`);
    console.error('');
    console.error('  请先完成 Tauri 构建（在 Windows 上：npm run tauri build，或 windows/build-windows.cmd），');
    console.error(`  然后把产物放到 ${DIST}（期望路径之一：${path.join(DIST, 'ScreenPlay.exe')}）。`);
    console.error('  参考 windows/docs/BUILD-WINDOWS.md。本次未生成任何 zip（不伪造产物）。');
    process.exit(1);
  }
  log(`step 1: exe = ${exe} (${human(fs.statSync(exe).size)})`);

  // ------------------------------------------------------- 2. 定位 resources
  const resources = RESOURCES_CANDIDATES.find((p) => fs.existsSync(p));
  if (!resources) {
    fail('定位 resources/', `以下路径都不存在：\n           ${RESOURCES_CANDIDATES.join('\n           ')}\n         （先运行 windows/scripts/prepare-backend.mjs 与 prepare-frontend.mjs）`);
  }
  const rStats = dirStats(resources);
  log(`step 2: resources = ${resources} (${rStats.files} 个文件 / ${human(rStats.bytes)})`);
  for (const must of ['node/node.exe', 'backend/dist/main.js', 'backend/node_modules', 'bin/ffmpeg.exe']) {
    if (!fs.existsSync(path.join(resources, must))) {
      warn(`resources 缺少 ${must}（便携包可能无法启动，请确认 prepare-backend.mjs 已完成）`);
    }
  }
  if (!fs.existsSync(path.join(resources, 'web', 'index.html'))) {
    warn('resources/web/index.html 不存在（先运行 prepare-frontend.mjs）');
  }

  // ------------------------------------------------------- 2b. 可读性预检
  // 打包前必须确认每个文件都能被读取：zip 对不可读文件只打印 warning 并在退出码 18 下
  // 静默丢文件（本机 NAS 上 npm 产物 st_mode=0000，被 fs.cpSync 传播后就会出现）。
  const unreadableBefore = findUnreadable(resources);
  if (unreadableBefore.length) {
    warn(`resources 内有不可读文件（首个：${unreadableBefore[0]}），尝试 chmod -R u+rwX 修复…`);
    const fixed = fixPerms(resources);
    const still = fixed ? findUnreadable(resources) : unreadableBefore;
    if (still.length) {
      fail('打包前可读性预检',
        `resources 内有文件不可读（示例：${still.slice(0, 3).join('、')}），zip 会静默丢弃它们`,
        '请重新运行 windows/scripts/prepare-backend.mjs（其 step 8b 会执行 chmod -R u+rwX），'
        + '或在 Linux 上手动执行：chmod -R u+rwX windows/src-tauri/resources');
    }
    log('    chmod 修复成功：resources 内所有文件均可读 ✓');
  } else {
    log('step 2b: 可读性预检通过（resources 内所有文件均可读）✓');
  }

  // ------------------------------------------------------- 3. staging
  log('step 3: 构建 staging（硬链接，零额外占用）');
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  const stageExe = path.join(STAGE, 'ScreenPlay.exe');
  const stageRes = path.join(STAGE, 'resources');
  if (!stageWithHardlinks(exe, stageExe)) {
    warn('cp -al 失败，退回 fs.copyFileSync 复制 exe');
    fs.copyFileSync(exe, stageExe);
  }
  if (!stageWithHardlinks(resources, stageRes)) {
    warn('cp -al 失败，退回真实复制 resources（耗时且占空间）');
    fs.cpSync(resources, stageRes, { recursive: true, dereference: true });
  }
  // 便携标记（空文件）
  fs.writeFileSync(path.join(STAGE, 'portable.flag'), '');
  // 中文说明（UTF-8 BOM + CRLF）
  fs.writeFileSync(path.join(STAGE, '使用说明.txt'), '\uFEFF' + USAGE_TXT, 'utf8');
  // staging 内新建的文件（portable.flag / 使用说明.txt）与硬链接进来的 exe 都可能带着 0 权限位，
  // zip 会静默跳过不可读文件 → 打包前统一 chmod -R u+rwX 并逐个确认可读。
  // 注意：resources 与 exe 是硬链接到 staging 的，chmod 会同时作用到同一 inode（无害：Windows 不用权限位）。
  fixPerms(STAGE);
  const unreadableStage = findUnreadable(STAGE);
  if (unreadableStage.length) {
    fail('staging 可读性检查', `仍有不可读文件（示例：${unreadableStage.slice(0, 3).join('、')}）`,
      '请手动执行 chmod -R u+rwX windows/.cache/portable-staging 后重试。');
  }
  log(`    staging 就绪：ScreenPlay.exe + resources/ + portable.flag + 使用说明.txt（全部可读 ✓）`);

  // ------------------------------------------------------- 4. zip
  const zipName = `ScreenPlay_${version}_x64-portable.zip`;
  const outZip = path.join(DIST, zipName);
  fs.rmSync(outZip, { force: true });
  const zipArgs = ['-r', '-9', '-q', outZip, 'ScreenPlay.exe', 'resources', 'portable.flag', '使用说明.txt'];
  log(`step 4: $ zip ${zipArgs.join(' ')}   (cwd=${STAGE})`);
  try {
    execFileSync('zip', zipArgs, { cwd: STAGE, stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (err) {
    fail('打包 zip', `zip ${zipArgs.join(' ')} cwd=${STAGE}`, err.message);
  }
  if (!fs.existsSync(outZip)) fail('打包 zip', `命令成功但未生成 ${outZip}`);
  // zip 是外部命令，产物文件权限同样受目录继承影响 → 显式 chmod 并确认可读（否则下面 unzip 会 EACCES）
  try { fs.chmodSync(outZip, 0o644); } catch (err) { warn(`chmod 0644 ${outZip} 失败：${err.message}`); }
  if (!canRead(outZip)) {
    fixPerms(outZip);
    if (!canRead(outZip)) {
      fail('打包 zip（可读性）', `${outZip} 生成后不可读，无法校验`,
        '请手动执行 chmod 644 后重试；或检查该挂载点（如 NAS 共享）的目录权限继承行为。');
    }
    warn('zip 产物权限已通过 chmod -R u+rwX 修复');
  }
  const zipBytes = fs.statSync(outZip).size;

  // ------------------------------------------------------- 5. 校验 zip
  log('step 5: 校验 zip 内容');
  // 用 zipinfo（unzip -Z1）只列条目名：10400+ 条目时 unzip -l 的表格会超过 Node 默认 maxBuffer 1 MiB。
  const listing = execFileSync('unzip', ['-Z1', outZip], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const names = listing.split('\n').map((s) => s.trim()).filter(Boolean);
  const need = ['ScreenPlay.exe', 'resources/node/node.exe', 'resources/backend/dist/main.js',
    'resources/backend/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    'resources/bin/ffmpeg.exe', 'resources/bin/ffprobe.exe', 'resources/web/index.html',
    'resources/web/assets/plyr.svg', 'resources/web/assets/blank.mp4',
    'portable.flag', '使用说明.txt'];
  const missing = need.filter((n) => !names.includes(n) && !names.includes(n + '/'));
  for (const n of need) console.log(`    ${missing.includes(n) ? '✗' : '✓'} ${n}`);
  if (missing.length) fail('校验 zip 内容', `zip 内缺少：${missing.join(', ')}`);
  const entries = names.length;
  console.log(`    zip 内条目数：${entries}`);
  const stageFiles = dirStats(STAGE).files;
  if (entries < stageFiles) {
    fail('校验 zip 内容',
      `zip 内条目数 ${entries} < staging 文件数 ${stageFiles}（有文件被 zip 跳过或未写入）`,
      '最可能的原因：文件不可读（权限）。请重新运行 windows/scripts/prepare-backend.mjs 修复权限后重试。');
  }
  console.log(`    staging 文件数：${stageFiles}（zip 条目含目录条目，因此应 ≥ 此数）`);
  // 反向抽查：staging 里的每个文件都应在 zip 条目里出现（防止 zip 静默丢文件）
  const missingAny = [];
  for (const f of walkFiles(STAGE)) {
    const rel = path.relative(STAGE, f).split(path.sep).join('/');
    if (!names.includes(rel)) { missingAny.push(rel); if (missingAny.length >= 5) break; }
  }
  if (missingAny.length) {
    fail('校验 zip 内容（全量比对）', `staging 中的文件未进入 zip（示例：${missingAny.join('、')}）`,
      '最可能的原因：文件不可读（权限）。请重新运行 prepare-backend.mjs / prepare-frontend.mjs 后重试。');
  }
  console.log(`    全量比对：staging 内 ${stageFiles} 个文件全部存在于 zip 中 ✓`);

  // ------------------------------------------------------- 6. 报告
  console.log('-'.repeat(72));
  console.log(`  产物            : ${outZip}`);
  console.log(`  压缩后大小      : ${zipBytes} B (${(zipBytes / 1024 / 1024).toFixed(2)} MiB)`);
  console.log(`  打包前 staging  : ${human(rStats.bytes + fs.statSync(exe).size)}（resources + exe）`);
  console.log(`  体积目标        : ≤ 200 MiB（DESIGN §10） → ${zipBytes / 1024 / 1024 <= 200 ? '达标 ✓' : '超出 ✗，需在文档中说明'}`);
  console.log(`  内容            : ScreenPlay.exe + resources/ + portable.flag + 使用说明.txt`);
  console.log('-'.repeat(72));
  log(`完成：${outZip}`);
}

main();