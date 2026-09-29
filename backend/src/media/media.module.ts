import { Module, OnModuleInit } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { MediaProcessorService } from './media-processor.service';
import { StreamingService } from './streaming.service';

@Module({
  controllers: [MediaController],
  providers: [MediaService, MediaProcessorService, StreamingService],
  // LibraryModule uses these to (re)generate thumbnails while scanning.
  exports: [MediaService, MediaProcessorService, StreamingService],
})
export class MediaModule implements OnModuleInit {
  constructor(private readonly processor: MediaProcessorService) {}

  onModuleInit(): void {
    this.processor.prepareDirs();
  }
}