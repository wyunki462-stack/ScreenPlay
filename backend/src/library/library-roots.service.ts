/**
 * User-managed media library roots.
 *
 * Roots added through the web UI are persisted in SQLite (so they survive
 * container rebuilds) and merged with MEDIA_DIRS from the environment. Env roots
 * are read-only here (they cannot be deleted from the UI, only disabled) which
 * keeps the compose file authoritative for anything declared there.
 *
 * Deleting a root row never touches files on disk.
 */

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import fs from 'fs-extra';
import path from 'path';
import { v5 as uuidv5 } from 'uuid';
import { AppConfig } from '../config/configuration';
import { DatabaseService } from '../database/database.service';

const UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/** Media-type filter applied while scanning a root. */
export type RootMediaType = 'auto' | 'image' | 'video';

export interface LibraryRoot {
  id: string;
  path: string;
  label: string | null;
  mediaType: RootMediaType;
  recursive: boolean;
  enabled: boolean;
  sortOrder: number;
  /** 'env' roots come from MEDIA_DIRS and cannot be deleted from the UI. */
  source: 'env' | 'user';
  createdAt: string | null;
  exists: boolean;
  gameCount: number | null;
}

interface RootRow {
  id: string;
  path: string;
  label: string | null;
  media_type: string;
  recursive: number;
  enabled: number;
  sort_order: number;
  created_at: number;
}

export interface SaveRootInput {
  path?: string;
  label?: string | null;
  mediaType?: string;
  recursive?: boolean;
  enabled?: boolean;
}

const MEDIA_TYPES: RootMediaType[] = ['auto', 'image', 'video'];

@Injectable()
export class LibraryRootsService {
  private readonly logger = new Logger(LibraryRootsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /** Environment-declared roots (MEDIA_DIRS), always present. */
  private envRoots(): string[] {
    return this.config.get('mediaDirs', { infer: true });
  }

  /** Every root row currently in the database. */
  private rows(): RootRow[] {
    return this.db.all<RootRow>(
      'SELECT * FROM library_roots ORDER BY sort_order ASC, created_at ASC',
    );
  }

  /** All enabled roots that actually exist on disk — what the scanner walks. */
  async activeRoots(): Promise<{ path: string; mediaType: RootMediaType; recursive: boolean }[]> {
    const out: { path: string; mediaType: RootMediaType; recursive: boolean }[] = [];
    const seen = new Set<string>();

    // Env roots first, then user roots.
    for (const p of this.envRoots()) {
      const norm = path.resolve(p);
      if (seen.has(norm)) continue;
      if (!(await fs.pathExists(norm))) continue;
      seen.add(norm);
      out.push({ path: norm, mediaType: 'auto', recursive: true });
    }
    for (const r of this.rows()) {
      if (!r.enabled) continue;
      const norm = path.resolve(r.path);
      if (seen.has(norm)) continue;
      if (!(await fs.pathExists(norm))) continue;
      seen.add(norm);
      out.push({
        path: norm,
        mediaType: (MEDIA_TYPES.includes(r.media_type as RootMediaType)
          ? (r.media_type as RootMediaType)
          : 'auto'),
        recursive: !!r.recursive,
      });
    }
    return out;
  }

  /** Full list for the UI (env roots synthesised + user rows). */
  async list(): Promise<LibraryRoot[]> {
    const out: LibraryRoot[] = [];
    const userRows = this.rows();
    const userPaths = new Set(userRows.map((r) => path.resolve(r.path)));

    for (const p of this.envRoots()) {
      const norm = path.resolve(p);
      // A user row for the same path wins (it carries the user's settings).
      if (userPaths.has(norm)) continue;
      out.push({
        id: `env:${norm}`,
        path: norm,
        label: null,
        mediaType: 'auto',
        recursive: true,
        enabled: true,
        sortOrder: -1,
        source: 'env',
        createdAt: null,
        exists: await fs.pathExists(norm),
        gameCount: null,
      });
    }

    for (const r of userRows) {
      out.push({
        id: r.id,
        path: path.resolve(r.path),
        label: r.label,
        mediaType: (MEDIA_TYPES.includes(r.media_type as RootMediaType)
          ? (r.media_type as RootMediaType)
          : 'auto'),
        recursive: !!r.recursive,
        enabled: !!r.enabled,
        sortOrder: r.sort_order,
        source: 'user',
        createdAt: new Date(r.created_at).toISOString(),
        exists: await fs.pathExists(r.path),
        gameCount: await this.countGames(r.path),
      });
    }
    return out;
  }

  /** Number of game folders directly under a root (cheap, best-effort). */
  private async countGames(root: string): Promise<number | null> {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).length;
    } catch {
      return null;
    }
  }

  async add(input: SaveRootInput): Promise<LibraryRoot> {
    const raw = (input.path ?? '').trim();
    if (!raw) throw new BadRequestException('请填写媒体库路径');
    if (!path.isAbsolute(raw)) {
      throw new BadRequestException('路径必须是绝对路径（例如 /media/游戏相册）');
    }
    const resolved = path.resolve(raw);

    // Must exist and be a directory, otherwise the scan would silently skip it.
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat) {
      throw new BadRequestException(
        `路径不存在或不可访问：${resolved}。请确认它已挂载进容器（docker-compose 的 volumes）。`,
      );
    }
    if (!stat.isDirectory()) {
      throw new BadRequestException(`路径不是目录：${resolved}`);
    }

    const dup = this.db.get<{ id: string }>('SELECT id FROM library_roots WHERE path = ?', [resolved]);
    if (dup) throw new BadRequestException('该路径已在媒体库列表中');

    const id = uuidv5(`root:${resolved}`, UUID_NAMESPACE);
    const now = Date.now();
    const maxOrder =
      this.db.get<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM library_roots')?.m ?? 0;

    this.db.run(
      `INSERT INTO library_roots
         (id, path, label, media_type, recursive, enabled, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        resolved,
        (input.label ?? '').trim() || null,
        this.normalizeType(input.mediaType),
        input.recursive === false ? 0 : 1,
        input.enabled === false ? 0 : 1,
        maxOrder + 1,
        now,
        now,
      ],
    );
    this.logger.log(`Added library root: ${resolved}`);
    const created = (await this.list()).find((r) => r.id === id);
    return created!;
  }

  async update(id: string, input: SaveRootInput): Promise<LibraryRoot> {
    const row = this.db.get<RootRow>('SELECT * FROM library_roots WHERE id = ?', [id]);
    if (!row) throw new NotFoundException('媒体库不存在');

    const changes: string[] = [];
    const params: unknown[] = [];

    if (input.path !== undefined) {
      const raw = input.path.trim();
      if (!path.isAbsolute(raw)) throw new BadRequestException('路径必须是绝对路径');
      const resolved = path.resolve(raw);
      const stat = await fs.stat(resolved).catch(() => null);
      if (!stat?.isDirectory()) throw new BadRequestException(`路径不存在或不是目录：${resolved}`);
      const dup = this.db.get<{ id: string }>(
        'SELECT id FROM library_roots WHERE path = ? AND id != ?',
        [resolved, id],
      );
      if (dup) throw new BadRequestException('该路径已在媒体库列表中');
      changes.push('path = ?');
      params.push(resolved);
    }
    if (input.label !== undefined) {
      changes.push('label = ?');
      params.push((input.label ?? '').trim() || null);
    }
    if (input.mediaType !== undefined) {
      changes.push('media_type = ?');
      params.push(this.normalizeType(input.mediaType));
    }
    if (input.recursive !== undefined) {
      changes.push('recursive = ?');
      params.push(input.recursive ? 1 : 0);
    }
    if (input.enabled !== undefined) {
      changes.push('enabled = ?');
      params.push(input.enabled ? 1 : 0);
    }

    if (changes.length) {
      changes.push('updated_at = ?');
      params.push(Date.now(), id);
      this.db.run(`UPDATE library_roots SET ${changes.join(', ')} WHERE id = ?`, params);
    }
    const updated = (await this.list()).find((r) => r.id === id);
    return updated!;
  }

  /** Remove a user root. Files on disk are never deleted. */
  remove(id: string): { removed: boolean; note?: string } {
    if (id.startsWith('env:')) {
      throw new BadRequestException(
        '该媒体库来自环境变量 MEDIA_DIRS，无法在此删除；请修改 docker-compose.yml，或在列表中将其停用。',
      );
    }
    const row = this.db.get<RootRow>('SELECT * FROM library_roots WHERE id = ?', [id]);
    if (!row) throw new NotFoundException('媒体库不存在');
    this.db.run('DELETE FROM library_roots WHERE id = ?', [id]);
    this.logger.log(`Removed library root: ${row.path}`);
    return { removed: true, note: '媒体库条目已移除，磁盘文件未做任何改动' };
  }

  /**
   * Validate a path without saving — used by the UI's "检查路径" button so the
   * user gets feedback before committing (e.g. a host path not mounted yet).
   */
  async check(rawPath: string): Promise<{
    ok: boolean;
    path: string;
    exists: boolean;
    isDirectory: boolean;
    readable: boolean;
    subdirectories: number | null;
    sampleNames: string[];
    mountedHint: string[];
    message: string;
  }> {
    const raw = (rawPath ?? '').trim();
    const mountedHint = await this.mountedRoots();
    if (!raw || !path.isAbsolute(raw)) {
      return {
        ok: false,
        path: raw,
        exists: false,
        isDirectory: false,
        readable: false,
        subdirectories: null,
        sampleNames: [],
        mountedHint,
        message: '请填写绝对路径（例如 /media/游戏相册）',
      };
    }
    const resolved = path.resolve(raw);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat) {
      return {
        ok: false,
        path: resolved,
        exists: false,
        isDirectory: false,
        readable: false,
        subdirectories: null,
        sampleNames: [],
        mountedHint,
        message:
          `容器内不存在该路径。若这是宿主机目录，需先在 docker-compose.yml 的 volumes 中挂载` +
          `（例如 "/host/path/to/game-albums:/media/games:ro"）并重建容器。`,
      };
    }
    if (!stat.isDirectory()) {
      return {
        ok: false,
        path: resolved,
        exists: true,
        isDirectory: false,
        readable: false,
        subdirectories: null,
        sampleNames: [],
        mountedHint,
        message: '该路径是文件而不是目录',
      };
    }
    let names: string[] = [];
    let readable = true;
    try {
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      readable = false;
    }
    return {
      ok: readable,
      path: resolved,
      exists: true,
      isDirectory: true,
      readable,
      subdirectories: readable ? names.length : null,
      sampleNames: names.slice(0, 8),
      mountedHint,
      message: readable
        ? `路径可用：发现 ${names.length} 个子文件夹（每个子文件夹视为一款游戏）`
        : '路径存在但不可读取，请检查挂载权限',
    };
  }

  /** Top-level directories inside the container, to help the user find mounts. */
  async mountedRoots(): Promise<string[]> {
    const out: string[] = [];
    for (const base of ['/media', '/data', '/mnt', '/vol2']) {
      if (!(await fs.pathExists(base))) continue;
      try {
        const entries = await fs.readdir(base, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory() && out.length < 20) out.push(path.join(base, e.name));
        }
      } catch {
        /* ignore */
      }
    }
    return out;
  }

  private normalizeType(v: string | undefined): RootMediaType {
    return MEDIA_TYPES.includes(v as RootMediaType) ? (v as RootMediaType) : 'auto';
  }
}