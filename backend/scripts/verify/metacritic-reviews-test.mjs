/**
 * 媒体评价解析器离线测试。
 *
 * **完全离线**：只读本机的 HTML 夹具，不访问 metacritic.com，不发任何网络请求。
 * 这样做的原因有两个：
 *   1. 解析器是本功能里最脆弱的一环（站点改版就会失效），必须能反复跑；
 *   2. 真实站点有反爬/风控，迭代解析规则时不该反复去敲门。
 *
 * 夹具 `fixtures/metacritic/*.html` 是**按已知页面结构手写的合成样本**，不是抓取
 * 下来的真实页面副本 —— 目的是覆盖「结构 A / 结构 B / 空 / 403 页」几种形态，
 * 并让解析退化行为（缺字段、脏数据）可被断言。
 *
 * 用法：node backend/scripts/verify/metacritic-reviews-test.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'metacritic');

let pass = 0;
let fail = 0;
const ok = (m) => { pass += 1; console.log(`   \x1b[32m✓\x1b[0m ${m}`); };
const bad = (m) => { fail += 1; console.log(`   \x1b[31m✗\x1b[0m ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

// 编译后的解析器（backend/dist），确保测的是真正跑在服务里的那份代码
const require = createRequire(import.meta.url);
const distPath = join(HERE, '..', '..', 'dist', 'metadata', 'providers', 'metacritic-reviews.js');
let mod;
try {
  mod = require(distPath);
} catch (err) {
  console.error(`\n无法加载 ${distPath}\n请先构建后端：npm run build（在 backend/ 下）\n${err.message}\n`);
  process.exit(1);
}

const { parseMediaReviews, parseReviewsFromDom, scoreFromText, clampScore, normaliseDate, normalisePlatform, isPlausibleOutlet, dedupeReviews, parseReviewsPagination, nextReviewsPageUrl, pageOfUrlIn } = mod;

function fixture(name) {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

console.log('\n\x1b[1m媒体评价解析器离线测试（不联网）\x1b[0m\n');
const names = readdirSync(FIXTURES).filter((f) => f.endsWith('.html'));
console.log(`   夹具：${names.join(', ')}\n`);

// --- 1. __NEXT_DATA__ 结构 -------------------------------------------------
{
  const reviews = parseMediaReviews(fixture('nextdata.html'));
  check(reviews.length === 3, `__NEXT_DATA__ 结构解析出 3 条（实际 ${reviews.length}）`);
  const ign = reviews.find((r) => r.outlet === 'IGN');
  check(!!ign, '找到媒体「IGN」');
  check(ign?.score === 90, `IGN 打分 90（实际 ${ign?.score}）`);
  check(
    typeof ign?.text === 'string' && ign.text.includes('血源'),
    'IGN 的评语原文被取到',
  );
  const gs = reviews.find((r) => r.outlet === 'GameSpot');
  check(gs?.score === 80, `GameSpot 打分 80（实际 ${gs?.score}）`);
  const poly = reviews.find((r) => /Polygon/.test(r.outlet ?? ''));
  check(poly?.verdict === 'Mixed', `Polygon 的判定词归一化为 Mixed（实际 ${poly?.verdict}）`);
}

// --- 2. DOM 结构（无 JSON 时） ---------------------------------------------
{
  const reviews = parseMediaReviews(fixture('dom.html'));
  check(reviews.length >= 3, `DOM 结构解析出 >=3 条（实际 ${reviews.length}）`);
  const outletNames = reviews.map((r) => r.outlet);
  check(outletNames.includes('IGN'), `DOM 里找到 IGN（实际 ${JSON.stringify(outletNames)}）`);
  check(
    outletNames.every((n) => !/^(All|PC|PS5|Positive|Mixed)$/i.test(n)),
    '过滤器/平台/判定词没有被当成媒体名',
  );
  check(
    reviews.some((r) => r.url && /^https:\/\/www\.metacritic\.com\//.test(r.url)),
    '相对链接被补成绝对链接',
  );
  check(
    reviews.some((r) => r.score === 95),
    '95 分的媒体被打分正确解析',
  );
}

// --- 3. 空页 / 错误页：必须返回空数组而不是抛错或造出假数据 ---------------
{
  const empty = parseMediaReviews(fixture('empty.html'));
  check(Array.isArray(empty) && empty.length === 0, `无评价页面返回空数组（实际 ${empty.length} 条）`);
  const notFound = parseMediaReviews(fixture('notfound.html'));
  check(
    notFound.length === 0,
    `404 页面不产生任何评价（实际 ${notFound.length} 条）—— 否则会把导航文字当成媒体`,
  );
  check(parseMediaReviews('').length === 0, '空字符串输入返回空数组');
  check(parseMediaReviews(null).length === 0, 'null 输入返回空数组（不抛错）');
}

// --- 4. 打分解析 ------------------------------------------------------------
{
  check(scoreFromText('90') === 90, '"90" → 90');
  check(scoreFromText('8.4/10') === 84, '"8.4/10" → 84（按 10 分制换算，而不是读成 8）');
  check(scoreFromText('85 out of 100') === 85, '"85 out of 100" → 85');
  check(scoreFromText('Metascore 93') === 93, '"Metascore 93" → 93');
  check(scoreFromText('—') === null, '"—" → null');
  check(scoreFromText('') === null, '空文本 → null');
  check(scoreFromText('Positive') === null, '判定词 "Positive" → null（不猜数字）');

  // clampScore 必须挡住 Next.js 的 RSC 列索引这类「看起来像分数」的值
  check(clampScore(3056) === null, 'clampScore(3056) → null（挡住 RSC 列索引）');
  check(clampScore(0) === null, 'clampScore(0) → null（0 不是有效 Metascore）');
  check(clampScore(93) === 93, 'clampScore(93) → 93');
  check(clampScore('88') === 88, 'clampScore("88") → 88');
  check(clampScore('abc') === null, 'clampScore("abc") → null');
}

// --- 5. 日期 / 平台归一化 --------------------------------------------------
{
  check(normaliseDate('Nov 12, 2020') === '2020-11-12', '"Nov 12, 2020" → 2020-11-12');
  check(normaliseDate('12 November 2020') === '2020-11-12', '"12 November 2020" → 2020-11-12');
  check(normaliseDate('2020-11-12') === '2020-11-12', 'ISO 日期原样返回');
  check(normaliseDate('yesterday') === null, '无法识别的日期 → null');

  check(normalisePlatform('PlayStation 5') === 'PS5', 'PlayStation 5 → PS5');
  check(normalisePlatform('PC') === 'PC', 'PC → PC');
  check(normalisePlatform('Nintendo Switch') === 'Switch', 'Nintendo Switch → Switch');
  check(normalisePlatform('Dreamcast 2') === 'Dreamcast 2', '不认识的平台保留原文而不是乱猜');
}

// --- 6. 媒体名合理性判断 ---------------------------------------------------
{
  check(isPlausibleOutlet('IGN') === true, 'IGN 是合法媒体名');
  check(isPlausibleOutlet('All') === false, '"All"（筛选器）被拒');
  check(isPlausibleOutlet('PC') === false, '"PC"（平台标签）被拒');
  check(isPlausibleOutlet('90') === false, '"90"（纯数字）被拒');
  check(isPlausibleOutlet('') === false, '空字符串被拒');
  check(isPlausibleOutlet('a'.repeat(80)) === false, '超长字符串被拒');
  check(
    isPlausibleOutlet('No critic reviews have been published yet.') === false,
    '"No critic reviews have been published yet."（空状态句子）被拒',
  );
  check(
    isPlausibleOutlet('No reviews yet') === false,
    '"No reviews yet"（空状态短语）被拒',
  );
  check(isPlausibleOutlet('Nintendo Life') === true, '"Nintendo Life"（真实长名）通过');
  check(isPlausibleOutlet('PlayStation Universe') === true, '"PlayStation Universe" 通过');
}

// --- 7. 去重 / 合并：JSON 给分数、DOM 给评语，合并后应两者都有 ------------
{
  const merged = dedupeReviews([
    { outlet: 'IGN', score: 90, text: null, verdict: null, url: null, author: null, platform: null, publishedAt: null },
    { outlet: 'IGN', score: 90, text: '一段更长的评语原文。', verdict: null, url: null, author: null, platform: null, publishedAt: null },
  ]);
  check(merged.length === 1, `同一媒体的重复条目被合并（实际 ${merged.length} 条）`);
  check(merged[0]?.score === 90 && merged[0]?.text === '一段更长的评语原文。', '合并后同时保留分数与评语');

  const byScore = dedupeReviews([
    { outlet: 'IGN', score: 90, text: 'a', verdict: null, url: null, author: null, platform: null, publishedAt: null },
    { outlet: 'IGN', score: 70, text: 'b', verdict: null, url: null, author: null, platform: null, publishedAt: null },
  ]);
  check(byScore.length === 2, '同一媒体的不同分数不会被误合并');
}

// --- 8. DOM 解析器单独调用（爬虫脚本用它做结构诊断） ----------------------
{
  const dom = parseReviewsFromDom(fixture('dom.html'));
  check(Array.isArray(dom) && dom.length >= 3, `parseReviewsFromDom 独立可用（${dom.length} 条）`);
}

// --- 9. 分页：这是「65 家媒体只抓到 1 条」的根因所在 -----------------------
{
  const p1 = fixture('paginated-p1.html');
  const landing = parseMediaReviews(p1);
  check(
    landing.length === 2,
    `分页首页只含 2 条（实际 ${landing.length}）—— 真实站点首页只印前几条，其余在分页里`,
  );

  const links = parseReviewsPagination(p1);
  check(links.next != null, `首页能识别出「下一页」链接（${links.next}）`);
  check(links.last === 5, `识别出总页数 5（实际 ${links.last}）`);
  check(
    /page=2/.test(links.next ?? ''),
    `下一页指向 page=2（实际 ${links.next}）`,
  );

  // 从「还没有翻过」的位置起步：next 必须是 page=2 而不是回跳 page=1。
  const first = nextReviewsPageUrl(links, 'https://www.metacritic.com/game/astro-bot/', 0);
  check(
    first != null && /page=2/.test(first),
    `第 0 页出发 → 拉 page=2（实际 ${first}）`,
  );

  // 已经在 page=2 上时，不能回头再拉 page=1 或重复拉 page=2。
  const p2 = fixture('paginated-p2.html');
  const l2 = parseReviewsPagination(p2);
  const fromP2 = nextReviewsPageUrl(l2, 'https://www.metacritic.com/game/astro-bot/critic-reviews/?page=2', 2);
  check(
    fromP2 != null && /page=3/.test(fromP2),
    `已在 page=2 → 拉 page=3，不回头（实际 ${fromP2}）`,
  );

  // 末页：没有向前的链接时必须停下，否则会无限翻。
  const p6 = fixture('paginated-p6.html');
  const l6 = parseReviewsPagination(p6);
  const fromP6 = nextReviewsPageUrl(l6, 'https://www.metacritic.com/game/astro-bot/critic-reviews/?page=6', 6);
  check(fromP6 === null, `末页(page=6)不再返回下一页（实际 ${fromP6}）`);

  // 单页（无分页器）也必须停下。
  const single = parseReviewsPagination(fixture('dom.html'));
  check(
    nextReviewsPageUrl(single, 'https://www.metacritic.com/game/hades/', 0) === null,
    '没有分页器的页面不会产生下一页（避免死循环）',
  );

  check(pageOfUrlIn('https://x/y/?page=7') === 7, `pageOfUrlIn 解析出 7（实际 ${pageOfUrlIn('https://x/y/?page=7')}）`);
  check(pageOfUrlIn('https://x/y/') === null, 'pageOfUrlIn 无 page 参数时返回 null');

  // 全量合并：首页 2 条 + 5 个分页文件 64 条 = 66 条唯一媒体。
  const all = [
    ...landing,
    ...[2, 3, 4, 5, 6].flatMap((n) => parseMediaReviews(fixture(`paginated-p${n}.html`))),
  ];
  const merged = dedupeReviews(all);
  check(
    merged.length === 66,
    `合并 6 页共 66 条唯一媒体评价（实际 ${merged.length}）—— 而不是只有首页的 2 条`,
  );
  check(
    merged.every((r) => r.outlet && r.score != null && r.text),
    '每条都带媒体名 + 打分 + 评价原文（三要素齐全，不是只有第一条）',
  );
  const outlets = merged.map((r) => r.outlet);
  check(
    new Set(outlets).size === outlets.length,
    '媒体名无重复（去重有效）',
  );
  check(
    merged.some((r) => r.outlet === 'PlayStation Universe') &&
      merged.some((r) => r.outlet === 'Gamona'),
    '首尾两页的媒体都在（覆盖到最后一页，不是提前中断）',
  );
}

console.log(`\n   \x1b[1m结果：${pass} 项通过 / ${fail} 项失败\x1b[0m\n`);
process.exit(fail ? 1 : 0);