/**
 * Games read model: summarizes/detail views over the scanned + enriched data.
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import fs from 'fs-extra';
import { DatabaseService } from '../database/database.service';
import { MediaService } from '../media/media.service';
import { MetadataService } from '../metadata/metadata.service';
import { buildAchievementsPayload } from './achievements.view';
import { AchievementTargetService } from '../trophies/achievement-target.service';
import { RatingTargetService } from '../metadata/rating-target.service';
import { MetadataProviderName } from '../metadata/provider.interface';
import { DURATION_SOURCE_ORDER } from '../metadata/metadata-merge';
import { titleQueryVariants } from '../metadata/providers/metacritic-aliases';
import { formatDurationText } from '../library/duration.service';
import { toProxiedImageUrl } from '../common/image-url';
import { parseStringArray, platformsOfRow } from '../common/game-row';
import { PostersService } from './posters.service';
import { MediaReviewsService } from './media-reviews.service';

/** Spacing between hand-set gallery positions; midpoints fill the gaps. */
const ORDER_GAP = 1024;

export interface GameFilters {
  search?: string;
  platform?: string;
  sort?: 'name' | 'created' | 'duration' | 'mediaCount' | 'metacritic' | 'custom';
  order?: 'asc' | 'desc';
  yearMin?: number;
  yearMax?: number;
  minScore?: number;
  maxScore?: number;
  page?: number;
  pageSize?: number;
}

/** Platforms offered in the detail page's multi-select. */
export const KNOWN_PLATFORMS = [
  'PC',
  'PlayStation 5',
  'PlayStation 4',
  'PlayStation 3',
  'Xbox Series X|S',
  'Xbox One',
  'Nintendo Switch',
  'Nintendo Switch 2',
  'Steam Deck',
  'macOS',
  'Linux',
  'iOS',
  'Android',
  '其他',
] as const;

interface GameRow {
  id: string;
  folder_name: string;
  folder_path: string;
  name: string;
  platform: string | null;
  aliases: string;
  manual_override: number;
  first_played_at: number | null;
  last_played_at: number | null;
  duration_seconds: number;
  main_duration_seconds: number | null;
  completionist_duration_seconds: number | null;
  poster_url: string | null;
  summary: string | null;
  developers: string;
  publishers: string;
  release_date: string | null;
  voice_actors: string;
  screenshots: string;
  main_story_hours: number | null;
  main_extra_hours: number | null;
  completionist_hours: number | null;
  ratings: string;
  prices: string;
  last_meta_refresh: number | null;
  meta_error: string | null;
  /** JSON array of user-chosen platforms (feature 6). */
  platforms?: string;
  /** Achievement/trophy scrape state (see achievements.view.ts). */
  duration_source?: string | null;
  custom_order?: number | null;
  achievements_status?: string | null;
  achievements_error?: string | null;
  last_achievements_refresh?: number | null;
  trophy_source?: string | null;
  poster_mode?: string | null;
  custom_platform?: number;
  /** 媒体评价 scrape state (see MediaReviewsService). */
  reviews_fetched_at?: number | null;
  reviews_status?: string | null;
  reviews_error?: string | null;
  reviews_source_url?: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Rows that still have no Metacritic score. Ratings live as a JSON array in
 * `ratings` (there is no separate score column), so "missing a score" means no
 * ratings entry carries a non-null metascore. COALESCE keeps NULL blobs.
 */
/** Chinese labels for the fields a match can fail to retrieve. */
const FIELD_LABELS: Record<string, string> = {
  poster: '海报',
  summary: '简介',
  developers: '开发商',
  rating: '评分',
  screenshots: '截图',
};

const MISSING_RATING_SQL = `SELECT id, name FROM games
   WHERE COALESCE(ratings, '[]') = '[]'
      OR ratings NOT LIKE '%"metascore":%'`;

/**
 * Games with no average completion time yet.
 *
 * Completion-time lookups are the flakiest part of a scrape (the upstream service
 * is rate-limited and often unreachable through a proxy), so a single sweep
 * always leaves stragglers. This is the selector the retry passes work from.
 */
const MISSING_DURATION_SQL = `SELECT id, name FROM games WHERE main_story_hours IS NULL`;

/**
 * Games whose completion time could still be improved.
 *
 * Either there is none at all, or it came from a lower-priority source. RAWG's
 * `playtime` is an average of how long everyone played, not how long the story
 * takes — measured on this library, Hades reads 10h from RAWG versus 23.6h of
 * actual main-story time from HLTB. So a source that merely filled a gap should
 * keep being retried until the authoritative one answers.
 */
const IMPROVABLE_DURATION_SQL = `SELECT id, name FROM games
   WHERE main_story_hours IS NULL
      OR COALESCE(duration_source, '') <> '${DURATION_SOURCE_ORDER[0]}'`;

/**
 * How many sequential retry rounds a bulk job runs for stragglers.
 *
 * Chosen from measurement rather than taste: with roughly a 50% per-attempt
 * success rate, three rounds lift coverage from ~50% to ~87%.
 */
const RETRY_ROUNDS = 3;

@Injectable()
export class GamesService {
  private readonly logger = new Logger(GamesService.name);
  private bulkProgress: {
    running: boolean;
    total: number;
    done: number;
    current: string | null;
    /**
     * Which job is running (「刷新元数据」/「补全通关时长」…).
     *
     * The settings page shows one progress bar for every bulk job, and without
     * this the user could not tell a duration backfill from a full re-scrape —
     * they look identical but take very different amounts of time.
     */
    label: string | null;
  } = {
    running: false,
    total: 0,
    done: 0,
    current: null,
    label: null,
  };

  constructor(
    private readonly db: DatabaseService,
    private readonly media: MediaService,
    private readonly metadata: MetadataService,
    private readonly posters: PostersService,
    private readonly targets: AchievementTargetService,
    private readonly ratingTargets: RatingTargetService,
    /** 媒体评价 storage — read for the detail payload, written by the backfill. */
    private readonly reviews: MediaReviewsService,
  ) {}

  /**
   * Every registered poster URL for a game — the **card / gallery** set.
   *
   * This deliberately returns the full set rather than the `in_slideshow` subset.
   * It used to return only the slideshow rows, which conflated two different
   * things and produced the reported defect 「编辑海报的轮播设置控制的是首页图库
   * 卡片轮播，而不是详情页的大图轮播」: because the gallery card consumed this
   * field, unticking a poster in 「编辑海报」changed *which pictures the card
   * could show*, while the detail page's large carousel — the thing the checkbox
   * is supposed to curate — was not what the user was watching change.
   *
   * The two carousels are now separated by data source, not just by intent:
   *
   *   - **首页图库卡片** (`GameCard`) → this field: cover first, then every
   *     registered poster. Browsable with its arrows; auto-advances only according
   *     to the game's 展现模式 (`posterMode`).
   *   - **详情页大图区** (`HeroPosterCarousel`) → `posterList` filtered on
   *     `inSlideshow`, i.e. exactly what 「编辑海报」shows ticked, plus the cover.
   *
   * So ticking/unticking a poster changes the detail-page carousel and leaves the
   * card set alone, and the two can no longer drift in or out of sync by accident.
   */
  private slideshowPosters(r: GameRow): string[] {
    const rows = this.db.all<{ url: string; source: string; id: string; media_id: string | null }>(
      // No `in_slideshow` filter here — see the docblock: this is the card set.
      // Cover first so it is always the frame the gallery shows.
      `SELECT id, url, source, media_id FROM game_posters
        WHERE game_id = ?
        ORDER BY is_selected DESC, sort_order ASC, created_at ASC`,
      [r.id],
    );
    const uniq: string[] = [];
    const seenMedia = new Set<string>();
    for (const p of rows) {
      // A media poster, the scraped poster seeded from `games.poster_url`, and
      // the album thumbnail can all point at the *same* underlying image
      // (/api/media/<id>/thumbnail vs /api/media/<id>/preview). Dedupe on the
      // media id, not on the row, so the rotation never repeats a picture.
      const url = p.source === 'upload' ? `/api/posters/${p.id}/image` : p.url;
      if (!url) continue;
      const mediaKey = p.media_id ?? mediaIdFromUrl(url);
      if (mediaKey) {
        if (seenMedia.has(mediaKey)) continue;
        seenMedia.add(mediaKey);
      }
      const proxied = this.proxyImage(url) ?? url;
      if (uniq.includes(proxied)) continue;
      uniq.push(proxied);
    }
    // Never return an empty list when the game does have a poster, otherwise
    // slideshow mode would render nothing.
    if (uniq.length === 0 && r.poster_url) {
      const fb = this.proxyImage(r.poster_url) ?? r.poster_url;
      if (fb) uniq.push(fb);
    }
    return uniq;
  }

  list(filters: GameFilters): object[] {
    const sorted = this.arrange(filters);
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 50));
    return sorted.slice((page - 1) * pageSize, page * pageSize);
  }

  /** Every game matching the filters, in gallery order (no pagination). */
  private arrange(filters: GameFilters): Record<string, unknown>[] {
    const rows = this.db.all<GameRow>('SELECT * FROM games');
    const summaries = rows
      .filter((r) => this.matchesFilters(r, filters))
      .map((r) => this.toSummary(r));
    return this.sort(summaries, filters.sort ?? 'name', filters.order ?? 'asc');
  }

  /**
   * The games either side of `id` in the current gallery order.
   *
   * Computed here rather than in the browser so the result is exact for any
   * library size: the gallery list is paginated and capped at 100 rows per
   * request, so a client that only knew about the loaded page would stop
   * navigating at page boundaries and would ignore the rows a filter hides.
   *
   * Navigation wraps around, so the buttons never go dead at either end.
   */
  neighbors(
    id: string,
    filters: GameFilters,
  ): {
    prev: { id: string; name: string } | null;
    next: { id: string; name: string } | null;
    index: number;
    total: number;
  } {
    const sorted = this.arrange(filters);
    const index = sorted.findIndex((g) => g.id === id);
    // Either the game is hidden by the active filters, or it no longer exists.
    if (index === -1) return { prev: null, next: null, index: -1, total: sorted.length };

    const brief = (g: Record<string, unknown> | undefined) =>
      g ? { id: String(g.id), name: String(g.name) } : null;

    return {
      prev: brief(sorted[(index - 1 + sorted.length) % sorted.length]),
      next: brief(sorted[(index + 1) % sorted.length]),
      index,
      total: sorted.length,
    };
  }

  async detail(id: string, refresh = false): Promise<object> {
    const row = this.db.get<GameRow>('SELECT * FROM games WHERE id = ?', [id]);
    if (!row) throw new NotFoundException('Game not found');

    if (refresh) {
      await this.metadata.refreshGame(id);
    } else if (row.last_meta_refresh == null) {
      // First view: fetch metadata eagerly so the detail page isn't empty.
      await this.metadata.enrichGame(id);
    }

    const fresh = this.db.get<GameRow>('SELECT * FROM games WHERE id = ?', [id])!;
    return this.toDetail(fresh);
  }

  /**
   * Metacritic entries the user can pick from for this game's score.
   *
   * Returns one row per平台 entry — the same title scores differently on PC / PS5
   * / Xbox / Switch, and each is a separate Metacritic page. The score, platform
   * and release date all come from the search result card, so no per-candidate
   * page fetch is needed.
   */
  async ratingCandidates(id: string, query?: string): Promise<object> {
    const row = this.db.get<GameRow>('SELECT * FROM games WHERE id = ?', [id]);
    if (!row) throw new NotFoundException('Game not found');

    const keyword = (query ?? '').trim() || row.name;
    const matches = await this.metadata.searchProvider('metacritic', keyword);
    const current = this.ratingTargets.get(id);

    return {
      query: keyword,
      current: current
        ? {
            externalId: current.externalId,
            name: current.name,
            platform: current.platform,
            metascore: current.metascore,
            releaseDate: current.releaseDate,
          }
        : null,
      // Surface the score the game shows right now, so the dialog can explain
      // what it is replacing.
      automatic: (() => {
        const auto = firstRating(row.ratings);
        return auto ? { metascore: auto.metascore, criticCount: auto.criticCount } : null;
      })(),
      candidates: matches.map((m) => ({
        externalId: m.externalId,
        name: m.name,
        platform: m.platform,
        metascore: m.metascore ?? null,
        releaseDate: m.releaseDate ?? null,
      })),
    };
  }

  /** Persist the user's chosen Metacritic entry for this game's score. */
  async setRatingTarget(
    id: string,
    body: {
      externalId: string;
      name?: string;
      platform?: string | null;
      metascore?: number | null;
      releaseDate?: string | null;
      criticCount?: number | null;
    },
  ): Promise<object> {
    const row = this.db.get<GameRow>('SELECT id FROM games WHERE id = ?', [id]);
    if (!row) throw new NotFoundException('Game not found');
    if (!body?.externalId) throw new BadRequestException('缺少要绑定的评分条目 id');

    // When the score was not supplied (e.g. the card carried none), read it from
    // the entry itself rather than storing a blank override that hides the badge.
    let metascore = body.metascore ?? null;
    let criticCount = body.criticCount ?? null;
    if (metascore == null) {
      const found = await this.metadata.searchProvider('metacritic', body.name ?? body.externalId);
      const hit = found.find((m) => m.externalId === body.externalId);
      if (hit) {
        metascore = hit.metascore ?? null;
        metascore = metascore ?? null;
      }
    }
    if (metascore == null) {
      throw new BadRequestException(
        '该条目没有 Metacritic 媒体评分，无法作为评分来源。请改选带分数的条目，' +
          '或使用「恢复自动匹配」。',
      );
    }

    this.ratingTargets.set(id, {
      source: 'metacritic',
      externalId: body.externalId,
      name: body.name ?? null,
      platform: body.platform ?? null,
      metascore,
      criticCount,
      releaseDate: body.releaseDate ?? null,
    });
    const fresh = this.db.get<GameRow>('SELECT * FROM games WHERE id = ?', [id])!;
    return this.toDetail(fresh);
  }

  /** Drop the override so the game follows automatic matching again. */
  clearRatingTarget(id: string): object {
    const row = this.db.get<GameRow>('SELECT * FROM games WHERE id = ?', [id]);
    if (!row) throw new NotFoundException('Game not found');
    this.ratingTargets.clear(id);
    const fresh = this.db.get<GameRow>('SELECT * FROM games WHERE id = ?', [id])!;
    return this.toDetail(fresh);
  }

  /** Force refresh of (optionally a subset of) metadata providers. */
  async refresh(id: string, only?: MetadataProviderName[]): Promise<void> {
    const row = this.db.get<GameRow>('SELECT id FROM games WHERE id = ?', [id]);
    if (!row) throw new NotFoundException('Game not found');
    await this.metadata.refreshGame(id, only);
  }

  /**
   * Re-scrape achievements/trophies for one game and return the fresh payload.
   *
   * Returns the same shape as `GET /api/achievements/:gameId`, so the tab can
   * re-render straight from the response with no second request.
   */
  async refreshAchievements(id: string): Promise<object> {
    const row = this.db.get<GameRow>('SELECT id FROM games WHERE id = ?', [id]);
    if (!row) throw new NotFoundException('Game not found');
    await this.metadata.refreshAchievements(id);
    return buildAchievementsPayload(this.db, id);
  }

  /**
   * Search every achievement source for entries matching `query`.
   *
   * Backs the 「手动选择游戏」 picker on the achievements tab.
   */
  async searchAchievementTargets(query: string): Promise<object[]> {
    return this.metadata.searchAchievementTargets(query);
  }

  /** The hand-picked achievement target, or null when the game is on auto. */
  async getAchievementTarget(id: string): Promise<object | null> {
    return this.targets.get(id);
  }

  /**
   * Save a hand-picked achievement target and immediately re-scrape from it, so
   * the tab updates in one round trip.
   *
   * The choice is persisted, so every later full scrape and single-game refresh
   * keeps using it instead of reverting to automatic matching.
   */
  async setAchievementTarget(
    id: string,
    source: string,
    externalId: string,
    name?: string | null,
  ): Promise<object> {
    const row = this.db.get<GameRow>('SELECT id FROM games WHERE id = ?', [id]);
    if (!row) throw new NotFoundException('Game not found');
    this.targets.set(id, source, externalId, name ?? null);
    await this.metadata.refreshAchievements(id);
    return buildAchievementsPayload(this.db, id);
  }

  /** Drop the manual choice and return the game to automatic matching. */
  async clearAchievementTarget(id: string): Promise<object> {
    const row = this.db.get<GameRow>('SELECT id FROM games WHERE id = ?', [id]);
    if (!row) throw new NotFoundException('Game not found');
    this.targets.clear(id);
    this.db.run(
      `UPDATE games SET achievements_status = NULL, achievements_error = NULL WHERE id = ?`,
      [id],
    );
    return buildAchievementsPayload(this.db, id);
  }

  /** Re-scrape metadata for every game (used right after API keys are set). */
  async refreshAll(): Promise<{ started: boolean; total: number }> {
    // Stragglers after a full scrape are almost always completion times — the
    // flakiest source — so the tail pass targets exactly those, and only re-runs
    // the duration providers rather than re-scraping everything.
    return this.runBulk(
      'SELECT id, name FROM games',
      'Bulk metadata refresh',
      undefined,
      false,
      MISSING_DURATION_SQL,
      DURATION_SOURCE_ORDER,
    );
  }

  /**
   * Re-attempt the completion time for every game that still has none.
   *
   * Fixing the duration providers does not by itself repair an existing library:
   * a game whose `last_meta_refresh` is already set is not re-scraped by a scan,
   * so games that failed while the source was unreachable would keep showing
   * 「未知」 forever. This runs only the duration sources, which is far cheaper
   * than a full refresh.
   */
  async backfillDurations(): Promise<{ started: boolean; total: number }> {
    return this.runBulk(
      IMPROVABLE_DURATION_SQL,
      'Completion-time backfill',
      DURATION_SOURCE_ORDER,
      // Drop the stored binding: it may point at an entry with no timings, and a
      // fresh search is what finds the one that has them.
      true,
      IMPROVABLE_DURATION_SQL,
      DURATION_SOURCE_ORDER,
    );
  }

  /**
   * How many games currently show a completion time, and how many do not.
   *
   * The settings page renders 「一键批量补全」 with this, so the user can see that
   * the button is worth pressing (and that it worked) without reading the log.
   * `missing` uses the same predicate as the backfill itself, so the number the
   * button reports is exactly the number of rows the job will touch.
   */
  durationCoverage(): {
    total: number;
    withDuration: number;
    missing: number;
    nextToTry: string[];
    sources: { source: string; count: number }[];
  } {
    const total = this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM games')?.c ?? 0;
    const withDuration =
      this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM games WHERE main_story_hours IS NOT NULL')
        ?.c ?? 0;
    const missing =
      this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM (${IMPROVABLE_DURATION_SQL})`)?.c ?? 0;
    const nextToTry = this.db
      .all<{ name: string }>(`${IMPROVABLE_DURATION_SQL} ORDER BY name ASC LIMIT 10`)
      .map((r) => r.name);
    const sources = this.db
      .all<{ source: string | null; count: number }>(
        `SELECT COALESCE(duration_source, 'unknown') AS source, COUNT(*) AS count
           FROM games WHERE main_story_hours IS NOT NULL GROUP BY source ORDER BY count DESC`,
      )
      .map((r) => ({ source: r.source ?? 'unknown', count: r.count }));
    return { total, withDuration, missing, nextToTry, sources };
  }

  /**
   * Backfill games that are missing a Metacritic score.
   *
   * Fixing the Metacritic provider does not by itself repair an existing
   * library: a game whose `last_meta_refresh` is already set is never re-scraped
   * by a scan, so previously-failed entries would keep showing no score forever.
   * This re-runs only the `metacritic` provider for the games that still have no
   * score — far cheaper than refreshAll(), and it also clears the stale
   * provider binding that the buggy matcher may have written.
   */
  async backfillRatings(): Promise<{ started: boolean; total: number }> {
    return this.runBulk(
      // Ratings live as a JSON array in `ratings` (there is no separate score
      // column), so "missing a score" means no ratings entry carries a non-null
      // metascore. COALESCE keeps rows with a NULL ratings blob.
      MISSING_RATING_SQL,
      'Metacritic backfill',
      ['metacritic'],
      true,
      MISSING_RATING_SQL,
    );
  }

  /**
   * Batch-fill 媒体评价 (critic reviews) — `POST /api/games/backfill-ratings`.
   *
   * Runs the review source for one game at a time and returns per-game results,
   * rather than the fire-and-forget `{ started: true }` the other backfills use.
   * Three reasons:
   *   1. the caller needs to know WHICH games still have nothing, and whether the
   *      reason was "no reviews exist" or "the source blocked us" — those need
   *      different reactions from the user;
   *   2. the source is a rate-limited website, so inherent serialisation is a
   *      feature (the shared per-origin limiter enforces the interval);
   *   3. it bounds the work, so the request cannot fan out over a large library.
   *
   * `scope`:
   *   - `missing` (default) skips games already holding reviews, so pressing the
   *     button twice is cheap and does not re-fetch settled games;
   *   - `all` re-fetches every game, for after a parser fix — this is the mode that
   *     repairs libraries scraped while reviews were still unimplemented.
   */
  async backfillRatingsBatch(opts: { limit?: number; scope?: 'missing' | 'all' } = {}): Promise<{
    processed: number;
    gained: number;
    reviewsStored: number;
    failed: number;
    skipped: number;
    remaining: number;
    total: number;
    results: { id: string; name: string; status: string; count: number; error: string | null }[];
  }> {
    const scope = opts.scope === 'all' ? 'all' : 'missing';
    const limit = Number.isFinite(opts.limit) && (opts.limit as number) > 0 ? Math.floor(opts.limit as number) : 0;

    // `missing` = every game the source has NOT yet answered for.
    //
    //   - never attempted   → fetch it;
    //   - last attempt failed → a transient block is worth retrying;
    //   - no bound source entry → nothing to fetch, but it is cheap: the binding
    //     check short-circuits BEFORE any network request, so re-visiting these
    //     costs nothing except a loop iteration. Including them is what lets the
    //     "待补全" count on the settings card actually reach zero after a run —
    //     the alternative is a number the button can never clear, which reads as a
    //     broken feature even though the behaviour is correct;
    //   - `empty` / `ok` are excluded: the source already answered, and re-asking a
    //     rate-limited site the same question is pure waste.
    //
    // The SAME filter is used by `MediaReviewsService.coverage().awaiting`, and the
    // two must stay in step (see the comment there).
    const candidates = this.db
      .all<{ id: string; name: string }>(
        scope === 'all'
          ? 'SELECT id, name FROM games ORDER BY updated_at DESC, name ASC'
          : `SELECT id, name FROM games
               WHERE reviews_fetched_at IS NULL
                  OR reviews_status IN ('failed','unsupported')
               ORDER BY updated_at DESC, name ASC`,
      )
      .slice(0, limit > 0 ? limit : undefined);

    const total = this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM games')?.c ?? 0;
    const results: { id: string; name: string; status: string; count: number; error: string | null }[] = [];
    let gained = 0;
    let reviewsStored = 0;
    let failed = 0;
    let skipped = 0;

    for (const game of candidates) {
      const before = this.reviews.count(game.id);
      const outcome = await this.metadata.refreshReviews(game.id);
      const after = this.reviews.count(game.id);

      if (outcome.status === 'skipped') skipped += 1;
      else if (outcome.status === 'failed') failed += 1;

      const added = after - before;
      if (added > 0) {
        gained += 1;
        reviewsStored += added;
      }

      results.push({
        id: game.id,
        name: game.name,
        status: outcome.status,
        count: after,
        error: outcome.error,
      });
    }

    // Same expression as `coverage().awaiting` and as the candidate query above,
    // so "still missing" after a run equals what another run would visit.
    const remaining =
      this.db.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM games
           WHERE reviews_fetched_at IS NULL OR reviews_status IN ('failed','unsupported')`,
      )?.c ?? 0;

    this.logger.log(
      `媒体评价 backfill (${scope}): ${candidates.length} 个游戏，` +
        `${gained} 个新增评价，共 ${reviewsStored} 条，${failed} 个失败，${skipped} 个跳过。`,
    );

    return {
      processed: candidates.length,
      gained,
      reviewsStored,
      failed,
      skipped,
      remaining,
      total,
      results,
    };
  }

  /**
   * 媒体评价 for one game — the panel's own read endpoint.
   *
   * Exists alongside the detail payload so the panel can refresh itself after a
   * backfill without re-fetching the whole game (posters, achievements, media).
   */
  mediaReviewsFor(id: string): {
    reviews: ReturnType<MediaReviewsService['list']>;
    summary: ReturnType<MediaReviewsService['summary']>;
  } {
    this.assertExists(id);
    return { reviews: this.reviews.list(id), summary: this.reviews.summary(id) };
  }

  /** Re-fetch 媒体评价 for a single game (the panel's refresh button). */
  async refreshMediaReviews(id: string): Promise<object> {
    this.assertExists(id);
    const outcome = await this.metadata.refreshReviews(id);
    return { ...outcome, summary: this.reviews.summary(id) };
  }

  /**
   * 媒体评价 coverage for the settings card.
   *
   * `missing` is the number of games the 「补全媒体评价」 button would actually
   * visit, so the number on the card matches the work the job does — the same
   * contract the duration-coverage card follows.
   */
  mediaReviewsCoverage(): {
    total: number;
    withReviews: number;
    awaiting: number;
    failed: number;
    lastFetchedAt: number | null;
    nextToTry: string[];
  } {
    const base = this.reviews.coverage();
    const nextToTry = this.db
      .all<{ name: string }>(
        `SELECT name FROM games
           WHERE NOT EXISTS (SELECT 1 FROM media_reviews r WHERE r.game_id = games.id)
             AND COALESCE(reviews_status, '') NOT IN ('empty')
           ORDER BY name ASC LIMIT 10`,
      )
      .map((r) => r.name);
    return { ...base, nextToTry };
  }

  /** Throw a 404 with the same wording the rest of the API uses. */
  private assertExists(id: string): void {
    const row = this.db.get<{ id: string }>('SELECT id FROM games WHERE id = ?', [id]);
    if (!row) throw new NotFoundException('Game not found');
  }

  /** Shared bulk-refresh worker for refreshAll() and backfillRatings(). */
  private runBulk(
    sql: string,
    label: string,
    only?: MetadataProviderName[],
    clearBinding = false,
    /** Query selecting the rows that are still missing data, for the retry pass. */
    retrySql?: string,
    /** Providers the retry pass should run; defaults to the same set as the main pass. */
    retryOnly?: MetadataProviderName[],
  ): { started: boolean; total: number } {
    const rows = this.db.all<{ id: string; name: string }>(sql);
    const total = rows.length;
    this.bulkProgress = { running: true, total, done: 0, current: null, label };
    this.logger.log(`${label} started (${total} games)`);

    const CONCURRENCY = 4;
    void (async () => {
      let index = 0;
      const worker = async () => {
        while (index < rows.length) {
          const row = rows[index++];
          this.bulkProgress.current = row.name;
          try {
            // A binding created by the old buggy matcher would be reused as-is,
            // so drop it to force a fresh search.
            if (clearBinding && only) {
              for (const provider of only) this.metadata.clearBinding(row.id, provider);
            }
            await this.metadata.refreshGame(row.id, only);
          } catch (err) {
            this.logger.warn(`${label} failed for ${row.id} (${row.name}): ${(err as Error)?.message}`);
          }
          this.bulkProgress.done += 1;
          if (this.bulkProgress.done % 10 === 0) {
            this.logger.log(`${label} progress ${this.bulkProgress.done}/${total}`);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker()));

      // Second pass: a handful of games can still fail on a transient network
      // or proxy error (observed: 4 of 39 after one pass, 3 of which succeeded
      // immediately on retry). Re-run only the ones that are STILL missing a
      // score, sequentially, so a bulk refresh does not leave stragglers.
      if (retrySql) {
        // Several rounds, because a single retry is not enough when the upstream
        // service is merely flaky: measured against this deployment's proxy, a
        // completion-time lookup succeeds roughly half the time, so three rounds
        // take a batch from ~50% to ~85%+ covered. Rounds stop early once a pass
        // recovers nothing.
        const source = retryOnly ?? only;
        for (let round = 1; round <= RETRY_ROUNDS; round += 1) {
          const recovered = await this.retryPass(retrySql, label, source, round);
          if (recovered) this.logger.log(`${label} retry pass ${round} recovered ${recovered} game(s)`);
          if (!recovered) break;
        }
      }

      this.bulkProgress.running = false;
      this.bulkProgress.current = null;
      this.bulkProgress.label = null;
      this.logger.log(`${label} finished (${total} games)`);
    })();
    return { started: true, total };
  }

  /**
   * Sequentially retry the games that are still missing a Metacritic score
   * after the concurrent pass. Returns how many were recovered.
   */
  private async retryPass(
    sql: string,
    label: string,
    only?: MetadataProviderName[],
    round = 1,
  ): Promise<number> {
    let rows: { id: string; name: string }[];
    try {
      rows = this.db.all<{ id: string; name: string }>(sql);
    } catch {
      return 0;
    }
    let recovered = 0;
    for (const row of rows) {
      this.bulkProgress.current = `重试(${round}) ${row.name}`;
      try {
        await this.metadata.refreshGame(row.id, only);
        recovered += 1;
      } catch (err) {
        this.logger.warn(`${label} retry failed for ${row.name}: ${(err as Error)?.message}`);
      }
    }
    return recovered;
  }

  metadataStatus(): object {
    const failed =
      this.db.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM games WHERE meta_error IS NOT NULL AND meta_error != ''`,
      )?.c ?? 0;
    return { ...this.bulkProgress, failed };
  }

  /** Search candidate matches across providers for the manual-match dialog. */
  searchMatches(query: string): Promise<object[]> {
    return this.metadata.search(query);
  }

  /**
   * Bind a game to an external id and re-scrape it.
   *
   * Refreshing ONLY the bound provider (the previous behaviour) left every other
   * provider's data in place, so after binding to a different game the summary
   * and developers would switch while the name, rating, poster and screenshots
   * kept pointing at the old title — the reported "绑定不生效".
   *
   * The whole point of a manual match is "this game is actually THAT game", so
   * the old identity's data must be replaced wholesale:
   *  1. drop every provider binding (the stale ones now describe another title),
   *  2. keep the new binding for the chosen provider,
   *  3. clear the old identity's metadata fields so nothing stale survives a
   *     provider that fails to return a replacement value,
   *  4. save the manual name so a full refresh re-searches from the right title,
   *  5. refresh every enabled provider.
   */
  async match(
    id: string,
    provider: MetadataProviderName,
    externalId: string,
  ): Promise<{
    matched: boolean;
    name: string;
    providers: string[];
    failed: string[];
    /** Fields no provider could supply, so the UI can explain a partial result. */
    missing: string[];
    /** Human-readable reason, empty on a complete match. */
    reason: string;
  }> {
    const row = this.db.get<GameRow>('SELECT * FROM games WHERE id = ?', [id]);
    if (!row) throw new NotFoundException('Game not found');

    // 1. Ask the provider who this entity actually is, so the game is renamed
    //    to the matched title before the full refresh re-searches with it.
    //
    //    A null result means the provider could not describe this id at all
    //    (deleted entry, wrong id, truncated search result). Falling back to the
    //    old name in that case silently kept the previous game's identity while
    //    reporting success — the reported "匹配失败但没提示". Fail loudly
    //    instead, before anything is mutated.
    const matchedName = await this.metadata.resolveMatchName(provider, externalId);
    if (!matchedName) {
      // Say WHY it failed and what to try instead. The previous message named
      // neither, so a user hitting it had nothing to act on: the usual causes are
      // an id from another platform's edition, or a query whose wording the
      // source does not index.
      const hints = titleQueryVariants(row.name)
        .filter((h) => h !== row.name)
        .slice(0, 3);
      throw new BadRequestException(
        `无法在 ${provider} 上读取该条目（id=${externalId}），已取消绑定。` +
          `常见原因：该条目已被站点下架，或这个 id 属于另一个平台的版本。` +
          (hints.length
            ? `可换个关键词再搜：${hints.map((h) => `「${h}」`).join('、')}。`
            : `请换个关键词重新搜索，或改选其它数据源的条目。`),
      );
    }
    const newName = matchedName.trim();

    // 2. Rebind from scratch: stale bindings describe the OLD game.
    const providers = this.metadata.enabledProviderNames();
    for (const name of providers) this.metadata.clearBinding(id, name);
    this.metadata.setBinding(id, provider, externalId);

    // 3. Clear identity-bearing fields. Anything a provider fails to refill
    //    stays empty rather than silently showing the previous game's data.
    //
    //    Ratings are the exception, and are guarded: `ratings = '[]'` below is a
    //    deliberate replace, but if the refresh that follows cannot obtain a new
    //    Metascore (provider blocked, proxy flaky, page changed) the previous
    //    valid score is put back rather than silently lost — the reported symptom
    //    was the M站 score badge disappearing after a manual match. The snapshot
    //    has to be taken HERE, before the clear, because `refreshGame()` takes its
    //    own snapshot at entry — by then the value would already be gone.
    const ratingSnapshot = this.metadata.snapshotRatings(id);
    this.db.run(
      `UPDATE games SET
         name = ?, summary = NULL, poster_url = NULL,
         developers = '[]', publishers = '[]', screenshots = '[]',
         ratings = '[]', prices = '[]', release_date = NULL,
         voice_actors = '[]', main_story_hours = NULL,
         main_extra_hours = NULL, completionist_hours = NULL,
         manual_override = 1, meta_error = NULL, updated_at = ?
       WHERE id = ?`,
      [newName, Date.now(), id],
    );

    // 4. Wipe the old identity's artwork: drop scraped posters, clear the
    //    selected flag and empty poster_url. Without clearing poster_url the
    //    card kept rendering the previous game's cover (problem 1:
    //    "绑定后封面仍是旧游戏海报").
    this.posters.resetForRematch(id);

    // 4b. Wipe the previous identity's achievements. The rows in the achievements
    //     table describe the OLD game, so keeping them showed the old title's
    //     trophy list under the new one. A manual achievement target is dropped
    //     with them because it points at the old title too.
    this.metadata.clearAchievements(id);

    // 4c. Same reasoning for 媒体评价: those reviews are the OLD game's press
    //     coverage. Duration fields were already cleared in step 3, but reviews
    //     live in their own table (deliberately, so a failed scrape cannot wipe
    //     them) and must be cleared explicitly on an identity change.
    this.reviews.removeFor(id);

    // 5. Full refresh across every enabled provider, then verify the score
    //    survived the replacement (requirement: 评分完整性校验).
    await this.metadata.refreshGame(id);
    this.metadata.restoreRatingsIfLost(id, ratingSnapshot, 'manual match');
    const fresh = this.db.get<GameRow>('SELECT * FROM games WHERE id = ?', [id]);
    if (!fresh) throw new NotFoundException('Game not found');

    // A binding is "effective" when we got at least one usable field, but a
    // failed scrape must be reported rather than silently claimed as success.
    //
    // `meta_error` alone is too coarse to be actionable: it is only set when
    // EVERY provider fails, so a match that returns a name but no poster, no
    // summary and no score still reported `matched:true` with no explanation.
    // Report per-field coverage so the dialog can say what is actually missing.
    const scraped = {
      poster: !!fresh.poster_url,
      summary: !!fresh.summary && fresh.summary.trim().length > 0,
      developers: parseStringArray(fresh.developers ?? '[]').length > 0,
      rating: parseStringArray(fresh.ratings ?? '[]').length > 0,
      screenshots: parseStringArray(fresh.screenshots ?? '[]').length > 0,
    };
    const missing = (Object.keys(scraped) as Array<keyof typeof scraped>).filter(
      (k) => !scraped[k],
    );
    const failed = fresh.meta_error ? providers : [];
    // Nothing at all came back — the binding resolved to an entity no provider
    // could describe, which is a failure regardless of what the name says.
    const matched = missing.length < Object.keys(scraped).length;
    const reason = fresh.meta_error
      ? fresh.meta_error
      : missing.length
        ? `部分数据缺失：${missing.map((m) => FIELD_LABELS[m]).join('、')}`
        : '';

    this.logger.log(
      `Matched game ${id} → ${provider}:${externalId} as "${fresh.name}"` +
        (missing.length ? ` (missing: ${missing.join(', ')})` : ''),
    );
    return { matched, name: fresh.name, providers, failed, missing, reason };
  }

  /** Manual name / platform / poster-mode correction (never overwritten by scans). */
  update(
    id: string,
    patch: {
      name?: string;
      platform?: string | null;
      /** Feature 6: multi-select platform override. */
      platforms?: string[];
      posterMode?: 'static' | 'slideshow';
    },
  ): object {
    const row = this.db.get<GameRow>('SELECT id FROM games WHERE id = ?', [id]);
    if (!row) throw new NotFoundException('Game not found');
    const changes: string[] = [];
    const params: unknown[] = [];

    if (patch.name != null) {
      changes.push('name = ?', 'manual_override = 1');
      params.push(patch.name.trim());
    }

    // Multi-platform override (feature 6). An empty array clears the override
    // and falls back to the scraped platform.
    if (patch.platforms !== undefined) {
      const list = (patch.platforms ?? []).map((p) => String(p).trim()).filter(Boolean);
      const uniq = [...new Set(list)];
      changes.push('platforms = ?', 'custom_platform = ?');
      params.push(JSON.stringify(uniq), uniq.length ? 1 : 0);
      // Keep the legacy single column in sync so older queries keep working.
      changes.push('platform = ?');
      params.push(uniq[0] ?? null);
      if (uniq.length) changes.push('manual_override = 1');
    } else if (patch.platform !== undefined) {
      changes.push('platform = ?', 'manual_override = 1');
      params.push(patch.platform || null);
    }

    if (patch.posterMode !== undefined) {
      changes.push('poster_mode = ?');
      params.push(patch.posterMode === 'slideshow' ? 'slideshow' : 'static');
    }

    if (changes.length) {
      changes.push('updated_at = ?');
      params.push(Date.now(), id);
      this.db.run(`UPDATE games SET ${changes.join(', ')} WHERE id = ?`, params);
    }

    const fresh = this.db.get<GameRow>('SELECT * FROM games WHERE id = ?', [id])!;
    return { updated: true, platforms: platformsOfRow(fresh), posterMode: fresh.poster_mode };
  }

  /** Platform list for the UI filter dropdown. */
  platformOptions(): { value: string; count: number }[] {
    const rows = this.db.all<GameRow>('SELECT * FROM games');
    const counts = new Map<string, number>();
    for (const r of rows) {
      const list = platformsOfRow(r);
      if (list.length === 0) {
        counts.set('未知', (counts.get('未知') ?? 0) + 1);
        continue;
      }
      for (const p of list) counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }

  listMedia(id: string): object[] {
    return this.media.listByGame(id);
  }

  /** Remove a game from the library; optionally delete its folder on disk. */
  async remove(id: string, deleteFiles: boolean): Promise<{ deleted: boolean; removedFiles: boolean }> {
    const row = this.db.get<GameRow>('SELECT * FROM games WHERE id = ?', [id]);
    if (!row) throw new NotFoundException('Game not found');

    const folderPath = row.folder_path;
    // media / achievements / game_links cascade via FK ON DELETE CASCADE.
    this.db.run('DELETE FROM games WHERE id = ?', [id]);

    let removedFiles = false;
    if (deleteFiles && folderPath) {
      removedFiles = await fs
        .remove(folderPath)
        .then(() => true)
        .catch(() => false);
    }
    this.logger.log(`Deleted game "${row.name}"${deleteFiles ? ' (+files)' : ''}`);
    return { deleted: true, removedFiles };
  }

  // ---------------------------------------------------------------------------

  /** Route external image URLs through the backend proxy (fixes blocked CDNs). */
  /** Rewrite an external image URL to the local disk-caching proxy. */
  private proxyImage(url: string | null): string | null {
    return toProxiedImageUrl(url);
  }

  /**
   * The poster rows for a game, with remote artwork routed through the image
   * proxy. Local routes (`/api/media/...`, `/api/posters/<id>/image`) are left
   * untouched by `toProxiedImageUrl`, so uploads and album posters are unaffected.
   */
  private proxiedPosters(gameId: string): Record<string, unknown>[] {
    return this.posters.list(gameId).map((p) => ({
      ...p,
      url: this.proxyImage(p.url) ?? p.url,
      thumbUrl: this.proxyImage(p.thumbUrl) ?? p.thumbUrl,
    }));
  }

  private toSummary(r: GameRow): Record<string, unknown> {
    // Hand-set gallery position for the drag-and-drop mode; read from the summary
    // because list() sorts the summaries, not the rows.
    const customOrder = r.custom_order ?? null;
    // A user-picked rating outranks whatever the scraper stored. Resolving this
    // at read time (rather than copying the value into `games`) is what makes the
    // choice survive every refresh: there is nothing for a scrape to overwrite.
    const manualRating = this.ratingTargets.get(r.id);
    const rating = manualRating
      ? { metascore: manualRating.metascore, criticCount: manualRating.criticCount }
      : firstRating(r.ratings);
    const platforms = platformsOfRow(r);
    return {
      customOrder,
      id: r.id,
      name: r.name,
      folderPath: r.folder_path,
      // `platform` stays for backward compatibility (first entry).
      platform: platforms[0] ?? null,
      // Full user-selected list (feature 6).
      platforms,
      customPlatform: !!r.custom_platform,
      posterUrl: this.proxyImage(r.poster_url),
      // Feature 5: slideshow list + mode.
      posters: this.slideshowPosters(r).map((u) => this.proxyImage(u) ?? u),
      posterMode: r.poster_mode === 'slideshow' ? 'slideshow' : 'static',
      mediaCount: this.media.countByGame(r.id),
      durationSeconds: r.duration_seconds,
      durationText: formatDurationText(r.duration_seconds),
      metacriticScore: rating?.metascore ?? null,
      metacriticCriticCount: rating?.criticCount ?? null,
      // Where the score came from, so the UI can label a hand-picked entry and
      // offer 「恢复自动匹配」 only when there is something to reset.
      metacriticManual: !!manualRating,
      metacriticPlatform: manualRating?.platform ?? null,
      metacriticSource: manualRating ? manualRating.source : rating ? 'auto' : null,
      metacriticReleaseDate: manualRating?.releaseDate ?? null,
      metaError: r.meta_error,
      firstPlayedAt: r.first_played_at ? new Date(r.first_played_at).toISOString() : null,
      lastPlayedAt: r.last_played_at ? new Date(r.last_played_at).toISOString() : null,
    };
  }

  private toDetail(r: GameRow): Record<string, unknown> {
    return {
      ...this.toSummary(r),
      folderName: r.folder_name,
      folderPath: r.folder_path,
      aliases: parseStringArray(r.aliases),
      summary: r.summary,
      developers: parseStringArray(r.developers),
      publishers: parseStringArray(r.publishers),
      releaseDate: r.release_date,
      voiceActors: parseStringArray(r.voice_actors),
      screenshots: parseStringArray(r.screenshots).map((s) => this.proxyImage(s) ?? s),
      // Full poster set for the detail-page editor (features 4 & 5).
      //
      // Routed through the image proxy like every other remote picture. Scraped
      // posters point at the provider's CDN (media.rawg.io), which the browser on
      // a China-side LAN cannot reach directly — the server does, and only via its
      // outbound proxy. Handing the raw URL to the browser meant every official
      // poster rendered as a broken image in the editor and in the carousel.
      posterList: this.proxiedPosters(r.id),
      knownPlatforms: [...KNOWN_PLATFORMS],
      mainStoryHours: r.main_story_hours,
      // Which database supplied the hours, so the UI can be explicit about it.
      durationSource: r.duration_source ?? null,
      mainPlusExtraHours: r.main_extra_hours,
      completionistHours: r.completionist_hours,
      mainDurationText: r.main_duration_seconds != null ? formatDurationText(r.main_duration_seconds) : null,
      completionistDurationText:
        r.completionist_duration_seconds != null
          ? formatDurationText(r.completionist_duration_seconds)
          : null,
      ratings: parseJson(r.ratings),
      // 媒体评价 for the 「媒体评价」 tab: the per-outlet review list plus the
      // scrape state, so an empty panel can say WHY it is empty (never fetched /
      // source had none / last attempt failed) instead of showing a blank box.
      mediaReviews: this.reviews.list(r.id),
      mediaReviewsSummary: this.reviews.summary(r.id),
      prices: parseJson(r.prices),
      achievements: this.db
        .all<{ icon_url: string | null }>(
          'SELECT * FROM achievements WHERE game_id = ? ORDER BY sort_order ASC, name ASC',
          [r.id],
        )
        .map((a) => ({
          ...a,
          // Achievement icons live on the Steam CDN too — route them through the
          // caching proxy so they render on networks that cannot reach it.
          iconUrl: this.proxyImage((a as { icon_url: string | null }).icon_url),
        })),
      // Scrape state travels with the detail payload so the 「成就」 tab can explain
      // an empty list (failed / unsupported) instead of showing a blank panel.
      achievementsStatus: r.achievements_status ?? null,
      achievementsError: r.achievements_error ?? null,
      timeline: this.buildTimeline(r),
      cachedAt: r.last_meta_refresh ? new Date(r.last_meta_refresh).toISOString() : null,
      lastMetadataRefresh: r.last_meta_refresh ? new Date(r.last_meta_refresh).toISOString() : null,
    };
  }

  private buildTimeline(r: GameRow): object[] {
    const events: object[] = [];
    if (r.release_date) {
      events.push({
        date: r.release_date,
        type: 'note',
        title: '发行日期',
        description: r.release_date.slice(0, 10),
      });
    }
    if (r.first_played_at) {
      events.push({
        date: new Date(r.first_played_at).toISOString(),
        type: 'first_media',
        title: '开始游玩',
        description: '库中最早一条媒体记录',
      });
    }
    if (r.last_played_at && r.last_played_at !== r.first_played_at) {
      events.push({
        date: new Date(r.last_played_at).toISOString(),
        type: 'last_media',
        title: '结束游玩',
        description: `总耗时 ${formatDurationText(r.duration_seconds)}`,
      });
    }
    return events.sort((a, b) => String((a as { date: string }).date).localeCompare(String((b as { date: string }).date)));
  }

  private matchesFilters(r: GameRow, f: GameFilters): boolean {
    if (f.search) {
      const q = f.search.toLowerCase();
      const hay = `${r.name} ${parseStringArray(r.developers).join(' ')} ${parseStringArray(r.publishers).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f.platform) {
      // Match against the user-selected platforms first (feature 6), then fall
      // back to the scraped value. Matching is case-insensitive and loose so
      // "ps5" finds "PlayStation 5".
      const want = f.platform.toLowerCase().trim();
      const list = platformsOfRow(r).map((p) => p.toLowerCase());
      const hit =
        list.some((p) => p.includes(want) || want.includes(p)) ||
        (r.platform ? r.platform.toLowerCase().includes(want) : false) ||
        // Common aliases so short queries work as users expect.
        list.some((p) => platformAliases(p).some((a) => a.includes(want) || want.includes(a)));
      if (!hit) return false;
    }
    const score = firstRating(r.ratings)?.metascore ?? null;
    if (f.minScore != null && (score == null || score < f.minScore)) return false;
    if (f.maxScore != null && (score == null || score > f.maxScore)) return false;
    if (f.yearMin != null || f.yearMax != null) {
      const year = r.release_date ? new Date(r.release_date).getFullYear() : null;
      if (f.yearMin != null && (year == null || year < f.yearMin)) return false;
      if (f.yearMax != null && (year == null || year > f.yearMax)) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Custom gallery order (drag and drop)

  /**
   * Move a game next to its new neighbours.
   *
   * The client only has to say which two cards the dragged one landed between,
   * which is what makes this work under filters and across pages: the neighbours
   * are ids in the *visible* list, and positions live in one global sequence, so a
   * drop on page 2 still lands correctly relative to page 1.
   */
  reorder(body: { gameId?: string; beforeId?: string | null; afterId?: string | null }): object {
    const gameId = body?.gameId;
    if (!gameId) throw new BadRequestException('缺少 gameId');
    const row = this.db.get<GameRow>('SELECT * FROM games WHERE id = ?', [gameId]);
    if (!row) throw new NotFoundException('游戏不存在');
    if (body.beforeId === gameId || body.afterId === gameId) {
      throw new BadRequestException('不能把游戏拖到它自己旁边');
    }

    const placed = this.db.all<{ id: string; custom_order: number | null }>(
      'SELECT id, custom_order FROM games ORDER BY custom_order ASC, name ASC',
    );
    const positionOf = (id: string | null | undefined): number | null =>
      id ? (placed.find((p) => p.id === id)?.custom_order ?? null) : null;

    const after = positionOf(body.afterId); // the card above the drop point
    const before = positionOf(body.beforeId); // the card below the drop point

    // A neighbour that has never been dragged has no number to interpolate
    // against. Materialise the whole effective order once — lossless, because it
    // reproduces exactly the sequence the user is looking at — and then the
    // midpoint between the two neighbours is well defined.
    if ((body.afterId && after == null) || (body.beforeId && before == null)) {
      this.renumberCustomOrder();
      return this.reorder(body);
    }

    let next: number;
    if (after == null && before == null) {
      // Dropped into an empty list, or both neighbours are unplaced: put it at the
      // end of the placed run so the arrangement stays predictable.
      const max = placed.reduce((m, p) => Math.max(m, p.custom_order ?? Number.NEGATIVE_INFINITY), Number.NEGATIVE_INFINITY);
      next = Number.isFinite(max) ? max + ORDER_GAP : ORDER_GAP;
    } else if (after == null) {
      next = (before as number) - ORDER_GAP;
    } else if (before == null) {
      next = after + ORDER_GAP;
    } else {
      const mid = Math.floor((after + (before as number)) / 2);
      // Gap exhausted by repeated inserts at the same spot — spread everything out
      // again and recompute against the fresh values.
      if (mid <= after || mid >= (before as number)) {
        this.renumberCustomOrder();
        return this.reorder(body);
      }
      next = mid;
    }

    this.db.run('UPDATE games SET custom_order = ? WHERE id = ?', [next, gameId]);
    return { ok: true, gameId, customOrder: next };
  }

  /**
   * Spread every placed game back out to ORDER_GAP intervals.
   *
   * Only needed when midpoint insertion has used up the room between two
   * neighbours; positions stay integers so the spacing cannot degrade silently.
   */
  private renumberCustomOrder(): void {
    // Ordered exactly like `sort=custom` renders — placed games by position,
    // unplaced ones after them by name — so writing numbers back changes nothing
    // the user can see.
    const all = this.db.all<{ id: string }>(
      `SELECT id FROM games
        ORDER BY custom_order IS NULL, custom_order ASC, name ASC`,
    );
    all.forEach((p, i) => {
      this.db.run('UPDATE games SET custom_order = ? WHERE id = ?', [(i + 1) * ORDER_GAP, p.id]);
    });
    this.logger.log(`Renumbered ${all.length} custom gallery positions.`);
  }

  /** Drop every hand-set position, returning the gallery to its default order. */
  resetCustomOrder(): object {
    const before = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM games WHERE custom_order IS NOT NULL',
    );
    this.db.run('UPDATE games SET custom_order = NULL');
    this.logger.log(`Reset custom gallery order for ${before?.n ?? 0} games.`);
    return { ok: true, cleared: before?.n ?? 0 };
  }

  private sort(
    items: Record<string, unknown>[],
    sort: NonNullable<GameFilters['sort']>,
    order: 'asc' | 'desc',
  ): Record<string, unknown>[] {
    const dir = order === 'desc' ? -1 : 1;
    const key = (it: Record<string, unknown>): number | string => {
      switch (sort) {
        case 'custom':
          // Games the user has never dragged keep a null position and sort after
          // the placed ones — by name, so a newly scanned game lands predictably
          // at the end instead of in front of the arrangement.
          return it.customOrder == null ? Number.MAX_SAFE_INTEGER : Number(it.customOrder);
        case 'created':
          return String(it.firstPlayedAt ?? '');
        case 'duration':
          return Number(it.durationSeconds ?? 0);
        case 'mediaCount':
          return Number(it.mediaCount ?? 0);
        case 'metacritic':
          return Number(it.metacriticScore ?? -1);
        default:
          return String(it.name).toLowerCase();
      }
    };
    return [...items].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      if (ka < kb) return -1 * dir;
      if (ka > kb) return 1 * dir;
      // Ties (notably the unplaced tail in custom mode) fall back to name so the
      // order is stable between requests rather than dependent on row order.
      return sort === 'custom'
        ? String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase())
        : 0;
    });
  }
}

// --- helpers -------------------------------------------------------------

function parseJson<T = unknown>(json: string): T {
  try {
    return JSON.parse(json || '[]') as T;
  } catch {
    return [] as unknown as T;
  }
}

function firstRating(ratingsJson: string): { metascore: number | null; criticCount: number | null } | null {
  const ratings = parseJson<{ metascore?: number | null; criticCount?: number | null }[]>(ratingsJson);
  for (const r of ratings) {
    if (r.metascore != null) return { metascore: r.metascore, criticCount: r.criticCount ?? null };
  }
  return null;
}

/**
 * Extract the media id out of an internal media URL
 * (`/api/media/<id>/thumbnail` → `<id>`), used to de-duplicate posters that
 * point at the same album image through different endpoints.
 */
function mediaIdFromUrl(url: string): string | null {
  const m = /^\/api\/media\/([0-9a-f-]{36})\//i.exec(url);
  return m ? m[1] : null;
}

/**
 * Extra spellings that should match a platform when the user types a short
 * query (e.g. "ps5" → "PlayStation 5", "switch" → "Nintendo Switch").
 */
function platformAliases(platform: string): string[] {
  const p = platform.toLowerCase();
  const map: Record<string, string[]> = {
    'playstation 5': ['ps5', 'ps 5', 'playstation5'],
    'playstation 4': ['ps4', 'ps 4', 'playstation4'],
    'playstation 3': ['ps3', 'ps 3', 'playstation3'],
    'xbox series x|s': ['xbox series', 'xsx', 'series x', 'series s', 'xbox series x', 'xbox series s'],
    'xbox one': ['xbone', 'xboxone'],
    'nintendo switch': ['switch', 'ns'],
    'nintendo switch 2': ['switch 2', 'switch2', 'ns2'],
    'steam deck': ['deck'],
    pc: ['windows', 'win', '电脑'],
  };
  return map[p] ?? [];
}