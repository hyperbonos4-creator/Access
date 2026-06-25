import { Logger } from '@nestjs/common';

import { AccessControlService } from '../../access-control/access-control.service';
import {
  AccessPointsService,
  type AccessPointView,
} from '../../access-control/access-points.service';
import { EnrollmentService } from '../../access-control/enrollment.service';
import { KioskRecognitionService } from '../../access-control/kiosk-recognition.service';
import { VisionServiceClient } from '../../access-control/vision-service.client';
import { CamerasService, type CameraView } from '../../cameras/cameras.service';
import { CredentialRotatorService } from '../../credential-rotator/credential-rotator.service';
import type { ToolSchema } from '../../assistant/llm.provider';
import type { ToolArgs, ToolResult } from './tools.types';

/** Dependencias que el módulo del copiloto inyecta en las tools de sistema. */
export interface SystemToolDeps {
  access: AccessControlService;
  accessPoints: AccessPointsService;
  enrollment: EnrollmentService;
  cameras: CamerasService;
  kiosk: KioskRecognitionService;
  vision: VisionServiceClient;
  rotator: CredentialRotatorService;
}

const MAX_EVENTS = 30; // tope de eventos que se entregan al modelo
const MAX_EMPLOYEES = 40; // tope de empleados en listar_empleados
const MAX_RESULT = 9_000;

function clip(s: string): string {
  return s.length > MAX_RESULT ? s.slice(0, MAX_RESULT) + '\n…[recortado]' : s;
}

/**
 * Herramientas de **sistema** del Copiloto: consultas de solo lectura sobre
 * TODO el sistema de control de acceso —empleados, eventos, puntos, cámaras,
 * puerta, salud y credenciales. No mutan nada: para actuar (abrir puerta,
 * rotar credenciales) se usan las tools de `action-tools.ts`.
 *
 * `panel` da un resumen global (una sola llamada responde el 90 % de las
 * preguntas del admin); el resto son tools de detalle por apartado para cuando
 * el admin quiere profundizar.
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
        name: 'panel',
        description:
          'Resumen global del sistema en una sola llamada: totales de empleados (registrados, activos, con biometría), accesos de hoy (concedidos, denegados, total), puntos de acceso activos, cámaras activas y salud (visión + base de datos). Úsala para preguntas generales como "¿cómo está todo?", "dame un resumen".',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'listar_empleados',
        description:
          'Lista los empleados registrados con su estado operativo: nombre, código, tipo (EMPLOYEE/CONTRACTOR), estado, si tienen biometría, nº de plantillas, consentimiento y último acceso. Filtros opcionales por estado o texto de búsqueda.',
        parameters: {
          type: 'object',
          properties: {
            estado: {
              type: 'string',
              enum: ['ACTIVE', 'DISABLED'],
              description: 'Filtrar por estado. Opcional.',
            },
            buscar: {
              type: 'string',
              description: 'Texto a buscar en nombre o código (case-insensitive). Opcional.',
            },
            limit: { type: 'integer', description: `Número máximo (máx. ${MAX_EMPLOYEES}).` },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'listar_eventos',
        description:
          'Lista los eventos de acceso (concedidos/denegados) con decisión, motivo, puntuaje, si se abrió la puerta y hora. Soporta filtro por rango de fechas (desde/hasta), decisión y punto. Útil para "quién entró hoy", "denegaciones de la semana".',
        parameters: {
          type: 'object',
          properties: {
            decision: {
              type: 'string',
              enum: ['GRANTED', 'DENIED'],
              description: 'Filtrar por decisión. Opcional.',
            },
            desde: {
              type: 'string',
              description:
                'Fecha/hora de inicio (ISO 8601, p. ej. "2026-06-24T00:00:00"). Opcional.',
            },
            hasta: {
              type: 'string',
              description: 'Fecha/hora de fin (ISO 8601). Opcional.',
            },
            accessPointId: {
              type: 'string',
              description: 'Filtrar por punto de acceso (UUID). Opcional.',
            },
            limit: { type: 'integer', description: `Número de eventos (máx. ${MAX_EVENTS}).` },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'listar_puntos_acceso',
        description:
          'Lista los puntos de acceso (puertas) con nombre, tipo, nivel de seguridad, umbrales de match y liveness, tipo de controlador y estado. Sin argumentos.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'listar_camaras',
        description:
          'Lista las cámaras IP configuradas con nombre, clave externa, canal NVR y estado. No expone la URL RTSP (secreto). Sin argumentos.',
        parameters: { type: 'object', properties: {} },
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
        name: 'estado_sistema',
        description:
          'Salud detallada del sistema: microservicio de visión, base de datos, cámaras y pool de credenciales Cloudflare (cuántas cuentas, activas, cuál en uso). Útil para "¿el sistema está bien?", "¿quedan credenciales?".',
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

  /** Día local a medianoche (00:00) — base para "eventos de hoy". */
  function startOfToday(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  /** Resumen global: agrega KPIs de todos los apartados en una sola llamada. */
  async function panel(): Promise<string> {
    const today = startOfToday();
    const [empleados, eventosHoy, puntos, camaras, vision, database] = await Promise.all([
      deps.enrollment.listSubjectsDetailed(),
      deps.access.listEvents({ from: today, limit: MAX_EVENTS }),
      deps.accessPoints.list().catch((): AccessPointView[] => []),
      deps.cameras.list().catch((): CameraView[] => []),
      deps.vision.health().catch(() => ({ ok: false, detail: null })),
      deps.access.pingDb().catch(() => ({ ok: false })),
    ]);

    const total = empleados.length;
    const activos = empleados.filter((e) => e.status === 'ACTIVE').length;
    const conBiometria = empleados.filter((e) => e.hasBiometrics).length;
    const conConsentimiento = empleados.filter((e) => e.hasConsent).length;
    const concedidosHoy = eventosHoy.filter((e) => e.decision === 'GRANTED').length;
    const denegadosHoy = eventosHoy.filter((e) => e.decision === 'DENIED').length;
    const puntosActivos = puntos.filter((p) => p.status === 'ACTIVE').length;
    const camarasActivas = camaras.filter((c) => c.status === 'ACTIVE').length;

    return JSON.stringify({
      empleados: { total, activos, conBiometria, conConsentimiento },
      accesosHoy: { concedidos: concedidosHoy, denegados: denegadosHoy, total: eventosHoy.length },
      puntosAcceso: { total: puntos.length, activos: puntosActivos },
      camaras: { total: camaras.length, activas: camarasActivas },
      salud: { vision: vision.ok, baseDeDatos: database.ok },
      generadoEn: new Date().toISOString(),
    });
  }

  async function listEmployees(args: ToolArgs): Promise<string> {
    const estado = strOrUndef(args.estado);
    const buscar = strOrUndef(args.buscar)?.toLowerCase();
    const limit = Math.min(toInt(args.limit) ?? MAX_EMPLOYEES, MAX_EMPLOYEES);
    let rows = await deps.enrollment.listSubjectsDetailed();
    if (estado) rows = rows.filter((e) => e.status === estado);
    if (buscar) {
      rows = rows.filter(
        (e) =>
          e.fullName.toLowerCase().includes(buscar) ||
          (e.employeeCode ?? '').toLowerCase().includes(buscar),
      );
    }
    rows = rows.slice(0, limit);
    return JSON.stringify({
      total: rows.length,
      empleados: rows.map((e) => ({
        nombre: e.fullName,
        codigo: e.employeeCode,
        tipo: e.kind,
        estado: e.status,
        biometria: e.hasBiometrics,
        plantillas: e.templateCount,
        consentimiento: e.hasConsent,
        ultimoAcceso: e.lastAccessAt,
      })),
    });
  }

  async function listEvents(args: ToolArgs): Promise<string> {
    const limit = Math.min(toInt(args.limit) ?? MAX_EVENTS, MAX_EVENTS);
    const events = await deps.access.listEvents({
      accessPointId: strOrUndef(args.accessPointId),
      decision: strOrUndef(args.decision),
      from: dateOrUndef(args.desde),
      to: dateOrUndef(args.hasta),
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
    return JSON.stringify({ total: rows.length, eventos: rows });
  }

  async function listAccessPoints(): Promise<string> {
    const points = await deps.accessPoints.list();
    return JSON.stringify({
      total: points.length,
      puntos: points.map((p) => ({
        id: p.id,
        nombre: p.name,
        tipo: p.kind,
        nivelSeguridad: p.securityLevel,
        umbralMatch: Number(p.matchThreshold),
        umbralLiveness: Number(p.livenessThreshold),
        controlador: p.controllerKind,
        camaraId: p.cameraId,
        estado: p.status,
      })),
    });
  }

  async function listCameras(): Promise<string> {
    const camaras = await deps.cameras.list();
    return JSON.stringify({
      total: camaras.length,
      camaras: camaras.map((c) => ({
        id: c.id,
        nombre: c.name,
        claveExterna: c.externalKey,
        canalNvr: c.nvrChannel,
        estado: c.status,
        creada: c.createdAt,
      })),
    });
  }

  async function doorStatus(args: ToolArgs): Promise<string> {
    const ap = await resolveAccessPoint(strOrUndef(args.accessPointId));
    if (!ap) return JSON.stringify({ ok: false, error: 'no hay puntos de acceso configurados' });
    const status = deps.access.doorStatus(ap.id);
    return JSON.stringify({ punto: ap.name, ...status });
  }

  async function systemStatus(): Promise<string> {
    const [vision, database, cameras, credentials] = await Promise.all([
      deps.vision.health().catch(() => ({ ok: false, detail: null })),
      deps.access.pingDb().catch(() => ({ ok: false })),
      deps.kiosk.diagnoseCameras().catch(() => []),
      Promise.resolve(deps.rotator.getStats()),
    ]);
    return JSON.stringify({ vision, baseDeDatos: database, camaras: cameras, credenciales: credentials });
  }

  async function execute(name: string, args: ToolArgs): Promise<ToolResult> {
    if (!names.has(name)) {
      return { ok: false, output: `error: herramienta desconocida ${name}` };
    }
    try {
      switch (name) {
        case 'panel':
          return { ok: true, output: clip(await panel()) };
        case 'listar_empleados':
          return { ok: true, output: clip(await listEmployees(args)) };
        case 'listar_eventos':
          return { ok: true, output: clip(await listEvents(args)) };
        case 'listar_puntos_acceso':
          return { ok: true, output: clip(await listAccessPoints()) };
        case 'listar_camaras':
          return { ok: true, output: clip(await listCameras()) };
        case 'estado_puerta':
          return { ok: true, output: clip(await doorStatus(args)) };
        case 'estado_sistema':
          return { ok: true, output: clip(await systemStatus()) };
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
function dateOrUndef(v: unknown): Date | undefined {
  if (typeof v !== 'string' || !v.length) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
