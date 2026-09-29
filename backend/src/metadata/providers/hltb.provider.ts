/**
 * HowLongToBeat (HLTB) metadata provider — the primary source of completion times.
 *
 * HLTB covers PC / PlayStation / Xbox / Switch alike, which is exactly what the
 * duration feature needs. Its search payload already carries the three completion
 * times (main / main+extra / completionist), so one request yields everything.
 *
 * ## Why this file looks the way it does
 *
 * HLTB put its search API behind an anti-bot gate: `POST /api/search` — the
 * endpoint this provider used to call — now answers **403 for every request**,
 * with or without a browser User-Agent, which is why durations were missing
 * across the board.
 *
 * Their own front end does this instead:
 *
 *   1. `GET  /api/search/site/init?t=<epoch-ms>` → `{ token }`
 *   2. `POST /api/search/site` with header `x-auth-token: <token>`
 *   3. on 403, fetch a fresh token and retry once ("Search token expired")
 *
 * The `t` parameter must be a real, current timestamp — a stale or dummy value
 * is rejected. The token is cached here for a few minutes, and any 403 drops it
 * immediately so the next attempt re-inits rather than looping on a dead token.
 *
 * Timing is subject to the global rate limiter and 429 backoff in HttpService.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { AxiosResponse } from 'axios';
import { HttpService } from '../../common/http/http.service';
import { GameRecognizerService } from '../../library/game-recognizer.service';
import { MetadataProvider, MetadataFragment, ProviderMatch } from '../provider.interface';
import { titleQueryVariants } from './metacritic-aliases';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration';

/**
 * Base origin for the duration lookups.
 *
 * Overridable so the retry / empty-payload behaviour can be verified for real
 * (a local stub that fails on purpose) instead of being asserted only in unit
 * tests — the same reason `STEAM_IMAGE_HOSTS` exists. Defaults to the live site;
 * nothing in the app sets this variable.
 */
const HLTB_ORIGIN = (
  process.env.HLTB_BASE_URL ||
  process.env.TROPHY_HLTB_BASE_URL ||
  'https://howlongtobeat.com'
).replace(/\/+$/, '');
const HLTB_INIT = `${HLTB_ORIGIN}/api/search/site/init`;
const HLTB_SEARCH = `${HLTB_ORIGIN}/api/search/site`;

/**
 * A browser-like User-Agent. The API gateway fronts the whole site, so the
 * provider's default crawler UA is a needless risk here.
 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** How long a search token is reused before being re-fetched. */
const TOKEN_TTL_MS = 10 * 60 * 1000;

/** Candidates returned by `searchAll()` for the manual-match list. */
const MAX_SEARCH_RESULTS = 6;

interface HltbSearchItem {
  game_id: number;
  game_name: string;
  profile_platform?: string;
  release_world?: number;
  comp_main?: number;
  comp_plus?: number;
  comp_100?: number;
  profile_dev?: string;
  profile_publishers?: string[];
  profile_platforms?: string[];
}

interface HltbSearchResult {
  data?: HltbSearchItem[];
  count?: number;
}

@Injectable()
export class HltbProvider implements MetadataProvider {
  readonly name = 'hltb' as const;
  readonly enabled = true; // public, no credentials required
  readonly cacheTtlSeconds: number;

  private readonly logger = new Logger(HltbProvider.name);

  private token: string | null = null;
  private tokenAt = 0;

  constructor(
    config: ConfigService<AppConfig, true>,
    private readonly http: HttpService,
    private readonly recognizer: GameRecognizerService,
  ) {
    this.cacheTtlSeconds = config.get('cacheTtlGameSeconds', { infer: true });
  }

  async search(name: string, platform: string | null): Promise<ProviderMatch | null> {
    const items = await this.searchItems(name);
    if (items.length === 0) return null;

    // Prefer a same-platform row, then fuzzy name similarity.
    const pool = platform
      ? items.filter((i) => i.profile_platform?.toLowerCase() === platform.toLowerCase())
      : [];
    const candidates = pool.length ? pool : items;

    const fuzzy = this.recognizer.fuzzyMatch(name, candidates, (i) => i.game_name);
    const best = fuzzy.item ?? candidates[0];
    return {
      externalId: String(best.game_id),
      name: best.game_name,
      platform: best.profile_platform ?? null,
      releaseYear: best.release_world ?? null,
    };
  }

  /**
   * Expose several HLTB rows so the manual-match dialog can offer them alongside
   * the artwork sources. HLTB contributes the completion times.
   */
  async searchAll(name: string, platform: string | null): Promise<ProviderMatch[]> {
    const items = await this.searchItems(name);
    if (items.length === 0) return [];

    // Rows that actually carry a completion time come first: an entry with no
    // timings is useless for what this source is here to provide.
    const timed = items.filter((i) => toHours(i.comp_main) != null);
    const ranked = (timed.length ? timed : items).slice(0, MAX_SEARCH_RESULTS);

    return ranked.map((i) => ({
      externalId: String(i.game_id),
      name: i.game_name,
      platform: i.profile_platform ?? platform,
      releaseYear: i.release_world ?? null,
    }));
  }

  async fetch(match: ProviderMatch): Promise<MetadataFragment> {
    // The search payload carries completion times; re-query and match by id.
    const items = await this.searchItems(match.name);
    const item = items.find((i) => String(i.game_id) === match.externalId) ?? items[0];
    if (!item) return {};

    return {
      mainStoryHours: toHours(item.comp_main),
      mainExtraHours: toHours(item.comp_plus),
      completionistHours: toHours(item.comp_100),
      durationSource: 'hltb',
      developers: item.profile_dev ? [item.profile_dev] : [],
      publishers: item.profile_publishers?.length ? item.profile_publishers : [],
      platforms: item.profile_platforms?.length ? item.profile_platforms : [],
    };
  }

  /**
   * Fetch a search token, reusing a recent one.
   *
   * The `t` query parameter is a cache-buster the site validates, so it has to be
   * the current time rather than a constant.
   */
  private async getToken(force = false): Promise<string | null> {
    if (!force && this.token && Date.now() - this.tokenAt < TOKEN_TTL_MS) {
      return this.token;
    }
    try {
      const res = await this.http.getOnce<{ token?: string }>(
        `${HLTB_INIT}?t=${Date.now()}`,
        {
          headers: {
            'User-Agent': BROWSER_UA,
            Accept: 'application/json, text/plain, */*',
            Referer: `${HLTB_ORIGIN}/`,
            Origin: HLTB_ORIGIN,
          },
        },
      );
      const token = res.data?.token;
      if (!token) {
        this.logger.warn('HLTB token endpoint returned no token; search will fail.');
        return null;
      }
      this.token = token;
      this.tokenAt = Date.now();
      return token;
    } catch (err) {
      this.logger.warn(`HLTB token fetch failed: ${(err as Error)?.message}`);
      return null;
    }
  }

  /**
   * Query strings to try, best first.
   *
   * HLTB's catalogue is Latin-only, so a Chinese folder name (「血源诅咒」,
   * 「艾尔登法环」) matches nothing at all — measured: 3 of 5 such titles return
   * zero rows, and each one returns data under its English name. The shared
   * `titleQueryVariants()` resolver supplies that English alias, and is what RAWG,
   * Steam and Metacritic already use.
   *
   * Typographic punctuation is straightened as well: HLTB has no entry for
   * "Assassin’s Creed Odyssey" (U+2019) but does for "Assassin's Creed Odyssey",
   * and the alias table stores the curly form.
   */
  private queryVariants(name: string): string[] {
    const out: string[] = [];
    const push = (raw: string) => {
      const q = straightenPunctuation(raw);
      if (q && !out.includes(q)) out.push(q);
    };
    // Latin alias first, then the original.
    for (const variant of titleQueryVariants(name)) push(variant);
    push(name);
    return out;
  }

  /**
   * Search HLTB across the query variants, stopping at the first that answers.
   *
   * Transparently handles the token gate: a 403 means the token expired or was
   * never valid, so it is dropped and the call retried with a fresh one —
   * mirroring the site's own behaviour.
   */
  private async searchItems(name: string): Promise<HltbSearchItem[]> {
    for (const variant of this.queryVariants(name)) {
      const items = await this.queryOnce(variant);
      if (items.length) return items;
    }
    return [];
  }

  /** One search request for one query string, with token handling. */
  private async queryOnce(name: string): Promise<HltbSearchItem[]> {
    const body = {
      searchType: 'games',
      searchTerms: [name],
      searchPage: 1,
      size: 20,
      searchOptions: {
        games: {
          userId: 0,
          platform: '',
          sortCategory: 'popular',
          rangeCategory: 'main',
          rangeTime: { min: 0, max: 0 },
          gameplay: { perspective: '', flow: '', genre: '', difficulty: '' },
          modifier: '',
        },
        users: { sortCategory: 'postcount' },
        filter: '',
        sort: 0,
        randomizer: 0,
      },
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = await this.getToken(attempt > 0);
      if (!token) return [];

      // `postOnce` keeps the retry loop here rather than inside HttpService: a
      // 403 needs a NEW token, which the generic retry cannot supply.
      //
      // Network/TLS failures must not escape this method. The proxy in front of
      // HLTB is intermittent, and an exception here would abort the whole
      // metadata refresh for the game rather than just leaving the duration
      // unfilled — this source is a best-effort contributor, not a hard
      // dependency.
      let res: AxiosResponse<HltbSearchResult>;
      try {
        res = await this.http.postOnce<HltbSearchResult>(HLTB_SEARCH, body, {
          headers: {
            'Content-Type': 'application/json',
            'x-auth-token': token,
            'User-Agent': BROWSER_UA,
            Referer: `${HLTB_ORIGIN}/`,
            Origin: HLTB_ORIGIN,
          },
          validateStatus: () => true,
        });
      } catch (err) {
        this.logger.warn(
          `HLTB search request failed for "${name}" (attempt ${attempt + 1}/3): ` +
            `${(err as Error)?.message}`,
        );
        continue; // transient — the retry below gets a fresh token and connection
      }

      if (res.status === 200) {
        return res.data?.data ?? [];
      }
      if (res.status === 403) {
        // Token rejected: forget it and try once more with a brand-new one.
        this.token = null;
        this.logger.warn(`HLTB search token rejected (403) for "${name}"; refetching token.`);
        continue;
      }
      if (res.status === 429) {
        this.logger.warn(`HLTB rate-limited (429) for "${name}".`);
        return [];
      }
      this.logger.warn(`HLTB search for "${name}" returned HTTP ${res.status}.`);
      return [];
    }

    this.logger.warn(`HLTB search failed for "${name}": token rejected 3 times.`);
    return [];
  }
}

/** HLTB returns durations in seconds; convert to fractional hours. */
function toHours(seconds: number | undefined): number | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  const hours = seconds / 3600;
  return hours > 0 ? Math.round(hours * 10) / 10 : null;
}

/**
 * Replace typographic punctuation with its ASCII equivalent.
 *
 * Alias-table entries are copied from store pages, so they carry curly quotes and
 * dashes; HLTB's search is literal and misses those forms entirely.
 */
function straightenPunctuation(raw: string): string {
  return (raw ?? '')
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u2033]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
