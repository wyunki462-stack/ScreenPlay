/**
 * Metacritic metadata provider — HTML scraping.
 *
 * Metacritic has no free official API, so we parse the public search and game
 * pages with cheerio. The known-fragile markup is wrapped in defensive parsing:
 * every missing field simply degrades to null. Requests respect the global rate
 * limiter (>= 1s interval) and the site's robots.txt spirit (personal use).
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as cheerio from 'cheerio';
import { AppConfig } from '../../config/configuration';
import { HttpService } from '../../common/http/http.service';
import { createIpv4Agents, parseProxyConfig } from '../../common/http/proxy-config';
import { isTransientNetworkError } from '../../common/http/proxy-config';
import { SettingsService } from '../../settings/settings.service';
import { GameRecognizerService } from '../../library/game-recognizer.service';
import { MetadataProvider, MetadataFragment, ProviderMatch, RatingData } from '../provider.interface';
import {
  MAX_REVIEWS,
  dedupeReviews,
  nextReviewsPageUrl,
  pageOfUrlIn,
  parseMediaReviews,
  parseReviewsPagination,
} from './metacritic-reviews';
import type { ParsedMediaReview } from './metacritic-reviews';
import { latinFragment, resolveMetacriticAlias } from './metacritic-aliases';

/**
 * Site origin, overridable so the fetch/parse/store path can be verified against
 * a local stub instead of the live site — which matters here because the real
 * Metacritic is rate-limited and (from a datacenter IP) often unreachable, so
 * "the parser is right" cannot be proven by pointing tests at it.
 *
 * Same reasoning as `HLTB_BASE_URL`: nothing in the app sets this, so the default
 * is always the live site.
 */
const MC_ORIGIN = (process.env.METACRITIC_BASE_URL || 'https://www.metacritic.com').replace(
  /\/+$/,
  '',
);
const SEARCH = `${MC_ORIGIN}/search/`;
const GAME = `${MC_ORIGIN}/game/`;
const TIMEOUT_MS = 20_000;
const MAX_RETRIES = 3;

/**
 * Upper bound on how many review-listing pages one refresh may walk.
 *
 * A game with 65 publications needs ~5 pages at the site's page size; 20 leaves
 * generous headroom while keeping a pathological/mis-detected pager from turning
 * one game's refresh into hundreds of requests against a rate-limited site.
 */
const MAX_REVIEW_PAGES = 20;

/** Politeness gap between review-page requests (the site rate-limits). */
const REVIEW_PAGE_DELAY_MS = 350;

/**
 * Fuzzy-score floor below which a candidate is rejected unless one title
 * demonstrably contains the other (see `searchOnce`).
 */
const LOW_CONFIDENCE = 0.6;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Metacritic's search path is a slug, not a query string, so a title with no
 * Latin characters collapses to an empty slug and the request lands on
 * `/search//` — which returns either nothing or a page of unrelated games.
 * That silent failure is why almost no game ever got a Metascore.
 */
function toSlug(raw: string): string {
  return (raw || '')
    .toLowerCase()
    .normalize('NFKD')
    // Drop combining accents so "Yōtei" → "yotei".
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}


/**
 * Comparison key for two titles: lowercase, alphanumeric only, edition noise
 * and ™/®/© marks removed. Makes "Bloodborne™ The Old Hunters Edition"
 * comparable to "Bloodborne: The Old Hunters".
 */
function titleKey(raw: string): string {
  return (raw || '')
    .toLowerCase()
    .replace(/[\u2122\u00ae\u00a9]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

/** Platform priority: PC first, then the biggest consoles. */
const PLATFORM_PRIORITY = ['pc', 'playstation-5', 'playstation-4', 'xbox-series-x', 'xbox-one', 'switch'];

/**
 * Metacritic link shapes seen in the wild:
 *
 *   current : /game/<slug>/                      (since the 2024 redesign)
 *   legacy  : /game/<platform>/<slug>/           (pre-redesign; still emitted
 *                                                 for some navigational links)
 *
 * The previous implementation only accepted the legacy shape, so search()
 * silently returned null for every game and no Metascore was ever persisted.
 */
/** One candidate link scraped off a search page. */
interface SearchEntry {
  href: string;
  name: string;
  platform: string;
  /**
   * Values printed on the result card itself. The manual rating picker needs a
   * score per platform, and sourcing it here avoids one page fetch per candidate.
   */
  metascore: number | null;
  releaseDate: string | null;
}

/** Cap on how many candidates one provider contributes to the match dialog. */
const MAX_SEARCH_RESULTS = 8;

const SLUG_RE = /^\/game\/([a-z0-9][a-z0-9-]*)\/?$/i;
const LEGACY_RE = /^\/game\/((?:pc|playstation-5|playstation-4|xbox-series-x|xbox-one|switch|nintendo-switch))\/([^/]+)\/?$/i;

@Injectable()
export class MetacriticProvider implements MetadataProvider {
  readonly name = 'metacritic' as const;
  readonly enabled = true;
  readonly cacheTtlSeconds: number; // rating tier (7d)

  private readonly logger = new Logger(MetacriticProvider.name);

  constructor(
    config: ConfigService<AppConfig, true>,
    private readonly http: HttpService,
    private readonly recognizer: GameRecognizerService,
    private readonly settings: SettingsService,
  ) {
    this.cacheTtlSeconds = config.get('cacheTtlRatingSeconds', { infer: true });
  }

  /**
 * Fetch a Metacritic HTML page.
 *
 * Metacritic is unreachable from many networks (and from inside this container
 * without a proxy), so this must honour the proxy configured in Settings —
 * exactly like RawgProvider does. Using the shared HttpService alone was the
 * reason Metacritic silently returned nothing: it applies no proxy.
 */
  private async fetchHtml(url: string, params?: Record<string, unknown>): Promise<string | null> {
    const proxyUrl = this.settings.getApiKeys().rawgProxy;
    const proxy = parseProxyConfig(proxyUrl);
    const agents = createIpv4Agents();

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await this.http.getOnce<string>(url, {
          params,
          responseType: 'text',
          headers: { Accept: 'text/html' },
          ...agents,
          proxy,
          timeout: TIMEOUT_MS,
        });
        return res.data;
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        // The proxy intermittently drops the TLS handshake ("socket hang up",
        // "Client network socket disconnected before secure TLS connection was
        // established"). A fresh connection almost always succeeds, so retry
        // immediately rather than backing off — the exponential sleep here used
        // to turn one transient drop into a permanently missing score.
        const transient = isTransientNetworkError(message);
        if (attempt === MAX_RETRIES) {
          this.logger.warn(`Metacritic fetch failed for ${url}: ${message}`);
          return null;
        }
        await sleep(transient ? 150 * (attempt + 1) : 600 * 2 ** attempt);
      }
    }
    return null;
  }

  async search(name: string, platform: string | null): Promise<ProviderMatch | null> {
    const slug = toSlug(name);

    // A CJK (or otherwise non-Latin) title yields an empty or degenerate slug —
    // "宇宙机器人" → "" and "女神异闻录5皇家版" → "5". Metacritic then either
    // 404s or returns a page of unrelated games, and no score is ever stored.
    // That is why only a handful of library entries had a Metascore.
    //
    // Fix: keep the Latin part of the name when there is one, and try the
    // original text as a fallback query before giving up.
    const variants = this.searchVariants(name, slug);

    for (const variant of variants) {
      // Compare against the query we actually searched with, not the original
      // library name. For a CJK title the original ("赛博朋克 2077") can never
      // match an English catalogue entry, so passing it here rejected every
      // alias-resolved result and the search always returned null.
      const match = await this.searchOnce(variant.query, variant.slug, variant.query, platform);
      if (match) return match;
    }
    return null;
  }

  /**
   * Build the ordered list of search queries to try for a title.
   *
   * Latin titles are searched directly. Titles with a usable Latin fragment
   * (e.g. "赛博朋克 2077" → "2077", "機戰傭兵™VI 境界天火™" → "VI") are searched
   * by that fragment first, because Metacritic indexes English names. Purely
   * non-Latin titles still get a last-resort original-text attempt.
   */
  private searchVariants(
    name: string,
    slug: string,
  ): { query: string; slug: string }[] {
    const out: { query: string; slug: string }[] = [];
    const push = (query: string, s: string) => {
      const key = s.trim();
      if (!key) return;
      if (out.some((o) => o.slug === key)) return;
      out.push({ query, slug: key });
    };

    // 1) Best case: a known English title for a CJK name. Metacritic only
    //    indexes Latin titles, so this is the difference between a score and
    //    nothing for a Chinese/Japanese library.
    const alias = resolveMetacriticAlias(name);
    if (alias) push(alias, toSlug(alias));

    // 2) A distinctive Latin fragment inside an otherwise CJK title
    //    (e.g. "機戰傭兵™VI 境界天火™" → "VI" is too short, but
    //    "賽博朋克 2077" → "2077" is usable). A lone "2" or "5" is not: it
    //    matches random games far better than the intended one.
    const latin = latinFragment(name);
    if (latin && latin.length >= 4 && /\p{L}/u.test(latin)) {
      push(latin, toSlug(latin));
    }

    // 3) Last resort: the original title (works for Latin names; harmless 404
    //    for a pure-CJK name, which the alias/fragment steps above cover).
    push(name, slug);
    return out;
  }

  /** One search attempt against a single query string. */
  /**
   * Every candidate game link on a search page, de-duplicated.
   *
   * Scoped to the result cards first. A page-wide `a[href*="/game/"]` sweep also
   * collects the navigation and "featured" rails, whose links look like entries
   * (`/game/pc/all/` even matches the legacy shape) and used to be ranked in as
   * candidates — which is how a search for a Nintendo title could offer an
   * unrelated PC game as its best match.
   */
  private collectEntries(html: string): SearchEntry[] {
    const $ = cheerio.load(html);
    const entries: SearchEntry[] = [];

    const scoped = $(
      'a.c-search-item[href*="/game/"], [data-testid="search-item"] a[href*="/game/"]',
    );
    const anchors = scoped.length ? scoped : $('a[href*="/game/"]');

    anchors.each((_, el) => {
      const href = ($(el).attr('href') ?? '').split('?')[0].split('#')[0];

      // The anchor's own text concatenates title + type + date + platforms +
      // score (e.g. "HadesgameSep 17, 2020PC, and more93"), which wrecked fuzzy
      // matching. The real title lives in a dedicated <p> inside the card.
      const title = ($(el).find('p').first().text() || '').replace(/\s+/g, ' ').trim();
      const fallback = ($(el).text() || '').replace(/\s+/g, ' ').trim();
      const text = title || fallback;
      if (!text || text.length > 80) return;

      // Score: Metacritic prints "Metascore 93 out of 100" in the badge's title.
      const badge = $(el).find('.c-search-item__score [title*="Metascore"]').first();
      const badgeTitle = badge.attr('title') ?? badge.attr('aria-label') ?? '';
      const scoreMatch = /Metascore\s+(\d+)\s+out of\s+100/i.exec(badgeTitle);
      const scopedScore = scoreMatch
        ? Number(scoreMatch[1])
        : numberOrNull($(el).find('.c-search-item__score span').first().text());

      // Release date and platform share a list; the date item is classed.
      const dateText =
        $(el).find('li.c-search-product-meta__release-date span').first().text() ||
        '';
      const platformText =
        $(el)
          .find('li.c-search-product-meta__list-item')
          .not('.c-search-product-meta__release-date')
          .first()
          .find('strong')
          .first()
          .text() || '';

      const legacy = LEGACY_RE.exec(href);
      const entry: SearchEntry = {
        href,
        name: text,
        platform: legacy ? legacy[1] : platformText,
        metascore: scopedScore,
        releaseDate: dateText.replace(/\s+/g, ' ').trim() || null,
      };
      if (legacy) {
        entries.push(entry);
        return;
      }
      if (SLUG_RE.test(href)) {
        entries.push({ ...entry, platform: platformText });
      }
    });

    return entries.filter((e, i, a) => a.findIndex((x) => x.href === e.href) === i);
  }

  /**
   * Every plausible match for the manual-match dialog, best first.
   *
   * `search()` keeps only its single best guess, so a wrong or narrow guess left
   * the user with no alternative to choose — the practical reason Nintendo
   * titles could not be matched by hand.
   */
  async searchAll(name: string, platform: string | null): Promise<ProviderMatch[]> {
    const slug = toSlug(name);
    for (const variant of this.searchVariants(name, slug)) {
      const html = await this.fetchHtml(`${SEARCH}${encodeURIComponent(variant.slug)}/`, {
        category: 13,
      });
      if (!html) continue;
      const entries = this.collectEntries(html);
      if (entries.length === 0) continue;

      // Rank the same way `searchOnce` does, but keep the whole list: an exact
      // title wins, then a containment match, then whatever the fuzzy matcher
      // liked, and platform priority breaks the remaining ties.
      const wanted = titleKey(this.recognizer.normalize(variant.query));
      const pool = entries.map((e) => ({ ...e, key: this.recognizer.normalize(e.name) }));
      const fuzzy = this.recognizer.fuzzyMatch(
        this.recognizer.normalize(variant.query),
        pool,
        (e) => e.key,
      );
      const rank = (e: { name: string; key: string }): number => {
        const k = titleKey(e.key);
        if (k && k === wanted) return 3;
        if (k.length >= 4 && wanted.length >= 2 && (k.includes(wanted) || wanted.includes(k))) {
          return 2;
        }
        return fuzzy.item === e ? 1 : 0;
      };
      return [...pool]
        .sort((a, b) => rank(b) - rank(a) || priority(a.platform) - priority(b.platform))
        .slice(0, MAX_SEARCH_RESULTS)
        .map((e) => ({
          externalId: slugOf(e.href),
          name: e.name,
          platform: e.platform || null,
          metascore: e.metascore,
          releaseDate: e.releaseDate,
          releaseYear: null,
        }));
    }
    return [];
  }

  private async searchOnce(
    query: string,
    slug: string,
    originalName: string,
    platform: string | null,
  ): Promise<ProviderMatch | null> {
    const html = await this.fetchHtml(`${SEARCH}${encodeURIComponent(slug)}/`, { category: 13 });
    if (!html) return null;

    const uniqEntries = this.collectEntries(html);
    if (uniqEntries.length === 0) return null;

    // Compare on an aggressively normalized key so punctuation, ™/® marks and
    // edition suffixes cannot defeat an otherwise exact match. This is what lets
    // "Bloodborne™ The Old Hunters Edition" match "Bloodborne: The Old Hunters".
    const wanted = titleKey(this.recognizer.normalize(originalName));
    const exact = uniqEntries.find((e) => titleKey(this.recognizer.normalize(e.name)) === wanted);
    if (exact) {
      return {
        externalId: slugOf(exact.href),
        name: exact.name,
        platform: exact.platform || null,
        releaseYear: null,
      };
    }

    // Otherwise the best fuzzy candidate above a sane score floor. Both sides go
    // through normalize() first so the edition/version noise is already gone and
    // a genuine sequel ("… 2") is not confused with its predecessor.
    const ordered = [...uniqEntries].sort((a, b) => priority(a.platform) - priority(b.platform));
    const pool = ordered.map((e) => ({
      ...e,
      key: this.recognizer.normalize(e.name),
    }));
    const fuzzy = this.recognizer.fuzzyMatch(this.recognizer.normalize(originalName), pool, (e) => e.key);
    const best = fuzzy.item ?? pool[0];
    if (!best) return null;

    // Confidence floor. A low fuzzy score is only acceptable when one title's
    // key actually contains the other's, which is the common "base name vs
    // subtitle/edition" case. Otherwise skipping beats binding the wrong game.
    //
    // Note the floor must apply even when fuzzy.item is null: the `?? pool[0]`
    // fallback above would otherwise accept pool[0] unchecked, which is how a
    // digits-only slug ("赛博朋克 2077" → "2077") bound an unrelated game.
    const bestKey = titleKey(best.key);
    const contains = bestKey.length >= 4 && (bestKey.includes(wanted) || wanted.includes(bestKey));
    const confidence = fuzzy.item ? fuzzy.score : 0;
    if (!contains && confidence < LOW_CONFIDENCE) {
      this.logger.warn(
        `Metacritic low-confidence match for "${originalName}" ` +
          `(best="${best.name}", score=${confidence.toFixed(2)}) — skipped`,
      );
      return null;
    }
    return {
      externalId: slugOf(best.href),
      name: best.name,
      platform: best.platform || null,
      releaseYear: null,
    };
  }

  /** The game page URL, following whichever origin this provider reads from. */
  sourceUrl(match: { externalId: string }): string {
    return `${GAME}${match.externalId}/`;
  }

  async fetch(match: ProviderMatch): Promise<MetadataFragment> {
    // externalId may be "hades" (current scheme) or "pc/hades" (legacy); both
    // resolve because Metacritic redirects the legacy form.
    const gameUrl = `${GAME}${match.externalId}/`;
    const html = await this.fetchHtml(gameUrl);
    if (!html) {
      // Throw rather than return `{}`.
      //
      // An empty fragment is indistinguishable from "the page loaded but had no
      // Metascore, with no reviews either" — and those two outcomes need opposite
      // handling: the first is a failure the user should retry, the second is the
      // final answer 「暂无媒体评价」. Throwing is what lets the caller record a
      // 'failed' state (and, crucially, keep the reviews it already has) instead
      // of silently stamping "this game has no reviews" over a populated panel.
      //
      // The metadata sweep already treats a throw as "this provider contributed
      // nothing", so rating behaviour is unchanged.
      throw new Error(`Metacritic 页面抓取失败：${gameUrl}`);
    }

    // `canonicalName` is what MetadataService.resolveMatchName() reads, and the
    // manual-match dialog always calls it before binding. Returning only a rating
    // meant resolveMatchName() always received null, so picking ANY Metacritic
    // entry failed with "无法在 metacritic 上找到该条目" — even though this very
    // page and its Metascore had been fetched successfully.
    return {
      canonicalName: this.parseTitle(html),
      rating: this.parseRating(html),
      // The landing page carries only the first slice of the critic reviews; the
      // rest are paginated. See `fetchAllMediaReviews`.
      mediaReviews: await this.fetchAllMediaReviews(html, match.externalId),
    };
  }

  /**
   * Collect **all** critic reviews for a game, following the pager.
   *
   * The landing page shows a handful of reviews (the site's own first page).
   * A game with 65 publications therefore looked like it had 1: the crawl read
   * the game page once and stopped, and the paginated listing — reachable at
   * `/game/<slug>/critic-reviews/?page=N` and linked from the page's own pager —
   * was never visited. This walks the pager until no forward link remains.
   *
   * Cost control, because Metacritic rate-limits and this runs during a refresh:
   *   - the landing page's own reviews are parsed first, so a pager failure still
   *     leaves the user with what the first page showed;
   *   - the walk is bounded by `MAX_REVIEW_PAGES`;
   *   - visited URLs are remembered, so a pager that links back to itself cannot
   *     loop;
   *   - a small delay between requests keeps the crawl polite.
   *
   * Everything merges through `dedupeReviews`, so the landing page's copy of a
   * review and the listing's copy collapse into one card instead of two.
   */
  private async fetchAllMediaReviews(html: string, externalId: string): Promise<ParsedMediaReview[]> {
    const collected: ParsedMediaReview[] = parseMediaReviews(html);

    // Where the listing lives. The landing page's own pager is preferred (that is
    // the site telling us the real URL); otherwise derive it from the slug.
    const slug = externalId.replace(/^[a-z0-9-]+\//i, ''); // drop a legacy "pc/" prefix
    const gameUrl = `${GAME}${slug}/`;

    let links = parseReviewsPagination(html);
    // No pager anywhere → the landing page is the whole set.
    if (!links.next && links.last <= 1) return dedupeReviews(collected).slice(0, MAX_REVIEWS);

    const visited = new Set<string>([gameUrl]);
    let currentUrl = gameUrl;
    let page = 0;

    while (page < MAX_REVIEW_PAGES) {
      // Resolve against THIS provider's origin, so a stubbed base URL stays
      // fully isolated instead of leaking requests to the live site.
      const nextUrl = nextReviewsPageUrl(links, currentUrl, page, MC_ORIGIN);
      if (!nextUrl || visited.has(nextUrl)) break;
      visited.add(nextUrl);

      const nextHtml = await this.fetchHtml(nextUrl);
      if (!nextHtml) break; // network gave up — keep what we already have

      const before = collected.length;
      collected.push(...parseMediaReviews(nextHtml));
      currentUrl = nextUrl;
      page = pageOfUrlIn(nextUrl) ?? page + 1;
      links = parseReviewsPagination(nextHtml);

      // A page that contributes nothing new means we have run past the end.
      if (collected.length === before && !links.next) break;
      if (page < MAX_REVIEW_PAGES) await sleep(REVIEW_PAGE_DELAY_MS);
    }

    const merged = dedupeReviews(collected).slice(0, MAX_REVIEWS);
    this.logger.log(
      `Metacritic 媒体评价：「${slug}」抓取 ${page} 页，合并后 ${merged.length} 条`,
    );
    return merged;
  }

  /**
   * Extract the game's display title from a Metacritic game page.
   *
   * Three strategies, most structured first, because the layout has changed
   * shape before. A "not found" page must not yield a title, or a bad id would
   * be bound successfully with the string "Page Not Found" as the game name.
   */
  private parseTitle(html: string): string | null {
    const $ = cheerio.load(html);

    // 1) JSON-LD VideoGame.name.
    for (const el of $('script[type="application/ld+json"]').toArray()) {
      try {
        const json = JSON.parse($(el).html() ?? '{}');
        const n = typeof json?.name === 'string' ? json.name.trim() : '';
        if (n) return n;
      } catch {
        /* ignore malformed JSON blobs */
      }
    }

    // 2) The visible hero heading.
    const hero = $('h1.hero-title__text').first().text().replace(/\s+/g, ' ').trim();
    if (hero) return hero;
    const h1 = $('h1').first().text().replace(/\s+/g, ' ').trim();
    if (h1) return h1;

    // 3) <title>Hades Reviews - Metacritic</title>.
    const t = /<title>([^<]+)<\/title>/i.exec(html)?.[1] ?? '';
    const cleaned = t
      .replace(/\s*[-–—|]\s*Metacritic\s*$/i, '')
      .replace(/\s+Reviews?\s*$/i, '')
      .trim();
    if (!cleaned || /not found|404|error/i.test(cleaned)) return null;
    return cleaned;
  }

  /** Defensive multi-strategy extraction of critic + user scores. */
  private parseRating(html: string): RatingData | null {
    let metascore: number | null = null;
    let criticCount: number | null = null;
    let userScore: number | null = null;
    let userCount: number | null = null;
    let ratingClass: string | null = null;

    const $ = cheerio.load(html);

    // 1) JSON-LD aggregateRating (most reliable when present).
    //    NOTE: Metacritic emits `reviewCount` (not `ratingCount`) for the
    //    Metascore — reading the wrong key loses the critic count entirely.
    for (const el of $('script[type="application/ld+json"]').toArray()) {
      try {
        const json = JSON.parse($(el).html() ?? '{}');
        const ar = json?.aggregateRating;
        if (ar?.ratingValue != null) {
          metascore = num(ar.ratingValue);
          criticCount = num(ar.reviewCount ?? ar.ratingCount);
        }
      } catch {
        /* ignore malformed JSON blobs */
      }
    }

    // 2) Metascore from the visible score block when JSON-LD is absent.
    if (metascore == null) {
      const m =
        /"metaScore"\s*:\s*\{[^}]*?"score"\s*:\s*(\d+(?:\.\d+)?)/.exec(html) ??
        /data-testid="[^"]*metascore[^"]*"[^>]*>\s*(\d{1,3})\s*</i.exec(html);
      if (m) metascore = num(m[1]);
    }
    if (criticCount == null) {
      const m = /"reviewCount"\s*:\s*"?(\d+)"?/.exec(html);
      if (m) criticCount = num(m[1]);
    }

    // 3) User score.
    //    The old regex `"userScore":\s*"?(\d+)"?` matched the *RSC column index*
    //    that Next.js emits (e.g. "userScore":3056), producing nonsense like
    //    a user score of 3056 on a 0–10 scale. Require a decimal-looking value
    //    in the valid 0–10 range and reject the bare-integer index form.
    const userScorePatterns: RegExp[] = [
      // Object form: "userScore":{"score":8.4,...}
      /"userScore"\s*:\s*\{[^}]*?"score"\s*:\s*(\d+(?:\.\d+)?)/,
      // Explicit positive-score field.
      /"userScore"\s*:\s*(\d+\.\d+)/,
      // Visible block, e.g. >8.4</span> next to a user-score test id.
      /data-testid="[^"]*user-score[^"]*"[^>]*>\s*(\d+(?:\.\d+)?)\s*</i,
    ];
    for (const re of userScorePatterns) {
      const m = re.exec(html);
      if (!m) continue;
      const v = num(m[1]);
      // Guard the 0–10 scale so a stray index/count can never be stored.
      if (v != null && v >= 0 && v <= 10) {
        userScore = v;
        break;
      }
    }

    if (userCount == null) {
      const m = /"userReviewCount"\s*:\s*"?(\d+)"?/.exec(html) ?? /"userCount"\s*:\s*"?(\d+)"?/.exec(html);
      if (m) userCount = num(m[1]);
    }

    // 4) Rating class like "Generally favorable" / "Universal acclaim".
    const cls =
      /"ratingClass"\s*:\s*"([^"]+)"/.exec(html) ??
      /Metascore is (?:generally|universal)[^"<]*/i.exec(html);
    if (cls) ratingClass = cls[1] ?? cls[0];

    // A Metascore alone is enough to be useful.
    if (metascore == null && userScore == null) return null;

    return {
      source: 'metacritic',
      metascore,
      criticCount,
      userScore,
      userCount,
      ratingClass,
    };
  }
}

/** Parse a loosely-typed numeric field, returning null when not finite. */
function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : null;
}

function priority(platform: string): number {
  const idx = PLATFORM_PRIORITY.indexOf(platform);
  return idx === -1 ? 99 : idx;
}

/** "/game/pc/hades/" or "/game/hades/" → "pc/hades" or "hades". */
function slugOf(href: string): string {
  return href.replace(/^\/game\//, '').replace(/\/$/, '');
}
/** Parse a digits-only score; anything else is treated as "no score". */
function numberOrNull(raw: string): number | null {
  const m = /^\s*(\d{1,3})\s*$/.exec(raw ?? '');
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}
