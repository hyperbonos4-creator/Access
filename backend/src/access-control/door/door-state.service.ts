import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Estados del ciclo físico de la puerta (maglock + re-bloqueo automático). */
export type DoorState = 'CLOSED' | 'OPENING' | 'OPEN' | 'CLOSING';

export interface DoorStatus {
  accessPointId: string;
  state: DoorState;
  /** ms en el estado actual. */
  sinceMs: number;
  /** ms restantes de la ventana de apertura (solo en OPEN). */
  remainingMs: number;
  /** ventana de apertura configurada. */
  holdMs: number;
  lastOpenedBy: string | null;
  lastOpenedAt: string | null;
}

interface DoorRuntime {
  state: DoorState;
  since: number;
  holdMs: number;
  lastOpenedBy: string | null;
  lastOpenedAt: number | null;
  timers: NodeJS.Timeout[];
}

/**
 * `DoorStateService` — máquina de estados de puerta en memoria, fuente de verdad
 * del **estado en vivo** que ve el kiosko/admin (CERRADA→ABRIENDO→ABIERTA→
 * CERRANDO→CERRADA con re-bloqueo automático).
 *
 * Modela el pulso de apertura + el re-bloqueo temporizado del maglock para poder
 * hacer demos reales SIN hardware (modo `SIMULATED`). Cuando exista el ESP32 con
 * sensor de puerta, este estado se alimentará del sensor real; el contrato de UI
 * no cambia (misma abstracción que `door-controller.port.ts`).
 *
 * Es una vista efímera (no persiste): la auditoría real vive en `AccessEvent`.
 */
@Injectable()
export class DoorStateService {
  private readonly logger = new Logger(DoorStateService.name);
  private static readonly OPENING_MS = 700;
  private static readonly CLOSING_MS = 900;
  private readonly defaultHoldMs: number;
  private readonly doors = new Map<string, DoorRuntime>();

  constructor(config: ConfigService) {
    this.defaultHoldMs = config.get<number>('DOOR_OPEN_HOLD_MS', 6000);
  }

  /**
   * Pulso de apertura: ABRIENDO → ABIERTA → (holdMs) → CERRANDO → CERRADA.
   * Idempotente ante repeticiones: reinicia la ventana de apertura (la persona
   * sigue frente a la puerta) sin reencadenar transiciones colgadas.
   */
  pulse(accessPointId: string, opts: { openedBy?: string | null; holdMs?: number } = {}): void {
    const holdMs = opts.holdMs && opts.holdMs > 0 ? opts.holdMs : this.defaultHoldMs;
    const door = this.ensure(accessPointId);
    this.clearTimers(door);
    door.holdMs = holdMs;
    door.lastOpenedBy = opts.openedBy ?? door.lastOpenedBy ?? null;
    door.lastOpenedAt = Date.now();

    this.transition(door, 'OPENING');
    door.timers.push(
      setTimeout(() => {
        this.transition(door, 'OPEN');
        door.timers.push(
          setTimeout(() => {
            this.transition(door, 'CLOSING');
            door.timers.push(
              setTimeout(() => this.transition(door, 'CLOSED'), DoorStateService.CLOSING_MS),
            );
          }, holdMs),
        );
      }, DoorStateService.OPENING_MS),
    );
    this.logger.log(
      `Puerta ${accessPointId}: pulso de apertura (hold=${holdMs}ms, por=${door.lastOpenedBy ?? 'n/a'})`,
    );
  }

  getStatus(accessPointId: string): DoorStatus {
    const door = this.ensure(accessPointId);
    const now = Date.now();
    const sinceMs = now - door.since;
    const remainingMs =
      door.state === 'OPEN' ? Math.max(0, door.holdMs - sinceMs) : 0;
    return {
      accessPointId,
      state: door.state,
      sinceMs,
      remainingMs,
      holdMs: door.holdMs,
      lastOpenedBy: door.lastOpenedBy,
      lastOpenedAt: door.lastOpenedAt ? new Date(door.lastOpenedAt).toISOString() : null,
    };
  }

  private ensure(accessPointId: string): DoorRuntime {
    let door = this.doors.get(accessPointId);
    if (!door) {
      door = {
        state: 'CLOSED',
        since: Date.now(),
        holdMs: this.defaultHoldMs,
        lastOpenedBy: null,
        lastOpenedAt: null,
        timers: [],
      };
      this.doors.set(accessPointId, door);
    }
    return door;
  }

  private transition(door: DoorRuntime, state: DoorState): void {
    door.state = state;
    door.since = Date.now();
  }

  private clearTimers(door: DoorRuntime): void {
    for (const t of door.timers) clearTimeout(t);
    door.timers = [];
  }
}
