/**
 * 用户配置保护验收：重新刮削不得覆盖用户的海报配置。
 *
 * 本轮把「官方刮取到的海报/截图」改成**默认全部进轮播**（需求 2 的统一行为），
 * 所以「自动加入」与「尊重用户手动配置」这两条要求会互相拉扯：
 *
 *   - 用户主动取消勾选的某张，重新刮削后**不能**被自动重新加回来；
 *   - 用户指定的封面，重新刮削后必须还是封面；
 *   - 重新刮削后整体仍然是多张轮播（不能因为加入自动逻辑反而退化成单张）。
 *
 * 用法： node scripts/verify-poster-config.mjs http://127.0.0.1:4401
 */
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根与 Chromium 位置都从本文件推导；可用 CHROME_PATH 覆盖。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:4401';
const CHROME =
  process.env.CHROME_PATH ||
  process.env.CHROME_PATH || join(ROOT, '.tmp-b/pw/chromium-1134/chrome-linux/chrome');

let pass = 0;
let fail = 0;
const truthy = (v) => v === true;
const ok = (m) => { pass += 1; console.log(`   \x1b[32m✓\x1b[0m ${m}`); };
const bad = (m) => { fail += 1; console.log(`   \x1b[31m✗\x1b[0m ${m}`); };
const info = (m) => console.log(`   ${m}`);

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });

async function getJson(pathname, tries = 4) {
  let last;
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await page.request.get(`${BASE}${pathname}`);
      if (res.ok()) return res.json();
      last = new Error(`HTTP ${res.status()}`);
    } catch (err) { last = err; }
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw last;
}

async function waitIdle(polls = 90) {
  for (let i = 0; i < polls; i += 1) {
    const s = await getJson('/api/games/refresh-all/status').catch(() => ({ running: false }));
    if (!s.running) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// 挑一个官方海报最多的游戏，这样「取消一张/换封面」的影响面最大
const games = await getJson('/api/games?pageSize=100');
let target = null;
let best = 0;
for (const g of games) {
  const posters = await getJson(`/api/games/${g.id}/posters`);
  const scraped = posters.filter((p) => p.source === 'scraped');
  if (scraped.length > best) { best = scraped.length; target = { game: g, posters }; }
}
info(`测试对象：${target.game.name}（官方海报 ${best} 张）`);

const gid = target.game.id;
const posters = target.posters;
if (posters.length < 4) {
  bad(`海报太少（${posters.length}），无法做取消/换封面测试`);
} else {
  const turnedOff = posters[1];
  const newCover = posters[2];

  // 用户操作：第 2 张移出轮播，第 3 张设为封面
  const off = await page.request.patch(`${BASE}/api/games/${gid}/posters/${turnedOff.id}`, {
    data: { inSlideshow: false },
  });
  truthy(off.status() === 200) ? ok('「取消轮播」操作成功') : bad(`取消轮播 HTTP ${off.status()}`);
  const sel = await page.request.post(`${BASE}/api/games/${gid}/posters/select`, {
    data: { posterId: newCover.id },
  });
  truthy(sel.status() === 200 || sel.status() === 201) ? ok('「设为封面」操作成功') : bad(`设封面 HTTP ${sel.status()}`);

  const afterUser = await getJson(`/api/games/${gid}/posters`);
  const offRow = afterUser.find((p) => p.id === turnedOff.id);
  const coverRow = afterUser.find((p) => p.id === newCover.id);
  const slidesAfterUser = afterUser.filter((p) => p.inSlideshow).length;
  info(`用户操作后：轮播 ${slidesAfterUser} 张，取消项 inSlideshow=${offRow?.inSlideshow}，封面项 isSelected=${coverRow?.isSelected}`);

  // 触发完整重新刮削
  const refresh = await page.request.post(`${BASE}/api/games/${gid}/refresh`);
  info(`重新刮削：HTTP ${refresh.status()}`);
  await waitIdle();

  const after = await getJson(`/api/games/${gid}/posters`);
  const offAgain = after.find((p) => p.id === turnedOff.id);
  const coverAgain = after.find((p) => p.id === newCover.id);
  const slidesAfter = after.filter((p) => p.inSlideshow).length;

  info(`重新刮削后：海报 ${after.length} 张，轮播 ${slidesAfter} 张，取消项 inSlideshow=${offAgain?.inSlideshow}，封面项 isSelected=${coverAgain?.isSelected}`);

  truthy(!!offAgain) ? ok('被取消的排海仍在图库中（没有被删除）') : bad('被取消的海报消失了');
  truthy(offAgain?.inSlideshow === false)
    ? ok('用户关闭的轮播项重新刮削后仍保持关闭（未被自动加回）')
    : bad('用户关闭的轮播项被自动重新打开了');
  truthy(coverAgain?.isSelected === true)
    ? ok('用户选择的封面重新刮削后仍是封面')
    : bad('用户选择的封面被重新刮削覆盖了');
  truthy(slidesAfter > 1)
    ? ok(`重新刮削后仍是多张轮播（${slidesAfter} 张）`)
    : bad(`重新刮削后退化成单张（${slidesAfter} 张）`);

  // 页面侧确认：再次打开详情页，画面里确实是多张，且**被取消的那张不在其中**
  await page.goto(`${BASE}/game/${gid}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="hero-counter"]', { timeout: 30000 }).catch(() => {});
  // 等图片解码稳定：计数分母是「当前真正能显示的张数」，坏图被组件剔除会改变它，
  // 所以必须等稳定后再读，否则量到的是加载中的中间态。
  let total = 0;
  let prev = '';
  for (let i = 0; i < 40; i += 1) {
    const sample = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('[data-testid="hero-carousel"] img'));
      const c = document.querySelector('[data-testid="hero-counter"]');
      const counter = ((c && c.textContent) || '').trim();
      return {
        counter,
        decoded: imgs.filter((x) => x.naturalWidth > 0).length,
        key: `${counter}|${imgs.filter((x) => x.naturalWidth > 0).length}`,
      };
    });
    if (sample.key === prev && sample.decoded > 0) { total = Number(sample.counter.split('/')[1] || 0); break; }
    prev = sample.key;
    await page.waitForTimeout(700);
  }
  const counterText = await page.locator('[data-testid="hero-counter"]').innerText().catch(() => '0/0');
  info(`详情页轮播计数：${counterText.trim()}（后端配置 ${slidesAfter} 张）`);

  // 画面里的实际图片集合必须与配置一致：不能出现用户已取消的那张
  const shownUrls = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('[data-testid="hero-carousel"] img'));
    return imgs.map((i) => decodeURIComponent(i.getAttribute('src') || ''));
  });
  const offInPage = shownUrls.some((u) => u.includes(turnedOff.url.split('/').pop()));
  truthy(!offInPage)
    ? ok('页面上确实没有出现用户已取消轮播的那张海报')
    : bad('页面仍在展示用户已取消轮播的海报（取消按钮无效）');
  truthy(total > 1)
    ? ok(`页面仍可左右切换多张海报（${total} 张）`)
    : bad(`页面退化成单张（${total}）`);
}

await browser.close();
console.log(`\n   \x1b[1m结果：${pass} 项通过 / ${fail} 项失败\x1b[0m`);
process.exit(fail ? 1 : 0);