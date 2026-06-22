"""Servicio KYC del Vision_Service — spec `resident-onboarding-kyc` (K1/K2).

Orquesta las capacidades de identidad que el Backend consume por el `Vision_Port`:

- `ocr_document`  — extrae número/nombres del documento (RapidOCR).            [K1]
- `liveness`      — anti-spoofing pasivo sobre una sola imagen (MiniFASNet).   [K2]
- `face_match`    — cotejo selfie ↔ retrato del documento (ArcFace, coseno).   [K2]

Separación de responsabilidades (heredada): el Vision_Service **infiere y
reporta**; el Backend **decide** (umbrales, fail-secure, Document_Match contra el
residente). Aquí no vive lógica de dominio ni de consentimiento.

Testeable con dobles: recibe `pipeline`, `liveness` y `ocr` por inyección.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional, Protocol

import numpy as np

from .pipeline.ocr import DocumentFields

logger = logging.getLogger("urban-vision.kyc")


@dataclass
class LivenessResult:
    ok: bool
    score: float
    reason: Optional[str] = None


@dataclass
class FaceMatchResult:
    ok: bool
    match_score: float
    reason: Optional[str] = None


class _PipelineLike(Protocol):
    def primary_face(self, image_bgr: np.ndarray): ...


class _LivenessLike(Protocol):
    def score(self, image_bgr: np.ndarray, bbox: tuple[int, int, int, int]) -> float: ...


class _OcrLike(Protocol):
    def read_lines(self, image_bgr: np.ndarray): ...
    def extract_fields(self, front_lines, back_lines=None) -> DocumentFields: ...


class KycService:
    """Capacidades de identidad (OCR / liveness / face-match) testeables."""

    def __init__(
        self, pipeline: _PipelineLike, liveness: _LivenessLike, ocr: _OcrLike
    ) -> None:
        self._pipeline = pipeline
        self._liveness = liveness
        self._ocr = ocr

    # ── OCR de documento (K1) ────────────────────────────────────────────
    def ocr_document(
        self, front_bgr: np.ndarray, back_bgr: Optional[np.ndarray] = None
    ) -> DocumentFields:
        front_lines = self._ocr.read_lines(front_bgr)
        back_lines = self._ocr.read_lines(back_bgr) if back_bgr is not None else None
        return self._ocr.extract_fields(front_lines, back_lines)

    # ── Liveness pasivo (K2) ─────────────────────────────────────────────
    def liveness(self, image_bgr: np.ndarray, mode: str = "PASSIVE") -> LivenessResult:
        face = self._pipeline.primary_face(image_bgr)
        if face is None:
            return LivenessResult(ok=False, score=0.0, reason="NO_FACE")
        try:
            score = self._liveness.score(image_bgr, face.bbox)
        except Exception as exc:  # noqa: BLE001 — fail-secure: score 0, no "vivo"
            logger.warning("Liveness no disponible (score=0.0): %s", exc)
            return LivenessResult(ok=True, score=0.0, reason="LIVENESS_UNAVAILABLE")
        return LivenessResult(ok=True, score=float(np.clip(score, 0.0, 1.0)))

    # ── Face-match selfie ↔ documento (K2) ───────────────────────────────
    def face_match(
        self, selfie_bgr: np.ndarray, document_bgr: np.ndarray
    ) -> FaceMatchResult:
        selfie_face = self._pipeline.primary_face(selfie_bgr)
        if selfie_face is None:
            return FaceMatchResult(ok=False, match_score=0.0, reason="NO_FACE_SELFIE")
        doc_face = self._pipeline.primary_face(document_bgr)
        if doc_face is None:
            return FaceMatchResult(ok=False, match_score=0.0, reason="NO_FACE_DOCUMENT")

        score = _cosine_similarity(selfie_face.embedding, doc_face.embedding)
        # Coseno en [-1,1] → se reporta recortado a [0,1]; el umbral lo fija el
        # Backend (`conjunto_onboarding_settings.face_document_match_threshold`).
        return FaceMatchResult(ok=True, match_score=round(float(max(0.0, score)), 4))


def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Coseno entre dos embeddings. InsightFace ya los entrega L2-normalizados,
    pero se renormaliza por robustez ante dobles de test no normalizados."""
    a = np.asarray(a, dtype=np.float32)
    b = np.asarray(b, dtype=np.float32)
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))
