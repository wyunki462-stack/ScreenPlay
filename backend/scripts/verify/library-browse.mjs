/**
 * 「添加媒体库」路径可视化选择 —— 后端只读目录浏览接口的真实端到端验证。
 *
 * 跑法：cd backend && npm run build  然后  node backend/scripts/verify/library-browse.mjs
 *      （测的是 nest build 产物，和 Docker 里跑的那份一致；宿主无 better-sqlite3
 *        编译产物，所以用 sqlite-shim.js 把 better-sqlite3 换成 node:sqlite。）
 *
 * 覆盖点（与需求一一对应）：
 *   1. 只列一层目录，返回 isDirectory:true 的条目，文件/隐藏目录/系统噪声被过滤；
 *   2. LIBRARY_BROWSE_ROOTS 白名单之外的路径被拒绝（含 ../ 逃逸与符号链接逃逸）；
 *   3. 白名单内不存在的路径 → ok:false / exists:false；
 *   4. 指向文件而非目录 → ok:false；
 *   5. 非绝对路径等非法参数 → ok:false，不抛 500；
 *   6. parent / roots 字段：根目录 parent=null，子目录 parent=根，失败响应也带 roots。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path, { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TMP = path.join(ROOT, '.tmp-lib-browse');
const DATA = path.join(TMP, 'data');
const MEDIA = path.join(TMP, 'media');
const BROWSE = path.join(TMP, 'browse');
const OUTSIDE = path.join(TMP, 'outside');
const PORT = Number(process.env.PORT || 4433);
const BASE = `http://127.0.0.1:${PORT}`;
// 用真实路径做基准：/vol2 等挂载点可能是符号链接，后端 realpath 后可能与字面量不同。
// WL 在夹具目录创建之后再解析（下面）。
let WL = BROWSE;

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`   \x1b[32m✓\x1b[0m ${m}`); pass += 1; };
const bad = (m) => { console.log(`   \x1b[31m✗\x1b[0m ${m}`); fail += 1; };
const info = (m) => console.log(`   ${m}`);
const step = (m) => console.log(`\n\x1b[1m== ${m}\x1b[0m`);

const children = [];
function killAll() {
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch { /* gone */ }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  return false;
}

/** GET browse and return `{ status, body }` (never throws on a JSON error body). */
async function browse(p) {
  const url = `${BASE}/api/library/roots/browse?path=${encodeURIComponent(p)}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
console.log('\x1b[1m准备隔离实例（独立 DATA_DIR + 白名单目录）\x1b[0m');
fs.rmSync(TMP, { recursive: true, force: true });

// 夹具树：能被列出的目录 + 必须被过滤掉的东西
for (const d of ['alpha/sub', 'beta', 'zeta', 'node_modules', '.hidden', '$RECYCLE.BIN', 'System Volume Information']) {
  fs.mkdirSync(path.join(BROWSE, d), { recursive: true });
}
fs.mkdirSync(MEDIA, { recursive: true });
fs.mkdirSync(path.join(OUTSIDE, 'secret'), { recursive: true });
fs.writeFileSync(path.join(BROWSE, 'file.txt'), 'not a directory\n');
WL = fs.realpathSync(BROWSE); // 白名单根（真实路径）

// 符号链接逃逸：白名单内的一个链接指向白名单之外。
let linkMade = false;
try {
  fs.symlinkSync(OUTSIDE, path.join(BROWSE, 'escape'), 'dir');
  linkMade = true;
} catch { /* 平台不支持则跳过该项 */ }

const runJs = path.join(TMP, 'run.js');
fs.writeFileSync(
  runJs,
  `const Module=require('module');const SHIM='${ROOT}/backend/scripts/verify/sqlite-shim.js';` +
    `const o=Module._resolveFilename;Module._resolveFilename=function(r,...a){return r==='better-sqlite3'?SHIM:o.call(this,r,...a);};` +
    `require('${ROOT}/backend/dist/main.js');\n`,
);
if (!fs.existsSync(path.join(ROOT, 'backend/dist/main.js'))) {
  console.error('找不到编译产物 backend/dist/main.js —— 先跑 cd backend && npm run build');
  process.exit(1);
}

const app = spawn(process.execPath, [runJs], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    DATA_DIR: DATA,
    MEDIA_DIRS: MEDIA,
    LIBRARY_BROWSE_ROOTS: BROWSE, // 覆盖默认白名单，让测试可确定
    WEB_DIST: path.join(ROOT, 'web/dist'),
    PORT: String(PORT),
    NODE_ENV: 'production',
    AUTH_DISABLED: '1',
    RAWG_API_KEY: '',
    RAWG_PROXY: '',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    IMAGE_FETCH_ORDER: 'direct',
    CRAWLER_MIN_INTERVAL_MS: '50',
  },
});
children.push(app);
fs.writeFileSync(path.join(TMP, 'log'), '');
app.stdout.on('data', (d) => fs.appendFileSync(path.join(TMP, 'log'), d));
app.stderr.on('data', (d) => fs.appendFileSync(path.join(TMP, 'log'), d));
process.on('exit', killAll);

if (!(await waitFor(`${BASE}/api/health`))) {
  console.error('后端未就绪，见', path.join(TMP, 'log'));
  killAll();
  process.exit(1);
}
ok('隔离实例已启动');

// ---------------------------------------------------------------------------
step('1 · 只列一层目录：过滤文件 / 隐藏目录 / 系统噪声');
{
  const { status, body } = await browse(WL);
  info(`HTTP ${status}，${body?.entries?.length ?? '?'} 个条目：${(body?.entries ?? []).map((e) => e.name).join(', ')}`);
  status === 200 ? ok('HTTP 200') : bad(`HTTP ${status}`);
  body?.ok === true ? ok('ok:true') : bad(`ok 应为 true，实际 ${JSON.stringify(body?.ok)}`);

  const names = (body?.entries ?? []).map((e) => e.name);
  const expected = ['alpha', 'beta', 'node_modules', 'zeta'];
  expected.every((n) => names.includes(n))
    ? ok(`目录条目齐全：${expected.join(', ')}`)
    : bad(`缺少目录条目，实际 ${names.join(', ')}`);
  !names.includes('file.txt') ? ok('文件未被列出') : bad('文件 file.txt 不应出现');
  !names.includes('.hidden') ? ok('隐藏目录（. 开头）被跳过') : bad('.hidden 不应出现');
  !names.includes('$RECYCLE.BIN') ? ok('$RECYCLE.BIN 被跳过') : bad('$RECYCLE.BIN 不应出现');
  !names.includes('System Volume Information')
    ? ok('System Volume Information 被跳过')
    : bad('System Volume Information 不应出现');
  (body?.entries ?? []).every((e) => e.isDirectory === true)
    ? ok('所有条目的 isDirectory 均为 true')
    : bad('存在 isDirectory !== true 的条目');
  JSON.stringify(names) === JSON.stringify([...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })))
    ? ok('条目按名称排序')
    : bad('条目未排序');
  (body?.entries ?? []).every((e) => e.path === path.join(body.path, e.name))
    ? ok('条目 path = 当前目录 + name')
    : bad('条目 path 拼接不正确');
  !names.includes('sub') ? ok('只列一层（alpha/sub 不在根目录列表中）') : bad('不应递归列出子目录');
  typeof body?.message === 'string' && body.message.length > 0 ? ok('message 非空') : bad('缺少 message');
}

// ---------------------------------------------------------------------------
step('2 · parent / roots 字段');
{
  const root = (await browse(WL)).body;
  root?.parent === null ? ok('白名单根目录 parent 为 null') : bad(`根目录 parent 应为 null，实际 ${JSON.stringify(root?.parent)}`);
  Array.isArray(root?.roots) && root.roots.length === 1
    ? ok('roots 返回 1 个白名单快捷入口')
    : bad(`roots 应返回 1 项，实际 ${JSON.stringify(root?.roots)}`);
  root?.roots?.[0]?.path === WL ? ok('roots[0].path 指向白名单根') : bad(`roots[0].path=${root?.roots?.[0]?.path}`);
  root?.roots?.[0]?.label ? ok('roots[0].label 非空') : bad('roots[0].label 为空');

  const sub = (await browse(path.join(WL, 'alpha'))).body;
  sub?.ok === true ? ok('进入子目录 ok:true') : bad('进入子目录失败');
  sub?.parent === WL ? ok('子目录 parent 指向根') : bad(`子目录 parent=${JSON.stringify(sub?.parent)}`);
  sub?.entries?.some((e) => e.name === 'sub') ? ok('子目录内可见下一层目录') : bad('子目录内缺少 sub');
}

// ---------------------------------------------------------------------------
step('3 · 白名单之外的路径被拒绝');
{
  const etc = await browse('/etc');
  etc.body?.ok === false ? ok('/etc 被拒绝（ok:false）') : bad('/etc 不应被允许');
  /允许浏览/.test(etc.body?.message ?? '') ? ok('拒绝原因说明白名单') : bad(`拒绝 message=${etc.body?.message}`);
  Array.isArray(etc.body?.roots) && etc.body.roots.length > 0
    ? ok('拒绝响应仍返回 roots 快捷入口')
    : bad('拒绝响应缺少 roots');

  const up = await browse(path.join(WL, '..', 'media'));
  up.body?.ok === false ? ok('../ 逃逸被拒绝') : bad('../ 逃逸不应被允许');

  if (linkMade) {
    const link = await browse(path.join(WL, 'escape'));
    link.body?.ok === false
      ? ok('符号链接逃逸被拒绝（已 realpath）')
      : bad('符号链接指向白名单外却未被拒绝');
  } else {
    info('（平台不支持符号链接，跳过该项）');
  }
}

// ---------------------------------------------------------------------------
step('4 · 不存在 / 非目录 / 非法参数');
{
  const missing = await browse(path.join(WL, 'does-not-exist'));
  missing.body?.ok === false ? ok('不存在的路径 ok:false') : bad('不存在路径应 ok:false');
  missing.body?.exists === false ? ok('exists:false') : bad(`exists 应为 false，实际 ${JSON.stringify(missing.body?.exists)}`);
  /不存在/.test(missing.body?.message ?? '') ? ok('提示「不存在」') : bad(`message=${missing.body?.message}`);

  const file = await browse(path.join(WL, 'file.txt'));
  file.body?.ok === false ? ok('文件路径 ok:false') : bad('文件路径应 ok:false');
  file.body?.exists === true ? ok('文件 exists:true（但非目录）') : bad(`文件 exists 应为 true，实际 ${JSON.stringify(file.body?.exists)}`);
  /文件/.test(file.body?.message ?? '') ? ok('提示「是文件而不是目录」') : bad(`message=${file.body?.message}`);

  const rel = await browse('relative/dir');
  rel.body?.ok === false ? ok('相对路径 ok:false') : bad('相对路径应 ok:false');
  /绝对路径/.test(rel.body?.message ?? '') ? ok('提示需要绝对路径') : bad(`message=${rel.body?.message}`);
}

// ---------------------------------------------------------------------------
console.log(`\n\x1b[1m汇总：${pass} 通过 / ${fail} 失败\x1b[0m`);
killAll();
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);