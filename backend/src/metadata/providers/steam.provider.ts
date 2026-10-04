/**
 * Steam metadata provider — Store search + Web API.
 *
 * AppID resolution uses the public store search endpoint (no key required).
 * Achievements and pricing use the official Web API (`STEAM_API_KEY`). All
 * requests flow through HttpService's rate limiter/retry.
 *
 * Note: Steam returns prices in *cents*; we normalize to currency units.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration';
import { HttpService } from '../../common/http/http.service';
import { steamAchievementIconUrl } from '../../common/image-url';
import { GameRecognizerService } from '../../library/game-recognizer.service';
import { SettingsService } from '../../settings/settings.service';
import { MetadataProvider, MetadataFragment, ProviderMatch, AchievementData } from '../provider.interface';
import { titleQueryVariants } from './metacritic-aliases';
import type { AchievementCandidate } from '../../trophies/trophy-source.interface';

const STORE_SEARCH = 'https://store.steampowered.com/api/storesearch/';
const APP_DETAILS = 'https://store.steampowered.com/api/appdetails';
const SCHEMA = 'https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/';
const GLOBAL_PCT = 'https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/';
/** Cap on add-on schemas fetched per refresh (see fetchAchievements). */
const MAX_DLC_APPS = 12;

interface StoreSearchItem {
  /**
   * Steam's storesearch endpoint returns `id` (the appid, as a number) — there
   * is no `appid` field. Reading `.appid` produced `undefined` for every result,
   * which showed up as `externalId: "undefined"` in the manual-match dialog and
   * made a Steam binding request app "undefined" and silently return nothing.
   *
   * `metascore` is also present and is used as a cheap fallback rating source.
   */
  id: number;
  name: string;
  type: string;
  metascore?: number;
}

/** One entry of `availableGameStats.achievements` in a schema response. */
interface SchemaAchievement {
  name: string;
  displayName?: string;
  description?: string;
  icon?: string;
  hidden?: number;
}

interface SchemaResp {
  game?: {
    gameName?: string;
    availableGameStats?: { achievements?: SchemaAchievement[] };
  };
}

interface PctResp {
  achievementpercentages?: { achievements?: { name: string; percent: number }[] };
}

interface AppDetailsResp {
  [appid: string]: {
    success?: boolean;
    data?: AppDetails;
  };
}

interface AppDetails {
  type?: string;
  /** Authoritative store title, present in the appdetails payload. */
  name?: string;
  short_description?: string;
  header_image?: string;
  capsule_image?: string;
  capsule_imagev5?: string;
  background?: string;
  developers?: string[];
  publishers?: string[];
  release_date?: { coming_soon?: boolean; date?: string };
  price_overview?: {
    currency?: string;
    final?: number;
    initial?: number;
    discount_percent?: number;
  };
  /** Add-on appids attached to this game, each with its own achievement schema. */
  dlc?: number[];
}

@Injectable()
export class SteamProvider implements MetadataProvider {
  readonly name = 'steam' as const;
  readonly cacheTtlSeconds: number; // achievements tier (15d)

  private readonly logger = new Logger(SteamProvider.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly http: HttpService,
    private readonly recognizer: GameRecognizerService,
    private readonly settings: SettingsService,
  ) {
    // Achievements list is cached longer than rating/price (spec: 15d).
    this.cacheTtlSeconds = config.get('cacheTtlAchievementsSeconds', { infer: true });
  }

  get enabled(): boolean {
    // Steam store search works without a key; achievements degrade gracefully.
    return true;
  }

  private get apiKey(): string {
    return this.settings.getApiKeys().steamApiKey;
  }

  async search(name: string, _platform: string | null): Promise<ProviderMatch | null> {
    // Steam's store search matches on Latin titles; a CJK term returns
    // unrelated apps (measured: "命运2" → "反转21克-下部…" instead of Destiny 2).
    // Alias variants are tried first, the raw title only as a last resort.
    let items: StoreSearchItem[] = [];
    let usedQuery = name;
    for (const q of titleQueryVariants(name)) {
      const res = await this.http
        .get<{ items?: StoreSearchItem[] }>(STORE_SEARCH, {
          params: { term: q, l: 'en', cc: 'us' },
        })
        .catch((err) => {
          this.logger.warn(`Steam search failed for "${q}": ${(err as Error)?.message}`);
          return null;
        });
      const hits = (res?.data?.items ?? []).filter(
        (i) => i.type === 'app' && Number.isFinite(i.id),
      );
      if (hits.length) {
        items = hits;
        usedQuery = q;
        break;
      }
    }
    if (items.length === 0) return null;

    const fuzzy = this.recognizer.fuzzyMatch(usedQuery, items, (i) => i.name);
    const best = fuzzy.item ?? items[0];
    return { externalId: String(best.id), name: best.name, platform: 'PC', releaseYear: null };
  }

  /**
   * Every Steam store hit for a free-text query, for the 「手动选择游戏」 picker.
   *
   * Unlike `search()` this does **not** pick a winner — disambiguating releases
   * that share a prefix (e.g. "007 First Light" vs "GoldenEye 007") is exactly
   * what the user is here to do, so all plausible hits are returned.
   *
   * `titleQueryVariants` is tried in order because a raw CJK term makes Steam's
   * store search return unrelated apps; results are merged and de-duplicated.
   */
  async searchTargets(query: string): Promise<AchievementCandidate[]> {
    const seen = new Map<number, StoreSearchItem>();
    for (const q of titleQueryVariants(query).slice(0, 3)) {
      const res = await this.http
        .get<{ items?: StoreSearchItem[] }>(STORE_SEARCH, {
          params: { term: q, l: 'en', cc: 'us' },
        })
        .catch((err) => {
          this.logger.warn(`Steam target search failed for "${q}": ${(err as Error)?.message}`);
          return null;
        });
      for (const i of res?.data?.items ?? []) {
        if (i.type === 'app' && Number.isFinite(i.id) && !seen.has(i.id)) seen.set(i.id, i);
      }
      if (seen.size >= 12) break;
    }
    return [...seen.values()].slice(0, 12).map((i) => ({
      source: 'steam',
      sourceLabel: 'Steam',
      externalId: String(i.id),
      name: i.name,
      platform: 'PC',
      releaseYear: null,
      // Shown under the title so two same-named releases can be told apart.
      detail: `appid ${i.id}`,
    }));
  }

  async fetch(match: ProviderMatch): Promise<MetadataFragment> {
    const appid = match.externalId;
    const fragment: MetadataFragment = {};

    // App details (no key required) give us a cover image, summary, developers,
    // publishers, release date and price all in one call.
    const details = await this.fetchAppDetails(appid);
    if (details) {
      // Authoritative title, so a manual match can rename the game.
      if (details.name) fragment.canonicalName = details.name;
      fragment.poster = pickSteamPoster(details, appid);
      fragment.summary = details.short_description || null;
      fragment.developers = details.developers?.length ? details.developers : [];
      fragment.publishers = details.publishers?.length ? details.publishers : [];
      fragment.platforms = ['PC'];
      if (details.release_date?.date) fragment.releaseDate = details.release_date.date;
      fragment.price = this.toPrice(details);
    }

    const ach = await this.fetchAchievements(appid, details?.dlc ?? []);
    fragment.achievements = ach.achievements;
    if (ach.error) fragment.achievementsError = ach.error;
    return fragment;
  }

  /**
   * Achievement schema for the base app plus every DLC that has one.
   *
   * Two things this fixes over the previous version:
   *
   *  1. **Errors used to vanish.** `.catch(() => null)` turned every failure —
   *     invalid key, HTTP 400, rate limit, a blocked `api.steampowered.com` — into
   *     the same "no achievements" result with no log and no user-visible reason.
   *     Failures now come back as a Chinese message that is persisted and shown.
   *  2. **DLC achievements were invisible.** `GetSchemaForGame` only answers for
   *     the appid you ask about, so add-ons (which carry their own appid and their
   *     own schema) were never fetched. They are now fetched per DLC and tagged so
   *     the UI can group them.
   */
  private async fetchAchievements(
    appid: string,
    dlcAppIds: number[],
  ): Promise<{ achievements: AchievementData[]; error: string | null }> {
    if (!this.apiKey) {
      return {
        achievements: [],
        error: '未配置 Steam API Key，无法刮取成就。请在「设置 → 数据源」中填写后重试。',
      };
    }

    const base = await this.fetchSchema(appid);
    if (base.error) return { achievements: [], error: base.error };

    // Global unlock percentages (separate endpoint, no per-achievement call).
    const pctMap = await this.fetchGlobalPercentages(appid);
    const achievements: AchievementData[] = [
      ...this.toAchievements(base.raw, pctMap, appid, null, null, 0),
    ];

    // DLC: each add-on answers for its own appid. Capped so a game with hundreds
    // of add-ons (train simulators) cannot turn one refresh into hundreds of calls.
    const dlcIds = dlcAppIds.slice(0, MAX_DLC_APPS);
    const dlcFailures: string[] = [];
    let order = achievements.length;
    for (const dlcId of dlcIds) {
      const dlc = await this.fetchSchema(String(dlcId));
      if (dlc.error) {
        dlcFailures.push(`${dlcId}: ${dlc.error}`);
        continue;
      }
      // `gameName` comes free with the schema, so no extra appdetails call.
      const dlcName = dlc.gameName || `DLC ${dlcId}`;
      const dlcPct = await this.fetchGlobalPercentages(String(dlcId));
      const rows = this.toAchievements(dlc.raw, dlcPct, String(dlcId), String(dlcId), dlcName, order);
      order += rows.length;
      achievements.push(...rows);
    }

    // A partial DLC failure must not read as a total failure, but it must not be
    // silent either — the base achievements still count as success.
    const baseName = base.gameName || appid;
    this.logger.log(
      `Steam achievements for ${baseName} (${appid}): ${achievements.length} from base + ${
        dlcIds.length - dlcFailures.length
      }/${dlcIds.length} DLC`,
    );
    if (dlcFailures.length) {
      this.logger.warn(`Steam DLC achievements failed for ${appid}: ${dlcFailures.join('; ')}`);
    }

    return { achievements, error: null };
  }

  /** One `GetSchemaForGame` call, with the failure reason kept intact. */
  private async fetchSchema(
    appid: string,
  ): Promise<{
    raw: SchemaAchievement[];
    gameName: string | null;
    error: string | null;
  }> {
    try {
      const res = await this.http.get<SchemaResp>(SCHEMA, {
        params: { key: this.apiKey, appid, l: 'schinese' },
      });
      const game = res?.data?.game;
      const raw = game?.availableGameStats?.achievements ?? [];
      // An app with no achievements is a legitimate empty result, not a failure.
      return { raw, gameName: game?.gameName ?? null, error: null };
    } catch (err) {
      const message = this.describeHttpFailure(err, appid);
      this.logger.warn(`Steam achievement schema failed for ${appid}: ${message}`);
      return { raw: [], gameName: null, error: message };
    }
  }

  /** Global unlock rates; failure here only costs the percentage column. */
  private async fetchGlobalPercentages(appid: string): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    try {
      const pct = await this.http.get<PctResp>(GLOBAL_PCT, { params: { gameid: appid } });
      for (const a of pct?.data?.achievementpercentages?.achievements ?? []) {
        if (typeof a?.percent === 'number') map.set(a.name, a.percent);
      }
    } catch (err) {
      this.logger.warn(
        `Steam global percentages failed for ${appid}: ${(err as Error)?.message}`,
      );
    }
    return map;
  }

  /** Shape one app's raw schema entries into our achievement rows. */
  private toAchievements(
    raw: SchemaAchievement[],
    pctMap: Map<string, number>,
    appid: string,
    dlcAppId: string | null,
    dlcName: string | null,
    startOrder: number,
  ): AchievementData[] {
    return raw.map((a, i) => ({
      externalId: dlcAppId ? `${dlcAppId}:${a.name}` : a.name,
      name: a.displayName || a.name,
      description: a.description ?? null,
      // `a.icon` is usually a bare `<hash>.jpg`, but some apps return a full URL
      // on the retired akamaihd host; the helper takes just the file name so the
      // CDN template can never nest one URL inside another (see image-url.ts).
      iconUrl: steamAchievementIconUrl(appid, a.icon),
      globalPercent: pctMap.has(a.name) ? pctMap.get(a.name)! : null,
      unlocked: false,
      source: 'steam',
      dlcAppId,
      dlcName,
      sortOrder: startOrder + i,
    }));
  }

  /**
   * Turn an axios failure into an actionable Chinese sentence.
   *
   * The distinction matters: a 400/403 means the key is wrong or lacks access,
   * while a socket error means `api.steampowered.com` is unreachable from the
   * container (the usual case in mainland China without a proxy).
   */
  private describeHttpFailure(err: unknown, appid: string): string {
    const e = err as {
      response?: { status?: number };
      message?: string;
      code?: string;
    };
    const status = e?.response?.status;
    const detail = e?.message || String(err);
    if (status === 400 || status === 401 || status === 403) {
      return `Steam 拒绝访问成就接口（HTTP ${status}，appid ${appid}）：API Key 无效、未启用或权限不足。请在「设置 → 数据源」重新填写 Steam API Key。`;
    }
    if (status === 429) {
      return `Steam 接口限流（HTTP 429，appid ${appid}）：请求过于频繁，请稍后重试。`;
    }
    if (status) {
      return `Steam 成就接口返回异常状态（HTTP ${status}，appid ${appid}）：${detail}`;
    }
    return `无法连接 api.steampowered.com（appid ${appid}）：${detail}。大陆网络通常需要在「设置 → 数据源」配置代理后重试。`;
  }

  private async fetchAppDetails(appid: string): Promise<AppDetails | null> {
    const res = await this.http
      .get<AppDetailsResp>(APP_DETAILS, { params: { appids: appid, cc: 'us', l: 'en' } })
      .catch((err) => {
        this.logger.warn(`Steam appdetails failed for ${appid}: ${(err as Error)?.message}`);
        return null;
      });
    const data = res?.data?.[appid]?.data;
    // `type: game` filters out DLC/music/etc. matched by the search layer.
    return data && data.type === 'game' ? data : null;
  }

  private toPrice(details: AppDetails): MetadataFragment['price'] {
    const priceOverview = details.price_overview;
    if (!priceOverview) return null;

    // Steam prices are integer cents.
    const cents = (n: number | undefined): number | null =>
      typeof n === 'number' ? Math.round(n) / 100 : null;

    return {
      source: 'steam',
      currency: priceOverview.currency ?? 'USD',
      currentPrice: cents(priceOverview.final),
      initialPrice: cents(priceOverview.initial),
      discountPercent: priceOverview.discount_percent ?? 0,
      // Historical low requires a SteamDB lookup (optional; see STEAMDB_KEY).
      historicalLow: null,
    };
  }
}

/**
 * Steam CDN hosts fall into two families that serve *different, disjoint* path
 * layouts. Swapping the hostname across families yields a 404, so any swap must
 * stay inside one family:
 *
 *   shared.*  → `/store_item_assets/steam/apps/<appid>/…/header.jpg`
 *   cdn.*     → `/steam/apps/<appid>/header.jpg`
 *
 * Verified against the live CDN: shared.akamai/shared.fastly serve
 * `/store_item_assets/…` (200) and 404 on `/steam/apps/…`; cdn.akamai/
 * cdn.cloudflare/steamcdn-a do the exact opposite.
 */
export const STEAM_HOST_FAMILIES: Record<'shared' | 'cdn', string[]> = {
  shared: ['shared.akamai.steamstatic.com', 'shared.fastly.steamstatic.com'],
  cdn: [
    'cdn.akamai.steamstatic.com',
    'cdn.cloudflare.steamstatic.com',
    'steamcdn-a.akamaihd.net',
  ],
};

/** Which family a hostname belongs to, or null when unrecognised. */
export function steamHostFamily(host: string): 'shared' | 'cdn' | null {
  const h = host.toLowerCase();
  if (h.startsWith('shared.')) return 'shared';
  if (h.startsWith('cdn.') || h.startsWith('steamcdn')) return 'cdn';
  return null;
}

/** The asset path a family expects, used only when synthesizing a URL. */
function familyPath(family: 'shared' | 'cdn', appid: string): string {
  return family === 'shared'
    ? `store_item_assets/steam/apps/${appid}/header.jpg`
    : `steam/apps/${appid}/header.jpg`;
}

/**
 * Steam cover image with an optional host swap.
 *
 * The appdetails API returns a fully-qualified URL that already carries the
 * correct asset path (and often a content hash), e.g.
 * `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/620/<hash>/header.jpg?t=…`.
 * Because the two CDN families serve disjoint paths (see
 * {@link STEAM_HOST_FAMILIES}), we keep the API's path+query verbatim and only
 * swap to a preferred host *from the same family* — never fabricate a path.
 *
 * Preference list comes from `STEAM_IMAGE_HOSTS` (comma separated). When it is
 * empty — the default — the API URL is returned untouched, i.e. zero behaviour
 * change. Put a directly-reachable host first to serve these images without the
 * proxy (see 优化 #6).
 */
export function pickSteamPoster(
  details: { header_image?: string; capsule_imagev5?: string; capsule_image?: string },
  appid: string,
  preferredHosts: string[] = STEAM_IMAGE_HOSTS,
): string | null {
  const apiUrl = details.header_image || details.capsule_imagev5 || details.capsule_image || null;
  const preferred = preferredHosts.filter(Boolean);
  if (preferred.length === 0) return apiUrl;

  if (!apiUrl) {
    // No URL from the API: synthesize using a path that matches the chosen
    // host's family, otherwise the URL would 404.
    const host = preferred[0];
    const family = steamHostFamily(host);
    if (!family) return null;
    return `https://${host}/${familyPath(family, appid)}`;
  }

  try {
    const u = new URL(apiUrl);
    const sourceFamily = steamHostFamily(u.hostname);
    // Pick the first preferred host that shares the source's path family.
    const replacement = preferred.find((h) =>
      sourceFamily ? steamHostFamily(h) === sourceFamily : h === u.hostname,
    );
    if (!replacement || replacement === u.hostname) return apiUrl;
    u.hostname = replacement;
    return u.toString();
  } catch {
    return apiUrl;
  }
}

/**
 * Steam image CDN hosts, most-preferred first. Override with the
 * `STEAM_IMAGE_HOSTS` env var (comma separated) to put a directly-reachable
 * host in front and cut proxy usage. Empty (default) = keep the API's URL.
 */
export const STEAM_IMAGE_HOSTS: string[] = (process.env.STEAM_IMAGE_HOSTS || '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);