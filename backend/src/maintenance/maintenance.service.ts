/**
 * Boot-time data repairs.
 *
 * Why this exists at all: fixing a provider does NOT repair an existing library.
 * A game whose `last_meta_refresh` is already set is never re-scraped by a scan,
 * and `ensureRotationFloor()` only runs from inside metadata persistence — so a
 * library that was built before those fixes keeps the old symptoms forever:
 *
 *   - 「其余所有游戏只有默认单张封面」  → the poster rotation was never topped up;
 *   - 通关时长显示「未知」             → the duration sources were never re-asked.
 *
 * Both are pure data problems, and both used to require the user to know which
 * button on the settings page to press. They are now applied automatically once
 * per container start, so that deploying a new image actually repairs the data
 * that image was built to fix.
 *
 * Deliberately background: `onApplicationBootstrap` must not delay `listen()`.
 * The container is expected to answer /api/health within seconds of starting, and
 * a library-wide network backfill can take minutes.
 */

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { SettingsService } from '../settings/settings.service';
import { LibraryService } from '../library/library.service';
import { PostersService } from '../games/posters.service';
import { GamesService } from '../games/games.service';

/** Marker keys recorded in the `settings` table (same store as the API keys). */
const MARKER_PREFIX = 'maintenance.';

/**
 * Bumped whenever a repair must run again on libraries that already ran the old
 * one (e.g. the rotation rule changes from "at least 2" to "2 + album count").
 * A new key means every existing install runs it once more, which is exactly the
 * intent — the marker records "this specific rule has been applied".
 */
const ROTATION_MARKER = `${MARKER_PREFIX}poster-rotation-floor.v2`;
const DURATION_MARKER = `${MARKER_PREFIX}duration-backfill.v1`;

@Injectable()
export class MaintenanceService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MaintenanceService.name);
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly settings: SettingsService,
    private readonly library: LibraryService,
    private readonly posters: PostersService,
    private readonly games: GamesService,
  ) {}

  onApplicationBootstrap(): void {
    // Everything here is an optimisation, never a requirement: if it throws, the
    // app must still serve. Hence fire-and-forget with its own catch.
    void this.run().catch((err) =>
      this.logger.error(`Boot maintenance failed: ${(err as Error)?.stack ?? err}`),
    );
  }

  private async run(): Promise<void> {
    if (this.running) return;
    if (this.enabled() === false) {
      this.logger.log('Boot maintenance disabled (MAINTENANCE_ON_BOOT=0).');
      return;
    }
    this.running = true;
    const t0 = Date.now();
    try {
      // Wait for the initial library scan: media rows must exist before the
      // rotation can be topped up from them, and games must exist at all.
      await this.waitForScan();

      const posters = this.repairPosterRotation();
      const durations = await this.repairDurations();

      const seconds = ((Date.now() - t0) / 1000).toFixed(1);
      if (posters.games > 0 || durations.started) {
        this.logger.log(
          `Boot maintenance finished in ${seconds}s — ` +
            `poster rotation topped up for ${posters.games} game(s) ` +
            `(+${posters.added} frame(s)); ` +
            `completion-time backfill ${
              durations.started ? `started for ${durations.total} game(s)` : 'not needed'
            }.`,
        );
      } else {
        this.logger.log(`Boot maintenance finished in ${seconds}s — nothing to repair.`);
      }
    } finally {
      this.running = false;
    }
  }

  /** `MAINTENANCE_ON_BOOT=0` disables both repairs (used by the test suites). */
  private enabled(): boolean {
    const raw = (process.env.MAINTENANCE_ON_BOOT ?? '').trim().toLowerCase();
    if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
    return true;
  }

  /**
   * Poll until the initial scan finishes.
   *
   * Bounded on purpose: a scan over a huge library can legitimately take minutes,
   * but this repair must not hold a timer forever if the scan wedged, and it must
   * never run *during* a scan — media is still being inserted, so the counts it
   * reads would be half-written.
   *
   * The stop condition is `!isScanning() && hasScanned()`, not just `!isScanning()`.
   * `onApplicationBootstrap` runs while `main.ts` is still inside `listen()`, and
   * the scan is a separate fire-and-forget call — so there is a real window where
   * the scan has not STARTED yet and `isScanning()` is `false`. Treating that as
   * "scan done" made this whole feature a silent no-op: it observed an empty
   * library, correctly concluded there was nothing to repair, and exited in 0.2s
   * while the scan ran 8 seconds later.
   */
  private async waitForScan(): Promise<void> {
    const timeoutMs = Number(process.env.MAINTENANCE_SCAN_TIMEOUT_MS ?? '') || 15 * 60_000;
    const deadline = Date.now() + timeoutMs;
    const step = 500;

    while (this.library.isScanning() || !this.library.hasScanned()) {
      if (Date.now() > deadline) {
        this.logger.warn(
          `Still scanning after ${Math.round(timeoutMs / 1000)}s — running boot ` +
            `maintenance anyway (results may be based on a partial library).`,
        );
        return;
      }
      await new Promise((r) => setTimeout(r, step));
    }
  }

  /**
   * Top every game's poster rotation up to the floor.
   *
   * Runs on EVERY boot rather than once, because it is cheap (pure SQLite, no
   * network) and because "runs once" is the wrong semantics for a repair whose
   * target set grows: a library the user adds games to next week would otherwise
   * never get the treatment. `ensureRotationFloor()` only ever ADDS album frames
   * and never touches a `slideshow_user_set` exclusion or a user's chosen cover,
   * so repeating it is a no-op once a game is at the floor.
   *
   * A marker is still written, for diagnosability only (`docker compose exec`
   * can read it to answer "did this image ever repair the rotation?").
   */
  private repairPosterRotation(): { games: number; added: number } {
    let candidates: { id: string; name: string }[] = [];
    try {
      // The `target = 2 + albumCount` expression is duplicated from
      // PostersService.ensureRotationFloor on purpose: selecting the candidate
      // set has to agree with what that method will do, and it is not exported.
      // Kept here as one SQL statement so a library of thousands of games costs
      // one query instead of thousands.
      candidates = this.db.all<{ id: string; name: string }>(`
        SELECT g.id, g.name
          FROM games g
         WHERE (SELECT COUNT(*) FROM game_posters p
                 WHERE p.game_id = g.id AND p.in_slideshow = 1)
             < MIN(2 + (SELECT COUNT(*) FROM media m
                         WHERE m.game_id = g.id AND m.type = 'image'), 8)
      `);
    } catch (err) {
      this.logger.warn(`Poster rotation query failed: ${(err as Error)?.message}`);
      return { games: 0, added: 0 };
    }

    let games = 0;
    let added = 0;
    for (const g of candidates) {
      try {
        const n = this.posters.ensureRotationFloor(g.id);
        if (n > 0) {
          games += 1;
          added += n;
        }
      } catch (err) {
        // One bad game must not stop the sweep — the rest of the library still
        // deserves its frames.
        this.logger.warn(`Rotation top-up failed for "${g.name}": ${(err as Error)?.message}`);
      }
    }

    this.settings.setValue(ROTATION_MARKER, JSON.stringify({ at: Date.now(), games, added }));
    return { games, added };
  }

  /**
   * Re-ask the completion-time sources for every game that still has none.
   *
   * Marker-guarded because this one DOES hit the network, and the source is
   * rate-limited: repeating a full-library sweep on every restart would be rude to
   * the source and slow to boot for no benefit. Once the sweep has run, the
   * settings card's 「一键批量补全」 covers games added later.
   */
  private async repairDurations(): Promise<{ started: boolean; total: number }> {
    if (this.settings.getValue(DURATION_MARKER)) {
      return { started: false, total: 0 };
    }

    const missing =
      this.db.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM games
          WHERE main_story_hours IS NULL
             OR COALESCE(duration_source, '') <> 'hltb'`,
      )?.c ?? 0;

    // Record the marker even when there is nothing to do, so a library that is
    // already complete does not re-query on every boot.
    if (missing === 0) {
      this.settings.setValue(DURATION_MARKER, JSON.stringify({ at: Date.now(), total: 0 }));
      return { started: false, total: 0 };
    }

    this.logger.log(
      `Completion-time backfill: ${missing} game(s) have no duration yet — ` +
        `asking the sources in the background (first boot of this image only).`,
    );

    const res = await this.games.backfillDurations();

    // Marked AFTER the job starts (not after it finishes): `backfillDurations`
    // is a background bulk job, and marking earlier would risk a crash mid-sweep
    // looking "done" forever.
    this.settings.setValue(DURATION_MARKER, JSON.stringify({ at: Date.now(), total: missing }));
    return res;
  }
}