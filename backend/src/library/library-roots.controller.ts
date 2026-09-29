/**
 * Media library management API (add / edit / delete roots from the web UI).
 *
 * Adding a root takes effect immediately — the next scan picks it up with no
 * container rebuild. Paths must already be mounted into the container.
 */

import { Body, Controller, Delete, Get, Patch, Post, Query } from '@nestjs/common';
import { LibraryRootsService, SaveRootInput } from './library-roots.service';
import { LibraryService } from './library.service';

@Controller('api/library/roots')
export class LibraryRootsController {
  constructor(
    private readonly roots: LibraryRootsService,
    private readonly library: LibraryService,
  ) {}

  /** List every configured root (env + user managed). */
  @Get()
  list(): Promise<object[]> {
    return this.roots.list();
  }

  /** Directories available inside the container (helps pick a mount). */
  @Get('mounted')
  mounted(): Promise<{ paths: string[] }> {
    return this.roots.mountedRoots().then((paths) => ({ paths }));
  }

  /** Validate a path before saving. */
  @Get('check')
  check(@Query('path') path: string): Promise<object> {
    return this.roots.check(path ?? '');
  }

  /** Add a root. Optionally trigger a scan right away. */
  @Post()
  async add(
    @Body() body: SaveRootInput & { scan?: boolean },
  ): Promise<{ root: object; scanStarted: boolean }> {
    const root = await this.roots.add(body);
    let scanStarted = false;
    if (body.scan !== false) {
      this.library.startScan();
      scanStarted = true;
    }
    return { root, scanStarted };
  }

  @Patch()
  async update(
    @Body() body: SaveRootInput & { id: string; scan?: boolean },
  ): Promise<{ root: object; scanStarted: boolean }> {
    const root = await this.roots.update(body.id, body);
    let scanStarted = false;
    if (body.scan) {
      this.library.startScan();
      scanStarted = true;
    }
    return { root, scanStarted };
  }

  @Delete()
  remove(@Query('id') id: string): { removed: boolean; note?: string } {
    return this.roots.remove(id ?? '');
  }
}