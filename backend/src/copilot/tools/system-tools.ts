import { Logger } from '@nestjs/common';

import { AccessControlService } from '../../access-control/access-control.service';
import { AccessPointsService } from '../../access-control/access-points.service';
import { KioskRecognitionService } from '../../access-control/kiosk-recognition.service';
import { VisionServiceClient } from '../../access-control/vision-service.client';
import { CredentialRotatorService } from '../../credential-rotator/credential-rotator.service';
import type { ToolSchema } from '../../assistant/llm.provider';
import type { ToolResult } from './code-tools';

type ToolArgs = Record<string, unknown>;

/** Dependencias que el módulo del copiloto inyecta en las tools de sistema. */
export interface SystemToolDeps {
  access: AccessControlService;
  accessPoints: AccessPointsService;
  kiosk: KioskRecognitionService;
  vision: VisionServiceClient;
  rotator: CredentialRotatorService;
}

const MAX_EVENTS = 30; // tope de eventos que se entregan al modelo
const MAX_RESULT = 9_000;

function clip(s: string): string {
  return s.length > MAX_RESULT ? s.slice(0, MAX_RESULT) + '\n…[recortado]' : s;
}

/**
 * Herramientas de **sistema** del Copiloto: consultas de solo lectura sobre el
 * estado del control de acceso (eventos, puerta, salud, credenciales). No
 * mutan nada: para actuar (abrir puerta, rotar credenciales) se usan las tools
 * de `action-tools.ts`, que sí quedan en auditoría como acciones.
 *
 * Devuelven JSON compacto en `output` (el modelo lo entiende bien) recortado a
 * `MAX_RESULT` chars. Nunca lanzan: un fallo de un subsistema se refleja como
 * `{ ok:false }` en el JSON para que el modelo pueda explicarlo al usuario.
 */
export function createSystemTools(deps: SystemToolDeps) {
  const logger = new Logger('CopilotSystemTools');

  const schemas: ToolSchema[] = [
    {
      type: 'function',
      function: {
        name: 'listar_eventos',
        description:
          'Lista los últimos eventos de acceso (concedidos/denegados) con decisión, motivo, puntuaje, si se abrió la puerta y hora. Útil para responder "quién entró", "hubo denegaciones", etc.',
        parameters: {
          type: 'object',
          properties: {
            accessPointId: {
              type: 'string',
              description: 'Filtrar por punto de acceso (UUID). Opcional.',
            },
            decision: {
              type: 'string',
              enum: ['GRANTED', 'DENIED'],
              description: 'Filtrar por decisión. Opcional.',
            },
            limit: {
              type: 'integer',
              description: `Número de eventos (máx. ${MAX_EVENTS}).`,
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'estado_puerta',
        description:
          'Estado en vivo de la puerta (CERRADA/ABRIENDO/ABIERTA/CERRANDO) y quién la abrió por última vez. Sin argumentos = puerta por defecto (producto de puerta única).',
        parameters: {
          type: 'object',
          properties: {
            accessPointId: {
              type: 'string',
              description: 'UUID del punto de acceso. Opcional.',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'diagnosticos',
        description:
          'Salud del sistema: microservicio de visión, base de datos y cámaras. Útil para responder "¿el sistema está bien?".',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'estado_credenciales',
        description:
          'Estado del pool de credenciales Cloudflare (cuántas cuentas, activas, cuál está en uso). No expone tokens.',
        parameters: { type: 'object', properties: {} },
      },
    },
  ];

  const names = new Set(schemas.map((s) => s.function.name));

  /** Resuelve el punto por defecto (puerta única) o devuelve el elegido. */
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

  async function listEvents(args: ToolArgs): Promise<string> {
    const limit = Math.min(toInt(args.limit) ?? MAX_EVENTS, MAX_EVENTS);
    const events = await deps.access.listEvents({
      accessPointId: strOrUndef(args.accessPointId),
      decision: strOrUndef(args.decision),
      limit,
    });
    const rows = events.map((e) => ({
      hora: e.recordedAt,
      decision: e.decision,
      motivo: e.reason,
      subjectId: e.subjectId,
      match: e.matchScore != null ? Number(e.matchScore) : null,
      liveness: e.livenessScore != null ? Number(e.livenessScore) : null,
      puertaAbierta: e.doorActuated,
    }));
    return JSON.stringify(
      { total: rows.length, eventos: rows },
      null,
      0,
    );
  }

  async function doorStatus(args: ToolArgs): Promise<string> {
    const ap = await resolveAccessPoint(strOrUndef(args.accessPointId));
    if (!ap) return JSON.stringify({ ok: false, error: 'no hay puntos de acceso configurados' });
    const status = deps.access.doorStatus(ap.id);
    return JSON.stringify({ punto: ap.name, ...status });
  }

  async function diagnostics(): Promise<string> {
    const [vision, database, cameras] = await Promise.all([
      deps.vision.health().catch(() => ({ ok: false, detail: null })),
      deps.access.pingDb().catch(() => ({ ok: false })),
      deps.kiosk.diagnoseCameras().catch(() => []),
    ]);
    return JSON.stringify({ vision, database, cameras });
  }

  function credentialsStatus(): string {
    // getStats() omite el token por diseño (confidencialidad).
    return JSON.stringify(deps.rotator.getStats());
  }

  async function execute(name: string, args: ToolArgs): Promise<ToolResult> {
    if (!names.has(name)) {
      return { ok: false, output: `error: herramienta desconocida ${name}` };
    }
    try {
      switch (name) {
        case 'listar_eventos':
          return { ok: true, output: clip(await listEvents(args)) };
        case 'estado_puerta':
          return { ok: true, output: clip(await doorStatus(args)) };
        case 'diagnosticos':
          return { ok: true, output: clip(await diagnostics()) };
        case 'estado_credenciales':
          return { ok: true, output: clip(credentialsStatus()) };
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

function toInt(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' && v.length ? v : undefined;
}
