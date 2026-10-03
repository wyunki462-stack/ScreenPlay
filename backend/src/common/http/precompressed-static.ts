/**
 * Serve build-time pre-compressed variants (`.br` / `.gz`) of the Web bundle.
 *
 * The frontend is bundled into two large text files (≈553 KB JS + 74 KB CSS
 * before compression) and the backend is the only server in front of them, so
 * every cold load transfers ~626 KB that compresses to ~172 KB. The variants are
 * produced once by `scripts/build/precompress.mjs` (no runtime CPU, no extra
 * dependency) and this middleware picks the best one the client accepts.
 *
 * Deliberately narrow, because a wrong `Content-Encoding` is worse than no
 * compression at all:
 *   - only GET/HEAD, only known text extensions, only files that actually have a
 *     sibling variant that is not older than the original;
 *   - never when a `Range` header is present (byte ranges and encoded bodies are
 *     incompatible) and never under `/api`;
 *   - the path is resolved inside `root` and anything escaping it is ignored;
 *   - if no variant applies, the request falls through to the normal static
 *     handler, so a partial/absent precompression never breaks serving.
 *
 * `Vary: Accept-Encoding` is always set on the responses it serves, so any cache
 * in front (or the browser) keeps the two encodings apart.
 */

import fs from 'fs';
import path from 'path';
import type { NextFunction, Request, Response } from 'express';

/** Extensions worth encoding. Everything else in a build is already compressed. */
const ENCODABLE = /\.(js|mjs|cjs|css|html|json|svg|txt)$/i;

/** Long-lived only for the content-hashed bundles Vite emits under /assets/. */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const REVALIDATE_CACHE = 'no-cache';

const MIME: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Accepted encoding → file suffix. They differ (`gzip` vs `.gz`), and getting it
 * wrong is silent: `statSync` fails, the middleware falls through, and the response
 * simply comes back uncompressed — which looks like "the feature is not there".
 */
const SUFFIX: Record<'br' | 'gzip', string> = { br: 'br', gzip: 'gz' };

/**
 * Merge into `Vary` instead of replacing it: CORS is enabled on this app and sets
 * `Vary: Origin`, so overwriting the header would drop the origin dimension and
 * let a shared cache hand one origin's response to another.
 */
function appendVary(res: Response, value: string): void {
  const current = res.getHeader('Vary');
  const list = (current ? String(current) : '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (!list.some((v) => v.toLowerCase() === value.toLowerCase())) list.push(value);
  res.setHeader('Vary', list.join(', '));
}

type Encoding = 'br' | 'gzip';

/**
 * Encodings this request will accept, best first, honouring quality values.
 *
 * `q=0` means "not acceptable" (RFC 9110 §12.5.3), so `Accept-Encoding: gzip;q=0`
 * must **not** get a gzipped body even though the token is present — a client that
 * says that has no decoder for it. When both are offered, the higher `q` wins and
 * equal `q` prefers `br` (smaller; every browser that offers gzip over
 * HTTPS/localhost offers br too).
 *
 * `*` is deliberately ignored, keeping the older, narrower behaviour: this
 * middleware only ever serves an encoding the client named. A client that truly
 * accepts anything still gets bytes, just uncompressed ones.
 */
function selectEncodings(header: string): Encoding[] {
  const quality = new Map<string, number>();
  for (const part of header.toLowerCase().split(',')) {
    const [name, ...params] = part.split(';');
    const token = name.trim();
    if (!token) continue;
    let q = 1;
    for (const param of params) {
      const eq = param.indexOf('=');
      if (eq < 0 || param.slice(0, eq).trim() !== 'q') continue;
      const parsed = Number.parseFloat(param.slice(eq + 1));
      if (Number.isFinite(parsed)) q = Math.min(Math.max(parsed, 0), 1);
    }
    quality.set(token, Math.max(quality.get(token) ?? 0, q));
  }
  const qOf = (name: Encoding): number => quality.get(name) ?? 0;
  const ordered: Encoding[] = qOf('br') >= qOf('gzip') ? ['br', 'gzip'] : ['gzip', 'br'];
  return ordered.filter((name) => qOf(name) > 0);
}

type Handler = (req: Request, res: Response, next: NextFunction) => void;

/**
 * @param root Absolute path of the built frontend (`WEB_DIST`).
 */
export function precompressedStatic(root: string): Handler {
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;

  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.headers.range) return next();
    if (!ENCODABLE.test(req.path)) return next();

    const candidates = selectEncodings(String(req.headers['accept-encoding'] ?? ''));
    if (candidates.length === 0) return next();

    let target: string;
    try {
      target = path.join(root, decodeURIComponent(req.path).replace(/^[/\\]+/, ''));
    } catch {
      return next(); // malformed percent-encoding
    }
    if (!target.startsWith(rootWithSep)) return next(); // path traversal

    // First acceptable candidate that actually has a fresh sibling variant wins;
    // if none does, fall through to the normal static handler.
    let encoding: Encoding | null = null;
    let variantInfo: fs.Stats | null = null;
    for (const candidate of candidates) {
      try {
        const variant = fs.statSync(`${target}.${SUFFIX[candidate]}`);
        const source = fs.statSync(target);
        if (!variant.isFile() || !source.isFile()) continue;
        // A rebuild rewrites the original; a stale sibling must never be served, so
        // require the variant to be at least as new (mtime ties are common because
        // both files are written by the same build step).
        if (variant.mtimeMs < source.mtimeMs) continue;
        encoding = candidate;
        variantInfo = variant;
        break;
      } catch {
        continue; // no variant, or the file is not a plain readable file
      }
    }
    if (!encoding || !variantInfo) return next();

    const mime = MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
    const cache = target.includes(`${path.sep}assets${path.sep}`) ? IMMUTABLE_CACHE : REVALIDATE_CACHE;
    // Weak validator: it identifies this encoded representation cheaply, and the
    // name already carries the content hash for hashed assets.
    const etag = `W/"${variantInfo.size}-${Math.round(variantInfo.mtimeMs)}-${encoding}"`;

    res.setHeader('Content-Encoding', encoding);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', String(variantInfo.size));
    appendVary(res, 'Accept-Encoding');
    res.setHeader('Cache-Control', cache);
    res.setHeader('ETag', etag);

    if (req.headers['if-none-match'] === etag) {
      res.status(304);
      return res.end();
    }

    res.status(200);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(`${target}.${SUFFIX[encoding]}`);
    stream.on('error', () => res.end());
    stream.pipe(res);
  };
}