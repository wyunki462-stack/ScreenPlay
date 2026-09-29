import { Global, Module } from '@nestjs/common';
import { PluginsService } from './plugins.service';

@Global()
@Module({
  providers: [PluginsService],
  exports: [PluginsService],
})
export class PluginsModule {}