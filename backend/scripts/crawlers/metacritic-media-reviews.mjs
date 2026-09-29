#!/usr/bin/env node
/**
 * Metacritic 媒体评价爬虫（独立脚本，不依赖 Nest 运行时）
 * ============================================================================
 *
 * 用途
 * ----
 * 把媒体评价（媒体名称 / 媒体打分 / 媒体评价原文）抓下来，既可以直接补进
 * ScreenPlay 的 SQLite 库，也可以只导出 JSON 供人工核对。
 *
 * 为什么要独立于后端存在
 * ----------------------
 * 1. 调样式不需要起服务：解析器是纯函数，改完 HTML 选择器立刻能重跑；
 * 2. 抓取策略比服务更重要 —— 这个脚本把「串行 + 间隔 + 重试 + 断点续跑」做成
 *    默认行为，而不是可选参数；
 * 3. 可以只对单个游戏、单个 URL 跑，方便定位「到底是页面变了还是网络挂了」。
 *
 * ⚠️ 合规与礼貌（请务必保持默认值）
 * --------------------------------
 *   - 默认串行请求（--concurrency 1）。目标站有速率限制，并发只会更快被封；
 *   - 默认每个请求间隔 1.5s（--min-interval），且带抖动，避免形成固定节拍；
 *   - 默认带 `If-None-Match` / `If-Modified-Since` 条件请求，页面没变时服务器
 *     回 304，我们直接跳过解析（省流量、也少一次解析误判的机会）；
 *   - 默认尊重 `robots.txt`（--ignore-robots 才会关掉）；
 *   - 单机自用规模的小批量抓取。请勿用于高频、大范围抓取。
 *
 * 用法
 * ----
 *   # 只抓一个游戏，打印结果（不写库、不落盘）
 *   node scripts/crawlers/metacritic-media-reviews.mjs --game 血源诅咒 --dry-run
 *
 *   # 直接抓一个 URL，用来定位解析问题（最常用）
 *   node scripts/crawlers/metacritic-media-reviews.mjs \
 *     --url https://www.metacritic.com/game/bloodborne/ --dry-run
 *
 *   # 全库补全：只处理 media_reviews 表里还没有评价的游戏，写库
 *   node scripts/crawlers/metacritic-media-reviews.mjs --db /path/to/screenplay.db --write
 *
 *   # 解析器改过之后全量重抓（覆盖已有行）
 *   node scripts/crawlers/metacritic-media-reviews.mjs --db ... --write --scope all --replace
 *
 *   # 先用本地保存的 HTML 调解析器，完全不联网
 *   node scripts/crawlers/metacritic-media-reviews.mjs --html page.html --dry-run
 *
 * 退出码
 * ------
 *   0 全部成功 / 1 有失败项 / 2 参数或环境错误
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * 仓库根目录。
 *
 * 脚本放在 `backend/scripts/crawlers/`，所以要往上三级；但仓库也可能被整体
 * 拷到别处、脚本被挪到 `scripts/crawlers/`，因此用「哪一层存在 backend/dist
 * 就用哪一层」的方式探测，而不是写死层级。
 */
const REPO_ROOT = (() => {
  let dir = HERE;
  for (let i = 0; i < 5; i += 1) {
    if (fs.existsSync(path.join(dir, 'backend', 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(HERE, '..', '..');
})();

// ---------------------------------------------------------------------------
// 解析器：复用后端编译产物，保证爬虫和线上走的是同一套选择器。
// 这样「爬虫能解析出来、后端解析不出来」这类分歧不会发生。
// ---------------------------------------------------------------------------
const require_ = createRequire(import.meta.url);

/**
 * 与后端 MediaReviewsService.UUID_NAMESPACE 保持一致（改一处必须改两处）。
 * 必须是版本位在 1–5 的合法 RFC-4122 UUID，否则 uuid 包会抛 "Invalid UUID"。
 */
const NAMESPACE = '5b1f4c2e-8a3d-4f6b-9e2a-7c1d3f5a8b40';

/** 记住实际加载的解析器路径，便于在日志里说清「用的是哪一份」。 */
let parserPath = null;

function loadParser() {
  const candidates = [
    path.join(REPO_ROOT, 'backend', 'dist', 'metadata', 'providers', 'metacritic-reviews.js'),
    path.join(REPO_ROOT, 'dist', 'metadata', 'providers', 'metacritic-reviews.js'),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      parserPath = file;
      return require_(file);
    }
  }
  fail(
    '找不到编译后的解析器。请先在 backend/ 目录执行 `npm run build`，\n' +
      '   因为本脚本刻意复用后端同一份选择器，而不是复制一份出来（两份必然漂移）。\n' +
      `   已查找：\n     - ${candidates.join('\n     - ')}`,
  );
}

// ---------------------------------------------------------------------------
// 命令行参数
// ---------------------------------------------------------------------------
const HELP = `Metacritic 媒体评价爬虫

  --db <path>              SQLite 库路径（默认取 $SCREENPLAY_DB 或 ../data/screenplay.db）
  --write                  写入数据库（默认只抓不写，配合 --dump 导出 JSON）
  --replace                写入时先删除该游戏已有评价（解析器修好后的全量重抓）
  --scope <missing|all>    missing（默认）只处理没有评价的游戏；all 处理全部
  --limit <n>              最多处理 n 个游戏（0 = 不限制）
  --game <name>            只抓名称匹配的游戏（子串匹配，可重复）
  --url <url>              只抓这一个 URL，忽略数据库
  --html <file>            解析本地 HTML，完全不联网（调试选择器用）
  --dump <file>            把抓到的结果写成 JSON
  --dry-run                不写数据库、不落盘，只打印摘要
  --concurrency <n>        并发数（默认 1；目标站有速率限制，不建议调高）
  --min-interval <ms>      同一域名两次请求的最小间隔（默认 1500）
  --max-retries <n>        单个页面的重试次数（默认 3）
  --timeout <ms>           单请求超时（默认 20000）
  --proxy <url>            代理，例如 http://127.0.0.1:7890（也可用 HTTPS_PROXY）
  --user-agent <ua>        覆盖 User-Agent
  --ignore-robots          忽略 robots.txt（默认遵守）
  --no-conditional         不做 If-None-Match / If-Modified-Since 条件请求
  --quiet                  只输出错误和最终汇总
  -h, --help               显示本帮助

示例
  node scripts/crawlers/metacritic-media-reviews.mjs --url <游戏页> --dry-run
  node scripts/crawlers/metacritic-media-reviews.mjs --db data/screenplay.db --write --limit 20
`;

function parseArgs(argv) {
  const opts = {
    db: process.env.SCREENPLAY_DB || null,
    write: false,
    replace: false,
    scope: 'missing',
    limit: 0,
    games: [],
    url: null,
    html: null,
    dump: null,
    dryRun: false,
    concurrency: 1,
    minInterval: 1500,
    maxRetries: 3,
    timeout: 20_000,
    proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null,
    userAgent: null,
    ignoreRobots: false,
    conditional: true,
    quiet: false,
  };

  const need = (i, flag) => {
    if (i + 1 >= argv.length) fail(`参数 ${flag} 需要一个值`);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const num = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) fail(`参数 ${a} 需要一个非负数字，收到 "${v}"`);
      return n;
    };
    switch (a) {
      case '--db': need(i, a); opts.db = argv[++i]; break;
      case '--write': opts.write = true; break;
      case '--replace': opts.replace = true; break;
      case '--scope': need(i, a); opts.scope = argv[++i]; break;
      case '--limit': need(i, a); opts.limit = num(argv[++i]); break;
      case '--game': need(i, a); opts.games.push(argv[++i]); break;
      case '--url': need(i, a); opts.url = argv[++i]; break;
      case '--html': need(i, a); opts.html = argv[++i]; break;
      case '--dump': need(i, a); opts.dump = argv[++i]; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--concurrency': need(i, a); opts.concurrency = Math.max(1, num(argv[++i])); break;
      case '--min-interval': need(i, a); opts.minInterval = num(argv[++i]); break;
      case '--max-retries': need(i, a); opts.maxRetries = num(argv[++i]); break;
      case '--timeout': need(i, a); opts.timeout = num(argv[++i]); break;
      case '--proxy': need(i, a); opts.proxy = argv[++i]; break;
      case '--user-agent': need(i, a); opts.userAgent = argv[++i]; break;
      case '--ignore-robots': opts.ignoreRobots = true; break;
      case '--no-conditional': opts.conditional = false; break;
      case '--quiet': opts.quiet = true; break;
      case '-h':
      case '--help':
        process.stdout.write(HELP);
        process.exit(0);
        break;
      default:
        fail(`未知参数 ${a}（--help 查看用法）`);
    }
  }

  if (opts.scope !== 'missing' && opts.scope !== 'all') {
    fail(`--scope 只能是 missing 或 all，收到 "${opts.scope}"`);
  }
  if (opts.concurrency > 1) {
    warn('并发 > 1 会提高被目标站限流的风险，建议保持 1。');
  }
  return opts;
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
let QUIET = false;
const log = (...a) => { if (!QUIET) console.log(...a); };
const warn = (...a) => console.warn('⚠️ ', ...a);
const errlog = (...a) => console.error('✗', ...a);
function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// HTTP 客户端：串行限速 + 条件请求 + 重试
// ---------------------------------------------------------------------------

/**
 * 每个域名一个「下次最早可请求时间」。
 *
 * 这是脚本里最重要的十行：目标站的限流是按来源 IP 算的，一旦触发，
 * 后续所有请求（包括正常的那些）都会失败。宁可慢，也不要被封。
 */
const nextAllowedAt = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle(url, minInterval) {
  const host = new URL(url).host;
  const now = Date.now();
  const earliest = nextAllowedAt.get(host) ?? 0;
  if (earliest > now) await sleep(earliest - now);
  // 加 0–25% 抖动：固定节拍比匀速更容易被识别为脚本。
  const jitter = minInterval * 0.25 * Math.random();
  nextAllowedAt.set(host, Date.now() + minInterval + jitter);
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** 走代理时用 CONNECT 隧道；直连时用普通的 http(s).request。 */
function requestOnce(url, { timeout, headers, proxy }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const isHttps = target.protocol === 'https:';

    const send = (req) => {
      req.on('response', (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      });
      req.on('timeout', () => req.destroy(new Error(`请求超时（${timeout}ms）`)));
      req.on('error', reject);
      req.end();
    };

    if (!proxy) {
      const req = (isHttps ? https : http).request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (isHttps ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers,
          timeout,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.on('timeout', () => req.destroy(new Error(`请求超时（${timeout}ms）`)));
      req.on('error', reject);
      req.end();
      return;
    }

    // --- 通过 HTTP 代理 ---
    const p = new URL(proxy);
    if (!isHttps) {
      const req = http.request(
        {
          hostname: p.hostname,
          port: p.port || 80,
          path: url,
          method: 'GET',
          headers: { ...headers, Host: target.host },
          timeout,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.on('timeout', () => req.destroy(new Error(`请求超时（${timeout}ms）`)));
      req.on('error', reject);
      req.end();
      return;
    }

    const connectReq = http.request({
      hostname: p.hostname,
      port: p.port || 80,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      headers: p.username ? { 'Proxy-Authorization': basicAuth(p) } : {},
      timeout,
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        reject(new Error(`代理 CONNECT 失败：HTTP ${res.statusCode}`));
        return;
      }
      const req = https.request(
        {
          socket,
          agent: false,
          servername: target.hostname,
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers,
          timeout,
        },
        (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () =>
            resolve({
              status: r.statusCode ?? 0,
              headers: r.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.on('timeout', () => req.destroy(new Error(`请求超时（${timeout}ms）`)));
      req.on('error', reject);
      req.end();
    });
    connectReq.on('timeout', () => connectReq.destroy(new Error('代理连接超时')));
    connectReq.on('error', reject);
    connectReq.end();
  });
}

function basicAuth(u) {
  return `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`;
}

/** 条件请求缓存（ETag / Last-Modified），让 304 短路解析。 */
const conditionalCache = new Map();

/**
 * 抓一个页面，带重试。
 *
 * 重试只针对「值得重试」的失败：网络错误、429、5xx。403 不重试 —— 那是站点
 * 明确拒绝，再打只会加重封禁。
 */
async function fetchPage(url, opts) {
  const headers = {
    'User-Agent': opts.userAgent || DEFAULT_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
  };
  const cached = conditionalCache.get(url);
  if (opts.conditional && cached) {
    if (cached.etag) headers['If-None-Match'] = cached.etag;
    if (cached.lastModified) headers['If-Modified-Since'] = cached.lastModified;
  }

  let lastError = null;
  for (let attempt = 1; attempt <= opts.maxRetries; attempt += 1) {
    await throttle(url, opts.minInterval);
    try {
      const res = await requestOnce(url, { timeout: opts.timeout, headers, proxy: opts.proxy });

      if (res.status === 304) {
        return { notModified: true, html: cached?.html ?? null, status: 304 };
      }
      if (res.status === 403) {
        throw new Error(`HTTP 403（站点拒绝访问；若在数据源不可达的地区，请配置 --proxy）`);
      }
      if (res.status === 429) {
        lastError = new Error('HTTP 429（被限流）');
        // 限流要退避得更久，否则重试等于继续触发限流。
        await sleep(opts.minInterval * attempt * 2);
        continue;
      }
      if (res.status >= 500) {
        lastError = new Error(`HTTP ${res.status}`);
        await sleep(opts.minInterval * attempt);
        continue;
      }
      if (res.status >= 400) {
        throw new Error(`HTTP ${res.status}`);
      }

      if (opts.conditional) {
        conditionalCache.set(url, {
          etag: res.headers.etag ?? null,
          lastModified: res.headers['last-modified'] ?? null,
          html: res.body,
        });
      }
      return { notModified: false, html: res.body, status: res.status };
    } catch (err) {
      lastError = err;
      const retriable = !/HTTP 4\d\d/.test((err && err.message) || '');
      if (!retriable) throw err;
      if (attempt < opts.maxRetries) await sleep(opts.minInterval * attempt);
    }
  }
  throw lastError ?? new Error('抓取失败');
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------
const robotsCache = new Map();

function robotsAllows(robotsTxt, ua, targetPath) {
  // 只实现通配 User-agent 的 Disallow（目标站用的是这一套，够用且不易误判）。
  const lines = robotsTxt.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim());
  const groups = [];
  let current = null;
  for (const line of lines) {
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((key === 'disallow' || key === 'allow') && current) {
      current.rules.push({ allow: key === 'allow', path: value });
    }
  }

  const uaLower = ua.toLowerCase();
  const group =
    groups.find((g) => g.agents.includes(uaLower)) ??
    groups.find((g) => g.agents.includes('*')) ??
    null;
  if (!group) return true;

  // 最长匹配优先；同样长度时 Allow 优先（与主流实现一致）。
  let verdict = true;
  let bestLen = -1;
  for (const rule of group.rules) {
    if (rule.path === '') continue;
    const pattern = rule.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    if (!new RegExp(`^${pattern}`).test(targetPath)) continue;
    if (rule.path.length > bestLen) {
      bestLen = rule.path.length;
      verdict = rule.allow;
    } else if (rule.path.length === bestLen && rule.allow) {
      verdict = true;
    }
  }
  return verdict;
}

async function checkRobots(url, opts) {
  if (opts.ignoreRobots) return true;
  const target = new URL(url);
  const origin = `${target.protocol}//${target.host}`;
  let txt = robotsCache.get(origin);
  if (txt == null) {
    try {
      const res = await requestOnce(`${origin}/robots.txt`, {
        timeout: opts.timeout,
        headers: { 'User-Agent': opts.userAgent || DEFAULT_UA },
        proxy: opts.proxy,
      });
      txt = res.status === 200 ? res.body : '';
    } catch {
      // robots.txt 拿不到时不阻塞（网络问题不等于站点禁止）。
      txt = '';
    }
    robotsCache.set(origin, txt);
  }
  if (!txt) return true;
  return robotsAllows(txt, opts.userAgent || DEFAULT_UA, `${target.pathname}${target.search}`);
}

// ---------------------------------------------------------------------------
// 数据库（用 node:sqlite —— Node 20.11+ 内置，无需编译扩展）
// ---------------------------------------------------------------------------

async function openDb(dbPath, write) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    fail('当前 Node 没有 node:sqlite。请升级到 Node 22+，或去掉 --write 只做抓取/导出。');
  }
  if (!fs.existsSync(dbPath)) fail(`数据库不存在：${dbPath}`);
  const db = new DatabaseSync(dbPath, write ? undefined : { readOnly: true });
  return db;
}

/** 目标游戏集合：默认只挑还没有评价的，和设置页按钮的口径保持一致。 */
function selectGames(db, opts) {
  const where = [];
  const params = [];

  if (opts.games.length) {
    // 名称子串匹配，方便 --game 血源诅咒 这种用法。
    where.push(`(${opts.games.map(() => 'name LIKE ?').join(' OR ')})`);
    for (const g of opts.games) params.push(`%${g}%`);
  }

  if (opts.scope === 'missing') {
    where.push(`NOT EXISTS (SELECT 1 FROM media_reviews r WHERE r.game_id = games.id)`);
    where.push(`COALESCE(reviews_status, '') NOT IN ('empty')`);
  }

  const sql =
    `SELECT g.id, g.name, g.updated_at,
            (SELECT external_id FROM game_links l
              WHERE l.game_id = g.id AND l.provider = 'metacritic' LIMIT 1) AS slug
       FROM games g
      WHERE 1=1 ${where.length ? `AND ${where.join(' AND ')}` : ''}
      ORDER BY g.updated_at DESC, g.name ASC` +
    (opts.limit > 0 ? ` LIMIT ${Math.floor(opts.limit)}` : '');

  return db.prepare(sql).all(...params);
}

function reviewCount(db, gameId) {
  return db.prepare('SELECT COUNT(*) AS c FROM media_reviews WHERE game_id = ?').get(gameId).c;
}

/**
 * 落库。
 *
 * 与后端 MediaReviewsService 的写入规则保持一致：
 *   - 评价非空才写；空结果只记状态，绝不清空已有行；
 *   - 主键由 (game_id, outlet, url) 哈希得到，保证重复跑是幂等的。
 */
function writeReviews(db, gameId, reviews, { replace, sourceUrl }) {
  const now = Date.now();

  // 必须和后端 MediaReviewsService 算出**完全相同**的 id：两边都跑过同一个库时，
  // 相同 id 才能走 upsert 更新同一行，否则会各写一行、面板出现重复评价。
  // 所以这里直接 import 后端依赖的 uuid 包，而不是自己实现一遍 v5。
  let v5;
  try {
    ({ v5 } = require_('uuid'));
  } catch {
    fail('找不到 uuid 模块。请在 backend/ 目录下执行 npm install（后端依赖里已有它）。');
  }
  const idFor = (outlet, url) => v5(`review:${gameId}:${outlet}:${url ?? ''}`, NAMESPACE);

  const insert = db.prepare(`
    INSERT INTO media_reviews
      (id, game_id, source, outlet, score, verdict, review_text, url, author, platform, published_at, sort_order, fetched_at)
    VALUES (?, ?, 'metacritic', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      outlet = excluded.outlet,
      score = excluded.score,
      verdict = excluded.verdict,
      review_text = excluded.review_text,
      url = excluded.url,
      author = excluded.author,
      platform = excluded.platform,
      published_at = excluded.published_at,
      sort_order = excluded.sort_order,
      fetched_at = excluded.fetched_at
  `);

  db.exec('BEGIN');
  try {
    if (replace) db.prepare('DELETE FROM media_reviews WHERE game_id = ?').run(gameId);
    reviews.forEach((r, index) => {
      insert.run(
        idFor(r.outlet, r.url ?? null),
        gameId,
        r.outlet,
        r.score ?? null,
        r.verdict ?? null,
        (r.text ?? '').slice(0, 1200) || null,
        r.url ?? null,
        r.author ?? null,
        r.platform ?? null,
        r.publishedAt ?? null,
        index,
        now,
      );
    });
    db.prepare(
      `UPDATE games SET reviews_status = ?, reviews_error = NULL,
         reviews_fetched_at = ?, reviews_source_url = COALESCE(?, reviews_source_url)
       WHERE id = ?`,
    ).run(reviews.length ? 'ok' : 'empty', now, sourceUrl ?? null, gameId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function markFailed(db, gameId, message) {
  db.prepare(
    `UPDATE games SET reviews_status = 'failed', reviews_error = ?, reviews_fetched_at = ?
      WHERE id = ?`,
  ).run(message, Date.now(), gameId);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function gameUrlFor(row) {
  if (!row.slug) return null;
  // 旧绑定存的是 "pc/hades" 形式，站点会重定向；两种都直接可用。
  return `https://www.metacritic.com/game/${row.slug}/`;
}

async function crawlOne({ url, name }, opts, parser) {
  const allowed = await checkRobots(url, opts);
  if (!allowed) {
    return { ok: false, skipped: true, error: `robots.txt 不允许抓取 ${url}` };
  }

  const res = await fetchPage(url, opts);
  if (res.notModified && !res.html) {
    // 服务器说没变，但我们没有本地副本 —— 只有第二次跑同一 URL 时才会走到这里，
    // 此时 conditionalCache 里一定有 html，所以这属于异常但无害的情况。
    return { ok: true, notModified: true, reviews: [] };
  }
  if (res.notModified) {
    return { ok: true, notModified: true, reviews: parser.parseMediaReviews(res.html) };
  }
  if (!res.html) return { ok: false, error: '页面为空' };

  const reviews = parser.parseMediaReviews(res.html);
  return { ok: true, notModified: false, reviews, htmlLength: res.html.length, name };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  QUIET = opts.quiet;

  const parser = loadParser();
  log(`解析器：${parserPath}`);
  log(
    `设置：串行=${opts.concurrency}，间隔=${opts.minInterval}ms，超时=${opts.timeout}ms，` +
      `重试=${opts.maxRetries}，代理=${opts.proxy ?? '直连'}，robots=${opts.ignoreRobots ? '忽略' : '遵守'}`,
  );

  // --- 模式 1：本地 HTML（完全不联网），调选择器用 ---
  if (opts.html) {
    const html = fs.readFileSync(opts.html, 'utf8');
    const reviews = parser.parseMediaReviews(html);
    printReviews(opts.html, reviews);
    if (opts.dump) dumpJson(opts.dump, [{ source: opts.html, reviews }]);
    return reviews.length ? 0 : 1;
  }

  // --- 模式 2：单个 URL ---
  if (opts.url) {
    const result = await crawlOne({ url: opts.url }, opts, parser);
    if (!result.ok) {
      errlog(`${opts.url} → ${result.error}`);
      return 1;
    }
    printReviews(opts.url, result.reviews);
    if (opts.dump) dumpJson(opts.dump, [{ source: opts.url, reviews: result.reviews }]);
    return result.reviews.length ? 0 : 1;
  }

  // --- 模式 3：库内批量 ---
  if (!opts.db) {
    const guess = path.join(REPO_ROOT, 'data', 'screenplay.db');
    opts.db = fs.existsSync(guess) ? guess : null;
  }
  if (!opts.db) fail('没有指定数据库（--db），也没有 --url / --html。用 --help 看用法。');

  const db = await openDb(opts.db, opts.write);
  const games = selectGames(db, opts);
  log(`库：${opts.db}`);
  log(`待处理：${games.length} 个游戏（scope=${opts.scope}${opts.limit ? `, limit=${opts.limit}` : ''}）`);

  if (games.length === 0) {
    log('没有需要处理的游戏。');
    return 0;
  }

  const dumped = [];
  let processed = 0;
  let gained = 0;
  let totalReviews = 0;
  let failed = 0;
  let skipped = 0;

  for (const game of games) {
    processed += 1;
    const url = gameUrlFor(game);
    const label = `[${processed}/${games.length}] ${game.name}`;

    if (!url) {
      // 没有绑定 → 没有页面可抓。交给后端的匹配流程，这里不猜 slug。
      log(`${label} → 跳过（未绑定媒体评价站条目）`);
      skipped += 1;
      if (opts.write && opts.db) {
        try {
          markFailed(db, game.id, '未绑定媒体评价站条目');
        } catch { /* 只读库时忽略 */ }
      }
      continue;
    }

    try {
      const result = await crawlOne({ url, name: game.name }, opts, parser);
      if (!result.ok) throw new Error(result.error);

      const count = result.reviews.length;
      totalReviews += count;
      log(
        `${label} → ${count} 条${result.notModified ? '（304 未修改）' : ''}`,
      );
      for (const r of result.reviews.slice(0, 5)) {
        log(`    · ${r.outlet}${r.score != null ? ` ${r.score}` : ''}${r.text ? `：${truncate(r.text, 90)}` : ''}`);
      }
      if (count > 5) log(`    · …还有 ${count - 5} 条`);

      if (count > 0) gained += 1;
      dumped.push({ gameId: game.id, name: game.name, url, reviews: result.reviews });

      if (opts.write && !opts.dryRun) {
        const before = reviewCount(db, game.id);
        writeReviews(db, game.id, result.reviews, { replace: opts.replace, sourceUrl: url });
        const after = reviewCount(db, game.id);
        if (after !== before) log(`    写入：${before} → ${after} 条`);
      }
    } catch (err) {
      failed += 1;
      errlog(`${label} → ${err.message}`);
      if (opts.write && !opts.dryRun) {
        try {
          markFailed(db, game.id, err.message);
        } catch { /* 只读库时忽略 */ }
      }
    }
  }

  if (opts.dump) dumpJson(opts.dump, dumped);

  log('');
  log('──────── 汇总 ────────');
  log(`处理游戏：${processed}（新增评价 ${gained} 个游戏）`);
  log(`抓到评价：${totalReviews} 条`);
  log(`失败：${failed}，跳过：${skipped}`);
  if (!opts.write) log('未写库（加 --write 才会写入）。');
  else if (opts.dryRun) log('--dry-run：解析结果未写库。');
  else log('已写入数据库。');

  return failed > 0 ? 1 : 0;
}

function truncate(s, n) {
  const clean = String(s).replace(/\s+/g, ' ').trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}

function printReviews(source, reviews) {
  log(`来源：${source}`);
  log(`解析出 ${reviews.length} 条媒体评价：`);
  if (reviews.length === 0) {
    log('  （无。若页面确实有评价，说明选择器需要更新 —— 用 --html 保存页面后逐步调试。）');
    return;
  }
  for (const [i, r] of reviews.entries()) {
    log('');
    log(`  ${i + 1}. 媒体名称：${r.outlet}`);
    log(`     媒体打分：${r.score ?? '（无）'}${r.verdict ? `  判定：${r.verdict}` : ''}`);
    log(`     评价原文：${r.text ? truncate(r.text, 200) : '（无）'}`);
    if (r.author) log(`     作者：${r.author}`);
    if (r.platform) log(`     平台：${r.platform}`);
    if (r.publishedAt) log(`     日期：${r.publishedAt}`);
    if (r.url) log(`     原文链接：${r.url}`);
  }
}

function dumpJson(file, payload) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(path.resolve(file), JSON.stringify(payload, null, 2), 'utf8');
  log(`已导出：${file}`);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    errlog(err?.stack || String(err));
    process.exit(1);
  });