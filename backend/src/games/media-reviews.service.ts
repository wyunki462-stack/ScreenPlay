/**
 * 媒体评价 (critic reviews) storage and retrieval.
 *
 * Kept separate from `MetadataService` and from `PostersService` because it owns a
 * distinct table with its own lifecycle rules — and those rules are the whole
 * point of this service:
 *
 *   - **Reviews are never deleted by a failed scrape.** `games.ratings` is reset
 *     on every refresh, but a review list is expensive to obtain (one page fetch
 *     per game against a rate-limited site). A refresh that comes back empty must
 *     therefore leave the stored reviews alone, exactly like durations.
 *   - **Empty is a recorded outcome, not an absence.** 「暂无媒体评价」is only an
 *     honest statement if we know a fetch actually ran and found nothing —
 *     otherwise it means "we never looked". `games.reviews_status` distinguishes
 *     `ok` / `empty` / `failed` / `unsupported`, and the UI says which.
 *
 * Upserts are keyed on (game, outlet, url) so re-running a scrape refreshes rows
 * instead of piling up duplicates or reordering the panel.
 */

import { Injectable, Logger } from '@nestjs/common';
import { v5 as uuidv5 } from 'uuid';
import { DatabaseService } from '../database/database.service';
import type { MediaReviewData } from '../metadata/provider.interface';

/**
 * Stable namespace so a review's id survives re-scrapes (idempotent upsert).
 *
 * Must be a real RFC-4122 UUID with a version nibble in 1–5: `uuid` v11 rejects
 * anything else with "Invalid UUID", which would turn every store into a failure.
 * (The well-known DCOM GUID `6f9619ff-…-00cf4fc964ff` looks like a UUID but has
 * version 0, so it is not usable here.)
 */
const UUID_NAMESPACE = '5b1f4c2e-8a3d-4f6b-9e2a-7c1d3f5a8b40';

export type ReviewsStatus = 'ok' | 'empty' | 'failed' | 'unsupported';

export interface MediaReviewRow {
  id: string;
  gameId: string;
  source: string;
  outlet: string;
  score: number | null;
  verdict: string | null;
  text: string | null;
  url: string | null;
  author: string | null;
  platform: string | null;
  publishedAt: string | null;
  fetchedAt: number;
}

/** Internal row shape as SQLite returns it (snake_case). */
interface RawReviewRow {
  id: string;
  game_id: string;
  source: string;
  outlet: string;
  score: number | null;
  verdict: string | null;
  review_text: string | null;
  url: string | null;
  author: string | null;
  platform: string | null;
  published_at: string | null;
  sort_order: number;
  fetched_at: number;
}

export interface ReviewsSummary {
  status: ReviewsStatus | null;
  error: string | null;
  fetchedAt: number | null;
  sourceUrl: string | null;
  count: number;
}

@Injectable()
export class MediaReviewsService {
  private readonly logger = new Logger(MediaReviewsService.name);

  constructor(private readonly db: DatabaseService) {}

  /** Display order: highest score first, unscored last, then by outlet name. */
  private orderSql(): string {
    return 'ORDER BY (score IS NULL) ASC, score DESC, outlet COLLATE NOCASE ASC, id ASC';
  }

  list(gameId: string): MediaReviewRow[] {
    return this.db
      .all<RawReviewRow>(`SELECT * FROM media_reviews WHERE game_id = ? ${this.orderSql()}`, [gameId])
      .map((r) => this.toDto(r));
  }

  count(gameId: string): number {
    return (
      this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM media_reviews WHERE game_id = ?', [gameId])
        ?.c ?? 0
    );
  }

  /** Scrape state for the panel, so an empty list can explain itself. */
  summary(gameId: string): ReviewsSummary {
    const row = this.db.get<{
      reviews_status: string | null;
      reviews_error: string | null;
      reviews_fetched_at: number | null;
      reviews_source_url: string | null;
    }>(
      'SELECT reviews_status, reviews_error, reviews_fetched_at, reviews_source_url FROM games WHERE id = ?',
      [gameId],
    );
    return {
      status: (row?.reviews_status as ReviewsStatus | null) ?? null,
      error: row?.reviews_error ?? null,
      fetchedAt: row?.reviews_fetched_at ?? null,
      sourceUrl: row?.reviews_source_url ?? null,
      count: this.count(gameId),
    };
  }

  /**
   * Replace this game's reviews with a freshly scraped set.
   *
   * `reviews: []` is treated as "fetched, nothing there" (`status: 'empty'`) and
   * **leaves existing rows in place**. An empty result is far more often a
   * transient block or a layout change than a genuine retraction, and wiping a
   * panel the user was reading is worse than keeping slightly stale text.
   *
   * Pass `replace: true` (used by the standalone crawler's import mode) when the
   * caller genuinely knows the new set is authoritative and complete.
   */
  save(
    gameId: string,
    reviews: MediaReviewData[],
    opts: { sourceUrl?: string | null; replace?: boolean; error?: string | null } = {},
  ): { stored: number; status: ReviewsStatus } {
    const now = Date.now();
    const clean = this.normalise(reviews);

    if (opts.error) {
      this.recordStatus(gameId, 'failed', opts.error, now, opts.sourceUrl ?? null);
      return { stored: this.count(gameId), status: 'failed' };
    }
    if (clean.length === 0) {
      this.recordStatus(gameId, 'empty', null, now, opts.sourceUrl ?? null);
      return { stored: this.count(gameId), status: 'empty' };
    }

    const tx = this.db.raw.transaction(() => {
      if (opts.replace) {
        this.db.run('DELETE FROM media_reviews WHERE game_id = ?', [gameId]);
      }
      clean.forEach((r, index) => {
        const id = uuidv5(`review:${gameId}:${r.outlet}:${r.url ?? ''}`, UUID_NAMESPACE);
        // Upsert: refresh every mutable field, keep the row identity stable so a
        // panel does not reorder or lose its scroll position on a re-scrape.
        this.db.run(
          `INSERT INTO media_reviews
             (id, game_id, source, outlet, score, verdict, review_text, url, author, platform, published_at, sort_order, fetched_at)
           VALUES (?, ?, 'metacritic', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             outlet = excluded.outlet,
             score = excluded.score,
             verdict = excluded.verdict,
             review_text = excluded.review_text,
             url = excluded.url,
             author = excluded.author,
             platform = excluded.platform,
             published_at = excluded.published_at,
             sort_order = excluded.sort_order,
             fetched_at = excluded.fetched_at`,
          [
            id,
            gameId,
            r.outlet,
            r.score,
            r.verdict,
            r.text,
            r.url,
            r.author,
            r.platform,
            r.publishedAt,
            index,
            now,
          ],
        );
      });
    });
    tx();

    this.recordStatus(gameId, 'ok', null, now, opts.sourceUrl ?? null);
    return { stored: this.count(gameId), status: 'ok' };
  }

  /**
   * Record "the source answered, and it has no reviews for this game" while
   * KEEPING whatever rows are stored.
   *
   * Both facts matter and neither replaces the other: `reviews_status = 'empty'`
   * tells the panel that the last fetch found nothing (so it must not claim the
   * list is up to date), while the rows keep the user something to read. Clearing
   * the rows here would destroy data on what is far more often a transient block
   * or a layout change than a genuine retraction.
   */
  markEmpty(gameId: string, sourceUrl: string | null = null): void {
    this.recordStatus(gameId, 'empty', null, Date.now(), sourceUrl);
  }

  /**
   * Record that this game has no entry on the review source, so no fetch is even
   * possible — distinct from `empty` (the page exists but lists no reviews) and
   * from `failed` (the fetch was attempted and went wrong). The user's next step
   * differs in all three cases: 手动匹配 / nothing / retry.
   */
  markUnsupported(gameId: string, reason: string | null): void {
    this.recordStatus(gameId, 'unsupported', reason, Date.now(), null);
  }

  /** Drop the review list — used when the game's identity changes (re-match). */
  removeFor(gameId: string): number {
    const before = this.count(gameId);
    this.db.run('DELETE FROM media_reviews WHERE game_id = ?', [gameId]);
    this.db.run(
      'UPDATE games SET reviews_status = NULL, reviews_error = NULL, reviews_fetched_at = NULL, reviews_source_url = NULL WHERE id = ?',
      [gameId],
    );
    return before;
  }

  coverage(): {
    total: number;
    withReviews: number;
    awaiting: number;
    failed: number;
    lastFetchedAt: number | null;
  } {
    const total = this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM games')?.c ?? 0;
    const withReviews =
      this.db.get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM (SELECT DISTINCT game_id FROM media_reviews)',
      )?.c ?? 0;
    const failed =
      this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM games WHERE reviews_status = 'failed'")
        ?.c ?? 0;
    const awaiting =
      this.db.get<{ c: number }>(
        // "Awaiting" = exactly what a `scope=missing` run would still visit.
        //
        // Kept literally in step with the batch's candidate query in
        // `GamesService.backfillRatingsBatch`. If the two drift, the card shows a
        // number that pressing the button never clears — which reads as a broken
        // feature rather than as "nothing left to do".
        //
        // `empty` and `ok` are excluded because the source has already answered for
        // those games; the rest (never attempted, failed, or with no bound source
        // entry) are what the button will actually visit.
        `SELECT COUNT(*) AS c FROM games
           WHERE reviews_fetched_at IS NULL OR reviews_status IN ('failed', 'unsupported')`,
      )?.c ?? 0;
    const lastFetchedAt =
      this.db.get<{ t: number | null }>('SELECT MAX(fetched_at) AS t FROM media_reviews')?.t ?? null;
    return { total, withReviews, awaiting, failed, lastFetchedAt };
  }

  // ---------------------------------------------------------------------------

  private recordStatus(
    gameId: string,
    status: ReviewsStatus,
    error: string | null,
    at: number,
    sourceUrl: string | null,
  ): void {
    this.db.run(
      `UPDATE games SET reviews_status = ?, reviews_error = ?, reviews_fetched_at = ?,
         reviews_source_url = COALESCE(?, reviews_source_url)
       WHERE id = ?`,
      [status, error, at, sourceUrl, gameId],
    );
  }

  /**
   * Drop unusable entries before they reach the table.
   *
   * The parser already filters, but this is the boundary that protects the
   * database, so the invariants are re-checked here: an outlet is mandatory, the
   * score must be a plausible 0–100 Metascore, and a row must carry at least one
   * of score/verdict/text — otherwise the panel would show an empty card.
   */
  private normalise(reviews: MediaReviewData[]): MediaReviewData[] {
    const out: MediaReviewData[] = [];
    const seen = new Set<string>();

    for (const raw of reviews ?? []) {
      const outlet = (raw?.outlet ?? '').trim();
      if (!outlet || outlet.length > 60) continue;

      const score =
        raw.score == null || !Number.isFinite(raw.score) || raw.score <= 0 || raw.score > 100
          ? null
          : Math.round(raw.score);

      const text = (raw.text ?? '').trim().slice(0, 1200) || null;
      const verdict = (raw.verdict ?? '').trim().slice(0, 40) || null;
      if (score == null && !text && !verdict) continue;

      const url = (raw.url ?? '').trim() || null;
      const key = `${outlet.toLowerCase()}|${url ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        outlet,
        score,
        text,
        verdict,
        url,
        author: (raw.author ?? '').trim().slice(0, 120) || null,
        platform: (raw.platform ?? '').trim().slice(0, 40) || null,
        publishedAt: (raw.publishedAt ?? '').trim().slice(0, 40) || null,
      });
    }
    return out;
  }

  private toDto(r: RawReviewRow): MediaReviewRow {
    return {
      id: r.id,
      gameId: r.game_id,
      source: r.source,
      outlet: r.outlet,
      score: r.score,
      verdict: r.verdict,
      text: r.review_text,
      url: r.url,
      author: r.author,
      platform: r.platform,
      publishedAt: r.published_at,
      fetchedAt: r.fetched_at,
    };
  }
}