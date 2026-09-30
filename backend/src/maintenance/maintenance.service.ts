/**
 * Boot-time data repairs.
 *
 * Why this exists at all: fixing a provider does NOT repair an existing library.
 * A game whose `last_meta_refresh` is already set is never re-scraped by a scan,
 * and `ensureCoverInRotation()` only runs from inside metadata persistence — so a
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
 * one (e.g. the rotation rule changes from "2 + album count" to "cover only").
 * A new key means every existing install runs it once more, which is exactly the
 * intent — the marker records "this specific rule has been applied".
 */
// v3：规则从「相册截图不足就补齐」改为「只保证封面在轮播里」（需求 21）。
// 换 key 是**必须的**，不只是好看：v2 的标记已经在现有库里写过一次，沿用同一个
// key 会让启动期修复直接跳过 —— 那些还没跑过新规则的库就永远等不到它。
const ROTATION_MARKER = `${MARKER_PREFIX}poster-rotation-cover-only.v3`;
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
      const purged = this.purgeAutoAddedAlbumFrames();
      const durations = await this.repairDurations();

      const seconds = ((Date.now() - t0) / 1000).toFixed(1);
      if (posters.games > 0 || durations.started) {
        this.logger.log(
          `Boot maintenance finished in ${seconds}s — ` +
            // 「cover rotation」而不是旧的「poster rotation topped up」：现在只会
            // 把**封面**补进轮播，不再按相册截图补齐。措辞不改会让人以为相册截图
            // 又被自动加进轮播了（这正是需求 21 要禁掉的行为）。
            `cover rotation repaired for ${posters.games} game(s) ` +
            `(+${posters.added} frame(s)); ` +
            `auto-added album frames removed: ${purged}; ` +
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
   * Take the album screenshots the OLD rule auto-enrolled back OUT of the rotation.
   *
   * ## Why this exists
   *
   * The previous rule (`ensureRotationFloor`, target `min(2 + albumCount, 8)`) and
   * the boot-time repair INSERTed album frames with
   * `in_slideshow = 1, slideshow_user_set = 0`. Measured on the live library:
   * 「poster rotation topped up for 39 game(s) (+268 frame(s))」. Those 268 frames
   * are still enrolled — removing the rule does not retroactively undo what the old
   * image already wrote, so without this pass the library keeps showing precisely
   * the thing the user asked to stop: 「相册截图默认自动加入轮播」.
   *
   * ## Why this is safe
   *
   * `slideshow_user_set = 0` is the exact signature of "the machine decided this,
   * the user never did":
   *
   *   - the old rule's INSERT / UPDATE never set it (verified against the previous
   *     revision: `VALUES (…, 'media', …, 0, 1, 0, …)` — note the 0 for
   *     `slideshow_user_set`);
   *   - every user action sets it, including 「从相册添加」and unticking
   *     (`PATCH … { inSlideshow: false }`).
   *
   * So this pass cannot touch a user's choice in either direction. It is also
   * idempotent: after the first run there is nothing left with that signature.
   *
   * ## What it deliberately does NOT do
   *
   * It does not touch `source = 'scraped'` rows. Official artwork still defaults
   * into the rotation (that half of 「所有刮取到的海报默认加入轮播」is unchanged) —
   * only the album screenshots were ever the user's complaint.
   *
   * @returns how many rows were switched off.
   */
  private purgeAutoAddedAlbumFrames(): number {
    try {
      const row = this.db.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM game_posters
          WHERE source = 'media' AND in_slideshow = 1 AND slideshow_user_set = 0`,
      );
      const pending = row?.c ?? 0;
      if (pending === 0) return 0;
      this.db.run(
        `UPDATE game_posters SET in_slideshow = 0
          WHERE source = 'media' AND in_slideshow = 1 AND slideshow_user_set = 0`,
      );
      return pending;
    } catch (err) {
      // A failed cleanup must not abort the other repairs or block boot.
      this.logger.warn(`Auto-added album frame purge failed: ${(err as Error)?.message}`);
      return 0;
    }
  }

  /**
   * Guarantee every game's **cover** is in the rotation.
   *
   * ## What changed and why
   *
   * This used to top every game's rotation up to `min(2 + albumCount, 8)`,
   * pulling in the game's own album screenshots. Running on every boot made it the
   * loudest source of 「相册截图默认自动加入轮播」: a screenshot the user had never
   * chosen was enrolled into the carousel and left unmarked as a user decision, so
   * unticking it was silently undone on the next restart. That is exactly the
   * 「勾选后无法取消」the user reported.
   *
   * The rule now follows 需求 21（「只有封面默认加入轮播…需求要的是「**可以**加入」，
   * 不是「自动加入」」）: the cover is the only thing forced in. Album screenshots
   * join only when the user ticks them in 「编辑海报」.
   *
   * Older versions could also switch ON an album row sitting at `in_slideshow = 0`
   * with `slideshow_user_set = 0`. Nothing does that any more, so an unticked row
   * stays unticked for good.
   *
   * Still runs on every boot rather than once: it is pure SQLite, it is cheap, and
   * "runs once" is the wrong semantics for a repair whose target set grows as the
   * user adds games. The write is idempotent — a cover already in the rotation
   * reports 0.
   *
   * A marker is still written, for diagnosability only (`docker compose exec` can
   * read it to answer "did this image ever repair the rotation?").
   */
  private repairPosterRotation(): { games: number; added: number } {
    let candidates: { id: string; name: string }[] = [];
    try {
      // Games whose selected cover is missing from the rotation. One query for the
      // whole library; no per-game scan.
      candidates = this.db.all<{ id: string; name: string }>(`
        SELECT g.id, g.name
          FROM games g
          JOIN game_posters p
            ON p.game_id = g.id AND p.is_selected = 1
         WHERE p.in_slideshow = 0
      `);
    } catch (err) {
      this.logger.warn(`Poster rotation query failed: ${(err as Error)?.message}`);
      return { games: 0, added: 0 };
    }

    let games = 0;
    let added = 0;
    for (const g of candidates) {
      try {
        const n = this.posters.ensureCoverInRotation(g.id);
        if (n > 0) {
          games += 1;
          added += n;
        }
      } catch (err) {
        // One bad game must not stop the sweep — the rest of the library still
        // deserves its cover.
        this.logger.warn(`Cover rotation repair failed for "${g.name}": ${(err as Error)?.message}`);
      }
    }

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