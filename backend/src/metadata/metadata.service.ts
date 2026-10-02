/**
 * Metadata aggregator.
 *
 * Coordinates the registered providers, applies the cache tiers (game 30d /
 * rating & price 7d / achievements 15d — each provider declares its own TTL),
 * persists resolved metadata onto the games row + achievements table, and owns
 * the manual binding (game_links) used to force-match a game to an external id.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { DatabaseService } from '../database/database.service';
import { MetadataCacheService } from '../common/cache/metadata-cache.service';
import { GameRecognizerService } from '../library/game-recognizer.service';
import { isLocalFileUrl, PostersService } from '../games/posters.service';
import { MediaReviewsService } from '../games/media-reviews.service';
import { storeAchievements } from '../trophies/achievement-store';
import { TrophiesService } from '../trophies/trophies.service';
import { AchievementTargetService } from '../trophies/achievement-target.service';
import type { AchievementCandidate } from '../trophies/trophy-source.interface';
import {
  MetadataProvider,
  MetadataProviderName,
  MetadataFragment,
  AchievementData,
  ProviderMatch,
  RatingData,
} from './provider.interface';
import {
  parseJson,
  mergeRatings,
  mergeDuration,
  mergePoster,
  hasMetascore,
  DURATION_SOURCE_PRIORITY,
  DURATION_SOURCE_ORDER,
} from './metadata-merge';

export const METADATA_PROVIDERS = 'METADATA_PROVIDERS';

/**
 * Duration sources in preference order, highest first.
 *
 * HowLongToBeat reports an actual "main story" completion time and covers PC,
 * PlayStation, Xbox and Switch, so it wins whenever it answers. RAWG's `playtime`
 * is the average across all players rather than a story time, so it is the
 * fallback — better than showing nothing, but not equal to HLTB.
 */

/** Preferred order for the "canonical title" — Metacritic (M站) first, as requested. */
const CANONICAL_NAME_PRIORITY: MetadataProviderName[] = ['metacritic', 'rawg', 'igdb', 'steam', 'hltb'];

/**
 * Providers whose answer is authoritative about 媒体评价 — in both directions.
 *
 * Only these may write the review list, and only these may declare that a game
 * has none. Without this, every other provider (which returns no reviews at all)
 * would look like "the source had nothing" and could stamp an empty state over a
 * panel that was populated a moment earlier.
 */
const REVIEW_PROVIDERS: MetadataProviderName[] = ['metacritic'];

interface GameRow {
  id: string;
  name: string;
  platform: string | null;
  manual_override: number;
  poster_url: string | null;
  /** JSON blob of scraped ratings; read to detect a missing Metascore. */
  ratings?: string | null;
  /** Read to detect a game that still has no completion time. */
  main_story_hours?: number | null;
}

@Injectable()
export class MetadataService {
  private readonly logger = new Logger(MetadataService.name);

  constructor(
    @Inject(METADATA_PROVIDERS) private readonly providers: MetadataProvider[],
    private readonly db: DatabaseService,
    private readonly cache: MetadataCacheService,
    private readonly recognizer: GameRecognizerService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly posters: PostersService,
    private readonly trophies: TrophiesService,
    private readonly targets: AchievementTargetService,
    /** 媒体评价 storage (own table, own lifecycle — see the service). */
    private readonly reviews: MediaReviewsService,
  ) {}

  /** Lazy enrichment when a game's detail view is requested. */
  async enrichGame(gameId: string, force = false): Promise<void> {
    const game = this.db.get<GameRow>('SELECT * FROM games WHERE id = ?', [gameId]);
    if (!game) return;

    const aggregate: MetadataFragment = {
      developers: [],
      publishers: [],
      voiceActors: [],
      screenshots: [],
      platforms: [],
    };
    const canonicalNames: Partial<Record<MetadataProviderName, string>> = {};
    /** Which provider supplied the 媒体评价, for the panel's "来源" link. */
    let reviewsFrom: MetadataProviderName | null = null;

    // Fetch providers concurrently — they hit different origins, so the shared
    // per-origin rate limiter still keeps each host polite while cutting the
    // wall-clock time of a cold scrape substantially.
    await Promise.all(
      this.providers.map(async (provider) => {
        if (!provider.enabled) return;
        try {
          const fragment = await this.fetchProvider(provider, game, force);
          if (fragment.canonicalName) canonicalNames[provider.name] = fragment.canonicalName;
          if (fragment.mediaReviews?.length) reviewsFrom = provider.name;
          merge(aggregate, fragment);
        } catch (err) {
          this.logger.warn(
            `${provider.name} failed for "${game.name}": ${(err as Error)?.message}`,
          );
        }
      }),
    );

    this.persist(game, aggregate);
    // 媒体评价 have their own table and their own lifecycle rules (never wiped by
    // an empty scrape), so they are written here rather than inside persist().
    this.persistReviews(game, aggregate.mediaReviews, reviewsFrom);
    this.applyCanonicalName(game, canonicalNames);
    // Console trophies come from a separate scrape (Steam has no entry for a PS
    // title). Non-forced, so a routine scan reuses a list scraped recently.
    await this.syncAchievements(gameId, false);
    // Same completion-time retry as refreshGame(): the canonical name is known by
    // now, so a Chinese-named folder gets a second chance at a Latin index.
    await this.backfillDuration(gameId, game.name);
  }

  /**
   * Retry the completion-time sources once the canonical title is known.
   *
   * Completion-time databases index Latin titles, and a game folder is very often
   * Chinese (「死亡岛2」). The shared alias table covers popular titles, but not
   * every one, so this pass is the general safety net: by now `applyCanonicalName`
   * has usually rewritten the row to the title RAWG/Metacritic uses
   * ("Dead Island 2"), which HLTB does index.
   *
   * Sources are tried in preference order and the first one that answers wins,
   * which is the multi-source fallback the coverage requirement asks for.
   */
  private async backfillDuration(gameId: string, previousName: string): Promise<void> {
    const fresh = this.db.get<GameRow>('SELECT * FROM games WHERE id = ?', [gameId]);
    if (!fresh || fresh.main_story_hours != null) return;
    // Nothing new to search with — the canonical pass did not rename the game.
    if (fresh.name === previousName) return;

    for (const sourceName of DURATION_SOURCE_ORDER) {
      const provider = this.providers.find((p) => p.name === sourceName && p.enabled);
      if (!provider) continue;
      try {
        const fragment = await this.fetchProvider(provider, fresh, true);
        if (fragment.mainStoryHours != null) {
          this.persist(fresh, fragment);
          this.logger.log(
            `Completion time for "${fresh.name}" recovered from ${sourceName} after renaming ` +
              `(was "${previousName}"): ${fragment.mainStoryHours}h.`,
          );
          return;
        }
      } catch (err) {
        this.logger.warn(
          `${sourceName} duration backfill failed for "${fresh.name}": ${(err as Error)?.message}`,
        );
      }
    }
    this.logger.log(
      `No completion time found for "${fresh.name}" (tried ${DURATION_SOURCE_ORDER.join(' → ')}).`,
    );
  }

  /**
   * Snapshot the ratings blob so a later update can be checked against it.
   *
   * Paired with `restoreRatingsIfLost()` this is the "评分完整性校验" that runs
   * around every metadata update.
   */
  snapshotRatings(gameId: string): string | null {
    return (
      this.db.get<{ ratings: string | null }>('SELECT ratings FROM games WHERE id = ?', [gameId])
        ?.ratings ?? null
    );
  }

  /**
   * Put a Metascore back when the update that just ran failed to produce one.
   *
   * Requirement: an update may refresh a score but must never silently clear a
   * valid one. Only a genuinely missing Metascore is restored — if the new data
   * carries a score, that newer value is kept as-is.
   *
   * @returns true when a score had to be restored.
   */
  restoreRatingsIfLost(gameId: string, snapshot: string | null, context: string): boolean {
    if (!hasMetascore(snapshot)) return false;
    const current = this.snapshotRatings(gameId);
    if (hasMetascore(current)) return false;

    const restored = parseJson<RatingData>(snapshot ?? '[]').filter((r) => r.metascore != null);
    let next = current;
    for (const rating of restored) next = mergeRatings(next, rating);
    this.db.run('UPDATE games SET ratings = ?, updated_at = ? WHERE id = ?', [next, Date.now(), gameId]);

    const row = this.db.get<{ name: string }>('SELECT name FROM games WHERE id = ?', [gameId]);
    this.logger.warn(
      `Rating integrity: ${context} left "${row?.name ?? gameId}" without a Metascore; ` +
        `restored the previous score (${restored.map((r) => r.metascore).join('/')}).`,
    );
    return true;
  }

  async refreshGame(gameId: string, only?: MetadataProviderName[]): Promise<void> {
    const game = this.db.get<GameRow>('SELECT * FROM games WHERE id = ?', [gameId]);
    if (!game) return;
    // Rating integrity: remember a good Metascore so a refresh that comes back
    // empty (provider down, proxy flaky, page changed) cannot silently lose it.
    // Reported symptom: refresh or manual match makes the score badge vanish.
    const ratingSnapshot = this.snapshotRatings(gameId);
    const canonicalNames: Partial<Record<MetadataProviderName, string>> = {};
    let attempted = 0;
    let failures = 0;
    let lastError = '';
    await Promise.all(
      this.providers.map(async (provider) => {
        if (!provider.enabled) return;
        if (only && !only.includes(provider.name)) return;
        attempted += 1;
        try {
          const fragment = await this.fetchProvider(provider, game, true);
          if (fragment.canonicalName) canonicalNames[provider.name] = fragment.canonicalName;
          // Persist incrementally per provider so partial successes survive.
          this.persist(game, fragment);
          // 媒体评价 live outside `persist` (own table, own lifecycle rules), so
          // each provider's review list is written as it arrives. A provider that
          // returns none of its own does not clear what another one stored.
          this.persistReviews(game, fragment.mediaReviews, provider.name);
        } catch (err) {
          failures += 1;
          lastError = lastError || (err as Error)?.message || String(err);
          this.logger.warn(
            `Refresh ${provider.name} failed for "${game.name}": ${(err as Error)?.message}`,
          );
        }
      }),
    );
    this.applyCanonicalName(game, canonicalNames);
    this.db.run('UPDATE games SET last_meta_refresh = ? WHERE id = ?', [Date.now(), gameId]);
    this.restoreRatingsIfLost(gameId, ratingSnapshot, 'refresh');
    // Second pass: completion times are indexed by Latin title, so retry now that
    // the canonical name is known (see backfillDuration).
    await this.backfillDuration(gameId, game.name);

    // Same refresh also pulls console trophies. A PlayStation game has no Steam
    // entry at all, which is why achievement scraping used to look "broken" for
    // exactly the games the user cared about.
    await this.syncAchievements(gameId, true);

    // Record a per-game failure so the gallery can badge it (cleared on success).
    if (attempted > 0 && failures === attempted) {
      this.db.run('UPDATE games SET meta_error = ? WHERE id = ?', [
        `所有数据源均失败：${lastError || '未知错误'}`,
        gameId,
      ]);
    } else {
      this.db.run('UPDATE games SET meta_error = NULL WHERE id = ?', [gameId]);
    }
  }

  /**
   * Fetch 媒体评价 for ONE game, touching only the review sources.
   *
   * Deliberately narrower than `refreshGame()`: that sweeps every provider (store
   * page, prices, screenshots, trophies) which is far more traffic than filling a
   * review panel needs, and it would rewrite unrelated metadata as a side effect
   * of pressing 「补全媒体评价」.
   *
   * Returns what actually happened, so the batch endpoint can report per-game
   * results to the UI rather than a bare `{ started: true }`.
   */
  async refreshReviews(
    gameId: string,
  ): Promise<{
    status: 'ok' | 'empty' | 'failed' | 'unsupported' | 'skipped';
    stored: number;
    error: string | null;
  }> {
    const game = this.db.get<GameRow>('SELECT * FROM games WHERE id = ?', [gameId]);
    if (!game) return { status: 'skipped', stored: 0, error: '游戏不存在' };

    const provider = this.providers.find(
      (p) => p.enabled && REVIEW_PROVIDERS.includes(p.name as MetadataProviderName),
    );
    if (!provider) {
      return { status: 'skipped', stored: this.reviews.count(gameId), error: '媒体评价数据源未启用' };
    }

    // No binding means there is no page to fetch for THIS game. That is not a
    // failure — the honest answer is 「未找到该游戏的对应条目」, and the user's next
    // step is 手动匹配 rather than retrying.
    //
    // Recorded, following the policy achievements already use for the same
    // situation (`syncTrophies` → 'unsupported' + 「可在「手动匹配」中关联后重试」).
    // Recording it is what keeps two things consistent:
    //   - the batch stops visiting a game it cannot do anything for, so a 补全 run
    //     does not forever report "6 个待补全" that pressing the button never clears;
    //   - the count on the settings card matches the work the button actually does.
    // The trade-off is accepted and matches achievements: a game that is later
    // matched is picked up by the refresh that follows the re-match, and by
    // `scope=all`.
    if (!this.getBinding(gameId, provider.name)) {
      this.reviews.markUnsupported(gameId, '未绑定媒体评价站条目');
      return {
        status: 'unsupported',
        stored: this.reviews.count(gameId),
        error: '未绑定媒体评价站条目',
      };
    }

    try {
      const fragment = await this.fetchProvider(provider, game, true);
      const sourceUrl = this.reviewsSourceUrl(game);

      if (fragment.mediaReviews && fragment.mediaReviews.length > 0) {
        const { stored, status } = this.reviews.save(gameId, fragment.mediaReviews, { sourceUrl });
        return { status, stored, error: null };
      }

      // The provider answered but the page carried no reviews. Record that
      // honestly — but never delete rows: an empty answer is far more often a
      // block or a layout change than a real retraction.
      this.reviews.markEmpty(gameId, sourceUrl);
      return { status: 'empty', stored: this.reviews.count(gameId), error: null };
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      // `save` with an error marks the game 'failed' while KEEPING existing rows,
      // which is the same policy achievements use: the panel can warn and still
      // show what it already has.
      this.reviews.save(gameId, [], { error: message });
      return { status: 'failed', stored: this.reviews.count(gameId), error: message };
    }
  }

  /**
   * Re-scrape achievements/trophies ONLY — the achievements tab's refresh button.
   *
   * Deliberately not `refreshGame()`: that sweeps every metadata provider (store
   * page, ratings, prices) which is far more traffic than the tab needs, and it
   * would rewrite the game's metadata as a side effect of pressing a button that
   * says "refresh achievements".
   *
   * `SteamProvider.fetch()` is reused as-is — it already returns the achievement
   * list AND the failure reason, which is what lets a bad key or an unreachable
   * `api.steampowered.com` show up as a message instead of an empty tab.
   */
  /**
   * Candidate achievement entries across every source, for 「手动选择游戏」.
   *
   * Steam and the trophy sites are queried together and returned as one list so
   * the user can pick the right release by eye — the whole point, since folder
   * names like "007" cannot tell "007 First Light" from "GoldenEye 007".
   * A source that fails contributes nothing rather than failing the search.
   */
  async searchAchievementTargets(query: string): Promise<AchievementCandidate[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const steam = this.providers.find((p) => p.name === 'steam' && p.enabled) as
      | (MetadataProvider & { searchTargets?: (q: string) => Promise<AchievementCandidate[]> })
      | undefined;
    const [steamHits, trophyHits] = await Promise.all([
      steam?.searchTargets
        ? steam.searchTargets(trimmed).catch((err) => {
            this.logger.warn(`Steam target search failed: ${(err as Error)?.message}`);
            return [] as AchievementCandidate[];
          })
        : Promise.resolve([] as AchievementCandidate[]),
      this.trophies.searchCandidates(trimmed).catch((err) => {
        this.logger.warn(`Trophy target search failed: ${(err as Error)?.message}`);
        return [] as AchievementCandidate[];
      }),
    ]);
    return [...steamHits, ...trophyHits];
  }

  /**
   * Forget every scraped achievement/trophy artifact for a game.
   *
   * The manual-match flow replaces a game's whole identity, so the previous
   * title's trophies must not survive into the new one.
   */
  clearAchievements(gameId: string): void {
    this.trophies.clearForGame(gameId);
  }

  async refreshAchievements(gameId: string): Promise<void> {
    const game = this.db.get<GameRow>('SELECT * FROM games WHERE id = ?', [gameId]);
    if (!game) return;

    // 1. Steam (only when the game is actually bound to an appid).
    let steamVerdict: { status: string; error: string | null } | null = null;
    const steam = this.providers.find((p) => p.name === 'steam' && p.enabled);
    // The hand-picked Steam app wins over the auto-generated binding.
    const manual = this.targets.get(game.id);
    const manualAppId = manual?.source === 'steam' ? manual.externalId : null;
    const binding = manualAppId ?? (steam ? this.getBinding(game.id, 'steam') : null);
    if (steam && binding) {
      try {
        const fragment = await steam.fetch({
          externalId: binding,
          name: game.name,
          platform: null,
          releaseYear: null,
        });
        steamVerdict = this.storeSteamAchievements(game.id, fragment);
      } catch (err) {
        steamVerdict = {
          status: 'failed',
          error: `Steam 成就刮取失败：${(err as Error)?.message ?? String(err)}`,
        };
      }
    }

    // 2. Console trophies. Non-forced freshness does not apply: this is an
    //    explicit user action.
    const isPS = this.trophies.isPlayStationGame(gameId) || manual?.source === 'psnine';
    const trophy = await this.trophies.sync(gameId, true);

    // 3. Decide which verdict is authoritative. Both paths write to
    //    `games.achievements_*`, so without this the trophy pass would overwrite a
    //    Steam failure with "unsupported" on a PC game — the exact case the user
    //    hit, where the real reason (a bad/missing key) got hidden.
    const trophyApplies =
      trophy.status === 'ok' || trophy.status === 'failed';
    let verdict: { status: string; error: string | null } | null = null;
    if (isPS && trophyApplies) {
      // A PlayStation game's achievements ARE its trophies.
      verdict = { status: trophy.status, error: trophy.error };
    } else if (steamVerdict) {
      verdict = steamVerdict;
    } else if (trophyApplies) {
      verdict = { status: trophy.status, error: trophy.error };
    } else {
      verdict = {
        status: 'unsupported',
        error:
          '该游戏既没有 Steam 匹配记录，也不属于 PlayStation 平台，暂时没有可用的成就/奖杯数据源。可在「手动匹配」中关联 Steam 条目后重试。',
      };
    }

    this.setAchievementStatus(gameId, verdict.status, verdict.error);
  }

  /**
   * Persist a Steam scrape result and report the verdict, without writing the
   * final status — the caller decides once it knows what the trophy pass found.
   */
  private storeSteamAchievements(
    gameId: string,
    fragment: MetadataFragment,
  ): { status: string; error: string | null } {
    const error = fragment.achievementsError ?? null;
    const list = fragment.achievements ?? [];
    if (!error && list.length) storeAchievements(this.db, gameId, 'steam', list);
    // An empty list with no error is a legitimate "this app has no achievements".
    return error
      ? { status: 'failed', error }
      : { status: list.length ? 'ok' : 'empty', error: null };
  }

  /** Write the achievement scrape state for one game. */
  private setAchievementStatus(gameId: string, status: string, error: string | null): void {
    this.db.run(
      `UPDATE games SET achievements_status = ?, achievements_error = ?,
         last_achievements_refresh = ? WHERE id = ?`,
      [status, status === 'ok' ? null : error, Date.now(), gameId],
    );
  }

  /**
   * Scrape console trophies, swallowing only *unexpected* errors.
   *
   * A trophy failure must never abort a metadata refresh (they are different
   * concerns), but it must also never be silent — `TrophiesService` records the
   * reason in `games.achievements_error` and this logs it.
   */
  private async syncAchievements(gameId: string, force: boolean): Promise<void> {
    if (this.targets.has(gameId)) {
      // A hand-picked target drives the whole path (Steam or trophies, whichever
      // the user chose), so full scrapes and single-game refreshes both reuse it.
      await this.refreshAchievements(gameId);
      return;
    }
    await this.syncTrophies(gameId, force);
  }

  private async syncTrophies(gameId: string, force: boolean): Promise<void> {
    try {
      const outcome = await this.trophies.sync(gameId, force);
      if (outcome.status === 'failed') {
        this.logger.warn(`Trophy scrape failed for ${gameId}: ${outcome.error}`);
      }
      if (outcome.status === 'unsupported') {
        // Only label the game when nothing else has spoken for it. Steam writes
        // its own verdict for a bound PC game, and overwriting that with
        // "unsupported" is what made a bad Steam key look like "no data source".
        const current = this.db.get<{ achievements_status: string | null }>(
          'SELECT achievements_status FROM games WHERE id = ?',
          [gameId],
        );
        if (!current?.achievements_status) {
          this.setAchievementStatus(
            gameId,
            'unsupported',
            '该游戏尚未匹配到 Steam 条目，也不属于 PlayStation 平台，暂时没有可用的成就/奖杯数据源。可在「手动匹配」中关联后重试。',
          );
        }
      }
    } catch (err) {
      this.logger.warn(`Trophy scrape crashed for ${gameId}: ${(err as Error)?.message}`);
      this.db.run(
        `UPDATE games SET achievements_status = 'failed', achievements_error = ? WHERE id = ?`,
        [`奖杯刮取出错：${(err as Error)?.message || String(err)}`, gameId],
      );
    }
  }

  // --- Manual search / match --------------------------------------------------

  /** Search across enabled providers (used by the manual-match dialog). */
  /**
   * Search a SINGLE provider and return its raw candidate list.
   *
   * `search()` fans out across every source and flattens the results; the manual
   * rating picker needs one specific source (Metacritic) with the per-entry score
   * and platform that `search()` does not carry.
   */
  async searchProvider(name: MetadataProviderName, query: string): Promise<ProviderMatch[]> {
    const provider = this.providers.find((p) => p.name === name);
    if (!provider || !provider.enabled) return [];
    try {
      if (typeof provider.searchAll === 'function') {
        const all = await provider.searchAll(query, null);
        if (all.length) return all;
      }
      const one = await provider.search(query, null);
      return one ? [one] : [];
    } catch (err) {
      this.logger.warn(
        `Search on ${name} failed for "${query}": ${(err as Error)?.message}`,
      );
      return [];
    }
  }

  async search(
    query: string,
  ): Promise<Array<{
    provider: MetadataProviderName;
    externalId: string;
    name: string;
    platform: string | null;
    releaseYear: number | null;
  }>> {
    const out: Array<{
      provider: MetadataProviderName;
      externalId: string;
      name: string;
      platform: string | null;
      releaseYear: number | null;
    }> = [];
    await Promise.all(
      this.providers.map(async (provider) => {
        if (!provider.enabled) return;
        try {
          // Prefer the provider's full candidate list. Automatic scraping only
          // needs its best guess, but a human picking from one row per source has
          // no way out of a wrong guess — which is what made Nintendo titles
          // un-matchable by hand. Providers that cannot enumerate fall back to
          // their single best match.
          const found: ProviderMatch[] =
            typeof provider.searchAll === 'function'
              ? await provider.searchAll(query, null)
              : [await provider.search(query, null)].filter((m): m is ProviderMatch => !!m);
          for (const m of found) {
            out.push({
              provider: provider.name,
              externalId: m.externalId,
              name: m.name,
              platform: m.platform,
              releaseYear: m.releaseYear,
            });
          }
        } catch (err) {
          this.logger.warn(`Search failed for "${query}" on ${provider.name}: ${(err as Error)?.message}`);
        }
      }),
    );
    // Manual-match dialog: surface the primary (RAWG) source first.
    const PRIORITY: Record<string, number> = { rawg: 0, hltb: 1, steam: 2, metacritic: 3, igdb: 4 };
    out.sort((a, b) => (PRIORITY[a.provider] ?? 99) - (PRIORITY[b.provider] ?? 99));
    return out;
  }

  // --- Manual bindings -------------------------------------------------------

  getBinding(gameId: string, provider: MetadataProviderName): string | null {
    const row = this.db.get<{ external_id: string }>(
      'SELECT external_id FROM game_links WHERE game_id = ? AND provider = ?',
      [gameId, provider],
    );
    return row?.external_id ?? null;
  }

  setBinding(gameId: string, provider: MetadataProviderName, externalId: string): void {
    this.db.run(
      `INSERT INTO game_links (game_id, provider, external_id) VALUES (?, ?, ?)
       ON CONFLICT(game_id, provider) DO UPDATE SET external_id = excluded.external_id`,
      [gameId, provider, externalId],
    );
  }

  /**
   * Drop a provider binding so the next refresh re-runs the search.
   *
   * Needed when a matcher bug stored a wrong id: the binding short-circuits
   * `search()` entirely, so a fixed matcher would never be consulted. Also used
   * by the manual-match flow, which rebinds every provider from scratch.
   */
  clearBinding(gameId: string, provider: MetadataProviderName): void {
    this.db.run('DELETE FROM game_links WHERE game_id = ? AND provider = ?', [gameId, provider]);
  }

  /**
   * Names of every provider that is currently usable (credentials present).
   * Used by the manual-match flow to refresh the whole identity, not just the
   * provider the user picked.
   */
  enabledProviderNames(): MetadataProviderName[] {
    return this.providers.filter((p) => p.enabled).map((p) => p.name);
  }

  /**
   * Ask a single provider what title a given external id actually has.
   *
   * The manual-match dialog only carries an opaque id, but the game's display
   * name must change to the matched title — otherwise the full refresh searches
   * for the OLD name and re-binds straight back to the old entity.
   */
  async resolveMatchName(
    provider: MetadataProviderName,
    externalId: string,
  ): Promise<string | null> {
    const p = this.providers.find((x) => x.name === provider);
    if (!p?.enabled) return null;
    try {
      const fragment = await p.fetch({
        externalId,
        name: '',
        platform: null,
        releaseYear: null,
      });
      // Only `canonicalName` is authoritative here; running the normal
      // title-guessing heuristics on an empty name would produce junk.
      const name = (fragment as { canonicalName?: string | null })?.canonicalName;
      return name ? String(name).trim() || null : null;
    } catch (err) {
      this.logger.warn(
        `Could not resolve title for ${provider}:${externalId}: ${(err as Error)?.message}`,
      );
      return null;
    }
  }

  private pickCanonicalName(names: Partial<Record<MetadataProviderName, string>>): string | null {
    for (const provider of CANONICAL_NAME_PRIORITY) {
      const n = names[provider];
      if (n) return n;
    }
    return null;
  }

  private applyCanonicalName(
    game: GameRow,
    names: Partial<Record<MetadataProviderName, string>>,
  ): void {
    if (game.manual_override) return;
    const name = this.pickCanonicalName(names);
    if (name && name !== game.name) {
      this.db.run('UPDATE games SET name = ? WHERE id = ?', [name, game.id]);
    }
  }

  // ---------------------------------------------------------------------------

  private async fetchProvider(
    provider: MetadataProvider,
    game: GameRow,
    force: boolean,
  ): Promise<MetadataFragment> {
    // 1. Resolve a match (manual binding → cache → search).
    const binding = this.getBinding(game.id, provider.name);
    // A binding may point at an entry that carries none of what this provider is
    // here to supply — that is how a game stays unscored or duration-less even
    // after a refresh. When that happens, re-run the search instead of trusting
    // the binding; this is what lets 「刷新元数据」 backfill data that was lost or
    // never found.
    const reSearchForRating =
      !!binding && provider.name === 'metacritic' && !hasMetascore(game.ratings);
    const reSearchForDuration =
      !!binding && provider.name === 'hltb' && game.main_story_hours == null;
    const reSearch = reSearchForRating || reSearchForDuration;
    if (reSearch) {
      this.logger.log(
        `"${game.name}" still has no ${reSearchForRating ? 'Metascore' : 'completion time'}; ` +
          `re-searching ${provider.name} instead of reusing binding ${binding}.`,
      );
    }
    let match: { externalId: string; name: string; platform: string | null; releaseYear: number | null };
    if (binding && !reSearch) {
      match = { externalId: binding, name: game.name, platform: null, releaseYear: null };
    } else {
      const searchKey = `${provider.name}:search:${this.recognizer.normalize(game.name).toLowerCase()}`;
      let cached = force ? null : this.cache.get<typeof match>(searchKey);
      if (cached) {
        match = cached.data;
      } else {
        const found = await provider.search(game.name, game.platform);
        if (!found) return {};
        match = found;
        this.cache.set(searchKey, provider.name, match, provider.cacheTtlSeconds);
        this.setBinding(game.id, provider.name, found.externalId);
      }
    }

    // 2. Fetch full metadata (cache → provider).
    const fetchKey = `${provider.name}:fetch:${match.externalId}`;
    let fragment: MetadataFragment;
    let cached = force ? null : this.cache.get<MetadataFragment>(fetchKey);
    // Do not serve a cached fragment that lacks what this provider exists to
    // supply (see isCacheableFragment).
    if (cached && !this.isCacheableFragment(provider, cached.data)) cached = null;
    if (cached) {
      fragment = cached.data;
    } else {
      fragment = await provider.fetch(match);
      if (this.isCacheableFragment(provider, fragment)) {
        this.cache.set(fetchKey, provider.name, fragment, provider.cacheTtlSeconds);
      }
    }
    // Carry the provider's authoritative title so the aggregator can correct it.
    if (fragment && match.name) fragment.canonicalName = match.name;
    return fragment;
  }

  /**
   * Whether a provider fragment may be cached.
   *
   * A fragment only belongs in the cache if it carries what that provider is here
   * to supply. The completion-time sources are best-effort — HLTB re-queries its
   * own search inside `fetch()` and a transient failure leaves the timing fields
   * empty — so caching such a fragment would pin the game at "未知" for the whole
   * TTL while every non-forced refresh (a routine scan, opening the detail page)
   * kept serving the poisoned entry. That is why a single flaky request could
   * leave a game with no duration for hours even though a retry would have
   * succeeded.
   *
   * An empty fragment is never cached either: it means "the request did not
   * produce anything", which is not a fact worth remembering.
   */
  private isCacheableFragment(provider: MetadataProvider, fragment: MetadataFragment): boolean {
    if (!fragment || Object.keys(fragment).length === 0) return false;
    if (DURATION_SOURCE_PRIORITY[provider.name] != null && fragment.mainStoryHours == null) {
      return false;
    }
    return true;
  }

  private persist(game: GameRow, fragment: MetadataFragment): void {
    const names = (list: string[] | undefined) =>
      list && list.length ? JSON.stringify(uniq(list)) : null;

    // A poster the user picked by hand must survive a provider refresh; only a poster
    // we downloaded ourselves may be replaced. `null` means "keep the stored value"
    // because the UPDATE below uses COALESCE(?, poster_url).
    const storedPoster = (game.poster_url ?? '').trim();
    const posterIsUserChoice = storedPoster !== '' && !isLocalFileUrl(storedPoster);
    const poster = mergePoster(posterIsUserChoice, fragment.poster);

    // Duration is merged by SOURCE PRIORITY rather than first-writer-wins.
    // Providers persist in parallel, so plain COALESCE let RAWG's average
    // playtime beat HLTB's real completion time depending on who answered first.
    // A higher-priority source replaces; a lower-priority one only fills blanks.
    const storedDuration = this.db.get<{
      main_story_hours: number | null;
      main_extra_hours: number | null;
      completionist_hours: number | null;
      duration_source: string | null;
    }>(
      'SELECT main_story_hours, main_extra_hours, completionist_hours, duration_source FROM games WHERE id = ?',
      [game.id],
    );
    const duration = mergeDuration(storedDuration, fragment);

    this.db.run(
      `UPDATE games SET
         poster_url = COALESCE(?, poster_url),
         summary = COALESCE(?, summary),
         developers = COALESCE(?, developers),
         publishers = COALESCE(?, publishers),
         release_date = COALESCE(?, release_date),
         voice_actors = COALESCE(?, voice_actors),
         screenshots = COALESCE(?, screenshots),
         main_story_hours = ?,
         main_extra_hours = ?,
         completionist_hours = ?,
         duration_source = ?,
         ratings = COALESCE(?, ratings),
         prices = COALESCE(?, prices),
         platform = COALESCE(?, platform),
         last_meta_refresh = ?,
         updated_at = ?
       WHERE id = ?`,
      [
        poster,
        fragment.summary ?? null,
        names(fragment.developers),
        names(fragment.publishers),
        fragment.releaseDate ?? null,
        names(fragment.voiceActors),
        fragment.screenshots?.length ? JSON.stringify(fragment.screenshots) : null,
        duration.main_story_hours,
        duration.main_extra_hours,
        duration.completionist_hours,
        duration.duration_source,
        // Merge against the value currently on record rather than the snapshot
        // taken before the refresh: providers persist in parallel, so a stale
        // snapshot would let one provider undo another's write.
        mergeRatings(
          this.db.get<{ ratings: string | null }>('SELECT ratings FROM games WHERE id = ?', [game.id])
            ?.ratings ?? null,
          fragment.rating,
        ),
        fragment.price ? JSON.stringify([fragment.price]) : null,
        fragment.platforms?.[0] ?? null,
        Date.now(),
        Date.now(),
        game.id,
      ],
    );

    // Achievements (Steam). Persist even when empty so the reason a tab shows
    // nothing is recorded rather than left to guesswork.
    //
    // Skipped when the user has hand-picked an achievement target: this fragment
    // came from the *auto-matched* app, and letting it through would silently
    // replace the choice they made (the "007" case, where auto-matching lands on
    // the wrong release). `syncAchievements()` scrapes the chosen target instead.
    if (this.targets.has(game.id)) {
      // Intentionally nothing — the manual target owns the achievements table.
    } else if (fragment.achievementsError) {
      this.replaceAchievements(game.id, [], fragment.achievementsError);
    } else if (fragment.achievements) {
      this.replaceAchievements(game.id, fragment.achievements, null);
    }

    // Register the provider's artwork as first-class poster records so every
    // official image is selectable as cover and tickable in 「编辑海报」.
    //
    // Pass the PROVIDER's artwork, never whatever `poster_url` happens to hold:
    // for a game the provider has no image for, that column is the local
    // first-image fallback (`/api/media/<id>/thumbnail`), and registering it as
    // `scraped` made "取消封面" restore the user's own picture — the reported
    // "cancel does nothing". An existing non-local poster_url is genuine provider
    // artwork (a proxied provider URL included), so it is kept.
    const artwork =
      fragment.poster ??
      (game.poster_url && !isLocalFileUrl(game.poster_url) ? game.poster_url : null);
    // Register the cover AND every screenshot the provider returned. Only the
    // cover used to be registered, so the rest of the official artwork could not
    // be picked as cover or ticked even though it had been scraped. The cover goes
    // first: it is the only one allowed to claim the cover slot.
    //
    // They are registered with `in_slideshow = 0`: the detail-page hero rotates
    // the official set itself (no flag), and the home card only rotates what the
    // user ticked — so nothing is enrolled in the card automatically.
    this.posters.ensureScrapedPosters(game.id, [
      ...(artwork ? [artwork] : []),
      ...(fragment.screenshots ?? []),
    ]);
  }

  /**
   * Write the scraped 媒体评价, distinguishing "no reviews" from "did not look".
   *
   * The three outcomes the panel must be able to tell apart:
   *   - reviews found            → `ok`, rows upserted;
   *   - fetch ran, none there    → `empty`; the UI may say 「暂无媒体评价」 honestly;
   *   - Metacritic never answered→ `failed`, and **existing rows are kept**, so a
   *     transient block cannot blank a panel the user was reading.
   *
   * `provider` is null when no provider contributed reviews at all, which on a
   * disabled/unreachable Metacritic is the common case — that is recorded as
   * `failed` rather than `empty` precisely because we do not know.
   */
  private persistReviews(
    game: GameRow,
    reviews: MetadataFragment['mediaReviews'],
    provider: MetadataProviderName | null,
  ): void {
    // Only a provider that publishes critic reviews may change this game's review
    // state — in either direction.
    //
    // This guard is what stops RAWG (which returns no reviews at all) from
    // clearing another source's panel, and stops a disabled Metacritic from being
    // reported as "this game has no reviews".
    if (!REVIEW_PROVIDERS.includes(provider as MetadataProviderName)) return;
    const enabled = this.providers.some((p) => p.enabled && p.name === provider);

    try {
      const sourceUrl = this.reviewsSourceUrl(game);

      if (reviews && reviews.length > 0) {
        const { stored } = this.reviews.save(game.id, reviews, { sourceUrl });
        this.logger.log(`"${game.name}": stored ${stored} 条媒体评价 from ${provider}.`);
        return;
      }

      if (!enabled) return;

      // The provider was enabled and answered, but produced no review rows. The
      // page may genuinely list none, or the layout may have changed — either way
      // the honest state is 'empty' (the source gave us nothing).
      //
      // Recorded unconditionally, including when rows are already stored: the
      // status describes what the LAST FETCH returned, while the rows are what we
      // have. Writing the status only when there were no rows left a refreshing
      // game reporting 'ok' after an empty answer, which made the panel claim the
      // list was current.
      this.reviews.markEmpty(game.id, sourceUrl);
    } catch (err) {
      // Never let review storage abort a metadata persist.
      this.logger.warn(`Storing 媒体评价 failed for "${game.name}": ${(err as Error)?.message}`);
    }
  }

  /**
   * The Metacritic page the reviews came from, for the panel's source link.
   *
   * Resolved from the stored binding rather than threaded through the provider
   * interface, which keeps `MetadataFragment` free of transport detail.
   */
  private reviewsSourceUrl(game: GameRow): string | null {
    const provider = this.providers.find(
      (p) => REVIEW_PROVIDERS.includes(p.name as MetadataProviderName),
    );
    if (!provider?.sourceUrl) return null;

    const link = this.db.get<{ external_id: string }>(
      "SELECT external_id FROM game_links WHERE game_id = ? AND provider = 'metacritic'",
      [game.id],
    );
    if (!link?.external_id) return null;

    // Ask the provider rather than composing the URL here: the provider knows
    // which origin it actually reads from, so the link cannot drift from it
    // (and a self-hosted/alternate origin does not produce a link to a site the
    // user cannot reach).
    return provider.sourceUrl({ externalId: link.external_id });
  }

  /**
   * Replace a game's Steam achievement rows and record the scrape outcome.
   *
   * Rows are only written when the scrape actually returned some, and existing
   * rows are deliberately KEPT on failure: `achievements.view.ts` reads a
   * 'failed' status with rows present as "ok but stale" so the tab can warn
   * instead of hiding a list the user could still read. Deleting here would make
   * that branch unreachable.
   *
   * An empty list with no error is a legitimate "this app has no achievements"
   * and is recorded as `empty` so the tab can say so rather than showing nothing.
   */
  private replaceAchievements(
    gameId: string,
    achievements: AchievementData[],
    error: string | null,
  ): void {
    if (!error && achievements.length) {
      storeAchievements(this.db, gameId, 'steam', achievements);
    }
    this.setAchievementStatus(
      gameId,
      error ? 'failed' : achievements.length ? 'ok' : 'empty',
      error,
    );
  }
}

/**
 * Fold one provider's fragment into the aggregate for a game.
 *
 * Scalar fields are first-wins — the provider list is ordered by trust — while
 * list fields accumulate so several sources can each contribute (one source may
 * know the developers, another the screenshots).
 *
 * Duration is the exception and is folded BY SOURCE PRIORITY: providers are
 * fetched in parallel, so first-wins would hand the aggregate to whichever
 * request happened to return first and could let RAWG's average playtime beat
 * HowLongToBeat's measured main-story time.
 */
function merge(target: MetadataFragment, src: MetadataFragment): void {
  if (!target.summary && src.summary) target.summary = src.summary;
  if (!target.poster && src.poster) target.poster = src.poster;
  if (!target.releaseDate && src.releaseDate) target.releaseDate = src.releaseDate;

  target.developers = [...(target.developers ?? []), ...(src.developers ?? [])];
  target.publishers = [...(target.publishers ?? []), ...(src.publishers ?? [])];
  target.platforms = [...(target.platforms ?? []), ...(src.platforms ?? [])];
  target.voiceActors = [...(target.voiceActors ?? []), ...(src.voiceActors ?? [])];
  target.screenshots = [...(target.screenshots ?? []), ...(src.screenshots ?? [])];

  // 媒体评价 accumulate like the other list fields: only Metacritic supplies them
  // today, but a second review aggregator should add to the panel rather than be
  // discarded by first-wins. Deduplication happens at the storage boundary
  // (MediaReviewsService.normalise), keyed on outlet+url.
  if (src.mediaReviews?.length) {
    target.mediaReviews = [...(target.mediaReviews ?? []), ...src.mediaReviews];
  }

  if (src.rating != null && target.rating == null) target.rating = src.rating;
  if (src.price != null && target.price == null) target.price = src.price;

  if (src.achievements && !target.achievements) target.achievements = src.achievements;
  if (src.achievementsError && !target.achievementsError) {
    target.achievementsError = src.achievementsError;
  }

  const srcRank = src.durationSource ? (DURATION_SOURCE_PRIORITY[src.durationSource] ?? 0) : 0;
  const curRank = target.durationSource
    ? (DURATION_SOURCE_PRIORITY[target.durationSource] ?? 0)
    : -1;
  const srcHasDuration =
    src.mainStoryHours != null ||
    src.mainExtraHours != null ||
    src.completionistHours != null;

  if (srcHasDuration && srcRank >= curRank) {
    // Better or equal source: refresh each field, keeping anything it omits.
    target.mainStoryHours = src.mainStoryHours ?? target.mainStoryHours ?? null;
    target.mainExtraHours = src.mainExtraHours ?? target.mainExtraHours ?? null;
    target.completionistHours = src.completionistHours ?? target.completionistHours ?? null;
    target.durationSource = src.durationSource ?? target.durationSource;
  } else {
    // Weaker source (or none declared): only fill the gaps.
    if (target.mainStoryHours == null) target.mainStoryHours = src.mainStoryHours ?? null;
    if (target.mainExtraHours == null) target.mainExtraHours = src.mainExtraHours ?? null;
    if (target.completionistHours == null) target.completionistHours = src.completionistHours ?? null;
    if (!target.durationSource && src.durationSource) target.durationSource = src.durationSource;
  }
}

function uniq(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}