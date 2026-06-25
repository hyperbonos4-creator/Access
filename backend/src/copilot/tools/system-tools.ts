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
import type { ConversationSnapshot, ToolContext } from './snapshot.types';

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
/** Tope para análisis (novedades, resumen operativo): más contexto, sin saturar. */
const MAX_ANALYTICS_EVENTS = 200;
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
          'Lista los eventos de acceso (concedidos/denegados) con decisión, motivo, puntuaje, si se abrió la puerta, el operador que actuó (en aperturas manuales/prueba) y hora. Soporta filtro por rango de fechas (desde/hasta), decisión y punto. Útil para "quién entró hoy", "denegaciones de la semana", "quién abrió la puerta manualmente".',
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
    {
      type: 'function',
      function: {
        name: 'novedades',
        description:
          'Compara el estado ACTUAL con el de la consulta anterior (snapshot guardado al cierre del turno previo) y devuelve solo las diferencias: eventos de acceso nuevos desde entonces, y cambios en el conteo de empleados. Úsala para "¿hay algo nuevo desde la última consulta?", "¿hubo cambios?", "¿qué pasó desde que pregunté?". Sin argumentos.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'resumen_operativo',
        description:
          'Diagnóstico de operaciones de los últimos 7 días como lo haría un gerente: tasas de concesión/denegación, motivo principal de rechazo, cobertura de biometría, número de cámaras y una lista de `criticalIssues` (p. ej. "tasa de denegación anormal", "X% sin biometría", "no hay cámaras"). Úsala para "¿hay riesgo operativo?", "¿detectas anomalías?", "¿qué revisarías primero?", "¿está listo para producción?". Sin argumentos.',
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
    const events = await deps.access.listEventsWithActor({
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
      operador: e.actor,
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

  // ── memoria entre consultas + análisis ────────────────────────────────

  /**
   * Captura la "fotografía" del estado del sistema que se persiste al cierre de
   * cada turno en `copilot_conversation.state_snapshot`. Reutiliza las mismas
   * fuentes que `panel` (empleados + eventos de hoy). El pivot del diff temporal
   * es `ultimoEventoEn`: el timestamp del evento más reciente.
   *
   * Robusta a "sin datos": si no hay eventos, `ultimoEventoEn` queda en null y la
   * próxima consulta de novedades simplemente devolverá "todo lo existente".
   */
  async function captureSnapshot(): Promise<ConversationSnapshot> {
    const today = startOfToday();
    const [empleados, eventosHoy] = await Promise.all([
      deps.enrollment.listSubjectsDetailed(),
      deps.access.listEvents({ from: today, limit: MAX_ANALYTICS_EVENTS }),
    ]);
    // listEvents viene ordenado por recordedAt DESC: el primero es el más reciente.
    const ultimo = eventosHoy[0]?.recordedAt ?? null;
    return {
      capturadoEn: new Date().toISOString(),
      eventos: {
        total: eventosHoy.length,
        granted: eventosHoy.filter((e) => e.decision === 'GRANTED').length,
        denied: eventosHoy.filter((e) => e.decision === 'DENIED').length,
      },
      ultimoEventoEn: ultimo ? new Date(ultimo).toISOString() : null,
      empleados: {
        total: empleados.length,
        activos: empleados.filter((e) => e.status === 'ACTIVE').length,
        conBiometria: empleados.filter((e) => e.hasBiometrics).length,
      },
    };
  }

  /**
   * Compara el estado actual con el snapshot del turno anterior y devuelve SOLO
   * las diferencias. El diff de eventos se hace por timestamp (`recordedAt >
   * ultimoEventoEn`), que es inmune a topes de paginación: aunque el snapshot
   * viera solo 30 de 50 eventos, lo que cuenta es "qué ocurrió después del
   * último visto".
   */
  async function novedades(ctx: ToolContext): Promise<string> {
    const prev = ctx.prevSnapshot;

    // Empleados actuales para el delta de plantilla.
    const empleadosAhora = await deps.enrollment.listSubjectsDetailed();

    // Sin snapshot previo: no hay consulta anterior con la que comparar. No es
    // un error; es simplemente "no hay baseline". Devolvemos el estado base.
    if (!prev) {
      const snapshot = await captureSnapshot();
      return JSON.stringify({
        hayConsultaAnterior: false,
        nota: 'No existe una consulta anterior en esta conversación con la que comparar. Este es el estado base; la próxima vez que preguntes por novedades sí podré calcular el diff.',
        estadoBase: snapshot,
      });
    }

    // Pivote temporal para el diff. Preferimos el último evento visto (`ultimoEventoEn`),
    // pero si el snapshot previo no registró eventos (sin actividad), caemos a
    // `capturadoEn`: cualquier cosa grabada después del cierre del turno anterior
    // cuenta como novedad. Así nunca pasamos `null` a `new Date`.
    const pivote = prev.ultimoEventoEn ?? prev.capturadoEn;
    const desde = new Date(pivote);
    const nuevos = Number.isNaN(desde.getTime())
      ? []
      : await deps.access.listEventsWithActor({ from: desde, limit: MAX_ANALYTICS_EVENTS });
    // `from` usa MoreThan: excluye el propio pivote (que ya estaba en el snapshot).
    const concedidos = nuevos.filter((e) => e.decision === 'GRANTED').length;
    const denegados = nuevos.filter((e) => e.decision === 'DENIED').length;

    return JSON.stringify({
      hayConsultaAnterior: true,
      snapshotAnterior: prev,
      eventosNuevos: {
        total: nuevos.length,
        concedidos,
        denegados,
        detalle: nuevos.slice(0, MAX_EVENTS).map((e) => ({
          hora: e.recordedAt,
          decision: e.decision,
          motivo: e.reason,
          subjectId: e.subjectId,
          operador: e.actor,
        })),
      },
      empleados: {
        antes: prev.empleados,
        ahora: {
          total: empleadosAhora.length,
          activos: empleadosAhora.filter((e) => e.status === 'ACTIVE').length,
          conBiometria: empleadosAhora.filter((e) => e.hasBiometrics).length,
        },
        delta: {
          total: empleadosAhora.length - prev.empleados.total,
          activos: empleadosAhora.filter((e) => e.status === 'ACTIVE').length - prev.empleados.activos,
        },
      },
    });
  }

  /**
   * Diagnóstico de operaciones de 7 días como lo haría un gerente de seguridad.
   * Calcula tasas, motivo dominante de denegación, cobertura de biometría y
   * genera una lista explícita de `criticalIssues` con heurísticas claras, para
   * que el modelo razoné sobre riesgo en vez de contestar "no" por defecto.
   */
  async function operationalSummary(): Promise<string> {
    const desde = new Date();
    desde.setDate(desde.getDate() - 7);
    const [empleados, eventos7d, puntos, camaras, vision, database] = await Promise.all([
      deps.enrollment.listSubjectsDetailed(),
      deps.access.listEventsWithActor({ from: desde, limit: MAX_ANALYTICS_EVENTS }),
      deps.accessPoints.list().catch((): AccessPointView[] => []),
      deps.cameras.list().catch((): CameraView[] => []),
      deps.vision.health().catch(() => ({ ok: false })),
      deps.access.pingDb().catch(() => ({ ok: false })),
    ]);

    const granted = eventos7d.filter((e) => e.decision === 'GRANTED').length;
    const denied = eventos7d.filter((e) => e.decision === 'DENIED').length;
    const totalDecisiones = granted + denied;
    const tasaDenegacion = totalDecisiones ? denied / totalDecisiones : 0;

    // Motivo principal de denegación (por conteo).
    const porMotivo = new Map<string, number>();
    for (const e of eventos7d) {
      if (e.decision === 'DENIED') porMotivo.set(e.reason, (porMotivo.get(e.reason) ?? 0) + 1);
    }
    let motivoPrincipal: string | null = null;
    let motivoPrincipalCount = 0;
    for (const [motivo, n] of porMotivo) {
      if (n > motivoPrincipalCount) {
        motivoPrincipal = motivo;
        motivoPrincipalCount = n;
      }
    }

    const sinBiometria = empleados.filter((e) => !e.hasBiometrics).length;
    const pctSinBiometria = empleados.length ? Math.round((sinBiometria / empleados.length) * 100) : 0;

    // ── criticalIssues: heurísticas explícitas ───────────────────────────
    const criticalIssues: string[] = [];
    if (camaras.length === 0) {
      criticalIssues.push('No hay cámaras configuradas: el sistema no captura evidencia visual.');
    } else if (camaras.filter((c) => c.status === 'ACTIVE').length === 0) {
      criticalIssues.push('Las cámaras existen pero ninguna está activa.');
    }
    if (empleados.length > 0 && sinBiometria > 0) {
      criticalIssues.push(`${pctSinBiometria}% de los empleados (${sinBiometria}) sin biometría: no pueden usar acceso facial.`);
    }
    if (totalDecisiones >= 5 && tasaDenegacion > 0.8) {
      criticalIssues.push(
        `Tasa de denegación anormal (${Math.round(tasaDenegacion * 100)}% en 7 días): revisa umbral facial o identidad de los usuarios.`,
      );
    }
    if (!vision.ok) criticalIssues.push('El microservicio de visión no responde: el reconocimiento facial no funciona.');
    if (!database.ok) criticalIssues.push('La base de datos no responde.');
    if (motivoPrincipal === 'UNKNOWN_SUBJECT' && denied > 0) {
      const pct = Math.round((motivoPrincipalCount / denied) * 100);
      criticalIssues.push(
        `La mayoría de las denegaciones (${pct}%) son por identidad desconocida (UNKNOWN_SUBJECT): posibles personas sin registrar o umbral facial muy estricto.`,
      );
    }
    if (puntos.length === 0) criticalIssues.push('No hay puntos de acceso configurados.');

    // Nivel de riesgo agregado, derivado de los issues (no inventado por el modelo).
    const nivelRiesgo = criticalIssues.length >= 3 ? 'ALTO' : criticalIssues.length >= 1 ? 'MODERADO' : 'BAJO';

    return JSON.stringify({
      ventana: '7 días',
      eventos: { granted, denied, total: eventos7d.length },
      tasas: {
        denegacion: Math.round(tasaDenegacion * 100) / 100,
        concesion: totalDecisiones ? Math.round((granted / totalDecisiones) * 100) / 100 : 0,
      },
      motivoPrincipalDenegacion: motivoPrincipal ? { motivo: motivoPrincipal, count: motivoPrincipalCount } : null,
      empleados: {
        total: empleados.length,
        withBiometrics: empleados.length - sinBiometria,
        withoutBiometrics: sinBiometria,
        pctSinBiometria,
      },
      doors: { total: puntos.length, activos: puntos.filter((p) => p.status === 'ACTIVE').length },
      cameras: { total: camaras.length, activas: camaras.filter((c) => c.status === 'ACTIVE').length },
      salud: { vision: vision.ok, baseDeDatos: database.ok },
      nivelRiesgo,
      criticalIssues,
    });
  }

  async function execute(name: string, args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
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
        case 'novedades':
          return { ok: true, output: clip(await novedades(ctx)) };
        case 'resumen_operativo':
          return { ok: true, output: clip(await operationalSummary()) };
        default:
          return { ok: false, output: `error: herramienta desconocida ${name}` };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`tool ${name} falló: ${msg}`);
      return { ok: false, output: `error: ${msg}` };
    }
  }

  return { schemas, execute, captureSnapshot };
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
