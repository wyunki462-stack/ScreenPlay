/**
 * Manual Metacritic rating selection.
 *
 * The automatic matcher picks whichever Metacritic entry it thinks best fits the
 * game, but the same title scores differently per platform (PC / PS5 / Xbox /
 * Switch are separate entries on Metacritic). When the auto pick lands on the
 * wrong platform the user sees a score that does not match how they played it.
 *
 * A user's choice is deliberately stored in its own table rather than as a
 * `games` column: the scraping pipeline rewrites `games` on every refresh, so a
 * column would be at the mercy of whatever the next scrape decided. Living apart
 * from the scraped row is what makes the choice survive 全量刮削 and 单游戏刷新
 * without needing to be re-applied after every write.
 *
 * Precedence is resolved at read time (see `GamesService.toSummary`): a manual
 * target wins over the scraped rating, and only 「恢复自动匹配」 removes it.
 */

import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface RatingTarget {
  source: string;
  externalId: string;
  name: string | null;
  platform: string | null;
  metascore: number | null;
  criticCount: number | null;
  releaseDate: string | null;
  createdAt: number;
}

interface RatingTargetRow {
  game_id: string;
  source: string;
  external_id: string;
  name: string | null;
  platform: string | null;
  metascore: number | null;
  critic_count: number | null;
  release_date: string | null;
  created_at: number;
}

@Injectable()
export class RatingTargetService {
  private readonly logger = new Logger(RatingTargetService.name);

  constructor(private readonly db: DatabaseService) {}

  /** The manual rating target for a game, or null when it is on auto. */
  get(gameId: string): RatingTarget | null {
    const row = this.db.get<RatingTargetRow>(
      'SELECT * FROM rating_targets WHERE game_id = ?',
      [gameId],
    );
    if (!row) return null;
    return {
      source: row.source,
      externalId: row.external_id,
      name: row.name,
      platform: row.platform,
      metascore: row.metascore,
      criticCount: row.critic_count,
      releaseDate: row.release_date,
      createdAt: row.created_at,
    };
  }

  has(gameId: string): boolean {
    return (
      this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM rating_targets WHERE game_id = ?', [
        gameId,
      ])?.n ?? 0
    ) > 0;
  }

  /** Store (or replace) the user's chosen rating entry. */
  set(
    gameId: string,
    target: {
      source: string;
      externalId: string;
      name?: string | null;
      platform?: string | null;
      metascore?: number | null;
      criticCount?: number | null;
      releaseDate?: string | null;
    },
  ): RatingTarget {
    this.db.run(
      `INSERT INTO rating_targets
         (game_id, source, external_id, name, platform, metascore, critic_count, release_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(game_id) DO UPDATE SET
         source = excluded.source,
         external_id = excluded.external_id,
         name = excluded.name,
         platform = excluded.platform,
         metascore = excluded.metascore,
         critic_count = excluded.critic_count,
         release_date = excluded.release_date,
         created_at = excluded.created_at`,
      [
        gameId,
        target.source,
        target.externalId,
        target.name ?? null,
        target.platform ?? null,
        target.metascore ?? null,
        target.criticCount ?? null,
        target.releaseDate ?? null,
        Date.now(),
      ],
    );
    this.logger.log(
      `Manual rating target set for ${gameId}: ${target.source}:${target.externalId} ` +
        `(${target.platform ?? 'unknown platform'}, ${target.metascore ?? 'no score'}).`,
    );
    return this.get(gameId)!;
  }

  /** Drop the override so the game follows the automatic matcher again. */
  clear(gameId: string): void {
    this.db.run('DELETE FROM rating_targets WHERE game_id = ?', [gameId]);
    this.logger.log(`Manual rating target cleared for ${gameId}; back to automatic matching.`);
  }
}