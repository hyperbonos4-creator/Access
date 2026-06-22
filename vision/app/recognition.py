"""Servicio de reconocimiento — orquesta el Recognition_Pipeline (tarea 2.2).

Para un frame de un Access_Point: detecta el rostro principal, evalúa liveness,
genera el embedding, busca 1:N en la colección del conjunto y construye un
`DomainCameraEvent` (camelCase) idéntico al contrato del Backend.

Separación de responsabilidades (design §dos diferencias de postura):
- El Vision_Service **reconoce y reporta**; NO decide abrir. El `label`,
  `score` (match) y `livenessScore` viajan en el evento.
- La **decisión `fail-secure`** (conceder/denegar/actuar puerta) es del Backend.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional, Protocol

import numpy as np

logger = logging.getLogger("urban-vision.recognition")

# Constantes del contrato con el Backend (domain-camera-event.ts).
SOURCE_VISION = "VISION"
PROCESSOR_FACE = "FACE"
EVENT_TYPE_ALERT = "ALERT"
LIVENESS_MODE_PASSIVE = "PASSIVE"


@dataclass
class AccessPointContext:
    """Contexto del Access_Point que procesa el worker."""

    conjunto_id: str
    external_camera_key: str
    processor_name: str = "urban-vision · arcface"
    match_threshold: float = 0.5


class LivenessLike(Protocol):
    def score(self, image_bgr: np.ndarray, bbox: tuple[int, int, int, int]) -> float: ...


class PipelineLike(Protocol):
    def primary_face(self, image_bgr: np.ndarray): ...


class StoreLike(Protocol):
    def search(self, conjunto_id: str, embedding: np.ndarray, limit: int = 1): ...


class RecognitionService:
    """Pipeline de reconocimiento por frame, testeable con dobles."""

    def __init__(self, pipeline: PipelineLike, store: StoreLike, liveness: LivenessLike) -> None:
        self._pipeline = pipeline
        self._store = store
        self._liveness = liveness

    def process_frame(
        self,
        ctx: AccessPointContext,
        image_bgr: np.ndarray,
        track_id: Optional[str] = None,
        recorded_at: Optional[datetime] = None,
    ) -> Optional[dict]:
        """Procesa un frame y devuelve el `DomainCameraEvent` (dict) o None.

        Devuelve None si no hay rostro (no se emite evento). Si hay rostro,
        SIEMPRE devuelve un evento: identificado (`label`=subject) o `unknown`,
        con su `livenessScore`. La decisión la toma el Backend.
        """
        face = self._pipeline.primary_face(image_bgr)
        if face is None:
            return None

        # Liveness: si el modelo no está disponible, score = 0.0 → el Backend
        # aplicará fail-secure (no abrir). Nunca asumimos "vivo" por defecto.
        try:
            liveness_score = self._liveness.score(image_bgr, face.bbox)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Liveness no disponible, score=0.0 (fail-secure): %s", exc)
            liveness_score = 0.0

        hits = self._store.search(ctx.conjunto_id, face.embedding, limit=1)
        subject_id, match_score = hits[0] if hits else ("unknown", 0.0)
        label = subject_id if match_score >= ctx.match_threshold else "unknown"

        ts = recorded_at or datetime.now(timezone.utc)
        track = track_id or str(uuid.uuid4())
        h, w = image_bgr.shape[:2]

        return {
            "source": SOURCE_VISION,
            "processorType": PROCESSOR_FACE,
            "processorName": ctx.processor_name,
            # Idempotencia (Property 5): mismo (accessPoint, track, ts) colapsa.
            "sourceEventId": f"{ctx.external_camera_key}:{track}:{ts.isoformat()}",
            "nvrId": None,
            "nvrChannel": None,
            "externalCameraKey": ctx.external_camera_key,
            "eventType": EVENT_TYPE_ALERT,
            "label": label,
            "score": round(float(match_score), 4),
            "zones": [],
            "trackId": track,
            "detection": {
                "bbox": list(face.bbox),
                "frameWidth": int(w),
                "frameHeight": int(h),
                "livenessScore": round(float(liveness_score), 4),
                "livenessMode": LIVENESS_MODE_PASSIVE,
            },
            "recordedAt": ts.isoformat(),
        }
