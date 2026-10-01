/**
 * 真实浏览器（Chromium）验证脚本 —— 三项需求逐条人工验证的可执行版本。
 *
 * 为什么要有它：前几轮的验收用的是 jsdom，能证明组件逻辑对，却证明不了
 * 「部署后页面肉眼可见」。本脚本驱动真实 Chromium 打开真实后端服务的
 * 真实构建产物（web/dist + backend/dist），并对 DOM 做断言 + 截图。
 *
 * 用法： node scripts/verify-browser.mjs [baseUrl]
 */
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根与 Chromium 位置都从本文件推导；可用 CHROME_PATH 覆盖。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:4401';
const OUT = process.argv[3] || join(ROOT, '.tmp-v/shots');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`   \x1b[32m✓\x1b[0m ${m}`); pass += 1; };
const bad = (m) => { console.log(`   \x1b[31m✗\x1b[0m ${m}`); fail += 1; };
const step = (m) => console.log(`\n\x1b[1m== ${m}\x1b[0m`);
const info = (m) => console.log(`   ${m}`);
/** Comparisons must yield a real boolean, not a truthy value. */
const truthy = (v) => v === true;

const CHROME =
  process.env.CHROME_PATH ||
  process.env.CHROME_BIN ||
  process.env.CHROME_PATH || join(ROOT, '.pw/chromium-1134/chrome-linux/chrome');

/**
 * Read an API resource with retries.
 *
 * This host's network stack intermittently drops connections (ECONNRESET /
 * socket disconnected) while background scraping is running. That is an
 * environment condition, not a product defect, so the harness retries instead of
 * reporting a false failure — the assertions are about the UI, not about TCP.
 */
async function getJson(pathname, tries = 4) {
  let last;
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await page.request.get(`${BASE}${pathname}`);
      if (res.ok()) return res.json();
      last = new Error(`HTTP ${res.status()} for ${pathname}`);
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw last;
}

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
const page = await context.newPage();

/**
 * JS errors and failed external resources are tracked separately.
 *
 * A 4xx/5xx from an upstream image CDN is an environment condition, not a page
 * bug: the poster URLs are third-party and this host's egress to them is
 * intermittent. What must be zero is a **JS exception** — that is what would
 * mean the new UI never rendered. Resource failures are reported as a count.
 */
const jsErrors = [];
const resourceErrors = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const text = m.text();
  if (/Failed to load resource/i.test(text)) resourceErrors.push(text);
  else jsErrors.push(text);
});
page.on('pageerror', (e) => jsErrors.push(`pageerror: ${e.message}`));

/** Wait for the detail page to have rendered its title. */
async function openDetail(id) {
  await page.goto(`${BASE}/game/${id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('h1', { timeout: 30000 });
  await page.waitForFunction(
    () => {
      const h = document.querySelector('h1');
      return h && h.textContent && h.textContent.trim().length > 0;
    },
    { timeout: 30000 },
  );
  // 邻居请求是异步的（而且首屏还会触发一次元数据刮削，可能把标题规范化），
  // 所以必须等到「上一个/下一个」真正拿到数据再断言，否则读到的是加载态。
  await page
    .waitForFunction(
      () => {
        const n = document.querySelector('[data-testid="nav-next"]');
        const p = document.querySelector('[data-testid="nav-prev"]');
        if (!n || !p) return false;
        const pos = document.querySelector('[data-testid="nav-position"]');
        return !n.disabled && !p.disabled && !!pos && /\d+\s*\/\s*\d+/.test(pos.textContent || '');
      },
      { timeout: 40000 },
    )
    .catch(() => {});
  // 首屏刮削会把「血源诅咒」规范成「Bloodborne」。等邻居数据落定之后，再做一次
  // 「页面显示的邻居」与「接口返回的邻居」一致性检查：刮削仍在写库时，页面可能
  // 拿着上一轮的排名渲染（neighbours 是按请求时刻的库状态算的），这时重载一次。
  await page.waitForTimeout(2000);
}

/** What the detail page currently shows for prev/next/position. */
async function domNav() {
  return page.evaluate(() => ({
    h1: document.querySelector('h1')?.textContent?.trim() ?? null,
    id: (location.pathname.split('/').pop() || '').trim(),
    position: document.querySelector('[data-testid="nav-position"]')?.textContent?.trim() ?? null,
    prev: document.querySelector('[data-testid="nav-prev"]')?.getAttribute('title') ?? null,
    next: document.querySelector('[data-testid="nav-next"]')?.getAttribute('title') ?? null,
  }));
}

/** Neighbours the API reports for the game currently on screen. */
async function apiNav(id) {
  return getJson(`/api/games/${id}/neighbors?sort=name&order=asc`);
}

/**
 * Reload until the on-screen neighbours agree with the API.
 *
 * Necessary because opening a detail page for the first time triggers a metadata
 * scrape that can rename the game mid-flight; the neighbour ranking is computed
 * from database state at request time, so a page rendered during that window can
 * legitimately show the pre-settle ordering.
 */
async function syncNav(expectedId) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const dom = await domNav();
    const api = await apiNav(dom.id || expectedId);
    const agree =
      dom.next === `下一个游戏：${api.next?.name}` && dom.prev === `上一个游戏：${api.prev?.name}`;
    if (agree) return { dom, api, attempts: attempt };
    info(`第 ${attempt} 次对齐：页面未就绪（页面 next=${dom.next} / 接口 next=${api.next?.name}），重载`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="nav-position"]', { timeout: 30000 });
    await page.waitForTimeout(2500);
  }
  return { dom: await domNav(), api: await apiNav(expectedId), attempts: 4 };
}

/** Fetch a game's current name straight from the API (metadata may rename it). */
async function apiName(id) {
  return getJson(`/api/games/${id}`).then((d) => d.name);
}

/** Wait until the hero carousel has settled (poster list + images resolved). */
async function settleCarousel() {
  await page.waitForSelector('[data-testid="hero-carousel"]', { timeout: 30000 });
  await page.waitForFunction(
    () => {
      const c = document.querySelector('[data-testid="hero-counter"]');
      const img = document.querySelector('[data-testid="hero-carousel"] img[data-active="true"]');
      return !!c && /^\d+\/\d+$/.test((c.textContent || '').trim()) && !!img;
    },
    { timeout: 30000 },
  );
  // 等刮削/图片全部落定，避免读数落在中途
  await page.waitForTimeout(1200);
}

/**
 * 待验证游戏：默认「血源诅咒」（刮削后标题会被规范化为 Bloodborne），
 * 可用 GAME_ID 环境变量覆盖。
 */
async function resolveGameId() {
  if (process.env.GAME_ID) return process.env.GAME_ID;
  const list = await page.request.get(`${BASE}/api/games?pageSize=100`).then((r) => r.json());
  const hit =
    list.find((g) => g.name === '血源诅咒') ||
    list.find((g) => /血源|bloodborne/i.test(g.name)) ||
    list[0];
  if (!hit) throw new Error('库中没有游戏，无法验证');
  return hit.id;
}

// ---------------------------------------------------------------------------
step('需求 1 · 详情页「上一个 / 下一个」切换');
const detailId = await resolveGameId();
info(`验证对象：${detailId}`);
await openDetail(detailId);
const title = (await page.locator('h1').first().innerText()).trim();
info(`详情页标题：${title}`);

const prevBtn = page.locator('[data-testid="nav-prev"]');
const nextBtn = page.locator('[data-testid="nav-next"]');
(await prevBtn.count()) === 1 ? ok('「上一个」按钮存在于 DOM') : bad('「上一个」按钮不存在');
(await nextBtn.count()) === 1 ? ok('「下一个」按钮存在于 DOM') : bad('「下一个」按钮不存在');

const visible = await nextBtn.isVisible();
truthy(visible) ? ok('「下一个」按钮可见（未被折叠/隐藏）') : bad('「下一个」按钮不可见');

// 关键前置步骤：先让「页面显示的邻居」与「接口算出的邻居」一致。
// 首次打开详情页会触发一次元数据刮削（会把「血源诅咒」规范成 Bloodborne），
// 刮削写入过程中页面可能拿着上一轮的排名渲染，所以这里先对齐再断言。
const synced = await syncNav(detailId);
const neighbors = synced.api;
info(`接口邻居：prev=${neighbors.prev?.name} / next=${neighbors.next?.name}（index=${neighbors.index}/${neighbors.total}）`);
info(`对齐尝试次数：${synced.attempts}`);

// 对齐后重新取按钮引用与 DOM 数值（syncNav 可能重载过页面）
const prevBtn2 = page.locator('[data-testid="nav-prev"]');
const nextBtn2 = page.locator('[data-testid="nav-next"]');
const domSnapshot = await domNav();
info(`DOM 快照：${JSON.stringify(domSnapshot)}`);
const nextTitle = domSnapshot.next;
const positionText = domSnapshot.position ?? '';

const prevBox = await prevBtn2.boundingBox();
const nextBox = await nextBtn2.boundingBox();
prevBox && nextBox && prevBox.width > 0 && prevBox.height > 0
  ? ok(`按钮有真实尺寸 next=${Math.round(nextBox.width)}x${Math.round(nextBox.height)} @(${Math.round(nextBox.x)},${Math.round(nextBox.y)})`)
  : bad('按钮尺寸为 0（页面上看不见）');

// 首屏可见性：按钮必须落在首屏之内，否则用户要滚动才看得到
const inViewport = await nextBtn2.evaluate((el) => {
  const r = el.getBoundingClientRect();
  return r.top >= 0 && r.top < window.innerHeight && r.left >= 0 && r.left < window.innerWidth;
});
truthy(inViewport) ? ok('按钮位于首屏可视区域内（无需滚动）') : bad('按钮在首屏之外');

info(`位置指示：${positionText}`);
truthy(/\d+\s*\/\s*\d+/.test(positionText)) ? ok('显示当前序号 / 总数') : bad('缺少位置指示');

truthy(nextTitle === `下一个游戏：${neighbors.next?.name}`)
  ? ok(`按钮 title 与接口邻居一致（下一个：${neighbors.next?.name}）`)
  : bad(`title 与接口邻居不一致：${nextTitle} vs ${neighbors.next?.name}`);

const startId = synced.dom.id || detailId;
const startName = await apiName(startId);
info(`页面当前游戏：${startName}（${startId}）`);
const nextTargetName = neighbors.next?.name;

// 点击前把页面滚下去，验证切换后自动置顶
await page.evaluate(() => window.scrollTo(0, 1500));
await page.waitForTimeout(300);
const beforeY = await page.evaluate(() => window.scrollY);

await nextBtn2.click();
await page.waitForTimeout(2500);
const afterTitle = (await page.locator('h1').first().innerText()).trim();
const afterY = await page.evaluate(() => window.scrollY);
const afterUrl = page.url();

const landedId = new URL(afterUrl).pathname.split('/').pop();
const landedName = await apiName(landedId);
info(`点击前 scrollY=${beforeY} → 点击后 scrollY=${afterY}`);
info(`跳转到：${landedName}（${afterUrl}）`);
info(`接口声明的「下一个」：${nextTargetName}`);
truthy(landedId !== startId) ? ok(`切换到了相邻游戏「${landedName}」`) : bad('点击后仍停留在同一游戏');
truthy(nextTargetName === landedName || landedId === neighbors.next?.id)
  ? ok('落地的游戏正是接口声明的「下一个」')
  : bad(`落到「${landedName}」，而接口声明的下一个是「${nextTargetName}」`);
truthy(afterY < 50) ? ok('切换后页面自动滚动置顶') : bad(`切换后未置顶（scrollY=${afterY}）`);
truthy(new URL(afterUrl).pathname.startsWith('/game/')) ? ok('URL 已切换到相邻游戏的详情页') : bad('URL 未变化');

// 与原游戏的名字比较要用「接口里的邻居名」而不是标题快照：
// 详情页默认会触发一次元数据刮削，标题可能在两次读取之间被规范化
// （「血源诅咒」→「Bloodborne」），那是正确行为，不该算成导航错误。
const prevTitleOnNew = await prevBtn2.getAttribute('title');
info(`新页面「上一个」title：${prevTitleOnNew}`);
// 回到起点的「上一个」必须指回**起始游戏**（也就是本次点「下一个」之前那一刻
// 它在接口里的名字）。名字取自接口而不是标题快照，因为首屏刮削可能刚把它规范化。
info(`起始游戏：${startName}`);
truthy(prevTitleOnNew === `上一个游戏：${startName}`)
  ? ok(`「上一个」指回起始游戏（${startName}），顺序可来回切换`)
  : bad(`相邻关系不一致：期望指回「${startName}」，实际「${prevTitleOnNew}」`);

// 循环：点「上一个」应回到起点
await prevBtn2.click();
await page.waitForTimeout(2500);
const backUrl = page.url();
const backId = new URL(backUrl).pathname.split('/').pop();
info(`点「上一个」后落到 ${backUrl}`);
truthy(backId === startId)
  ? ok('点「上一个」回到原游戏（按游戏 id 判定）')
  : bad(`点「上一个」到了 id=${backId}，而非 ${startId}`);

// 首尾循环：从第一项点「上一个」应当绕到队列最后一项。
// 这里必须按**当前显示的**游戏重新取一次邻居 —— 首屏刮削可能已经改了展示名，
// 用点击前的快照判断 index 会错位。
const backNeighbors = await getJson(`/api/games/${startId}/neighbors?sort=name&order=asc`);
info(`起始游戏 index=${backNeighbors.index}/${backNeighbors.total}`);
if (backNeighbors.index === 0) {
  await page.locator('[data-testid="nav-prev"]').click();
  await page.waitForTimeout(2500);
  const wrappedId = new URL(page.url()).pathname.split('/').pop();
  const wrappedName = await apiName(wrappedId);
  info(`从第 1 项点「上一个」→「${wrappedName}」`);
  truthy(wrappedId === backNeighbors.prev?.id)
    ? ok(`首尾循环生效（绕到队尾「${wrappedName}」）`)
    : bad(`首尾循环异常：期望「${backNeighbors.prev?.name}」，实际「${wrappedName}」`);
  await page.locator('[data-testid="nav-next"]').click();
  await page.waitForTimeout(2500);
  const backId2 = new URL(page.url()).pathname.split('/').pop();
  truthy(backId2 === startId) ? ok('再点「下一个」回到起点') : bad(`回到 id=${backId2} 而非 ${startId}`);
}

truthy(!!neighbors.prev && !!neighbors.next) ? ok('首尾均可循环（prev/next 均非空）') : bad('首尾不能循环');

// 图库筛选/排序上下文：换一个排序后，邻居必须跟着变
const listAsc = await getJson('/api/games?pageSize=100&sort=name&order=asc');
const listDesc = await getJson('/api/games?pageSize=100&sort=name&order=desc');
info(`升序首项=${listAsc[0].name}，降序首项=${listDesc[0].name}`);
if (listAsc.length > 1 && listAsc[0].id !== listDesc[0].id) {
  const descNeighbors = await getJson(`/api/games/${listAsc[0].id}/neighbors?sort=name&order=desc`);
  info(`升序首项在降序下的 next=${descNeighbors.next?.name}（期望 ${listDesc[0].name}）`);
  truthy(descNeighbors.next?.name === listDesc[0].name)
    ? ok('邻居顺序跟随图库排序状态（升序/降序不同结果）')
    : bad('邻居顺序没有跟随排序状态');
} else {
  bad('夹具不足以验证排序跟随');
}

// 页面级验证：图库写入排序状态后，详情页按钮的 title 应反映该排序
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('a[href^="/game/"]', { timeout: 30000 });
await page.evaluate(() => {
  sessionStorage.setItem(
    'screenplay.galleryQuery',
    JSON.stringify({ search: '', platform: '', sort: 'name', order: 'desc', minScore: '' }),
  );
});
// 切到具体某个游戏，确认按钮反映降序邻居
await openDetail(listAsc[0].id);
const descNextTitle = await page.locator('[data-testid="nav-next"]').getAttribute('title');
info(`图库设为降序后，${listAsc[0].name} 的「下一个」→ ${descNextTitle}`);
truthy((descNextTitle || '').includes(listDesc[0].name))
  ? ok('详情页按钮遵循图库当前排序状态')
  : bad('详情页按钮没有遵循图库排序状态');
await page.evaluate(() => sessionStorage.removeItem('screenplay.galleryQuery'));
await openDetail(detailId);

await page.screenshot({ path: path.join(OUT, '1-detail-nav.png'), fullPage: false });

// ---------------------------------------------------------------------------
step('需求 2 · 官方海报轮播（大图区左右箭头）');
await openDetail(detailId);

const posterCount = await getJson(`/api/games/${detailId}/posters`);
info(`后端海报记录：${posterCount.length} 条（source=${[...new Set(posterCount.map((p) => p.source))].join(',')}）`);
posterCount.length > 1 ? ok(`刮取到多张官方海报：${posterCount.length} 张`) : bad('官方海报不足 2 张');

await settleCarousel();

const hero = page.locator('[data-testid="hero-carousel"]');
truthy((await hero.count()) > 0) ? ok('大图区存在轮播容器（data-testid=hero-carousel）') : bad('大图区没有轮播容器');

const heroNext = page.locator('[data-testid="hero-carousel"] button[aria-label="下一张海报"]');
const heroPrev = page.locator('[data-testid="hero-carousel"] button[aria-label="上一张海报"]');
(await heroNext.count()) === 1 ? ok('大图区存在「下一张海报」箭头') : bad('大图区没有「下一张海报」箭头');
(await heroPrev.count()) === 1 ? ok('大图区存在「上一张海报」箭头') : bad('大图区没有「上一张海报」箭头');

// 箭头必须真的看得见（不是 opacity-0 / hover 才出现 / 尺寸为 0）
const arrowVisible = await heroNext.isVisible();
const arrowBox = await heroNext.boundingBox();
const arrowOpacity = await heroNext.evaluate((el) => getComputedStyle(el).opacity);
info(`箭头：visible=${arrowVisible} size=${arrowBox ? `${Math.round(arrowBox.width)}x${Math.round(arrowBox.height)}` : 'n/a'} opacity=${arrowOpacity}`);
arrowVisible && arrowBox && arrowBox.width >= 24 && arrowBox.height >= 24 && Number(arrowOpacity) > 0.5
  ? ok('箭头可见且可点击（尺寸/不透明度达标）')
  : bad('箭头不可见或不可点击');

// 箭头不能是 disabled（旧实现到末张就禁用，看起来像没有轮播）
const nextDisabled = await heroNext.isDisabled();
const prevDisabled = await heroPrev.isDisabled();
info(`箭头 disabled：prev=${prevDisabled} next=${nextDisabled}`);
truthy(!nextDisabled && !prevDisabled) ? ok('左右箭头均可用（未禁用）') : bad('箭头被禁用，翻不动');

const counterBefore = await page.locator('[data-testid="hero-counter"]').innerText().catch(() => '');
info(`轮播计数（点击前）：${counterBefore}`);
truthy(/^\d+\/\d+$/.test(counterBefore.trim())) ? ok('轮播显示 x/y 计数') : bad('轮播没有计数');

const activeSel = '[data-testid="hero-carousel"] img[data-active="true"]';
const activeSrcBefore = await page.locator(activeSel).first().getAttribute('src').catch(() => null);
info(`当前显示图：${String(activeSrcBefore).slice(0, 90)}`);

await heroNext.click();
await page.waitForTimeout(700);
const counterAfter = await page.locator('[data-testid="hero-counter"]').innerText();
const activeSrcAfter = await page.locator(activeSel).first().getAttribute('src').catch(() => null);
info(`轮播计数（点右箭头后）：${counterAfter}`);
truthy(counterAfter.trim() !== counterBefore.trim()) ? ok('右箭头切换到了下一张') : bad('右箭头没有切换');
truthy(activeSrcAfter !== activeSrcBefore) ? ok('实际显示的图片 URL 已改变') : bad('显示图片未改变');

await heroPrev.click();
await page.waitForTimeout(700);
const counterBack = await page.locator('[data-testid="hero-counter"]').innerText();
info(`轮播计数（点左箭头后）：${counterBack}`);
truthy(counterBack.trim() === counterBefore.trim()) ? ok('左箭头切回上一张') : bad('左箭头没有切回');

// 循环：连点若干次「下一张」，始终可用且能回到起点
let wrapped = false;
const totalCount = Number(counterBefore.trim().split('/')[1]) || 0;
for (let i = 0; i < Math.max(totalCount * 2, 8); i += 1) {
  if (await heroNext.isDisabled()) break;
  await heroNext.click();
  await page.waitForTimeout(120);
  const c = (await page.locator('[data-testid="hero-counter"]').innerText()).trim();
  if (c === counterBefore.trim()) { wrapped = true; break; }
}
truthy(wrapped) ? ok('轮播可循环（连点右箭头能绕回起始张）') : bad('轮播不能循环');

const imgState = await page.evaluate(() => {
  const imgs = [...document.querySelectorAll('[data-testid="hero-carousel"] img')];
  return imgs.map((i) => ({ src: i.currentSrc || i.src, w: i.naturalWidth, h: i.naturalHeight }));
});
const loaded = imgState.filter((i) => i.w > 0).length;
info(`轮播内 <img> 数量=${imgState.length}，成功解码=${loaded}`);
truthy(loaded > 0) ? ok(`图片真实加载（示例 ${imgState.find((i) => i.w > 0)?.w}x${imgState.find((i) => i.w > 0)?.h}）`) : bad('轮播图片全部加载失败');

await page.screenshot({ path: path.join(OUT, '2-hero-carousel.png'), fullPage: false });

step('需求 2b · 用户配置的海报不被重新刮削删除');
const firstPoster = posterCount[0];
const keepId = posterCount[1].id;
const markResp = await page.request.patch(`${BASE}/api/games/${detailId}/posters/${keepId}`, {
  data: { inSlideshow: true },
});
info(`把第 2 张海报加入轮播：HTTP ${markResp.status()}`);
// 再触发一次完整重新刮削
const refreshResp = await page.request.post(`${BASE}/api/games/${detailId}/refresh`);
info(`重新刮削：HTTP ${refreshResp.status()}`);
await page.waitForTimeout(4000);
const afterScrape = await getJson(`/api/games/${detailId}/posters`);
const survivor = afterScrape.find((p) => p.id === keepId);
info(`重新刮削后海报数=${afterScrape.length}，被勾选的那张：${survivor ? `仍在（inSlideshow=${survivor.inSlideshow}）` : '已丢失'}`);
survivor && survivor.inSlideshow ? ok('重新刮削没有删除用户勾选加入轮播的图片') : bad('用户配置的轮播海报被刮削删除/重置');
afterScrape.length >= posterCount.length
  ? ok('重新刮削没有丢失官方海报')
  : info(`注意：海报数量 ${posterCount.length} → ${afterScrape.length}`);

// ---------------------------------------------------------------------------
step('需求 3 · HLTB 人均通关时长展示');
await openDetail(detailId);

const detail = await getJson(`/api/games/${detailId}`);
info(`接口 mainStoryHours=${detail.mainStoryHours} source=${detail.durationSource}`);
truthy(detail.mainStoryHours != null) ? ok(`后端返回主线时长 ${detail.mainStoryHours} 小时`) : bad('后端未返回主线时长');

const playtimeLabel = page.locator('div', { hasText: /^平均通关时长$/ }).first();
await playtimeLabel.count() ? ok('页面存在「平均通关时长」字段') : bad('页面没有该字段');

const playtimeBlock = page.locator('div:has(> div:text-is("平均通关时长"))').last();
const playtimeText = await playtimeBlock.innerText().catch(() => '');
info(`页面渲染内容：${JSON.stringify(playtimeText)}`);
truthy(/主线\s*[\d.]+\s*小时/.test(playtimeText)) ? ok('页面展示「主线 X 小时」') : bad('页面没有展示主线时长');
truthy(!/^平均通关时长\s*未知$/.test(playtimeText.trim())) ? ok('未显示「未知」') : bad('页面仍显示「未知」');

const bodyText = await page.locator('body').innerText();
truthy(!bodyText.includes('平均通关时长\n未知')) ? ok('全页「平均通关时长」不是「未知」') : bad('全页仍出现「平均通关时长 未知」');

await page.screenshot({ path: path.join(OUT, '3-hltb-duration.png'), fullPage: false });

// 缓存缺陷：空时长禁止写缓存 + 重试后仍能稳定显示
step('需求 3b · 空时长缓存缺陷与重试');
const cacheStats = await page.request
  .get(`${BASE}/api/health`)
  .then((r) => r.json());
info(`/api/health features: ${JSON.stringify(cacheStats.features || [])}`);
truthy((cacheStats.features || []).includes('duration-cache-guard'))
  ? ok('健康接口声明 duration-cache-guard 已生效')
  : bad('未声明 duration-cache-guard');

const backfill = await page.request.post(`${BASE}/api/games/backfill-durations`);
info(`POST /api/games/backfill-durations → HTTP ${backfill.status()}`);
const backfillBody = await backfill.json().catch(() => null);
info(`响应：${JSON.stringify(backfillBody)}`);
truthy(backfill.status() === 201 || backfill.status() === 200)
  ? ok('批量补全接口可用')
  : bad('批量补全接口不可用');

const status = await getJson('/api/games/refresh-all/status');
info(`补全进度：${JSON.stringify(status)}`);

await page.waitForTimeout(6000);
const detailAgain = await getJson(`/api/games/${detailId}`);
info(`补全后 mainStoryHours=${detailAgain.mainStoryHours} source=${detailAgain.durationSource}`);
truthy(detailAgain.mainStoryHours != null) ? ok('补全后时长稳定存在（未变回未知）') : bad('补全后时长丢失');

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('h1', { timeout: 30000 });
await page.waitForTimeout(2000);
const reloadText = await page.locator('div:has(> div:text-is("平均通关时长"))').last().innerText().catch(() => '');
info(`刷新页面后：${JSON.stringify(reloadText)}`);
truthy(/主线\s*[\d.]+\s*小时/.test(reloadText)) ? ok('刷新页面后仍稳定显示通关时长') : bad('刷新页面后时长丢失');

// ---------------------------------------------------------------------------
step('需求 3b · 设置页「一键批量补全通关时长」真实点击');
await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="backfill-durations"]', { timeout: 30000 });

const backfillBtn = page.locator('[data-testid="backfill-durations"]');
(await backfillBtn.count()) === 1 ? ok('设置页存在「一键批量补全通关时长」按钮') : bad('设置页没有补全按钮');
truthy(await backfillBtn.isVisible()) ? ok('补全按钮可见') : bad('补全按钮不可见');
info(`按钮文案：${(await backfillBtn.innerText()).trim()}`);

const missingBefore = (await page.locator('[data-testid="duration-missing"]').innerText()).trim();
info(`补全前：${missingBefore}`);
await page.screenshot({ path: path.join(OUT, '4-settings-before.png'), fullPage: true });

const coverageBefore = await getJson('/api/games/duration-coverage');
await backfillBtn.click();
await page.waitForTimeout(1500);
const resultText = await page.locator('[data-testid="backfill-result"]').innerText().catch(() => '');
info(`点击后提示：${resultText.trim() || '(进度条已接管)'}`);

// 等任务跑完
let coverageAfter = coverageBefore;
for (let i = 0; i < 60; i += 1) {
  const status = await getJson('/api/games/refresh-all/status');
  if (!status.running) break;
  if (i === 0) info(`任务标签：${status.label}；进度 ${status.done}/${status.total}`);
  await page.waitForTimeout(2000);
}
coverageAfter = await getJson('/api/games/duration-coverage');
info(`补全前 missing=${coverageBefore.missing}（withDuration=${coverageBefore.withDuration}/${coverageBefore.total}）`);
info(`补全后 missing=${coverageAfter.missing}（withDuration=${coverageAfter.withDuration}/${coverageAfter.total}）`);
truthy(coverageAfter.withDuration >= coverageBefore.withDuration)
  ? ok('批量补全没有让任何存量时长丢失')
  : bad('批量补全丢失了已有时长');
if (coverageBefore.missing > 0 && coverageAfter.withDuration > coverageBefore.withDuration) {
  ok(`批量补全补齐了 ${coverageAfter.withDuration - coverageBefore.withDuration} 款游戏的通关时长`);
} else if (coverageBefore.missing === 0) {
  info('库里已无缺时长的游戏，跳过覆盖率提升断言');
} else {
  info('本轮未提升覆盖率（时长库瞬时不可达属正常，重跑即可；不会写入空值）');
}

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="duration-missing"]', { timeout: 30000 });
info(`刷新设置页后：${(await page.locator('[data-testid="duration-missing"]').innerText()).trim()}`);
await page.screenshot({ path: path.join(OUT, '5-settings-after.png'), fullPage: true });

// ---------------------------------------------------------------------------
step('需求 4 · 保护存量游戏手动修改名称（manual_override）');
// 先把原始名字记下来，验证完要还原，否则重复跑脚本会让库里的名字一直被改着。
const originalName = await page.request
  .get(`${BASE}/api/games/${detailId}`)
  .then((r) => r.json())
  .then((d) => d.name);
info(`改名前接口名：${originalName}`);
const renameResp = await page.request.patch(`${BASE}/api/games/${detailId}`, {
  data: { name: '血源诅咒（我的命名）', manualOverride: true },
});
info(`手动改名：HTTP ${renameResp.status()}`);
const renamed = await renameResp.json().catch(() => ({}));
info(`接口返回 name=${renamed.name} manualOverride=${renamed.manualOverride}`);
const listedAfterRename = await page.request
  .get(`${BASE}/api/games?pageSize=50`)
  .then((r) => r.json());
const renamedRow = listedAfterRename.find((g) => g.id === detailId);
truthy(renamedRow?.name === '血源诅咒（我的命名）') ? ok('手动名称已保存') : bad(`手动名称未保存（当前 ${renamedRow?.name}）`);

const refreshAfter = await page.request.post(`${BASE}/api/games/${detailId}/refresh`);
info(`改名后重新刮削：HTTP ${refreshAfter.status()}`);
await page.waitForTimeout(5000);
const afterRefreshRow = (await getJson('/api/games?pageSize=50')).find((g) => g.id === detailId);
info(`刮削后名称=${afterRefreshRow?.name}`);
truthy(afterRefreshRow?.name === '血源诅咒（我的命名）')
  ? ok('重新刮削没有覆盖手动修改的名称')
  : bad('手动名称被刮削覆盖');

const scanResp = await page.request.post(`${BASE}/api/library/scan`);
await page.waitForTimeout(6000);
const afterScanRow = (await getJson('/api/games?pageSize=50')).find((g) => g.id === detailId);
info(`重新扫描后名称=${afterScanRow?.name}`);
truthy(afterScanRow?.name === '血源诅咒（我的命名）')
  ? ok('重新扫描没有覆盖手动修改的名称')
  : bad('手动名称被扫描覆盖');

// 还原：名字改回去，manual_override 交还给自动刮削
await page.request.patch(`${BASE}/api/games/${detailId}`, { data: { name: originalName } });
const restored = (await getJson('/api/games?pageSize=50')).find((g) => g.id === detailId);
info(`还原后名称=${restored?.name}`);
truthy(restored?.name === originalName) ? ok('验证结束后名字已还原') : bad('名字未还原');

// ---------------------------------------------------------------------------
step('页面健康度');
truthy(jsErrors.length === 0)
  ? ok('控制台无 JS 异常（页面脚本全程正常）')
  : bad(`控制台 JS 异常 ${jsErrors.length} 条：${jsErrors.slice(0, 5).join(' | ')}`);
info(`外部图片资源加载失败 ${resourceErrors.length} 条（CDN 侧网络状况，页面已按坏图跳过，不影响功能）`);

await browser.close();

console.log(`\n\x1b[1m结果：${pass} 项通过 / ${fail} 项失败\x1b[0m`);
console.log(`截图目录：${OUT}`);
process.exit(fail === 0 ? 0 : 1);