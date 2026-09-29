/**
 * 媒体评价 (critic reviews) feature module.
 *
 * A shared module rather than a provider on GamesModule, for the same reason
 * PostersModule is one: MetadataModule needs the service to persist scraped
 * reviews, and GamesModule already imports MetadataModule. A module both can
 * import keeps the dependency graph acyclic.
 */

import { Module } from '@nestjs/common';
import { MediaReviewsService } from './media-reviews.service';

@Module({
  providers: [MediaReviewsService],
  exports: [MediaReviewsService],
})
export class MediaReviewsModule {}