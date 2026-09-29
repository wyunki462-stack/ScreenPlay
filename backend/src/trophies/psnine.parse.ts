/**
 * PSNINE (psnine.com) HTML → data parsing, as pure functions.
 *
 * Kept free of Nest/HTTP so the fragile part of the scraper — the site's markup —
 * can be unit-tested against saved fixtures without a network call or a DI
 * container. `psnine.source.ts` owns the requests and maps failures to user-facing
 * Chinese errors; everything here only reads a string.
 *
 * Markup notes verified against live pages (ids 5818, 51746, 19955):
 * - Every trophy is `<tr id="1" class="trophy">` with sequential ids.
 * - The tier lives in the first cell's class (`t1`..`t4`) and is mirrored by the
 *   trophy anchor's class (`text-platinum`..`text-bronze`); the cell class is
 *   authoritative, the anchor class is the fallback.
 * - The last cell holds `3.80%` followed by `<em>极为珍贵</em>`. That cell can be
 *   completely empty — psnine has no global percentage yet for freshly released
 *   trophies (measured: 19 of 85 rows for game 51746) — so a missing percentage is
 *   normal data, not a broken row.
 * - Search results contain a *first* `<a>` per game whose image is commented out,
 *   and therefore whose text is empty; the real title sits in a second anchor with
 *   the same href. Cheerio drops the comments, so ignoring empty-text anchors and
 *   deduping by id is enough.
 * - Cheerio decodes entities and drops comments/tags, which is what "unescape the
 *   text" means for every field below.
 */

import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { AchievementData, TrophyCounts, TrophyTier } from '../metadata/provider.interface';
import type { TrophySearchHit } from './trophy-source.interface';

/** Default cap for search hits; the UI only offers a short list of candidates. */
export const PSNINE_SEARCH_LIMIT = 8;

/** Tier by the class of the row's first trophy cell. */
const TIER_BY_CELL_CLASS: Record<string, TrophyTier> = {
  t1: 'platinum',
  t2: 'gold',
  t3: 'silver',
  t4: 'bronze',
};

/** Tier by the trophy anchor's `text-*` class, used as a cross-check/fallback. */
const TIER_BY_ANCHOR_CLASS: Record<string, TrophyTier> = {
  'text-platinum': 'platinum',
  'text-gold': 'gold',
  'text-silver': 'silver',
  'text-bronze': 'bronze',
};

/**
 * Header tally spans, e.g. `<span class="text-platinum">白1</span>`.
 *
 * The platinum span is spelled `白1`, *not* `白金1`, so the label must not be
 * matched literally — only the digits after it are read.
 */
const HEADER_TALLY_CLASSES: Record<string, keyof TrophyCounts> = {
  'text-platinum': 'platinum',
  'text-gold': 'gold',
  'text-silver': 'silver',
  'text-bronze': 'bronze',
  'text-strong': 'total',
};

/** `《游戏名》中文奖杯列表`, the only place the canonical game name appears. */
const GAME_TITLE_PATTERN = /《([^》]+)》/;

const TROPHY_HREF_PATTERN = /^(?:https?:\/\/psnine\.com)?\/trophy\/(\d+)(?:[?#].*)?$/;
const PSGAME_HREF_PATTERN = /^(?:https?:\/\/psnine\.com)?\/psngame\/(\d+)(?:[?#].*)?$/;

/** `3.80%` — the leading number of the rarity cell. */
const PERCENT_PATTERN = /([0-9]+(?:\.[0-9]+)?)\s*%/;

/** Result of parsing one `/psngame/<id>` trophy-list page. */
export interface PsnineGamePage {
  /** Game name from `<title>《…》中文奖杯列表`, or null when absent. */
  gameTitle: string | null;
  /** Number of `<tr class="trophy">` rows seen, before malformed ones are dropped. */
  rowCount: number;
  /** Parsed trophies, in page order. */
  achievements: AchievementData[];
  /**
   * Tally scraped from the page header, when present.
   *
   * Cross-check only: the header is decorative markup that psnine sometimes
   * leaves stale, while the rows are exact. Never derive counts from it.
   */
  headerCounts: TrophyCounts | null;
}

/**
 * Parse a `/psngame/<id>` page.
 *
 * `rowCount` lets the caller tell "this page has no trophy list at all" (wrong id
 * or a changed layout) from "the layout changed so every row became unreadable".
 * Individual malformed rows are skipped instead of aborting the list, because one
 * odd row used to be enough to lose a whole game's trophies.
 */
export function parsePsnineGamePage(html: string): PsnineGamePage {
  const empty: PsnineGamePage = {
    gameTitle: null,
    rowCount: 0,
    achievements: [],
    headerCounts: null,
  };
  if (typeof html !== 'string' || html.trim() === '') return empty;

  const $ = cheerio.load(html);
  const rows = $('tr.trophy').toArray();
  if (rows.length === 0) {
    // No rows: still try the header, so the caller's error message can mention
    // whether we recognised the page as a psnine trophy list at all.
    return { ...empty, gameTitle: parsePsnineGameTitle(html), headerCounts: parsePsnineHeaderCounts($) };
  }

  const achievements: AchievementData[] = [];
  for (const row of rows) {
    const parsed = parseTrophyRow($, $(row), achievements.length + 1);
    if (parsed) achievements.push(parsed);
  }

  return {
    gameTitle: parsePsnineGameTitle(html),
    rowCount: rows.length,
    achievements,
    headerCounts: parsePsnineHeaderCounts($),
  };
}

/**
 * Game name from the `<title>` tag.
 *
 * The trophy page's `<h1>`/breadcrumb spellings vary between PS4/PS5 editions,
 * while `<title>` is stable and identical to the name psnine's search returns.
 */
export function parsePsnineGameTitle(html: string): string | null {
  if (typeof html !== 'string') return null;
  const match = GAME_TITLE_PATTERN.exec(html);
  if (!match) return null;
  return cleanText(match[1]);
}

/**
 * Header per-tier tally, or null when the header block is missing.
 *
 * Note the header can disagree with the rows (a stale `总50` for a 69-row page);
 * callers use it to log a warning, never as the source of truth.
 */
export function parsePsnineHeaderCounts($: cheerio.CheerioAPI): TrophyCounts | null {
  const counts: TrophyCounts = { platinum: 0, gold: 0, silver: 0, bronze: 0, total: 0 };
  let found = false;
  for (const [className, key] of Object.entries(HEADER_TALLY_CLASSES)) {
    const span = $(`span.${className}`).first();
    if (span.length === 0) continue;
    const digits = /(\d+)/.exec(span.text());
    if (!digits) continue;
    counts[key] = Number.parseInt(digits[1], 10);
    found = true;
  }
  if (!found) return null;
  // `total` must be summed here: the header lists the four tiers separately, and
  // callers compare `total` against the parsed row count to spot a layout change.
  // Leaving it at 0 made that check fire on every scrape.
  counts.total = counts.platinum + counts.gold + counts.silver + counts.bronze;
  return counts;
}

/**
 * Parse one `tr.trophy` row.
 *
 * Returns null for rows that cannot be identified: `externalId` is the
 * persistence key (`AchievementData.externalId`), so a row missing either its id
 * or its name is unusable and is dropped without affecting the others.
 */
// `T` is left unconstrained on purpose: cheerio's element type lives in
// domhandler and is not re-exported, so the wrapper is accepted generically.
function parseTrophyRow<T extends AnyNode>(
  $: cheerio.CheerioAPI,
  $row: cheerio.Cheerio<T>,
  fallbackOrder: number,
): AchievementData | null {
  // A row can hold two anchors to the same trophy: one wrapping only the icon
  // (its text is empty) and one carrying the name. Take the first one that
  // actually has text, so the icon anchor is never mistaken for the name.
  const anchors = $row
    .find('a[href*="/trophy/"]')
    .toArray()
    .map((el) => $(el))
    .filter((a) => TROPHY_HREF_PATTERN.test((a.attr('href') ?? '').trim()));
  const $anchor = anchors.find((a) => cleanText(a.text()) !== '');
  if (!$anchor) return null;

  const externalId = TROPHY_HREF_PATTERN.exec(($anchor.attr('href') ?? '').trim())?.[1] ?? '';
  const name = cleanText($anchor.text());
  if (!externalId || !name) return null;

  // The image cell is the first cell carrying a `tN` class; its class also gives
  // the tier. Falling back to the anchor's `text-*` class keeps working if psnine
  // ever drops the cell class.
  let tier: TrophyTier | null = null;
  let iconUrl: string | null = null;
  for (const cell of $row.children('td').toArray()) {
    const $cell = $(cell);
    const fromCell = classTokens($cell.attr('class'))
      .map((c) => TIER_BY_CELL_CLASS[c])
      .find(Boolean);
    if (fromCell) {
      tier = fromCell;
      iconUrl = absoluteUrl($cell.find('img').first().attr('src'));
      break;
    }
  }
  if (!tier) {
    tier = classTokens($anchor.attr('class'))
      .map((c) => TIER_BY_ANCHOR_CLASS[c])
      .find(Boolean) ?? null;
  }
  if (iconUrl === null) {
    iconUrl = absoluteUrl($row.children('td').first().find('img').first().attr('src'));
  }
  const description = cleanText($row.find('em.text-gray').first().text()) || null;

  // Rarity/percentage live in the row's last cell. The whole cell is empty for
  // trophies psnine has no global stats for yet, which yields null/null.
  const $lastCell = $row.find('td').last();
  const $rarity = $lastCell.find('em').first();
  const percent = PERCENT_PATTERN.exec($lastCell.text());

  const rowId = Number.parseInt($row.attr('id') ?? '', 10);
  const sortOrder = Number.isFinite(rowId) && rowId > 0 ? rowId : fallbackOrder;

  return {
    externalId,
    name,
    description,
    iconUrl,
    globalPercent: percent ? Number.parseFloat(percent[1]) : null,
    unlocked: false,
    tier,
    rarity: cleanText($rarity.text()) || null,
    source: 'psnine',
    // PlayStation trophies from psnine are always the base game's list; psnine
    // publishes DLC trophy sets on separate pages that we do not scrape.
    dlcAppId: null,
    dlcName: null,
    sortOrder,
  };
}

/**
 * Parse a `/psngame?title=<name>` search page.
 *
 * Dedupes by game id and keeps page order, so the caller's first hit is psnine's
 * own best match. Empty-text anchors are skipped *without* marking the id as seen,
 * because the useful anchor for the same game usually comes right after them.
 * The href pattern requires the id to end the path, which keeps sub-pages such as
 * `/psngame/5818/trophy` out of the candidate list.
 */
export function parsePsnineSearch(html: string, limit: number = PSNINE_SEARCH_LIMIT): TrophySearchHit[] {
  const hits: TrophySearchHit[] = [];
  if (typeof html !== 'string' || html.trim() === '') return hits;

  const $ = cheerio.load(html);
  const seen = new Set<string>();
  for (const el of $('a[href*="/psngame/"]').toArray()) {
    const externalId = PSGAME_HREF_PATTERN.exec(($(el).attr('href') ?? '').trim())?.[1] ?? '';
    if (!externalId || seen.has(externalId)) continue;
    const name = cleanText($(el).text());
    if (!name) continue;
    seen.add(externalId);
    hits.push({ externalId, name });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Class attribute split into tokens; `[]` when absent. */
function classTokens(value: string | undefined): string[] {
  return (value ?? '').split(/\s+/).filter(Boolean);
}

/** Collapse whitespace (including `&nbsp;`) and trim, for display-ready text. */
function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** psnine serves protocol-relative image URLs in some layouts. */
function absoluteUrl(value: string | undefined): string | null {
  const src = (value ?? '').trim();
  if (!src) return null;
  return src.startsWith('//') ? `https:${src}` : src;
}