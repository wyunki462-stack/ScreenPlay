import { Module } from '@nestjs/common';
import { GamesController } from './games.controller';
import { GamesService } from './games.service';
import { PostersModule } from './posters.module';
import { MediaReviewsModule } from './media-reviews.module';
import { AchievementsController } from './achievements.controller';
import { StatsController } from './stats.controller';
import { MediaModule } from '../media/media.module';
import { MetadataModule } from '../metadata/metadata.module';
import { TrophiesModule } from '../trophies/trophies.module';

@Module({
  imports: [MediaModule, MetadataModule, PostersModule, TrophiesModule, MediaReviewsModule],
  controllers: [GamesController, AchievementsController, StatsController],
  providers: [GamesService],
  // Exported for MaintenanceService, which drives a completion-time backfill at
  // boot. Exporting the singleton keeps the bulk-job progress state shared, so the
  // settings page sees the same job the boot repair started.
  exports: [GamesService],
})
export class GamesModule {}