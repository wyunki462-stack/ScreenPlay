/**
 * Central typed configuration.
 *
 * Every value is sourced from process.env (no hardcoded secrets). The
 * `get` defaults keep local development working with zero config, while
 * production (Docker) injects real values via environment variables.
 */

export interface AppConfig {
  port: number;
  corsOrigins: string[];
  mediaDirs: string[];
  /**
   * Hard allow-list for the read-only directory browser (`/library/roots/browse`).
   * Empty means "compute defaults at runtime" — the existing media roots plus the
   * usual mount points / Windows drive letters. Setting `LIBRARY_BROWSE_ROOTS`
   * replaces those defaults entirely.
   */
  libraryBrowseRoots: string[];
  dataDir: string;
  dbFilename: string;
  thumbnailWidth: number;
  thumbnailQuality: number;
  ffmpegPath: string | null;

  rawgApiKey: string;
  rawgProxy: string;
  /** NO_PROXY from the environment (informational; LAN is always direct). */
  noProxy: string;
  imageFetchOrder: string;
  igdbClientId: string;
  igdbClientSecret: string;
  steamApiKey: string;
  /** Base URL of the Steam *store* API (search + appdetails). Override to use a stub/mirror. */
  steamStoreBaseUrl: string;
  /** Base URL of the Steam *web* API (achievement schemas + global percentages). */
  steamApiBaseUrl: string;
  trophyPsnineDisabled: boolean;
  /** Base URL of the PlayStation trophy site (override to use a mirror/proxy). */
  trophyPsnineBaseUrl: string;
  steamdbKey: string;

  crawlerMinIntervalMs: number;
  /**
   * Faster per-origin interval for the two Steam endpoints only. Politeness is a
   * policy, not a hard limit: Steam tolerates a quicker cadence than the global
   * 1200ms default, so achievement scraping is not capped at ~0.83 req/s.
   * Set it to the global value (1200) to fall back to the conservative pace.
   */
  crawlerMinIntervalSteamMs: number;
  crawlerMaxRetries: number;
  crawlerUserAgent: string;

  cacheTtlGameSeconds: number;
  cacheTtlRatingSeconds: number;
  cacheTtlAchievementsSeconds: number;

  // --- Authentication (local only — no cloud service is ever contacted) ---
  /** Master switch. `AUTH_DISABLED=1` turns the guard off (escape hatch). */
  authEnabled: boolean;
  /** `system` = NAS accounts via mounted /etc; `local` = app-managed accounts. */
  authMode: 'system' | 'local';
  /**
   * Allow the login page to create the first local account when none exists
   * (`AUTH_ALLOW_SETUP=1`). Off by default, so Linux/Docker keeps seeding `admin`.
   */
  authAllowSetup: boolean;
  /** How long a session stays valid; drives "记住登录状态". */
  authSessionDays: number;
  /** Where the host user database is mounted inside the container. */
  authPasswdPath: string;
  authShadowPath: string;
  authGroupPath: string;
  /** Only these accounts may sign in (empty = any normal account). */
  authAllowedUsers: string[];
  /**
   * Password for the seeded local `admin` account. Used on first run so the app
   * is never left unreachable; changeable from the UI afterwards.
   */
  authAdminPassword: string;
}

/** Parse a comma separated string env var into a trimmed, non-empty array. */
function csv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export default function configuration(): AppConfig {
  return {
    port: int(process.env.PORT, 3000),
    corsOrigins: csv(process.env.CORS_ORIGINS).length
      ? csv(process.env.CORS_ORIGINS)
      : ['*'],
    mediaDirs: csv(process.env.MEDIA_DIRS).length
      ? csv(process.env.MEDIA_DIRS)
      : ['/media'],

    // Empty => the browser service derives its own defaults (see browseRoots()).
    libraryBrowseRoots: csv(process.env.LIBRARY_BROWSE_ROOTS),

    dataDir: process.env.DATA_DIR || './data',
    dbFilename: process.env.DB_FILENAME || 'screenplay.db',

    thumbnailWidth: int(process.env.THUMBNAIL_WIDTH, 480),
    thumbnailQuality: int(process.env.THUMBNAIL_QUALITY, 80),
    // fluent-ffmpeg resolves ffmpeg from PATH when this is null
    ffmpegPath: process.env.FFMPEG_PATH || null,

    // Metadata provider credentials (empty => provider is disabled)
    rawgApiKey: process.env.RAWG_API_KEY || '',
    // Optional HTTP(S) proxy for RAWG requests, e.g. http://host.docker.internal:7890
    // RAWG_PROXY wins; if unset we fall back to the standard runtime proxy env
    // vars so a compose deployment can configure the proxy the usual way.
    rawgProxy: firstNonEmpty(
      process.env.RAWG_PROXY,
      process.env.HTTPS_PROXY,
      process.env.HTTP_PROXY,
      process.env.https_proxy,
      process.env.http_proxy,
    ),
    // Hosts that must bypass the proxy (comma separated). Only used to explain
    // the effective config in the UI; private/LAN hosts are always direct.
    noProxy: firstNonEmpty(process.env.NO_PROXY, process.env.no_proxy),
    // Image (poster/screenshot) fetch strategy, comma separated: proxy,direct.
    // Empty => "proxy,direct" when a proxy is configured, else "direct".
    imageFetchOrder: process.env.IMAGE_FETCH_ORDER || '',
    igdbClientId: process.env.IGDB_CLIENT_ID || '',
    igdbClientSecret: process.env.IGDB_CLIENT_SECRET || '',
    steamApiKey: process.env.STEAM_API_KEY || '',
    // Overridable so the achievement pipeline can be verified offline against a
    // local stub (the same reason HLTB_BASE_URL / METACRITIC_BASE_URL exist).
    steamStoreBaseUrl: (
      process.env.STEAM_STORE_BASE_URL || 'https://store.steampowered.com'
    ).replace(/\/+$/, ''),
    steamApiBaseUrl: (
      process.env.STEAM_API_BASE_URL || 'https://api.steampowered.com'
    ).replace(/\/+$/, ''),
    steamdbKey: process.env.STEAMDB_KEY || '',

    // PlayStation trophies are scraped from a public Chinese trophy site (psnine).
    // Set TROPHY_PSNINE_DISABLED=1 to switch that source off without a redeploy —
    // useful if the site blocks us or goes down.
    trophyPsnineDisabled: process.env.TROPHY_PSNINE_DISABLED === '1',

    // Override to reach the trophy site through a mirror or your own reverse proxy.
    // Worth having: which sites are reachable depends on the network the container
    // sits behind, and a second entry point is exactly what the fallback chain
    // needs when the primary host is blocked from one network but not another.
    trophyPsnineBaseUrl: process.env.TROPHY_PSNINE_BASE_URL || 'https://psnine.com',

    // Crawler hygiene (respect robots.txt spirit: >= 1s between requests)
    crawlerMinIntervalMs: int(process.env.CRAWLER_MIN_INTERVAL_MS, 1200),
    // Steam-only cadence (see AppConfig). 350ms ≈ 2.9 req/s per Steam origin:
    // measurably faster than the 1200ms default, still serialized and polite.
    crawlerMinIntervalSteamMs: int(process.env.CRAWLER_MIN_INTERVAL_STEAM_MS, 350),
    crawlerMaxRetries: int(process.env.CRAWLER_MAX_RETRIES, 3),
    crawlerUserAgent:
      process.env.CRAWLER_USER_AGENT ||
      'ScreenPlay/0.6 (+personal metadata library)',

    // Cache TTLs (seconds) — matches the spec: game 30d, rating/price 7d, achievements 15d
    cacheTtlGameSeconds: int(process.env.CACHE_TTL_GAME_SECONDS, 30 * 24 * 3600),
    cacheTtlRatingSeconds: int(process.env.CACHE_TTL_RATING_SECONDS, 7 * 24 * 3600),
    cacheTtlAchievementsSeconds: int(
      process.env.CACHE_TTL_ACHIEVEMENTS_SECONDS,
      15 * 24 * 3600,
    ),

    // Authentication. Everything here is local: the system provider reads the
    // mounted host user database, the local provider keeps scrypt hashes in the
    // app database. Nothing is ever sent to a cloud service.
    authEnabled: !['1', 'true', 'yes'].includes((process.env.AUTH_DISABLED ?? '').toLowerCase()),
    authMode: (process.env.AUTH_MODE ?? 'system').toLowerCase() === 'local' ? 'local' : 'system',
    authAllowSetup: ['1', 'true', 'yes'].includes((process.env.AUTH_ALLOW_SETUP ?? '').toLowerCase()),
    authSessionDays: int(process.env.AUTH_SESSION_DAYS, 30),
    authPasswdPath: process.env.AUTH_PASSWD_PATH || '/host-etc/passwd',
    authShadowPath: process.env.AUTH_SHADOW_PATH || '/host-etc/shadow',
    authGroupPath: process.env.AUTH_GROUP_PATH || '/host-etc/group',
    authAllowedUsers: csv(process.env.AUTH_ALLOWED_USERS),
    authAdminPassword: process.env.AUTH_ADMIN_PASSWORD || '',
  };
}

/**
 * First non-empty value among the candidates, trimmed.
 * Used so `RAWG_PROXY` keeps priority while the standard runtime proxy
 * variables (HTTP_PROXY / HTTPS_PROXY) work as a fallback.
 */
function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const v of values) {
    const s = (v ?? '').trim();
    if (s) return s;
  }
  return '';
}
