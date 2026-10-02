/**
 * SQLite persistence layer.
 *
 * better-sqlite3 is synchronous, which keeps the scan/metadata code simple.
 * A single database file lives in DATA_DIR (a Docker volume) so state survives
 * container restarts.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import Database from 'better-sqlite3';
import fs from 'fs-extra';
import path from 'path';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';

@Injectable()
export class DatabaseService implements OnModuleInit {
  private readonly logger = new Logger(DatabaseService.name);
  private db!: Database.Database;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  onModuleInit(): void {
    const dataDir = this.config.get('dataDir', { infer: true });
    const dbFilename = this.config.get('dbFilename', { infer: true });
    fs.ensureDirSync(dataDir);

    const dbPath = path.join(dataDir, dbFilename);
    this.db = new Database(dbPath);
    // WAL gives us safe concurrent reads (the streaming path reads via fs, not
    // the DB, but API handlers and the scan worker may overlap).
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.logger.log(`SQLite database ready at ${dbPath}`);
  }

  /** Raw handle for callers that need prepared statements. */
  get raw(): Database.Database {
    return this.db;
  }

  /** Run a parameterised statement and return the insertion id. */
  run(sql: string, params: unknown[] = []): { changes: number; lastInsertRowid: number | bigint } {
    const info = this.db.prepare(sql).run(...params);
    return info;
  }

  /** Fetch a single row or undefined. */
  get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  /** Fetch all rows. */
  all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  /** Execute a single statement that may span many rows (transactions handled by caller). */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS games (
        id               TEXT PRIMARY KEY,
        folder_name      TEXT NOT NULL,
        folder_path      TEXT NOT NULL UNIQUE,
        name             TEXT NOT NULL,
        platform         TEXT,
        aliases          TEXT NOT NULL DEFAULT '[]',
        manual_override  INTEGER NOT NULL DEFAULT 0,
        first_played_at  INTEGER,
        last_played_at   INTEGER,
        duration_seconds INTEGER NOT NULL DEFAULT 0,
        main_duration_seconds INTEGER,
        completionist_duration_seconds INTEGER,
        poster_url       TEXT,
        summary          TEXT,
        developers       TEXT NOT NULL DEFAULT '[]',
        publishers       TEXT NOT NULL DEFAULT '[]',
        release_date     TEXT,
        voice_actors     TEXT NOT NULL DEFAULT '[]',
        screenshots      TEXT NOT NULL DEFAULT '[]',
        main_story_hours REAL,
        main_extra_hours REAL,
        completionist_hours REAL,
        ratings          TEXT NOT NULL DEFAULT '[]',
        prices           TEXT NOT NULL DEFAULT '[]',
        last_meta_refresh INTEGER,
        meta_error       TEXT,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS media (
        id               TEXT PRIMARY KEY,
        game_id          TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        file_name        TEXT NOT NULL,
        file_path        TEXT NOT NULL,
        type             TEXT NOT NULL,          -- image | video | gif
        mime_type        TEXT NOT NULL,
        width            INTEGER,
        height           INTEGER,
        size_bytes       INTEGER NOT NULL DEFAULT 0,
        file_created_at  INTEGER,
        duration_seconds REAL,
        thumb_path       TEXT,
        cover_path       TEXT,
        sort_order       INTEGER NOT NULL DEFAULT 0,
        created_at       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_media_game ON media(game_id);

      CREATE TABLE IF NOT EXISTS achievements (
        id               TEXT PRIMARY KEY,
        game_id          TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        external_id      TEXT,
        name             TEXT NOT NULL,
        description      TEXT,
        icon_url         TEXT,
        global_percent   REAL,
        unlocked         INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_achievements_game ON achievements(game_id);

      -- Provider → external id bindings (manual corrections live here too)
      CREATE TABLE IF NOT EXISTS game_links (
        game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        provider    TEXT NOT NULL,
        external_id TEXT NOT NULL,
        PRIMARY KEY (game_id, provider)
      );

      -- Achievement/trophy target chosen by hand on the detail page.
      --
      -- Deliberately NOT a row in game_links: that table is rewritten by the
      -- automatic matcher (fetchProvider stores whatever it found), so an
      -- auto-match would silently overwrite the user's explicit choice. Keeping
      -- it separate lets the manual pick win on every future scrape.
      CREATE TABLE IF NOT EXISTS achievement_links (
        game_id     TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
        source      TEXT NOT NULL,
        external_id TEXT NOT NULL,
        name        TEXT,
        created_at  INTEGER NOT NULL
      );

      -- Generic provider response cache with per-key TTL
      CREATE TABLE IF NOT EXISTS metadata_cache (
        key        TEXT PRIMARY KEY,
        provider   TEXT NOT NULL,
        payload    TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_meta_cache_expiry ON metadata_cache(expires_at);

      -- Runtime-persisted settings (API keys etc.), editable from the web UI.
      CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- User-added media library roots (managed from the web UI).
      -- Rows here are merged with MEDIA_DIRS from the environment; deleting a
      -- row never touches the files on disk.
      CREATE TABLE IF NOT EXISTS library_roots (
        id          TEXT PRIMARY KEY,
        path        TEXT NOT NULL UNIQUE,
        label       TEXT,
        media_type  TEXT NOT NULL DEFAULT 'auto',   -- auto | image | video
        recursive   INTEGER NOT NULL DEFAULT 1,
        enabled     INTEGER NOT NULL DEFAULT 1,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      -- Custom / multiple posters per game.
      --   is_selected  → the game's cover (the card's static frame, always frame 0)
      --   in_slideshow → ticked in 「编辑海报」to join the HOME-CARD carousel;
      --                  the detail-page hero rotates the official posters
      --                  regardless of this flag
      -- source: 'upload' (user file) | 'media' (existing album image) | 'scraped'
      CREATE TABLE IF NOT EXISTS game_posters (
        id           TEXT PRIMARY KEY,
        game_id      TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        url          TEXT NOT NULL,
        source       TEXT NOT NULL DEFAULT 'upload',
        media_id     TEXT,
        is_selected  INTEGER NOT NULL DEFAULT 0,
        in_slideshow INTEGER NOT NULL DEFAULT 0,
        sort_order   INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_game_posters_game ON game_posters(game_id);

      -- Per-outlet critic reviews (媒体评价), scraped from the same Metacritic
      -- game page that yields the aggregate score in games.ratings.
      --
      -- Its own table rather than a JSON blob on games for two reasons:
      --   1. games.ratings is REWRITTEN on every scrape (reset to an empty array
      --      in games.service's refresh path). Reviews are expensive to obtain
      --      and must not be destroyed just because a later scrape failed.
      --   2. A review list is unbounded -- tens of rows per game -- so keeping it
      --      out of the row we read for every gallery card keeps that read cheap.
      --
      -- outlet is the only required column: a card with no score or with its
      -- excerpt cut off is still shown.
      CREATE TABLE IF NOT EXISTS media_reviews (
        id           TEXT PRIMARY KEY,
        game_id      TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        source       TEXT NOT NULL DEFAULT 'metacritic',
        outlet       TEXT NOT NULL,
        score        INTEGER,
        verdict      TEXT,
        review_text  TEXT,
        url          TEXT,
        author       TEXT,
        platform     TEXT,
        published_at TEXT,
        sort_order   INTEGER NOT NULL DEFAULT 0,
        fetched_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_media_reviews_game ON media_reviews(game_id);
      -- One row per outlet+url: the scrape upserts, so re-running it refreshes a
      -- review instead of piling up duplicates.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_media_reviews_unique
        ON media_reviews(game_id, outlet, COALESCE(url, ''));

      -- Local login sessions. Persisted in the data volume so a container
      -- restart does not sign the user out ("记住登录状态").
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token       TEXT PRIMARY KEY,
        username    TEXT NOT NULL,
        provider    TEXT NOT NULL DEFAULT 'system',   -- system | local
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        last_seen   INTEGER NOT NULL,
        user_agent  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);

      -- App-local fallback accounts (scrypt hashes). Used when the host user
      -- database is not mounted in, so the app is never left without a way in.
      CREATE TABLE IF NOT EXISTS auth_users (
        username      TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,   -- scrypt$N$r$p$salt$hash — never plaintext
        display_name  TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );
    `);

    // Incremental columns added after the initial schema (survive upgrades on
    // existing database files where the CREATE TABLE above is a no-op).
    this.addColumnIfMissing('games', 'meta_error', 'TEXT');
    // Feature: user-selected play platforms (JSON array, e.g. ["PC","PlayStation 5"]).
    // When present it replaces the auto-scraped single platform everywhere.
    this.addColumnIfMissing('games', 'platforms', "TEXT NOT NULL DEFAULT '[]'");
    // Feature: 「首页卡片轮播」 switch — 'static' | 'slideshow'. Drives whether the
    // home-card frames auto-advance and whether the card shows its prev/next
    // arrows. It has nothing to do with per-poster `in_slideshow` (the tick) or
    // with the detail-page hero carousel.
    this.addColumnIfMissing('games', 'poster_mode', "TEXT NOT NULL DEFAULT 'static'");
    // Feature: marks platform/poster as user-controlled so scrapes never clobber it.
    this.addColumnIfMissing('games', 'custom_platform', 'INTEGER NOT NULL DEFAULT 0');
    // Feature: separates a cover the *user* chose from one the app picked for
    // them (official artwork, or the automatic first-image fallback). Without
    // this, "取消封面" could never clear the cancel button on a game that has no
    // official poster: the fallback row was re-selected and looked user-chosen.
    this.addColumnIfMissing('game_posters', 'is_user_choice', 'INTEGER NOT NULL DEFAULT 0');

    // Whether the USER has decided this poster's card-rotation membership.
    //
    // `in_slideshow` is the home-card tick, and nothing enrolls a frame
    // automatically any more — but an older rule did (the boot-time cover floor
    // and the album rotation floor), leaving `in_slideshow = 1` rows nobody chose.
    // Recording *who* made the call is what lets the boot-time cleanup
    // (`removeAutoAddedFramesFromRotation`) take the un-chosen rows back out
    // without ever touching a user's tick or untick. It is also what tells a
    // re-scrape "the user decided this row, leave it alone".
    //
    // Named separately from is_user_choice on purpose: that one means "the user
    // picked this as the COVER", which is a different decision.
    this.addColumnIfMissing('game_posters', 'slideshow_user_set', 'INTEGER NOT NULL DEFAULT 0');

    // --- 媒体评价 (critic reviews) ------------------------------------------
    // When the review list was last obtained, so the UI can say "尚未抓取" instead
    // of an ambiguous empty panel — an empty list means two very different things
    // (never fetched vs. fetched and genuinely empty).
    this.addColumnIfMissing('games', 'reviews_fetched_at', 'INTEGER');
    // Outcome of the last review fetch: 'ok' | 'empty' | 'failed' | 'unsupported'.
    // `empty` is what turns 「暂无媒体评价」 from a guess into a statement.
    this.addColumnIfMissing('games', 'reviews_status', 'TEXT');
    // Why it failed, shown verbatim in the UI (proxy blocked / 403 / timeout).
    this.addColumnIfMissing('games', 'reviews_error', 'TEXT');
    // Which Metacritic page the reviews came from, so the panel can link back and
    // a re-scrape of the same slug can be recognised as a refresh.
    this.addColumnIfMissing('games', 'reviews_source_url', 'TEXT');

    // --- Achievements / trophies -------------------------------------------
    // Trophy tier for PlayStation sources (platinum|gold|silver|bronze). NULL for
    // Steam, where achievements carry no tier.
    this.addColumnIfMissing('achievements', 'tier', 'TEXT');
    // Human rarity wording exactly as the source gives it (极为珍贵/非常珍贵/珍贵/一般).
    this.addColumnIfMissing('achievements', 'rarity', 'TEXT');
    // Which source produced this row ('steam' / 'psnine'), so re-scraping can
    // replace only that source's rows.
    this.addColumnIfMissing('achievements', 'source', 'TEXT');
    // DLC grouping: the Steam add-on appid and its store name. NULL for base rows.
    this.addColumnIfMissing('achievements', 'dlc_app_id', 'TEXT');
    this.addColumnIfMissing('achievements', 'dlc_name', 'TEXT');
    // Display order: base game first, then DLC, then the source's own order.
    this.addColumnIfMissing('achievements', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_achievements_game_tier ON achievements(game_id, tier)',
    );

    // Per-game achievement scrape state so a failure is never silent: the detail
    // page can show the reason and the gallery can badge it like `meta_error`.
    // status ∈ ok | empty | failed | unsupported | pending
    this.addColumnIfMissing('games', 'achievements_status', 'TEXT');
    this.addColumnIfMissing('games', 'achievements_error', 'TEXT');
    this.addColumnIfMissing('games', 'last_achievements_refresh', 'INTEGER');
    // The trophy source that satisfied this game (e.g. 'psnine'), so the next
    // refresh can go straight to the one that worked.
    this.addColumnIfMissing('games', 'trophy_source', 'TEXT');

    // Which duration database supplied main_story_hours (e.g. 'hltb' / 'rawg').
    // Kept so a lower-priority source cannot silently overwrite a better value,
    // and so the UI can say where the number came from.
    this.addColumnIfMissing('games', 'duration_source', 'TEXT');
    // User-defined gallery position for the drag-and-drop sort mode. NULL means
    // "never positioned by hand", which is what keeps a freshly scanned game from
    // jumping to the front of an arrangement the user already made.
    this.addColumnIfMissing('games', 'custom_order', 'INTEGER');

    // A Metacritic entry the user picked by hand for this game. Deliberately its
    // own table (not a `games` column) so it survives every scrape: the auto
    // matcher never reads or writes it.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rating_targets (
        game_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        name TEXT,
        platform TEXT,
        metascore INTEGER,
        critic_count INTEGER,
        release_date TEXT,
        created_at INTEGER NOT NULL
      );
    `);

    // Existing rows marked selected were chosen through the poster dialog before
    // this column existed, so treat a non-official selection as a user choice.
    this.db.exec(
      "UPDATE game_posters SET is_user_choice = 1 WHERE is_selected = 1 AND source != 'scraped'",
    );

    this.repairFakeScrapedPosters();
    this.repairLegacyAchievements();
  }

  /**
   * Bring pre-existing achievement rows onto the new id scheme.
   *
   * Rows written before the `source` column existed are keyed `<gameId>:<externalId>`
   * and would never be matched by the incremental upsert (which keys
   * `<gameId>:<source>:<externalId>`), leaving the old rows behind as duplicates on
   * the first re-scrape. They are all Steam achievements, so they are re-keyed and
   * labelled once instead of being discarded — keeps already-scraped data.
   *
   * Idempotent: after one pass no row has a NULL `source`.
   */
  private repairLegacyAchievements(): number {
    const legacy = this.db
      .prepare("SELECT COUNT(*) AS c FROM achievements WHERE source IS NULL")
      .get() as { c: number } | undefined;
    if (!legacy?.c) return 0;

    // Two rows could share an external id under the old scheme; keep one so the
    // re-key below cannot violate the primary key.
    this.db.exec(
      `DELETE FROM achievements
        WHERE source IS NULL
          AND rowid NOT IN (SELECT MIN(rowid) FROM achievements GROUP BY game_id, external_id)`,
    );
    this.db
      .prepare(
        `UPDATE achievements
            SET source = 'steam',
                id = game_id || ':steam:' || COALESCE(external_id, id)
          WHERE source IS NULL`,
      )
      .run();

    this.logger.log(`Migrated ${legacy.c} achievement row(s) to the per-source id scheme`);
    return legacy.c;
  }

  /**
   * Repair poster rows that were recorded as official ("scraped") artwork while
   * actually pointing at a file on this server.
   *
   * `MetadataService.persist()` used to hand `games.poster_url` straight to
   * `ensureScrapedPosters()`. For a game the provider returns no image for, that
   * column holds the local first-image fallback (`/api/media/<id>/thumbnail`), so
   * a fake "official" row was created. Cancelling the cover then "restored" that
   * same local picture — the user's own album screenshot after they had chosen it
   * — so 「取消封面」 looked like it did nothing. The caller is fixed; this repairs
   * databases that already contain such rows.
   *
   * Idempotent: after one pass no matching row remains, so later boots are no-ops.
   */
  private repairFakeScrapedPosters(): number {
    const bogus = this.db
      .prepare(
        `SELECT id, game_id, url, is_selected FROM game_posters
          WHERE source = 'scraped'
            AND url LIKE '/api/media/%'
            AND url NOT LIKE '/api/media/proxy%'`,
      )
      .all() as Array<{ id: string; game_id: string; url: string; is_selected: number }>;
    if (!bogus.length) return 0;

    let repaired = 0;
    for (const row of bogus) {
      const mediaId = /^\/api\/media\/([^/]+)\//.exec(row.url)?.[1] ?? null;
      // Is the same album image already registered properly?
      const twin = mediaId
        ? (this.db
            .prepare(
              `SELECT id FROM game_posters
                WHERE game_id = ? AND source = 'media' AND media_id = ? AND id != ?`,
            )
            .get(row.game_id, mediaId, row.id) as { id: string } | undefined)
        : undefined;

      if (twin) {
        // Hand the cover over before dropping the impostor so it is never lost.
        if (row.is_selected) {
          this.db
            .prepare('UPDATE game_posters SET is_selected = 1, is_user_choice = 0 WHERE id = ?')
            .run(twin.id);
        }
        this.db.prepare('DELETE FROM game_posters WHERE id = ?').run(row.id);
      } else if (mediaId) {
        // Nothing else represents this image — re-label it as what it really is.
        this.db
          .prepare("UPDATE game_posters SET source = 'media', media_id = ?, url = ? WHERE id = ?")
          .run(mediaId, `/api/media/${mediaId}/preview`, row.id);
      } else {
        // An unrecognisable local reference (an upload, say). Drop it rather than
        // let it pose as official artwork.
        this.db.prepare('DELETE FROM game_posters WHERE id = ?').run(row.id);
      }
      repaired++;
    }

    this.logger.log(
      `Repaired ${repaired} poster row(s) that were wrongly recorded as official artwork`,
    );
    return repaired;
  }

  /** Add a column when an older database file predates it. */
  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const cols = this.db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      this.logger.log(`Schema upgrade: added ${table}.${column}`);
    }
  }
}