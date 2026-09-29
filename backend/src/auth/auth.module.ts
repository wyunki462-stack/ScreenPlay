import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../database/database.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SystemUsersService } from './system-users.service';

/**
 * Local authentication. No external identity provider is contacted: the system
 * provider reads the mounted host user database, the local provider keeps
 * scrypt hashes in the app database, and sessions persist in the data volume.
 */
@Module({
  imports: [ConfigModule, DatabaseModule],
  controllers: [AuthController],
  providers: [AuthService, SystemUsersService],
  exports: [AuthService, SystemUsersService],
})
export class AuthModule {}