#!/usr/bin/env node
/**
 * Standalone test for the PSNINE trophy parser (`psnine.parse.ts`).
 *
 * Run with plain `node backend/scripts/test-psnine-parser.mjs` — if the runtime
 * needs a flag to strip TypeScript types, the script re-runs itself once with
 * `--experimental-strip-types` and reports the child's exit code.
 *
 * Fixtures live in /tmp/psnine (saved live pages, so the test needs no network
 * once they exist) and are downloaded with curl when missing.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PARSE_TS = `${HERE}/../src/trophies/psnine.parse.ts`;
const FIXTURE_ROOT = '/tmp/psnine';
const USER_AGENT = 'ScreenPlay/0.1 (+personal metadata library)';

const GAMES = [
  {
    id: '19955',
    fixture: `${FIXTURE_ROOT}/t.html`,
    title: '最终幻想16',
    rows: 69,
    counts: { platinum: 1, gold: 3, silver: 6, bronze: 59 },
    first: {
      externalId: '19955001',
      name: 'FINAL FANTASY',
      description: '探求之旅将永世流传',
      globalPercent: 3.8,
      rarity: '极为珍贵',
      tier: 'platinum',
    },
    firstBronze: {
      name: '往昔的记忆',
      description: '从过去的梦中醒来',
      globalPercent: 84.7,
      rarity: '一般',
    },
  },
  {
    id: '5818',
    fixture: `${FIXTURE_ROOT}/cache/5818.html`,
    title: '血源诅咒',
    rows: 40,
    counts: { platinum: 1, gold: 7, silver: 8, bronze: 24 },
    first: {
      externalId: '5818001',
      name: 'Bloodborne',
      description: '已获得所有战利品。脱帽!',
      globalPercent: 6.9,
      rarity: '非常珍贵',
      tier: 'platinum',
    },
  },
  {
    id: '51746',
    fixture: `${FIXTURE_ROOT}/cache/51746.html`,
    title: '羊蹄山之魂',
    rows: 85,
    counts: { platinum: 1, gold: 3, silver: 12, bronze: 69 },
    first: {
      externalId: '51746001',
      name: '传说怨灵',
      description: '获得所有奖杯。',
      globalPercent: 13.2,
      rarity: '非常珍贵',
      tier: 'platinum',
    },
  },
];

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}`);
    console.log(`      expected: ${JSON.stringify(expected)}`);
    console.log(`      actual:   ${JSON.stringify(actual)}`);
  }
}

function checkTrue(label, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Import the .ts parser, re-running this script with the strip-types flag if needed. */
async function loadParser() {
  try {
    return await import(pathToFileURL(PARSE_TS).href);
  } catch (err) {
    if (process.env.PSNINE_TEST_REEXEC === '1') throw err;
    console.log('Re-running with --experimental-strip-types to import the .ts parser…\n');
    const res = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
      { stdio: 'inherit', env: { ...process.env, PSNINE_TEST_REEXEC: '1' } },
    );
    process.exit(res.status ?? 1);
  }
}

/** Fetch a fixture with curl when it is not on disk yet. */
function ensureFixture(path, id) {
  if (existsSync(path)) return true;
  mkdirSync(dirname(path), { recursive: true });
  const url = `https://psnine.com/psngame/${id}`;
  console.log(`Downloading fixture ${url} → ${path}`);
  const res = spawnSync(
    'curl',
    ['-sSL', '--max-time', '40', '-A', USER_AGENT, '-o', path, url],
    { encoding: 'utf8' },
  );
  if (res.status !== 0 || !existsSync(path)) {
    failed += 1;
    console.log(`  ✗ could not obtain fixture for game ${id}: ${res.stderr || res.error}`);
    return false;
  }
  return true;
}

function countsOf(achievements) {
  const counts = { platinum: 0, gold: 0, silver: 0, bronze: 0 };
  for (const a of achievements) if (a.tier in counts) counts[a.tier] += 1;
  return counts;
}

const parse = await loadParser();

console.log(`Parser loaded from ${PARSE_TS}\n`);

// ---------------------------------------------------------------- game pages
for (const game of GAMES) {
  console.log(`Game ${game.id} (${game.title})`);
  if (!ensureFixture(game.fixture, game.id)) continue;

  const html = readFileSync(game.fixture, 'utf8');
  const page = parse.parsePsnineGamePage(html);

  check('game title from <title>', page.gameTitle, game.title);
  check('row count', page.rowCount, game.rows);
  check('all rows parsed', page.achievements.length, game.rows);
  check('per-tier counts', countsOf(page.achievements), game.counts);
  check('header tally matches parsed rows', page.headerCounts, {
    ...game.counts,
    total: game.rows,
  });

  const first = page.achievements[0] ?? {};
  check('first trophy: name', first.name, game.first.name);
  check('first trophy: description', first.description, game.first.description);
  check('first trophy: globalPercent', first.globalPercent, game.first.globalPercent);
  check('first trophy: rarity', first.rarity, game.first.rarity);
  check('first trophy: tier', first.tier, game.first.tier);
  check('first trophy: externalId', first.externalId, game.first.externalId);
  check('first trophy: sortOrder', first.sortOrder, 1);
  check('first trophy: unlocked', first.unlocked, false);
  check('first trophy: source', first.source, 'psnine');
  check('first trophy: dlc fields', [first.dlcAppId, first.dlcName], [null, null]);
  checkTrue(
    'first trophy: iconUrl from the tN cell',
    typeof first.iconUrl === 'string' && /^https?:\/\/.+\.(png|PNG)$/.test(first.iconUrl),
    `got ${JSON.stringify(first.iconUrl)}`,
  );

  if (game.firstBronze) {
    const bronze = page.achievements.find((a) => a.tier === 'bronze') ?? {};
    check('first bronze: name', bronze.name, game.firstBronze.name);
    check('first bronze: description', bronze.description, game.firstBronze.description);
    check('first bronze: globalPercent', bronze.globalPercent, game.firstBronze.globalPercent);
    check('first bronze: rarity', bronze.rarity, game.firstBronze.rarity);
  }

  checkTrue(
    'page order preserved (sortOrder = row index)',
    page.achievements.every((a, i) => a.sortOrder === i + 1),
  );
  checkTrue(
    'every trophy has an id, a name and a tier',
    page.achievements.every((a) => a.externalId && a.name && a.tier),
  );
  checkTrue(
    'percentages are numbers in (0, 100] or null',
    page.achievements.every(
      (a) => a.globalPercent === null || (a.globalPercent > 0 && a.globalPercent <= 100),
    ),
  );
  checkTrue(
    'every trophy has an icon url',
    page.achievements.every((a) => typeof a.iconUrl === 'string' && a.iconUrl.length > 0),
  );
  console.log('');
}

// ---------------------------------------------------------------- search page
console.log('Search parsing (synthetic markup copied from a live result page)');
{
  // Real pages carry a first anchor per game whose image is commented out — its
  // text is empty — plus a second anchor with the title; `/psngame/<id>/trophy`
  // sub-page links must not become candidates.
  const searchHtml = `<html><body><table>
<tr><td><a href="https://psnine.com/psngame/100"><!--            <img src="--><!--" width="91" /></a>--><img src="a.png" /></a></td>
<td><a href="https://psnine.com/psngame/100">血源诅咒</a></td></tr>
<tr><td><a href="https://psnine.com/psngame/200"><img src="b.png" /></a></td>
<td><a href="https://psnine.com/psngame/200">Tom &amp; Jerry 大冒险</a></td></tr>
<tr><td><a href="https://psnine.com/psngame/300"></a></td></tr>
<tr><td><a href="https://psnine.com/psngame/100">血源诅咒 (重复)</a></td></tr>
<tr><td><a href="https://psnine.com/psngame/100/trophy">奖杯列表</a></td></tr>
<tr><td><a href="https://psnine.com/psngame/400">恶魔之魂</a></td></tr>
<tr><td><a href="https://psnine.com/psngame/500">恶魔之魂 重制版</a></td></tr>
<tr><td><a href="https://psnine.com/psngame/600">对马岛之魂</a></td></tr>
<tr><td><a href="https://psnine.com/psngame/700">战神</a></td></tr>
<tr><td><a href="https://psnine.com/psngame/800">战神 诸神黄昏</a></td></tr>
<tr><td><a href="https://psnine.com/psngame/900">地平线</a></td></tr>
<tr><td><a href="https://psnine.com/psngame/1000">地平线 西之绝境</a></td></tr>
<tr><td><a href="https://psnine.com/psngame/1100">最后生还者</a></td></tr>
</table></body></html>`;

  const hits = parse.parsePsnineSearch(searchHtml);
  check('dedupe by id, empty names skipped, sub-pages excluded', hits, [
    { externalId: '100', name: '血源诅咒' },
    { externalId: '200', name: 'Tom & Jerry 大冒险' },
    { externalId: '400', name: '恶魔之魂' },
    { externalId: '500', name: '恶魔之魂 重制版' },
    { externalId: '600', name: '对马岛之魂' },
    { externalId: '700', name: '战神' },
    { externalId: '800', name: '战神 诸神黄昏' },
    { externalId: '900', name: '地平线' },
  ]);
  checkTrue('names are HTML-unescaped and id 100 is not duplicated', hits.filter((h) => h.externalId === '100').length === 1);
  checkTrue('game ids are raw digits, never URLs', hits.every((h) => /^\d+$/.test(h.externalId)));
  check('default limit is 8 hits', hits.length, 8);
  check('explicit limit is honoured', parse.parsePsnineSearch(searchHtml, 3).length, 3);
  check('no match returns []', parse.parsePsnineSearch('<html><body>没有找到相关内容</body></html>'), []);
  console.log('');
}

// -------------------------------------------------------------------- garbage
console.log('Garbage input is tolerated (returns empty data, never throws)');
{
  const emptyPage = () => ({ rowCount: 0, achievements: [] });
  const pageOf = (html) => {
    const p = parse.parsePsnineGamePage(html);
    return { rowCount: p.rowCount, achievements: p.achievements };
  };
  check('empty string → no rows', pageOf(''), emptyPage());
  check('empty document → no rows', pageOf('<html></html>'), emptyPage());
  check('plain text → no rows', pageOf('not html at all'), emptyPage());
  check('empty string → no title', parse.parsePsnineGameTitle(''), null);
  check('empty string → no search hits', parse.parsePsnineSearch(''), []);
  check('empty string → no header tally', parse.parsePsnineGamePage('').headerCounts, null);
  // Rows present but unreadable: the source must be able to tell this apart from
  // "no trophy list at all", so rowCount stays non-zero.
  const junkRows = parse.parsePsnineGamePage(
    '<table><tr class="trophy"><td class="t1">no anchor here</td></tr></table>',
  );
  check('junk row counted but dropped', [junkRows.rowCount, junkRows.achievements.length], [1, 0]);
  console.log('');
}

console.log(`${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);