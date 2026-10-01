/**
 * Metacritic critic-review parser (媒体评价).
 *
 * A deliberately standalone module with **no I/O**. It takes the HTML of a
 * Metacritic game page and returns the individual critic reviews, so the whole
 * fragile part of the feature can be tested offline against saved fixtures —
 * no network, no rate limits, no chance of tripping a bot check while iterating.
 *
 * Two consumers use this:
 *   1. `MetacriticProvider` (backend scrape → `media_reviews` table), so the
 *      detail page's 「媒体评价」 tab fills in during a normal refresh;
 *   2. `scripts/scrape-metacritic.mjs` (standalone crawler), which prints/dumps
 *      the same structure for local debugging against a real page.
 *
 * Markup strategy: Metacritic is a Next.js app that also embeds structured data.
 * We therefore try, in order of reliability:
 *   1. `__NEXT_DATA__` JSON — the least brittle source when present;
 *   2. JSON-LD `review[]` — standard, stable field names;
 *   3. the rendered DOM (`.critic-review`, `[class*="criticReview"]`, …).
 * Any strategy that yields nothing degrades to "no reviews" rather than throwing,
 * because a layout change must never fail a whole metadata scrape.
 */

import * as cheerio from 'cheerio';

export interface ReviewsPageLinks {
  /**
   * Next page to fetch, absolute or site-relative — whichever the page printed.
   * `null` when the document is the last page.
   */
  next: string | null;
  /** Highest `?page=N` seen on the page. Used to bound the crawl. */
  last: number;
  /** Current page number as printed, when discoverable. */
  current: number;
}

export interface ParsedMediaReview {
  /** Publication name, e.g. "IGN". The only field we insist on. */
  outlet: string;
  /** The outlet's own score on Metacritic's 0–100 scale. */
  score: number | null;
  /** Short verdict text / excerpt as printed on the Metacritic page. */
  text: string | null;
  /** Word verdict when the site gives one instead of a number ("Positive"). */
  verdict: string | null;
  /** Link to the review's Metacritic page. */
  url: string | null;
  /** Critic name, when credited. */
  author: string | null;
  /** Platform the review was written for ("PC", "PS5", …). */
  platform: string | null;
  /** Publication date, ISO when a parseable date is embedded. */
  publishedAt: string | null;
}

/** Review text is an excerpt; cap it so one pathological page cannot bloat a row. */
const MAX_TEXT = 1200;
/** Upper bound on stored reviews. The pager is walked in full; this only guards
 *  against a mis-detected pager ballooning one game's row set. */
export const MAX_REVIEWS = 200;

/**
 * Outlets that are navigation/filter chrome rather than publications.
 *
 * The DOM fallback walks elements whose class mentions "review", and Metacritic's
 * filter dropdown ("All", "PC", "PS5", "Xbox Series X", …) sits in that same
 * subtree. Dropping these keeps the list to actual publications.
 */
const NON_OUTLETS = new Set([
  'all',
  'all platforms',
  'all critics',
  'filter',
  'sort',
  'sort by',
  'platform',
  'genre',
  'score',
  'reviews',
  'review',
  'critic reviews',
  'user reviews',
  'metacritic',
  'metascore',
  'see all',
  'more',
  'read more',
  'positive',
  'mixed',
  'negative',
  'pc',
  'ps5',
  'ps4',
  'xbox one',
  'xbox series x',
  'xbox series s',
  'nintendo switch',
  'switch',
  'ios',
  'android',
  'mac',
  'linux',
  'stadia',
  'wii u',
  '3ds',
  'vita',
]);

/** Date shapes Metacritic prints, e.g. "Nov 12, 2020" or "2020-11-12". */
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

/**
 * Parse the reviews embedded as a JSON blob (tolerant of malformed JSON).
 *
 * Used for both `__NEXT_DATA__` and JSON-LD, whose review arrays look different
 * but carry overlapping field names — so one normaliser handles both.
 */
function reviewsFromJson(root: unknown): ParsedMediaReview[] {
  const out: ParsedMediaReview[] = [];
  for (const obj of walkJson(root)) {
    const review = normaliseJsonReview(obj);
    if (review) out.push(review);
  }
  return out;
}

/**
 * Depth-first walk collecting objects that look like a review.
 *
 * A recursive walk (rather than reaching for a fixed path) is what makes this
 * survive Next.js reshuffling its `props.pageProps` tree between deploys.
 */
function* walkJson(node: unknown, depth = 0): Generator<Record<string, unknown>> {
  if (depth > 12 || node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) yield* walkJson(item, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  yield obj;
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') yield* walkJson(value, depth + 1);
  }
}

/** Does this object describe a single critic review? */
function looksLikeReview(o: Record<string, unknown>): boolean {
  const hasOutlet =
    typeof o.publicationName === 'string' ||
    typeof o.publication === 'string' ||
    typeof o.outlet === 'string' ||
    (typeof o.publisher === 'object' && o.publisher !== null) ||
    typeof o.author === 'string' ||
    typeof o.criticName === 'string';
  const hasBody =
    typeof o.quote === 'string' ||
    typeof o.reviewBody === 'string' ||
    typeof o.body === 'string' ||
    typeof o.review_text === 'string' ||
    typeof o.description === 'string';
  const hasScore =
    o.score != null || o.reviewScore != null || o.ratingValue != null || o.metascore != null;
  // Require an outlet-ish field plus at least one of text/score: a bare
  // `{score: 90}` object appears in aggregate/score-breakdown nodes too.
  return hasOutlet && (hasBody || hasScore);
}

function normaliseJsonReview(o: Record<string, unknown>): ParsedMediaReview | null {
  if (!looksLikeReview(o)) return null;

  const outlet =
    firstString(o.publicationName, o.publication, o.outlet) ??
    (typeof o.publisher === 'object' && o.publisher !== null
      ? firstString((o.publisher as Record<string, unknown>).name)
      : firstString(o.publisher)) ??
    firstString(o.author, o.criticName);
  if (!outlet) return null;

  const text = firstString(o.quote, o.reviewBody, o.body, o.review_text, o.description);

  const score =
    clampScore(o.score) ??
    clampScore(o.reviewScore) ??
    (typeof o.reviewRating === 'object' && o.reviewRating !== null
      ? clampScore((o.reviewRating as Record<string, unknown>).ratingValue)
      : null) ??
    clampScore(o.ratingValue) ??
    clampScore(o.metascore);

  // A node with no usable score and no text is noise, even if it carries a
  // publication name.
  //
  // Covers the RSC index artifact that real pages emit: Next.js writes objects
  // shaped like `{publicationName: "…", score: 3056}` where 3056 is a
  // serialisation index rather than a score. `clampScore` rejects it, and
  // without this guard the node still produced a review card showing 3056.
  if (score == null && !text) return null;

  const verdict = normaliseVerdict(firstString(o.verdict, o.reviewVerdict, o.sentiment));

  const url = resolveMaybe(o.url, o.reviewUrl, o.link);

  return {
    outlet: cleanText(outlet)!,
    score,
    text: truncate(cleanText(text)),
    verdict,
    url,
    author: cleanText(firstString(o.author, o.criticName)),
    platform:
      normalisePlatform(firstString(o.platform, o.platformName)) ??
      normalisePlatform(
        typeof o.platform === 'object' && o.platform !== null
          ? firstString((o.platform as Record<string, unknown>).name)
          : null,
      ),
    publishedAt: normaliseDate(firstString(o.datePublished, o.publishedDate, o.date, o.reviewDate)),
  };
}

/**
 * DOM fallback.
 *
 * The hard part is not finding review *blocks*, it is refusing to see reviews
 * where there are none. A naive `[class*="review"]` sweep matches:
 *   - the wrapper element around the whole review list;
 *   - the filter dropdown (`class="...review-filters"`) holding "All"/"PC";
 *   - a verdict summary block (`class="c-review-verdict-summary"`);
 *   - on a 404/blocked page, the header/footer navigation.
 * Measured against the fixtures, that produced 1 bogus "review" (outlet taken
 * from a nav link) and missed all three real ones.
 *
 * So a candidate container must prove itself structurally:
 *   1. it must NOT contain many other review-ish descendants (that makes it a
 *      wrapper, not a single review);
 *   2. it must carry an element *dedicated* to the publication — a link whose
 *      href contains "critic" or "publication", or an outlet/critic-name class.
 *      A bare anchor is not evidence, which is what excludes site navigation;
 *   3. it must carry a dedicated quote/body element OR a score badge.
 *
 * Every field stays optional: Metacritic renames these blocks periodically, and a
 * review missing its score is still worth showing.
 */
export function parseReviewsFromDom(html: string): ParsedMediaReview[] {
  const $ = cheerio.load(html);
  const out: ParsedMediaReview[] = [];

  const seen = new Set<string>();
  const push = (review: ParsedMediaReview | null) => {
    if (!review) return;
    const key = `${review.outlet.toLowerCase()}|${review.score ?? ''}|${review.url ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(review);
  };

  const OUTLET_SEL = [
    'a[href*="/critic/"]',
    'a[href*="/publication/"]',
    '[data-testid*="publication"]',
    '[class*="publication"]',
    '[class*="critic-name"]',
    '[class*="criticName"]',
    '[class*="criticname"]',
    // Deliberately NOT a bare '[class*="critic"]': that also matches container
    // modifiers such as `c-critic-reviews`, whose *text* is the empty-state
    // sentence "No critic reviews have been published yet." — which then parsed
    // as a publication literally named after that sentence.
    '[class*="outlet"]',
  ].join(',');

  const TEXT_SEL = [
    '[data-testid*="quote"]',
    '[class*="review-quote"]',
    '[class*="reviewQuote"]',
    '[class*="review-quote"]',
    '[class*="quote"]',
    'blockquote',
  ].join(',');

  const SCORE_SEL = [
    '[data-testid*="score"]',
    // CSS attribute matching is case-sensitive, and the current site class is
    // `c-siteReviewScore` (capital S) — `[class*="score"]` alone missed it, which
    // is why a live parse reported `score: null` for a card that visibly shows
    // "100". Both spellings, plus the accessible labels, are accepted.
    '[class*="score"]',
    '[class*="Score"]',
    '[data-testid*="Score"]',
    '[title*="Metascore"]',
    '[aria-label*="Metascore"]',
  ].join(',');

  const containers = $(
    [
      '[data-testid="critic-review"]',
      '[data-testid*="criticReview"]',
      // Current (Nuxt) markup: one `data-testid="review-card"` element per review,
      // on both the game page and the `/critic-reviews/` listing.
      '[data-testid="review-card"]',
      '[data-testid*="review-card"]',
      '[class*="criticReview"]',
      '[class*="critic-review"]',
      // Generic fallbacks for renamed markup.
      '[class*="c-site-review"]',
      '[class*="review-card"]',
      '[class*="reviewCard"]',
      '[class*="review"]',
      '[class*="Review"]',
    ].join(','),
  );

  /**
   * Decide whether one element is a single review card.
   *
   * Counting review-ish descendants does NOT work, and this is the trap the
   * previous attempt fell into: a real card's own inner spans carry
   * `*__score` / `*__quote` classes, so a genuine card and the wrapper around
   * three cards both look "busy". Counting made the wrapper win and the cards
   * lose, which is how a 3-review page parsed to 1.
   *
   * Instead a card must present the two marks *together*: a publication element
   * AND a score badge or quote element. A wrapper never has a single outlet +
   * score pair of its own, and a filter dropdown has a score-less, outlet-less
   * body — so both are rejected on evidence rather than on a heuristic.
   */
  const consider = (el: unknown) => {
    const node = $(el as never);

    const outletNode = node.find(OUTLET_SEL).first();
    // The outlet anchor can *contain* the score badge — the current Nuxt header
    // link does (`<a data-testid="review-card-header">… <div class="c-siteReviewScore">
    // 100</div> Cultura Geek</a>`) — and a plain `text()` would then read
    // "100 Cultura Geek". Stripping the badge from a *copy* keeps the name clean
    // while still reading `href` off the original element below.
    const outletOnly = outletNode.clone();
    outletOnly.find(SCORE_SEL).remove();
    const outlet = cleanText(firstString(outletOnly.text(), node.find('h4, h3').first().text()));

    const scoreRaw = firstString(
      node.find(SCORE_SEL).first().text(),
      node.find('[class*="score"]').first().text(),
    );
    const score = scoreFromText(cleanText(scoreRaw));

    const textRaw = firstString(
      node.find(TEXT_SEL).first().text(),
      node.find('[class*="quote"]').first().text(),
      node.find('div[class*="body"], p').first().text(),
    );
    const text = truncate(cleanText(textRaw));

    if (!outlet) return;
    // Both marks required, so filters/nav/wrappers cannot qualify.
    if (score == null && !node.find(SCORE_SEL).length && !text) return;
    if (score == null && !text) return;
    // A card cannot claim to be one review while pointing at many publications.
    if (node.find(OUTLET_SEL).length > 2) return;

    // 「查看原文」 has to point at the outlet's own article. The current markup gives
    // it a dedicated anchor (`data-testid="review-full-review-link"`, an off-site
    // URL); the outlet anchor sitting right next to it points at the publication
    // page on Metacritic, so it stays as the fallback for older markup.
    const fullReviewHref = node
      .find(
        [
          '[data-testid*="full-review"]',
          '[data-testid*="fullReview"]',
          '[class*="full-review"]',
          '[class*="readFullReview"]',
          '[class*="read-review"]',
        ].join(','),
      )
      .first()
      .attr('href');
    const href =
      fullReviewHref ??
      outletNode.attr('href') ??
      node.find('a[href*="/review/"]').first().attr('href');

    push({
      outlet,
      score,
      text,
      verdict: normaliseVerdict(
        firstString(node.find('[class*="verdict"], [class*="sentiment"]').first().text()),
      ),
      url: href ? absolutise(href) : null,
      author: cleanText(node.find('[rel="author"], [class*="author"]').first().text()),
      platform: normalisePlatform(node.find('[class*="platform"]').first().text()),
      publishedAt: normaliseDate(
        firstString(
          node.find('time').attr('datetime'),
          node.find('time').first().text(),
          // The Nuxt card prints the date in a plain div — no `<time>` element —
          // so the date has to be read by testid/class as well.
          node.find('[data-testid*="date"]').first().text(),
          node.find('[class*="review-date"], [class*="reviewDate"]').first().text(),
        ),
      ),
    });
  };

  containers.each((_, el) => consider(el));

  return out.filter((r) => isPlausibleOutlet(r.outlet));
}

/**
 * Extract reviews from a full game page — the entry point both the provider and
 * the standalone crawler use.
 *
 * Strategy order matters:
 *   1. `__NEXT_DATA__` — most reliable when present, but it frequently omits the
 *      review excerpt;
 *   2. JSON-LD — stable field names, sometimes carries `review[]`;
 *   3. the rendered DOM — the only source that reliably has the excerpt text.
 *
 * All three always run, then `dedupeReviews` merges by outlet+score so a review
 * that JSON gave a score for and the DOM gave text for becomes one complete
 * card. Running only the first strategy that matched is what left review text
 * empty on pages whose `__NEXT_DATA__` had scores but no quotes.
 */
/**
 * Discover the pagination of a critic-reviews listing.
 *
 * Why this exists: a game page carries only the first slice of its critic
 * reviews. 「宇宙机器人」has 65 publications on Metacritic, and the landing page
 * shows a handful — the rest live behind `?page=2`, `?page=3`, … Without
 * following those links the 「媒体评价」 tab can never show more than the first
 * page, which is exactly the reported "65 家媒体却只抓到 1 条".
 *
 * The parser stays deliberately dumb: it reports every `?page=N` link it can see
 * plus any `rel="next"`. The caller knows which page it just fetched, so it —
 * not the parser — decides what "forward" means. That split is what keeps this
 * function pure and trivially testable.
 */
export function parseReviewsPagination(html: string): ReviewsPageLinks {
  const result: ReviewsPageLinks = { next: null, last: 0, current: 0 };
  if (!html || typeof html !== 'string') return result;

  const $ = cheerio.load(html);

  /** page number from a href like "/game/x/critic-reviews/?page=3". */
  const pageOf = (href: string): number | null => {
    const m = /[?&]page=(\d+)/i.exec(href);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  // Every numbered pager link, smallest forward-most first.
  const numbered: { page: number; href: string }[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const page = pageOf(href);
    if (page == null) return;
    numbered.push({ page, href });
    if (page > result.last) result.last = page;
  });
  numbered.sort((a, b) => a.page - b.page);
  // The pager always lists page 1; `next` is refined by the caller using the
  // page it actually fetched. Reporting the lowest link is the useful default.
  result.next = numbered[0]?.href ?? null;

  // `rel="next"` is authoritative when present — it beats any guess.
  const relNext = $('a[rel="next"][href], link[rel="next"][href]').first().attr('href');
  if (relNext) result.next = relNext;

  // Text-labelled fallback ("Next", "下一页", "›") for skins that paginate
  // without a query string. Restricted to pager-looking anchors so a "next game"
  // link cannot be mistaken for a next page.
  if (!result.next) {
    const labelled = $('a[href]').filter((_, el) => {
      const label = ($(el).text() || '').replace(/\s+/g, ' ').trim();
      const aria = $(el).attr('aria-label') ?? '';
      return /^(next|next page|下一页|下页|›|»|→)$/i.test(label) || /next page/i.test(aria);
    });
    result.next = labelled.first().attr('href') ?? null;
  }

  return result;
}

/**
 * Decide the next URL to fetch, or `null` to stop.
 *
 * `currentPage` is the 1-based page the caller just parsed. The only rule is
 * **the page number must move forward**:
 *
 *   - a pager link to `?page=N` with N <= current is a back-link (the numbered
 *     pager always lists earlier pages, and a single-page game links to its own
 *     `page=1`), so it stops the walk instead of looping;
 *   - a link with no page number at all is a one-shot "next" anchor — allowed,
 *     and the caller's seen-URL set prevents revisiting it.
 *
 * An earlier version also compared the two URLs with the `page` parameter
 * stripped, meaning to catch "a pager that links back to itself". That was wrong
 * and killed every walk: `?page=2` and `?page=3` strip to the *same* listing URL,
 * so page 2 was judged to be pointing at itself and the crawl stopped after one
 * page — reproducing exactly the bug it was written to prevent. The page-number
 * comparison alone is both simpler and correct.
 */
export function nextReviewsPageUrl(
  links: ReviewsPageLinks,
  _currentUrl: string,
  currentPage: number,
  base?: string,
): string | null {
  if (!links.next) return null;
  const absolute = absolutise(links.next, base);
  const target = pageOfUrl(absolute);
  if (target != null && target <= currentPage) return null;
  return absolute;
}

function pageOfUrl(url: string): number | null {
  const m = /[?&]page=(\d+)/i.exec(url);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Public alias: the 1-based page number embedded in a listing URL, if any. */
export function pageOfUrlIn(url: string): number | null {
  return pageOfUrl(url);
}

export function parseMediaReviews(html: string): ParsedMediaReview[] {
  if (!html || typeof html !== 'string') return [];

  const collected: ParsedMediaReview[] = [];

  // 1. __NEXT_DATA__ (Next.js hydration payload).
  const nextData = extractScriptJson(
    html,
    /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
  );
  if (nextData) collected.push(...reviewsFromJson(nextData));

  // 2. JSON-LD (`Review` / `aggregateRating` neighbourhoods).
  for (const match of html.matchAll(
    /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      collected.push(...reviewsFromJson(JSON.parse(match[1])));
    } catch {
      /* malformed JSON-LD is common; ignore */
    }
  }

  // 3. Rendered DOM.
  collected.push(...parseReviewsFromDom(html));

  return dedupeReviews(collected).slice(0, MAX_REVIEWS);
}

function extractScriptJson(html: string, pattern: RegExp): unknown | null {
  const m = pattern.exec(html);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    // `__NEXT_DATA__` escapes `</script>` inside strings; a light repair is
    // usually enough to recover the payload.
    try {
      return JSON.parse(m[1].replace(/\\"/g, '"').replace(/\\u003c/gi, '<'));
    } catch {
      return null;
    }
  }
}

/**
 * Merge duplicates: JSON strategies give the score but rarely the text, the DOM
 * gives the text but sometimes not the score. Filling in from the other source
 * is what makes a complete card.
 */
export function dedupeReviews(list: ParsedMediaReview[]): ParsedMediaReview[] {
  const byKey = new Map<string, ParsedMediaReview>();
  for (const r of list) {
    if (!isPlausibleOutlet(r.outlet)) continue;
    const key = `${r.outlet.toLowerCase().replace(/\s+/g, ' ')}|${r.score ?? ''}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, r);
      continue;
    }
    byKey.set(key, {
      outlet: existing.outlet.length >= r.outlet.length ? existing.outlet : r.outlet,
      score: existing.score ?? r.score,
      // Prefer the longer excerpt — that is the one that did not get truncated
      // by a nested container being matched first.
      text: longer(existing.text, r.text),
      verdict: existing.verdict ?? r.verdict,
      url: existing.url ?? r.url,
      author: existing.author ?? r.author,
      platform: existing.platform ?? r.platform,
      publishedAt: existing.publishedAt ?? r.publishedAt,
    });
  }
  return [...byKey.values()];
}

function longer(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a.length >= b.length ? a : b;
}

/** Reject headings, filter labels and stray single words picked up by the DOM walk. */
export function isPlausibleOutlet(raw: string | null | undefined): boolean {
  const name = cleanText(raw);
  if (!name) return false;
  if (name.length < 2 || name.length > 60) return false;
  if (NON_OUTLETS.has(name.toLowerCase())) return false;
  // Must contain a letter (rejects "90", "—", "•••").
  if (!/[a-z\u4e00-\u9fff]/i.test(name)) return false;

  // A publication name is a short label, never a sentence.
  //
  // Second line of defence behind the selector list: when a container's text is
  // swept up by a loose match, what arrives here looks like
  // "No critic reviews have been published yet." — a whole sentence with
  // punctuation. Real names ("IGN", "Nintendo Life", "PlayStation Universe",
  // "RPG Site") stay well under 40 characters.
  if (name.length > 40) return false;
  if (/[.!?。！？]\s|\s[.!?。！？]$/.test(name)) return false;
  // Empty-state phrasings, should a selector ever surface them verbatim.
  if (/^(no|there are no)\b/i.test(name) && /review|critic|rating|score/i.test(name)) return false;
  if (/\bbe the first\b|\bhave been published\b|\bnot yet\b/i.test(name)) return false;

  return true;
}

export function cleanText(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length ? s : null;
}

function truncate(text: string | null, max = MAX_TEXT): string | null {
  if (!text) return null;
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** Score from free text: "90", "9.0/10", "85 out of 100" → 0–100 integer. */
export function scoreFromText(raw: string | null | undefined): number | null {
  const s = cleanText(raw);
  if (!s) return null;

  // "8.4/10" style first — a 0–10 score must be scaled, not read as 8/100.
  const outOfTen = /(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*10\b/i.exec(s);
  if (outOfTen) {
    const v = Number(outOfTen[1]);
    if (Number.isFinite(v) && v >= 0 && v <= 10) return Math.round(v * 10);
  }

  const outOfHundred = /(\d{1,3})\s*(?:\/|out of)\s*100\b/i.exec(s);
  if (outOfHundred) return clampScore(outOfHundred[1]);

  // A bare 0–100 integer (the usual Metascore badge).
  const bare = /(?<!\d)(\d{1,3})(?!\d)/.exec(s);
  if (bare) return clampScore(bare[1]);

  return null;
}

/** Accept only a plausible Metacritic score. Rejects RSC column indices. */
export function clampScore(raw: unknown): number | null {
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw).replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 100) return null;
  // 0 is not a real Metascore; treat it as absent rather than a floor score.
  return n === 0 ? null : Math.round(n);
}

export function normaliseVerdict(raw: string | null | undefined): string | null {
  const s = cleanText(raw);
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower.includes('universal acclaim')) return 'Universal acclaim';
  if (lower.includes('generally favorable') || lower.includes('generally favourable')) {
    return 'Generally favorable';
  }
  if (lower.includes('mixed') || lower.includes('average')) return 'Mixed';
  if (lower.includes('generally unfavorable') || lower.includes('generally unfavourable')) {
    return 'Generally unfavorable';
  }
  if (lower.includes('overwhelming dislike')) return 'Overwhelming dislike';
  if (/\bpositive\b/.test(lower)) return 'Positive';
  if (/\bnegative\b/.test(lower)) return 'Negative';
  if (/\bmixed\b/.test(lower)) return 'Mixed';
  return s.length <= 24 ? s : null;
}

/** "Nov 12, 2020" / "12 November 2020" / ISO → ISO date (date part only). */
export function normaliseDate(raw: string | null | undefined): string | null {
  const s = cleanText(raw);
  if (!s) return null;

  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const mdy = /([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s);
  const dmy = /(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/.exec(s);

  let month: number | undefined;
  let day: number | undefined;
  let year: number | undefined;

  if (mdy) {
    month = MONTHS[mdy[1].toLowerCase()];
    day = Number(mdy[2]);
    year = Number(mdy[3]);
  } else if (dmy) {
    month = MONTHS[dmy[2].toLowerCase()];
    day = Number(dmy[1]);
    year = Number(dmy[3]);
  }
  if (!month || !day || !year) return null;
  if (day < 1 || day > 31 || year < 1970 || year > 2100) return null;

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Collapse Metacritic's platform labels to a canonical short form. */
export function normalisePlatform(raw: string | null | undefined): string | null {
  const s = cleanText(raw);
  if (!s) return null;
  const lower = s.toLowerCase();
  if (/\bps5\b|playstation 5/.test(lower)) return 'PS5';
  if (/\bps4\b|playstation 4/.test(lower)) return 'PS4';
  if (/xbox series/.test(lower)) return 'Xbox Series X|S';
  if (/xbox one/.test(lower)) return 'Xbox One';
  if (/switch 2/.test(lower)) return 'Switch 2';
  if (/switch/.test(lower)) return 'Switch';
  if (/\bpc\b|windows/.test(lower)) return 'PC';
  if (/mac/.test(lower)) return 'Mac';
  if (/ios|iphone|ipad/.test(lower)) return 'iOS';
  if (/android/.test(lower)) return 'Android';
  if (/stadia/.test(lower)) return 'Stadia';
  if (/vita/.test(lower)) return 'Vita';
  if (/wii u/.test(lower)) return 'Wii U';
  // Leave anything unexpected as-is; a guess is worse than the raw label.
  return s.length <= 24 ? s : null;
}

function resolveMaybe(...values: unknown[]): string | null {
  const raw = firstString(...values);
  return raw ? absolutise(raw) : null;
}

/**
 * Make a site-relative href absolute.
 *
 * `base` must be the origin the caller actually fetched from — NOT a hardcoded
 * metacritic.com. Hardcoding it was a real defect: the provider resolves its
 * origin from `METACRITIC_BASE_URL` so the whole fetch/parse path can be verified
 * against a local stub, but pagination links were still absolutised against the
 * live site. A stub-based test therefore either missed the paged reviews entirely
 * or silently reached out to the real Metacritic — the opposite of the isolation
 * the override exists to provide.
 */
export function absolutise(href: string, base = 'https://www.metacritic.com'): string {
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('//')) return `https:${href}`;
  const origin = base.replace(/\/+$/, '');
  return `${origin}${href.startsWith('/') ? '' : '/'}${href}`;
}