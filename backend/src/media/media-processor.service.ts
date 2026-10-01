/**
 * Media processing: thumbnail generation, JXR→WebP transcode, video cover
 * extraction.
 *
 * All expensive work happens here, on the backend, and is cached to disk under
 * DATA_DIR. The frontend only ever fetches ready-made thumbnails/covers.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import fs from 'fs-extra';
import path from 'path';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import { AppConfig } from '../config/configuration';
import { MediaType } from './media-types';
import {
  jxrToWebp,
  jxrToWebpVariants,
  isJxrPath,
  JXR_PIPELINE_VERSION,
} from './jxr-decoder';

/**
 * Width of the lightbox rendition. Defined here (not in the caller) because the
 * scan-time warmer and the preview endpoint must agree exactly, or the warmed
 * file is never the one requested and the first click still pays for a decode.
 */
export const JXR_PREVIEW_WIDTH = 2560;

@Injectable()
export class MediaProcessorService {
  private readonly logger = new Logger(MediaProcessorService.name);
  private readonly dataDir: string;
  private readonly thumbWidth: number;
  private readonly thumbQuality: number;

  constructor(config: ConfigService<AppConfig, true>) {
    this.dataDir = config.get('dataDir', { infer: true });
    this.thumbWidth = config.get('thumbnailWidth', { infer: true });
    this.thumbQuality = config.get('thumbnailQuality', { infer: true });

    const ffmpegPath = config.get('ffmpegPath', { infer: true });
    if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
  }

  get thumbnailsDir(): string {
    return path.join(this.dataDir, 'thumbnails');
  }
  get coversDir(): string {
    return path.join(this.dataDir, 'covers');
  }
  /** Browser-safe, larger renditions (used by the lightbox + "view original"). */
  get previewsDir(): string {
    return path.join(this.dataDir, 'previews');
  }

  /** Ensure cache directories exist (called once at startup). */
  prepareDirs(): void {
    fs.ensureDirSync(this.thumbnailsDir);
    fs.ensureDirSync(this.coversDir);
    fs.ensureDirSync(this.previewsDir);
  }

  /**
   * Generate a browser-displayable rendition of an image.
   *
   * This exists because browsers cannot decode JPEG XR (.jxr/.wdp/.hdp) at all:
   * serving the raw bytes produced a permanently broken image in the lightbox
   * and in "view original". Every such source is transcoded to WebP here.
   *
   * `maxWidth` is omitted for the full-resolution variant.
   * Returns the file name (no directory) on success, or null.
   */
  async generatePreview(
    id: string,
    srcPath: string,
    type: MediaType,
    maxWidth?: number,
  ): Promise<string | null> {
    // JXR renditions embed the tone-map version: a maths change must invalidate
    // the stale washed-out WebP rather than serve it forever.
    const suffix = maxWidth
      ? `${id}@w${maxWidth}${isJxrPath(srcPath) ? `v${JXR_PIPELINE_VERSION}` : ''}.webp`
      : `${id}@full${isJxrPath(srcPath) ? `v${JXR_PIPELINE_VERSION}` : ''}.webp`;
    const outPath = path.join(this.previewsDir, suffix);
    if (await fs.pathExists(outPath)) return suffix;

    try {
      if (type === 'video') {
        const frame = await this.extractFrameToBuffer(srcPath);
        if (!frame) return null;
        let p = sharp(frame);
        if (maxWidth) p = p.resize({ width: maxWidth, withoutEnlargement: true });
        await p.webp({ quality: this.thumbQuality }).toFile(outPath);
        return suffix;
      }

      if (isJxrPath(srcPath)) {
        const buf = await jxrToWebp(await fs.readFile(srcPath), { width: maxWidth });
        if (!buf) return null;
        await fs.writeFile(outPath, buf);
        return suffix;
      }

      let pipeline = sharp(srcPath, { animated: false });
      if (maxWidth) pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true });
      await pipeline.webp({ quality: this.thumbQuality }).toFile(outPath);
      return suffix;
    } catch (err) {
      this.logger.warn(
        `Preview failed for ${srcPath}: ${(err as Error)?.message ?? err}`,
      );
      return null;
    }
  }

  /**
   * Generate every rendition of a JXR file from a single decode.
   *
   * The three display sizes (thumbnail / preview / full) share one tone-mapped
   * buffer, so they cannot diverge in exposure and the ~4 s decode is paid once
   * instead of once per size. Called from the scan so a user's first click is a
   * cache hit on all three paths.
   */
  async warmJxrRenditions(
    id: string,
    srcPath: string,
  ): Promise<{ thumbnail: boolean; preview: boolean; full: boolean }> {
    const result = { thumbnail: false, preview: false, full: false };

    const thumbPath = path.join(this.thumbnailsDir, `${id}v${JXR_PIPELINE_VERSION}.webp`);
    const previewPath = path.join(
      this.previewsDir,
      `${id}@w${JXR_PREVIEW_WIDTH}v${JXR_PIPELINE_VERSION}.webp`,
    );
    const fullPath = path.join(this.previewsDir, `${id}@fullv${JXR_PIPELINE_VERSION}.webp`);

    // Only decode when at least one rendition is actually missing.
    const [hasThumb, hasPreview, hasFull] = await Promise.all([
      fs.pathExists(thumbPath),
      fs.pathExists(previewPath),
      fs.pathExists(fullPath),
    ]);
    if (hasThumb) result.thumbnail = true;
    if (hasPreview) result.preview = true;
    if (hasFull) result.full = true;
    if (hasThumb && hasPreview && hasFull) return result;

    const widths: Array<number | undefined> = [];
    if (!hasThumb) widths.push(this.thumbWidth);
    if (!hasPreview) widths.push(JXR_PREVIEW_WIDTH);
    if (!hasFull) widths.push(undefined);

    const variants = await jxrToWebpVariants(await fs.readFile(srcPath), widths, {
      quality: this.thumbQuality,
    });
    for (const v of variants) {
      if (v.width === this.thumbWidth) {
        await fs.writeFile(thumbPath, v.data);
        result.thumbnail = true;
      } else if (v.width === JXR_PREVIEW_WIDTH) {
        await fs.writeFile(previewPath, v.data);
        result.preview = true;
      } else if (v.width === undefined) {
        await fs.writeFile(fullPath, v.data);
        result.full = true;
      }
    }
    return result;
  }

  /**
   * Generate a WebP thumbnail for a media file.
   * Returns the file name (no directory) on success, or null.
   */
  async generateThumbnail(
    id: string,
    srcPath: string,
    type: MediaType,
  ): Promise<string | null> {
    try {
      const thumbName = isJxrPath(srcPath)
        ? `${id}v${JXR_PIPELINE_VERSION}.webp`
        : `${id}.webp`;
      const outPath = path.join(this.thumbnailsDir, thumbName);
      if (await fs.pathExists(outPath)) return thumbName;

      if (type === 'video') {
        const frame = await this.extractFrameToBuffer(srcPath);
        if (!frame) return null;
        await sharp(frame)
          .resize({ width: this.thumbWidth, withoutEnlargement: true })
          .webp({ quality: this.thumbQuality })
          .toFile(outPath);
        return thumbName;
      }

      await this.transcodeImage(srcPath, outPath);
      return thumbName;
    } catch (err) {
      this.logger.warn(
        `Thumbnail failed for ${srcPath}: ${(err as Error)?.message ?? err}`,
      );
      return null;
    }
  }

  /**
   * Resolve a video's cover image: prefer a same-directory, same-basename
   * image file; otherwise extract the first video frame. Output is WebP cached
   * under covers/. Returns `{ fileName, source }`.
   */
  async resolveVideoCover(
    id: string,
    videoPath: string,
  ): Promise<{ fileName: string; source: 'sibling' | 'frame' } | null> {
    const outPath = path.join(this.coversDir, `${id}.webp`);
    if (await fs.pathExists(outPath)) return { fileName: `${id}.webp`, source: 'sibling' };

    const sibling = this.findSiblingCover(videoPath);
    try {
      if (sibling) {
        await this.transcodeImage(sibling, outPath);
        return { fileName: `${id}.webp`, source: 'sibling' };
      }
      const frame = await this.extractFrameToBuffer(videoPath);
      if (!frame) return null;
      await sharp(frame)
        .resize({ width: this.thumbWidth, withoutEnlargement: true })
        .webp({ quality: this.thumbQuality })
        .toFile(outPath);
      return { fileName: `${id}.webp`, source: 'frame' };
    } catch (err) {
      this.logger.warn(
        `Cover extraction failed for ${videoPath}: ${(err as Error)?.message ?? err}`,
      );
      return null;
    }
  }

  /**
   * Probe image dimensions without decoding (fast). Returns null on failure.
   */
  async probeImage(srcPath: string): Promise<{ width: number; height: number } | null> {
    try {
      const meta = await sharp(srcPath).metadata();
      if (meta.width && meta.height) return { width: meta.width, height: meta.height };
      return null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------

  /** Static image/JXR/GIF → WebP. GIF is flattened to its first frame for a cheap thumbnail. */
  private async transcodeImage(srcPath: string, outPath: string): Promise<void> {
    if (isJxrPath(srcPath)) {
      const buf = await jxrToWebp(await fs.readFile(srcPath), { width: this.thumbWidth });
      if (!buf) throw new Error('JXR decode produced no output');
      await fs.writeFile(outPath, buf);
      return;
    }
    await sharp(srcPath, { animated: false })
      .resize({ width: this.thumbWidth, withoutEnlargement: true })
      .webp({ quality: this.thumbQuality })
      .toFile(outPath);
  }

  /** ffmpeg first-frame extraction → PNG/JPG buffer. */
  private extractFrameToBuffer(srcPath: string): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      const cmd = ffmpeg(srcPath)
        .seekInput(0)
        .frames(1)
        .format('image2')
        .outputOptions(['-vcodec', 'png'])
        .on('error', (err) => {
          this.logger.debug(`ffmpeg frame extract failed: ${err.message}`);
          resolve(null);
        });

      const stream = cmd.pipe();
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () =>
        resolve(chunks.length ? Buffer.concat(chunks) : null),
      );
      stream.on('error', () => resolve(null));
    });
  }

  /** Look for an image sibling sharing the video's basename. */
  findSiblingCover(videoPath: string): string | null {
    const dir = path.dirname(videoPath);
    const base = path.basename(videoPath, path.extname(videoPath));
    const candidates = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.jxr', '.wdp', '.hdp'];
    for (const ext of candidates) {
      const candidate = path.join(dir, `${base}${ext}`);
      if (candidate.toLowerCase() === videoPath.toLowerCase()) continue;
      if (fs.pathExistsSync(candidate)) return candidate;
    }
    return null;
  }
}