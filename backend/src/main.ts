/**
 * ScreenPlay backend entrypoint.
 *
 * - Boots NestJS with global configuration + validation.
 * - Serves the built Web frontend (SPA) when a bundle is present (Docker).
 * - Kicks off an initial library scan so data appears without manual action.
 */

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { AppConfig } from './config/configuration';
import { precompressedStatic } from './common/http/precompressed-static';
import { LibraryService } from './library/library.service';
import fs from 'fs-extra';
import path from 'path';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Let Express set bodies; needed for file streaming endpoints.
  });

  const config = app.get(ConfigService<AppConfig, true>);

  // Start the initial scan BEFORE listening.
  //
  // This ordering is load-bearing, not cosmetic. `NestFactory.create()` has
  // already run every `onApplicationBootstrap` hook by the time it returns, so
  // `MaintenanceService` is now waiting for the scan to finish before it repairs
  // anything. If the scan were still only started after `listen()` (where it
  // used to be), `isScanning()` would be false at that moment and the repair
  // would see an empty library and correctly conclude "nothing to repair" — the
  // whole feature would silently do nothing on every boot.
  //
  // Idempotent and fire-and-forget either way: it never blocks the port binding.
  app.get(LibraryService).startScan();

  app.setGlobalPrefix('', { exclude: [] });
  app.enableCors({
    origin: config.get('corsOrigins', { infer: true }),
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Serve the Web frontend if its production bundle is present (Docker mode).
  const webDist = process.env.WEB_DIST || path.join(process.cwd(), 'public');
  if (fs.pathExistsSync(path.join(webDist, 'index.html'))) {
    // Pre-compressed variants first (see `precompressedStatic`): when the build
    // produced `*.br`/`*.gz` siblings, the ~626 KB bundle is delivered as ~172 KB
    // without any per-request compression work. Falls through to the static
    // handler below when a variant is absent, so this is purely additive.
    app.use(precompressedStatic(webDist));

    app.useStaticAssets(webDist, {
      // Vite names everything under /assets/ with a content hash, so those files
      // can be cached forever — a rebuild produces a new name. They used to go out
      // as `max-age=0` (Express's default), which re-validated both bundle files on
      // every navigation. Everything else (index.html, favicon.svg) must be
      // revalidated, otherwise a redeploy would be invisible until a hard refresh.
      setHeaders: (res, filePath) => {
        const hashed = `${path.sep}assets${path.sep}`;
        res.setHeader(
          'Cache-Control',
          filePath.includes(hashed) ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
    // SPA fallback for client-side routes (everything except /api).
    const express = app.getHttpAdapter().getInstance() as {
      use: (handler: (req: Request, res: Response, next: NextFunction) => void) => void;
    };
    express.use((req, res, next) => {
      if (
        req.method === 'GET' &&
        !req.path.startsWith('/api') &&
        req.accepts('html')
      ) {
        res.sendFile(path.join(webDist, 'index.html'));
      } else {
        next();
      }
    });
    Logger.log(`Serving Web frontend from ${webDist}`, 'Bootstrap');
  }

  const port = config.get('port', { infer: true });
  // Bind explicitly to 0.0.0.0 so the container is reachable through Docker's
  // published port from the host and the LAN. Without a host argument Nest
  // listens on the wildcard anyway, but stating it removes any doubt and makes
  // an accidental HOST override impossible to get wrong.
  const host = process.env.HOST || '0.0.0.0';
  await app.listen(port, host);

  // Startup diagnostics: these three lines are what make "container says
  // Started but nothing answers" diagnosable from `docker compose logs`.
  const uptime = process.uptime();
  Logger.log(`ScreenPlay backend listening on http://${host}:${port}`, 'Bootstrap');
  Logger.log(
    `Runtime proxy: ${config.get('rawgProxy', { infer: true }) || '(none — direct)'}`,
    'Bootstrap',
  );
  Logger.log(
    `Data dir: ${config.get('dataDir', { infer: true })} | Media dirs: ` +
      `${(config.get('mediaDirs', { infer: true }) || []).join(', ') || '(none)'}`,
    'Bootstrap',
  );
  Logger.log(`Ready after ${uptime.toFixed(1)}s (health: /api/health)`, 'Bootstrap');
}

void bootstrap();