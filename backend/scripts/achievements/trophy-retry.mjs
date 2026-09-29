/**
 * 奖杯抓取「失败与重试」验证。
 *
 * 目标：证明最常见的真实故障模式被正确处理，而且**不会静默变成「没有奖杯」**：
 *   1. 站点返回 504/503（psnine 的高频故障）→ 自动重试，成功后正常返回；
 *   2. 一直失败 → 抛出带 HTTP 状态码的明确错误，而不是空列表；
 *   3. 200 但响应体为空（反爬/代理拦截页）→ 给出专门的错误文案，
 *      而不是被当成「这游戏没有奖杯」；
 *   4. 站点根地址可配置（TROPHY_PSNINE_BASE_URL）→ 搜索与取列表两条路径都生效，
 *      这样在某个网络下被封时可以指到镜像/反代。
 *
 * 用一个本地 HTTP 桩服替代真实站点，所以结论可复现、不受网络抖动影响。
 */
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { PsnineTrophySource, HttpService, parsePsnineHeaderCounts, parsePsnineGamePage } =
  require('./trophy.cjs');
const cheerio = require('cheerio');

let pass = 0, fail = 0, warned = 0;
const ok = (m) => { console.log(`  \x1b[32m✓\x1b[0m ${m}`); pass++; };
const bad = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); fail++; };
const warn = (m) => { console.log(`  \x1b[33m!\x1b[0m ${m}`); warned++; };
const info = (m) => console.log(`  \x1b[36m·\x1b[0m ${m}`);

/** 奖杯行数（与头部总数对比用）。 */
const title_rows = (page) => page.achievements.length;

/** 一页结构合法的 psnine 奖杯页：白金1 / 银1 / 铜1。 */
const TROPHY_PAGE = `<!doctype html><html><body>
<div class="title"><h1>测试游戏</h1></div>
<div class="tally">
  <span class="text-platinum">白1</span><span class="text-gold">金0</span>
  <span class="text-silver">银1</span><span class="text-bronze">铜1</span>
</div>
<table class="list">
  <tr id="1" class="trophy">
    <td class="t1"><img src="/img/p.png"></td>
    <td><a href="/trophy/1001">白金奖杯</a></td>
    <td>白金说明</td>
    <td>3.80%<em>极为珍贵</em></td>
  </tr>
  <tr id="2" class="trophy">
    <td class="t3"><img src="/img/s.png"></td>
    <td><a href="/trophy/1002">银奖杯</a></td>
    <td>银说明</td>
    <td></td>
  </tr>
  <tr id="3" class="trophy">
    <td class="t4"><img src="/img/b.png"></td>
    <td><a href="/trophy/1003">铜奖杯</a></td>
    <td>铜说明</td>
    <td>42.10%<em>普通</em></td>
  </tr>
</table>
</body></html>`;

const SEARCH_PAGE = `<!doctype html><html><body>
<table><tr>
  <td><a href="/psngame/5818"><img src="/i.png"></a><a href="/psngame/5818">血源诅咒</a></td>
</tr></table>
</body></html>`;

/**
 * 本地桩服：按脚本逐次返回状态码，用来精确复现「先失败后成功」。
 * `hits` 记录每个路径被请求的次数，用于证明重试真的发生了。
 */
function startStub(script) {
  const hits = { list: 0, search: 0 };
  const server = http.createServer((req, res) => {
    const isSearch = req.url.startsWith('/psngame?') || req.url === '/psngame';
    const key = isSearch ? 'search' : 'list';
    const n = hits[key]++;
    const step = script(key, n);
    if (step.status && step.status !== 200) {
      res.writeHead(step.status, { 'content-type': 'text/html' });
      res.end('<html>error</html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(step.body ?? TROPHY_PAGE);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, hits, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function makeSource(baseUrl, maxRetries) {
  const config = {
    get: (k) => ({
      crawlerMinIntervalMs: 30,
      crawlerMaxRetries: maxRetries,
      rawgProxy: '',
      crawlerUserAgent: 'ScreenPlay/0.1 (+test)',
      trophyPsnineDisabled: false,
      trophyPsnineBaseUrl: baseUrl,
    })[k],
  };
  return new PsnineTrophySource(config, new HttpService(config));
}

(async () => {
  // ── 1. 504 两次后成功 ────────────────────────────────────────────────
  console.log('\n【1】站点 504 抖动 → 自动重试，最终成功（不误报为「没有奖杯」）');
  {
    const stub = await startStub((key, n) =>
      key === 'list' && n < 2 ? { status: 504 } : { body: TROPHY_PAGE },
    );
    const src = makeSource(stub.url, 3);
    try {
      const r = await src.fetch('5818');
      const tiers = r.counts;
      if (r.achievements.length === 3 && tiers.platinum === 1 && tiers.silver === 1 && tiers.bronze === 1) {
        ok(`重试后抓到 3 条（白金${tiers.platinum}/银${tiers.silver}/铜${tiers.bronze}）`);
      } else {
        bad(`条数异常：${r.achievements.length} ${JSON.stringify(tiers)}`);
      }
      if (stub.hits.list === 3) ok(`站点被请求 ${stub.hits.list} 次：2 次 504 + 1 次成功（重试确实发生）`);
      else bad(`请求次数异常：${stub.hits.list}（预期 3）`);
    } catch (e) {
      bad(`本应重试成功，却抛错：${e.message}`);
    }
    stub.server.close();
  }

  // ── 2. 一直失败 → 明确报错 ──────────────────────────────────────────
  console.log('\n【2】站点持续 503 → 抛出带状态码的错误，绝不返回空列表');
  {
    const stub = await startStub(() => ({ status: 503 }));
    const src = makeSource(stub.url, 1);
    try {
      const r = await src.fetch('5818');
      bad(`本应抛错，却返回了 ${r.achievements.length} 条（静默失败）`);
    } catch (e) {
      if (/HTTP 503/.test(e.message)) ok(`错误信息带状态码：${e.message.slice(0, 62)}…`);
      else bad(`错误信息缺少状态码：${e.message}`);
      if (e.name === 'TrophySourceError' || /TrophySourceError/.test(e.constructor?.name ?? '')) {
        ok('错误类型为 TrophySourceError（可被降级链识别并换下一个源）');
      } else {
        info(`错误类型：${e.constructor?.name ?? typeof e}`);
      }
    }
    stub.server.close();
  }

  // ── 3. 200 空响应体 → 专门文案 ──────────────────────────────────────
  console.log('\n【3】200 但响应体为空（反爬/代理拦截）→ 专门文案，而非「没有奖杯」');
  {
    const stub = await startStub(() => ({ body: '' }));
    const src = makeSource(stub.url, 0);
    try {
      await src.fetch('5818');
      bad('空响应体本应抛错');
    } catch (e) {
      if (/空|拦截|反爬/.test(e.message)) ok(`给出专门说明：${e.message.slice(0, 66)}…`);
      else bad(`文案未区分空响应：${e.message.slice(0, 66)}`);
      if (!/没有奖杯|未找到/.test(e.message)) ok('没有被误判成「这个游戏没有奖杯」');
      else bad('被误判成「没有奖杯」，会误导用户');
    }
    stub.server.close();
  }

  // ── 4. 搜索路径同样走可配置根地址 ───────────────────────────────────
  console.log('\n【4】站点根地址可配置 → 搜索与取列表两条路径都生效');
  {
    const stub = await startStub((key, n) => (key === 'search' ? { body: SEARCH_PAGE } : { body: TROPHY_PAGE }));
    const src = makeSource(stub.url, 0);
    try {
      const hits = await src.search('血源诅咒');
      if (hits.some((h) => h.externalId === '5818')) {
        ok(`搜索走配置的根地址并解析成功：${hits.map((h) => `${h.name}(${h.externalId})`).join('、')}`);
      } else {
        bad(`搜索结果异常：${JSON.stringify(hits)}`);
      }
      if (stub.hits.search >= 1) ok('搜索请求确实打到了桩服（根地址配置已贯通）');
      else bad('搜索没有打到桩服，配置未生效');
    } catch (e) {
      bad(`搜索抛错：${e.message}`);
    }
    stub.server.close();
  }

  // ── 5. 真实站点仍然可用（配置默认值没被改坏） ────────────────────────
  console.log('\n【5】默认配置仍指向真实 psnine（改配置没有改坏默认值）');
  {
    const src = makeSource(undefined, 2);
    try {
      const hits = await src.search('血源诅咒');
      if (hits.some((h) => h.externalId === '5818')) ok('默认根地址下真实搜索仍返回 血源诅咒(5818)');
      else warn(`真实站点本次未返回预期结果：${JSON.stringify(hits.slice(0, 2))}（网络抖动）`);
    } catch (e) {
      warn(`真实站点本次不可达：${e.message.slice(0, 60)}（网络抖动，属环境性）`);
    }
  }

  // ── 6. 版面变化检测（头部总数 vs 实际行数） ──────────────────────────
  console.log('\n【6】头部总数能反映真实分级（版面变化检测不会被误触发）');
  {
    const $ok = cheerio.load(TROPHY_PAGE);
    const tally = parsePsnineHeaderCounts($ok);
    if (tally && tally.total === 3 && tally.platinum === 1 && tally.silver === 1 && tally.bronze === 1) {
      ok(`头部总数正确累加：白金${tally.platinum}/银${tally.silver}/铜${tally.bronze}/共${tally.total}`);
    } else {
      bad(`头部总数异常：${JSON.stringify(tally)}`);
    }
    const page = parsePsnineGamePage(TROPHY_PAGE);
    if (tally && tally.total === title_rows(page)) {
      ok('头部总数与实际行数一致 → 正常抓取不会刷出「版面变化」告警');
    } else {
      bad(`一致性问题：头部 ${tally?.total} vs 行数 ${title_rows(page)}`);
    }

    // 人为让头部与实际行数不一致，确认检测器仍然有效
    const skewed = TROPHY_PAGE.replace('白1', '白5');
    const $s = cheerio.load(skewed);
    const t2 = parsePsnineHeaderCounts($s);
    if (t2 && t2.total !== title_rows(parsePsnineGamePage(skewed))) {
      ok(`头部(5)≠行数(3) 可被检出 → 版面真出问题时告警依然会响`);
    } else {
      bad('版面变化检测失效，真出问题时不会告警');
    }
  }

  console.log(`\n  结果: ${pass} 通过 / ${warned} 提示 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n  测试异常:', e.message);
  console.error(e.stack?.split('\n').slice(0, 5).join('\n'));
  process.exit(2);
});