import { NestFactory } from '@nestjs/core';
import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TenantMiddleware } from './common/tenant/tenant.middleware';

/** Cap del body JSON: las fotos de enrolamiento van en base64 (~2 MB holgado). */
const JSON_BODY_LIMIT = '8mb';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const logger = new Logger('Bootstrap');

  // Detrás de un proxy (nginx/ingress): req.ip = cliente real (auditoría).
  app.set('trust proxy', 1);

  app.use(json({ limit: JSON_BODY_LIMIT }));
  app.use(urlencoded({ extended: true, limit: JSON_BODY_LIMIT }));

  // El backend sirve el preview MJPEG del kiosko como <img> desde otro origen
  // y el registro guiado usa MediaPipe (WASM) en el navegador. CSP ajustada:
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: {
        directives: {
          'img-src': ["'self'", 'data:', 'blob:'],
          'script-src': ["'self'", "'wasm-unsafe-eval'"],
          'worker-src': ["'self'", 'blob:'],
          'connect-src': ["'self'", 'data:', 'blob:'],
        },
      },
    }),
  );
  app.use(cookieParser());

  // Tenencia efímera del demo: deposita la demoSessionId del token en el
  // AsyncLocalStorage para todo el request (aislamiento de datos por sesión).
  const tenantMw = app.get(TenantMiddleware);
  app.use((req: Request, res: Response, next: NextFunction) => tenantMw.use(req, res, next));

  const corsOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3001')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const isProduction = process.env.NODE_ENV === 'production';
  const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  app.enableCors({
    origin: isProduction
      ? corsOrigins.length === 1
        ? corsOrigins[0]
        : corsOrigins
      : (origin, callback) => {
          if (!origin || corsOrigins.includes(origin) || LOCALHOST_ORIGIN.test(origin)) {
            callback(null, true);
          } else {
            callback(null, false);
          }
        },
    credentials: true,
  });

  app.enableShutdownHooks();

  const apiPrefix = process.env.API_PREFIX || 'api/v1';
  app.setGlobalPrefix(apiPrefix, {
    exclude: [{ path: 'health', method: RequestMethod.GET }],
  });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());

  const swaggerEnabled =
    process.env.SWAGGER_ENABLED === 'true' || process.env.NODE_ENV !== 'production';
  if (swaggerEnabled) {
    const config = new DocumentBuilder()
      .setTitle('Office Access Control')
      .setDescription('Control de acceso facial para una puerta de oficina')
      .setVersion('0.1')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  const port = process.env.PORT || 3000;
  await app.listen(port);
  logger.log(`Backend escuchando en http://localhost:${port}`);
  if (swaggerEnabled) {
    logger.log(`Swagger en http://localhost:${port}/api/docs`);
  }
}
void bootstrap();
