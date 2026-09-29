import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { LibraryController } from './library.controller';
import { LibraryRootsController } from './library-roots.controller';
import { LibraryService } from './library.service';
import { LibraryRootsService } from './library-roots.service';
import { GameRecognizerService } from './game-recognizer.service';

@Module({
  imports: [MediaModule],
  controllers: [LibraryController, LibraryRootsController],
  // GameRecognizerService is exported for the metadata matcher too.
  providers: [LibraryService, LibraryRootsService, GameRecognizerService],
  exports: [LibraryService, LibraryRootsService, GameRecognizerService],
})
export class LibraryModule {}