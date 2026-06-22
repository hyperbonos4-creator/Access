/** Decisión de acceso. */
export enum AccessDecision {
  GRANTED = 'GRANTED',
  DENIED = 'DENIED',
}

/** Motivo auditable de la decisión (alineado con `access_events.reason`). */
export enum AccessReason {
  MATCHED = 'MATCHED',
  UNKNOWN_SUBJECT = 'UNKNOWN_SUBJECT',
  LIVENESS_FAILED = 'LIVENESS_FAILED',
  CHALLENGE_REQUIRED = 'CHALLENGE_REQUIRED',
  NOT_AUTHORIZED = 'NOT_AUTHORIZED',
  OUT_OF_SCHEDULE = 'OUT_OF_SCHEDULE',
  NO_CONSENT = 'NO_CONSENT',
  MANUAL = 'MANUAL',
}

/** Evento de dominio in-process emitido tras decidir un acceso (consumible por la UI). */
export const ACCESS_EVENT_DECIDED = 'access.event.decided';

export interface AccessEventDecidedPayload {
  accessEventId: string;
  accessPointId: string;
  subjectId: string | null;
  decision: AccessDecision;
  reason: AccessReason;
  doorActuated: boolean;
  snapshotUrl: string | null;
  recordedAt: Date;
}
