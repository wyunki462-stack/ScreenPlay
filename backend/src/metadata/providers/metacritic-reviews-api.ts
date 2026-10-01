/**
 * Metacritic critic reviews — the site's own **JSON API**.
 *
 * Why this file exists (third and last round of 「65 家媒体却只抓到 1 条」):
 *
 * Metacritic is a Nuxt (Vue) app now. The game page and the dedicated
 * `/game/<slug>/critic-reviews/` listing render **only the first slice** of the
 * reviews into the HTML — 10 cards on the listing, 14 on the game page — and the
 * rest arrive over XHR from `backend.metacritic.com`. Live evidence
 * (`007-first-light`): the page advertises **99** critic reviews, the listing's
 * markup carries 10, and `?page=2` / `?offset=10` on the HTML route return the
 * *same* 10 cards. So HTML crawling cannot ever see more than those 10, and both
 * earlier rounds were busy "fixing" the pager of a listing that has none.
 *
 * The endpoint the page itself calls is public, needs no key, and answers with
 * exactly what the panel shows:
 *
 *   GET https://backend.metacritic.com/reviews/metacritic/critic/games/<slug>/web
 *       ?offset=0&limit=10&filterBySentiment=all&sort=score
 *       &componentName=critic-reviews&componentDisplayName=critic+Reviews
 *       &componentType=ReviewList
 *
 *   → { data: { totalResults: 99, items: [ { publicationName, score, quote,
 *         url, date, author, platform, … } ] },
 *       links: { next: { href: '…&offset=10&…' } } }
 *
 * Two things about that response shape drive the code below:
 *
 *   - `limit` is **ignored** (every response carries 10 items regardless), so
 *     completeness comes from following `links.next`. We follow the URL the
 *     service hands us rather than building `?offset=N` ourselves: the query
 *     string is the server's, and re-deriving it is exactly how a crawler ends
 *     up asking a question the site does not answer.
 *   - `data.totalResults` is the site's own count (99), which is what lets a
 *     refresh report "抓全了" instead of silently stopping at the first slice.
 *
 * Like `metacritic-reviews.ts` this module is deliberately I/O-free: the
 * provider fetches, so every mapping rule stays testable offline against saved
 * responses.
 */

import {
  cleanText,
  clampScore,
  normaliseDate,
  normalisePlatform,
} from './metacritic-reviews';
import type { ParsedMediaReview } from './metacritic-reviews';

/**
 * API origin.
 *
 * Two overrides, deliberately in this order:
 *
 *   - `METACRITIC_API_BASE_URL` points the API at its own host (used when the
 *     stub serves the interface separately);
 *   - otherwise, **if the HTML base URL is overridden** (`METACRITIC_BASE_URL`,
 *     which is how every offline suite redirects this provider at a local stub),
 *     the API follows that same origin instead of falling back to the live host.
 *
 * The second rule is not cosmetic: without it an offline run would redirect the
 * *HTML* fetches to the stub but let the API request escape to
 * `backend.metacritic.com` — the suite would then silently grade live data (and
 * hit the real site), which is exactly the kind of "passes because it is not
 * really testing anything" failure this repo has been bitten by before.
 */
export const MC_API_ORIGIN = (
  process.env.METACRITIC_API_BASE_URL ||
  (process.env.METACRITIC_BASE_URL ? process.env.METACRITIC_BASE_URL : '') ||
  'https://backend.metacritic.com'
).replace(/\/+$/, '');

/** Items per API response. The service ignores `limit`; kept for documentation. */
export const API_PAGE_SIZE = 10;

/** Excerpt cap, mirroring `MAX_TEXT` in `metacritic-reviews.ts`. */
const MAX_TEXT = 1200;

/**
 * The fixed part of the query. `componentName`/`componentType` are what tell the
 * service which list on the page we mean; dropping them returns a payload for a
 * different component (user reviews / a different module), not an error.
 */
const COMPONENT_QUERY =
  'filterBySentiment=all&sort=score&componentName=critic-reviews' +
  '&componentDisplayName=critic+Reviews&componentType=ReviewList';

/** First page of the critic-review list for a game slug. */
export function criticReviewsApiUrl(slug: string, offset = 0): string {
  return (
    `${MC_API_ORIGIN}/reviews/metacritic/critic/games/${encodeURIComponent(slug)}/web` +
    `?offset=${offset}&limit=${API_PAGE_SIZE}&${COMPONENT_QUERY}`
  );
}

export interface CriticReviewsApiPage {
  reviews: ParsedMediaReview[];
  /** `data.totalResults` — the site's own count; null when the field is absent. */
  total: number | null;
  /** Absolute URL of the next slice, straight from `links.next`. */
  next: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function asCount(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(asString(value));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function asText(value: unknown): string | null {
  const s = cleanText(asString(value));
  return s ? s.slice(0, MAX_TEXT) : null;
}

/**
 * One API item → the review row the rest of the app already speaks.
 *
 * Field-by-field notes, because every one of these has bitten the HTML parser:
 *   - the outlet is `publicationName` ("Cultura Geek"), not the slug;
 *   - the score is already 0–100 and may legitimately be 0… but in practice
 *     arrives as a number, so `clampScore` guards a stray string;
 *   - the full review lives off-site in `url` (that is the 「查看原文」 link);
 *   - `platform` is a display label ("PlayStation 5") and gets folded to the
 *     short form ("PS5") the panel filters on;
 *   - `quote` is plain text, so no entity/whitespace cleanup beyond `cleanText`.
 *
 * No `verdict`: the list payload carries no sentiment field (only
 * `filterBySentiment` as a *request* parameter), and inventing one from the
 * score would put words in the outlet's mouth.
 */
export function mapApiReview(item: unknown): ParsedMediaReview | null {
  const row = asRecord(item);
  if (!row) return null;

  const outlet = cleanText(asString(row.publicationName));
  // The outlet is the one field the panel cannot render without.
  if (!outlet) return null;

  const product = asRecord(row.reviewedProduct);
  const productPlatform = product ? asRecord(product.platform) : null;

  return {
    outlet,
    score: clampScore(row.score),
    text: asText(row.quote),
    verdict: null,
    url: asString(row.url) ?? null,
    author: cleanText(asString(row.author)),
    platform: normalisePlatform(
      asString(row.platform) ?? asString(productPlatform?.name),
    ),
    publishedAt: normaliseDate(asString(row.date)),
  };
}

/** Read one API response into reviews + "is there more, and where". */
export function parseCriticReviewsApi(payload: unknown): CriticReviewsApiPage {
  const root = asRecord(payload);
  const data = root ? asRecord(root.data) : null;
  const rawItems = data?.items;

  const reviews: ParsedMediaReview[] = [];
  if (Array.isArray(rawItems)) {
    for (const item of rawItems) {
      const review = mapApiReview(item);
      if (review) reviews.push(review);
    }
  }

  const links = root ? asRecord(root.links) : null;
  const next = links ? asRecord(links.next) : null;

  return {
    reviews,
    total: asCount(data?.totalResults),
    next: asString(next?.href),
  };
}
