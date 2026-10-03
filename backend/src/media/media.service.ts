/**
 * Media read model: DB-backed listing plus URL resolution.
 *
 * Media rows are written by the scan worker; this service exposes them as API
 * DTOs (with stable `/api/media/:id/...` URLs) to the games controller and the
 * media streaming controller.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import fs from 'fs-extra';
import path from 'path';
import { AppConfig } from '../config/configuration';
import { DatabaseService } from '../database/database.service';
import { JXR_PIPELINE_VERSION } from './jxr-decoder';
import { MediaType } from './media-types';

export interface MediaRow {
  id: string;
  game_id: string;
  file_name: string;
  file_path: string;
  type: MediaType;
  mime_type: string;
  width: number | null;
  height: number | null;
  size_bytes: number;
  file_created_at: number | null;
  duration_seconds: number | null;
  thumb_path: string | null;
  cover_path: string | null;
  sort_order: number;
}

export interface MediaDto {
  id: string;
  gameId: string;
  fileName: string;
  type: MediaType;
  mimeType: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  createdAt: string | null;
  durationSeconds: number | null;
  streamUrl: string;
  thumbnailUrl: string;
  /** Browser-safe rendition for the lightbox (JXR sources are transcoded). */
  previewUrl: string;
  coverUrl: string | null;
}

@Injectable()
export class MediaService {
  private readonly dataDir: string;
  /** Roots declared via `MEDIA_DIRS`; DB roots are read per call. */
  private readonly envRoots: string[];

  constructor(
    private readonly db: DatabaseService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.dataDir = config.get('dataDir', { infer: true });
    this.envRoots = config.get('mediaDirs', { infer: true });
  }

  listByGame(gameId: string): MediaDto[] {
    const rows = this.db.all<MediaRow>(
      `SELECT * FROM media WHERE game_id = ? ORDER BY sort_order ASC, file_created_at ASC`,
      [gameId],
    );
    return rows.map((r) => this.toDto(r));
  }

  findById(id: string): MediaRow {
    const row = this.db.get<MediaRow>('SELECT * FROM media WHERE id = ?', [id]);
    if (!row) throw new NotFoundException('Media not found');
    return row;
  }

  countByGame(gameId: string): number {
    const row = this.db.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM media WHERE game_id = ?',
      [gameId],
    );
    return row?.c ?? 0;
  }

  toDto(row: MediaRow): MediaDto {
    return {
      id: row.id,
      gameId: row.game_id,
      fileName: row.file_name,
      type: row.type,
      mimeType: row.mime_type,
      width: row.width,
      height: row.height,
      sizeBytes: row.size_bytes,
      createdAt: row.file_created_at
        ? new Date(row.file_created_at).toISOString()
        : null,
      durationSeconds: row.duration_seconds ?? null,
      streamUrl: `/api/media/${row.id}/stream`,
      thumbnailUrl: `/api/media/${row.id}/thumbnail`,
      previewUrl: `/api/media/${row.id}/preview`,
      coverUrl: row.cover_path ? `/api/media/${row.id}/cover` : null,
    };
  }

  /**
   * Delete one media item: its DB row, the original file on disk, every cached
   * rendition (thumbnail / cover / preview) and any poster row that referenced
   * it.
   *
   * The original does NOT live under DATA_DIR — it sits inside one of the user's
   * library roots — so it is only unlinked after confirming the path really sits
   * inside a known root. A stale `file_path` (or one containing `../`) must never
   * be able to delete an arbitrary file on the host.
   *
   * Deletion order follows the existing convention (DB first, files after,
   * silently ignoring unlink failures, no transaction): a half-finished delete
   * then leaves a missing file rather than a row pointing at one.
   */
  async remove(id: string): Promise<{
    ok: true;
    id: string;
    deleted: true;
    removedFiles: number;
    postersRemoved: number;
    originalSkipped: boolean;
  }> {
    const row = this.findById(id);

    // Read before deleting: whether this media was the game's cover poster, and
    // the media URL it produced, decide whether `games.poster_url` needs repair.
    const linked = this.db.all<{ is_selected: number }>(
      'SELECT is_selected FROM game_posters WHERE media_id = ?',
      [id],
    );
    const wasSelectedPoster = linked.some((p) => p.is_selected === 1);

    this.db.run('DELETE FROM media WHERE id = ?', [id]);

    // `game_posters.media_id` has no FK, so such rows would survive as dangling
    // references whose `/api/media/<id>/thumbnail` URL now 404s. Drop them all.
    const postersRemoved = this.db.run('DELETE FROM game_posters WHERE media_id = ?', [id]).changes;

    await this.restoreCoverAfterMediaDelete(row.game_id, id, wasSelectedPoster);

    // Original file — only inside a library root, verified above.
    let removedFiles = 0;
    let originalSkipped = true;
    if (row.file_path && this.isInsideLibraryRoot(row.file_path)) {
      originalSkipped = false;
      const original = path.resolve(row.file_path);
      if (await fs.pathExists(original)) {
        try {
          await fs.remove(original);
          removedFiles += 1;
        } catch {
          /* 删除失败静默：索引行已删，孤儿文件不值得让请求失败 */
        }
      }
    }

    // Cached renditions are always under DATA_DIR, keyed by media id. `thumb_path`
    // / `cover_path` are tried first (that is the path the controller reads), then
    // the plain and JXR-suffixed names, since the row may not carry the path.
    const candidates = new Set<string>();
    if (row.thumb_path) {
      candidates.add(path.join(this.dataDir, 'thumbnails', path.basename(row.thumb_path)));
    }
    candidates.add(path.join(this.dataDir, 'thumbnails', `${id}.webp`));
    candidates.add(path.join(this.dataDir, 'thumbnails', `${id}v${JXR_PIPELINE_VERSION}.webp`));
    if (row.cover_path) {
      candidates.add(path.join(this.dataDir, 'covers', path.basename(row.cover_path)));
    }
    candidates.add(path.join(this.dataDir, 'covers', `${id}.webp`));
    for (const file of candidates) {
      if (!(await fs.pathExists(file))) continue;
      try {
        await fs.remove(file);
        removedFiles += 1;
      } catch {
        /* silent */
      }
    }

    // Previews are named `<id>@…`, but the width/version suffix varies, so sweep
    // the directory for every file belonging to this id.
    const previewsDir = path.join(this.dataDir, 'previews');
    const previews = await fs.readdir(previewsDir).catch(() => [] as string[]);
    for (const name of previews) {
      if (!name.startsWith(`${id}@`)) continue;
      try {
        await fs.remove(path.join(previewsDir, name));
        removedFiles += 1;
      } catch {
        /* silent */
      }
    }

    return { ok: true, id, deleted: true, removedFiles, postersRemoved, originalSkipped };
  }

  /**
   * Repair the game's cover after its media row (and any media-poster row) is
   * gone, so the card never points at the now-dead `/api/media/<id>/…` URL.
   *
   * Mirrors `PostersService.remove()` (promote the next poster; else fall back to
   * the game's first local screenshot) but is implemented inline rather than by
   * injecting `PostersService`: `PostersModule` already imports `MediaModule`, so
   * injecting it back would create a module cycle. Behaviour is intentionally
   * identical — the fallback list/selection order matches.
   */
  private async restoreCoverAfterMediaDelete(
    gameId: string,
    mediaId: string,
    wasSelectedPoster: boolean,
  ): Promise<void> {
    const posterUrl =
      this.db.get<{ poster_url: string | null }>('SELECT poster_url FROM games WHERE id = ?', [
        gameId,
      ])?.poster_url ?? null;
    // Only act when the cover actually broke (the deleted media owned it).
    const pointsAtDeleted = !!posterUrl && this.posterUrlReferencesMedia(posterUrl, mediaId);
    if (!wasSelectedPoster && !pointsAtDeleted) return;

    // A surviving poster already marked selected: just re-mirror its URL so it
    // wins over the dangling one.
    const existing = this.db.get<{ id: string; url: string; source: string }>(
      'SELECT id, url, source FROM game_posters WHERE game_id = ? AND is_selected = 1 LIMIT 1',
      [gameId],
    );
    if (existing) {
      this.db.run('UPDATE games SET poster_url = ?, updated_at = ? WHERE id = ?', [
        existing.source === 'upload' ? `/api/posters/${existing.id}/image` : existing.url,
        Date.now(),
        gameId,
      ]);
      return;
    }

    // Otherwise promote the next available poster (same order `PostersService`
    // uses), recording it as the app's choice, not the user's.
    const next = this.db.get<{ id: string; url: string; source: string }>(
      `SELECT id, url, source FROM game_posters WHERE game_id = ?
       ORDER BY is_selected DESC, sort_order ASC, created_at ASC LIMIT 1`,
      [gameId],
    );
    if (next) {
      this.db.run('UPDATE game_posters SET is_selected = 1, is_user_choice = 0 WHERE id = ?', [
        next.id,
      ]);
      this.db.run('UPDATE games SET poster_url = ?, updated_at = ? WHERE id = ?', [
        next.source === 'upload' ? `/api/posters/${next.id}/image` : next.url,
        Date.now(),
        gameId,
      ]);
      return;
    }

    // No posters left — fall back to the game's first local screenshot, exactly
    // like a freshly scanned game, or clear the cover when there is none.
    const first = this.db.get<{ id: string }>(
      `SELECT id FROM media WHERE game_id = ? AND type IN ('image','gif')
       ORDER BY file_created_at ASC LIMIT 1`,
      [gameId],
    );
    this.db.run('UPDATE games SET poster_url = ? WHERE id = ?', [
      first ? `/api/media/${first.id}/thumbnail` : null,
      gameId,
    ]);
  }

  /**
   * Path-safety gate for deleting the original file.
   *
   * `path.resolve` collapses `..` first, then the result must be the root itself
   * or start with `root + separator` — the separator matters, otherwise a sibling
   * like `/media-evil` would look like it lives under `/media`.
   */
  private isInsideLibraryRoot(filePath: string): boolean {
    const roots = [...this.envRoots];
    for (const r of this.db.all<{ path: string }>('SELECT path FROM library_roots')) {
      if (r.path) roots.push(r.path);
    }
    const resolved = path.resolve(filePath);
    return roots.some((root) => {
      if (!root) return false;
      const base = path.resolve(root);
      return resolved === base || resolved.startsWith(base + path.sep);
    });
  }

  /** Does a poster URL point at `/api/media/<mediaId>/…` (segment-exact)? */
  private posterUrlReferencesMedia(url: string, mediaId: string): boolean {
    const escaped = mediaId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`/api/media/${escaped}/`).test(url);
  }
}