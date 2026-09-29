/**
 * In-process plugin registry.
 *
 * During bootstrap, `onModuleInit` discovers built-in plugin modules (or, in a
 * future iteration, loads compiled plugins from a directory). The scanner asks
 * this service whether any registered parser recognises a file so unsupported
 * formats can be handed off to custom parsers without touching core code.
 */

import { Injectable, Logger } from '@nestjs/common';
import { MediaParser, ParsedMedia, DataSource } from './plugin.interface';

@Injectable()
export class PluginsService {
  private readonly logger = new Logger(PluginsService.name);
  private readonly parsers: MediaParser[] = [];
  private readonly dataSources: DataSource[] = [];

  registerParser(parser: MediaParser): void {
    if (this.parsers.some((p) => p.id === parser.id)) {
      this.logger.warn(`Parser already registered: ${parser.id}`);
      return;
    }
    this.parsers.push(parser);
    this.logger.log(`Registered media parser "${parser.id}" (${parser.extensions.join(', ')})`);
  }

  registerDataSource(source: DataSource): void {
    if (this.dataSources.some((s) => s.id === source.id)) return;
    this.dataSources.push(source);
    this.logger.log(`Registered data source "${source.id}"`);
  }

  /** Find a parser that supports the given file, if any. */
  findParser(fileName: string): MediaParser | null {
    return this.parsers.find((p) => p.supports(fileName)) ?? null;
  }

  parse(fileName: string, filePath: string): Promise<ParsedMedia | null> {
    const parser = this.findParser(fileName);
    return parser ? parser.parse(filePath) : Promise.resolve(null);
  }

  listParsers(): string[] {
    return this.parsers.map((p) => p.id);
  }

  listDataSources(): string[] {
    return this.dataSources.map((d) => d.id);
  }
}