/**
 * Persistence for scraped achievements and trophies.
 *
 * Steam achievements and PlayStation trophies are scraped by completely different
 * code paths, but they land in the same table and must behave identically: update
 * in place, prune only what vanished, and never touch another source's rows. This
 * shared writer keeps the two paths from drifting apart.
 */

import { DatabaseService } from '../database/database.service';
import type { AchievementData } from '../metadata/provider.interface';

/**
 * Row id for one achievement.
 *
 * Includes the source so the same external id arriving from a different source
 * (or a re-scrape that switched sources) cannot overwrite an unrelated row.
 */
export function achievementRowId(gameId: string, source: string, externalId: string): string {
  return `${gameId}:${source}:${externalId}`;
}

/**
 * Upsert a scrape result and delete the rows that are no longer present.
 *
 * Deliberately not a blanket DELETE + INSERT: an upsert costs one write per
 * changed row, keeps ids stable across re-scrapes, and lets the prune step be
 * scoped to this source so a Steam refresh cannot wipe scraped PS trophies.
 */
export function storeAchievements(
  db: DatabaseService,
  gameId: string,
  source: string,
  achievements: AchievementData[],
): void {
  const tx = db.raw.transaction(() => {
    const keep = new Set<string>();
    for (const [i, a] of achievements.entries()) {
      const id = achievementRowId(gameId, source, a.externalId);
      keep.add(id);
      db.run(
        `INSERT INTO achievements
           (id, game_id, external_id, name, description, icon_url, global_percent, unlocked,
            tier, rarity, source, dlc_app_id, dlc_name, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           icon_url = excluded.icon_url,
           global_percent = excluded.global_percent,
           tier = excluded.tier,
           rarity = excluded.rarity,
           dlc_app_id = excluded.dlc_app_id,
           dlc_name = excluded.dlc_name,
           sort_order = excluded.sort_order`,
        [
          id,
          gameId,
          a.externalId,
          a.name,
          a.description ?? null,
          a.iconUrl ?? null,
          a.globalPercent ?? null,
          a.unlocked ? 1 : 0,
          a.tier ?? null,
          a.rarity ?? null,
          source,
          a.dlcAppId ?? null,
          a.dlcName ?? null,
          a.sortOrder ?? i,
        ],
      );
    }

    // Prune this source's stale rows only (a trophy removed by a patch, or an
    // achievement renamed upstream).
    const existing = db.all<{ id: string }>(
      'SELECT id FROM achievements WHERE game_id = ? AND source = ?',
      [gameId, source],
    );
    for (const r of existing) {
      if (!keep.has(r.id)) db.run('DELETE FROM achievements WHERE id = ?', [r.id]);
    }
  });
  tx();
}