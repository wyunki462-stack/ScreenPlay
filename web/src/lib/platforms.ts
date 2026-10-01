/** A game's platform fields, as the API returns them. */
export interface PlatformGame {
  platforms?: string[] | null;
  platform?: string | null;
}

/**
 * Platform tags to display for a game: the selected array column first, then the
 * auto-detected scalar — the same rule the backend applies (see
 * `backend/src/common/game-row.ts`).
 */
export function platformTags(game: PlatformGame): string[] {
  const list = (game.platforms ?? []).filter(Boolean);
  if (list.length) return list;
  return game.platform ? [game.platform] : [];
}