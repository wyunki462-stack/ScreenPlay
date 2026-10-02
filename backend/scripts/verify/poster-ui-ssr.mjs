/**
 * 前端 DOM 行为验证（SSR 渲染，不需要浏览器）
 * ============================================================================
 *
 * 跑法：node backend/scripts/verify/poster-ui-ssr.mjs
 *
 * 验证用户报告的两个前端问题：
 *   · 「编辑海报」里相册截图默认不勾选、勾选框**在任何模式下都渲染且可点**
 *     （旧实现把它包在 `mode === "slideshow"` 里，静态模式下控件根本不存在，
 *      这才是「勾选后无法取消」的直接原因）
 *   · 详情页大图区（`HeroPosterCarousel`）**恒定自动轮播全部官方海报**，与
 *     「编辑海报」面板彻底解耦 —— 组件已删除 `mode` prop 与 `data-mode` 属性，
 *     所以这里断言的是「只看张数」：3 张时容器 / 箭头 / 计数都在，1 张时一个都不出现
 *
 * 为什么用 SSR 而不是浏览器：这台机器上没有可用的 Chromium 二进制（Playwright
 * 的下载缓存在这个环境里是空的），装一个不合适。SSR 渲染的是**真实源码组件**
 * （esbuild 直接编译 src/**），足以断言「控件是否存在、初始是否勾选、属性是否正确」
 * 这三件本轮要修的事。
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const WEB = path.join(ROOT, 'web');
const OUT = path.join(ROOT, '.tmp-ssr');

let pass = 0;
let fail = 0;
const ok = (m) => { pass += 1; console.log(`   \x1b[32m✓\x1b[0m ${m}`); };
const bad = (m) => { fail += 1; console.log(`   \x1b[31m✗\x1b[0m ${m}`); };
const info = (m) => console.log(`   ${m}`);
const step = (m) => console.log(`\n\x1b[1m== ${m}\x1b[0m`);

const ENTRY = `
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PosterDialog from "${WEB}/src/components/PosterDialog.tsx";
import HeroPosterCarousel from "${WEB}/src/components/HeroPosterCarousel.tsx";
import { I18nProvider } from "${WEB}/src/i18n/index.tsx";
// 海报集合只有一份来源：桩。入口里再抄一份必然对不上（已经踩过一次）。
import { SSR_POSTERS, SSR_MEDIA } from "${ROOT}/backend/scripts/verify/ssr-hooks-stub.mjs";

const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });

// 一个游戏，登记 4 张海报：1 张官方（已进轮播）+ 3 张相册（用户都没勾）。
//
// 这正是用户报告里的场景：从相册选了截图，默认不该被勾上。
const game = {
  id: "g-1",
  name: "测试游戏",
  posterUrl: "/p0.png",
  posterMode: "static",
  posters: ["/p0.png", "/p1.png", "/p2.png", "/p3.png"],
  posterList: SSR_POSTERS,
  media: SSR_MEDIA,
  screenshots: [],
  platforms: [],
  knownPlatforms: [],
  youTubeTrailers: [],
  voiceActors: [],
  mediaReviews: [],
};

export const POSTER_COUNT = game.posterList.length;
export { SSR_POSTERS, SSR_MEDIA };

export function renderDialog(mode) {
  return renderToStaticMarkup(
    React.createElement(QueryClientProvider, { client: qc },
      React.createElement(I18nProvider, { children:
        React.createElement(PosterDialog, { game: { ...game, posterMode: mode }, open: true, onOpenChange: () => {} }),
      }),
    ),
  );
}

// 这段代码在 ENTRY 模板字符串里，所以不能出现反引号（会截断模板）。
// 大图区组件没有 mode prop（DOM 里也不再有 data-mode）：详情页大图恒定自动轮播
// 全部官方海报，与首页卡片的展现模式 / 轮播勾选无关。
export function renderHero(images) {
  return renderToStaticMarkup(
    React.createElement(QueryClientProvider, { client: qc },
      React.createElement(I18nProvider, { children:
        React.createElement(HeroPosterCarousel, { images, alt: "测试游戏" }),
      }),
    ),
  );
}
`;

console.log('\n\x1b[1m前端 DOM 行为验证（SSR）\x1b[0m');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const entryFile = path.join(OUT, 'entry.tsx');
fs.writeFileSync(entryFile, ENTRY, 'utf8');
const bundleFile = path.join(OUT, 'bundle.mjs');

try {
  await build({
    entryPoints: [entryFile],
    outfile: bundleFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    // CSS 不参与断言，抽掉避免打包报错
    loader: { '.css': 'empty' },
    // 不打包任何第三方依赖 / Node 内置模块 —— 只打包本项目源码。
    //
    // 不这么做的话 esbuild 会把 react-dom/server 的 CJS 打进来，它对
    // `stream` 的 require 在 ESM 产物里会炸（"Dynamic require of stream is not
    // supported"）。让 Node 自己在运行时解析这些包最省事，也更快。
    plugins: [{
      name: 'externalize-deps',
      setup(b) {
        // 把 tRPC hooks 换成桩：SSR 下没有查询数据，弹窗会渲染成空状态，
        // 「勾选框在不在」就测不到了。桩只喂数据，行为由后端 e2e 覆盖。
        b.onResolve({ filter: /api\/hooks$/ }, () => ({
          path: path.join(ROOT, 'backend/scripts/verify/ssr-hooks-stub.mjs'),
        }));
        b.onResolve({ filter: /^[^./]|^\.[^./]|^\.\.[^/]/ }, (args) => {
          // 相对路径（./ ../）继续解析；裸包名一律 external
          if (args.path.startsWith('.') || path.isAbsolute(args.path)) return null;
          return { path: args.path, external: true };
        });
      },
    }],
    logLevel: 'error',
    absWorkingDir: WEB,
  });
} catch (err) {
  console.error('  打包失败：', err.message);
  process.exit(1);
}

const mod = await import(pathToFileURL(bundleFile).href);

// ---------------------------------------------------------------------------
step('问题 2 · 「编辑海报」的轮播勾选框');

// 勾选框数量 = 海报张数，由桩里的海报集合决定（不写死数字，避免又对不上）
const EXPECTED = mod.POSTER_COUNT;

for (const mode of ['static', 'slideshow']) {
  const html = mod.renderDialog(mode);

  // 勾选框数量 = 海报张数。少了就说明有控件没渲染。
  const boxes = [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((m) => m[0]);
  const posterBoxes = boxes.filter((b) => b.includes('accent-sky-500'));

  posterBoxes.length === EXPECTED
    ? ok(`${mode} 模式下渲染出 ${EXPECTED} 个轮播勾选框（静态模式下也渲染 —— 旧实现这里是 0 个）`)
    : bad(`${mode} 模式下只有 ${posterBoxes.length} 个勾选框，期望 ${EXPECTED} 个`);

  const checked = posterBoxes.filter((b) => /\bchecked\b/.test(b)).length;

  if (mode === 'static') {
    // 由 posterList 决定：官方那张 true，三张相册 false
    checked === 1
      ? ok(`初始勾选 ${checked} 张 —— 只有官方海报在轮播里，相册截图一张都没勾`)
      : bad(`初始勾选 ${checked} 张，期望 1 张（相册截图不该默认勾上）`);
  }

  // 关键回归：静态模式下也必须有可点的控件
  if (mode === 'static' && posterBoxes.length === 0) {
    bad('静态模式下勾选框不存在 —— 用户无法取消勾选（这正是被报告的 bug）');
  }
}

// 反面断言：确认页面里没有把勾选框藏起来的条件渲染痕迹
{
  const html = mod.renderDialog('static');
  const hasToggle = html.includes('accent-sky-500');
  hasToggle
    ? ok('静态模式下勾选框确实存在于 DOM（不再是 mode==="slideshow" 才渲染）')
    : bad('静态模式下找不到勾选框');
}

// ---------------------------------------------------------------------------
step('问题 3 · 详情页大图区轮播（只看张数，不看任何模式开关）');

// 判据用 aria-label 精确定位「上一张 / 下一张」，不是数所有 <button>：
// 大图区里还有别的按钮（圆点、缩略图等），数总量会把它们一起算进来。
const arrowsIn = (html) =>
  [...html.matchAll(/<button[^>]*aria-label="([^"]*)"/g)]
    .map((m) => m[1])
    .filter((l) => /上一张|下一张|prev|next/i.test(l)).length;

// 多张图：容器 / 两个箭头 / 计数器都要在，且**不依赖任何模式开关** ——
// 组件已经没有 `mode` 可传，「传哪种模式」这件事本身不再存在。
{
  const html = mod.renderHero(['/a.png', '/b.png', '/c.png']);

  html.includes('data-testid="hero-carousel"')
    ? ok('大图区容器存在（详情页大图轮播挂载点）')
    : bad('大图区容器缺失');
  html.includes('data-testid="hero-counter"')
    ? ok('大图区有计数器（3 张图 → 多张时可翻页）')
    : bad('大图区缺少计数器');

  const a3 = arrowsIn(html);
  a3 === 2
    ? ok('3 张图时渲染上一张/下一张两个箭头（箭头常驻，不靠 hover）')
    : bad(`3 张图应渲染 2 个箭头，实际 ${a3} 个`);

  // 回归断言：`mode` / `data-mode` 已删除，不该再出现在 DOM 里。
  !html.includes('data-mode')
    ? ok('大图区不再渲染 data-mode（没有「模式」这一维，恒定自动轮播）')
    : bad('大图区仍在渲染 data-mode —— mode 语义应已删除');
}

// 单张图不应产生可翻页的错觉。
//
// 这两条以前只是 `info()` 打印，没有断言 —— 于是「单张图仍渲染出箭头」这种回归
// 会静静地打印一行 "按钮数 = 2" 然后报「8 项通过 / 0 项失败」。现在改成真断言。
{
  const html1 = mod.renderHero(['/only.png']);
  const a1 = arrowsIn(html1);
  if (a1 === 0) ok('单张图时不渲染翻页箭头（不会造成可翻页的错觉）');
  else bad(`单张图却渲染了 ${a1} 个翻页箭头`);
  !html1.includes('data-testid="hero-counter"')
    ? ok('单张图时不渲染计数器（1/1 没有意义）')
    : bad('单张图却渲染了计数器');

  // 多于一张时才该出现箭头 —— 否则上一条可能只是「箭头压根不渲染」而恒真。
  const html2 = mod.renderHero(['/a.png', '/b.png']);
  const a2 = arrowsIn(html2);
  if (a2 === 2) ok('两张图时渲染上一张/下一张两个箭头');
  else bad(`两张图应渲染 2 个箭头，实际 ${a2} 个`);
}

fs.rmSync(OUT, { recursive: true, force: true });

console.log(`\n\x1b[1m结果：${pass} 项通过 / ${fail} 项失败\x1b[0m\n`);
process.exit(fail ? 1 : 0);