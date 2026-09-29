/**
 * Plugin extension points (P3).
 *
 * ScreenPlay supports two kinds of third-party extensions:
 *   1. `MediaParser`   — add support for new media file formats.
 *   2. `DataSource`    — add a new metadata source.
 *
 * Both are plain TypeScript interfaces. A plugin implements one (or both),
 * registers with the `PluginsService` at bootstrap, and the core scanner /
 * aggregator consults the registry automatically.
 */

import { MediaType } from '../media/media-types';

/** A decoded/parsed media asset handed back to the core pipeline. */
export interface ParsedMedia {
  type: MediaType;
  mimeType: string;
  width?: number;
  height?: number;
  /** Optional millisecond creation time override. */
  createdAtMs?: number;
}

/**
 * Custom media parser: teach ScreenPlay a new file extension.
 * `supports` gates by file name/extension; `parse` inspects a file and returns
 * its dimensions/type. Thumbnail generation uses the return of `parse`.
 */
export interface MediaParser {
  readonly id: string;
  readonly extensions: string[];
  supports(fileName: string): boolean;
  parse(filePath: string): Promise<ParsedMedia>;
}

/** A metadata source contributed by a plugin (see MetadataProvider SPI). */
export interface DataSource {
  readonly id: string;
  readonly enabled: boolean;
  /* Define per-source methods here; the core MetadataService consumes the
     MetadataProvider SPI in metadata/provider.interface.ts. Plugins may simply
     re-export that interface under a different id. */
  readonly description: string;
}