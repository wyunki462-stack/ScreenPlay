/**
 * Media read model: DB-backed listing plus URL resolution.
 *
 * Media rows are written by the scan worker; this service exposes them as API
 * DTOs (with stable `/api/media/:id/...` URLs) to the games controller and the
 * media streaming controller.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { MediaType } from './media-types';

export interface MediaRow {
  id: string;
  game_id: string;
  file_name: string;
  file_path: string;
  type: MediaType;
  mime_type: string;
  width: number | null;
  height: number | null;
  size_bytes: number;
  file_created_at: number | null;
  duration_seconds: number | null;
  thumb_path: string | null;
  cover_path: string | null;
  sort_order: number;
}

export interface MediaDto {
  id: string;
  gameId: string;
  fileName: string;
  type: MediaType;
  mimeType: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  createdAt: string | null;
  durationSeconds: number | null;
  streamUrl: string;
  thumbnailUrl: string;
  /** Browser-safe rendition for the lightbox (JXR sources are transcoded). */
  previewUrl: string;
  coverUrl: string | null;
}

@Injectable()
export class MediaService {
  constructor(private readonly db: DatabaseService) {}

  listByGame(gameId: string): MediaDto[] {
    const rows = this.db.all<MediaRow>(
      `SELECT * FROM media WHERE game_id = ? ORDER BY sort_order ASC, file_created_at ASC`,
      [gameId],
    );
    return rows.map((r) => this.toDto(r));
  }

  findById(id: string): MediaRow {
    const row = this.db.get<MediaRow>('SELECT * FROM media WHERE id = ?', [id]);
    if (!row) throw new NotFoundException('Media not found');
    return row;
  }

  countByGame(gameId: string): number {
    const row = this.db.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM media WHERE game_id = ?',
      [gameId],
    );
    return row?.c ?? 0;
  }

  toDto(row: MediaRow): MediaDto {
    return {
      id: row.id,
      gameId: row.game_id,
      fileName: row.file_name,
      type: row.type,
      mimeType: row.mime_type,
      width: row.width,
      height: row.height,
      sizeBytes: row.size_bytes,
      createdAt: row.file_created_at
        ? new Date(row.file_created_at).toISOString()
        : null,
      durationSeconds: row.duration_seconds ?? null,
      streamUrl: `/api/media/${row.id}/stream`,
      thumbnailUrl: `/api/media/${row.id}/thumbnail`,
      previewUrl: `/api/media/${row.id}/preview`,
      coverUrl: row.cover_path ? `/api/media/${row.id}/cover` : null,
    };
  }
}