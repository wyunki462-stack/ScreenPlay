/**
 * IGDB (Twitch) metadata provider — API v4.
 *
 * Docs: https://api-docs.igdb.com
 * Uses the Apicalypse query language over POST. Requires CLIENT_ID + CLIENT
 * SECRET (a short-lived app access token is fetched via Twitch OAuth and
 * memoized in-process).
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration';
import { HttpService } from '../../common/http/http.service';
import { GameRecognizerService } from '../../library/game-recognizer.service';
import { SettingsService } from '../../settings/settings.service';
import { MetadataProvider, MetadataFragment, ProviderMatch } from '../provider.interface';

const IGDB_BASE = 'https://api.igdb.com/v4';
const TWITCH_TOKEN = 'https://id.twitch.tv/oauth2/token';

interface IgdbGame {
  id: number;
  name: string;
  summary?: string;
  first_release_date?: number;
  cover?: { url: string };
  screenshots?: { url: string }[];
  involved_companies?: {
    company?: { name: string };
    developer?: boolean;
    publisher?: boolean;
  }[];
  platforms?: { name: string }[];
  rating?: number;
  url?: string;
}

@Injectable()
export class IgdbProvider implements MetadataProvider {
  readonly name = 'igdb' as const;
  readonly cacheTtlSeconds: number;

  private readonly logger = new Logger(IgdbProvider.name);
  private token: { value: string; expiry: number; clientId: string } | null = null;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly http: HttpService,
    private readonly recognizer: GameRecognizerService,
    private readonly settings: SettingsService,
  ) {
    this.cacheTtlSeconds = config.get('cacheTtlGameSeconds', { infer: true });
  }

  get enabled(): boolean {
    const keys = this.settings.getApiKeys();
    return Boolean(keys.igdbClientId && keys.igdbClientSecret);
  }

  async search(name: string, platform: string | null): Promise<ProviderMatch | null> {
    return this.querySearch(name, platform);
  }

  async fetch(match: ProviderMatch): Promise<MetadataFragment> {
    const token = await this.getAccessToken();
    const query = `fields name, summary, first_release_date, cover.url, screenshots.url, involved_companies.company.name, involved_companies.developer, involved_companies.publisher, platforms.name, url; where id = ${match.externalId};`;
    const res = await this.http.post<IgdbGame[]>(`${IGDB_BASE}/games`, query, {
      headers: { 'Client-ID': await this.clientId(), Authorization: `Bearer ${token}` },
    });
    const game = res.data?.[0];
    if (!game) return {};

    const developers: string[] = [];
    const publishers: string[] = [];
    const otherCompanies: string[] = [];
    for (const ic of game.involved_companies ?? []) {
      const name = ic.company?.name;
      if (!name) continue;
      if (ic.developer) developers.push(name);
      else if (ic.publisher) publishers.push(name);
      else otherCompanies.push(name);
    }

    return {
      summary: game.summary ?? null,
      releaseDate: game.first_release_date
        ? new Date(game.first_release_date * 1000).toISOString()
        : null,
      poster: imageUrl(game.cover?.url, 'cover_big'),
      screenshots: (game.screenshots ?? [])
        .map((s) => imageUrl(s.url, 'screenshot_big'))
        .filter((x): x is string => Boolean(x))
        .slice(0, 8),
      developers: uniq(developers),
      publishers: uniq(publishers),
      // Voice actors live under IGDB's `game_voice_actors` relation; companies
      // with neither role are exposed here as a best-effort "contributors" list.
      voiceActors: uniq(otherCompanies),
      platforms: uniq((game.platforms ?? []).map((p) => p.name).filter((x): x is string => Boolean(x))),
    };
  }

  // ---------------------------------------------------------------------------

  private async querySearch(name: string, platform: string | null): Promise<ProviderMatch | null> {
    const token = await this.getAccessToken();

    // Strategy 1: name only (IGDB search isn't platform-aware in one call); we
    // filter by platform client-side where possible, else fuzzy-match.
    const query = `fields name, first_release_date, platforms.name; search "${escapeApicalypse(name)}"; limit 20;`;
    const res = await this.http.post<IgdbGame[]>(`${IGDB_BASE}/games`, query, {
      headers: { 'Client-ID': await this.clientId(), Authorization: `Bearer ${token}` },
    });
    const results = res.data ?? [];
    if (results.length === 0) return null;

    const known = results.map((g) => ({
      id: String(g.id),
      name: g.name,
      releaseYear: g.first_release_date
        ? new Date(g.first_release_date * 1000).getFullYear()
        : null,
      platformHints: (g.platforms ?? []).map((p) => p.name),
    }));

    // Exact platform preference first, then fuzzy name similarity.
    if (platform) {
      const byPlatform = known.filter((k) =>
        k.platformHints.some((p) => p.toLowerCase() === platform.toLowerCase()),
      );
      if (byPlatform.length === 1) return toMatch(byPlatform[0]);
      const fuzzy = this.recognizer.fuzzyMatch(name, byPlatform.length ? byPlatform : known, (k) => k.name);
      if (fuzzy.item && fuzzy.score >= 0.4) return toMatch(fuzzy.item);
    }

    const fuzzy = this.recognizer.fuzzyMatch(name, known, (k) => k.name);
    return fuzzy.item && fuzzy.score >= 0.4 ? toMatch(fuzzy.item) : null;
  }

  private async getAccessToken(): Promise<string> {
    const keys = this.settings.getApiKeys();
    if (
      this.token &&
      this.token.expiry > Date.now() + 60_000 &&
      this.token.clientId === keys.igdbClientId
    ) {
      return this.token.value;
    }
    const params = new URLSearchParams({
      client_id: keys.igdbClientId,
      client_secret: keys.igdbClientSecret,
      grant_type: 'client_credentials',
    });
    const res = await this.http.post<{ access_token: string; expires_in: number }>(
      `${TWITCH_TOKEN}?${params.toString()}`,
      null,
    );
    const ttl = (res.data.expires_in ?? 3600) * 1000;
    this.token = {
      value: res.data.access_token,
      expiry: Date.now() + ttl,
      clientId: keys.igdbClientId,
    };
    return this.token.value;
  }

  private clientId(): string {
    return this.settings.getApiKeys().igdbClientId;
  }
}

function toMatch(k: { id: string; name: string; releaseYear: number | null }): ProviderMatch {
  return { externalId: k.id, name: k.name, platform: null, releaseYear: k.releaseYear };
}

function imageUrl(url: string | undefined, size: string): string | null {
  if (!url) return null;
  const https = url.startsWith('//') ? `https:${url}` : url;
  // IGDB thumbnails are returned as `t_thumb`; swap in the requested size.
  return https.replace(/\/t_[a-z0-9_]+\//, `/${size}/`);
}

function uniq(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

function escapeApicalypse(input: string): string {
  // Apicalypse string literals escape double quotes and backslashes.
  return input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}