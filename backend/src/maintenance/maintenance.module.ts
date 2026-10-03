import { Module } from '@nestjs/common';
import { MaintenanceService } from './maintenance.service';
import { LibraryModule } from '../library/library.module';
import { GamesModule } from '../games/games.module';
import { MetadataModule } from '../metadata/metadata.module';
/**
 * Boot-time data repairs (see `MaintenanceService`).
 *
 * Imports the modules whose services it drives rather than re-providing them, so
 * it operates on the SAME singleton instances the rest of the app uses — a
 * second `GamesService`/`LibraryService` would hold its own database handle and
 * its own scan state. `SettingsService` comes from the global `SettingsModule`,
 * and `DatabaseService` from the global `DatabaseModule`.
 *
 * `MetadataModule` is here for `MetadataCacheService.prune()`, which the
 * housekeeping pass calls: it is the only way to drop expired provider responses
 * from `metadata_cache`, and it must be the same instance the providers wrote to.
 *
 * `PostersModule` used to be here for the boot-time cover repair; that repair is
 * gone (the cover is structural now), so the import went with it.
 */
@Module({
  imports: [LibraryModule, GamesModule, MetadataModule],
  providers: [MaintenanceService],
})
export class MaintenanceModule {}