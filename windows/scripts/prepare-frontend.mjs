#!/usr/bin/env node
/**
 * prepare-frontend.mjs — 组装 ScreenPlay Windows 桌面端的 Web 前端资源。
 *
 * 契约：windows/DESIGN.md §6（前端「桌面精简」）
 * 原则：绝不修改 web/ 源码；所有精简都在副本（windows/src-tauri/resources/web）上做。
 *
 * 用法：
 *   node windows/scripts/prepare-frontend.mjs [--reduce-motion] [--force-build]
 *
 *   --reduce-motion  在产物 CSS 末尾追加一小段动画/过渡归零的覆盖规则。
 *                    **默认关闭**：默认开启会改变与 Web 端 1:1 的观感，仅为满足
 *                    「移除非必要装饰性动画」提供显式开关。
 *   --force-build    忽略已有的 web/dist，强制先执行 `npm --prefix web run build`。
 *
 * 只使用 Node 内置模块 + 系统命令，不新增 npm 依赖。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WIN_DIR = path.resolve(__dirname, '..');
const WEB_SRC = path.join(REPO_ROOT, 'web');
const WEB_DIST = path.join(WEB_SRC, 'dist');
const RESOURCES = path.join(WIN_DIR, 'src-tauri', 'resources');
const OUT_WEB = path.join(RESOURCES, 'web');
const PLYR_SVG_SRC = path.join(REPO_ROOT, 'node_modules', 'plyr', 'dist', 'plyr.svg');

const PLYR_SVG_REMOTE = 'https://cdn.plyr.io/3.8.4/plyr.svg';
const PLYR_BLANK_REMOTE = 'https://cdn.plyr.io/static/blank.mp4';
const PLYR_SVG_LOCAL = 'assets/plyr.svg';
const PLYR_BLANK_LOCAL = 'assets/blank.mp4';

const LOG_PREFIX = '[prepare-frontend]';

// 1.5 KB 的极简黑色 MP4（2x2、1fps、1s），用于替换 plyr 默认的远端 blank.mp4。
// 由 ffmpeg 预生成并内联，避免构建机必须安装 ffmpeg。
const BLANK_MP4_B64 = 'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMXbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAkF0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAIAAAACAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAG5bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABZG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAASRzdGJsAAAAwHN0c2QAAAAAAAAAAQAAALBhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAIAAgBIAAAASAAAAAAAAAABFUxhdmM2Mi4yOC4xMDEgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANmF2Y0MBZAAK/+EAGWdkAAqs2V+IiMBEAAADAAQAAAMACDxIllgBAAZo6+PLIsD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAAFigAAAAAAAAAGHN0dHMAAAAAAAAAAQAAAAEAAEAAAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAABAAAAAQAAABRzdHN6AAAAAAAAAsUAAAABAAAAFHN0Y28AAAAAAAAAAQAAA0cAAABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYyLjEyLjEwMgAAAAhmcmVlAAACzW1kYXQAAAKtBgX//6ncRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY0IHIzMDk1IGJhZWU0MDAgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDIyIC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUwIGtleWludF9taW49MSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAABBliIQAFf/+98nvwKbr29+B';

const args = process.argv.slice(2);
const REDUCE_MOTION = args.includes('--reduce-motion');
const FORCE_BUILD = args.includes('--force-build');

function log(msg) { console.log(`${LOG_PREFIX} ${msg}`); }
function warn(msg) { console.warn(`${LOG_PREFIX} WARN ${msg}`); }

/** 任一步失败都必须给出「哪一步 / 哪个路径 / 原始错误」，然后 exit(1)，绝不静默降级。 */
function fail(step, detail, err) {
  console.error(`\n${LOG_PREFIX} FAILED`);
  console.error(`  step   : ${step}`);
  console.error(`  detail : ${detail}`);
  if (err) {
    console.error(`  error  : ${err && err.message ? err.message : String(err)}`);
    if (err.stack && !err.message) console.error(String(err.stack));
  }
  console.error(`${LOG_PREFIX} 中止（未生成不完整的 resources/web）。`);
  process.exit(1);
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}
function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function walkFiles(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, acc);
    else if (e.isFile()) acc.push(p);
  }
  return acc;
}
function dirStats(dir) {
  const files = walkFiles(dir);
  const bytes = files.reduce((s, f) => s + fs.statSync(f).size, 0);
  return { files: files.length, bytes };
}

/**
 * 删除 CSS 中整块 `@media (max-width: …)` 规则（含嵌套块），其余一字不动。
 * 只处理 max-width（移动端断点）；Tailwind 的 min-width 断点在移动优先体系里
 * 代表桌面端布局，删除会破坏「UI 1:1」要求，必须保留。
 */
function stripMaxWidthMediaQueries(css) {
  let out = '';
  let i = 0;
  let removed = 0;
  const removedBlocks = [];
  while (i < css.length) {
    const at = css.indexOf('@media', i);
    if (at === -1) { out += css.slice(i); break; }
    // 找到该 at-rule 的条件部分与左花括号
    const brace = css.indexOf('{', at);
    if (brace === -1) { out += css.slice(i); break; }
    const cond = css.slice(at, brace);
    out += css.slice(i, at);
    if (/max-width/i.test(cond)) {
      // 匹配花括号
      let depth = 0;
      let j = brace;
      for (; j < css.length; j++) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}') { depth--; if (depth === 0) break; }
      }
      if (j >= css.length) fail('strip @media max-width', '括号不配对的 @media 块', new Error('unbalanced braces'));
      const block = css.slice(at, j + 1);
      removed++;
      removedBlocks.push(`${cond.trim()}{…} (${block.length} B)`);
      i = j + 1; // 跳过整块
    } else {
      out += cond + '{';
      i = brace + 1;
    }
  }
  return { css: out, removed, removedBlocks };
}

function countMedia(css, kind) {
  const re = new RegExp(`@media\\s*\\(\\s*${kind}:`, 'gi');
  return (css.match(re) || []).length;
}

function main() {
  console.log('='.repeat(72));
  console.log(`${LOG_PREFIX} ScreenPlay 桌面端 · Web 前端资源组装`);
  console.log(`  repo root    : ${REPO_ROOT}`);
  console.log(`  source       : ${WEB_DIST}`);
  console.log(`  destination  : ${OUT_WEB}`);
  console.log(`  reduceMotion : ${REDUCE_MOTION ? 'ON（--reduce-motion，会改变与 Web 端 1:1 观感）' : 'OFF（默认，保持与 Web 端 1:1）'}`);
  console.log('='.repeat(72));

  // ---------------------------------------------------------------- 0. 可选重新构建
  if (FORCE_BUILD) {
    log('step 0: --force-build，先执行 `npm --prefix web run build`');
    try {
      execFileSync('npm', ['--prefix', WEB_SRC, 'run', 'build'], {
        cwd: REPO_ROOT, stdio: 'inherit', env: process.env,
      });
    } catch (err) {
      fail('npm --prefix web run build', `web=${WEB_SRC}`, err);
    }
  }

  // ---------------------------------------------------------------- 1. 校验 web/dist
  const srcIndexHtml = path.join(WEB_DIST, 'index.html');
  const srcAssets = path.join(WEB_DIST, 'assets');
  if (!fs.existsSync(srcIndexHtml)) {
    fail('校验 web/dist', `缺少构建产物 ${srcIndexHtml}（可加 --force-build 或先跑 npm --prefix web run build）`);
  }
  if (!fs.existsSync(srcAssets)) {
    fail('校验 web/dist', `缺少 ${srcAssets}`);
  }
  const assetFiles = fs.readdirSync(srcAssets);
  const jsFiles = assetFiles.filter((f) => f.endsWith('.js'));
  const cssFiles = assetFiles.filter((f) => f.endsWith('.css'));
  if (jsFiles.length === 0 || cssFiles.length === 0) {
    fail('校验 web/dist/assets', `需要同时存在 .js 与 .css，实际 js=[${jsFiles}] css=[${cssFiles}]`);
  }

  log(`step 1: web/dist 校验通过（${jsFiles.length} 个 js / ${cssFiles.length} 个 css）`);
  const beforeEntries = [];
  for (const rel of ['index.html', ...assetFiles.map((f) => path.join('assets', f))]) {
    const p = path.join(WEB_DIST, rel);
    if (!fs.statSync(p).isFile()) continue;
    const buf = fs.readFileSync(p);
    beforeEntries.push({ rel, bytes: buf.length, sha256: sha256(buf) });
  }
  let beforeTotal = 0;
  for (const e of beforeEntries) {
    beforeTotal += e.bytes;
    console.log(`    ${e.rel.padEnd(34)} ${String(e.bytes).padStart(9)} B  sha256=${e.sha256}`);
  }
  console.log(`    ${'（web/dist 源合计）'.padEnd(34)} ${String(beforeTotal).padStart(9)} B  (${human(beforeTotal)})`);

  // ---------------------------------------------------------------- 2. 复制到 resources/web
  try {
    fs.rmSync(OUT_WEB, { recursive: true, force: true });
    fs.mkdirSync(OUT_WEB, { recursive: true });
    fs.cpSync(WEB_DIST, OUT_WEB, { recursive: true, dereference: true });
  } catch (err) {
    fail('复制 web/dist → resources/web', `${WEB_DIST} → ${OUT_WEB}`, err);
  }
  log(`step 2: 已复制 ${WEB_DIST} → ${OUT_WEB}`);

  const outIndexHtml = path.join(OUT_WEB, 'index.html');
  const outAssets = path.join(OUT_WEB, 'assets');
  const outJs = fs.readdirSync(outAssets).filter((f) => f.endsWith('.js'));
  const outCss = fs.readdirSync(outAssets).filter((f) => f.endsWith('.css'));

  // ---------------------------------------------------------------- 3. CSS 精简
  let minWidthKept = 0;
  let removedTotal = 0;
  for (const f of outCss) {
    const p = path.join(outAssets, f);
    const original = fs.readFileSync(p, 'utf8');
    const minBefore = countMedia(original, 'min-width');
    const maxBefore = countMedia(original, 'max-width');
    const { css: trimmed, removed, removedBlocks } = stripMaxWidthMediaQueries(original);
    let final = trimmed;
    if (REDUCE_MOTION) {
      final += '\n/* desktop shim: --reduce-motion */\n' +
        '.plyr, *{animation-duration:0.001ms!important;animation-iteration-count:1!important;transition-duration:0.001ms!important}\n';
    }
    if (outCss.length > 1) {
      fail('CSS 精简', `假设只有 1 个 CSS 产物，实际 ${outCss.length} 个：${outCss.join(', ')}`);
    }
    fs.writeFileSync(p, final, 'utf8');
    minWidthKept = minBefore;
    removedTotal = removed;
    log(`step 3: 精简 ${f}`);
    console.log(`    @media min-width 断点保留 ${minBefore} 条（属于桌面布局，不可删）`);
    console.log(`    @media max-width 规则删除 ${removed} 条（移动端冗余）: ${removedBlocks.join(', ') || '无'}`);
    console.log(`    CSS 体积 ${fmtBytes(Buffer.byteLength(original, 'utf8'))} → ${fmtBytes(Buffer.byteLength(final, 'utf8'))}` +
      (REDUCE_MOTION ? '（含 --reduce-motion 追加段）' : ''));
    if (maxBefore !== removed) {
      warn(`max-width 计数 ${maxBefore} ≠ 删除 ${removed}（可能有嵌套/复合条件，请人工复核）`);
    }
  }

  // ---------------------------------------------------------------- 4. 离线化 plyr 资源
  // 4a. 官方 plyr sprite
  if (!fs.existsSync(PLYR_SVG_SRC)) {
    fail('离线化 plyr svg', `找不到官方 sprite ${PLYR_SVG_SRC}（需要仓库 node_modules/plyr）`);
  }
  const svgBuf = fs.readFileSync(PLYR_SVG_SRC);
  const symbols = (svgBuf.toString('utf8').match(/<symbol/g) || []).length;
  fs.writeFileSync(path.join(outAssets, 'plyr.svg'), svgBuf);
  log(`step 4a: 复制官方 plyr.svg → assets/plyr.svg（${svgBuf.length} B, ${symbols} 个 <symbol>, sha256=${sha256(svgBuf)}）`);

  // 4b. blank.mp4（plyr 默认远端 blank 视频；为保证 grep cdn.plyr.io == 0 也必须本地化）
  const blankBuf = Buffer.from(BLANK_MP4_B64, 'base64');
  fs.writeFileSync(path.join(outAssets, 'blank.mp4'), blankBuf);
  log(`step 4b: 内联极简空白视频 → assets/blank.mp4（${blankBuf.length} B, sha256=${sha256(blankBuf)}）`);

  // 4c. 字符串替换（svg + blank.mp4 两处来源都在 cdn.plyr.io 域下）
  let replacedSvg = 0;
  let replacedBlank = 0;
  for (const f of outJs) {
    const p = path.join(outAssets, f);
    let js = fs.readFileSync(p, 'utf8');
    replacedSvg += js.split(PLYR_SVG_REMOTE).length - 1;
    replacedBlank += js.split(PLYR_BLANK_REMOTE).length - 1;
    js = js.split(PLYR_SVG_REMOTE).join(PLYR_SVG_LOCAL);
    js = js.split(PLYR_BLANK_REMOTE).join(PLYR_BLANK_LOCAL);
    fs.writeFileSync(p, js, 'utf8');
  }
  log(`step 4c: JS 中 ${PLYR_SVG_REMOTE} → ${PLYR_SVG_LOCAL} 命中 ${replacedSvg} 次；` +
      `${PLYR_BLANK_REMOTE} → ${PLYR_BLANK_LOCAL} 命中 ${replacedBlank} 次`);
  if (replacedSvg === 0) {
    warn(`未在 JS 中找到 ${PLYR_SVG_REMOTE}（上游可能已改版本号，请检查 CDN 版本）`);
  }

  // ---------------------------------------------------------------- 5. index.html 去 viewport
  {
    let html = fs.readFileSync(outIndexHtml, 'utf8');
    const before = Buffer.byteLength(html, 'utf8');
    const viewportRe = /\s*<meta\s+name="viewport"[^>]*>\s*/gi;
    const hits = (html.match(viewportRe) || []).length;
    html = html.replace(viewportRe, '\n    ');
    fs.writeFileSync(outIndexHtml, html, 'utf8');
    log(`step 5: index.html 移除 <meta name="viewport"> ${hits} 条（桌面壳固定窗口宽度，无影响）`);
    console.log(`    index.html 体积 ${fmtBytes(before)} → ${fmtBytes(Buffer.byteLength(html, 'utf8'))}`);
  }

  // ---------------------------------------------------------------- 6. 校验
  log('step 6: 校验');
  const finalHtml = fs.readFileSync(outIndexHtml, 'utf8');
  const refJs = /\/assets\/[^"'()\s]+\.js/.test(finalHtml);
  const refCss = /\/assets\/[^"'()\s]+\.css/.test(finalHtml);
  if (!refJs || !refCss) {
    fail('校验 index.html', `index.html 未引用 /assets/*.js 与 /assets/*.css（js=${refJs} css=${refCss}）`);
  }
  console.log(`    index.html 引用 /assets/*.js = ${refJs}, /assets/*.css = ${refCss}  ✓`);

  const allFiles = walkFiles(OUT_WEB);
  const offenders = [];
  for (const f of allFiles) {
    if (!/\.(js|css|html|svg|mp4|json|map)$/i.test(f)) continue;
    const txt = fs.readFileSync(f, 'utf8');
    for (const needle of ['cdn.plyr.io']) {
      const n = txt.split(needle).length - 1;
      if (n > 0) offenders.push({ f: path.relative(OUT_WEB, f), needle, n });
    }
  }
  if (offenders.length > 0) {
    fail('校验 cdn.plyr.io 命中数', `必须为 0，实际命中：${offenders.map((o) => `${o.f}×${o.n}`).join(', ')}`);
  }
  console.log('    grep "cdn.plyr.io" resources/web -r → 命中数 0  ✓');

  // 官方 sprite 与 blank 视频就位
  for (const rel of [PLYR_SVG_LOCAL, PLYR_BLANK_LOCAL]) {
    const p = path.join(OUT_WEB, rel);
    if (!fs.existsSync(p)) fail('校验本地 plyr 资源', `缺少 ${p}`);
  }
  console.log(`    ${PLYR_SVG_LOCAL} + ${PLYR_BLANK_LOCAL} 就位  ✓`);

  // ---------------------------------------------------------------- 7. 体积对比
  const after = dirStats(OUT_WEB);
  const deltaFiles = beforeEntries.map((b) => {
    const p = path.join(OUT_WEB, b.rel);
    const nb = fs.existsSync(p) ? fs.statSync(p).size : 0;
    return `    ${b.rel.padEnd(34)} ${String(b.bytes).padStart(9)} → ${String(nb).padStart(9)} B  (${nb - b.bytes >= 0 ? '+' : ''}${nb - b.bytes})`;
  });
  console.log('-'.repeat(72));
  console.log('  产物文件体积对比（精简前 → 精简后）');
  for (const l of deltaFiles) console.log(l);
  console.log(`  同源文件合计            ${String(beforeTotal).padStart(9)} → ${String(after.bytes).padStart(9)} B  ` +
    `(${beforeTotal === after.bytes ? '' : (after.bytes - beforeTotal >= 0 ? '+' : '') + (after.bytes - beforeTotal)} B)`);
  console.log(`  resources/web 总计      ${after.files} 个文件 / ${after.bytes} B (${human(after.bytes)})`);
  console.log(`  （新增本地化资源：assets/plyr.svg ${svgBuf.length} B、assets/blank.mp4 ${blankBuf.length} B）`);
  console.log('-'.repeat(72));

  // ---------------------------------------------------------------- 8. 产物权限
  // 本机 NAS：新建文件/目录会继承父目录的权限位（可能为 0），使产物在构建机上不可读
  // （make-portable 打包时 zip 会静默丢文件）。Windows 不使用 Unix 权限位，统一 u+rwX 即可。
  log('step 8: 修复产物权限（chmod -R u+rwX resources/web）');
  try {
    execFileSync('chmod', ['-R', 'u+rwX', OUT_WEB], { stdio: 'pipe' });
    for (const f of walkFiles(OUT_WEB)) fs.accessSync(f, fs.constants.R_OK);
    log('    校验：resources/web 内所有文件均可读 ✓');
  } catch (err) {
    fail('修复产物权限', `chmod -R u+rwX ${OUT_WEB}`, err);
  }

  log(`完成：${OUT_WEB}`);
}

main();