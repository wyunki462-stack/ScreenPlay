/**
 * HTTP Range streaming helper.
 *
 * Video scrubbing requires the server to honour `Range` requests: the browser
 * asks for a byte slice and we reply `206 Partial Content` with a
 * `Content-Range` header. The controller passes the `req.headers.range` value
 * and the response object; this helper does the byte maths and piping.
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import fs from 'fs-extra';
import path from 'path';

@Injectable()
export class StreamingService {
  private readonly logger = new Logger(StreamingService.name);

  /**
   * Stream a file, honouring the Range header. Guarantees the path stays
   * inside `rootDir` (path traversal defence).
   */
  async stream(
    filePath: string,
    rootDir: string,
    rangeHeader: string | undefined,
    res: Response,
    contentType: string,
  ): Promise<void> {
    // Resolve + confine inside rootDir.
    const absolute = path.resolve(filePath);
    const safeRoot = path.resolve(rootDir);
    if (!isInside(safeRoot, absolute)) {
      throw new NotFoundException('File not found');
    }
    if (!(await fs.pathExists(absolute))) {
      throw new NotFoundException('File not found');
    }

    const stat = await fs.stat(absolute);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', contentType);

    if (!rangeHeader) {
      res.setHeader('Content-Length', stat.size);
      res.statusCode = 200;
      // Without an 'error' handler a read failure (unreadable file, or a file
      // deleted between the stat above and the read) emits an unhandled 'error'
      // event on the ReadStream, which CRASHES the whole Node process — taking
      // down every API for a single bad media file.
      const whole = fs.createReadStream(absolute);
      whole.on('error', (err) => {
        this.logger.warn(`Stream failed for ${absolute}: ${(err as Error)?.message}`);
        if (!res.headersSent) res.statusCode = 500;
        res.end();
      });
      // A client that disconnects mid-download would otherwise leave the file
      // handle open until the process exits.
      res.on('close', () => whole.destroy());
      whole.pipe(res);
      return;
    }

    const range = this.parseRange(rangeHeader, stat.size);
    if (!range) {
      // Malformed range → 416.
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      res.end();
      return;
    }

    const { start, end } = range;
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    const stream = fs.createReadStream(absolute, { start, end });
    stream.on('error', (err) => {
      this.logger.warn(`Range stream failed for ${absolute}: ${(err as Error)?.message}`);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  /** Parse a single-range header like `bytes=0-1023` / `bytes=0-`. */
  private parseRange(
    header: string,
    size: number,
  ): { start: number; end: number } | null {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
    if (!match) return null;
    const [, rawStart, rawEnd] = match;

    let start: number;
    let end: number;

    if (rawStart === '' && rawEnd === '') return null;
    if (rawStart === '') {
      // Suffix range: last N bytes.
      const suffix = Number.parseInt(rawEnd, 10);
      if (suffix === 0) return null;
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number.parseInt(rawStart, 10);
      end = rawEnd === '' ? size - 1 : Number.parseInt(rawEnd, 10);
      if (Number.isNaN(start) || start >= size) return null;
      end = Math.min(end, size - 1);
    }

    if (end < start) return null;
    return { start, end };
  }

  /** Build a streaming closure for a file (used with a dynamic Range header). */
  async open(
    filePath: string,
    rootDir: string,
  ): Promise<{ size: number; contentType: string } | null> {
    const absolute = path.resolve(filePath);
    if (!isInside(path.resolve(rootDir), absolute)) {
      return null;
    }
    if (!(await fs.pathExists(absolute))) return null;
    const stat = await fs.stat(absolute);
    return { size: stat.size, contentType: contentTypeFor(filePath) };
  }
}

/** True when `target` is equal to `root` or a descendant of it. */
function isInside(root: string, target: string): boolean {
  if (root === path.parse(root).root) {
    // Filesystem root (e.g. "/" or "C:\\") — everything is inside it.
    return true;
  }
  return target === root || target.startsWith(root + path.sep);
}

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.jxr': 'image/vnd.ms-photo',
  '.wdp': 'image/vnd.ms-photo',
  '.hdp': 'image/vnd.ms-photo',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
};

export function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}