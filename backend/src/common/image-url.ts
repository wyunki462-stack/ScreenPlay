/**
 * Image URL helpers.
 *
 * External CDN images (RAWG `media.rawg.io`, Steam `*.steamstatic.com`, …) are
 * unreachable directly from a client inside mainland China, so every external
 * image URL is rewritten to the backend's own `/api/media/proxy` endpoint. The
 * backend then fetches the bytes (through the configured proxy) and disk-caches
 * them — see `RemoteImageService`.
 */

const ABSOLUTE_URL = /^https?:\/\//i;

/**
 * Rewrite an external image URL to the local caching proxy.
 * Local paths (`/api/media/...`) and non-http values pass through untouched.
 */
export function toProxiedImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const raw = String(url).trim();
  if (!raw) return null;
  if (raw.startsWith('/')) return raw;
  if (!ABSOLUTE_URL.test(raw)) return raw;
  return `/api/media/proxy?url=${encodeURIComponent(raw)}`;
}

/**
 * Achievement icons: the one directory Steam serves them from, and the file-name
 * shape inside it (`<content-hash>.jpg`).
 *
 * `GetSchemaForGame` is inconsistent about `icon`: most apps return the bare file
 * name, but some return a fully-qualified URL — and those still point at the
 * retired `steamcdn-a.akamaihd.net` host, which now answers 502. Prefixing that
 * URL with the CDN template nested one URL inside another
 * (`…/apps/812140/https://steamcdn-a.akamaihd.net/…/08bdee6f….jpg.jpg`), so every
 * achievement icon of such a game was blank on both Web and the Android client.
 * Only the *file name* is taken from `icon`, which collapses all the shapes
 * (bare name, path, absolute URL, already-nested URL) onto one canonical URL.
 */
const STEAM_ICON_DIR =
  'https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/';
const IMAGE_EXTENSIONS = /(?:\.(?:jpe?g|png|gif))+$/i;
const NESTED_STEAM_ICON =
  /^https?:\/\/cdn\.cloudflare\.steamstatic\.com\/steamcommunity\/public\/images\/apps\/(\d+)\/(https?:\/\/.+)$/i;
const RETIRED_STEAM_ICON_HOST =
  /^https?:\/\/steamcdn-a\.akamaihd\.net\/steamcommunity\/public\/images\/apps\/(\d+)\/(.+)$/i;

/** The bare `<content-hash>` inside any of the `icon` shapes above, or null. */
export function steamIconFileStem(icon: string | null | undefined): string | null {
  if (icon == null) return null;
  const raw = String(icon)
    .trim()
    .split(/[?#]/)[0]
    .replace(/\/+$/, '');
  if (!raw) return null;
  const stem = raw.slice(raw.lastIndexOf('/') + 1).replace(IMAGE_EXTENSIONS, '');
  return stem || null;
}

/**
 * Canonical Steam achievement-icon URL for an appid, from whatever the schema
 * API handed us. Returns null when there is no usable file name (or no icon).
 */
export function steamAchievementIconUrl(
  appid: string,
  icon: string | null | undefined,
): string | null {
  const stem = steamIconFileStem(icon);
  return stem ? `${STEAM_ICON_DIR}${appid}/${stem}.jpg` : null;
}

/**
 * Canonicalize an *already stored* achievement icon URL.
 *
 * Only the two broken shapes are rewritten — one URL nested inside another, and
 * one still pointing at the retired `steamcdn-a.akamaihd.net` host. Anything else
 * (a canonical URL, a PlayStation `psnobj…` PNG, an unknown host) comes back
 * unchanged, which is what makes the boot-time repair idempotent and keeps it
 * from touching rows it has no business touching.
 */
export function normalizeSteamAchievementIconUrl(url: string | null | undefined): string | null {
  if (url == null) return null;
  const raw = String(url).trim();
  if (!raw) return null;

  const nested = NESTED_STEAM_ICON.exec(raw);
  if (nested) {
    // The asset path inside the nested URL names the directory it really lives
    // in; fall back to the outer appid when it is unreadable.
    const innerAppId = /\/apps\/(\d+)\//.exec(nested[2])?.[1] ?? nested[1];
    return steamAchievementIconUrl(innerAppId, nested[2]);
  }

  const retired = RETIRED_STEAM_ICON_HOST.exec(raw);
  if (retired) return steamAchievementIconUrl(retired[1], retired[2]);

  return raw;
}