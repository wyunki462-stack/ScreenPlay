/**
 * Metadata provider SPI (Service Provider Interface).
 *
 * This is the extension point for third-party metadata sources (P1's IGDB /
 * HLTB / Steam / Metacritic, and any future plugin). A provider only needs to
 * implement two methods: `search` (name/platform → external entity) and
 * `fetch` (entity → normalized metadata fragment). The aggregator owns rate
 * limiting, retries, caching and persistence.
 */

export type MetadataProviderName = 'rawg' | 'igdb' | 'hltb' | 'steam' | 'metacritic';

/** A located external entity for a given game name. */
export interface ProviderMatch {
  /** Stable id in the provider's namespace (AppID, slug, IGDB id…). */
  externalId: string;
  /** Normalized title as the provider knows it. */
  name: string;
  platform: string | null;
  /** Optional release year; used to disambiguate same-name titles. */
  releaseYear: number | null;

  /**
   * Metascore shown on the search result card, when the source publishes one in
   * its list view. Lets the manual rating picker show each platform's score
   * without fetching every candidate page.
   */
  metascore?: number | null;
  /** Release date as printed on the result card (e.g. "Sep 17, 2020"). */
  releaseDate?: string | null;
}

/** Partial metadata contributed by a single provider. Fields are optional. */
export interface MetadataFragment {
  summary?: string | null;
  /** Authoritative title from the provider (used to autocorrect the display name). */
  canonicalName?: string | null;
  developers?: string[];
  publishers?: string[];
  platforms?: string[];
  releaseDate?: string | null;
  voiceActors?: string[];
  poster?: string | null;
  screenshots?: string[];

  // HowLongToBeat times (hours).
  mainStoryHours?: number | null;
  mainExtraHours?: number | null;
  completionistHours?: number | null;

  /**
   * Which database produced the hours above ('hltb' / 'rawg'). Lets the service
   * apply a source preference instead of accepting whichever provider answered
   * first, and keeps the UI honest about where a duration came from.
   */
  durationSource?: string;

  // Metacritic-style rating.
  rating?: RatingData | null;

  /**
   * Individual critic reviews ("媒体评价") from the same page as `rating`.
   *
   * Kept separate from `RatingData`, which is an aggregate score summary: this is
   * a list of per-outlet rows (publication, its own score, review text). The
   * aggregate is what the cards show; this list is what the 「媒体评价」 tab shows.
   */
  mediaReviews?: MediaReviewData[];

  // Steam-style pricing.
  price?: PriceData | null;

  // Steam achievements.
  achievements?: AchievementData[];
  /**
   * Set when achievement scraping FAILED, as opposed to the game simply having
   * none (empty is `achievements: []` with no error).
   *
   * The Steam fetch used to swallow every error with `.catch(() => null)`, so an
   * invalid key, a rate limit or a blocked `api.steampowered.com` produced an
   * empty achievement tab with no explanation at all. Whatever lands here is
   * persisted to `games.achievements_error` and shown on the detail page.
   */
  achievementsError?: string | null;
}

export interface RatingData {
  source: string;
  metascore: number | null;
  criticCount: number | null;
  userScore: number | null;
  userCount: number | null;
  ratingClass: string | null;
}

/**
 * One critic review as shown on a Metacritic game page.
 *
 * `outlet` is the publication name ("IGN", "GameSpot", …) and is the only field
 * guaranteed to exist — a review card with no score or with its text truncated
 * away is still worth showing, so both are nullable.
 *
 * `text` is deliberately short: Metacritic only publishes an excerpt on the game
 * page (the full review lives on the outlet's own site). We store the excerpt,
 * which is what the site itself displays.
 */
export interface MediaReviewData {
  /** Publication name, e.g. "IGN". */
  outlet: string;
  /** The outlet's own score, on Metacritic's 0–100 scale. */
  score: number | null;
  /** Short review excerpt / verdict text. */
  text: string | null;
  /** Verdict word when the site gives one instead of a number ("Positive"). */
  verdict?: string | null;
  /** Link to the review on Metacritic (not the outlet site). */
  url?: string | null;
  /** Critic name, when the page credits one. */
  author?: string | null;
  /** Platform the review was written for ("PC", "PS5", …). */
  platform?: string | null;
  /** Publication date as printed by the site (ISO when a date is embedded). */
  publishedAt?: string | null;
}

export interface PriceData {
  source: string;
  currency: string | null;
  currentPrice: number | null;
  initialPrice: number | null;
  discountPercent: number | null;
  historicalLow: number | null;
}

/** Trophy tiers PlayStation uses; Steam achievements have no tier. */
export type TrophyTier = 'platinum' | 'gold' | 'silver' | 'bronze';

export interface AchievementData {
  externalId: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  globalPercent: number | null;
  unlocked: boolean;
  /** PlayStation trophy tier. Left undefined/null for Steam achievements. */
  tier?: TrophyTier | null;
  /** Rarity wording as the source states it (极为珍贵/非常珍贵/珍贵/一般). */
  rarity?: string | null;
  /** Origin of the row: 'steam' | 'psnine'. Filled in by the persister. */
  source?: string | null;
  /** Steam DLC appid when this achievement belongs to an add-on. */
  dlcAppId?: string | null;
  /** Steam DLC store name, for grouping in the UI. */
  dlcName?: string | null;
  /** Display order within the game (base game first, then DLC). */
  sortOrder?: number;
}

/** Per-tier trophy tally, shown in the detail page header. */
export interface TrophyCounts {
  platinum: number;
  gold: number;
  silver: number;
  bronze: number;
  total: number;
}

export interface MetadataProvider {
  readonly name: MetadataProviderName;
  /** Providers disable themselves when credentials are missing. */
  readonly enabled: boolean;
  /** Cache TTL (seconds) for this provider's responses. */
  readonly cacheTtlSeconds: number;

  /** Locate the best entity match for a game name (may use platform hint). */
  search(name: string, platform: string | null): Promise<ProviderMatch | null>;

  /**
   * Every plausible match, best first, for the manual-match dialog.
   *
   * `search()` deliberately returns its single best guess, which is right for
   * automatic scraping but leaves a user who disagrees with that guess with no
   * alternative to pick. Providers that can enumerate their results implement
   * this; the dialog falls back to `search()` for the rest.
   */
  searchAll?(name: string, platform: string | null): Promise<ProviderMatch[]>;

  /**
   * The public page a match's data came from, when the provider has one.
   *
   * Used by the UI to link back to the source (the 媒体评价 panel's 「数据来源」).
   * Declared by the provider instead of composed by the caller so the link follows
   * whatever origin the provider is actually configured to read — a hardcoded
   * domain in the caller would point users at a site they may not even reach.
   */
  sourceUrl?(match: { externalId: string }): string | null;

  /** Fetch the full metadata fragment for a located match. */
  fetch(match: ProviderMatch, options?: ProviderFetchOptions): Promise<MetadataFragment>;
}

/**
 * Optional per-call switches for `fetch()`. Providers that have nothing to skip
 * simply ignore the argument, so this stays backward compatible.
 */
export interface ProviderFetchOptions {
  /**
   * Skip this provider's achievement/trophy scrape and return metadata only.
   *
   * Used by the bulk refresh to honour the achievements tier's 15-day TTL: the
   * caller has already established that the stored rows are fresh, and a fragment
   * without `achievements`/`achievementsError` makes `persist()` leave the
   * achievements table and its status untouched.
   */
  skipAchievements?: boolean;
}