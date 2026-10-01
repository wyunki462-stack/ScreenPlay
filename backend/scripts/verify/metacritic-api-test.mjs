/**
 * 媒体评价「官方 JSON 接口」验证 —— provider 层，**零网络**。
 * ============================================================================
 *
 * 跑法：node backend/scripts/verify/metacritic-api-test.mjs
 *      （先在 backend/ 下 `npm run build` —— 测的是编译产物，不是源码）
 *
 * ⚠️ 全程不发真实请求：`fetchJson` 桩从 fixture 读文件，`fetchHtml` 桩同样。
 *
 * 为什么需要这个文件：前两轮修的都是**分页**，而真实站点根本没有可翻的分页 ——
 * 列表页是 Nuxt 渲染的，HTML 里只有 10 张卡，其余靠 XHR 取回，`?page=2` /
 * `?offset=20` 拿回的还是同样那 10 张（`007-first-light` 页面自己写着 99 条）。
 * 第三轮因此改成直接问站点自己的接口：
 *
 *   GET backend.metacritic.com/reviews/metacritic/critic/games/<slug>/web?offset=N…
 *
 * `api-critic-007-p1.json` / `-p2.json` 就是把线上响应**原样**存下来的证据，
 * 它们锁住的是「真实响应长什么样、能不能被映射成评价行」；合成页则用来测
 * 编排（跟随 next、抓满即停、失败回落）。
 *
 * 覆盖：
 *   1. 真实响应 → 10 条评价，字段齐全（媒体名/打分/评语/原文链接/日期/平台归一）
 *   2. 跟随响应里的 links.next（原样使用，不自己拼 offset）
 *   3. totalResults 抓满即停；站点继续给 next 也不多发请求
 *   4. 接口不可用 / 返回垃圾 → 回落 HTML 抓取（不抛错、不清空）
 *   5. 纯函数映射规则（媒体名必填、打分裁剪、平台归一、评语截断）
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
const fixtureJson = (name) => JSON.parse(fixture(name));

// ─────────────────────────────────────────────────────────────────────────────
// 载入**已编译**的产物。
//
// 两个 origin 都在模块加载时读环境变量，所以必须在 require 之前设置。接口 origin
// 指向假域名，任何「桩没拦住、真的发出去」的请求都会立刻 DNS 失败（而不是打到
// 线上），这样才能确信测试是零网络的。
// ─────────────────────────────────────────────────────────────────────────────
process.env.METACRITIC_BASE_URL = 'https://mc.test';
process.env.METACRITIC_API_BASE_URL = 'https://mc-api.test';

const DIST_DIR = path.join(ROOT, 'backend', 'dist', 'metadata', 'providers');
const DIST = path.join(DIST_DIR, 'metacritic.provider.js');
if (!fs.existsSync(DIST)) {
  console.error(`找不到编译产物：${DIST}\n请先在 backend/ 下跑一次 npm run build。`);
  process.exit(1);
}
const { MetacriticProvider } = require(DIST);
const api = require(path.join(DIST_DIR, 'metacritic-reviews-api.js'));

const P1 = fixtureJson('api-critic-007-p1.json');
const P2 = fixtureJson('api-critic-007-p2.json');

/** 合成多页响应，用来测编排（真实 fixture 只有两页，且都带 next）。 */
function synthPages(total, { perPage = 10, alwaysNext = false } = {}) {
  const pages = [];
  for (let offset = 0; offset < total; offset += perPage) {
    const count = Math.min(perPage, total - offset);
    const items = Array.from({ length: count }, (_, i) => {
      const n = offset + i + 1;
      const platform = n % 2 ? 'PlayStation 5' : 'PC';
      return {
        publicationName: `Outlet ${n}`,
        score: 50 + (n % 50),
        quote: `Synthetic quote ${n}`,
        url: `https://outlet${n}.example/review-${n}`,
        date: '2026-05-26',
        author: '',
        platform,
        reviewedProduct: { platform: { name: platform } },
      };
    });
    const more = offset + perPage < total;
    const links =
      more || alwaysNext
        ? {
            next: {
              href:
                `https://mc-api.test/reviews/metacritic/critic/games/synth/web` +
                `?offset=${offset + perPage}&limit=10&componentName=critic-reviews`,
            },
          }
        : {};
    pages.push({ data: { totalResults: total, items }, links, meta: { componentName: 'critic-reviews' } });
  }
  return pages;
}

/**
 * 造 provider 实例，把两个网络出口都换成桩。
 *
 * `fetchJson` / `fetchHtml` 是 private，但编译后就是普通方法，可以直接覆盖 ——
 * 于是完整的编排逻辑（跟随 next、抓满即停、失败回落、去重）都能在零网络下驱动。
 * `opts.api(url)` 返回 `undefined` 表示「这一页拿不到」（模拟网络失败/接口关闭）。
 */
function makeProvider(opts = {}) {
  const requestedApi = [];
  const requestedHtml = [];
  const logs = [];

  const settings = { getApiKeys: () => ({ rawgProxy: '' }) };
  const config = { get: (key) => (key === 'cacheTtlRatingSeconds' ? 604800 : undefined) };
  const provider = new MetacriticProvider(config, {}, {}, settings);

  // 断言日志用：真 Logger 会把 warn 打到 stdout，盖住测试输出。
  provider.logger = {
    log: (m) => logs.push(['log', String(m)]),
    warn: (m) => logs.push(['warn', String(m)]),
    debug: () => {},
    verbose: () => {},
    error: () => {},
  };

  provider.fetchJson = async (url) => {
    requestedApi.push(url);
    if (!opts.api) return null;
    const payload = opts.api(url);
    return payload === undefined ? null : payload;
  };

  provider.fetchHtml = async (url) => {
    requestedHtml.push(url);
    const pathname = new URL(url).pathname;
    if (/^\/game\/[^/]+\/critic-reviews\/?$/.test(pathname)) {
      const page = Number(new URL(url).searchParams.get('page') || '1');
      const file = `paginated-p${page}.html`;
      return fs.existsSync(path.join(FIXTURES, file)) ? fixture(file) : fixture('empty.html');
    }
    if (/^\/game\/[^/]+\/?$/.test(pathname)) return fixture('landing-no-pager.html');
    return null;
  };

  provider.requestedApi = requestedApi;
  provider.requestedHtml = requestedHtml;
  provider.logs = logs;
  return provider;
}

const crawl = (provider, html, externalId = '007-first-light') =>
  provider.fetchAllMediaReviews(html, externalId);

// ─────────────────────────────────────────────────────────────────────────────
step('1. 真实响应 → 完整映射（frontend 需要的每个字段）');

{
  const provider = makeProvider({
    // 只给第一页：第二页「拿不到」，所以走完一页就停。
    api: (url) => (url.includes('offset=0') ? P1 : undefined),
  });

  const reviews = await crawl(provider, fixture('landing-no-pager.html'));
  console.log(`   真实 p1 映射出 ${reviews.length} 条`);
  console.log(`   第一条：${reviews[0]?.outlet} / ${reviews[0]?.score} / ${reviews[0]?.platform} / ${reviews[0]?.publishedAt}`);
  console.log(`   原文链接：${reviews[0]?.url}`);

  if (reviews.length === 10) ok('真实第一页 10 条全部映射出来（HTML 落地页只有 1 条）');
  else bad(`期望 10 条，实际 ${reviews.length}`);

  const first = reviews[0];
  if (first?.outlet === 'Cultura Geek') ok('媒体名取自 publicationName，且不含分数（不是「100 Cultura Geek」）');
  else bad(`媒体名异常：${JSON.stringify(first?.outlet)}`);

  const dirty = reviews.filter((r) => !r.outlet || /^\d/.test(r.outlet));
  if (dirty.length === 0) ok('10 条媒体名都干净（无空、无数字前缀）');
  else bad(`有 ${dirty.length} 条媒体名异常：${dirty.map((r) => r.outlet).join(' / ')}`);

  const scored = reviews.filter((r) => typeof r.score === 'number');
  if (scored.length === reviews.length) ok(`10 条都带分数（${reviews.map((r) => r.score).join(',')}）`);
  else bad(`只有 ${scored.length}/${reviews.length} 条有分数`);

  const quoted = reviews.filter((r) => r.text && r.text.length > 10);
  if (quoted.length === reviews.length) ok('10 条都有评语原文');
  else bad(`只有 ${quoted.length}/${reviews.length} 条有评语`);

  const linked = reviews.filter((r) => /^https:\/\//.test(r.url ?? '') && !/metacritic\.com/.test(r.url));
  if (linked.length === reviews.length) ok('10 条原文链接都指向站外媒体（「查看原文」可用）');
  else bad(`只有 ${linked.length}/${reviews.length} 条原文链接正确：${reviews.find((r) => !/^https:/.test(r.url ?? ''))?.url}`);

  const dated = reviews.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.publishedAt ?? ''));
  if (dated.length === reviews.length) ok('10 条日期都解析成 YYYY-MM-DD');
  else bad(`只有 ${dated.length}/${reviews.length} 条日期可解析（第一条 ${reviews[0]?.publishedAt}）`);

  const folded = reviews.every((r) => r.platform === 'PS5');
  if (folded) ok('平台归一：真实响应里的 "PlayStation 5" → "PS5"（面板筛选用的是后者）');
  else bad(`平台归一异常：${[...new Set(reviews.map((r) => r.platform))].join(' / ')}`);

  if (reviews.some((r) => r.outlet === 'Washington Post')) {
    ok('包含面板里原本只显示到的那条（Washington Post）');
  } else {
    bad('没有 Washington Post —— 映射漏了条目');
  }

  // 站点自报 99 条，而这次只给到第一页：必须留下可诊断的 warn，而不是静默停在 10。
  const warn = provider.logs.find(([lvl, m]) => lvl === 'warn' && m.includes('99'));
  if (warn) ok(`拿到 10 条但站点自报 99 条 → 明确 warn：${warn[1]}`);
  else bad('缺少「应有 99 条、仅取到 10 条」的 warn —— 现场将无法判断是抓少了还是本来就这么少');
}

// ─────────────────────────────────────────────────────────────────────────────
step('2. 跟随响应里的 links.next（原样使用，不自己拼 offset）');

{
  const nextHref = P1.links.next.href;
  const provider = makeProvider({
    api: (url) => {
      if (/offset=10(&|$)/.test(url) || url === nextHref) return P2;
      if (/offset=0(&|$)/.test(url)) return P1;
      return undefined;
    },
  });

  const reviews = await crawl(provider, fixture('landing-no-pager.html'));
  console.log(`   两页合并 ${reviews.length} 条；请求 ${provider.requestedApi.length} 次`);
  for (const u of provider.requestedApi) console.log(`     · ${u.slice(0, 96)}…`);

  if (reviews.length === 20) ok('20 条（两页各 10 条）都进来了');
  else bad(`期望 20 条，实际 ${reviews.length}`);

  if (provider.requestedApi[1] === nextHref) {
    ok('第二次请求用的就是响应里的 links.next（原样，没有另拼 URL）');
  } else {
    bad(`没有跟随 links.next：第二次请求的是 ${provider.requestedApi[1]}`);
  }

  const outlets = reviews.map((r) => r.outlet.toLowerCase());
  const dupes = outlets.filter((n, i) => outlets.indexOf(n) !== i);
  if (dupes.length === 0) ok('两页之间无重复媒体（去重有效）');
  else bad(`跨页重复：${[...new Set(dupes)].join(', ')}`);

  if (provider.requestedHtml.length === 0) {
    ok('接口可用时完全不回落到 HTML 抓取（没有多打一次列表页）');
  } else {
    bad(`接口可用却仍请求了 HTML：${provider.requestedHtml.length} 次`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
step('3. totalResults 抓满即停（站点继续给 next 也不多发请求）');

{
  const pages = synthPages(23, { alwaysNext: true }); // 最后一页仍带 next：故意刁难
  const provider = makeProvider({ api: (url) => pages[Number(new URL(url).searchParams.get('offset') || 0) / 10] });

  const reviews = await crawl(provider, fixture('landing-no-pager.html'), 'synth');

  if (reviews.length === 23) ok(`抓满 23 条（totalResults 的数目）`);
  else bad(`期望 23 条，实际 ${reviews.length}`);

  if (provider.requestedApi.length === 3) {
    ok('只请求 3 次（offset=0/10/20），抓满后没有再跟着 next 走');
  } else {
    bad(`请求了 ${provider.requestedApi.length} 次，期望 3 次 —— 抓满判断没生效`);
  }

  const warn = provider.logs.find(([lvl]) => lvl === 'warn');
  if (!warn) ok('抓满时没有多余的 warn');
  else bad(`抓满了却 warn：${warn[1]}`);
}

// ─────────────────────────────────────────────────────────────────────────────
step('4. 接口不可用 / 返回垃圾 → 回落 HTML 抓取（不能退化的底线）');

{
  // 4a. 接口整体失败（网络层返回 null）
  const down = makeProvider({ api: null });
  const a = await crawl(down, fixture('landing-no-pager.html'));
  console.log(`   接口失败时回落到 HTML：拿到 ${a.length} 条，HTML 请求 ${down.requestedHtml.length} 次`);
  if (a.length > 2) ok(`接口不通时 HTML 兜底仍抓到 ${a.length} 条（不是 0，也没抛错）`);
  else bad(`接口失败后只拿到 ${a.length} 条 —— 兜底失效`);

  // 4b. 接口通了但返回空/垃圾（结构变了、组件名改了）
  const garbage = makeProvider({
    api: (url) => (url.includes('offset=0') ? { data: { totalResults: 0, items: [] }, links: {} } : undefined),
  });
  const b = await crawl(garbage, fixture('landing-no-pager.html'));
  if (b.length > 2) ok(`接口返回空列表时同样回落 HTML（${b.length} 条）`);
  else bad(`接口返回空时只拿到 ${b.length} 条`);

  // 4c. 接口返回的根本不是预期结构
  const broken = makeProvider({ api: () => ({ html: '<html>blocked</html>' }) });
  let threw = false;
  let c = [];
  try {
    c = await crawl(broken, fixture('landing-no-pager.html'));
  } catch (err) {
    threw = true;
    console.log(`   抛错：${err.message}`);
  }
  if (!threw && c.length > 2) ok(`接口返回意外结构时不抛错、回落 HTML（${c.length} 条）`);
  else bad(threw ? '接口返回意外结构时抛错了' : `只拿到 ${c.length} 条`);
}

// ─────────────────────────────────────────────────────────────────────────────
step('5. 纯函数映射规则');

{
  const m = api.mapApiReview({
    publicationName: '  Cultura Geek ',
    score: '100',
    quote: '  Quote  text\n\nwith newlines  ',
    url: 'https://example.com/review',
    date: '2026-05-26',
    platform: 'PlayStation 5',
    author: 'Jane Doe',
  });

  if (m?.outlet === 'Cultura Geek') ok('媒体名去除首尾空白');
  else bad(`媒体名未清理：${JSON.stringify(m?.outlet)}`);
  if (m?.score === 100) ok('字符串分数 "100" → 数字 100');
  else bad(`分数未转换：${JSON.stringify(m?.score)}`);
  if (m?.text === 'Quote text with newlines') ok('评语折叠换行');
  else bad(`评语未折叠：${JSON.stringify(m?.text)}`);
  if (m?.platform === 'PS5') ok('平台 "PlayStation 5" → "PS5"');
  else bad(`平台未归一：${JSON.stringify(m?.platform)}`);
  if (m?.publishedAt === '2026-05-26') ok('日期 ISO 直通');
  else bad(`日期异常：${JSON.stringify(m?.publishedAt)}`);
  if (m?.verdict === null) ok('接口不提供判定词 → 不伪造 verdict');
  else bad(`verdict 不该有值：${JSON.stringify(m?.verdict)}`);

  if (api.mapApiReview({ score: 90, quote: 'x' }) === null) ok('缺媒体名的条目被丢弃（面板无法渲染）');
  else bad('缺媒体名的条目没有被丢弃');

  // `clampScore` 是两条路径共用的「什么算合理分数」定义：超出 0–100 视为
  // 序列化噪声（旧 Next.js 页面会把数组下标 3056 当分数吐出来），而 0 按约定
  // 视为「没有分数」。这里断言的是**共用约定**，不是接口特有的行为。
  const clamped = api.mapApiReview({ publicationName: 'X', score: 500 });
  if (clamped?.score === null) ok('超出 0–100 的分数被丢弃（与 HTML 路径同一套 clampScore）');
  else bad(`超范围分数未被丢弃：${JSON.stringify(clamped?.score)}`);

  const para = api.mapApiReview({ publicationName: 'X', score: 0, quote: 'a'.repeat(5000) });
  if (para?.text.length === 1200) ok('超长评语截断到 1200（与 HTML 路径一致）');
  else bad(`评语长度 ${para?.text.length}，期望 1200`);
  if (para?.score === null) ok('0 分按共用约定视为「无分数」，与 HTML 路径一致');
  else bad(`0 分处理与 HTML 路径不一致：${JSON.stringify(para?.score)}`);

  // reviewedProduct.platform 作为 platform 的兜底来源。
  const nested = api.mapApiReview({
    publicationName: 'X',
    score: 80,
    reviewedProduct: { platform: { name: 'PlayStation 5' } },
  });
  if (nested?.platform === 'PS5') ok('platform 缺失时回落到 reviewedProduct.platform.name');
  else bad(`嵌套平台未取到：${JSON.stringify(nested?.platform)}`);

  const page = api.parseCriticReviewsApi(P1);
  if (page.total === 99) ok('parseCriticReviewsApi 读出 totalResults = 99');
  else bad(`totalResults 读出为 ${page.total}`);
  if (page.next === P1.links.next.href) ok('parseCriticReviewsApi 原样给出 links.next');
  else bad('links.next 未读出');

  if (api.parseCriticReviewsApi(null).reviews.length === 0) ok('空载荷 → 空数组（不抛错）');
  else bad('空载荷没有安全返回');

  if (api.criticReviewsApiUrl('a/b c').includes('a%2Fb%20c')) ok('slug 做 URL 编码（不会被拼出歧义路径）');
  else bad(`slug 未编码：${api.criticReviewsApiUrl('a/b c')}`);
}

// ─────────────────────────────────────────────────────────────────────────────
step('隔离：HTML 基址被改写时，接口地址必须跟着走（不许漏到真实站点）');

// 这条锁的是本轮真的踩到的坑：离线套件只设 `METACRITIC_BASE_URL` 指向本地桩服，
// 而接口 origin 原先固定在 backend.metacritic.com —— 于是 media-reviews-e2e 一边
// 声称「只访问本地桩服」，一边真的从线上取回了 99 条评价，用例失败得莫名其妙
// （期望 3 条、实际 10 条）。用**子进程**重新加载模块，才能读到「只设 HTML 基址」
// 时的取值 —— 模块是在 require 时读环境变量的，当前进程里已经改不回去了。
{
  const API_DIST = path.join(DIST_DIR, 'metacritic-reviews-api.js');
  const probe = (env) =>
    execFileSync(
      process.execPath,
      ['-e', `console.log(require(${JSON.stringify(API_DIST)}).MC_API_ORIGIN)`],
      { encoding: 'utf8', env: { ...process.env, ...env } },
    ).trim();

  const followed = probe({
    METACRITIC_BASE_URL: 'http://127.0.0.1:4600',
    METACRITIC_API_BASE_URL: '',
  });
  if (followed === 'http://127.0.0.1:4600') ok('只设 HTML 基址时接口跟着它走（桩服拦得住）');
  else bad(`接口没有跟随 HTML 基址：${followed} —— 这会打到真实站点`);

  const explicit = probe({
    METACRITIC_BASE_URL: 'http://127.0.0.1:4600',
    METACRITIC_API_BASE_URL: 'http://127.0.0.1:4700',
  });
  if (explicit === 'http://127.0.0.1:4700') ok('显式指定接口基址时优先用它');
  else bad(`显式接口基址没有被优先使用：${explicit}`);

  const dflt = probe({ METACRITIC_BASE_URL: '', METACRITIC_API_BASE_URL: '' });
  if (dflt === 'https://backend.metacritic.com') ok('两个都不设时用官方接口地址');
  else bad(`默认接口地址不对：${dflt}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n\x1b[1m结果：${pass} 项通过 / ${fail} 项失败\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
