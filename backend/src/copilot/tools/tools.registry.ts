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

/** Marca de cada familia, para auditar/limitar por categoría si hace falta. */
export type ToolFamily = 'system' | 'action';

/** Entrada del registro: familia + ejecutor atribuido al usuario. */
interface ToolEntry {
  family: ToolFamily;
  /** Ejecuta la tool; `userId` es el admin que dispara la conversación. */
  run: (args: ToolArgs, userId: string) => Promise<ToolResult>;
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
    //    (empleados, eventos, puntos, cámaras, puerta, salud, credenciales).
    const sysDeps: SystemToolDeps = { access, accessPoints, enrollment, cameras, kiosk, vision, rotator };
    const system = createSystemTools(sysDeps);
    for (const s of system.schemas) {
      this.entries.set(s.function.name, {
        family: 'system',
        run: (args) => system.execute(s.function.name, args),
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
          run: (args, userId) => action.execute(s.function.name, args, userId),
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
   * Ejecuta una tool por nombre, atribuyéndola al `userId`. Nunca lanza: en
   * error devuelve `{ ok:false, output:'error: …' }`. El servicio decide qué
   * auditar a partir de `family` y `ok`.
   */
  async dispatch(
    name: string,
    args: ToolArgs,
    userId: string,
  ): Promise<ToolResult & { family: ToolFamily }> {
    const entry = this.entries.get(name);
    if (!entry) {
      return { ok: false, output: `error: herramienta desconocida ${name}`, family: 'system' };
    }
    const res = await entry.run(args ?? {}, userId);
    return { ...res, family: entry.family };
  }
}
