import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { VisionServiceUnavailableError } from '../../access-control/vision-service.client';

/**
 * Filtro global de excepciones con forma de error uniforme (ADR
 * bootstrap-and-error-shape de URBAN). Nunca filtra detalles internos al
 * cliente; el stack de las excepciones inesperadas queda en el log del server.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: Record<string, unknown> = { message: 'internal_error' };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      body = typeof res === 'string' ? { message: res } : (res as Record<string, unknown>);
    } else if (exception instanceof VisionServiceUnavailableError) {
      // Canal de visión caído/timeout: degradación esperada, no error interno.
      status = HttpStatus.SERVICE_UNAVAILABLE;
      body = { message: 'vision_service_unavailable' };
    } else {
      const err = exception as Error;
      this.logger.error(`Excepción no controlada: ${err?.message}`, err?.stack);
    }

    response.status(status).json({
      statusCode: status,
      ...body,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
