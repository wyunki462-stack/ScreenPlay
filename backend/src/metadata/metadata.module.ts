import { Module } from '@nestjs/common';
import { MetadataService, METADATA_PROVIDERS } from './metadata.service';
import { MetadataCacheService } from '../common/cache/metadata-cache.service';
import { HltbProvider } from './providers/hltb.provider';
import { RawgProvider } from './providers/rawg.provider';
import { SteamProvider } from './providers/steam.provider';
import { MetacriticProvider } from './providers/metacritic.provider';
import { MetadataProvider } from './provider.interface';
import { LibraryModule } from '../library/library.module';
import { PostersModule } from '../games/posters.module';
import { MediaReviewsModule } from '../games/media-reviews.module';
import { TrophiesModule } from '../trophies/trophies.module';
import { RatingTargetService } from './rating-target.service';

/**
 * Register every enabled provider. Extending ScreenPlay with a new data source
 * is as simple as implementing `MetadataProvider` and adding it to this array.
 *
 * Order matters for the aggregator: a provider earlier in the list "wins" when
 * two sources contribute the same scalar (e.g. HLTB's granular playtime wins
 * over RAWG's single average). RAWG is the primary multi-platform source.
 */
@Module({
  imports: [LibraryModule, PostersModule, TrophiesModule, MediaReviewsModule],
  providers: [
    MetadataService,
    MetadataCacheService,
    RatingTargetService,
    HltbProvider,
    RawgProvider,
    SteamProvider,
    MetacriticProvider,
    {
      provide: METADATA_PROVIDERS,
      useFactory: (
        hltb: HltbProvider,
        rawg: RawgProvider,
        steam: SteamProvider,
        metacritic: MetacriticProvider,
      ): MetadataProvider[] => [hltb, rawg, steam, metacritic],
      inject: [HltbProvider, RawgProvider, SteamProvider, MetacriticProvider],
    },
  ],
  exports: [MetadataService, RatingTargetService],
})
export class MetadataModule {}