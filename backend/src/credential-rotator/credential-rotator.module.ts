import { Module, Global } from '@nestjs/common';
import { CredentialRotatorService } from './credential-rotator.service';
import { RotatingApiClient } from './api-client.service';
import { CredentialRotatorController } from './credential-rotator.controller';
import { HttpModule } from '@nestjs/axios';

@Global()
@Module({
  imports: [HttpModule],
  controllers: [CredentialRotatorController],
  providers: [CredentialRotatorService, RotatingApiClient],
  exports: [CredentialRotatorService, RotatingApiClient],
})
export class CredentialRotatorModule {}