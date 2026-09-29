/**
 * Poster API: upload / pick from album / select / slideshow / delete.
 *
 * Uploads use multipart/form-data (field name `file`). No extra dependency is
 * needed — Nest's FileInterceptor is backed by multer, already present through
 * @nestjs/platform-express.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import path from 'path';
import { PostersService } from './posters.service';
import { StreamingService } from '../media/streaming.service';

@Controller('api')
export class PostersController {
  constructor(
    private readonly posters: PostersService,
    private readonly streaming: StreamingService,
  ) {}

  /** Posters of a game (selected first). */
  @Get('games/:id/posters')
  list(@Param('id') id: string): object[] {
    return this.posters.list(id);
  }

  /** Upload a local file as a poster. */
  @Post('games/:id/posters/upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  async upload(
    @Param('id') id: string,
    @UploadedFile() file?: { buffer: Buffer; originalname?: string },
  ): Promise<object> {
    if (!file) throw new BadRequestException('未收到上传文件（字段名应为 file）');
    return { poster: await this.posters.upload(id, file) };
  }

  /** Use an existing album image of this game as a poster. */
  @Post('games/:id/posters/from-media')
  async fromMedia(
    @Param('id') id: string,
    @Body() body: { mediaId: string },
  ): Promise<object> {
    if (!body?.mediaId) throw new BadRequestException('缺少 mediaId');
    return { poster: await this.posters.addFromMedia(id, body.mediaId) };
  }

  /** Choose which poster is the gallery cover. */
  @Post('games/:id/posters/select')
  select(@Param('id') id: string, @Body() body: { posterId: string }): Promise<object> {
    if (!body?.posterId) throw new BadRequestException('缺少 posterId');
    return this.posters.select(id, body.posterId);
  }

  /** Cancel the user's cover choice and restore the official default poster. */
  @Post('games/:id/posters/clear-selection')
  clearSelection(@Param('id') id: string): object {
    return this.posters.clearSelection(id);
  }

  /**
   * Repair a cover whose `is_selected` flag was never written, so the UI offers
   * the cancel entry again. Also runs automatically inside `list()`; exposed so
   * an operator can heal a whole library in one pass.
   */
  @Post('games/:id/posters/reconcile')
  reconcile(@Param('id') id: string): { repaired: boolean } {
    return { repaired: this.posters.reconcileSelection(id) };
  }

  /** Include/exclude a poster from the slideshow. */
  @Patch('games/:id/posters/:posterId')
  slideshow(
    @Param('id') id: string,
    @Param('posterId') posterId: string,
    @Body() body: { inSlideshow: boolean },
  ): object {
    return this.posters.setSlideshow(id, posterId, !!body?.inSlideshow);
  }

  @Delete('games/:id/posters/:posterId')
  remove(@Param('id') id: string, @Param('posterId') posterId: string): Promise<object> {
    return this.posters.remove(id, posterId);
  }

  /** Serve an uploaded poster image. */
  @Get('posters/:posterId/image')
  async image(@Param('posterId') posterId: string, @Res() res: Response) {
    const file = this.posters.uploadPath(posterId);
    res.setHeader('Cache-Control', 'public, max-age=604800');
    return this.streaming.stream(file, path.dirname(file), undefined, res, 'image/webp');
  }
}