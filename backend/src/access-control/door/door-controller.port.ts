import { AccessPoint } from '../entities/access-point.entity';

/** Resultado de una orden de apertura. `actuated=false` => puerta NO abierta. */
export interface DoorActuationResult {
  actuated: boolean;
  detail?: string;
}

/**
 * Puerto de actuación de puerta. El dominio solicita la apertura por esta
 * abstracción; nunca cablea el hardware directamente. Implementaciones: relé de
 * red (ESP32/Shelly por HTTP), terminal Hikvision por ISAPI, simulado.
 *
 * Contrato fail-secure: ante cualquier fallo, la implementación devuelve
 * `{ actuated: false }` (nunca abre "por las dudas"); el caller registra el
 * intento sin marcar acceso físico concedido.
 */
export interface DoorControllerPort {
  open(accessPoint: AccessPoint): Promise<DoorActuationResult>;
}

/** Token de inyección del puerto (permite sustituir la implementación). */
export const DOOR_CONTROLLER = Symbol('DOOR_CONTROLLER');
