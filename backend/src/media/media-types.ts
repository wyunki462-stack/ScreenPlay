/**
 * Media file-type registry.
 *
 * This single source of truth maps file extensions to MediaType / MIME and is
 * consumed by both the scanner and the media processor. It is intentionally a
 * plain object so the plugin system (P3) can *extend* it at runtime with new
 * formats without touching the core scanner.
 */

export type MediaType = 'image' | 'video' | 'gif';

export interface MediaFormat {
  type: MediaType;
  mimeType: string;
  /** True when the format may be animated (GIF/APNG/animated WebP). */
  animated?: boolean;
}

const EXTENSIONS = new Map<string, MediaFormat>();

function register(exts: string[], format: MediaFormat): void {
  for (const ext of exts) EXTENSIONS.set(ext.toLowerCase(), format);
}

// --- Images (static + animated) ---
register(['.jpg', '.jpeg'], { type: 'image', mimeType: 'image/jpeg' });
register(['.png'], { type: 'image', mimeType: 'image/png', animated: true });
register(['.webp'], { type: 'image', mimeType: 'image/webp', animated: true });
register(['.gif'], { type: 'gif', mimeType: 'image/gif', animated: true });
// JPEG XR (a.k.a. HD Photo / Windows Media Photo). Recognised so the backend
// can decode + transcode to WebP; the frontend never handles JXR natively.
register(['.jxr', '.wdp', '.hdp'], { type: 'image', mimeType: 'image/vnd.ms-photo' });

// --- Video ---
register(['.mp4'], { type: 'video', mimeType: 'video/mp4' });
register(['.webm'], { type: 'video', mimeType: 'video/webm' });
register(['.mkv'], { type: 'video', mimeType: 'video/x-matroska' });

/** Resolve a file name/path to its media format, or null if unsupported. */
export function resolveFormat(filePathOrName: string): MediaFormat | null {
  const match = /\.[a-z0-9]+$/i.exec(filePathOrName);
  if (!match) return null;
  return EXTENSIONS.get(match[0].toLowerCase()) ?? null;
}

/** All supported extensions (for glob patterns). e.g. `*.{jpg,jpeg,...}`. */
export function supportedExtensions(): string[] {
  const exts = [...EXTENSIONS.keys()].map((e) => e.slice(1));
  return [...new Set(exts)];
}

export function isSupported(filePathOrName: string): boolean {
  return resolveFormat(filePathOrName) != null;
}