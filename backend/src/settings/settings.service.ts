/**
 * Runtime-persisted settings (API keys etc.).
 *
 * Values start from environment (compose/.env) on first boot and are then
 * stored in the SQLite `settings` table, editable from the web UI without
 * restarting the container. A value set via the UI always wins over env.
 *
 * Seeding is lazy (on first read) so it never races the DatabaseService's own
 * migration that creates the `settings` table.
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { DatabaseService } from '../database/database.service';

export interface ApiKeySettings {
  rawgApiKey: string;
  rawgProxy: string;
  igdbClientId: string;
  igdbClientSecret: string;
  steamApiKey: string;
  steamdbKey: string;
}

const KEYS = {
  rawgApiKey: 'api.rawg.apiKey',
  rawgProxy: 'api.rawg.proxy',
  igdbClientId: 'api.igdb.clientId',
  igdbClientSecret: 'api.igdb.clientSecret',
  steamApiKey: 'api.steam.apiKey',
  steamdbKey: 'api.steamdb.key',
} as const;

@Injectable()
export class SettingsService {
  private seeded = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  getValue(key: string): string {
    return (
      this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])
        ?.value ?? ''
    );
  }

  setValue(key: string, value: string): void {
    this.db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, Date.now()],
    );
  }

  getApiKeys(): ApiKeySettings {
    this.ensureSeeded();
    return {
      rawgApiKey: this.getValue(KEYS.rawgApiKey),
      rawgProxy: this.getValue(KEYS.rawgProxy),
      igdbClientId: this.getValue(KEYS.igdbClientId),
      igdbClientSecret: this.getValue(KEYS.igdbClientSecret),
      steamApiKey: this.getValue(KEYS.steamApiKey),
      steamdbKey: this.getValue(KEYS.steamdbKey),
    };
  }

  saveApiKeys(dto: Partial<ApiKeySettings>): ApiKeySettings {
    this.ensureSeeded();
    if (dto.rawgApiKey !== undefined) this.setValue(KEYS.rawgApiKey, dto.rawgApiKey.trim());
    if (dto.rawgProxy !== undefined) this.setValue(KEYS.rawgProxy, dto.rawgProxy.trim());
    if (dto.igdbClientId !== undefined) this.setValue(KEYS.igdbClientId, dto.igdbClientId.trim());
    if (dto.igdbClientSecret !== undefined) this.setValue(KEYS.igdbClientSecret, dto.igdbClientSecret.trim());
    if (dto.steamApiKey !== undefined) this.setValue(KEYS.steamApiKey, dto.steamApiKey.trim());
    if (dto.steamdbKey !== undefined) this.setValue(KEYS.steamdbKey, dto.steamdbKey.trim());
    return this.getApiKeys();
  }

  /** Seed from environment once, but never overwrite an existing UI edit. */
  private ensureSeeded(): void {
    if (this.seeded) return;
    this.seeded = true;

    const seed: Array<[string, string]> = [
      [KEYS.rawgApiKey, this.config.get('rawgApiKey', { infer: true })],
      [KEYS.rawgProxy, this.config.get('rawgProxy', { infer: true })],
      [KEYS.igdbClientId, this.config.get('igdbClientId', { infer: true })],
      [KEYS.igdbClientSecret, this.config.get('igdbClientSecret', { infer: true })],
      [KEYS.steamApiKey, this.config.get('steamApiKey', { infer: true })],
      [KEYS.steamdbKey, this.config.get('steamdbKey', { infer: true })],
    ];
    for (const [key, value] of seed) {
      if (!value) continue;
      const exists = this.db.get<{ key: string }>(
        'SELECT key FROM settings WHERE key = ?',
        [key],
      );
      if (!exists) this.setValue(key, value);
    }
  }
}