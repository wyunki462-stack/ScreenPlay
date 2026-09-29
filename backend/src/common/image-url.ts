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