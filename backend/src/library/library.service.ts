/**
 * Media library scanner.
 *
 * One top-level directory per media root = one game. Media files are discovered
 * recursively (any depth), timed, normalised, thumbnailed and persisted. Scans
 * are idempotent: game/media ids are deterministic (UUIDv5 of the path), so
 * re-scans keep the same rows and reuse cached thumbnails.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import fs from 'fs-extra';
import path from 'path';
import fg from 'fast-glob';
import { v5 as uuidv5 } from 'uuid';
import { AppConfig } from '../config/configuration';
import { DatabaseService } from '../database/database.service';
import { GameRecognizerService } from './game-recognizer.service';
import { LibraryRootsService } from './library-roots.service';
import {
  computeDurations,
  FileMoment,
  parseTimestampFromFileName,
} from './duration.service';
import { MediaProcessorService } from '../media/media-processor.service';
import { MediaType, resolveFormat, supportedExtensions } from '../media/media-types';

const UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

interface GameRow {
  id: string;
  manual_override: number;
}

@Injectable()
export class LibraryService {
  private readonly logger = new Logger(LibraryService.name);
  private scanning = false;
  private lastScanAt: number | null = null;
  private totalMedia = 0;
  private totalGames = 0;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly db: DatabaseService,
    private readonly recognizer: GameRecognizerService,
    private readonly processor: MediaProcessorService,
    private readonly roots: LibraryRootsService,
  ) {
    // MEDIA_DIRS is still read so the initial (pre-DB) state matches compose.
    this.envMediaDirs = this.config.get('mediaDirs', { infer: true });
  }

  /** Fallback roots when the database has none yet (first boot). */
  private readonly envMediaDirs: string[];

  isScanning(): boolean {
    return this.scanning;
  }

  /**
   * Whether the library has ever been scanned to completion.
   *
   * Exposed for `MaintenanceService`, which must not start repairing against a
   * library that has not been enumerated yet. `isScanning()` alone is not enough:
   * before the first scan is kicked off it is also `false`, so "not scanning"
   * would be misread as "scan finished, library is complete".
   */
  hasScanned(): boolean {
    return this.lastScanAt !== null;
  }

  status(): { scanning: boolean; lastScanAt: string | null; totalGames: number; totalMedia: number } {
    return {
      scanning: this.scanning,
      lastScanAt: this.lastScanAt ? new Date(this.lastScanAt).toISOString() : null,
      totalGames: this.totalGames,
      totalMedia: this.totalMedia,
    };
  }

  /** Trigger a full re-scan without blocking the caller. */
  startScan(): void {
    if (this.scanning) return;
    this.scanning = true;
    // Fire-and-forget; the status endpoint reports progress/completion.
    void this.runScan()
      .catch((err) => this.logger.error(`Scan failed: ${(err as Error)?.stack ?? err}`))
      .finally(() => {
        this.scanning = false;
        this.lastScanAt = Date.now();
      });
  }

  /** Run the scan synchronously (also used by tests). */
  async runScan(): Promise<{ games: number; media: number }> {
    // Roots come from the DB (user-managed, hot-reloadable) merged with
    // MEDIA_DIRS. This is what makes "add a library from the web UI" work
    // without rebuilding the container.
    const roots = await this.roots.activeRoots();
    const effective = roots.length
      ? roots
      : this.envMediaDirs.map((p) => ({ path: p, mediaType: 'auto' as const, recursive: true }));

    if (effective.length === 0) {
      this.logger.warn('No media library roots configured; nothing to scan');
    }

    for (const root of effective) {
      if (!(await fs.pathExists(root.path))) {
        this.logger.warn(`Media dir does not exist, skipping: ${root.path}`);
        continue;
      }
      // Per-root media-type filter (image / video / auto).
      const exts = supportedExtensions().filter((ext) => {
        if (root.mediaType === 'auto') return true;
        return resolveFormat(`x.${ext}`)?.type === root.mediaType;
      });
      const patterns = [
        root.recursive ? `**/*.{${exts.join(',')}}` : `*.{${exts.join(',')}}`,
      ];

      this.logger.log(
        `Scanning media root: ${root.path} (type=${root.mediaType}, recursive=${root.recursive})`,
      );

      // Non-recursive roots may still nest one level (root/<game>/<file>).
      const gameDirs = root.recursive
        ? await this.listGameDirs(root.path)
        : await this.listGameDirs(root.path);
      for (const gameDir of gameDirs) {
        await this.scanGame(gameDir, patterns);
      }
      // A non-recursive root can also *be* the game folder itself.
      if (!root.recursive) {
        await this.scanGame(root.path, patterns);
      }
    }

    await this.pruneMissingGames();
    const mediaCount = this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM media')?.c ?? 0;
    const gameCount = this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM games')?.c ?? 0;
    this.totalMedia = mediaCount;
    this.totalGames = gameCount;
    this.logger.log(`Scan complete: ${gameCount} games, ${mediaCount} media files`);
    return { games: gameCount, media: mediaCount };
  }

  // ---------------------------------------------------------------------------

  /** Direct sub-directories of a media root = game folders. */
  private async listGameDirs(root: string): Promise<string[]> {
    const entries = await fg('*', {
      cwd: root,
      onlyDirectories: true,
      dot: false,
    });
    return entries.map((e) => path.join(root, e)).sort();
  }

  private async scanGame(gameDir: string, patterns: string[]): Promise<void> {
    const folderName = path.basename(gameDir);
    const gameId = uuidv5(gameDir, UUID_NAMESPACE);
    const existing = this.db.get<GameRow>('SELECT id, manual_override FROM games WHERE id = ?', [gameId]);

    const files = await fg(patterns, {
      cwd: gameDir,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
      caseSensitiveMatch: false,
    }).catch(() => [] as string[]);

    const mediaFiles = files
      .map((rel) => path.join(gameDir, rel))
      .filter((abs) => resolveFormat(abs) != null);

    // Collect file moments + stats.
    const moments: FileMoment[] = [];
    const stats = new Map<string, { size: number; createdAtMs: number }>();
    for (const abs of mediaFiles) {
      const st = await fs.stat(abs).catch(() => null);
      if (!st) continue;
      const fromName = parseTimestampFromFileName(path.basename(abs));
      const createdAtMs = fromName ?? st.birthtimeMs ?? st.ctimeMs ?? st.mtimeMs;
      stats.set(abs, { size: st.size, createdAtMs });
      moments.push({
        path: abs,
        createdAtMs,
        modifiedAtMs: st.mtimeMs,
      });
    }

    const duration = computeDurations(gameDir, moments);

    // Upsert game row.
    if (!existing) {
      const name = this.recognizer.normalize(folderName);
      this.db.run(
        `INSERT INTO games
           (id, folder_name, folder_path, name, platform, aliases, manual_override,
            first_played_at, last_played_at, duration_seconds,
            main_duration_seconds, completionist_duration_seconds,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, '[]', 0, ?, ?, ?, ?, ?, ?, ?)`,
        [
          gameId, folderName, gameDir, name,
          duration.overall.firstMs, duration.overall.lastMs, duration.overallSeconds,
          duration.mainSeconds || null, duration.completionistSeconds || null,
          Date.now(), Date.now(),
        ],
      );
    } else {
      // Re-normalize the display name on every scan unless the user renamed it
      // manually (manual_override). This fixes names persisted by older builds.
      if (!existing.manual_override) {
        this.db.run('UPDATE games SET name = ? WHERE id = ?', [
          this.recognizer.normalize(folderName),
          gameId,
        ]);
      }
      this.db.run(
        `UPDATE games SET
           first_played_at = ?, last_played_at = ?, duration_seconds = ?,
           main_duration_seconds = ?, completionist_duration_seconds = ?,
           updated_at = ?
         WHERE id = ?`,
        [
          duration.overall.firstMs, duration.overall.lastMs, duration.overallSeconds,
          duration.mainSeconds || null, duration.completionistSeconds || null,
          Date.now(), gameId,
        ],
      );
    }

    // Dedup: an image used as a video's cover shouldn't also appear as its own
    // standalone entry — the same basename sibling image is already the cover.
    const coverPaths = new Set<string>();
    for (const abs of mediaFiles) {
      if (resolveFormat(abs)?.type === 'video') {
        const cover = this.processor.findSiblingCover(abs);
        if (cover) coverPaths.add(cover.toLowerCase());
      }
    }
    const mediaToUpsert = mediaFiles.filter((abs) => !coverPaths.has(abs.toLowerCase()));

    // Upsert media rows and thumbnails (bounded concurrency).
    const seenIds = new Set<string>();
    await mapLimit(mediaToUpsert, 4, async (abs) => {
      const id = uuidv5(abs, UUID_NAMESPACE);
      seenIds.add(id);
      const format = resolveFormat(abs);
      if (!format) return;
      const stat = stats.get(abs);
      if (!stat) return;

      const fileCreatedAt = stat.createdAtMs;
      let thumbName: string | null = null;
      let coverName: string | null = null;
      let durationSeconds: number | null = null;

      thumbName = await this.processor.generateThumbnail(id, abs, format.type);
      if (format.type === 'video') {
        const cover = await this.processor.resolveVideoCover(id, abs);
        coverName = cover?.fileName ?? null;
        durationSeconds = await this.probeVideoDuration(abs);
      }

      const existingMedia = this.db.get('SELECT id FROM media WHERE id = ?', [id]);
      if (existingMedia) {
        this.db.run(
          `UPDATE media SET size_bytes = ?, file_created_at = ?, duration_seconds = ?,
             thumb_path = COALESCE(?, thumb_path), cover_path = COALESCE(?, cover_path)
           WHERE id = ?`,
          [stat.size, fileCreatedAt, durationSeconds, thumbName, coverName, id],
        );
      } else {
        this.db.run(
          `INSERT INTO media
            (id, game_id, file_name, file_path, type, mime_type, size_bytes,
             file_created_at, duration_seconds, thumb_path, cover_path, sort_order, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id, gameId, path.basename(abs), abs, format.type, format.mimeType,
            stat.size, fileCreatedAt, durationSeconds, thumbName, coverName,
            mediaToUpsert.indexOf(abs), Date.now(),
          ],
        );
      }
    });

    // Remove media rows for files that vanished since the last scan.
    const all = this.db.all<{ id: string }>('SELECT id FROM media WHERE game_id = ?', [gameId]);
    for (const row of all) {
      if (!seenIds.has(row.id)) {
        this.db.run('DELETE FROM media WHERE id = ?', [row.id]);
      }
    }

    // Ensure a local poster (first image thumbnail) exists for games without one yet.
    this.ensureLocalPoster(gameId);

    // JXR previews are expensive (~4 s and ~160 MB for a 3840×2160 HDR frame),
    // so do them here instead of on the user's first click. Bounded to a single
    // worker: each transcode allocates a ~126 MB float view plus a 31 MB RGBA
    // buffer inside the WASM heap, and running several in parallel was measured
    // to be memory-bound rather than CPU-bound.
    await this.warmJxrPreviews(gameId);
  }

  /**
   * Pre-generate the lightbox-sized WebP for a game's JXR media.
   *
   * Scans used to produce only thumbnails, so opening a JXR screenshot in the
   * lightbox paid the full decode cost on the main request path (measured
   * 3.4-4.5 s). Warming the same rendition the viewer asks for makes the first
   * open a cache hit. Failures are logged and skipped: a file that cannot be
   * decoded must not abort the scan.
   */
  private async warmJxrPreviews(gameId: string): Promise<void> {
    const rows = this.db.all<{ id: string; file_path: string; type: MediaType }>(
      `SELECT id, file_path, type FROM media
        WHERE game_id = ? AND (lower(file_path) LIKE '%.jxr'
           OR lower(file_path) LIKE '%.wdp' OR lower(file_path) LIKE '%.hdp')`,
      [gameId],
    );
    if (!rows.length) return;

    let warmed = 0;
    for (const row of rows) {
      try {
        // One decode produces the thumbnail, the lightbox preview and the
        // full-size rendition together, so all three are cache hits for the
        // user and the three sizes are guaranteed to share one tone mapping.
        const done = await this.processor.warmJxrRenditions(row.id, row.file_path);
        if (done.preview) warmed += 1;
      } catch (err) {
        this.logger.warn(
          `JXR preview warm failed for ${row.file_path}: ${(err as Error)?.message ?? err}`,
        );
      }
    }
    if (warmed) {
      this.logger.log(
        `Pre-generated JXR renditions for ${warmed}/${rows.length} file(s) in ${gameId}`,
      );
    }
  }

  private async probeVideoDuration(abs: string): Promise<number | null> {
    // Deferred to ffprobe via fluent-ffmpeg (lazy require keeps startup light).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffmpeg = require('fluent-ffmpeg');
    return new Promise((resolve) => {
      ffmpeg.ffprobe(abs, (err: Error | null, data: { format?: { duration?: number } }) => {
        if (err || !data?.format?.duration) return resolve(null);
        resolve(Math.round(data.format.duration));
      });
    });
  }

  private ensureLocalPoster(gameId: string): void {
    const game = this.db.get<{ poster_url: string | null }>(
      'SELECT poster_url FROM games WHERE id = ?',
      [gameId],
    );
    if (game && game.poster_url) return;
    const firstImage = this.db.get<{ id: string }>(
      `SELECT id FROM media WHERE game_id = ? AND type IN ('image','gif')
       ORDER BY file_created_at ASC LIMIT 1`,
      [gameId],
    );
    if (firstImage) {
      this.db.run('UPDATE games SET poster_url = ? WHERE id = ?', [
        `/api/media/${firstImage.id}/thumbnail`,
        gameId,
      ]);
    }
  }

  private async pruneMissingGames(): Promise<void> {
    const rows = this.db.all<{ id: string; folder_path: string }>('SELECT id, folder_path FROM games');
    for (const row of rows) {
      if (!(await fs.pathExists(row.folder_path))) {
        this.db.run('DELETE FROM games WHERE id = ?', [row.id]);
        this.logger.log(`Removed missing game: ${row.folder_path}`);
      }
    }
  }
}

/** Run an async mapper with a bounded concurrency. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}