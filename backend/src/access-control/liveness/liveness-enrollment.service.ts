import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EnrollmentService } from '../enrollment.service';
import { VisionServiceClient } from '../vision-service.client';
import { LivenessChallengeService } from './liveness-challenge.service';
import {
  centerActionIndex,
  verifyChallengeActions,
  type LivenessAction,
  type LivenessChallenge,
} from './liveness-challenge';

export interface GuidedFrame {
  action: string;
  imageB64: string;
}

export interface GuidedEnrollResult {
  ok: boolean;
  /** Etapa que falló: challenge | sequence | liveness_active | liveness_passive | enroll. */
  stage?: string;
  reason?: string | null;
  failedIndex?: number | null;
  passiveScore?: number;
  livenessOk?: boolean;
  templateId?: string;
}

/**
 * Orquestación del **registro facial guiado por liveness activo** (ADR §3).
 *
 * 1. Consume el reto (anti-replay).
 * 2. Revalida server-side en el Vision (`/liveness/active`): pose por frame +
 *    liveness pasivo (anti-foto) — NO confía en el veredicto del cliente.
 * 3. Verifica la secuencia del reto (acciones, orden, todas cumplidas).
 * 4. Gate fail-secure del liveness pasivo (REJECT si no disponible o bajo umbral).
 * 5. Enrola el embedding del frame `LOOK_CENTER` (frontal limpio).
 *
 * El embedding sale SIEMPRE del frame central; los frames laterales/parpadeo
 * son prueba de vida, no de identidad.
 */
@Injectable()
export class LivenessEnrollmentService {
  private readonly logger = new Logger(LivenessEnrollmentService.name);
  private readonly passiveThreshold: number;
  private readonly requirePassive: boolean;

  constructor(
    private readonly challenges: LivenessChallengeService,
    private readonly vision: VisionServiceClient,
    private readonly enrollment: EnrollmentService,
    config: ConfigService,
  ) {
    this.passiveThreshold = config.get<number>('LIVENESS_THRESHOLD', 0.5);
    // Exigir el anti-spoofing PASIVO (MiniFASNet). En producción debe ser true.
    // En entornos sin los pesos del modelo (p. ej. demo) se puede poner 'false':
    // el reto ACTIVO (giros + parpadeo revalidado) sigue siendo la prueba de vida.
    this.requirePassive =
      config.get<string>('LIVENESS_REQUIRE_PASSIVE', 'true') !== 'false';
  }

  issueChallenge(subjectId: string): LivenessChallenge {
    return this.challenges.issue(subjectId);
  }

  async guidedEnroll(
    subjectId: string,
    challengeId: string,
    frames: GuidedFrame[],
  ): Promise<GuidedEnrollResult> {
    const challenge = this.challenges.consume(subjectId, challengeId);
    if (!challenge) {
      return { ok: false, stage: 'challenge', reason: 'challenge_invalid_or_expired' };
    }

    const actions = frames.map((f) => f.action);
    const framesB64 = frames.map((f) => f.imageB64);

    // Revalidación server-side (pose + liveness pasivo por frame).
    const vr = await this.vision.activeLiveness(framesB64, actions);
    const observed = vr.observed.map((o) => ({
      action: o.action as LivenessAction,
      satisfied: o.satisfied,
    }));

    // Observabilidad (sin imágenes): pose por acción + liveness pasivo del set.
    // Imprescindible para calibrar umbrales (yaw del servidor vs. cliente) y el
    // gate anti-spoofing. No expone biometría.
    this.logger.log(
      `Guiado subject=${subjectId} ` +
        `expected=[${challenge.actions.join(',')}] ` +
        `observed=[${vr.observed
          .map(
            (o) =>
              `${o.action}:${o.satisfied ? 'OK' : 'NO'}(yaw=${o.yawRatio ?? 'n/a'},face=${o.hasFace},live=${o.passiveScore ?? 'n/a'})`,
          )
          .join(' ')}] ` +
        `passiveMin=${vr.passiveScore} centerPassive=${vr.centerPassiveScore}(avail=${vr.centerPassiveAvailable}) ` +
        `threshold=${this.passiveThreshold} visionReason=${vr.reason ?? 'none'}`,
    );

    // Secuencia del reto (acciones, orden exacto, todas cumplidas).
    const seq = verifyChallengeActions({ challenge, observed, now: Date.now() });
    if (!seq.ok) {
      this.logger.warn(
        `Guiado RECHAZO secuencia subject=${subjectId} reason=${seq.reason} failedIndex=${seq.failedIndex}`,
      );
      return {
        ok: false,
        stage: 'sequence',
        reason: seq.reason,
        failedIndex: seq.failedIndex,
        livenessOk: false,
      };
    }

    // Gate fail-secure del liveness pasivo (anti-foto/anti-pantalla).
    // Se evalúa sobre el frame FRONTAL (rostro completo, toma fiable). El mínimo
    // del set hunde a personas reales por los frames de perfil, donde MiniFASNet
    // es poco fiable. El reto conductual (giros + parpadeo, revalidado server-
    // side) es la prueba de vida; el pasivo frontal es la capa anti-textura.
    const passiveGate = vr.centerPassiveAvailable ? vr.centerPassiveScore : vr.passiveScore;
    const passiveOk = vr.centerPassiveAvailable || vr.passiveAvailable;
    if (!passiveOk && this.requirePassive) {
      this.logger.warn(`Guiado RECHAZO liveness no disponible subject=${subjectId}`);
      return { ok: false, stage: 'liveness_passive', reason: 'liveness_unavailable', passiveScore: 0 };
    }
    if (!passiveOk) {
      this.logger.warn(
        `Guiado: anti-spoofing pasivo no disponible; aceptado por reto ACTIVO (LIVENESS_REQUIRE_PASSIVE=false) subject=${subjectId}`,
      );
    }
    if (passiveOk && passiveGate < this.passiveThreshold) {
      this.logger.warn(
        `Guiado RECHAZO spoof subject=${subjectId} passive=${passiveGate} < ${this.passiveThreshold}`,
      );
      return {
        ok: false,
        stage: 'liveness_passive',
        reason: 'spoof_suspected',
        passiveScore: passiveGate,
        livenessOk: false,
      };
    }

    // Enrola el frame frontal (LOOK_CENTER).
    const centerIdx = centerActionIndex(challenge);
    const centerImage = frames[centerIdx]?.imageB64;
    if (!centerImage) {
      return { ok: false, stage: 'enroll', reason: 'missing_center_frame' };
    }

    try {
      const template = await this.enrollment.enroll(subjectId, centerImage);
      this.logger.log(`Registro guiado OK subject=${subjectId} passive=${vr.passiveScore}`);
      return {
        ok: true,
        passiveScore: vr.passiveScore,
        livenessOk: true,
        templateId: template.id,
      };
    } catch (err) {
      // Rechazo de calidad del Vision (NO_FACE/LOW_QUALITY/…) o sin consentimiento.
      const e = err as { response?: { reason?: string }; message?: string };
      const reason = e?.response?.reason ?? e?.message ?? 'enroll_failed';
      return { ok: false, stage: 'enroll', reason, passiveScore: vr.passiveScore, livenessOk: true };
    }
  }
}
