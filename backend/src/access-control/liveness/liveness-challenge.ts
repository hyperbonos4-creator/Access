import { randomUUID } from 'crypto';

/**
 * Reto-respuesta de liveness ACTIVO — lógica PURA y testeable (portada del ADR
 * `facial-liveness-architecture` §3 de URBAN).
 *
 * El servidor emite una secuencia ALEATORIA de acciones que la persona ejecuta
 * en vivo frente a la cámara. El cliente verifica on-device (MediaPipe), pero el
 * servidor REVALIDA (vía Vision `/liveness/active`) y decide aquí. Anti-replay:
 * cada reto se consume una sola vez (`LivenessChallengeService`).
 */

export type LivenessAction = 'LOOK_LEFT' | 'LOOK_RIGHT' | 'LOOK_CENTER' | 'BLINK';

export const MIN_CHALLENGE_ACTIONS = 3;
export const MAX_CHALLENGE_ACTIONS = 4;
export const DEFAULT_CHALLENGE_ACTIONS = 4;
export const DEFAULT_CHALLENGE_TTL_MS = 90_000;

export interface LivenessChallenge {
  challengeId: string;
  /** Secuencia ordenada; SIEMPRE termina en `LOOK_CENTER` (frame del embedding). */
  actions: LivenessAction[];
  issuedAt: number;
  expiresAt: number;
}

export interface GenerateChallengeOptions {
  actionCount?: number;
  ttlMs?: number;
  now?: number;
  rng?: () => number;
  idFactory?: () => string;
}

function clampActionCount(value: number | undefined): number {
  const n = Math.trunc(value ?? DEFAULT_CHALLENGE_ACTIONS);
  if (Number.isNaN(n)) return DEFAULT_CHALLENGE_ACTIONS;
  return Math.min(MAX_CHALLENGE_ACTIONS, Math.max(MIN_CHALLENGE_ACTIONS, n));
}

/**
 * Genera un reto. SIEMPRE incluye `LOOK_LEFT` y `LOOK_RIGHT` (ángulos para el
 * enrolamiento multi-pose) y, con count>=4, `BLINK` (prueba de vida extra). La
 * última acción SIEMPRE es `LOOK_CENTER` (frame frontal limpio para el
 * embedding). El ORDEN de los movimientos se aleatoriza (Fisher–Yates) +
 * `challengeId` de un solo uso → anti-replay.
 */
export function generateChallenge(opts: GenerateChallengeOptions = {}): LivenessChallenge {
  const rng = opts.rng ?? Math.random;
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_CHALLENGE_TTL_MS;
  const count = clampActionCount(opts.actionCount);

  const movements: LivenessAction[] = ['LOOK_LEFT', 'LOOK_RIGHT'];
  if (count - 1 >= 3) movements.push('BLINK');

  for (let i = movements.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1)) % (i + 1);
    [movements[i], movements[j]] = [movements[j], movements[i]];
  }
  const actions: LivenessAction[] = [...movements, 'LOOK_CENTER'];

  const challengeId = opts.idFactory ? opts.idFactory() : randomUUID();
  return { challengeId, actions, issuedAt: now, expiresAt: now + ttlMs };
}

export interface ObservedAction {
  action: LivenessAction;
  satisfied: boolean;
}

export interface VerifyChallengeInput {
  challenge: LivenessChallenge;
  observed: ObservedAction[];
  now: number;
}

export interface VerifyChallengeResult {
  ok: boolean;
  reason: null | 'challenge_expired' | 'sequence_mismatch' | 'action_failed';
  failedIndex: number | null;
}

/**
 * Valida la parte ACTIVA del reto: no expirado, secuencia observada coincide
 * EXACTAMENTE (acciones y orden) con la emitida, y todas se cumplieron.
 */
export function verifyChallengeActions(input: VerifyChallengeInput): VerifyChallengeResult {
  const { challenge, observed, now } = input;
  if (now > challenge.expiresAt) {
    return { ok: false, reason: 'challenge_expired', failedIndex: null };
  }
  if (observed.length !== challenge.actions.length) {
    return { ok: false, reason: 'sequence_mismatch', failedIndex: null };
  }
  for (let i = 0; i < challenge.actions.length; i++) {
    if (observed[i].action !== challenge.actions[i]) {
      return { ok: false, reason: 'sequence_mismatch', failedIndex: i };
    }
  }
  for (let i = 0; i < observed.length; i++) {
    if (!observed[i].satisfied) {
      return { ok: false, reason: 'action_failed', failedIndex: i };
    }
  }
  return { ok: true, reason: null, failedIndex: null };
}

/** Índice del frame frontal (LOOK_CENTER) del que sale el embedding. */
export function centerActionIndex(challenge: LivenessChallenge): number {
  return challenge.actions.lastIndexOf('LOOK_CENTER');
}
