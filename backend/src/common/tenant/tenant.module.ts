import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { getJwtAccessSecret } from '../../config/jwt.config';
import { TenantContext } from './tenant-context.service';
import { TenantMiddleware } from './tenant.middleware';

/**
 * Módulo global de tenencia efímera. Expone `TenantContext` a toda la app y
 * registra el `JwtService` que el `TenantMiddleware` usa para leer el claim
 * `ds` (demoSessionId) del token.
 */
@Global()
@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ secret: getJwtAccessSecret(config) }),
    }),
  ],
  providers: [TenantContext, TenantMiddleware],
  exports: [TenantContext],
})
export class TenantModule {}
