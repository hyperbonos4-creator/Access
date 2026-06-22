"""Liveness ACTIVO server-side — revalidación del reto (ADR §3).

Para cada frame clave (uno por acción del reto), el servicio:
1. Detecta el rostro principal.
2. Estima la pose (yaw) y decide si la acción pedida se cumplió (coarse).
3. Evalúa el liveness pasivo del frame (segunda capa anti-spoof).

El servicio **reporta**; el Backend **decide** (combina con su `verifyChallenge`
y la política fail-secure). No confía en el veredicto del cliente.

Testeable con dobles: recibe `pipeline` y `liveness` por inyección.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import List, Optional, Protocol, Sequence

import numpy as np

from .pipeline.headpose import classify_action, estimate_yaw_ratio

logger = logging.getLogger("urban-vision.active-liveness")


def _cosine(a: np.ndarray, b: np.ndarray) -> Optional[float]:
    """Coseno entre dos embeddings; `None` si alguno es degenerado (norma ~0)."""
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na < 1e-8 or nb < 1e-8:
        return None
    return float(np.dot(a, b) / (na * nb))


@dataclass
class ActionObservation:
    action: str
    satisfied: bool
    yaw_ratio: Optional[float] = None
    has_face: bool = True
    # Liveness pasivo (anti-spoof) de ESTE frame; `None` si no se pudo evaluar.
    passive_score: Optional[float] = None


@dataclass
class ActiveLivenessResult:
    ok: bool
    observed: List[ActionObservation] = field(default_factory=list)
    passive_score: float = 0.0
    passive_available: bool = True
    reason: Optional[str] = None
    # Liveness pasivo del fotograma FRONTAL (LOOK_CENTER): es la toma fiable para
    # el anti-spoofing de textura (rostro completo). El Backend prefiere gatear
    # aquí; el mínimo del set hunde a personas reales por los frames de perfil.
    center_passive_score: float = 0.0
    center_passive_available: bool = False
    # Consistencia de identidad entre frames (L3): similitud coseno mínima del
    # frame CENTER contra los demás frames del reto. El Vision SOLO reporta; el
    # Backend decide (umbral por conjunto, opt-in). `available=False` => no se
    # pudo evaluar (sin CENTER o sin embeddings válidos) y no debe penalizar.
    identity_min_similarity: float = 1.0
    identity_available: bool = False


class _PipelineLike(Protocol):
    def primary_face(self, image_bgr: np.ndarray): ...


class _LivenessLike(Protocol):
    def score(self, image_bgr: np.ndarray, bbox: tuple[int, int, int, int]) -> float: ...


class ActiveLivenessService:
    def __init__(self, pipeline: _PipelineLike, liveness: _LivenessLike) -> None:
        self._pipeline = pipeline
        self._liveness = liveness

    def verify(
        self,
        frames_bgr: Sequence[np.ndarray],
        actions: Sequence[str],
    ) -> ActiveLivenessResult:
        if len(frames_bgr) != len(actions):
            return ActiveLivenessResult(ok=False, reason="FRAME_COUNT_MISMATCH")

        observed: List[ActionObservation] = []
        passive_scores: List[float] = []
        passive_available = True
        any_no_face = False
        # (acción, embedding) de frames con rostro y embedding válido (L3).
        embeddings: List[tuple[str, np.ndarray]] = []
        center_passive: Optional[float] = None

        for frame, action in zip(frames_bgr, actions):
            face = self._pipeline.primary_face(frame)
            has_face = face is not None
            if not has_face:
                any_no_face = True
            yaw = (
                estimate_yaw_ratio(getattr(face, "keypoints", None))
                if has_face
                else None
            )
            satisfied = classify_action(action, yaw, has_face)

            frame_passive: Optional[float] = None
            if has_face:
                emb = getattr(face, "embedding", None)
                if emb is not None:
                    emb = np.asarray(emb, dtype=np.float32)
                    if float(np.linalg.norm(emb)) > 1e-6:
                        embeddings.append((action, emb))
                try:
                    frame_passive = float(self._liveness.score(frame, face.bbox))
                    passive_scores.append(frame_passive)
                    if action == "LOOK_CENTER":
                        center_passive = frame_passive
                except Exception as exc:  # noqa: BLE001 — modelo ausente/caído
                    logger.warning("Liveness pasivo no disponible: %s", exc)
                    passive_available = False

            observed.append(
                ActionObservation(
                    action=action,
                    satisfied=satisfied,
                    yaw_ratio=None if yaw is None else round(yaw, 4),
                    has_face=has_face,
                    passive_score=None if frame_passive is None else round(frame_passive, 4),
                )
            )

        # Consistencia de identidad (L3): coseno mínimo CENTER↔demás frames.
        identity_min_similarity, identity_available = _identity_consistency(embeddings)

        # El liveness pasivo del conjunto es el MÍNIMO de los frames (el más
        # débil manda) — fail-secure. 0.0 si no hubo ninguno evaluable.
        passive_score = min(passive_scores) if passive_scores else 0.0
        all_satisfied = all(o.satisfied for o in observed)
        reason = "NO_FACE" if any_no_face else (None if all_satisfied else "ACTION_FAILED")
        return ActiveLivenessResult(
            ok=all_satisfied and not any_no_face,
            observed=observed,
            passive_score=round(passive_score, 4),
            passive_available=passive_available,
            reason=reason,
            center_passive_score=round(center_passive, 4) if center_passive is not None else 0.0,
            center_passive_available=center_passive is not None,
            identity_min_similarity=identity_min_similarity,
            identity_available=identity_available,
        )


def _identity_consistency(
    embeddings: Sequence[tuple[str, np.ndarray]],
) -> tuple[float, bool]:
    """Similitud coseno mínima del frame CENTER contra los demás (L3).

    Devuelve `(min_similarity, available)`. `available=False` si no hay un
    frame CENTER con embedding válido o no hay otros frames con embedding (p. ej.
    dobles de test con embeddings nulos): en ese caso no hay señal y se devuelve
    `1.0` para no penalizar (el gate del Backend es opt-in).
    """
    center = next((e for a, e in embeddings if a == "LOOK_CENTER"), None)
    if center is None:
        return 1.0, False
    others = [e for a, e in embeddings if a != "LOOK_CENTER"]
    sims: List[float] = []
    cn = float(np.linalg.norm(center))
    if cn <= 1e-6:
        return 1.0, False
    for emb in others:
        en = float(np.linalg.norm(emb))
        if en <= 1e-6:
            continue
        sims.append(float(np.dot(center, emb) / (cn * en)))
    if not sims:
        return 1.0, False
    return round(min(sims), 4), True
