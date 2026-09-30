/**
 * 媒体评价「抓取编排」验证 —— provider 层，不联网。
 * ============================================================================
 *
 * 跑法：node backend/scripts/verify/metacritic-crawl-test.mjs
 *
 * ⚠️ 全程零网络请求：把 provider 的 `fetchHtml` 换成从 fixture 读文件的桩，
 *    所以既不需要代理，也不会碰真实站点。
 *
 * 为什么需要这个文件：已有的 `metacritic-reviews-test.mjs` 只测**纯函数**
 * （解析器、分页链接发现、合并去重），而「65 家媒体只抓到 1 条」这个缺陷两次
 * 出在**编排**上，不在解析上：
 *
 *   第 1 次：抓取根本不会跟随分页，读完游戏页就结束了。
 *   第 2 次：修好分页跟随之后，它仍然**只在着陆页自己带分页器时**才走 —— 而真实
 *           站点的着陆页没有分页器（分页器在专属列表页上），于是又停在首页那几条。
 *
 * 第 2 次的缺陷之所以能躲过所有测试，是因为离线 fixture 是**照着能通过的形态**
 * 写的：`paginated-p1.html` 自己带了 `rel="next"`。用「本来就好的那条路径」去测，
 * 自然测不出坏掉的那条。本文件用 `landing-no-pager.html`（着陆页无分页器）补上
 * 这个缺口。
 *
 * 覆盖：
 *   1. 着陆页无分页器 → 仍然抓完整个列表（这是回归点，也是本文件存在的理由）
 *   2. 着陆页有分页器 → 行为不变（不能为了修 1 而破坏这条）
 *   3. 只有一页评价 → 不白白多发请求
 *   4. 列表页抓取失败 → 保留着陆页已有的那几条，而不是清空
 *   5. 请求路径正确（走的确实是 /critic-reviews/ 列表页）
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const FIXTURES = path.join(HERE, 'fixtures', 'metacritic');
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`   \x1b[32m✓\x1b[0m ${m}`); pass += 1; };
const bad = (m) => { console.log(`   \x1b[31m✗\x1b[0m ${m}`); fail += 1; };
const step = (m) => console.log(`\n\x1b[1m== ${m}\x1b[0m`);

const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// 载入**已编译**的 provider。
//
// 不用 ts-node：跑的是 `nest build` 的产物，这样测的就是真正会被部署的那份代码
// （也顺带保证产物是最新的 —— 忘了构建会立刻在这里暴露）。
//
// `MC_ORIGIN` 在模块加载时读 `METACRITIC_BASE_URL`，所以必须在 require 之前设置。
// ─────────────────────────────────────────────────────────────────────────────
process.env.METACRITIC_BASE_URL = 'https://mc.test';

const DIST = path.join(ROOT, 'backend', 'dist', 'metadata', 'providers', 'metacritic.provider.js');
if (!fs.existsSync(DIST)) {
  console.error(`找不到编译产物：${DIST}\n请先在 backend/ 下跑一次 npm run build。`);
  process.exit(1);
}
const { MetacriticProvider } = require(DIST);

/**
 * 造一个 provider 实例，并把 `fetchHtml` 换成读 fixture 的桩。
 *
 * `fetchHtml` 是 private，但编译成 JS 之后只是个普通方法，可以直接覆盖 —— 这样
 * 就能在**零网络**的前提下驱动完整的编排逻辑（跟随分页、去重、失败降级）。
 * 构造函数只用到 `cacheTtlRatingSeconds`，其余依赖在编排路径上不会被调用。
 *
 * 路由按**路径语义**匹配（照抄 `metacritic-stub.mjs` 的做法），而不是拿完整 URL
 * 去 `includes` 某个子串：后者第一版就写错过 —— `url.includes('/critic-reviews/')`
 * 会把带 `?page=2` 的后续页也一并吞掉，于是「翻了页但拿到的还是第一页」，
 * 表现为条数上不去。按 page 参数取对应 fixture 不会有这个歧义。
 */
function makeProvider(opts = {}) {
  const requested = [];
  const settings = { getApiKeys: () => ({ rawgProxy: '' }) };
  const config = { get: (key) => (key === 'cacheTtlRatingSeconds' ? 604800 : undefined) };
  const provider = new MetacriticProvider(config, {}, {}, settings);

  provider.fetchHtml = async (url) => {
    requested.push(url);
    const pathname = new URL(url).pathname;

    // 列表页：/game/<slug>/critic-reviews/?page=N → paginated-pN.html
    if (/^\/game\/[^/]+\/critic-reviews\/?$/.test(pathname)) {
      if (opts.failListing) return null;
      // 指定固定文件时，任何一页都返回它 —— 用来模拟「列表页也只有一个页」。
      if (opts.listingFile) return fixture(opts.listingFile);
      const page = Number(new URL(url).searchParams.get('page') || '1');
      const file = `paginated-p${page}.html`;
      return fs.existsSync(path.join(FIXTURES, file)) ? fixture(file) : fixture('empty.html');
    }

    // 游戏着陆页：由 opts.landing 指定用哪份 fixture。
    if (/^\/game\/[^/]+\/?$/.test(pathname)) {
      return fixture(opts.landing ?? 'landing-no-pager.html');
    }

    return null;
  };
  provider.requested = requested;
  return provider;
}

/** 直接驱动编排入口（private 方法，运行时可直接调用）。 */
const crawl = (provider, html, externalId = 'astro-bot') =>
  provider.fetchAllMediaReviews(html, externalId);

// ─────────────────────────────────────────────────────────────────────────────
step('1. 着陆页无分页器 → 仍抓完整个列表（回归点）');

{
  const provider = makeProvider();
  const reviews = await crawl(provider, fixture('landing-no-pager.html'));

  console.log(`   拿到 ${reviews.length} 条；请求了 ${provider.requested.length} 个 URL`);
  for (const u of provider.requested) console.log(`     · ${u.replace('https://mc.test', '')}`);

  // 着陆页只给 2 条（IGN / GameSpot），其余在列表页 page=2..6。抓到明显多于 2 条，
  // 就说明分页真的被走通了 —— 这正是缺陷的判据。
  if (reviews.length > 2) ok(`抓到的条数多于着陆页（${reviews.length} > 2）—— 分页确实被走通了`);
  else bad(`只抓到 ${reviews.length} 条，等于着陆页数量 —— 缺陷仍在`);

  if (provider.requested.some((u) => u.includes('/critic-reviews/'))) {
    ok('请求了 /critic-reviews/ 列表页');
  } else {
    bad('没有请求列表页 —— 说明仍是「着陆页没分页器就放弃」的老逻辑');
  }

  const laterPages = provider.requested.filter((u) => /[?&]page=[2-9]/.test(u));
  if (laterPages.length >= 4) ok(`翻到了 ${laterPages.length} 个后续页`);
  else bad(`只翻到 ${laterPages.length} 个后续页，期望 >= 4`);

  const names = reviews.map((r) => r.outlet.toLowerCase());
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length === 0) ok(`媒体名无重复（${names.length} 个唯一媒体）`);
  else bad(`出现重复媒体：${[...new Set(dupes)].join(', ')}`);

  // 三要素齐全：不能只有第一条有分数/评语（旧缺陷的另一个表现）。
  const complete = reviews.filter((r) => r.outlet && r.score != null && r.text);
  if (complete.length >= reviews.length - 1) {
    ok(`${complete.length}/${reviews.length} 条同时具备媒体名 + 打分 + 评语`);
  } else {
    bad(`仅 ${complete.length}/${reviews.length} 条三要素齐全`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
step('2. 着陆页自带分页器 → 行为不变');

{
  const provider = makeProvider({ landing: 'paginated-p1.html' });
  const reviews = await crawl(provider, fixture('paginated-p1.html'));

  console.log(`   拿到 ${reviews.length} 条；请求了 ${provider.requested.length} 个 URL`);
  if (reviews.length > 2) ok(`抓到的条数多于着陆页（${reviews.length}）`);
  else bad(`只抓到 ${reviews.length} 条`);

  // 注意：这里**不能**断言「没有请求 /critic-reviews/」—— 分页器指向的就是那些
  // URL，抓它们正是「跟随分页」本身。兜底探测的独有标志是**不带 page 参数**的
  // 列表页请求（那一下是在问「这里到底有没有分页器」）。
  const probes = provider.requested.filter(
    (u) => u.includes('/critic-reviews/') && !/[?&]page=/.test(u),
  );
  if (probes.length === 0) ok('没有触发兜底探测（着陆页分页器已够用，未浪费请求）');
  else bad(`触发了 ${probes.length} 次兜底探测 —— 着陆页有分页器时不该走到那个分支`);

  // 分页器指向 page=2..6，所以应恰好请求这 5 个 URL。
  const got = [2, 3, 4, 5, 6].filter((n) => provider.requested.some((u) => u.includes(`page=${n}`)));
  if (got.length === 5) ok('按分页器请求了 page=2..6 共 5 页');
  else bad(`只请求了 page=${got.join(',')}，期望 2..6`);
}

// ─────────────────────────────────────────────────────────────────────────────
step('3. 只有一页评价 → 不白白多发请求');

{
  // 着陆页无分页器，列表页也没有分页器 → 应该探测一次后停下。
  const provider = makeProvider({ listingFile: 'landing-no-pager.html' });
  const reviews = await crawl(provider, fixture('landing-no-pager.html'));

  console.log(`   拿到 ${reviews.length} 条；请求了 ${provider.requested.length} 个 URL`);
  for (const u of provider.requested) console.log(`     · ${u.replace('https://mc.test', '')}`);

  if (reviews.length === 2) ok('保留着陆页的 2 条');
  else bad(`期望 2 条，实际 ${reviews.length}`);

  if (provider.requested.length <= 2) {
    ok(`请求数合理（${provider.requested.length} ≤ 2），没有循环`);
  } else {
    bad(`请求了 ${provider.requested.length} 次 —— 可能陷入循环`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
step('4. 列表页抓取失败 → 保留着陆页已有的评价');

{
  const provider = makeProvider({ failListing: true });
  const reviews = await crawl(provider, fixture('landing-no-pager.html'));

  console.log(`   拿到 ${reviews.length} 条`);
  if (reviews.length === 2) {
    ok('列表页失败时保留着陆页的 2 条（没有清空、没有抛错）');
  } else {
    bad(`期望保留 2 条，实际 ${reviews.length}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
step('5. 请求路径正确 / 旧式前缀');

{
  const provider = makeProvider();
  await crawl(provider, fixture('landing-no-pager.html'), 'astro-bot');
  const strayPaths = provider.requested.filter((u) => !u.includes('/game/astro-bot/'));
  if (strayPaths.length === 0) ok('所有请求都指向该游戏的路径');
  else bad(`出现意料之外的路径：${strayPaths.join(', ')}`);

  const legacy = makeProvider();
  await crawl(legacy, fixture('landing-no-pager.html'), 'pc/astro-bot');
  const legacyBad = legacy.requested.filter((u) => u.includes('/game/pc/'));
  if (legacyBad.length === 0) {
    ok('旧式 "pc/" 前缀被剥掉，没有拼出 /game/pc/astro-bot/');
  } else {
    bad(`旧式前缀没剥干净：${legacyBad.join(', ')}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(
  `\n\x1b[1m结果：${pass} 项通过 / ${fail} 项失败\x1b[0m\n`,
);
process.exit(fail === 0 ? 0 : 1);