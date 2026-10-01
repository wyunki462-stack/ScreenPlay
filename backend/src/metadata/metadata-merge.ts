/**
 * Pure merge helpers behind two rules the scraping pipeline must never break:
 *
 *  1. **A valid Metascore is never destroyed by an update.** Metacritic returns
 *     rating objects whose `metascore` is null — a page with user scores but no
 *     critic reviews yet parses to `{metascore: null, criticCount: 3, ...}`.
 *     Replacing the stored array with one of those made the score badge vanish
 *     from cards and detail pages after a refresh: the reported "评分偶发丢失".
 *  2. **A better duration source wins regardless of who answered first.**
 *     Providers persist in parallel, so first-writer-wins let RAWG's average
 *     playtime beat HowLongToBeat's measured completion time depending on which
 *     request happened to return first.
 *
 * They live outside `MetadataService` so both rules are unit-testable without a
 * database or a network.
 */

import type { MetadataFragment, RatingData } from './provider.interface';

/**
 * Duration sources in preference order, highest first.
 *
 * HowLongToBeat reports an actual "main story" completion time and covers PC,
 * PlayStation, Xbox and Switch, so it wins whenever it answers. RAWG's `playtime`
 * is the average across all players rather than a story time, so it is the
 * fallback — better than showing nothing, but not equal to HLTB.
 */
export const DURATION_SOURCE_PRIORITY: Record<string, number> = { hltb: 2, rawg: 1 };

/**
 * Duration sources in the order the fallback chain tries them.
 *
 * Derived from the priority table so the two can never drift apart.
 */
export const DURATION_SOURCE_ORDER: ('hltb' | 'rawg')[] = Object.entries(DURATION_SOURCE_PRIORITY)
  .sort((a, b) => b[1] - a[1])
  .map(([name]) => name as 'hltb' | 'rawg');

/** The duration columns of a `games` row, plus which source produced them. */
export interface StoredDuration {
  main_story_hours: number | null;
  main_extra_hours: number | null;
  completionist_hours: number | null;
  duration_source: string | null;
}

/** Tolerant JSON column reader — a malformed blob must not break a scrape. */
export function parseJson<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Does this ratings blob carry a usable Metascore? */
export function hasMetascore(ratingsJson: string | null | undefined): boolean {
  return parseJson<RatingData>(ratingsJson ?? '[]').some((r) => r.metascore != null);
}

/**
 * Merge a freshly scraped rating into the stored list without ever downgrading it.
 *
 * An update may only overwrite a field when it actually carries a value;
 * everything else is inherited from the entry already on record.
 *
 * @param existingJson the `ratings` blob currently stored for the game
 * @param incoming the rating the provider just returned (may be absent/empty)
 * @returns the blob to store — the input unchanged when nothing useful arrived
 */
export function mergeRatings(
  existingJson: string | null,
  incoming: RatingData | null | undefined,
): string | null {
  const existing = parseJson<RatingData>(existingJson ?? '[]');
  if (!incoming) return existingJson;

  const incomingHasValue =
    incoming.metascore != null ||
    incoming.userScore != null ||
    incoming.criticCount != null ||
    incoming.userCount != null;
  // A rating that carries nothing at all must not erase what is already stored.
  if (!incomingHasValue) return existingJson;

  const index = existing.findIndex((r) => r.source === incoming.source);
  if (index === -1) return JSON.stringify([...existing, incoming]);

  const prev = existing[index];
  const merged: RatingData = {
    ...prev,
    ...incoming,
    metascore: incoming.metascore ?? prev.metascore ?? null,
    userScore: incoming.userScore ?? prev.userScore ?? null,
    criticCount: incoming.criticCount ?? prev.criticCount ?? null,
    userCount: incoming.userCount ?? prev.userCount ?? null,
    ratingClass: incoming.ratingClass ?? prev.ratingClass ?? null,
  };
  const next = [...existing];
  next[index] = merged;
  return JSON.stringify(next);
}

/**
 * Decide the completion times to store, honouring source preference.
 *
 * A higher-priority source replaces; a lower-priority one only fills blanks, and
 * only claims provenance when it actually contributed something.
 *
 * @param stored the row's current values plus which source produced them
 * @param fragment the freshly scraped values
 */
export function mergeDuration(
  stored: StoredDuration | undefined,
  fragment: MetadataFragment,
): StoredDuration {
  const current: StoredDuration = {
    main_story_hours: stored?.main_story_hours ?? null,
    main_extra_hours: stored?.main_extra_hours ?? null,
    completionist_hours: stored?.completionist_hours ?? null,
    duration_source: stored?.duration_source ?? null,
  };
  const incomingSource = fragment.durationSource ?? null;
  const hasIncoming =
    fragment.mainStoryHours != null ||
    fragment.mainExtraHours != null ||
    fragment.completionistHours != null;
  if (!hasIncoming) return current;

  const incomingRank = incomingSource ? (DURATION_SOURCE_PRIORITY[incomingSource] ?? 0) : 0;
  const storedRank = current.duration_source
    ? (DURATION_SOURCE_PRIORITY[current.duration_source] ?? 0)
    : -1;

  // Equal or better source: take the new numbers, but never blank a field the new
  // payload happens not to carry.
  if (incomingRank >= storedRank) {
    return {
      main_story_hours: fragment.mainStoryHours ?? current.main_story_hours,
      main_extra_hours: fragment.mainExtraHours ?? current.main_extra_hours,
      completionist_hours: fragment.completionistHours ?? current.completionist_hours,
      duration_source: incomingSource ?? current.duration_source,
    };
  }

  // Weaker source: only fill what is still empty.
  const filled: StoredDuration = {
    main_story_hours: current.main_story_hours ?? fragment.mainStoryHours ?? null,
    main_extra_hours: current.main_extra_hours ?? fragment.mainExtraHours ?? null,
    completionist_hours: current.completionist_hours ?? fragment.completionistHours ?? null,
    duration_source: current.duration_source,
  };
  const contributed =
    filled.main_story_hours !== current.main_story_hours ||
    filled.main_extra_hours !== current.main_extra_hours ||
    filled.completionist_hours !== current.completionist_hours;
  if (contributed && !filled.duration_source) filled.duration_source = incomingSource;
  return filled;
}

/**
 * Decide which poster URL to store after a metadata refresh.
 *
 * A stored poster the user picked by hand — an external link, raw or proxied through
 * `/api/media/proxy` — must survive a provider refresh, otherwise matching metadata
 * silently throws away the poster the user chose. A poster we downloaded ourselves is
 * only a stale copy of an older scrape, so it may be replaced.
 *
 * `null` means "keep what is stored" (the UPDATE uses `COALESCE(?, poster_url)`);
 * the caller decides what counts as "ours" via `isLocalFileUrl`.
 *
 * @param storedPosterIsUserChoice true when `poster_url` is non-empty and not our copy
 * @param providerPoster freshly scraped poster URL, if the provider returned one
 */
export function mergePoster(
  storedPosterIsUserChoice: boolean,
  providerPoster: string | null | undefined,
): string | null {
  if (storedPosterIsUserChoice) return null;
  const incoming = (providerPoster ?? '').trim();
  return incoming || null;
}