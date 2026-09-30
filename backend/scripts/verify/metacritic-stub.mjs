/**
 * Metacritic 桩服 —— 用来「确定性地」验证媒体评价的完整链路：
 * 抓取 → 解析 → 落库 → 接口 → 前端。
 *
 * 为什么需要它：真实站点有速率限制，而且从数据中心 IP 往往直接不可达（需要
 * 代理），所以「选择器对不对」「失败时会不会清空已有评价」这类问题没法靠联网
 * 测出来。桩服把这些变成可复现的。
 *
 * 模式（运行中可热切换）：
 *   ok      正常返回带评价的页面
 *   empty   返回 HTTP 200 但页面里没有任何评价（真实的「这个游戏没有评价」）
 *   block   返回 HTTP 403（站点拒绝，不该重试）
 *   limit   返回 HTTP 429（限流）
 *   error   返回 HTTP 500
 *   notfound 返回 HTTP 404
 *
 * 控制端点：
 *   GET /__mode?set=ok|empty|block|limit|error|notfound
 *   GET /__stats                              命中计数 + 当前模式
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'metacritic');

const PORT = Number(process.argv[2] || 4600);
let mode = process.argv[3] || 'ok';
const hits = { game: 0, search: 0, robots: 0, reviewPages: 0, byMode: {} };

/** 每个 slug 用哪份 fixture —— 让不同游戏走不同分支。 */
const PAGE_FOR = {
  bloodborne: 'nextdata.html',
  hades: 'dom.html',
  'no-reviews-game': 'empty.html',
  // 分页场景：首页只印 2 条，其余 64 条分布在 paginated-p2..p6
  'astro-bot': 'paginated-p1.html',
};

const EMPTY = fs.readFileSync(path.join(FIXTURES, 'empty.html'), 'utf8');

function pageFor(slug) {
  const file = PAGE_FOR[slug];
  if (!file) return EMPTY;
  return fs.readFileSync(path.join(FIXTURES, file), 'utf8');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // --- 控制端点 ---
  if (url.pathname === '/__mode') {
    const next = url.searchParams.get('set');
    if (next) mode = next;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ mode }));
    return;
  }
  if (url.pathname === '/__stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ mode, hits }));
    return;
  }

  if (url.pathname === '/robots.txt') {
    hits.robots += 1;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('User-agent: *\nAllow: /\n');
    return;
  }

  // --- 失败模式 ---
  const fail = () => {
    hits.byMode[mode] = (hits.byMode[mode] ?? 0) + 1;
    switch (mode) {
      case 'block':
        res.writeHead(403, { 'content-type': 'text/html' });
        res.end('<html><body>Forbidden</body></html>');
        return true;
      case 'limit':
        res.writeHead(429, { 'content-type': 'text/html', 'retry-after': '5' });
        res.end('<html><body>Too Many Requests</body></html>');
        return true;
      case 'error':
        res.writeHead(500, { 'content-type': 'text/html' });
        res.end('<html><body>Server Error</body></html>');
        return true;
      case 'notfound':
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end(fs.readFileSync(path.join(FIXTURES, 'notfound.html'), 'utf8'));
        return true;
      default:
        return false;
    }
  };

  // 媒体评价的分页列表。
  //
  // 真实站点把绝大部分媒体评价挂在 `/game/<slug>/critic-reviews/?page=N`
  // 上，游戏首页只印出前几条 —— 这正是「65 家媒体只抓到 1 条」的根因。
  // 桩服必须能服务这条路径，否则「跟随分页」的逻辑在离线环境里测不到。
  const listing = /^\/game\/([^/]+)\/critic-reviews\/?$/.exec(url.pathname);
  if (listing) {
    hits.reviewPages = (hits.reviewPages ?? 0) + 1;
    if (fail()) return;
    const page = Number(url.searchParams.get('page') || '1');
    const file = path.join(FIXTURES, `paginated-p${page}.html`);
    const html = fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8')
      : fs.readFileSync(path.join(FIXTURES, 'empty.html'), 'utf8');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      etag: `"stub-${listing[1]}-p${page}-${mode}"`,
      'last-modified': new Date(0).toUTCString(),
    });
    res.end(html);
    return;
  }

  if (url.pathname.startsWith('/game/')) {
    hits.game += 1;
    if (fail()) return;
    const slug = decodeURIComponent(url.pathname.replace('/game/', '').replace(/\/$/, ''));
    const html = mode === 'empty' ? EMPTY : pageFor(slug);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      etag: `"stub-${slug}-${mode}"`,
      'last-modified': new Date(0).toUTCString(),
    });
    res.end(html);
    return;
  }

  if (url.pathname.startsWith('/search/')) {
    hits.search += 1;
    if (fail()) return;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(EMPTY);
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Metacritic 桩服已启动：http://127.0.0.1:${PORT}（模式 ${mode}）`);
});