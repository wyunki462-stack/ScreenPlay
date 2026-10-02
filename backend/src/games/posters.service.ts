/**
 * Custom & multiple posters per game (features 4 and 5).
 *
 * A game can own several posters. Exactly one (at most) is marked selected —
 * that is the game's cover, and it is always the first frame of the home-card
 * carousel, whatever the 「轮播」 checkbox says.
 *
 * `inSlideshow` is the **home-card** switch: the user ticks a poster in
 * 「编辑海报」to add it to the card rotation (`GamesService.cardPosters`). It does
 * NOT control the detail-page hero carousel — that one auto-rotates every
 * official poster (source `scraped`/`upload`) with no configuration.
 *
 * Three sources are supported:
 *   upload  — a file the user uploaded from their device (stored under DATA_DIR)
 *   media   — an existing album image of this game, referenced by media id
 *   scraped — the poster that came from the metadata provider
 *
 * The chosen poster is mirrored onto `games.poster_url` so every existing code
 * path (gallery card, detail header, carousel) keeps working unchanged.
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import fs from 'fs-extra';
import path from 'path';
import sharp from 'sharp';
import { v5 as uuidv5 } from 'uuid';
import { AppConfig } from '../config/configuration';
import { DatabaseService } from '../database/database.service';
import { MediaProcessorService } from '../media/media-processor.service';
import { isJxrBuffer, isJxrPath, jxrToWebp } from '../media/jxr-decoder';

const UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

export interface PosterDto {
  id: string;
  gameId: string;
  /** URL safe for the browser (uploads point at the poster endpoint). */
  url: string;
  /**
   * Lightweight preview of the same picture, for cramped tiles.
   *
   * `url` for a media poster is the full `/preview` rendition — 2.5-9.8 MB for a
   * 4K screenshot, which is what made the poster manager crawl. `thumbUrl` is
   * the disk-cached ~6 KB thumbnail of the same image, so grids can render an
   * identical-looking tile for three orders of magnitude less bandwidth.
   */
  thumbUrl: string;
  source: 'upload' | 'media' | 'scraped';
  mediaId: string | null;
  isSelected: boolean;
  /**
   * True only when this poster is the cover AND is not the official artwork —
   * i.e. the user made a non-default choice that can be cancelled. The UI uses
   * this to decide whether to offer "取消封面": offering it on the official
   * poster would be a no-op, because cancelling legitimately restores it.
   */
  isCover: boolean;
  inSlideshow: boolean;
  sortOrder: number;
  createdAt: string;
}

interface PosterRow {
  id: string;
  game_id: string;
  url: string;
  source: string;
  media_id: string | null;
  is_selected: number;
  /** 1 when the *user* picked this cover, 0 when the app chose it. */
  is_user_choice: number;
  in_slideshow: number;
  /** 1 when the *user* decided this poster's slideshow membership. */
  slideshow_user_set: number;
  sort_order: number;
  created_at: number;
}

/**
 * Compare two poster URLs for "same picture".
 *
 * A cover may be stored raw (`https://media.rawg.io/…`) while the poster row
 * holds either the same raw URL or the proxied form
 * (`/api/media/proxy?url=<encoded>`); album posters additionally carry a
 * `/thumbnail` vs `/preview` suffix for the same underlying image. Unwrapping
 * the proxy, dropping the query string and ignoring the size suffix lets
 * `reconcileSelection` recognise the cover in every one of those shapes.
 */
export function normalizePosterUrl(raw: string | null): string {
  if (!raw) return '';
  let url = raw;
  const marker = '/api/media/proxy?url=';
  if (url.includes(marker)) {
    url = decodeURIComponent(url.slice(url.indexOf(marker) + marker.length));
  }
  url = url.split('?')[0].replace(/\/(thumbnail|preview|original|stream)$/i, '');
  return url.replace(/\/+$/, '');
}

/**
 * Is this a reference to a file on THIS server (an uploaded poster or one of the
 * game's own album renditions), as opposed to provider artwork?
 *
 * `/api/media/proxy?url=…` is provider artwork that merely travels through our
 * image proxy, so it is deliberately NOT local. Everything else under
 * `/api/media/<id>/…` and all of `/api/posters/<id>/…` is a local file and must
 * never be mistaken for official scraped artwork.
 */
export function isLocalFileUrl(url: string): boolean {
  if (url.startsWith('/api/posters/')) return true;
  if (!url.startsWith('/api/media/')) return false;
  return !url.startsWith('/api/media/proxy');
}

@Injectable()
export class PostersService {
  private readonly logger = new Logger(PostersService.name);
  private readonly dataDir: string;

  constructor(
    private readonly db: DatabaseService,
    private readonly processor: MediaProcessorService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.dataDir = config.get('dataDir', { infer: true });
  }

  get postersDir(): string {
    return path.join(this.dataDir, 'posters');
  }

  /** All posters for a game, selected first. */
  list(gameId: string): PosterDto[] {
    // Repair a cover whose `is_selected` flag was never written before reporting
    // it, so the UI always sees which poster owns the cover.
    this.reconcileSelection(gameId);
    const rows = this.db.all<PosterRow>(
      `SELECT * FROM game_posters WHERE game_id = ?
       ORDER BY is_selected DESC, sort_order ASC, created_at ASC`,
      [gameId],
    );
    return rows.map((r) => this.toDto(r));
  }

  /** Wake? No — ensure the upload directory exists before writing. */
  private async ensureDir(): Promise<void> {
    await fs.ensureDir(this.postersDir);
  }

  private toDto(r: PosterRow): PosterDto {
    const url = r.source === 'upload' ? `/api/posters/${r.id}/image` : r.url;
    return {
      id: r.id,
      gameId: r.game_id,
      // Uploaded files live under DATA_DIR and are served by the poster route.
      url,
      // Media posters carry a media id, so the thumbnail route can serve a tiny
      // rendition instead of the multi-megabyte preview.
      thumbUrl: r.media_id ? `/api/media/${r.media_id}/thumbnail` : url,
      source: (r.source as PosterDto['source']) ?? 'upload',
      mediaId: r.media_id,
      isSelected: !!r.is_selected,
      // Only a non-official selected poster is a cancellable user choice.
      isCover: !!r.is_selected && !!r.is_user_choice,
      inSlideshow: !!r.in_slideshow,
      sortOrder: r.sort_order,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }

  private assertGame(gameId: string): void {
    const row = this.db.get<{ id: string }>('SELECT id FROM games WHERE id = ?', [gameId]);
    if (!row) throw new NotFoundException('Game not found');
  }

  private nextOrder(gameId: string): number {
    return (
      (this.db.get<{ m: number | null }>(
        'SELECT MAX(sort_order) AS m FROM game_posters WHERE game_id = ?',
        [gameId],
      )?.m ?? -1) + 1
    );
  }

  /** Save an uploaded image as a poster. */
  async upload(gameId: string, file: { buffer: Buffer; originalname?: string }): Promise<PosterDto> {
    this.assertGame(gameId);
    if (!file?.buffer?.length) throw new BadRequestException('未收到图片数据');
    if (file.buffer.length > 20 * 1024 * 1024) {
      throw new BadRequestException('图片过大（上限 20MB）');
    }

    // Validate + normalise to WebP so any browser can render it, and so an
    // exotic upload (e.g. JXR) cannot end up un-displayable in the grid.
    let out: Buffer;
    let width: number | undefined;
    let height: number | undefined;
    try {
      // sharp has no JPEG XR decoder, so a .jxr upload used to fail with
      // "Input buffer contains unsupported image format" and the poster was
      // rejected outright. Decode via jpegxr first, then hand raw pixels to
      // sharp. The original upload is never written to disk in JXR form.
      const isJxr =
        (file.originalname && isJxrPath(file.originalname)) || isJxrBuffer(file.buffer);
      if (isJxr) {
        const webp = await jxrToWebp(file.buffer, { quality: 90 });
        if (!webp) {
          throw new BadRequestException(
            '该 JXR 图片无法解码（可能是高位深或非 8 位变体），请先转为 JPG/PNG 后再上传',
          );
        }
        const meta = await sharp(webp).metadata();
        width = meta.width;
        height = meta.height;
        out = webp;
      } else {
        const img = sharp(file.buffer, { animated: false });
        const meta = await img.metadata();
        width = meta.width;
        height = meta.height;
        out = await img.webp({ quality: 90 }).toBuffer();
      }
    } catch (err) {
      throw new BadRequestException(
        `无法解析该图片（支持 JPG/PNG/WebP/GIF/AVIF 等）：${(err as Error)?.message ?? err}`,
      );
    }

    const id = uuidv5(`poster:${gameId}:${Date.now()}:${Math.random()}`, UUID_NAMESPACE);
    await this.ensureDir();
    await fs.writeFile(path.join(this.postersDir, `${id}.webp`), out);

    const hasAny = this.list(gameId).length > 0;
    // An uploaded poster starts OUT of the card rotation (`in_slideshow = 0`):
    // the card only rotates pictures the user ticked. The first upload becomes the
    // cover (`select()` below), and the cover is in the card set structurally, so
    // a fresh game still shows its one frame.
    this.db.run(
      `INSERT INTO game_posters
         (id, game_id, url, source, media_id, is_selected, in_slideshow, sort_order, created_at)
       VALUES (?, ?, ?, 'upload', NULL, ?, 0, ?, ?)`,
      [id, gameId, `/api/posters/${id}/image`, hasAny ? 0 : 1, this.nextOrder(gameId), Date.now()],
    );
    this.logger.log(`Uploaded poster for game ${gameId} (${width}x${height ?? '?'})`);

    const created = this.list(gameId).find((p) => p.id === id)!;
    // First poster becomes the selected one automatically.
    if (!hasAny) await this.select(gameId, id);
    return created;
  }

  /** Use an existing album image (screenshot etc.) as a poster. */
  async addFromMedia(gameId: string, mediaId: string): Promise<PosterDto> {
    this.assertGame(gameId);
    const media = this.db.get<{ id: string; game_id: string; type: string }>(
      'SELECT id, game_id, type FROM media WHERE id = ?',
      [mediaId],
    );
    if (!media) throw new NotFoundException('相册图片不存在');
    if (media.game_id !== gameId) throw new BadRequestException('该图片不属于当前游戏');

    // Deduplicate: the same album image should not be added twice.
    const dup = this.db.get<PosterRow>(
      "SELECT * FROM game_posters WHERE game_id = ? AND media_id = ? AND source = 'media'",
      [gameId, mediaId],
    );
    if (dup) return this.toDto(dup);

    const id = uuidv5(`poster:media:${gameId}:${mediaId}`, UUID_NAMESPACE);
    const hasAny = this.list(gameId).length > 0;
    // A poster the user adds from the album starts OUT of the card rotation, and
    // that decision is recorded as the user's own (`slideshow_user_set = 1`).
    //
    // Why the default is 0: 「从相册添加」is how a screenshot becomes *available*
    // as a poster. Silently enrolling it in the card rotation changed what the
    // home card showed without the user asking — the requirement is that the card
    // only rotates the pictures the user ticked. The checkbox in 「编辑海报」is the
    // user's switch, so it has to start off.
    //
    // Why `slideshow_user_set = 1` matters as much as the 0: it records that this
    // row is already decided, so the boot-time `removeAutoAddedFramesFromRotation`
    // leaves it alone. Without it the row would look "auto-included, safe to
    // switch back on", which is what made unticking appear to do nothing.
    this.db.run(
      `INSERT INTO game_posters
         (id, game_id, url, source, media_id, is_selected, in_slideshow, slideshow_user_set, sort_order, created_at)
       VALUES (?, ?, ?, 'media', ?, 0, 0, 1, ?, ?)`,
      [
        id,
        gameId,
        // Serve the album image itself (already browser-safe via /preview).
        `/api/media/${mediaId}/preview`,
        mediaId,
        this.nextOrder(gameId),
        Date.now(),
      ],
    );
    const created = this.list(gameId).find((p) => p.id === id)!;
    if (!hasAny) await this.select(gameId, id);
    return created;
  }

  /** Mark one poster as the selected cover (mirrored onto games.poster_url). */
  async select(gameId: string, posterId: string): Promise<{ selected: string }> {
    this.assertGame(gameId);
    const row = this.db.get<PosterRow>(
      'SELECT * FROM game_posters WHERE id = ? AND game_id = ?',
      [posterId, gameId],
    );
    if (!row) throw new NotFoundException('海报不存在');

    const tx = this.db.raw.transaction(() => {
      this.db.run(
        'UPDATE game_posters SET is_selected = 0, is_user_choice = 0 WHERE game_id = ?',
        [gameId],
      );
      this.db.run('UPDATE game_posters SET is_selected = 1, is_user_choice = 1 WHERE id = ?', [
        posterId,
      ]);
    });
    tx();

    // Mirror onto the game row so all existing UI paths show the new poster.
    this.db.run('UPDATE games SET poster_url = ?, updated_at = ? WHERE id = ?', [
      this.toDto({ ...row, is_selected: 1 }).url,
      Date.now(),
      gameId,
    ]);
    return { selected: posterId };
  }

  /**
   * Cancel the user's cover choice and fall back to the game's official poster.
   *
   * There was previously no way back: `select()` was the only poster endpoint,
   * so once a game screenshot or an upload was made the cover it could never be
   * un-set — only the slideshow flag could be toggled. This restores the
   * scraped official artwork as the cover while KEEPING every poster row and
   * file (nothing is deleted), which is what the user asked for.
   *
   * Preference order for the restored cover:
   *  1. the scraped (official) poster, if one is registered;
   *  2. the poster `games.poster_url` already points at (matched by URL), which
   *     is the case for games whose official artwork was adopted as the cover
   *     without a `is_selected` flag ever being written;
   *  3. otherwise the game's first local screenshot, matching the behaviour of
   *     a freshly scanned game that has never had a cover chosen.
   *
   * Known non-bug: when the official poster is ALREADY the cover, cancelling
   * legitimately leaves that same official poster selected — "cancel" means
   * "stop using my custom pick", not "show no poster". The UI hides the cancel
   * entry in that case (see `isCover`), so the button never appears to do
   * nothing.
   */
  clearSelection(gameId: string): {
    selected: string | null;
    posterUrl: string | null;
    restored: string | null;
  } {
    this.assertGame(gameId);

    // Which poster owned the cover before we reset? Used only for the response
    // so the UI can report what it went back to.
    const previous = this.db.get<PosterRow>(
      `SELECT * FROM game_posters WHERE game_id = ? AND is_selected = 1 LIMIT 1`,
      [gameId],
    );

    // Demote everything: the user is explicitly giving the cover back.
    // Clearing is_user_choice is what makes the cancel button actually go away:
// Demote everything: the user is explicitly giving the cover back.
    // whatever we restore below is the app's default, not a user choice.
// Demote everything: the user is explicitly giving the cover back.
    this.db.run('UPDATE game_posters SET is_selected = 0, is_user_choice = 0 WHERE game_id = ?', [gameId]);

    // Only provider artwork counts as the official poster. Rows wrongly recorded
    // as `scraped` while holding a local `/api/media/...` path are skipped, so a
    // cancel can never "restore" the user's own screenshot. The boot-time
    // migration repairs those rows; this keeps even an un-migrated database sane.
    const official = this.db
      .all<PosterRow>(
        `SELECT * FROM game_posters
          WHERE game_id = ? AND source = 'scraped'
          ORDER BY created_at ASC`,
        [gameId],
      )
      .find((r) => !isLocalFileUrl(r.url));

    if (official) {
      this.db.run(
          'UPDATE game_posters SET is_selected = 1, is_user_choice = 0 WHERE id = ?',
          [official.id],
        );
      const url = this.toDto({ ...official, is_selected: 1 }).url;
      // Also refresh the scraped row's own url, so a poster registered before a
      // provider changed its CDN path still points at the live image.
      this.db.run('UPDATE game_posters SET url = ? WHERE id = ? AND url != ?', [
        url,
        official.id,
        url,
      ]);
      this.db.run('UPDATE games SET poster_url = ?, updated_at = ? WHERE id = ?', [
        url,
        Date.now(),
        gameId,
      ]);
      return { selected: official.id, posterUrl: url, restored: previous?.id ?? null };
    }

    // No official poster registered (e.g. scraping never returned one) — fall
    // back to the local first-image poster so the card is never left blank.
    const first = this.db.get<{ id: string }>(
      `SELECT id FROM media WHERE game_id = ? AND type IN ('image','gif')
       ORDER BY file_created_at ASC LIMIT 1`,
      [gameId],
    );
    const url = first ? `/api/media/${first.id}/thumbnail` : null;
    this.db.run('UPDATE games SET poster_url = ?, updated_at = ? WHERE id = ?', [
      url,
      Date.now(),
      gameId,
    ]);
    return { selected: null, posterUrl: url, restored: previous?.id ?? null };
  }

  /**
   * Self-heal a game whose cover is set but whose poster rows carry no
   * `is_selected` flag.
   *
   * 34 of the 39 live games were in exactly that state: `games.poster_url` held
   * the official artwork while every `game_posters` row had `is_selected = 0`.
   * `ensureScrapedPosters` returned early ("same artwork as before — nothing to
   * do") and so never repaired the flag. The UI decides whether to offer
   * "取消封面" from `isSelected`, so those games showed no way to change the
   * cover at all.
   *
   * Idempotent, and deliberately conservative: it only ever promotes a row whose
   * URL already equals the cover, so it cannot change what the user sees.
   */
  reconcileSelection(gameId: string): boolean {
    const game = this.db.get<{ poster_url: string | null }>(
      'SELECT poster_url FROM games WHERE id = ?',
      [gameId],
    );
    if (!game?.poster_url) return false;

    const selectedRow = this.db.get<PosterRow>(
      'SELECT * FROM game_posters WHERE game_id = ? AND is_selected = 1 LIMIT 1',
      [gameId],
    );

    if (selectedRow) {
      // A selection exists, so there is no flag to repair — but the mirrored
      // `games.poster_url` can still have drifted (a later scrape wrote its own
      // artwork there). Realign it with the selected row so the gallery card and
      // the poster dialog cannot show different pictures.
      const selectedUrl =
        selectedRow.source === 'upload'
          ? `/api/posters/${selectedRow.id}/image`
          : selectedRow.url;
      if (normalizePosterUrl(game.poster_url) !== normalizePosterUrl(selectedUrl)) {
        this.db.run('UPDATE games SET poster_url = ? WHERE id = ?', [selectedUrl, gameId]);
        this.logger.warn(
          `Cover url for game ${gameId} had drifted from poster ${selectedRow.id}; realigned`,
        );
        return true;
      }
      return false;
    }

    // Compare ignoring the /api/media/proxy?url= wrapper and query strings, so a
    // proxied cover still matches the row that stored the raw provider URL.
    const rows = this.db.all<PosterRow>('SELECT * FROM game_posters WHERE game_id = ?', [gameId]);
    if (!rows.length) return false;

    const target = normalizePosterUrl(game.poster_url);
    let hit = rows.find((r) => normalizePosterUrl(r.url) === target);

    if (!hit) {
      // The cover references artwork that is no longer one of this game's rows
      // (the provider swapped the image, or a user file was removed). Promote the
      // official row — falling back to the first row — and repoint poster_url at
      // it so the mirrored column and the selected row cannot disagree.
      hit = rows.find((r) => r.source === 'scraped') ?? rows[0];
      this.db.run('UPDATE games SET poster_url = ? WHERE id = ?', [hit.url, gameId]);
      this.logger.warn(
        `Cover for game ${gameId} referenced a poster that no longer exists; ` +
          `fell back to ${hit.source} poster ${hit.id}`,
      );
    }

    // Repairing a missing flag restores the *default* cover, never a user choice:
    // marking it as user-chosen would resurrect the phantom cancel button that
    // this method exists to avoid.
    this.db.run(
      'UPDATE game_posters SET is_selected = 1, is_user_choice = 0 WHERE id = ?',
      [hit.id],
    );
    this.logger.log(`Restored cover flag for game ${gameId} (poster ${hit.id})`);
    return true;
  }

  /**
   * Toggle whether a poster participates in the **home-card** rotation.
   *
   * This is the 「轮播」 checkbox in 「编辑海报」. Records the decision as the
   * user's (`slideshow_user_set = 1`), so the boot-time auto-added-frame cleanup
   * never switches a poster the user turned OFF back on. Nothing enrolls a poster
   * automatically any more: only this call adds one to the card set — the cover is
   * there structurally (`is_selected`), not through this flag.
   */
  setSlideshow(gameId: string, posterId: string, inSlideshow: boolean): { updated: boolean } {
    this.assertGame(gameId);
    const row = this.db.get<PosterRow>(
      'SELECT id FROM game_posters WHERE id = ? AND game_id = ?',
      [posterId, gameId],
    );
    if (!row) throw new NotFoundException('海报不存在');
    this.db.run(
      'UPDATE game_posters SET in_slideshow = ?, slideshow_user_set = 1 WHERE id = ?',
      [inSlideshow ? 1 : 0, posterId],
    );
    return { updated: true };
  }

  /** Remove a poster (and its uploaded file). Selecting a new one if needed. */
  async remove(gameId: string, posterId: string): Promise<{ removed: boolean; selected: string | null }> {
    this.assertGame(gameId);
    const row = this.db.get<PosterRow>(
      'SELECT * FROM game_posters WHERE id = ? AND game_id = ?',
      [posterId, gameId],
    );
    if (!row) throw new NotFoundException('海报不存在');

    this.db.run('DELETE FROM game_posters WHERE id = ?', [posterId]);
    if (row.source === 'upload') {
      await fs.remove(path.join(this.postersDir, `${row.id}.webp`)).catch(() => undefined);
    }

    // If the removed poster was the selected one, promote the next available.
    let selected: string | null = null;
    if (row.is_selected) {
      const next = this.list(gameId)[0] ?? null;
      if (next) {
        await this.select(gameId, next.id);
        selected = next.id;
      } else {
        // No posters left — restore the local first-image poster if possible.
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
    }
    return { removed: true, selected };
  }

  /** Absolute path of an uploaded poster file (for streaming). */
  uploadPath(posterId: string): string {
    const row = this.db.get<PosterRow>('SELECT * FROM game_posters WHERE id = ?', [posterId]);
    if (!row || row.source !== 'upload') throw new NotFoundException('海报不存在');
    return path.join(this.postersDir, `${row.id}.webp`);
  }

  /**
   * Register every piece of provider artwork as a first-class poster record, so
   * each official image is selectable as cover and tickable in 「编辑海报」.
   *
   * Providers return one cover plus a set of screenshots. Only the cover used to
   * be registered, so the rest of the official artwork could be seen nowhere and
   * managed nowhere even though it had been scraped. The previous implementation
   * also bailed out whenever the game already had ANY poster, so a single user
   * upload stopped the official artwork from ever being registered.
   *
   * Rules:
   *  - always register every provider URL, never bail out;
   *  - `urls[0]` is the cover and is the only one that may take `is_selected`
   *    when the user has not chosen a cover themselves;
   *  - a new scraped row starts OUT of the card rotation (`in_slideshow = 0`).
   *    The detail-page hero rotates the official set itself (no flag), and the
   *    home card only rotates what the user ticked — so nothing may enter the card
   *    rotation without an explicit tick;
   *  - nothing is ever deleted here. Existing rows keep their identity, their
   *    cover state, and any slideshow decision the user already made. Identity
   *    changes (a manual re-match) are handled by `resetForRematch()`, the only
   *    place that knows the game really became a different game.
   */
  ensureScrapedPosters(gameId: string, urls: string[]): void {
    // Only real provider artwork may become a `scraped` row.
    //
    // This used to accept anything, and callers passed `games.poster_url` after a
    // metadata refresh — which, for a game the provider returned no artwork for,
    // is the LOCAL first-image fallback (`/api/media/<id>/thumbnail`). Worse, if
    // the user had already set an album screenshot as the cover it is
    // `/api/media/<id>/preview`, so the user's own picture was registered as the
    // "official" poster. Cancelling then "restored" that very same image, which is
    // exactly the reported "取消封面没反应 / 封面没恢复默认".
    // Duplicates are common (a provider can list the cover among its screenshots),
    // and registering the same URL twice would show it twice in the editor.
    const wanted = [...new Set(urls.filter((u): u is string => !!u && !isLocalFileUrl(u)))];
    if (!wanted.length) return;

    const existing = this.db.all<PosterRow>(
      "SELECT * FROM game_posters WHERE game_id = ? AND source = 'scraped'",
      [gameId],
    );

    // NOTE: this method never deletes anything.
    //
    // It used to prune "artwork the provider no longer lists" whenever the cover
    // URL looked different from last time. That heuristic is not sound, and it was
    // the direct cause of the reported "其余所有游戏只有默认单张封面":
    //
    //   - A single scrape runs EVERY provider and persists several fragments. Only
    //     some carry artwork, and they disagree about the cover (RAWG returns its
    //     `background_image`, Steam returns its `header.jpg`). Measured with temporary
    //     entry/exit instrumentation (the `POSTER_DEBUG` prints, since removed) on a
    //     cold scrape of 「艾尔登法环」:
    //
    //       call 1  in=7 wanted=7  [RAWG cover + 6 official screenshots]
    //       call 2  in=1 wanted=1  [Steam header]
    //
    //     Call 2 saw "cover changed" and deleted the 6 screenshots call 1 had just
    //     registered. 「对马岛之魂」showed the same signature, and 「赛博朋克2077」
    //     kept only its Steam cover.
    //   - The screenshot lookup is a separate, best-effort request that is allowed
    //     to fail, so "fewer images than last time" is not evidence of a new
    //     identity either.
    //
    // Deciding "this is a different game now" belongs to the one flow that actually
    // knows that — a manual re-match, which calls `resetForRematch()` and deletes
    // all scraped artwork deliberately. Treating every routine refresh as a
    // possible identity change lost far more than it ever protected.
    const present = new Set(existing.map((r) => r.url));

    // Does a user poster already own the cover? Then scraped artwork must not
    // steal it — user choice has priority over automatic scraping.
    const selected = this.db.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM game_posters WHERE game_id = ? AND is_selected = 1',
      [gameId],
    );
    let userOwnsCover = (selected?.c ?? 0) > 0;

    // No slideshow backfill here any more.
    //
    // An older revision enrolled every existing scraped row with
    // `slideshow_user_set = 0` into the rotation. Under the card-is-the-ticked-set
    // model that is exactly backwards — it would tick the card for the user. Rows
    // the old rule already enrolled are taken back out once by the boot-time
    // `removeAutoAddedFramesFromRotation`, not re-enrolled here.

    for (const [index, url] of wanted.entries()) {
      if (present.has(url)) continue;
      const id = uuidv5(`poster:scraped:${gameId}:${url}`, UUID_NAMESPACE);
      // Register every official image the provider returned — cover first, then
      // each screenshot — so all of them exist and can be ticked. They start OUT
      // of the card rotation (`in_slideshow = 0`); the detail-page hero rotates
      // the official set itself, so a game with 7 scraped images is still
      // browsable as 7 without the user ticking anything.
      const isCover = index === 0 && !userOwnsCover;
      this.db.run(
        `INSERT OR IGNORE INTO game_posters
           (id, game_id, url, source, media_id, is_selected, in_slideshow, slideshow_user_set, sort_order, created_at)
         VALUES (?, ?, ?, 'scraped', NULL, ?, 0, 0, ?, ?)`,
        [
          id,
          gameId,
          url,
          isCover ? 1 : 0,
          this.nextOrder(gameId),
          Date.now(),
        ],
      );
      if (isCover) {
        // Mirror the cover onto the game row as before.
        this.db.run('UPDATE games SET poster_url = ? WHERE id = ?', [url, gameId]);
        userOwnsCover = true;
      }
    }
  }

  /**
   * Drop the auto-scraped poster(s) for a game.
   *
   * Called on a manual re-match: the scraped poster belongs to the OLD identity,
   * so keeping it would leave a foreign cover (and a foreign card frame)
   * behind. User uploads and album-derived posters are deliberately preserved —
   * those were chosen by hand and are not tied to provider metadata.
   *
   * If a removed poster was the selected one, the next remaining poster becomes
   * selected so the game never loses its cover.
   */
  removeScrapedFor(gameId: string): number {
    const rows = this.db.all<PosterRow>(
      "SELECT * FROM game_posters WHERE game_id = ? AND source = 'scraped'",
      [gameId],
    );
    if (rows.length === 0) return 0;

    const wasSelected = rows.some((r) => r.is_selected);
    this.db.run("DELETE FROM game_posters WHERE game_id = ? AND source = 'scraped'", [gameId]);

    if (wasSelected) {
      const next = this.db.get<PosterRow>(
        'SELECT * FROM game_posters WHERE game_id = ? ORDER BY sort_order ASC, created_at ASC LIMIT 1',
        [gameId],
      );
      if (next) {
        this.db.run(
          // Automatic promotion after a scrape is replaced — not a user choice.
          'UPDATE game_posters SET is_selected = 1, is_user_choice = 0 WHERE id = ?',
          [next.id],
        );
        this.db.run('UPDATE games SET poster_url = ? WHERE id = ?', [
          this.toDto({ ...next, is_selected: 1 }).url,
          gameId,
        ]);
      } else {
        this.db.run('UPDATE games SET poster_url = NULL WHERE id = ?', [gameId]);
      }
    }
    return rows.length;
  }

  /**
   * Reset poster state for a manual re-match (identity change).
   *
   * The game is being declared "actually a different game", so the old identity's
   * artwork must go:
   *  - every auto-scraped poster is deleted (it depicts the previous game);
   *  - user uploads / album posters are KEPT, selection included. An explicit
   *    cover choice is user configuration rather than scraped data, so it
   *    survives the switch; only a selection that died with the deleted scraped
   *    rows is left empty, and the next scrape fills it (see registerScraped,
   *    which auto-selects whenever no user poster holds the cover).
   *
   * `games.poster_url` is re-mirrored from whichever poster still holds the
   * selection, so it can never keep pointing at a deleted scraped URL — that
   * stale pointer was the reported "绑定后封面仍是旧游戏海报".
   *
   * Returns the number of scraped posters removed.
   */
  resetForRematch(gameId: string): number {
    const scraped = this.db.all<PosterRow>(
      "SELECT * FROM game_posters WHERE game_id = ? AND source = 'scraped'",
      [gameId],
    );

    const tx = this.db.raw.transaction(() => {
      this.db.run("DELETE FROM game_posters WHERE game_id = ? AND source = 'scraped'", [gameId]);

      const survivor = this.db.get<PosterRow>(
        'SELECT * FROM game_posters WHERE game_id = ? AND is_selected = 1 LIMIT 1',
        [gameId],
      );
      if (survivor) {
        this.db.run('UPDATE games SET poster_url = ? WHERE id = ?', [
          this.toDto(survivor).url,
          gameId,
        ]);
      } else {
        this.db.run('UPDATE games SET poster_url = NULL WHERE id = ?', [gameId]);
      }
    });
    tx();

    return scraped.length;
  }
}