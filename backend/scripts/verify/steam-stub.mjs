/**
 * Steam 桩服 —— 用来在没有外网的情况下、确定性地测量成就抓取的耗时与请求数。
 *
 * 为什么需要它：真实 store.steampowered.com / api.steampowered.com 的可达性与
 * 延迟都不可控（大陆网络下常常直接不可达），基准必须离线可复现；而
 * HttpService 的限流是**按 origin 分桶**的，两个域如果指向同一个 origin 就会
 * 共用同一个限流队列，从而低估并发收益。因此本脚本必须能起**两个实例**：
 *
 *   node steam-stub.mjs <port> store            # store.steampowered.com 的角色
 *   node steam-stub.mjs <port> api              # api.steampowered.com 的角色
 *
 * 覆盖的端点：
 *   store: /api/storesearch/、/api/appdetails
 *   api:   /ISteamUserStats/GetSchemaForGame/v2/
 *          /ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/
 *
 * 控制端点（不参与计数）：
 *   GET /__stats                    命中计数 + 每个 appid 的首/末次请求时间戳
 *   GET /__reset                    清零计数与时间线
 *   GET /__config?delay=250&dlc=3   每请求注入延迟（毫秒）/ 每个游戏附加的 DLC 数量
 *
 * 约定与 metacritic-stub.mjs / hltb-stub.mjs 保持一致：argv[2]=端口、argv[3]=角色。
 */
import http from 'node:http';

const PORT = Number(process.argv[2] || 4610);
const ROLE = process.argv[3] === 'api' ? 'api' : 'store';

let delayMs = Number(process.argv[4] || 0);
/** Number of fake DLC appids advertised by every appdetails response. */
let dlcCount = 0;

const hits = {
  storesearch: 0,
  appdetails: 0,
  schema: 0,
  percentages: 0,
  other: 0,
};
/** appid → { first, last } request timestamps (ms epoch), merged by the bench. */
let timeline = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function appidOf(url, body) {
  const v =
    url.searchParams.get('appid') ??
    url.searchParams.get('appids') ??
    url.searchParams.get('gameid');
  if (v) return String(v).split(',')[0];
  if (body) {
    try {
      const j = JSON.parse(body);
      const id = j?.appid ?? j?.gameid;
      if (id != null) return String(id);
    } catch {
      /* not json */
    }
  }
  return null;
}

function touch(appid) {
  if (!appid) return;
  const now = Date.now();
  const t = timeline.get(appid);
  if (t) t.last = now;
  else timeline.set(appid, { first: now, last: now });
}

function dlcAppIds() {
  return Array.from({ length: dlcCount }, (_, i) => 9001 + i);
}

function schemaFor(appid) {
  const count = Number(appid) >= 9000 ? 2 : 5;
  const gameName = Number(appid) >= 9000 ? `Stub DLC ${appid}` : `Stub Game ${appid}`;
  return {
    game: {
      gameName,
      availableGameStats: {
        achievements: Array.from({ length: count }, (_, i) => ({
          name: `ACH_${i + 1}`,
          displayName: `Achievement ${i + 1}`,
          description: `stub description ${i + 1}`,
          icon: `stub_${appid}_${i + 1}.jpg`,
          hidden: 0,
        })),
      },
    },
  };
}

function pctFor(appid) {
  const count = Number(appid) >= 9000 ? 2 : 5;
  return {
    achievementpercentages: {
      achievements: Array.from({ length: count }, (_, i) => ({
        name: `ACH_${i + 1}`,
        percent: 50 - i * 5,
      })),
    },
  };
}

function appDetailsFor(appid) {
  return {
    [appid]: {
      success: true,
      data: {
        type: 'game',
        name: `Stub Game ${appid}`,
        short_description: `stub summary for ${appid}`,
        developers: ['Stub Dev'],
        publishers: ['Stub Publisher'],
        release_date: { date: '1 Jan, 2020' },
        price_overview: { currency: 'USD', final: 1999, initial: 2999, discount_percent: 33 },
        dlc: dlcAppIds(),
        // NOTE: deliberately no header_image / capsule_image. `pickSteamPoster`
        // then returns null, so the run does not silently start downloading
        // posters from the real Steam CDN and pollute the measurement.
      },
    },
  };
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  // --- control endpoints (never counted) ---------------------------------
  if (path === '/__stats') {
    json(res, 200, {
      role: ROLE,
      delayMs,
      dlcCount,
      hits,
      timeline: Object.fromEntries(timeline),
    });
    return;
  }
  if (path === '/__reset') {
    for (const k of Object.keys(hits)) hits[k] = 0;
    timeline = new Map();
    json(res, 200, { reset: true, role: ROLE });
    return;
  }
  if (path === '/__config') {
    const d = url.searchParams.get('delay');
    if (d != null) delayMs = Number(d) || 0;
    const c = url.searchParams.get('dlc');
    if (c != null) dlcCount = Math.max(0, Number(c) || 0);
    json(res, 200, { delayMs, dlcCount });
    return;
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', async () => {
    const appid = appidOf(url, body);
    if (delayMs > 0) await sleep(delayMs);

    if (ROLE === 'store') {
      if (path === '/api/storesearch/') {
        hits.storesearch += 1;
        touch(appid);
        const term = url.searchParams.get('term') || 'stub';
        json(res, 200, {
          total: 1,
          items: [{ id: 1001, name: term, type: 'app', metascore: 88 }],
        });
        return;
      }
      if (path === '/api/appdetails') {
        hits.appdetails += 1;
        touch(appid);
        json(res, 200, appDetailsFor(appid ?? '0'));
        return;
      }
    } else {
      if (path === '/ISteamUserStats/GetSchemaForGame/v2/') {
        hits.schema += 1;
        touch(appid);
        json(res, 200, schemaFor(appid ?? '0'));
        return;
      }
      if (path === '/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/') {
        hits.percentages += 1;
        touch(appid);
        json(res, 200, pctFor(appid ?? '0'));
        return;
      }
    }

    hits.other += 1;
    json(res, 404, { error: 'not found', path, role: ROLE });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `[steam-stub:${ROLE}] listening on http://127.0.0.1:${PORT} delay=${delayMs}ms dlc=${dlcCount}`,
  );
});