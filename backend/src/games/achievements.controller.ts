import { Body, Controller, Delete, Get, Param, Put, Query } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { GamesService } from './games.service';
import { AchievementsPayload, buildAchievementsPayload } from './achievements.view';

/** Body of `PUT /api/achievements/:gameId/target`. */
interface SetTargetBody {
  /** Achievement source the id belongs to: 'steam', 'psnine', … */
  source?: string;
  externalId?: string | number;
  name?: string | null;
}

@Controller('api/achievements')
export class AchievementsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly games: GamesService,
  ) {}

  /**
   * Achievements (Steam) or trophies (PlayStation) for one game.
   *
   * Returns an object rather than a bare array so the per-tier tally and the
   * scrape state travel with the rows — the UI needs to distinguish "no data yet",
   * "this platform has no source" and "the scrape failed, here is why".
   */
  @Get(':gameId')
  list(@Param('gameId') gameId: string): AchievementsPayload {
    return buildAchievementsPayload(this.db, gameId);
  }

  /**
   * Search every achievement source for entries matching `q`.
   *
   * Backs the 「手动选择游戏」 picker. Returns one uniform shape across Steam and
   * the trophy sites so the dialog can list them together; a source that is down
   * contributes nothing instead of failing the whole search.
   */
  @Get(':gameId/candidates')
  async candidates(
    @Param('gameId') gameId: string,
    @Query('q') q?: string,
  ): Promise<{ items: object[]; target: object | null }> {
    // `target` lets the dialog show what is currently picked, so the user can see
    // they are changing an existing choice rather than setting the first one.
    const target = await this.games.getAchievementTarget(gameId);
    return {
      items: q?.trim() ? await this.games.searchAchievementTargets(q) : [],
      target,
    };
  }

  /** The hand-picked achievement target, or null when the game is on auto. */
  @Get(':gameId/target')
  async target(@Param('gameId') gameId: string): Promise<object> {
    return { target: await this.games.getAchievementTarget(gameId) };
  }

  /**
   * Save a hand-picked achievement target and re-scrape from it immediately, so
   * the tab refreshes in one round trip.
   *
   * The choice is persisted: later full scrapes and single-game refreshes keep
   * using it instead of reverting to automatic matching.
   */
  @Put(':gameId/target')
  async setTarget(
    @Param('gameId') gameId: string,
    @Body() body: SetTargetBody,
  ): Promise<AchievementsPayload> {
    return (await this.games.setAchievementTarget(
      gameId,
      String(body.source ?? ''),
      String(body.externalId ?? ''),
      body.name ?? null,
    )) as AchievementsPayload;
  }

  /** Drop the manual choice and put the game back on automatic matching. */
  @Delete(':gameId/target')
  async clearTarget(@Param('gameId') gameId: string): Promise<AchievementsPayload> {
    return (await this.games.clearAchievementTarget(gameId)) as AchievementsPayload;
  }
}