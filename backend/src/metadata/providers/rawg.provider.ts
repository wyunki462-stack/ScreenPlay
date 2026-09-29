/**
 * RAWG.io metadata provider — primary multi-platform source.
 *
 * RAWG is a comprehensive game database covering PC + PlayStation / Xbox /
 * Nintendo Switch (including exclusives) with multilingual names, cover art,
 * release info and average playtime. It needs a free API key (email sign-up,
 * no 2FA/sms) — see https://rawg.io/apidocs. When the key is missing this
 * provider disables itself and the other providers keep working.
 *
 * Networking: every request forces IPv4 (avoids ENETUNREACH on IPv6-only
 * stacks), honours an optional HTTP(S) proxy configured in Settings, has a
 * 15s timeout and retries twice before giving up.
 */

import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration';
import { GameRecognizerService } from '../../library/game-recognizer.service';
import { SettingsService } from '../../settings/settings.service';
import { titleQueryVariants } from './metacritic-aliases';
import { createIpv4Agents, parseProxyConfig } from '../../common/http/proxy-config';
import {
  MetadataFragment,
  MetadataProvider,
  ProviderMatch,
} from '../provider.interface';

/**
 * Lowercase and strip accents plus (TM)/(R)/(C) marks.
 *
 * Folding accents is essential, not cosmetic: without it "Pokémon Scarlet and
 * Violet" does not contain the word "pokemon", so a query for "Pokemon Violet"
 * matched "Violet (itch)" just as well as the correct game.
 */
function fold(raw: string): string {
  return (raw || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2122\u00ae\u00a9]/g, '')
    .toLowerCase();
}

/** Comparison key for two titles: folded, alphanumerics plus CJK only. */
function titleKey(raw: string): string {
  return fold(raw).replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

/** Significant words of a normalised query ("Pokemon Violet" -> pokemon, violet). */
function queryTokens(normalized: string): string[] {
  return fold(normalized)
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((t) => t.length >= 2);
}

/** Cap on how many candidates RAWG contributes to the manual-match dialog. */
const MAX_SEARCH_RESULTS = 10;

const API = 'https://api.rawg.io/api';
const TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2; // 2 retries on top of the initial attempt

/** Normalised search hit: the shape the ranking helpers work on. */
interface RawgItem {
  id: string;
  name: string;
  released: string | null;
  platforms: string[];
}

interface RawgSearchItem {
  id: number;
  name: string;
  released?: string | null;
  platforms?: Array<{ platform?: { name?: string } }>;
}

interface RawgSearchResp {
  results?: RawgSearchItem[];
}

interface RawgDetail {
  id: number;
  name: string;
  description?: string;
  released?: string | null;
  background_image?: string | null;
  background_image_additional?: string | null;
  playtime?: number;
  platforms?: Array<{ platform?: { name?: string } }>;
  developers?: Array<{ name?: string }>;
  publishers?: Array<{ name?: string }>;
}

interface RawgScreenshotsResp {
  results?: Array<{ image?: string }>;
}

@Injectable()
export class RawgProvider implements MetadataProvider {
  readonly name = 'rawg' as const;
  readonly cacheTtlSeconds: number;

  private readonly logger = new Logger(RawgProvider.name);
  private readonly client: AxiosInstance;

  constructor(
    config: ConfigService<AppConfig, true>,
    private readonly recognizer: GameRecognizerService,
    private readonly settings: SettingsService,
  ) {
    this.cacheTtlSeconds = config.get('cacheTtlGameSeconds', { infer: true });
    this.client = axios.create({
      timeout: TIMEOUT_MS,
      maxRedirects: 5,
      headers: {
        Accept: 'application/json',
        'User-Agent': config.get('crawlerUserAgent', { infer: true }),
      },
      ...createIpv4Agents(),
    });
  }

  get enabled(): boolean {
    return this.apiKey.length > 0;
  }

  private get apiKey(): string {
    return this.settings.getApiKeys().rawgApiKey;
  }

  async search(name: string, platform: string | null): Promise<ProviderMatch | null> {
    const { items, usedQuery } = await this.queryBest(name, platform);
    if (items.length === 0) return null;
    const ranked = this.rank(usedQuery, items);
    return this.toMatch(ranked[0]);
  }

  /**
   * Every plausible match for the manual-match dialog, best first.
   *
   * `search()` returns a single guess; when that guess is wrong the user had
   * nothing else to pick, which is what made Nintendo titles hard to match.
   */
  async searchAll(name: string, platform: string | null): Promise<ProviderMatch[]> {
    const { items, usedQuery } = await this.queryBest(
      name,
      platform,
      MAX_SEARCH_RESULTS,
    );
    if (items.length === 0) return [];
    return this.rank(usedQuery, items).slice(0, MAX_SEARCH_RESULTS).map((i) => this.toMatch(i));
  }

  /**
   * Rank RAWG results, independently of the order the API happened to return.
   *
   * RAWG's relevance order is not reliable for this job and is not even stable
   * between calls: the same "Pokemon Violet" query returned "Pokemon Scarlet and
   * Violet" first on one request and "Violet (itch)" first on the next. The local
   * fuzzy matcher is no better — it scored "Pokemon Colosseum" highest (0.52) and
   * discarded the correct hit entirely.
   *
   * So nothing is trusted blindly. A title is scored by how much of the QUERY it
   * actually accounts for: exact match first, then containment, then the share of
   * significant query words present in the title. For "Pokemon Violet" that gives
   * "Pokemon Scarlet and Violet" a perfect word score while "Violet (itch)" only
   * accounts for one of the two words. RAWG's own order is kept as the final
   * tie-break, and the fuzzy score as a weak signal before it.
   */
  private rank(query: string, items: RawgItem[]): RawgItem[] {
    const fuzzy = this.recognizer.fuzzyMatch(query, items, (i) => i.name);
    const wanted = titleKey(this.recognizer.normalize(query));
    const tokens = queryTokens(this.recognizer.normalize(query));

    const score = (item: RawgItem): number => {
      const norm = fold(this.recognizer.normalize(item.name));
      const k = titleKey(norm);
      if (k && k === wanted) return 5;

      // Word coverage is the primary signal: how much of what the user typed does
      // this title actually account for?
      const covered = tokens.length
        ? tokens.filter((t) => norm.includes(t)).length / tokens.length
        : 0;

      // Containment ("base title vs subtitle/edition") is a bonus, but ONLY when
      // the shorter title is a substantial share of the longer one. Without that
      // ratio guard a six-character fragment outranked the real game:
      // normalize() reduces "Violet (itch)" to "Violet", whose key "violet" is
      // contained in "pokemonviolet", so it scored as a containment match and beat
      // "Pokemon Scarlet and Violet" — the exact game the user asked for.
      const shorter = Math.min(k.length, wanted.length);
      const longer = Math.max(k.length, wanted.length);
      const contained =
        shorter >= 6 &&
        longer > 0 &&
        shorter / longer >= 0.6 &&
        (k.includes(wanted) || wanted.includes(k));

      return contained ? 4 : Math.round(covered * 3);
    };

    return items
      .map((item, idx) => ({
        item,
        idx,
        s: score(item),
        f: item === fuzzy.item ? fuzzy.score : 0,
      }))
      .sort((a, b) => b.s - a.s || b.f - a.f || a.idx - b.idx)
      .map((x) => x.item);
  }

  /** Fetch (and normalise) RAWG search hits, trying the title variants in order. */
  private async queryBest(
    name: string,
    _platform: string | null,
    pageSize = 10,
  ): Promise<{ items: RawgItem[]; usedQuery: string }> {
    // RAWG ranks by text similarity over Latin titles, so a pure-CJK query
    // returns unrelated games ("命运2" -> "Fateline(命运线)"). Try the alias
    // variants first and only fall back to the raw title, so a Chinese-named
    // library still binds to the right entry.
    let usedQuery = name;
    for (const q of titleQueryVariants(name)) {
      const data = await this.request<RawgSearchResp>('/games', {
        key: this.apiKey,
        search: q,
        search_precise: true,
        page_size: pageSize,
      });
      const hits = data?.results ?? [];
      if (hits.length) {
        usedQuery = q;
        return {
          usedQuery,
          items: hits.map((r) => ({
            id: String(r.id),
            name: r.name,
            released: r.released ?? null,
            platforms: (r.platforms ?? [])
              .map((p) => p.platform?.name)
              .filter((n): n is string => !!n),
          })),
        };
      }
    }
    return { items: [], usedQuery };
  }

  private toMatch(item: RawgItem): ProviderMatch {
    return {
      externalId: item.id,
      name: item.name,
      platform: item.platforms[0] ?? null,
      releaseYear: item.released ? yearOf(item.released) : null,
    };
  }

  async fetch(match: ProviderMatch): Promise<MetadataFragment> {
    const fragment: MetadataFragment = {};

    const detail = await this.request<RawgDetail>(`/games/${match.externalId}`, {
      key: this.apiKey,
    });
    if (detail) {
      // Authoritative title — lets a manual match rename the game to the
      // matched entity instead of keeping the previous (wrong) name.
      if (detail.name) fragment.canonicalName = detail.name;
      fragment.summary = detail.description ? stripHtml(detail.description) : null;
      fragment.developers = (detail.developers ?? [])
        .map((d) => d.name)
        .filter((n): n is string => !!n);
      fragment.publishers = (detail.publishers ?? [])
        .map((p) => p.name)
        .filter((n): n is string => !!n);
      fragment.platforms = (detail.platforms ?? [])
        .map((p) => p.platform?.name)
        .filter((n): n is string => !!n);
      fragment.releaseDate = detail.released ?? null;
      fragment.poster =
        detail.background_image || detail.background_image_additional || null;
      if (typeof detail.playtime === 'number' && detail.playtime > 0) {
        fragment.mainStoryHours = detail.playtime;
        // Marked as the weaker duration source: this is the average playtime
        // across all players, not HLTB's measured main-story completion time.
        fragment.durationSource = 'rawg';
      }
    }

    // Screenshots (best effort; the carousel degrades gracefully without them).
    const shots = await this.request<RawgScreenshotsResp>(
      `/games/${match.externalId}/screenshots`,
      { key: this.apiKey },
    );
    const images = (shots?.results ?? [])
      .map((s) => s.image)
      .filter((u): u is string => !!u);
    if (images.length) fragment.screenshots = images;

    return fragment;
  }

  /**
   * GET with IPv4 + optional proxy + 15s timeout + 2 retries. Returns null on
   * total failure so the aggregator can fall back to the next provider.
   */
  private async request<T>(
    path: string,
    params: Record<string, unknown>,
  ): Promise<T | null> {
    const proxy = parseProxyConfig(this.settings.getApiKeys().rawgProxy);
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await this.client.get<T>(API + path, { params, proxy });
        return res.data;
      } catch (err) {
        this.logger.warn(
          `RAWG ${path} failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${
            (err as Error)?.message
          }`,
        );
        if (attempt >= MAX_RETRIES) return null;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    return null;
  }
}

function yearOf(iso: string): number | null {
  const m = /^(\d{4})/.exec(iso);
  return m ? Number(m[1]) : null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/(\s*\n\s*)+/g, '\n')
    .trim();
}