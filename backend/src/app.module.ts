import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { AppController } from './app.controller';
import { DatabaseModule } from './database/database.module';
import { HttpModule } from './common/http/http.module';
import { LibraryModule } from './library/library.module';
import { MediaModule } from './media/media.module';
import { GamesModule } from './games/games.module';
import { MetadataModule } from './metadata/metadata.module';
import { TrophiesModule } from './trophies/trophies.module';
import { PluginsModule } from './plugins/plugins.module';
import { SettingsModule } from './settings/settings.module';
import { AuthModule } from './auth/auth.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { AuthGuard } from './auth/auth.guard';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: ['.env', '../.env'],
    }),
    DatabaseModule,
    HttpModule,
    PluginsModule,
    MediaModule,
    LibraryModule,
    MetadataModule,
    TrophiesModule,
    SettingsModule,
    GamesModule,
    AuthModule,
    // Boot-time data repairs (poster rotation top-up, completion-time backfill).
    // Last on purpose: it drives the other modules' services and must observe the
    // library scan those modules start.
    MaintenanceModule,
  ],
  controllers: [AppController],
  providers: [
    // Global session guard. It no-ops when AUTH_DISABLED=1, and always lets
    // /api/health and the auth endpoints through.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}