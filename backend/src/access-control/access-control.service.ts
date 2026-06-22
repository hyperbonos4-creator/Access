import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ConsentService } from './consent.service';
import {
  AccessDecision,
  AccessReason,
  ACCESS_EVENT_DECIDED,
  AccessEventDecidedPayload,
} from './access-control.types';
import { AccessEvent } from './entities/access-event.entity';
import { AccessPoint } from './entities/access-point.entity';
import { EnrolledSubject } from './entities/enrolled-subject.entity';
import {
  AuthorizationSchedule,
  SubjectAuthorization,
} from './entities/subject-authorization.entity';
import { DOOR_CONTROLLER } from './door/door-controller.port';
import type { DoorControllerPort } from './door/door-controller.port';
import { DoorStateService } from './door/door-state.service';
import { TenantContext } from '../common/tenant/tenant-context.service';

interface DecisionOutcome {
  decision: AccessDecision;
  reason: AccessReason;
  subjectId: string | null;
}

/**
 * `AccessControlService` — corazón del control de acceso.
 *
 * Aplica la **política de dominio** con precedencia **fail-secure** y, solo si
 * concede, solicita la apertura de la puerta. Persiste un Access_Event
 * append-only y emite un evento de dominio para la UI.
 *
 * Invariante: NINGÚN camino degradado abre la puerta. Liveness bajo, identidad
 * desconocida, sin consentimiento, score bajo o falta de autorización ⇒
 * `DENIED` y `door_actuated=false`.
 */
@Injectable()
export class AccessControlService {
  private readonly logger = new Logger(AccessControlService.name);

  constructor(
    @InjectRepository(AccessPoint)
    private readonly accessPoints: Repository<AccessPoint>,
    @InjectRepository(SubjectAuthorization)
    private readonly authorizations: Repository<SubjectAuthorization>,
    @InjectRepository(AccessEvent)
    private readonly accessEvents: Repository<AccessEvent>,
    @InjectRepository(EnrolledSubject)
    private readonly subjects: Repository<EnrolledSubject>,
    private readonly consents: ConsentService,
    @Inject(DOOR_CONTROLLER)
    private readonly door: DoorControllerPort,
    private readonly doorState: DoorStateService,
    private readonly emitter: EventEmitter2,
    private readonly tenant: TenantContext,
  ) {}

  /**
   * Aplica `decide()` a una lectura facial, actúa la puerta solo si concede
   * (fail-secure) y persiste/emite el Access_Event. Devuelve el evento + el
   * outcome para que el kiosko muestre el veredicto al instante.
   */
  async evaluateFaceAndActuate(input: {
    ap: AccessPoint;
    label: string | null;
    matchScore: number;
    livenessScore: number;
    livenessMode?: string;
    snapshotUrl?: string | null;
    recordedAt?: Date;
  }): Promise<{ event: AccessEvent; outcome: DecisionOutcome }> {
    const outcome = await this.decide(
      input.ap,
      input.label,
      input.matchScore,
      input.livenessScore,
      input.livenessMode ?? 'PASSIVE',
    );

    let doorActuated = false;
    if (outcome.decision === AccessDecision.GRANTED) {
      const result = await this.door.open(input.ap);
      doorActuated = result.actuated;
      if (doorActuated) {
        // Estado en vivo de la puerta (ABRIENDO→ABIERTA→re-bloqueo) para el kiosko.
        const name = outcome.subjectId
          ? (await this.subjects.findOne({ where: { id: outcome.subjectId, demoSessionId: this.tenant.scopeValue() } }))?.fullName ?? null
          : null;
        this.doorState.pulse(input.ap.id, { openedBy: name });
      } else {
        this.logger.warn(
          `Acceso concedido pero el actuador no abrió (ap=${input.ap.id}): ${result.detail ?? 'sin detalle'}`,
        );
      }
    }

    const event = await this.persistAndEmit({
      accessPointId: input.ap.id,
      subjectId: outcome.subjectId,
      matchScore: input.matchScore,
      livenessScore: input.livenessScore,
      livenessMode: input.livenessMode ?? 'PASSIVE',
      decision: outcome.decision,
      reason: outcome.reason,
      doorActuated,
      actorId: null,
      snapshotUrl: input.snapshotUrl ?? null,
      recordedAt: input.recordedAt ?? new Date(),
    });
    return { event, outcome };
  }

  /**
   * Política de decisión con precedencia fail-secure. El orden importa: el
   * liveness se evalúa antes que la autorización para que un intento con una
   * foto de un empleado real se deniegue como `LIVENESS_FAILED` (anti-spoofing).
   */
  async decide(
    ap: AccessPoint,
    label: string | null,
    matchScore: number,
    livenessScore: number,
    livenessMode = 'PASSIVE',
  ): Promise<DecisionOutcome> {
    const deny = (reason: AccessReason, subjectId: string | null = null): DecisionOutcome => ({
      decision: AccessDecision.DENIED,
      reason,
      subjectId,
    });

    // 1. Identidad: desconocido o por debajo del umbral de match.
    if (!label || label === 'unknown' || matchScore < Number(ap.matchThreshold)) {
      return deny(AccessReason.UNKNOWN_SUBJECT);
    }

    const subject = await this.subjects.findOne({
      where: { id: label, demoSessionId: this.tenant.scopeValue() },
    });
    if (!subject) return deny(AccessReason.UNKNOWN_SUBJECT);
    if (subject.status !== 'ACTIVE') return deny(AccessReason.NOT_AUTHORIZED, subject.id);

    // 2. Liveness (gate anti-spoofing) — antes que autorización.
    if (livenessScore < Number(ap.livenessThreshold)) {
      return deny(AccessReason.LIVENESS_FAILED, subject.id);
    }

    // 2b. Puntos de seguridad alta exigen reto ACTIVO (parpadeo/giro).
    if (ap.securityLevel === 'HIGH' && livenessMode !== 'ACTIVE') {
      return deny(AccessReason.CHALLENGE_REQUIRED, subject.id);
    }

    // 3. Consentimiento vigente (defensivo; sin él no debería haber plantilla).
    const consented = await this.consents.hasActiveConsent(subject.id);
    if (!consented) return deny(AccessReason.NO_CONSENT, subject.id);

    // 4. Autorización en este punto.
    const auth = await this.authorizations.findOne({
      where: { subjectId: subject.id, accessPointId: ap.id },
    });
    if (!auth) return deny(AccessReason.NOT_AUTHORIZED, subject.id);

    // 5. Franja horaria.
    if (!this.isWithinSchedule(auth.schedule, new Date())) {
      return deny(AccessReason.OUT_OF_SCHEDULE, subject.id);
    }

    return { decision: AccessDecision.GRANTED, reason: AccessReason.MATCHED, subjectId: subject.id };
  }

  /** `null`/sin ventana => 24/7. Evalúa día y rango "HH:mm". */
  isWithinSchedule(schedule: AuthorizationSchedule | null, when: Date): boolean {
    if (!schedule) return true;
    if (schedule.days && schedule.days.length > 0 && !schedule.days.includes(when.getDay())) {
      return false;
    }
    if (schedule.from && schedule.to) {
      const minutes = when.getHours() * 60 + when.getMinutes();
      const [fh, fm] = schedule.from.split(':').map(Number);
      const [th, tm] = schedule.to.split(':').map(Number);
      const from = fh * 60 + fm;
      const to = th * 60 + tm;
      if (minutes < from || minutes > to) return false;
    }
    return true;
  }

  /** Apertura manual por un operador tras una denegación (auditada). */
  async manualOpen(accessEventId: string, actorId: string): Promise<AccessEvent> {
    const denied = await this.accessEvents.findOne({
      where: { id: accessEventId, demoSessionId: this.tenant.scopeValue() },
    });
    if (!denied) throw new NotFoundException('access_event_not_found');

    const ap = await this.accessPoints.findOne({
      where: { id: denied.accessPointId, demoSessionId: this.tenant.scopeValue() },
    });
    if (!ap) throw new NotFoundException('access_point_not_found');

    const result = await this.door.open(ap);
    if (result.actuated) this.doorState.pulse(ap.id, { openedBy: 'Operador (apertura manual)' });
    return this.persistAndEmit({
      accessPointId: ap.id,
      subjectId: denied.subjectId,
      matchScore: null,
      livenessScore: null,
      livenessMode: null,
      decision: AccessDecision.GRANTED,
      reason: AccessReason.MANUAL,
      doorActuated: result.actuated,
      actorId,
      snapshotUrl: denied.snapshotUrl,
      recordedAt: new Date(),
    });
  }

  /** Apertura de prueba directa (admin) — valida el actuador y anima la puerta. */
  async testOpenDoor(
    accessPointId: string,
    actorId: string,
  ): Promise<{ actuated: boolean; status: ReturnType<DoorStateService['getStatus']> }> {
    const ap = await this.accessPoints.findOne({
      where: { id: accessPointId, demoSessionId: this.tenant.scopeValue() },
    });
    if (!ap) throw new NotFoundException('access_point_not_found');
    const result = await this.door.open(ap);
    if (result.actuated) this.doorState.pulse(ap.id, { openedBy: 'Prueba (admin)' });
    await this.persistAndEmit({
      accessPointId: ap.id,
      subjectId: null,
      matchScore: null,
      livenessScore: null,
      livenessMode: null,
      decision: result.actuated ? AccessDecision.GRANTED : AccessDecision.DENIED,
      reason: AccessReason.MANUAL,
      doorActuated: result.actuated,
      actorId,
      snapshotUrl: null,
      recordedAt: new Date(),
    });
    return { actuated: result.actuated, status: this.doorState.getStatus(ap.id) };
  }

  /** Estado en vivo de la puerta para el kiosko/admin. */
  doorStatus(accessPointId: string): ReturnType<DoorStateService['getStatus']> {
    return this.doorState.getStatus(accessPointId);
  }

  /** Ping trivial a la base de datos para el panel de diagnóstico. */
  async pingDb(): Promise<{ ok: boolean }> {
    try {
      await this.accessEvents.count();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  /** Feed/histórico de eventos de acceso, paginado. */
  listEvents(
    filters: { accessPointId?: string; decision?: string; limit?: number } = {},
  ): Promise<AccessEvent[]> {
    const where: Record<string, unknown> = { demoSessionId: this.tenant.scopeValue() };
    if (filters.accessPointId) where.accessPointId = filters.accessPointId;
    if (filters.decision) where.decision = filters.decision;
    return this.accessEvents.find({
      where,
      order: { recordedAt: 'DESC' },
      take: Math.min(filters.limit ?? 50, 200),
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────
  private async persistAndEmit(data: {
    accessPointId: string;
    subjectId: string | null;
    matchScore: number | null;
    livenessScore: number | null;
    livenessMode: string | null;
    decision: AccessDecision;
    reason: AccessReason;
    doorActuated: boolean;
    actorId: string | null;
    snapshotUrl: string | null;
    recordedAt: Date;
  }): Promise<AccessEvent> {
    const row = this.accessEvents.create({
      accessPointId: data.accessPointId,
      subjectId: data.subjectId,
      demoSessionId: this.tenant.demoSessionId(),
      matchScore: data.matchScore,
      livenessScore: data.livenessScore,
      livenessMode: data.livenessMode,
      decision: data.decision,
      reason: data.reason,
      doorActuated: data.doorActuated,
      actorId: data.actorId,
      snapshotUrl: data.snapshotUrl,
      recordedAt: data.recordedAt,
    });
    const saved = await this.accessEvents.save(row);

    const payload: AccessEventDecidedPayload = {
      accessEventId: saved.id,
      accessPointId: saved.accessPointId,
      subjectId: saved.subjectId,
      decision: data.decision,
      reason: data.reason,
      doorActuated: data.doorActuated,
      snapshotUrl: saved.snapshotUrl,
      recordedAt: saved.recordedAt,
    };
    this.emitter.emit(ACCESS_EVENT_DECIDED, payload);
    return saved;
  }
}
