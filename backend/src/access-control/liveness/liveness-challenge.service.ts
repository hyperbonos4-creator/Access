import { Injectable, Logger } from '@nestjs/common';

import {
  DEFAULT_CHALLENGE_TTL_MS,
  generateChallenge,
  type LivenessChallenge,
} from './liveness-challenge';

interface StoredChallenge {
  challenge: LivenessChallenge;
  expiresAt: number;
}

/**
 * Ciclo de vida del reto de liveness ACTIVO (anti-replay).
 *
 * URBAN usa Redis (`GETDEL` atómico); aquí, al ser una sola puerta / una sola
 * instancia, se usa un store EN MEMORIA con TTL y consumo de un solo uso. Una
 * clave por sujeto: emitir un reto nuevo invalida el anterior. Si en el futuro
 * se escala a múltiples instancias, sustituir por Redis manteniendo esta API.
 */
@Injectable()
export class LivenessChallengeService {
  private readonly logger = new Logger(LivenessChallengeService.name);
  private readonly store = new Map<string, StoredChallenge>();

  /** Emite (y persiste con TTL) un reto para el sujeto. */
  issue(subjectId: string, opts: { actionCount?: number; ttlMs?: number } = {}): LivenessChallenge {
    this.sweep();
    const ttlMs = opts.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_CHALLENGE_TTL_MS;
    const challenge = generateChallenge({ actionCount: opts.actionCount, ttlMs });
    this.store.set(subjectId, { challenge, expiresAt: challenge.expiresAt });
    return challenge;
  }

  /**
   * Consume el reto del sujeto si coincide el `challengeId` (anti-replay: lo
   * borra SIEMPRE, aunque el id no coincida). `null` si no existe/expiró/no
   * coincide. Fail-secure.
   */
  consume(subjectId: string, challengeId: string): LivenessChallenge | null {
    const entry = this.store.get(subjectId);
    this.store.delete(subjectId); // one-time: se borra pase lo que pase
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) return null;
    if (entry.challenge.challengeId !== challengeId) {
      this.logger.warn(`challengeId no coincide para subject=${subjectId}`);
      return null;
    }
    return entry.challenge;
  }

  /** Limpia retos expirados (evita fuga de memoria en el store en proceso). */
  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.store.entries()) {
      if (now > v.expiresAt) this.store.delete(k);
    }
  }
}
