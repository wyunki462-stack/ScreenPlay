/**
 * Boot-time data repairs.
 *
 * Why this exists at all: fixing a provider does NOT repair an existing library.
 * A game whose `last_meta_refresh` is already set is never re-scraped by a scan,
 * so a library that was built before a fix keeps the old symptoms forever:
 *
 *   - 「相册截图默认自动加入轮播」  → the old rotation floor had enrolled album
 *     screenshots, and removing the rule does not retract what it already wrote;
 *   - 通关时长显示「未知」         → the duration sources were never re-asked.
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
import { GamesService } from '../games/games.service';

/** Marker keys recorded in the `settings` table (same store as the API keys). */
const MARKER_PREFIX = 'maintenance.';

/**
 * Version markers for repairs that must run ONCE per library.
 *
 * Bumped whenever such a repair must run again on installs that already ran the
 * old one: a new key means every existing install runs it once more, which is
 * exactly the intent — the marker records "this specific rule has been applied".
 *
 * Only `repairDurations` uses this scheme today: it hits rate-limited network
 * sources, so it has to guard-and-skip. The auto-added-frame cleanup
 * (`removeAutoAddedFramesFromRotation`) deliberately runs on every boot instead:
 * it is cheap pure SQLite, it is idempotent, and its target set grows as the user
 * keeps the library — so a "has this rule run?" marker would be the wrong
 * semantics.
 */
const DURATION_MARKER = `${MARKER_PREFIX}duration-backfill.v1`;

@Injectable()
export class MaintenanceService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MaintenanceService.name);
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly settings: SettingsService,
    private readonly library: LibraryService,
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
      // Wait for the initial library scan: games and media rows must exist before
      // the cleanup can look at them.
      await this.waitForScan();

      const autoRemoved = this.removeAutoAddedFramesFromRotation();
      const durations = await this.repairDurations();

      const seconds = ((Date.now() - t0) / 1000).toFixed(1);
      // `autoRemoved` MUST be part of this condition.
      //
      // It was missing once, and that hid the very evidence this repair is judged
      // by: a boot whose only work was the cleanup skipped the detailed line and
      // logged 「nothing to repair.」— while having in fact just taken 268 album
      // frames out of the rotation. The data proved the cleanup ran (268 → 0) but
      // the log said nothing happened, which sent the investigation looking for a
      // nonexistent second cause.
      if (autoRemoved > 0 || durations.started) {
        this.logger.log(
          `Boot maintenance finished in ${seconds}s — ` +
            `auto-added frames removed from the card rotation: ${autoRemoved}; ` +
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
   * Take every MACHINE-enrolled frame — from ANY source — back OUT of the card
   * rotation, leaving only the frames the user ticked.
   *
   * ## Why this exists
   *
   * `in_slideshow = 1, slideshow_user_set = 0` is the exact signature of "the
   * machine decided this, the user never did". Older rules enrolled frames with
   * that signature: the boot-time `ensureCoverInRotation` forced the cover in, and
   * the rotation floor (`ensureRotationFloor`) added the game's own album
   * screenshots. Measured on the live library:
   * 「poster rotation topped up for 39 game(s) (+268 frame(s))」. Removing those
   * rules does not retroactively undo what the old image already wrote, so without
   * this pass the library keeps showing precisely the thing the user asked to stop:
   * frames the user never ticked sitting in the card rotation.
   *
   * It covers EVERY source (scraped / upload / media), because the card rotation
   * is now purely the user's ticked set — official artwork must not stay enrolled
   * by default either. The detail-page hero is unaffected: it rotates the official
   * posters itself and reads no flag.
   *
   * ## Why this is safe
   *
   * `slideshow_user_set = 0` is exactly "the machine decided this". Every user
   * action sets it, including 「从相册添加」and unticking
   * (`PATCH … { inSlideshow: false }`), so this pass cannot touch a user's choice
   * in either direction. It is also idempotent: after the first run nothing is
   * left with that signature.
   *
   * @returns how many rows were switched off.
   */
  private removeAutoAddedFramesFromRotation(): number {
    try {
      const row = this.db.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM game_posters
          WHERE in_slideshow = 1 AND slideshow_user_set = 0`,
      );
      const pending = row?.c ?? 0;
      if (pending === 0) return 0;
      this.db.run(
        `UPDATE game_posters SET in_slideshow = 0
          WHERE in_slideshow = 1 AND slideshow_user_set = 0`,
      );
      return pending;
    } catch (err) {
      // A failed cleanup must not abort the other repairs or block boot.
      this.logger.warn(`Auto-added frame cleanup failed: ${(err as Error)?.message}`);
      return 0;
    }
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