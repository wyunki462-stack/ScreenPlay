import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { GamesService } from './games.service';
import { ListGamesQuery, RefreshGameDto, UpdateGameDto } from './dto';

@Controller('api/games')
export class GamesController {
  constructor(private readonly games: GamesService) {}

  @Get()
  list(@Query() query: ListGamesQuery): object[] {
    return this.games.list(query);
  }

  /** Distinct platforms (with counts) for the gallery filter dropdown. */
  @Get('platforms')
  platforms(): object[] {
    return this.games.platformOptions();
  }

  /**
   * Persist a drag-and-drop gallery move.
   *
   * Deliberately placed above the `:id` routes — Nest matches in declaration
   * order, so a literal path declared later would be swallowed by `:id`.
   */
  @Put('order')
  reorder(@Body() body: { gameId?: string; beforeId?: string | null; afterId?: string | null }) {
    return this.games.reorder(body);
  }

  @Delete('order')
  resetOrder() {
    return this.games.resetCustomOrder();
  }

  /**
   * Completion-time coverage, for the settings page's 「一键批量补全通关时长」.
   *
   * Declared here, ahead of `@Get(':id')`, for the same declaration-order reason
   * as the other literal routes: Nest matches in order, so a literal declared
   * after `:id` would be swallowed by it.
   */
  /** 媒体评价 coverage for the settings card (counts + which games remain). */
  @Get('media-reviews/coverage')
  mediaReviewsCoverage(): object {
    return this.games.mediaReviewsCoverage();
  }

  @Get('duration-coverage')
  durationCoverage(): object {
    return this.games.durationCoverage();
  }

  @Get(':id')
  detail(@Param('id') id: string): Promise<object> {
    return this.games.detail(id, false);
  }

  /**
   * Previous/next game in the gallery order, honouring the same filters and sort
   * the gallery is currently using. Declared before `:id/media` for clarity; Nest
   * only needs literals ahead of the single-segment `:id` route.
   */
  @Get(':id/neighbors')
  neighbors(@Param('id') id: string, @Query() query: ListGamesQuery) {
    return this.games.neighbors(id, query);
  }

  @Get(':id/media')
  media(@Param('id') id: string): object[] {
    return this.games.listMedia(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateGameDto): object {
    return this.games.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Query('deleteFiles') deleteFiles?: string): Promise<object> {
    return this.games.remove(id, deleteFiles === 'true');
  }

  @Post(':id/refresh')
  async refresh(@Param('id') id: string, @Body() body: RefreshGameDto): Promise<object> {
    await this.games.refresh(id, body.providers as Parameters<GamesService['refresh']>[1]);
    return { refreshed: true };
  }

  /**
   * Re-scrape ONLY achievements/trophies for one game and return the fresh list.
   *
   * Separate from `:id/refresh` because it is cheap (one or two HTTP calls, no
   * provider sweep) and because the achievements tab needs the updated rows back
   * to render them without a second round trip. Always returns 200 — a scrape
   * failure is reported inside the payload as `status: 'failed'` with `error`, so
   * the UI can show the reason rather than a bare HTTP error.
   */
  @Post(':id/achievements/refresh')
  refreshAchievements(@Param('id') id: string): Promise<object> {
    return this.games.refreshAchievements(id);
  }

  @Get('match/search')
  matchSearch(@Query('q') q: string): Promise<object[]> {
    return this.games.searchMatches(q ?? '');
  }

  @Post(':id/match')
  async match(
    @Param('id') id: string,
    @Body() body: { provider: string; externalId: string },
  ): Promise<object> {
    // Return the resolved name, missing fields and any failed providers so the dialog can show
    // what actually happened instead of a bare `{matched:true}`.
    return this.games.match(
      id,
      body.provider as Parameters<GamesService['match']>[1],
      body.externalId,
    );
  }

  /**
   * Metacritic entries the user can pick as this game's score source.
   * `?q=` overrides the search keyword (defaults to the game's own name).
   */
  @Get(':id/rating-candidates')
  ratingCandidates(
    @Param('id') id: string,
    @Query('q') q?: string,
  ): Promise<object> {
    return this.games.ratingCandidates(id, q);
  }

  /** Pin this game's score to a specific Metacritic platform entry. */
  @Put(':id/rating-target')
  setRatingTarget(
    @Param('id') id: string,
    @Body()
    body: {
      externalId: string;
      name?: string;
      platform?: string | null;
      metascore?: number | null;
      criticCount?: number | null;
      releaseDate?: string | null;
    },
  ): Promise<object> {
    return this.games.setRatingTarget(id, body);
  }

  /** Drop the override and go back to automatic matching. */
  @Delete(':id/rating-target')
  clearRatingTarget(@Param('id') id: string): object {
    return this.games.clearRatingTarget(id);
  }

  /**
   * 批量刷新元数据。`?achievements=force` 强制重抓成就；默认 `ttl` 在 15 天
   * 新鲜度内复用已存的成就行（元数据本身始终强刷），这是让 bulk 刷新变便宜的关键。
   */
  @Post('refresh-all')
  refreshAll(@Query('achievements') achievements?: string): Promise<object> {
    return this.games.refreshAll({
      achievements: achievements === 'force' ? 'force' : 'ttl',
    });
  }

  /**
   * Backfill only the games still missing a Metacritic score. Cheaper than
   * refresh-all and safe to run repeatedly after fixing a matcher bug.
   */
  /**
   * Re-attempt the completion time for every game that still has none.
   *
   * The duration sources are the flakiest part of a scrape, so a library can end
   * up with many games showing 「未知」 purely because the source was unreachable
   * at the moment they were first scraped. This repairs that without a full
   * re-scrape.
   */
  @Post('backfill-durations')
  backfillDurations() {
    return this.games.backfillDurations();
  }

  /**
   * 批量补全媒体评价 — `POST /api/games/backfill-ratings`.
   *
   * Body (all optional):
   *   - `scope`: `missing` (default) — only games with no reviews yet, plus games
   *     whose last attempt failed. `all` re-fetches every game, which is what you
   *     want after a parser fix so libraries scraped before reviews existed are
   *     repaired too.
   *   - `limit`: cap the number of games processed in this call, so a large
   *     library can be filled in bounded chunks.
   *
   * Synchronous and serial by design: it returns a per-game result list, and the
   * source is a rate-limited website that must not be hit in parallel.
   */
  @Post('backfill-ratings')
  backfillRatings(
    @Body() body: { scope?: 'missing' | 'all'; limit?: number },
  ): Promise<object> {
    return this.games.backfillRatingsBatch({
      scope: body?.scope === 'all' ? 'all' : 'missing',
      limit: Number(body?.limit) || 0,
    });
  }

  /**
   * Re-attempt ONLY the Metacritic metascore for games that lack one.
   *
   * Kept from the earlier round: still useful on its own (it clears a stale
   * provider binding), and far cheaper than refresh-all.
   */
  @Post('backfill-scores')
  backfillScores(): Promise<object> {
    return this.games.backfillRatings();
  }

  /** 媒体评价 for one game, without loading the whole detail payload. */
  @Get(':id/media-reviews')
  mediaReviews(@Param('id') id: string): object {
    return this.games.mediaReviewsFor(id);
  }

  /** Re-fetch 媒体评价 for a single game (the panel's refresh button). */
  @Post(':id/media-reviews/refresh')
  refreshMediaReviews(@Param('id') id: string): Promise<object> {
    return this.games.refreshMediaReviews(id);
  }

  @Get('refresh-all/status')
  metadataStatus(): object {
    return this.games.metadataStatus();
  }
}