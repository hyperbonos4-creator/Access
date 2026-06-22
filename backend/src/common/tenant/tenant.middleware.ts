import { Injectable, NestMiddleware } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { NextFunction, Request, Response } from 'express';

import { TenantContext } from './tenant-context.service';

/**
 * Deposita la `demoSessionId` del token en el `TenantContext` (AsyncLocalStorage)
 * para todo el ciclo del request. No autoriza ni rechaza nada (de eso se encarga
 * el `JwtAuthGuard`): solo lee el claim `ds` de forma best-effort. Si no hay
 * token válido, el scope queda en `null` (tenant base).
 *
 * El token llega por `Authorization: Bearer` o por `?token=` (streams en `<img>`).
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(
    private readonly jwt: JwtService,
    private readonly tenant: TenantContext,
  ) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    const ds = this.extractDemoSessionId(req);
    this.tenant.run(ds, () => next());
  }

  private extractDemoSessionId(req: Request): string | null {
    let raw: string | null = null;
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) raw = header.slice(7).trim();
    else if (typeof req.query?.token === 'string') raw = req.query.token;
    if (!raw) return null;
    try {
      const payload = this.jwt.verify<{ ds?: string | null }>(raw);
      return payload?.ds ?? null;
    } catch {
      return null; // token inválido/expirado: el guard responderá 401 luego
    }
  }
}
