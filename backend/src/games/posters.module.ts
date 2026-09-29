/**
 * Poster feature module.
 *
 * Lives in its own module (rather than inside GamesModule) because
 * MetadataModule also needs PostersService to seed the scraped poster — and
 * GamesModule already imports MetadataModule. A shared module keeps the graph
 * acyclic.
 */

import { Module } from '@nestjs/common';
import { PostersController } from './posters.controller';
import { PostersService } from './posters.service';
import { MediaModule } from '../media/media.module';

@Module({
  imports: [MediaModule],
  controllers: [PostersController],
  providers: [PostersService],
  exports: [PostersService],
})
export class PostersModule {}