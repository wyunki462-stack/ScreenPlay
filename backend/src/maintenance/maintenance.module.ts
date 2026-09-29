import { Module } from '@nestjs/common';
import { MaintenanceService } from './maintenance.service';
import { LibraryModule } from '../library/library.module';
import { GamesModule } from '../games/games.module';
import { PostersModule } from '../games/posters.module';

/**
 * Boot-time data repairs (see `MaintenanceService`).
 *
 * Imports the modules whose services it drives rather than re-providing them, so
 * it operates on the SAME singleton instances the rest of the app uses — a
 * second `PostersService` would hold its own database handle and its own
 * `nextOrder()` bookkeeping. `SettingsService` comes from the global
 * `SettingsModule`, and `DatabaseService` from the global `DatabaseModule`.
 */
@Module({
  imports: [LibraryModule, GamesModule, PostersModule],
  providers: [MaintenanceService],
})
export class MaintenanceModule {}