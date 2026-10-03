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
import { ConfigService } from '@nestjs/config';
import fs from 'fs-extra';
import path from 'path';
import { AppConfig } from '../config/configuration';
import { DatabaseService } from '../database/database.service';
import { SettingsService } from '../settings/settings.service';
import { LibraryService } from '../library/library.service';
import { GamesService } from '../games/games.service';
import { MetadataCacheService } from '../common/cache/metadata-cache.service';

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

/**
 * Cadence of the recurring cache housekeeping (see `reclaimCaches`).
 *
 * The boot pass alone is not enough: a NAS container runs for weeks, and the two
 * caches it trims (`metadata_cache` rows, `proxied/` images) only grow while the
 * user keeps browsing. Six hours is deliberately unhurried — this is pure disk
 * tidying, and 0 disables the timer (boot pass still runs).
 */
const HOUSEKEEPING_INTERVAL_MS =
  Number(process.env.HOUSEKEEPING_INTERVAL_MS ?? '') || 6 * 60 * 60_000;

/**
 * Never remove a derived file younger than this.
 *
 * Runs concurrently with normal serving, so a file could be mid-write when the
 * sweep looks at it. A rendition is written once and then left alone, so anything
 * an hour old is finished, and skipping the newest files makes a race impossible
 * without needing a lock.
 */
const HOUSEKEEPING_MIN_AGE_MS = 60 * 60_000;

/**
 * Age at which a cached remote image is considered stale (it is re-downloadable).
 *
 * `PROXIED_CACHE_TTL_DAYS=0` (or any non-positive value) **disables the sweep** —
 * an explicit "keep this cache forever". That case has to be read separately from
 * the default: a bare `Number(x) || 30` would turn an explicit `0` back into 30
 * days, which is a silent trap for anyone reaching for 0 to mean "off".
 */
const PROXIED_TTL_DAYS = (process.env.PROXIED_CACHE_TTL_DAYS ?? '').trim();
const PROXIED_TTL_MS = (() => {
  const days = PROXIED_TTL_DAYS === '' ? 30 : Number(PROXIED_TTL_DAYS);
  // Unparseable values keep the default rather than silently switching the sweep off.
  return (Number.isFinite(days) ? days : 30) * 24 * 60 * 60_000;
})();

/**
 * Names of the renditions this app generates itself, all derived from a media
 * row's id (`uuidv5`) and re-creatable from the original file at any time:
 *
 *   thumbnails/  `<id>.webp`      `<id>v2.webp`
 *   covers/      `<id>.webp`
 *   previews/    `<id>@w2560.webp`  `<id>@full.webp`  (each with an optional `vN`)
 *
 * A media id contains only UUID characters, so anything that does NOT match this
 * shape is not ours and is left alone — that is what keeps the sweep from ever
 * touching an unknown file. `posters/` is user data and is never swept at all.
 */
const DERIVED_RENDITION = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:@(?:w\d+|full))?(?:v\d+)?\.webp$/;

/** How many files the sweep inspects at once (bounds open descriptors). */
const SWEEP_CONCURRENCY = 64;

interface SweepStats {
  files: number;
  bytes: number;
}

interface ReclaimStats {
  cacheRows: number;
  files: number;
  bytes: number;
}

/** Human-readable byte count for the sweep's log lines. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

@Injectable()
export class MaintenanceService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MaintenanceService.name);
  private readonly dataDir: string;
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly settings: SettingsService,
    private readonly library: LibraryService,
    private readonly games: GamesService,
    private readonly cache: MetadataCacheService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.dataDir = config.get('dataDir', { infer: true });
  }

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
      const reclaimed = await this.reclaimCaches();

      const seconds = ((Date.now() - t0) / 1000).toFixed(1);
      // `autoRemoved` MUST be part of this condition.
      //
      // It was missing once, and that hid the very evidence this repair is judged
      // by: a boot whose only work was the cleanup skipped the detailed line and
      // logged 「nothing to repair.」— while having in fact just taken 268 album
      // frames out of the rotation. The data proved the cleanup ran (268 → 0) but
      // the log said nothing happened, which sent the investigation looking for a
      // nonexistent second cause.
      if (autoRemoved > 0 || durations.started || reclaimed.cacheRows > 0 || reclaimed.files > 0) {
        this.logger.log(
          `Boot maintenance finished in ${seconds}s — ` +
            `auto-added frames removed from the card rotation: ${autoRemoved}; ` +
            `completion-time backfill ${
              durations.started ? `started for ${durations.total} game(s)` : 'not needed'
            }; ` +
            `caches reclaimed: ${reclaimed.cacheRows} expired cache row(s), ` +
            `${reclaimed.files} stale file(s) (${formatBytes(reclaimed.bytes)}).`,
        );
      } else {
        this.logger.log(`Boot maintenance finished in ${seconds}s — nothing to repair.`);
      }

      // Keep trimming while the container runs (see HOUSEKEEPING_INTERVAL_MS).
      this.scheduleHousekeeping();
    } finally {
      this.running = false;
    }
  }

  /**
   * Recurring cache housekeeping, chained through `setTimeout` rather than
   * `setInterval` so a slow pass (or a temporary failure) can never pile up
   * overlapping sweeps.
   *
   * `unref()` keeps the timer from holding the process open by itself — the HTTP
   * server is what keeps this app alive, and a stray handle here would show up as
   * "shutdown hangs" in every test that boots the app.
   */
  private scheduleHousekeeping(): void {
    if (HOUSEKEEPING_INTERVAL_MS <= 0) return;
    const timer = setTimeout(() => void this.housekeepingTick(), HOUSEKEEPING_INTERVAL_MS);
    timer.unref?.();
  }

  private async housekeepingTick(): Promise<void> {
    try {
      // A scan is writing media rows and renditions at full tilt; sweeping then
      // would race the scan for disk and could judge a brand-new media row's
      // rendition an orphan. Skip and wait for the next tick instead.
      if (this.library.isScanning()) {
        this.logger.log('Housekeeping skipped: library scan in progress.');
      } else {
        const stats = await this.reclaimCaches();
        if (stats.cacheRows > 0 || stats.files > 0) {
          this.logger.log(
            `Housekeeping reclaimed ${stats.cacheRows} expired cache row(s) and ` +
              `${stats.files} stale file(s) (${formatBytes(stats.bytes)}).`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(`Housekeeping failed: ${(err as Error)?.stack ?? err}`);
    } finally {
      this.scheduleHousekeeping();
    }
  }

  /**
   * Delete the caches that live on the data volume and would otherwise grow
   * forever. Nothing here is user data:
   *
   *   1. `metadata_cache` rows past their TTL — provider responses (30d/7d/15d)
   *      that are simply re-fetched when needed. `prune()` existed for exactly
   *      this and had no caller, so the table only ever grew.
   *   2. `proxied/` images older than `PROXIED_CACHE_TTL_DAYS` (30) — the disk
   *      cache behind `/api/media/proxy?url=…`. The database stores the SOURCE
   *      url, never this path, so a removed file is re-downloaded on the next
   *      request and no row ever points at a missing file. Set the variable to `0`
   *      to keep this cache forever (an image whose source url has since gone away
   *      could otherwise become a broken picture after the TTL).
   *   3. renderings of media rows that no longer exist: thumbnails/covers/
   *      previews for a game the user deleted, or for an album file that was
   *      removed. They can never be requested again, and if the file comes back
   *      the row gets a new id, so these are pure garbage.
   *
   * `posters/` is deliberately not touched — those are the user's own uploads.
   */
  private async reclaimCaches(): Promise<ReclaimStats> {
    const stats: ReclaimStats = { cacheRows: 0, files: 0, bytes: 0 };

    try {
      stats.cacheRows = this.cache.prune();
    } catch (err) {
      this.logger.warn(`metadata_cache prune failed: ${(err as Error)?.message}`);
    }

    // `PROXIED_CACHE_TTL_DAYS=0` means "keep it forever" (see PROXIED_TTL_MS).
    if (PROXIED_TTL_MS > 0) {
      const proxied = await this.sweepFiles(path.join(this.dataDir, 'proxied'), {
        maxAgeMs: PROXIED_TTL_MS,
      });
      stats.files += proxied.files;
      stats.bytes += proxied.bytes;
    }

    const live = this.liveMediaIds();
    if (live) {
      for (const dir of ['thumbnails', 'covers', 'previews']) {
        const swept = await this.sweepFiles(path.join(this.dataDir, dir), {
          maxAgeMs: HOUSEKEEPING_MIN_AGE_MS,
          keepIds: live,
        });
        stats.files += swept.files;
        stats.bytes += swept.bytes;
      }
    }
    return stats;
  }

  /**
   * Every media id still in the library.
   *
   * Returns `null` — meaning "do not sweep any rendition" — when the media table
   * is empty. An empty table is far more likely to be a database that has not
   * been populated yet (or a misconfigured `DATA_DIR`) than a real library with
   * zero files, and in that state every rendition on disk would look like an
   * orphan. The whole thumbnail cache is not worth risking on that guess.
   */
  private liveMediaIds(): Set<string> | null {
    try {
      const rows = this.db.all<{ id: string }>('SELECT id FROM media');
      if (rows.length === 0) {
        this.logger.log('Rendition sweep skipped: no media rows in the database.');
        return null;
      }
      return new Set(rows.map((r) => r.id));
    } catch (err) {
      this.logger.warn(`Rendition sweep skipped: ${(err as Error)?.message}`);
      return null;
    }
  }

  /**
   * Remove cache files from one directory.
   *
   * Two modes, one method, because they share the only tricky part (racing a
   * concurrent writer): every candidate must be older than `maxAgeMs`, and when
   * `keepIds` is given the name must parse as a derived rendition whose media id
   * is NOT in that set. Anything else — an unknown name, a `keepIds` hit, a
   * directory, a file that vanished between listing and `stat` — is left exactly
   * as it is.
   */
  private async sweepFiles(
    dir: string,
    opts: { maxAgeMs: number; keepIds?: Set<string> },
  ): Promise<SweepStats> {
    const stats: SweepStats = { files: 0, bytes: 0 };
    let names: string[];
    try {
      if (!(await fs.pathExists(dir))) return stats;
      names = await fs.readdir(dir);
    } catch (err) {
      this.logger.warn(`Cache sweep of ${dir} failed: ${(err as Error)?.message}`);
      return stats;
    }

    const cutoff = Date.now() - opts.maxAgeMs;
    for (let i = 0; i < names.length; i += SWEEP_CONCURRENCY) {
      const chunk = names.slice(i, i + SWEEP_CONCURRENCY);
      await Promise.all(
        chunk.map(async (name) => {
          if (opts.keepIds) {
            const match = DERIVED_RENDITION.exec(name);
            if (!match || opts.keepIds.has(match[1])) return;
          }
          const file = path.join(dir, name);
          try {
            const info = await fs.stat(file);
            if (!info.isFile() || info.mtimeMs > cutoff) return;
            await fs.remove(file);
            stats.files += 1;
            stats.bytes += info.size;
          } catch {
            // Raced with a writer or the file disappeared — next pass handles it.
          }
        }),
      );
    }
    return stats;
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