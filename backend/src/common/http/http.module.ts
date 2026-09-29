import { Global, Module } from '@nestjs/common';
import { HttpService } from './http.service';
import { RemoteImageService } from './remote-image.service';

@Global()
@Module({
  providers: [HttpService, RemoteImageService],
  exports: [HttpService, RemoteImageService],
})
export class HttpModule {}