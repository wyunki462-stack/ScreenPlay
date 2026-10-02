import { Module } from '@nestjs/common';
import { MaintenanceService } from './maintenance.service';
import { LibraryModule } from '../library/library.module';
import { GamesModule } from '../games/games.module';
/**
 * Boot-time data repairs (see `MaintenanceService`).
 *
 * Imports the modules whose services it drives rather than re-providing them, so
 * it operates on the SAME singleton instances the rest of the app uses — a
 * second `GamesService`/`LibraryService` would hold its own database handle and
 * its own scan state. `SettingsService` comes from the global `SettingsModule`,
 * and `DatabaseService` from the global `DatabaseModule`.
 *
 * `PostersModule` used to be here for the boot-time cover repair; that repair is
 * gone (the cover is structural now), so the import went with it.
 */
@Module({
  imports: [LibraryModule, GamesModule],
  providers: [MaintenanceService],
})
export class MaintenanceModule {}