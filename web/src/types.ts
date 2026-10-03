// Mirrors the ScreenPlay API model shapes (see docs/API.md).

export type MediaType = "image" | "video" | "gif";

export interface GameSummary {
  id: string;
  name: string;
  folderPath: string;
  /** First entry of `platforms`, kept for compatibility. */
  platform: string | null;
  /** User-selected play platforms (feature 6); empty = auto-detected. */
  platforms: string[];
  customPlatform: boolean;
  posterUrl: string | null;
  /** Posters available for the slideshow (feature 5). */
  posters: string[];
  /** Card cover display mode (feature 5). */
  posterMode: PosterMode;
  mediaCount: number;
  durationSeconds: number;
  durationText: string;
  metacriticScore: number | null;
  metacriticCriticCount: number | null;
  /** Hand-set gallery position; null when the user has not moved this game. */
  customOrder?: number | null;
  /** True when the user hand-picked the rating entry instead of auto-matching. */
  metacriticManual?: boolean;
  /** Platform of the hand-picked entry (e.g. "PC", "PlayStation 5"). */
  metacriticPlatform?: string | null;
  /** 'metacritic' when hand-picked, 'auto' when scraped, null when unscored. */
  metacriticSource?: string | null;
  /** Release date printed on the hand-picked entry. */
  metacriticReleaseDate?: string | null;
  metaError: string | null;
  firstPlayedAt: string | null;
  lastPlayedAt: string | null;
}

/** Gallery card cover display mode. */
export type PosterMode = 'static' | 'slideshow';

/** A poster record owned by a game (features 4 & 5). */
export interface Poster {
  id: string;
  gameId: string;
  url: string;
  /**
   * Small rendition of the same picture for grid tiles. `url` for an album
   * poster is the full 4K preview (2.5-9.8 MB); `thumbUrl` is the ~6 KB
   * thumbnail, so tiles stay fast without looking different.
   */
  thumbUrl: string;
  source: 'upload' | 'media' | 'scraped';
  mediaId: string | null;
  isSelected: boolean;
  /**
   * Selected AND not the official artwork — the only case where "取消封面" makes
   * sense. Cancelling the official poster would just restore it.
   */
  isCover: boolean;
  inSlideshow: boolean;
  sortOrder: number;
  createdAt: string;
}

export interface Media {
  id: string;
  gameId: string;
  fileName: string;
  type: MediaType;
  mimeType: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  createdAt: string;
  durationSeconds: number | null;
  streamUrl: string;
  thumbnailUrl: string;
  coverUrl: string | null;
  /** Browser-safe full-size image (JXR is transcoded server-side). */
  previewUrl: string;
}

/** PlayStation trophy tier; `null` for Steam achievements. */
export type AchievementTier = "platinum" | "gold" | "silver" | "bronze";

export interface Achievement {
  id: string;
  gameId: string;
  name: string;
  description: string | null;
  /** Already proxied by the backend, so it can be used as a `src` directly. */
  iconUrl: string | null;
  /** Steam global unlock rate, or the psnine rarity percentage. */
  globalPercent: number | null;
  unlocked: boolean;
  /** Trophy tier (PlayStation); `null` for Steam achievements. */
  tier: AchievementTier | null;
  /** psnine rarity wording: 极为珍贵 / 非常珍贵 / 珍贵 / 一般. */
  rarity: string | null;
  /** Which provider supplied the row: "steam" | "psnine". */
  source: string | null;
  /** Set when the achievement belongs to a Steam DLC. */
  dlcAppId: string | null;
  /** The DLC's store name, used for grouping. */
  dlcName: string | null;
  sortOrder: number;
}

/** Per-tier tally reported alongside the list. */
export interface AchievementCounts {
  platinum: number;
  gold: number;
  silver: number;
  bronze: number;
  total: number;
}

/**
 * `failed` / `unsupported` carry a user-facing reason in `error`; `pending` means
 * a scrape is still running on the server.
 */
export type AchievementStatus = "ok" | "empty" | "failed" | "unsupported" | "pending";

/** Response of `GET /api/achievements/:gameId` (and of the refresh endpoint). */
export interface AchievementsResponse {
  items: Achievement[];
  counts: AchievementCounts;
  status: AchievementStatus;
  /** Human-readable Chinese reason when `status` is "failed". */
  error: string | null;
  /** "steam" | "psnine" — the source that supplied the data. */
  source: string | null;
}

/**
 * One selectable entry in the 「手动选择游戏」 picker.
 *
 * Uniform across Steam and the trophy sites so the dialog lists them together.
 * `detail` carries a disambiguator (e.g. "appid 220") shown under the title.
 */
export interface AchievementCandidate {
  source: string;
  sourceLabel: string;
  externalId: string;
  name: string;
  platform?: string | null;
  releaseYear?: number | null;
  detail?: string | null;
}

/** A hand-picked achievement target, as persisted by the backend. */
export interface AchievementTarget {
  gameId: string;
  source: string;
  externalId: string;
  name: string | null;
}

export type RatingSource = "metacritic";

export interface Rating {
  source: RatingSource;
  metascore: number | null;
  criticCount: number | null;
  userScore: number | null;
  userCount: number | null;
  ratingClass: string | null;
}

/** 媒体评价 — one outlet's review, as shown in the 「媒体评价」 tab. */
export interface MediaReview {
  id: string;
  gameId: string;
  source: string;
  /** Publication name, e.g. "IGN". */
  outlet: string;
  /** The outlet's own score on the 0–100 scale; null when it did not give one. */
  score: number | null;
  /** Word verdict ("Mixed", "Positive") when there is no number. */
  verdict: string | null;
  /** Review excerpt as the source prints it. */
  text: string | null;
  url: string | null;
  author: string | null;
  platform: string | null;
  publishedAt: string | null;
  fetchedAt: number;
}

/**
 * Why the review panel is empty.
 *
 * Without this the UI cannot tell 「还没有抓取过」 from 「抓过了，这个游戏确实
 * 没有媒体评价」 from 「抓取失败（数据源被墙/被限流）」 — three different
 * messages, and only one of them means "暂无媒体评价".
 */
export type MediaReviewsStatus = "ok" | "empty" | "failed" | "unsupported" | null;

export interface MediaReviewsSummary {
  status: MediaReviewsStatus;
  /** Failure reason, shown verbatim when status is failed/unsupported. */
  error: string | null;
  /** Epoch ms of the last fetch attempt, or null when never attempted. */
  fetchedAt: number | null;
  /** The page the reviews came from, for the "查看来源" link. */
  sourceUrl: string | null;
  count: number;
}

export interface MediaReviewsResponse {
  reviews: MediaReview[];
  summary: MediaReviewsSummary;
}

/** Result of POST /games/backfill-ratings. */
export interface MediaReviewsBackfillResult {
  processed: number;
  gained: number;
  reviewsStored: number;
  failed: number;
  skipped: number;
  remaining: number;
  total: number;
  results: {
    id: string;
    name: string;
    status: string;
    count: number;
    error: string | null;
  }[];
}

/** Coverage numbers for the settings card. */
export interface MediaReviewsCoverage {
  total: number;
  withReviews: number;
  awaiting: number;
  failed: number;
  lastFetchedAt: number | null;
  nextToTry: string[];
}

export type PriceSource = "steam";

export interface Price {
  source: PriceSource;
  currency: string | null;
  currentPrice: number | null;
  initialPrice: number | null;
  discountPercent: number | null;
  historicalLow: number | null;
  lastUpdated: string | null;
}

export type TimelineType = "first_media" | "last_media" | "milestone" | "note";

export interface TimelineEvent {
  date: string;
  type: TimelineType;
  title: string;
  description: string | null;
}

export interface GameDetail extends GameSummary {
  folderName: string;
  folderPath: string;
  aliases: string[];
  summary: string | null;
  developers: string[];
  publishers: string[];
  releaseDate: string | null;
  voiceActors: string[];
  screenshots: string[];
  /** Full poster set for the "编辑海报" dialog (features 4 & 5). */
  posterList: Poster[];
  /** Platforms offered in the "平台设置" multi-select (feature 6). */
  knownPlatforms: string[];
  youTubeTrailers: string[];
  mainStoryHours: number | null;
  mainPlusExtraHours: number | null;
  completionistHours: number | null;
  /** Which database supplied the hours ('hltb' / 'rawg'), or null. */
  durationSource?: string | null;
  ratings: Rating[];
  /** 媒体评价 rows for the 「媒体评价」 tab (may be empty). */
  mediaReviews?: MediaReview[];
  /** Scrape state, so an empty panel can explain itself instead of looking broken. */
  mediaReviewsSummary?: MediaReviewsSummary;
  prices: Price[];
  achievements: Achievement[];
  timeline: TimelineEvent[];
  cachedAt: string | null;
  lastMetadataRefresh: string | null;
}

export interface Stats {
  totalGames: number;
  totalMedia: number;
  totalImages: number;
  totalVideos: number;
  totalSizeBytes: number;
  totalPlayTimeSeconds: number;
  platforms: Record<string, number>;
}

export interface LibraryStatus {
  scanning: boolean;
  lastScanAt: string | null;
  totalGames: number;
  totalMedia: number;
}

/** One Metacritic entry the user can pick as a game's score source. */
export interface RatingCandidate {
  externalId: string;
  name: string;
  platform: string | null;
  metascore: number | null;
  releaseDate: string | null;
}

/** Payload of the rating picker endpoint. */
export interface RatingCandidatesResponse {
  query: string;
  /** The entry currently pinned by the user, if any. */
  current: {
    externalId: string;
    name: string | null;
    platform: string | null;
    metascore: number | null;
    releaseDate: string | null;
  } | null;
  /** What automatic matching currently shows. */
  automatic: { metascore: number | null; criticCount: number | null } | null;
  candidates: RatingCandidate[];
}
