/**
 * PlayStation trophy scraping.
 *
 * Sony exposes no usable public trophy API — the official PSN endpoints need a
 * bound account and are unreliable from mainland China — so trophies are scraped
 * from public Chinese trophy sites. Sources are chained: when one cannot find the
 * game, or fails, the next is tried, and the reason for every failure is kept so
 * the failure can be reported instead of silently leaving the tab empty.
 *
 * Steam achievements are handled by `SteamProvider`; this service is deliberately
 * PlayStation-only and never touches games that cannot have trophies.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { GameRecognizerService } from '../library/game-recognizer.service';
import type { AchievementData, TrophyCounts } from '../metadata/provider.interface';
import {
  TROPHY_SOURCES,
  TrophySource,
  TrophySourceError,
  countTiers,
  type AchievementCandidate,
} from './trophy-source.interface';
import { storeAchievements } from './achievement-store';
import { AchievementTargetService } from './achievement-target.service';

/** Outcome of one trophy sync, mapped onto `games.achievements_*`. */
export interface TrophySyncOutcome {
  /** ok | empty | failed | unsupported | skipped */
  status: 'ok' | 'empty' | 'failed' | 'unsupported' | 'skipped';
  error: string | null;
  source: string | null;
  total: number;
}

interface GameRow {
  id: string;
  name: string;
  platform: string | null;
  platforms: string | null;
  trophy_source: string | null;
  last_achievements_refresh: number | null;
}

/** How long a scraped trophy list is trusted before a plain refresh re-fetches. */
const TROPHY_TTL_MS = 15 * 24 * 60 * 60 * 1000;

/**
 * True when a platform list means "PlayStation".
 *
 * Matches RAWG's full names ("PlayStation 5", "PlayStation Vita") as well as the
 * short forms the UI and manual overrides use ("PS5", "PS4", "PSV", "PSP").
 */
export function isPlayStation(platforms: string[]): boolean {
  return platforms.some((p) => {
    const s = String(p ?? '').trim().toLowerCase();
    if (!s) return false;
    if (s.includes('playstation') || s.includes('psn')) return true;
    // Short forms: ps3/ps4/ps5/psv/psp/vita, but not "psp" inside another word.
    return /^(ps[3-5]|psv|psp|vita)\b/.test(s) || /^(ps[3-5]|psv|psp)$/.test(s);
  });
}

/** Parse the JSON `platforms` column, falling back to the single `platform`. */
function platformsOf(row: GameRow): string[] {
  let list: string[] = [];
  try {
    const parsed = JSON.parse(row.platforms ?? '[]');
    if (Array.isArray(parsed)) list = parsed.map((p) => String(p));
  } catch {
    /* malformed JSON — fall back to the scalar column */
  }
  if (list.length) return list;
  return row.platform ? [row.platform] : [];
}

@Injectable()
export class TrophiesService {
  private readonly logger = new Logger(TrophiesService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly recognizer: GameRecognizerService,
    @Optional() @Inject(TROPHY_SOURCES) private readonly sources: TrophySource[] = [],
    @Optional() private readonly targets?: AchievementTargetService,
  ) {}

  /**
   * Drop every scraped achievement/trophy row for a game and reset its status.
   *
   * Called by the manual-match flow before a game is re-bound to a new identity.
   * The rows in the achievements table describe the PREVIOUS game, so keeping
   * them showed the old title's trophy list underneath the new one. The user's
   * manual achievement target is cleared with them, since it points at the old
   * title too — a fresh match starts from automatic lookup again.
   */
  clearForGame(gameId: string): void {
    this.db.run('DELETE FROM achievements WHERE game_id = ?', [gameId]);
    this.targets?.clear(gameId);
    this.db.run(
      `UPDATE games SET achievements_status = NULL, achievements_error = NULL,
         last_achievements_refresh = NULL, trophy_source = NULL
       WHERE id = ?`,
      [gameId],
    );
  }

  /** Is this a PlayStation game that could have trophies at all? */
  isPlayStationGame(gameId: string): boolean {
    const row = this.db.get<GameRow>(
      'SELECT id, name, platform, platforms, trophy_source, last_achievements_refresh FROM games WHERE id = ?',
      [gameId],
    );
    return !!row && isPlayStation(platformsOf(row));
  }

  /**
   * Scrape trophies for one game.
   *
   * `force` bypasses the freshness check (an explicit user refresh); otherwise a
   * list scraped within the TTL is reused so a routine metadata refresh does not
   * hammer the source site.
   */
  async sync(gameId: string, force = false): Promise<TrophySyncOutcome> {
    const row = this.db.get<GameRow>(
      'SELECT id, name, platform, platforms, trophy_source, last_achievements_refresh FROM games WHERE id = ?',
      [gameId],
    );
    if (!row) return { status: 'skipped', error: null, source: null, total: 0 };

    // A hand-picked target wins over every automatic signal. It also bypasses the
    // platform gate below: when the user has explicitly said "these trophies are
    // that entry", platform detection failing must not veto their choice.
    const manual = this.targets?.get(gameId) ?? null;
    const trophyTarget =
      manual && this.sources.some((s) => s.name === manual.source) ? manual : null;

    if (manual && !trophyTarget) {
      // The manual target belongs to a non-trophy source (Steam): not our job.
      return { status: 'unsupported', error: null, source: null, total: 0 };
    }

    if (!trophyTarget && !isPlayStation(platformsOf(row))) {
      // Not an error — a PC game legitimately has no trophies. The verdict is
      // returned rather than written: the caller may have Steam results for this
      // game, and writing 'unsupported' here used to overwrite a real Steam
      // failure (an invalid key reported as "no source"), hiding the reason.
      return { status: 'unsupported', error: null, source: null, total: 0 };
    }

    const fresh =
      !force &&
      row.last_achievements_refresh != null &&
      Date.now() - row.last_achievements_refresh < TROPHY_TTL_MS;
    if (fresh) {
      const have = this.db.get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM achievements WHERE game_id = ?',
        [gameId],
      );
      if ((have?.c ?? 0) > 0) {
        return { status: 'ok', error: null, source: row.trophy_source, total: have?.c ?? 0 };
      }
    }

    const usable = this.sources.filter((s) => s.enabled);
    if (usable.length === 0) {
      const msg = '没有可用的主机奖杯数据源，请检查服务配置。';
      this.setStatus(gameId, 'failed', msg, null);
      return { status: 'failed', error: msg, source: null, total: 0 };
    }


    // Prefer the hand-picked source, then the one that worked last time, then the
    // rest in order. This is the "try each source in turn, fall back on failure"
    // chain: a dead site moves on to the next instead of ending the scrape.
    const first = trophyTarget?.source ?? row.trophy_source;
    const ordered = [
      ...usable.filter((s) => s.name === first),
      ...usable.filter((s) => s.name !== first),
    ];

    const failures: string[] = [];
    for (const source of ordered) {
      try {
        // A hand-picked entry skips the fuzzy search entirely — searching again
        // is what picked the wrong release in the first place.
        const pinned = trophyTarget && source.name === trophyTarget.source;
        const hit = pinned
          ? { externalId: trophyTarget.externalId, name: trophyTarget.name ?? row.name }
          : await this.resolveHit(source, row.name);
        if (!hit) {
          failures.push(`${source.label}：未找到该游戏`);
          continue;
        }
        const result = await source.fetch(hit.externalId);
        if (result.achievements.length === 0) {
          failures.push(`${source.label}：页面没有奖杯数据`);
          continue;
        }
        storeAchievements(this.db, gameId, source.name, result.achievements);
        const total = result.achievements.length;
        this.setStatus(gameId, 'ok', null, source.name);
        this.logger.log(
          `Trophies for "${row.name}" from ${source.label}: ${total} (${
            Object.entries(result.counts)
              .filter(([k]) => k !== 'total')
              .map(([k, v]) => `${k} ${v}`)
              .join(', ')
          })`,
        );
        return { status: 'ok', error: null, source: source.name, total };
      } catch (err) {
        const reason =
          err instanceof TrophySourceError
            ? err.message
            : `${(err as Error)?.message || String(err)}`;
        failures.push(reason);
        this.logger.warn(`Trophy source ${source.name} failed for "${row.name}": ${reason}`);
      }
    }

    // Every source failed — say so, with the reasons.
    const msg = `全部奖杯数据源均失败：${failures.join('；')}`;
    this.setStatus(gameId, 'failed', msg, null);
    return { status: 'failed', error: msg, source: null, total: 0 };
  }

  /**
   * All candidate entries across every trophy source, for the manual picker.
   *
   * Unlike `sync()`, a source that fails here is skipped silently: the picker
   * still lists whatever the reachable sources returned.
   */
  async searchCandidates(query: string): Promise<AchievementCandidate[]> {
    const usable = this.sources.filter((s) => s.enabled);
    const perSource = await Promise.all(
      usable.map(async (source) => {
        try {
          const hits = await source.search(query);
          return hits.map((h) => ({
            source: source.name,
            sourceLabel: source.label,
            externalId: h.externalId,
            name: h.name,
            platform: 'PlayStation',
            releaseYear: null,
            detail: null,
          }));
        } catch (err) {
          // Best effort: one unreachable site must not empty the picker.
          this.logger.warn(
            `Trophy candidate search failed on ${source.name} for "${query}": ${(err as Error)?.message}`,
          );
          return [];
        }
      }),
    );
    return perSource.flat();
  }

  /** Search a source and pick its best match for this title. */
  private async resolveHit(
    source: TrophySource,
    name: string,
  ): Promise<{ externalId: string; name: string } | null> {
    const hits = await source.search(name);
    if (hits.length === 0) return null;
    const best = this.recognizer.fuzzyMatch(name, hits, (h) => h.name);
    // A weak match is worse than none: binding the wrong game would show another
    // game's trophies. 0.4 is the project's usual floor for provider matching.
    if (!best.item || best.score < 0.4) return hits[0];
    return best.item;
  }

  /** Record the scrape state so the UI never has to guess why a tab is empty. */
  private setStatus(
    gameId: string,
    status: TrophySyncOutcome['status'],
    error: string | null,
    source: string | null,
  ): void {
    // `skipped` is a no-op signal, not a state worth persisting.
    if (status === 'skipped') return;
    this.db.run(
      `UPDATE games SET achievements_status = ?, achievements_error = ?,
         trophy_source = COALESCE(?, trophy_source), last_achievements_refresh = ?
       WHERE id = ?`,
      [status, error, source, Date.now(), gameId],
    );
  }

  /** Per-tier tally for a game, from whatever rows are stored. */
  countsFor(gameId: string): TrophyCounts {
    const rows = this.db.all<{ tier: string | null }>(
      'SELECT tier FROM achievements WHERE game_id = ?',
      [gameId],
    );
    return countTiers(rows.map((r) => ({ tier: r.tier }) as AchievementData));
  }
}