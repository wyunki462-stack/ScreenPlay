/**
 * The achievement/trophy target the user picked by hand.
 *
 * Automatic matching keys off the folder name, which is often ambiguous: a folder
 * called "007" cannot tell "007 First Light" apart from "GoldenEye 007", so the
 * scrape lands on the wrong entry or on nothing at all. The detail page therefore
 * offers 「手动选择游戏」, and whatever is chosen here wins.
 *
 * Stored separately from `game_links` on purpose — that table is rewritten by the
 * automatic matcher, so keeping this apart is what makes the choice survive every
 * later full scrape and single-game refresh.
 */

import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/** One persisted manual choice. */
export interface AchievementTarget {
  gameId: string;
  /** Source the id belongs to: 'steam', 'psnine', … */
  source: string;
  externalId: string;
  /** Title as the source spells it, shown back to the user. */
  name: string | null;
}

interface TargetRow {
  game_id: string;
  source: string;
  external_id: string;
  name: string | null;
}

@Injectable()
export class AchievementTargetService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  /** The manual target for a game, or null when the game is on auto-matching. */
  get(gameId: string): AchievementTarget | null {
    const row = this.db.get<TargetRow>(
      'SELECT game_id, source, external_id, name FROM achievement_links WHERE game_id = ?',
      [gameId],
    );
    if (!row) return null;
    return {
      gameId: row.game_id,
      source: row.source,
      externalId: row.external_id,
      name: row.name,
    };
  }

  /** True when the user has taken this game off automatic matching. */
  has(gameId: string): boolean {
    return this.get(gameId) !== null;
  }

  /** Record a manual choice, replacing any earlier one. */
  set(gameId: string, source: string, externalId: string, name: string | null): void {
    this.db.run(
      `INSERT INTO achievement_links (game_id, source, external_id, name, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(game_id) DO UPDATE SET
         source = excluded.source,
         external_id = excluded.external_id,
         name = excluded.name,
         created_at = excluded.created_at`,
      [gameId, source, externalId, name, Date.now()],
    );
  }

  /** Drop the manual choice so the game returns to automatic matching. */
  clear(gameId: string): void {
    this.db.run('DELETE FROM achievement_links WHERE game_id = ?', [gameId]);
  }
}