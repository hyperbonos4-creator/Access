import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AccessControlService } from '../../access-control/access-control.service';
import { AccessPointsService } from '../../access-control/access-points.service';
import { EnrollmentService } from '../../access-control/enrollment.service';
import { KioskRecognitionService } from '../../access-control/kiosk-recognition.service';
import { VisionServiceClient } from '../../access-control/vision-service.client';
import { CamerasService } from '../../cameras/cameras.service';
import { CredentialRotatorService } from '../../credential-rotator/credential-rotator.service';
import type { ToolSchema } from '../../assistant/llm.provider';

import { createSystemTools, type SystemToolDeps } from './system-tools';
import { createActionTools, type ActionToolDeps } from './action-tools';
import type { ToolArgs, ToolResult } from './tools.types';
import type { ConversationSnapshot, ToolContext } from './snapshot.types';

/** Marca de cada familia, para auditar/limitar por categoría si hace falta. */
export type ToolFamily = 'system' | 'action';

/** Entrada del registro: familia + ejecutor con contexto de conversación. */
interface ToolEntry {
  family: ToolFamily;
  /** Ejecuta la tool; `ctx` lleva el userId, la conversación y el snapshot previo. */
  run: (args: ToolArgs, ctx: ToolContext) => Promise<ToolResult>;
}

/**
 * `ToolsRegistry` — catálogo central de herramientas del Copiloto.
 *
 * Reúne los esquemas (OpenAI function-calling) de las dos familias —sistema y
 * acción— y los despacha por nombre, pasando siempre el `userId` del admin
 * (atribución). Es el único punto por el que el bucle agéntico llama a una tool,
 * lo que permite:
 *  - publicar al modelo solo los esquemas habilitados (las actions desaparecen
 *    del menú si `COPLOT_ACTIONS_ENABLED=false`),
 *  - y delegar la auditoría al servicio, que recibe `{ family, ok, output }`.
 *
 * Es `@Injectable` y se construye una sola vez; las fábricas de cada familia
 * se invocan en el constructor con los servicios ya inyectados. Cada fábrica es
 * la única fuente de verdad de sus propios esquemas y descripciones.
 */
@Injectable()
export class ToolsRegistry {
  private readonly entries = new Map<string, ToolEntry>();
  private readonly schemas: ToolSchema[] = [];
  private readonly actionsEnabled: boolean;
  /** Capturador de snapshot (de las tools de sistema); null si no se crearon. */
  private readonly snapshotFn: (() => Promise<ConversationSnapshot>) | null;

  constructor(
    config: ConfigService,
    access: AccessControlService,
    accessPoints: AccessPointsService,
    enrollment: EnrollmentService,
    cameras: CamerasService,
    kiosk: KioskRecognitionService,
    vision: VisionServiceClient,
    rotator: CredentialRotatorService,
  ) {
    this.actionsEnabled = config.get<string>('COPLOT_ACTIONS_ENABLED', 'true') !== 'false';

    // 1) Sistema — consultas de solo lectura sobre todo el control de acceso
    //    (empleados, eventos, puntos, cámaras, puerta, salud, credenciales),
    //    más análisis (novedades, resumen operativo) y captura de snapshot.
    const sysDeps: SystemToolDeps = { access, accessPoints, enrollment, cameras, kiosk, vision, rotator };
    const system = createSystemTools(sysDeps);
    this.snapshotFn = system.captureSnapshot;
    for (const s of system.schemas) {
      this.entries.set(s.function.name, {
        family: 'system',
        run: (args, ctx) => system.execute(s.function.name, args, ctx),
      });
    }
    this.schemas.push(...system.schemas);

    // 2) Acción — mutaciones (puerta, credenciales). Solo si están habilitadas:
    //    si no, no se registran entradas ni se publican esquemas, de modo que la
    //    tool es inalcanzable para el modelo aunque "decida" llamarla.
    if (this.actionsEnabled) {
      const actDeps: ActionToolDeps = { access, accessPoints, rotator };
      const action = createActionTools(actDeps);
      for (const s of action.schemas) {
        this.entries.set(s.function.name, {
          family: 'action',
          run: (args, ctx) => action.execute(s.function.name, args, ctx),
        });
      }
      this.schemas.push(...action.schemas);
    }
  }

  /** Esquemas a enviar al modelo (excluye actions si están apagadas). */
  get availableSchemas(): ToolSchema[] {
    return this.schemas;
  }

  get hasActions(): boolean {
    return this.actionsEnabled;
  }

  /** ¿Existe esta tool y está habilitada ahora mismo? */
  has(name: string): boolean {
    return this.entries.has(name);
  }

  /**
   * Ejecuta una tool por nombre, pasándole el contexto del turno (userId,
   * conversación y snapshot previo). Nunca lanza: en error devuelve
   * `{ ok:false, output:'error: …' }`. El servicio decide qué auditar a
   * partir de `family` y `ok`.
   */
  async dispatch(
    name: string,
    args: ToolArgs,
    ctx: ToolContext,
  ): Promise<ToolResult & { family: ToolFamily }> {
    const entry = this.entries.get(name);
    if (!entry) {
      return { ok: false, output: `error: herramienta desconocida ${name}`, family: 'system' };
    }
    const res = await entry.run(args ?? {}, ctx);
    return { ...res, family: entry.family };
  }

  /**
   * Captura un snapshot fresco del sistema para persistirlo al cierre del turno
   * (memoria entre consultas). Lanza si las tools de sistema no se crearon, así
   * el llamador debe atraparlo y simplemente omitir la persistencia.
   */
  async captureSnapshot(): Promise<ConversationSnapshot> {
    if (!this.snapshotFn) throw new Error('snapshot_no_disponible');
    return this.snapshotFn();
  }
}
