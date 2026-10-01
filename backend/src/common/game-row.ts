/**
 * Helpers for reading a `games` row the way every read path needs it.
 *
 * `games.platforms` is a JSON array column written by the scrapers, while
 * `games.platform` is the legacy scalar a few providers still fill. The games and
 * trophies read paths must agree on how the two combine — they used to carry three
 * copies of that rule between them.
 */

/** Parse a JSON array column, tolerating NULL, a scalar and malformed JSON. */
export function parseStringArray(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.map((p) => String(p)) : [];
  } catch {
    return [];
  }
}

/** The platform fields a row must expose for {@link platformsOfRow}. */
export interface PlatformRow {
  platforms?: string | null;
  platform?: string | null;
}

/**
 * The platform list to show for a row: the user-selected array column first,
 * then the scraped scalar.
 */
export function platformsOfRow(row: PlatformRow): string[] {
  const list = parseStringArray(row.platforms);
  if (list.length) return list;
  return row.platform ? [row.platform] : [];
}