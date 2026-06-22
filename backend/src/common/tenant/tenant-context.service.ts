import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { IsNull } from 'typeorm';

interface TenantStore {
  /** Id de la sesión de demo efímera, o `null` para el tenant base (no-demo). */
  demoSessionId: string | null;
}

/**
 * Contexto de tenant por request (multi-tenencia efímera del demo público).
 *
 * Cada visitante del demo recibe una `demoSessionId` propia; su token JWT la
 * transporta y el `TenantMiddleware` la deposita aquí (AsyncLocalStorage) para
 * toda la vida del request. Los servicios la leen con `scopeValue()` y la usan
 * como filtro en Postgres, y `VisionServiceClient` la usa para aislar la
 * colección de Qdrant (`faces_demo_<id>`). Sin sesión de demo, el scope es
 * `null` (tenant base: el administrador "real").
 *
 * El cron de purga corre fuera de un request: usa `run()` para fijar el scope
 * de la sesión que está limpiando.
 */
@Injectable()
export class TenantContext {
  private readonly als = new AsyncLocalStorage<TenantStore>();

  /** Ejecuta `fn` con un scope de tenant fijo (request o tarea de purga). */
  run<T>(demoSessionId: string | null, fn: () => T): T {
    return this.als.run({ demoSessionId: demoSessionId ?? null }, fn);
  }

  /** Id de la sesión de demo del scope actual, o `null`. */
  demoSessionId(): string | null {
    return this.als.getStore()?.demoSessionId ?? null;
  }

  /** true si el scope actual es una sesión de demo (no el tenant base). */
  isDemo(): boolean {
    return this.demoSessionId() != null;
  }

  /**
   * Valor a usar en una cláusula `where` de TypeORM para aislar por tenant:
   * el id de la sesión, o `IsNull()` para el tenant base. Úsese como
   * `where: { ..., demoSessionId: tenant.scopeValue() }`.
   */
  scopeValue(): string | ReturnType<typeof IsNull> {
    const id = this.demoSessionId();
    return id ?? IsNull();
  }

  /** Espacio de nombres del Vector_Store para el scope actual. */
  visionNamespace(baseSiteId: string): string {
    const id = this.demoSessionId();
    return id ? `demo_${id}` : baseSiteId;
  }
}
