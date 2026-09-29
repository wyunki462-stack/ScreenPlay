/**
 * HLTB 桩服 —— 用来「确定性地」复现时长源的两种失败，并验证后端不会把失败写进缓存。
 *
 * 为什么需要它：真实 HLTB 的成功/失败是随机的（实测代理下大约一半成功率），
 * 光靠联网测不出「空结果 → 不写缓存 → 重试 → 成功」这条链路。桩服把失败变成
 * 可复现的，于是缓存缺陷可以被真正证伪。
 *
 * 模式（每次请求都会判断，可在运行中热切换）：
 *   ok         正常返回（comp_main 单位是秒）
 *   empty      返回 HTTP 200 但 data 为空 —— 这正是旧的「空结果被写进缓存」路径
 *   error      返回 HTTP 500
 *   forbid     返回 HTTP 403（HLTB 的 token 过期语义，应触发换 token 重试）
 *
 * 控制端点：
 *   GET /__mode?set=ok|empty|error|forbid    切换模式
 *   GET /__stats                             统计各端点命中次数 + 当前模式
 */
import http from 'node:http';

const PORT = Number(process.argv[2] || 4599);
let mode = process.argv[3] || 'ok';
const hits = { init: 0, search: 0, byMode: {} };

const SECONDS = {
  // game_name → { main, plus, hundred }
  '血源诅咒': { main: 116_000, plus: 156_000, hundred: 270_000 },
  Bloodborne: { main: 116_000, plus: 156_000, hundred: 270_000 },
  Hades: { main: 77_000, plus: 117_000, hundred: 173_000 },
};

function payload(name) {
  const s = SECONDS[name] ?? { main: 36_000, plus: 54_000, hundred: 90_000 };
  return {
    count: 1,
    data: [
      {
        game_id: 12345,
        game_name: name,
        profile_platform: 'PlayStation 4',
        release_world: 1458432000,
        comp_main: s.main,
        comp_plus: s.plus,
        comp_100: s.hundred,
        profile_dev: 'FromSoftware',
        profile_publishers: ['Sony Computer Entertainment'],
        profile_platforms: ['PlayStation 4', 'PlayStation 5'],
      },
    ],
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  hits.byMode[mode] = (hits.byMode[mode] ?? 0) + 1;

  if (url.pathname === '/__mode') {
    const next = url.searchParams.get('set');
    if (next) mode = next;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ mode, hits }));
    return;
  }
  if (url.pathname === '/__stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ mode, hits }));
    return;
  }

  if (url.pathname === '/api/search/site/init') {
    hits.init += 1;
    if (mode === 'forbid') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ token: `stub-token-${Date.now()}` }));
    return;
  }

  if (url.pathname === '/api/search/site') {
    hits.search += 1;
    if (mode === 'error') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
      return;
    }
    if (mode === 'forbid') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    if (mode === 'empty') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ count: 0, data: [] }));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let term = '';
      try {
        term = JSON.parse(body)?.searchTerms?.[0] ?? '';
      } catch {
        /* ignore */
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload(term)));
    });
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found', path: url.pathname }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[hltb-stub] listening on http://127.0.0.1:${PORT} mode=${mode}`);
});