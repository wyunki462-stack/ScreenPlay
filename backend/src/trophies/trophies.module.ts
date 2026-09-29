/**
 * PlayStation trophy scraping.
 *
 * `TrophiesService` walks the injected sources in order and falls back to the next
 * one when a source cannot find the game or fails. Adding a site means writing a
 * `TrophySource` and listing it here — nothing else changes.
 */

import { Module } from '@nestjs/common';
import { LibraryModule } from '../library/library.module';
import { TrophiesService } from './trophies.service';
import { PsnineTrophySource } from './psnine.source';
import { TROPHY_SOURCES, TrophySource } from './trophy-source.interface';
import { AchievementTargetService } from './achievement-target.service';

@Module({
  imports: [LibraryModule],
  providers: [
    PsnineTrophySource,
    {
      provide: TROPHY_SOURCES,
      // Order matters: the first source that answers wins.
      useFactory: (psnine: PsnineTrophySource): TrophySource[] => [psnine],
      inject: [PsnineTrophySource],
    },
    TrophiesService,
    AchievementTargetService,
  ],
  exports: [TrophiesService, AchievementTargetService],
})
export class TrophiesModule {}