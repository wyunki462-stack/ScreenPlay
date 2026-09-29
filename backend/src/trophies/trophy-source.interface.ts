/**
 * PlayStation trophy sources.
 *
 * Steam achievements come from the official Web API inside `SteamProvider`. Sony
 * has no usable public trophy API (and the official PSN endpoints are unreliable
 * from mainland China), so PlayStation trophies are scraped from public Chinese
 * trophy sites instead. Several sources are chained with automatic fallback: when
 * one cannot find the game or fails, the next is tried, so a single dead site does
 * not leave the library without trophies.
 *
 * No PSN account binding is involved anywhere — everything here is public data.
 */

import type { AchievementData, TrophyCounts, TrophyTier } from '../metadata/provider.interface';

/** One candidate game as returned by a source's search. */
export interface TrophySearchHit {
  /** Id this source uses in `fetch()`. */
  externalId: string;
  /** Title as that source spells it (usually Chinese). */
  name: string;
}

/** A fully scraped trophy list. */
export interface TrophyFetchResult {
  /** Source name, e.g. 'psnine'. */
  source: string;
  /** Canonical title the source uses. */
  title: string;
  /** Human-facing page URL, kept for attribution and debugging. */
  url: string;
  achievements: AchievementData[];
  /** Per-tier tally. Derived from `achievements` when the source omits it. */
  counts: TrophyCounts;
}

/**
 * A failure with a message meant for the user.
 *
 * Achievement scraping must never fail silently: whatever ends up here is shown on
 * the detail page and recorded in `games.achievements_error`.
 */
export class TrophySourceError extends Error {
  constructor(
    message: string,
    readonly source: string,
    /** HTTP status when the failure came from a response. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TrophySourceError';
  }
}

export interface TrophySource {
  /** Stable identifier stored in `games.trophy_source`. */
  readonly name: string;
  /** Display name for logs and the UI. */
  readonly label: string;
  /** False when the source is switched off by configuration. */
  readonly enabled: boolean;

  /** Look up candidate games by title. Returns [] when nothing matches. */
  search(name: string): Promise<TrophySearchHit[]>;

  /** Fetch the trophy list for an id returned by `search()`. */
  fetch(externalId: string): Promise<TrophyFetchResult>;
}

/**
 * One selectable game entry in the 「手动选择游戏」 picker.
 *
 * Uniform across every achievement source (Steam, psnine, …) so the dialog can
 * list them together and the user picks the right release/version by eye — which
 * is what fixes folder names like "007" that cannot disambiguate
 * "007 First Light" from "GoldenEye 007".
 */
export interface AchievementCandidate {
  /** Source name this id belongs to, e.g. 'steam' or 'psnine'. */
  source: string;
  /** Display label of that source, for the picker's subtitle. */
  sourceLabel: string;
  /** Id to store in `achievement_links.external_id`. */
  externalId: string;
  name: string;
  /** Platform / release hint shown under the name, when the source knows it. */
  platform?: string | null;
  releaseYear?: number | null;
  /** Extra disambiguation text (e.g. the source's own id or a Chinese title). */
  detail?: string | null;
}

/**
 * DI token for the ordered list of trophy sources.
 *
 * Sources are provided as an array so adding a site is a one-line change in
 * `TrophiesModule`, and `TrophiesService` can walk them with automatic fallback.
 */
export const TROPHY_SOURCES = 'TROPHY_SOURCES';

/** Tally trophy tiers from a list. */
export function countTiers(achievements: AchievementData[]): TrophyCounts {
  const counts: TrophyCounts = { platinum: 0, gold: 0, silver: 0, bronze: 0, total: 0 };
  for (const a of achievements) {
    if (a.tier && a.tier in counts) counts[a.tier as TrophyTier] += 1;
    counts.total += 1;
  }
  return counts;
}