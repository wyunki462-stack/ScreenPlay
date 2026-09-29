import { Controller, Get, Post } from '@nestjs/common';
import { LibraryService } from './library.service';

@Controller('api/library')
export class LibraryController {
  constructor(private readonly library: LibraryService) {}

  /** Trigger a background (re)scan. */
  @Post('scan')
  scan(): { started: boolean } {
    this.library.startScan();
    return { started: true };
  }

  @Get('status')
  status(): ReturnType<LibraryService['status']> {
    return this.library.status();
  }
}