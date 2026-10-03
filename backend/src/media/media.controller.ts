import { Controller, Delete, Get, Param, Query, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import fs from 'fs-extra';
import path from 'path';
import { AppConfig } from '../config/configuration';
import { RemoteImageService } from '../common/http/remote-image.service';
import { JXR_PREVIEW_WIDTH, MediaProcessorService } from './media-processor.service';
import { isJxrPath } from './jxr-decoder';
import { MediaService } from './media.service';
import { StreamingService } from './streaming.service';

@Controller('api/media')
export class MediaController {
  private readonly dataDir: string;

  constructor(
    private readonly media: MediaService,
    private readonly streaming: StreamingService,
    private readonly processor: MediaProcessorService,
    private readonly remoteImage: RemoteImageService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.dataDir = config.get('dataDir', { infer: true });
  }

  /**
   * Proxy an external image through the backend (disk-cached) so posters and
   * screenshots load even when the source CDN is unreachable from the client.
   *
   * The fetch itself reuses the configured RAWG proxy (see RemoteImageService),
   * which is what makes `media.rawg.io` / Steam CDN images load on a
   * China-mainland network.
   */
  @Get('proxy')
  async proxy(@Query('url') url: string, @Res() res: Response) {
    if (!url || !/^https?:\/\/\S+$/i.test(url)) {
      return res.status(400).send('invalid url');
    }
    const cacheDir = path.join(this.dataDir, 'proxied');
    const cached = await this.remoteImage.resolve(url).catch(() => null);
    if (!cached) return res.status(502).send('proxy fetch failed');
    // Long browser cache: the bytes for a given URL never change.
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    return this.streaming.stream(cached.path, cacheDir, undefined, res, cached.mime);
  }

  /** Serve the original media file with Range support (video scrubbing). */
  @Get(':id/stream')
  async stream(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const row = this.media.findById(id);
    await this.streaming.stream(
      row.file_path,
      path.parse(row.file_path).root,
      req.headers.range,
      res,
      row.mime_type,
    );
  }

  /** Serve the cached thumbnail (WebP; JXR sources are pre-transcoded). */
  @Get(':id/thumbnail')
  async thumbnail(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    // Thumbnails are immutable once generated (content is keyed by media id and
    // only ever written once), so let the browser reuse them instead of
    // re-downloading a whole grid on every dialog open. Without this header the
    // poster manager re-fetched every tile each time it was mounted.
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    const row = this.media.findById(id);
    let file = row.thumb_path
      ? path.join(this.dataDir, 'thumbnails', path.basename(row.thumb_path))
      : null;
    if (!file || !(await fs.pathExists(file))) {
      // Generate on demand (idempotent + disk-cached) instead of serving the
      // full original — keeps the grid fast even before the scan finishes.
      const generated = await this.processor.generateThumbnail(row.id, row.file_path, row.type);
      if (generated) file = path.join(this.dataDir, 'thumbnails', generated);
    }
    if (!file || !(await fs.pathExists(file))) {
      // Last resort: stream the original bytes.
      return this.streaming.stream(
        row.file_path,
        path.parse(row.file_path).root,
        req.headers.range,
        res,
        row.mime_type,
      );
    }
    return this.streaming.stream(file, path.join(this.dataDir, 'thumbnails'), req.headers.range, res, 'image/webp');
  }

  /** Serve the video cover (same-name image or first-frame extraction). */
  @Get(':id/cover')
  async cover(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    const row = this.media.findById(id);
    const file = row.cover_path
      ? path.join(this.dataDir, 'covers', path.basename(row.cover_path))
      : null;
    if (!file || !(await fs.pathExists(file))) {
      return this.thumbnail(id, req, res);
    }
    return this.streaming.stream(file, path.join(this.dataDir, 'covers'), req.headers.range, res, 'image/webp');
  }

  /**
   * Serve the original bytes (for "view original" in the viewer).
   *
   * Browsers cannot render JPEG XR, so for JXR family files we serve a
   * full-resolution WebP transcode instead of the raw file — otherwise
   * "查看原图" opens a permanently broken image.
   */
  @Get(':id/original')
  async original(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const row = this.media.findById(id);
    if (isJxrPath(row.file_path)) {
      const name = await this.processor.generatePreview(row.id, row.file_path, row.type);
      if (name) {
        return this.streaming.stream(
          path.join(this.processor.previewsDir, path.basename(name)),
          this.processor.previewsDir,
          req.headers.range,
          res,
          'image/webp',
        );
      }
      // Decode unavailable: report clearly instead of serving undecodable bytes.
      return res
        .status(415)
        .send('JXR 解码不可用，无法转换该图片（请检查服务端 jpegxr 模块）');
    }
    await this.streaming.stream(
      row.file_path,
      path.parse(row.file_path).root,
      req.headers.range,
      res,
      row.mime_type,
    );
  }

  /**
   * Browser-safe rendition for the lightbox: a wide WebP transcode.
   * Non-JXR images are served as-is (already browser-native).
   */
  @Get(':id/preview')
  async preview(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const row = this.media.findById(id);
    if (!isJxrPath(row.file_path)) {
      return this.streaming.stream(
        row.file_path,
        path.parse(row.file_path).root,
        req.headers.range,
        res,
        row.mime_type,
      );
    }
    const name = await this.processor.generatePreview(row.id, row.file_path, row.type, JXR_PREVIEW_WIDTH);
    if (!name) {
      // Fall back to the thumbnail so the viewer still shows something.
      return this.thumbnail(id, req, res);
    }
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    return this.streaming.stream(
      path.join(this.processor.previewsDir, path.basename(name)),
      this.processor.previewsDir,
      req.headers.range,
      res,
      'image/webp',
    );
  }

  /**
   * 删除一个媒体文件（安卓端相册「长按删除」的服务端支撑）。
   *
   * 受全局会话守卫保护：带凭证（Linux/Web 端会话 Cookie 或 Bearer）才能删；
   * Windows 桌面端以 `AUTH_DISABLED=1` 运行，天然无凭证即可删。返回 Nest 默认
   * 200 + JSON，与其它删除端点一致。
   */
  @Delete(':id')
  remove(@Param('id') id: string): Promise<object> {
    return this.media.remove(id);
  }
}