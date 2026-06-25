import { Logger } from '@nestjs/common';

import { AccessControlService } from '../../access-control/access-control.service';
import { AccessPointsService } from '../../access-control/access-points.service';
import { CredentialRotatorService } from '../../credential-rotator/credential-rotator.service';
import type { ToolSchema } from '../../assistant/llm.provider';
import type { ToolResult } from './code-tools';

type ToolArgs = Record<string, unknown>;

/** Dependencias que el módulo del copiloto inyecta en las tools de acción. */
export interface ActionToolDeps {
  access: AccessControlService;
  accessPoints: AccessPointsService;
  rotator: CredentialRotatorService;
}

/**
 * Herramientas de **acción** del Copiloto: las únicas que mutan el mundo físico
 * o el estado de credenciales. Por eso están aisladas de las de consulta y,
 * además de devolver el resultado al modelo, se registran en `copilot_audit`
 * por el servicio (no aquí: aquí solo se ejecutan con el `userId` del admin).
 *
 * Seguirdad por diseño:
 *  - Se construyen **solo si** `COPLOT_ACTIONS_ENABLED=true`. Si están apagadas,
 *    no existen para el modelo: ni siquiera se publican sus esquemas. Así el
 *    operador puede desplegar el copiloto en modo "solo lectura del sistema".
 *  - La apertura se hace por el flujo existente y auditado
 *    (`testOpenDoor(actorId)`), que ya persiste un `Access_Event` con el
 *    operador. El copiloto **nunca** llama al actuador directamente.
 */
export function createActionTools(deps: ActionToolDeps) {
  const logger = new Logger('CopilotActionTools');

  const schemas: ToolSchema[] = [
    {
      type: 'function',
      function: {
        name: 'abrir_puerta',
        description:
          'Abre físicamente la puerta (apertura de prueba auditada). Úsala SOLO cuando el operador lo pida explícitamente. Sin argumentos = puerta por defecto.',
        parameters: {
          type: 'object',
          properties: {
            accessPointId: {
              type: 'string',
              description: 'UUID del punto de acceso. Opcional (puerta única).',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'rotar_credenciales',
        description:
          'Cambia a la siguiente cuenta Cloudflare del pool (p. ej. si la cuenta actual está limitada). Sin argumentos.',
        parameters: { type: 'object', properties: {} },
      },
    },
  ];

  const names = new Set(schemas.map((s) => s.function.name));

  /** Resuelve el punto por defecto o el solicitado. */
  async function resolveAccessPoint(
    accessPointId?: string,
  ): Promise<{ id: string; name: string } | null> {
    if (accessPointId) {
      const all = await deps.accessPoints.list();
      const found = all.find((p) => p.id === accessPointId);
      return found ? { id: found.id, name: found.name } : null;
    }
    const all = await deps.accessPoints.list();
    const first = all[0];
    return first ? { id: first.id, name: first.name } : null;
  }

  async function openDoor(args: ToolArgs, userId: string): Promise<string> {
    const ap = await resolveAccessPoint(strOrUndef(args.accessPointId));
    if (!ap) return JSON.stringify({ ok: false, error: 'no hay puntos de acceso configurados' });
    // testOpenDoor valida el actuador, anima la puerta Y persiste un Access_Event
    // con actorId=userId (auditoría reutilizada, no se inventa un nuevo flujo).
    const result = await deps.access.testOpenDoor(ap.id, userId);
    return JSON.stringify({
      ok: result.actuated,
      punto: ap.name,
      accessPointId: ap.id,
      estado: result.status.state,
    });
  }

  async function rotateCredentials(): Promise<string> {
    const before = deps.rotator.getStats().current;
    const next = await deps.rotator.switchToNextAccount();
    const after = deps.rotator.getStats().current;
    return JSON.stringify({
      ok: !!next,
      cuentaAnterior: before,
      cuentaActual: after,
      rotada: before !== after,
    });
  }

  async function execute(name: string, args: ToolArgs, userId: string): Promise<ToolResult> {
    if (!names.has(name)) {
      return { ok: false, output: `error: herramienta desconocida ${name}` };
    }
    try {
      switch (name) {
        case 'abrir_puerta':
          return { ok: true, output: await openDoor(args, userId) };
        case 'rotar_credenciales':
          return { ok: true, output: await rotateCredentials() };
        default:
          return { ok: false, output: `error: herramienta desconocida ${name}` };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`tool ${name} falló: ${msg}`);
      return { ok: false, output: `error: ${msg}` };
    }
  }

  return { schemas, execute };
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' && v.length ? v : undefined;
}
