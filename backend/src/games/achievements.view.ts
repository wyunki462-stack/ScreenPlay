/**
 * Read model for the 「成就」 tab.
 *
 * Steam achievements and PlayStation trophies share one table but reach the UI in
 * one shape, together with the per-tier tally and — critically — the *reason* a
 * list is empty. A bare array could not express "this failed" versus "this game
 * has none", which is why a failed scrape used to look identical to a working one.
 */

import { DatabaseService } from '../database/database.service';
import { toProxiedImageUrl } from '../common/image-url';
import type { TrophyCounts } from '../metadata/provider.interface';

export interface AchievementView {
  id: string;
  gameId: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  globalPercent: number | null;
  unlocked: boolean;
  tier: string | null;
  rarity: string | null;
  source: string | null;
  dlcAppId: string | null;
  dlcName: string | null;
  sortOrder: number;
}

export interface AchievementsPayload {
  items: AchievementView[];
  counts: TrophyCounts;
  /** ok | empty | failed | unsupported | pending */
  status: string;
  /** Chinese reason when `status` is 'failed'; null otherwise. */
  error: string | null;
  /** 'steam' | 'psnine' | null — where the stored rows came from. */
  source: string | null;
}

interface GameStateRow {
  achievements_status: string | null;
  achievements_error: string | null;
  trophy_source: string | null;
}

/**
 * Read a game's achievements plus its scrape state.
 *
 * `status` falls back to a value derived from the rows when the column has never
 * been written (a library scraped before this feature existed): rows present means
 * "ok", no rows and no recorded state means "pending" rather than a scary failure.
 */
export function buildAchievementsPayload(
  db: DatabaseService,
  gameId: string,
): AchievementsPayload {
  const items = db.all<AchievementView>(
    `SELECT id, game_id AS gameId, name, description, icon_url AS iconUrl,
            global_percent AS globalPercent, unlocked, tier, rarity, source,
            dlc_app_id AS dlcAppId, dlc_name AS dlcName, sort_order AS sortOrder
       FROM achievements
      WHERE game_id = ?
      ORDER BY sort_order ASC, name ASC`,
    [gameId],
  );

  const counts: TrophyCounts = { platinum: 0, gold: 0, silver: 0, bronze: 0, total: 0 };
  const sources = new Set<string>();
  for (const a of items) {
    if (a.tier === 'platinum' || a.tier === 'gold' || a.tier === 'silver' || a.tier === 'bronze') {
      counts[a.tier] += 1;
    }
    counts.total += 1;
    if (a.source) sources.add(a.source);
  }

  const state = db.get<GameStateRow>(
    'SELECT achievements_status, achievements_error, trophy_source FROM games WHERE id = ?',
    [gameId],
  );

  const storedSource = state?.trophy_source ?? null;
  // Steam games never set trophy_source, so fall back to what the rows say.
  const source = storedSource ?? (sources.size ? [...sources].join(',') : null);

  let status = state?.achievements_status ?? null;
  if (!status) status = items.length ? 'ok' : 'pending';

  // A recorded failure with rows present still reads as "ok" but keeps the error,
  // so the UI can show a stale-data warning instead of hiding the achievements.
  if (status === 'failed' && items.length > 0) status = 'ok';

  return {
    items: items.map((a) => ({ ...a, iconUrl: toProxiedImageUrl(a.iconUrl) })),
    counts,
    status,
    error: status === 'ok' || status === 'pending' ? null : (state?.achievements_error ?? null),
    source,
  };
}