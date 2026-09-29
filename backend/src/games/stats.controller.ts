import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Controller('api/stats')
export class StatsController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  stats(): Record<string, unknown> {
    const media = this.db.get<{ c: number; totalSize: number }>(
      'SELECT COUNT(*) AS c, COALESCE(SUM(size_bytes), 0) AS totalSize FROM media',
    );
    const images = this.db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM media WHERE type IN ('image','gif')`,
    );
    const videos = this.db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM media WHERE type = 'video'`,
    );
    const play = this.db.get<{ total: number }>(
      'SELECT COALESCE(SUM(duration_seconds), 0) AS total FROM games',
    );

    // Platform counts must honour the user-set multi-platform lists
    // (feature 6): a game tagged with two platforms counts once in each.
    const rows = this.db.all<{ platform: string | null; platforms: string | null; c: number }>(
      'SELECT platform, platforms, COUNT(*) AS c FROM games GROUP BY platform, platforms',
    );
    const platforms: Record<string, number> = {};
    let totalGames = 0;
    for (const r of rows) {
      totalGames += r.c;
      let list: string[] = [];
      try {
        const parsed: unknown = JSON.parse(r.platforms ?? '[]');
        if (Array.isArray(parsed)) list = parsed.filter((p): p is string => typeof p === 'string');
      } catch {
        list = [];
      }
      if (list.length === 0 && r.platform) list = [r.platform];
      if (list.length === 0) {
        platforms['未知'] = (platforms['未知'] ?? 0) + r.c;
        continue;
      }
      for (const p of list) platforms[p] = (platforms[p] ?? 0) + r.c;
    }

    return {
      totalGames,
      totalMedia: media?.c ?? 0,
      totalImages: images?.c ?? 0,
      totalVideos: videos?.c ?? 0,
      totalSizeBytes: media?.totalSize ?? 0,
      totalPlayTimeSeconds: play?.total ?? 0,
      platforms,
    };
  }
}