"""Lectura de placas (LPR) — G6, tarea 7.1.

Pipeline ALPR basado en `fast-alpr` (detección de placa + OCR, ONNX), como
módulo adicional del mismo Vision_Service (no un servicio aparte). Habilitable
de forma independiente del pipeline facial.

Diseño coherente con el resto del servicio:
- **Carga perezosa** del modelo, con degradación elegante.
- **Seam de inferencia** (`_run`) inyectable para testear el contrato sin pesos.
- Emite, vía `recognition`/`emitter`, un `DomainCameraEvent` con `label = <placa>`
  y `processorType = LPR` (el Backend decide contra `vehicle_plates`).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from threading import Lock
from typing import Optional

import numpy as np

from ..config import Settings

logger = logging.getLogger("urban-vision.lpr")

# Placas Colombia: 3 letras + 3 dígitos (carro) o 3 letras + 2 dígitos + 1 letra
# (moto). Normalizamos a mayúsculas sin separadores.
_PLATE_RE = re.compile(r"^[A-Z]{3}[0-9]{2,3}[A-Z]?$")


@dataclass
class PlateResult:
    text: str
    confidence: float


class LprNotReadyError(Exception):
    """El modelo LPR no pudo cargarse (peso ausente / provider)."""


class LprPipeline:
    """Lector de placas, thread-safe y de carga perezosa."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._alpr = None
        self._lock = Lock()
        self._load_error: Optional[str] = None

    @property
    def models_loaded(self) -> bool:
        return self._alpr is not None

    @property
    def load_error(self) -> Optional[str]:
        return self._load_error

    def ensure_loaded(self) -> None:
        if self._alpr is not None:
            return
        with self._lock:
            if self._alpr is not None:
                return
            try:
                from fast_alpr import ALPR  # import perezoso

                self._alpr = ALPR(
                    detector_model="yolo-v9-t-384-license-plate-end2end",
                    ocr_model="global-plates-mobile-vit-v2-model",
                )
                self._load_error = None
                logger.info("LPR (fast-alpr) cargado")
            except Exception as exc:  # noqa: BLE001
                self._load_error = str(exc)
                logger.error("No se pudo cargar LPR: %s", exc)
                raise LprNotReadyError(str(exc)) from exc

    def read_plate(self, image_bgr: np.ndarray) -> Optional[PlateResult]:
        """Devuelve la placa más confiable de la imagen, o None si no hay."""
        self.ensure_loaded()
        results = self._run(image_bgr)
        best: Optional[PlateResult] = None
        for text, conf in results:
            normalized = self.normalize_plate(text)
            if not normalized:
                continue
            if best is None or conf > best.confidence:
                best = PlateResult(text=normalized, confidence=float(conf))
        return best

    def _run(self, image_bgr: np.ndarray) -> list[tuple[str, float]]:
        """Ejecuta fast-alpr y devuelve [(texto, confianza)]. Seam testeable."""
        assert self._alpr is not None
        out: list[tuple[str, float]] = []
        for r in self._alpr.predict(image_bgr):
            ocr = getattr(r, "ocr", None)
            if ocr and getattr(ocr, "text", None):
                out.append((ocr.text, float(getattr(ocr, "confidence", 0.0))))
        return out

    @staticmethod
    def normalize_plate(text: str) -> Optional[str]:
        """Normaliza (mayúsculas, sin separadores) y valida formato CO."""
        cleaned = re.sub(r"[^A-Za-z0-9]", "", text or "").upper()
        return cleaned if _PLATE_RE.match(cleaned) else None
