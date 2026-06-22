import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ServeStaticModule } from '@nestjs/serve-static';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'path';

import { envValidationSchema } from './config/env.validation';
import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { CamerasModule } from './cameras/cameras.module';
import { AccessControlModule } from './access-control/access-control.module';
import { TenantModule } from './common/tenant/tenant.module';
import { AssistantModule } from './assistant/assistant.module';
import { CredentialRotatorModule } from './credential-rotator/credential-rotator.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
    }),
    EventEmitterModule.forRoot(),
    // UI del kiosko + consola admin (estáticos), servidos en /kiosk.
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      serveRoot: '/kiosk',
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('DB_HOST', 'localhost'),
        port: config.get<number>('DB_PORT', 5432),
        username: config.get<string>('DB_USER'),
        password: config.get<string>('DB_PASSWORD'),
        database: config.get<string>('DB_NAME'),
        autoLoadEntities: true,
        synchronize: config.get<string>('DB_SYNCHRONIZE') === 'true',
      }),
    }),
    AuthModule,
    CamerasModule,
    AccessControlModule,
    TenantModule,
    AssistantModule,
    CredentialRotatorModule,
  ],
  controllers: [AppController],
})
export class AppModule {}