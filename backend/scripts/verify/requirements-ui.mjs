/**
 * 本轮三项需求的浏览器行为验证（真实 Chromium）
 * ============================================================================
 *
 * 跑法：node backend/scripts/verify/requirements-ui.mjs
 *
 * 覆盖：
 *   · 需求 1「媒体评价分页」：默认 5 条 / 展开 10 条 / 单页最多 10 条 / 标注总数 / 翻页
 *   · 需求 2「平台切换」：有多个平台时出现选择器；切到某平台只剩该平台的评价
 *   · 需求 3「卡片箭头」：无可浏览图片（0 张或 1 张）时**不渲染**箭头，多于 1 张才渲染
 *
 * 用真实浏览器而不是纯 SSR：需求 2 的核心动作是「用户切了下拉框」，静态渲染永远停在
 * 初始 state，断言不到切换结果；需求 3 的箭头本身是 opacity-0 + hover 才显形，
 * 「节点到底在不在 DOM 里」只有渲染之后才作数。esbuild 打包的是**真实源码组件**。
 *
 * 浏览器来自仓库里已有的 Playwright 缓存（`.tmp-b/pw/`），不额外下载。
 * 页面用 file:// 直接打开自包含 bundle，因此**不启动任何服务、不监听端口**。
 */

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const WEB = path.join(ROOT, 'web');
const OUT = path.join(ROOT, '.tmp-req-ui');
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
const ok = (m) => { pass += 1; console.log(`   \x1b[32m✓\x1b[0m ${m}`); };
const bad = (m) => { fail += 1; console.log(`   \x1b[31m✗\x1b[0m ${m}`); };
const step = (m) => console.log(`\n\x1b[1m== ${m}\x1b[0m`);

// ─────────────────────────────────────────────────────────────────────────────
// 打包：真实源码组件 + 把渲染函数挂到 window 上的入口。
// ─────────────────────────────────────────────────────────────────────────────
const ENTRY = `
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import MediaReviewsPanel from "${WEB}/src/components/MediaReviewsPanel.tsx";
import GameCard from "${WEB}/src/components/GameCard.tsx";
import { I18nProvider } from "${WEB}/src/i18n/index.tsx";
import { SSR_REVIEWS } from "${ROOT}/backend/scripts/verify/ssr-hooks-stub.mjs";

const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });

function wrap(node) {
  return React.createElement(
    QueryClientProvider,
    { client: qc },
    React.createElement(I18nProvider, null, React.createElement(MemoryRouter, null, node)),
  );
}

window.__REVIEW_COUNT = SSR_REVIEWS.length;

window.renderReviews = () => {
  createRoot(document.getElementById("reviews")).render(
    wrap(React.createElement(MediaReviewsPanel, { gameId: "g-1" })),
  );
};

/** posters 就是首页卡片的轮播队列 —— 封面优先、已去重（后端 slideshowPosters 保证）。 */
function makeGame(posterUrls) {
  return {
    id: "g-1",
    name: "测试游戏",
    folderPath: "/tmp/g1",
    platform: "PS5",
    platforms: ["PS5"],
    customPlatform: false,
    posterUrl: posterUrls[0] ?? null,
    posters: posterUrls,
    posterMode: "static",
    mediaCount: 0,
    durationSeconds: 0,
    durationText: "",
    metacriticScore: null,
    metacriticCriticCount: null,
  };
}

/**
 * 三张**互不相同**且必定加载成功的 1x1 图片。
 *
 * 不能用 '/p0.png' 这类路径：浏览器里会 404，而 PosterLayer 的 onError 会把该层
 * 渲染成 null —— 于是「图片有没有渲染出来」的断言全部失败，看起来像缺陷其实只是
 * 资源不存在。
 *
 * 也**不能**在 data URI 后面拼查询串来制造差异（PIXEL + '?1'）：那会让 data URI
 * 失效、图片加载失败，症状与上面完全相同。直接准备三个不同的 base64 串。
 */
const PIXELS = [
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=",
  "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=",
  "data:image/gif;base64,R0lGODlhAQABAIAAAP//AAAAACwAAAAAAQABAAACAkQBADs=",
  "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAACAkQBADs=",
];
window.PIXELS = PIXELS;

window.renderCard = (targetId, posterUrls) => {
  createRoot(document.getElementById(targetId)).render(
    wrap(React.createElement(GameCard, { game: makeGame(posterUrls) })),
  );
};
`;

// ENTRY 是用模板字符串写的，里面出现裸背引号会截断它，报出一个与真实原因
// 无关的语法错误（这个坑踩了两次）。构建前先自检，把错误指向真正的问题。
{
  // 用模块自身的源码文本做检查（ENTRY 的边界就在本文件里）。
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const a = src.indexOf('const ENTRY = `') + 'const ENTRY = `'.length;
  const b = src.indexOf('\n`;', a);
  const body = src.slice(a, b);
  const stray = body
    .split('\n')
    .filter((l) => l.includes('`') && !l.includes('\\`'));
  if (stray.length) {
    console.error('ENTRY 模板里出现未转义的背引号（会截断模板字符串）：');
    for (const l of stray) console.error(`  ${l.trim()}`);
    process.exit(1);
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const bundlePath = path.join(OUT, 'bundle.js');

await build({
  stdin: { contents: ENTRY, resolveDir: ROOT, sourcefile: 'entry.tsx', loader: 'tsx' },
  bundle: true,
  outfile: bundlePath,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  logLevel: 'error',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    {
      name: 'stub-api-hooks',
      setup(b) {
        // 把 tRPC hooks 换成桩。浏览器里没有后端，真实 hook 会发请求、失败、然后
        // 组件渲染成空状态 —— 「条数 / 分页 / 平台筛选」就一条都断言不到。
        // 桩只喂数据；数据的产生逻辑（抓取、落库）由后端 e2e 与 crawl 测试覆盖。
        //
        // 注意：这与 `poster-ui-ssr.mjs` 用的是**同一个**桩文件，所以桩必须覆盖所有
        // 被渲染组件用到的 handle。往桩里加新 hook 时两边一起生效。
        b.onResolve({ filter: /api\/hooks$/ }, () => ({
          path: path.join(ROOT, 'backend/scripts/verify/ssr-hooks-stub.mjs'),
        }));
      },
    },
  ],
});

const HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>requirements-ui</title></head><body>
<div id="reviews"></div>
<div id="card0"></div><div id="card1"></div><div id="card2"></div>
<div id="card5"></div><div id="carddup"></div>
<script src="bundle.js"></script>
</body></html>`;
fs.writeFileSync(path.join(OUT, 'index.html'), HTML);

// ─────────────────────────────────────────────────────────────────────────────
// 启动 Chromium
// ─────────────────────────────────────────────────────────────────────────────
const EXE = path.join(ROOT, '.tmp-b/pw/chromium-1134/chrome-linux/chrome');
if (!fs.existsSync(EXE)) {
  console.error(`找不到 Chromium：${EXE}\n（本脚本用仓库里已有的 Playwright 缓存，不联网下载）`);
  process.exit(1);
}
const { chromium } = require('playwright');
const browser = await chromium.launch({
  executablePath: EXE,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(String(err)));

await page.goto(pathToFileURL(path.join(OUT, 'index.html')).href);
await page.waitForFunction(() => typeof window.renderReviews === 'function');

const REVIEW_TOTAL = await page.evaluate(() => window.__REVIEW_COUNT);
const cardCount = () => page.locator('[data-testid="media-review-card"]').count();
const outlets = () => page.locator('[data-testid="media-review-outlet"]').allTextContents();

// ─────────────────────────────────────────────────────────────────────────────
step('需求 1 · 媒体评价分页（默认 5 / 展开 10 / 单页最多 10 / 标注总数）');

await page.evaluate(() => window.renderReviews());
await page.waitForSelector('[data-testid="media-reviews-list"]');
console.log(`   灌入 ${REVIEW_TOTAL} 条评价（PS5 6 / PC 3 / Switch 2 / 无平台 2）`);
const LAST_PAGE = REVIEW_TOTAL - 10; // 10 条一页 → 第 2 页是余数

{
  const countLabel = await page.locator('[data-testid="media-reviews-count"]').textContent();
  if (new RegExp(String(REVIEW_TOTAL)).test(countLabel ?? '')) {
    ok(`标注了总数：${(countLabel ?? '').trim()}`);
  } else {
    bad(`总数标注不对：${countLabel}`);
  }

  let n = await cardCount();
  if (n === 5) ok('默认显示 5 条');
  else bad(`默认应显示 5 条，实际 ${n} 条`);

  const expandSel = '[data-testid="media-reviews-expand"]';
  if (await page.locator(expandSel).count()) {
    ok(`有「展开」按钮：${(await page.locator(expandSel).textContent()).trim()}`);
  } else {
    bad('没有「展开」按钮');
  }

  await page.click(expandSel);
  n = await cardCount();
  if (n === 10) ok('展开后显示 10 条');
  else bad(`展开后应显示 10 条，实际 ${n} 条`);

  if (n <= 10) ok('单页不超过 10 条（本轮要求的上限）');
  else bad(`单页出现 ${n} 条，超过 10 条上限`);

  if (!(await page.locator(expandSel).count())) ok('展开后按钮消失（没有可再展开的余地）');
  else bad('展开后按钮仍在');

  const pageLabel = await page.locator('[data-testid="media-reviews-page"]').textContent();
  if (pageLabel && /2/.test(pageLabel) && !/\/ 1 /.test(pageLabel)) ok(`有分页指示：${pageLabel.trim()}`);
  // 注：第 2 页时读数是「第 2 / 2 页」，所以这里还要排除掉「第 1 / 2 页」这种误读
  else bad(`分页指示不对：${pageLabel}`);

  await page.click('[data-testid="media-reviews-next"]');
  n = await cardCount();
  if (n === LAST_PAGE) ok(`翻到第 2 页显示剩余 ${LAST_PAGE} 条（${REVIEW_TOTAL} = 10 + ${LAST_PAGE}）`);
  else bad(`第 2 页应显示 ${LAST_PAGE} 条，实际 ${n} 条`);

  const shown = await page.locator('[data-testid="media-reviews-shown"]').textContent();
  if (shown && new RegExp(String(LAST_PAGE)).test(shown) && new RegExp(String(REVIEW_TOTAL)).test(shown)) {
    ok(`条数提示正确：${shown.trim()}`);
  } else {
    bad(`条数提示不对：${shown}`);
  }

  await page.click('[data-testid="media-reviews-prev"]');
  n = await cardCount();
  if (n === 5) ok('翻回第 1 页回到默认的 5 条');
  else bad(`翻回第 1 页应显示 5 条，实际 ${n} 条`);
}

// ─────────────────────────────────────────────────────────────────────────────
step('需求 2 · 平台切换');

{
  const sel = page.locator('[data-testid="media-reviews-platform-select"]');
  if (await sel.count()) ok('渲染出平台选择器');
  else bad('没有渲染出平台选择器');

  const options = await sel.locator('option').evaluateAll((els) => els.map((e) => e.value));
  console.log(`   选项：${options.join(' / ')}`);

  for (const want of ['__all__', 'PS5', 'PC', 'Switch']) {
    if (options.includes(want)) ok(`选项包含 ${want}`);
    else bad(`选项缺少 ${want}`);
  }
  if (options.length === 4) ok('选项数恰好 4（不列出该游戏没出现过评价的平台）');
  else bad(`选项数为 ${options.length}，期望 4`);

  const ps5Text = await sel.locator('option[value="PS5"]').textContent();
  if (ps5Text && /6/.test(ps5Text)) ok(`选项标注了该平台条数：${ps5Text.trim()}`);
  else bad(`PS5 选项未标注 6 条：${ps5Text}`);

  await sel.selectOption('PC');
  let n = await cardCount();
  let names = await outlets();
  console.log(`   切到 PC 后：${n} 条 → ${names.join(', ')}`);
  if (n === 3) ok('切到 PC 后只剩 3 条');
  else bad(`切到 PC 后应剩 3 条，实际 ${n} 条`);

  const allPc = names.every((o) => ['PC Gamer', 'Rock Paper Shotgun', 'PCGamesN'].includes(o));
  if (allPc && names.length === 3) ok('剩下的确实都是 PC 平台的媒体');
  else bad(`混入了非 PC 媒体：${names.join(', ')}`);

  const texts = await page.locator('[data-testid="media-review-card"]').allTextContents();
  if (texts.length && texts.every((t) => t.includes('PC'))) ok('卡片上的平台标注与筛选一致（PC）');
  else bad('有卡片的平台标注不是 PC');

  const shownPc = await page.locator('[data-testid="media-reviews-shown"]').textContent();
  if (shownPc && /3/.test(shownPc)) ok(`条数提示跟着筛选变化：${shownPc.trim()}`);
  else bad(`条数提示未跟随筛选：${shownPc}`);

  await sel.selectOption('Switch');
  n = await cardCount();
  names = await outlets();
  if (n === 2) ok('切到 Switch 后剩 2 条');
  else bad(`切到 Switch 后应剩 2 条，实际 ${n} 条`);
  if (names.length && names.every((o) => ['Nintendo Life', 'God is a Geek'].includes(o))) {
    ok('剩下的确实都是 Switch 平台的媒体');
  } else {
    bad(`混入了非 Switch 媒体：${names.join(', ')}`);
  }

  await sel.selectOption('__all__');
  n = await cardCount();
  if (n === 5) ok('切回「全部平台」后回到第一页 5 条');
  else bad(`切回全部后应显示 5 条，实际 ${n} 条`);

  const anyUnknown = options.some((o) => /未知|unknown/i.test(o));
  if (!anyUnknown) ok('没有为无平台评价单独建选项（它们留在「全部」里）');
  else bad('出现了「未知平台」选项');
}

// ─────────────────────────────────────────────────────────────────────────────
step('需求 3 · 首页卡片轮播箭头（无可浏览图片时隐藏）');

/** 卡片里的上一张/下一张按钮 —— 由 aria-label 定位，与组件渲染一致。 */
const arrowCount = (id) =>
  page.locator(`#${id} button[aria-label]`).evaluateAll((els) =>
    els.filter((b) => /上一张|下一张|prev|next/i.test(b.getAttribute('aria-label') || '')).length,
  );

/** 渲染 n 张**必定可见**的图（data URI，不会 404）。 */
const renderCardWith = (id, n) =>
  page.evaluate(
    ({ id, n }) => window.renderCard(id, window.PIXELS.slice(0, n)),
    { id, n },
  );

{
  await renderCardWith('card0', 0);
  await page.waitForTimeout(150);
  let n = await arrowCount('card0');
  if (n === 0) ok('0 张图片时不渲染箭头');
  else bad(`0 张图片却渲染了 ${n} 个箭头`);

  // 本轮最关键的一条
  await renderCardWith('card1', 1);
  await page.waitForTimeout(200);
  n = await arrowCount('card1');
  if (n === 0) ok('1 张图片时不渲染箭头（无可浏览对象）');
  else bad(`1 张图片却渲染了 ${n} 个箭头 —— 需求未达成`);
  const imgs1 = await page.locator('#card1 img').count();
  if (imgs1 === 1) ok('这 1 张图正常渲染');
  else bad(`期望渲染出 1 张图，实际 ${imgs1} 张`);

  await renderCardWith('card2', 2);
  await page.waitForTimeout(200);
  n = await arrowCount('card2');
  if (n === 2) ok('2 张图片时渲染上一张/下一张两个箭头');
  else bad(`2 张图片应渲染 2 个箭头，实际 ${n} 个`);

  // 点箭头真的换图。
  //
  // 判据用**计数器读数**（「1/2」→「2/2」），不用不透明度。
  // 原因：本测试页只注入 JS bundle，不加载 Tailwind 产物，于是 `opacity-0` /
  // `opacity-100` 两个类都没有样式，所有层都落到默认的 opacity:1 —— 靠不透明度
  // 判断“哪一层可见”在这里恒为并列，只会得出「点了没反应」的错误结论。
  // （已确认这两个类在生产 CSS 里都存在，且 .opacity-100 在后，所以真实页面上
  //   只有活动层是可见的；这里换判据是为了测行为，不是为了绕过缺陷。）
  if (n === 2) {
    const counter = async () => {
      const t = await page.locator('#card2').textContent();
      const m = t.match(/(\d+)\/(\d+)/);
      return m ? m[0] : null;
    };

    const before = await counter();
    await page.locator('#card2 button[aria-label]').nth(1).click();
    await page.waitForTimeout(400);
    const after = await counter();

    if (before === '1/2' && after === '2/2') {
      ok(`点「下一张」计数从 ${before} 变为 ${after}（确实换到了第 2 张）`);
    } else {
      bad(`点「下一张」计数应从 1/2 变为 2/2，实际 ${before} → ${after}`);
    }

    // 再点「上一张」应回到第 1 张
    await page.locator('#card2 button[aria-label]').nth(0).click();
    await page.waitForTimeout(400);
    const back = await counter();
    if (back === '1/2') ok('点「上一张」计数回到 1/2');
    else bad(`点「上一张」应回到 1/2，实际 ${back}`);

    // 循环：第 1 张再点上一张 → 绕到最后一张（2/2）
    await page.locator('#card2 button[aria-label]').nth(0).click();
    await page.waitForTimeout(400);
    const wrapped = await counter();
    if (wrapped === '2/2') ok('在第 1 张点「上一张」会绕到最后一张（2/2），不会卡住');
    else bad(`循环翻页异常：期望 2/2，实际 ${wrapped}`);
  }

  await renderCardWith('card5', 5);
  await page.waitForTimeout(200);
  n = await arrowCount('card5');
  if (n === 2) ok('5 张图片时仍是 2 个箭头（不是每张一个）');
  else bad(`5 张图片应渲染 2 个箭头，实际 ${n} 个`);
  if (await page.locator('#card5').getByText('1/5').count()) ok('计数器显示 1/5');
  else bad('计数器没有显示 1/5');

  // 同一张图重复出现（封面与队列首项相同时后端已去重）不该被当成 2 张
  await page.evaluate(() =>
    window.renderCard('carddup', [window.PIXELS[0], window.PIXELS[0]]),
  );
  await page.waitForTimeout(200);
  n = await arrowCount('carddup');
  if (n === 0) ok('重复的同一张图被当作 1 张，不渲染箭头');
  else bad(`重复图被误判为多张，渲染了 ${n} 个箭头`);
}

// ─────────────────────────────────────────────────────────────────────────────
step('页面运行时无 JS 错误（忽略环境性的后端请求失败）');

// file:// 页面没有后端，偏好设置等请求必然失败 —— 与本轮三项需求无关，过滤掉。
// 留下的是渲染期的真实错误（React 报错、未捕获异常等）。
const IGNORE = /settings\/preferences|ERR_INVALID_URL|Failed to load resource|net::ERR_/i;
const realErrors = consoleErrors.filter((e) => !IGNORE.test(e));

if (realErrors.length === 0) {
  ok(`没有渲染期错误（已忽略 ${consoleErrors.length - realErrors.length} 条环境性的后端请求失败）`);
} else {
  bad(`出现 ${realErrors.length} 条渲染期错误：`);
  for (const e of realErrors.slice(0, 5)) console.log(`     · ${e.slice(0, 200)}`);
}

await browser.close();
console.log(`\n\x1b[1m结果：${pass} 项通过 / ${fail} 项失败\x1b[0m\n`);
fs.rmSync(OUT, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);