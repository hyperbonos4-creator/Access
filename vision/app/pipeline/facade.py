"""Fachada del pipeline facial: detección + embedding (G0).

Encapsula InsightFace (`FaceAnalysis`), que agrupa el detector **SCRFD** y el
modelo de embeddings **ArcFace** (`buffalo_l`/`antelopev2`) bajo un único API,
ejecutando sobre el `execution provider` configurado (Req 1.6).

Diseño:
- **Carga perezosa:** los modelos se cargan en el primer uso, no al importar, de
  modo que el contenedor arranca y `/health` responde aunque los pesos aún no
  estén presentes (degradación elegante).
- **Sin estado de dominio:** la fachada no conoce consentimiento ni política de
  acceso; solo transforma imagen → embedding + calidad.

Pendiente por fase:
- G1 (2.1): integrar liveness MiniFASNet como gate previo al embedding.
- G0 (1.2)/G5: selección ArcFace↔AdaFace por tipo de cámara.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from threading import Lock
from typing import Optional

import numpy as np

from ..config import Settings

logger = logging.getLogger("urban-vision.pipeline")


def _warn_if_gpu_degraded_to_cpu(requested_providers: list[str]) -> None:
    """Fail-loud de observabilidad: avisa si se pidió GPU pero ONNX Runtime solo
    tiene CPU disponible.

    `to_ort_providers()` añade `CPUExecutionProvider` como fallback final, de modo
    que pedir CUDA/TensorRT/DirectML en un host sin esa GPU (o sin el paquete
    `onnxruntime-gpu`) NO falla: degrada a CPU en silencio. En CPU el Face ID es
    notablemente más lento, así que el operador debe enterarse al arrancar en vez
    de diagnosticar "lag" a ciegas.
    """
    try:
        import onnxruntime as ort

        available = set(ort.get_available_providers())
    except Exception as exc:  # noqa: BLE001 — nunca romper la carga por el log
        logger.debug("No se pudo consultar los providers de ONNX Runtime: %s", exc)
        return

    gpu_requested = [p for p in requested_providers if p != "CPUExecutionProvider"]
    if gpu_requested and not any(p in available for p in gpu_requested):
        logger.warning(
            "GPU solicitada (%s) NO disponible en el host; ONNX Runtime degradó a "
            "CPU. El reconocimiento facial y el liveness serán notablemente más "
            "lentos. Providers disponibles: %s. Revisa el paquete onnxruntime-gpu "
            "y los drivers de la GPU.",
            gpu_requested,
            sorted(available),
        )
    else:
        logger.info("ONNX Runtime providers disponibles: %s", sorted(available))


@dataclass
class FaceResult:
    """Resultado de procesar una imagen con exactamente un rostro válido."""

    embedding: np.ndarray  # vector L2-normalizado (dim = settings.embedding_dim)
    quality: float  # score de calidad/det en [0,1]


@dataclass
class FaceDetection:
    """Rostro detectado para reconocimiento (no exige exactamente uno)."""

    embedding: np.ndarray
    bbox: tuple[int, int, int, int]  # (x, y, w, h) en píxeles
    quality: float
    # 5 keypoints (ojo izq, ojo der, nariz, boca izq, boca der) en píxeles, si
    # el detector los provee. Usados por el liveness ACTIVO para estimar la pose.
    keypoints: Optional[np.ndarray] = None


class FaceQualityError(Exception):
    """La imagen no contiene un rostro enrolable de calidad suficiente.

    `reason` usa los códigos del contrato (`NO_FACE`/`MULTIPLE_FACES`/`LOW_QUALITY`).
    """

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class PipelineNotReadyError(Exception):
    """Los modelos no pudieron cargarse (pesos ausentes o provider no disponible)."""


class FacePipeline:
    """Fachada thread-safe del pipeline de detección + embedding."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._app = None  # insightface.app.FaceAnalysis, cargado perezosamente
        self._lock = Lock()
        self._load_error: Optional[str] = None

    # ── Estado ───────────────────────────────────────────────────────────
    @property
    def models_loaded(self) -> bool:
        return self._app is not None

    @property
    def load_error(self) -> Optional[str]:
        return self._load_error

    # ── Carga perezosa ──────────────────────────────────────────────────
    def ensure_loaded(self) -> None:
        """Carga los modelos si aún no lo están. Idempotente y thread-safe."""
        if self._app is not None:
            return
        with self._lock:
            if self._app is not None:
                return
            try:
                from insightface.app import FaceAnalysis  # import perezoso

                providers = self._settings.execution_provider.to_ort_providers()
                # `buffalo_l` = SCRFD (det) + ArcFace (rec). root = models_dir.
                app = FaceAnalysis(name="buffalo_l", root=self._settings.models_dir, providers=providers)
                app.prepare(ctx_id=0, det_size=(640, 640))
                self._app = app
                self._load_error = None
                _warn_if_gpu_degraded_to_cpu(providers)
                logger.info(
                    "Pipeline cargado (providers solicitados=%s, model=buffalo_l)", providers
                )
            except Exception as exc:  # noqa: BLE001 — degradación elegante
                self._load_error = str(exc)
                logger.error("No se pudo cargar el pipeline: %s", exc)
                raise PipelineNotReadyError(str(exc)) from exc

    # ── Inferencia ──────────────────────────────────────────────────────
    def embed_single_face(self, image_bgr: np.ndarray) -> FaceResult:
        """Detecta y devuelve el embedding del único rostro de la imagen.

        Reglas de calidad (Req 2.2):
        - 0 rostros → `NO_FACE`
        - >1 rostro → `MULTIPLE_FACES`
        - calidad < umbral → `LOW_QUALITY`
        """
        self.ensure_loaded()
        assert self._app is not None  # garantizado por ensure_loaded

        faces = self._app.get(image_bgr)
        if not faces:
            raise FaceQualityError("NO_FACE")
        if len(faces) > 1:
            raise FaceQualityError("MULTIPLE_FACES")

        face = faces[0]
        quality = float(getattr(face, "det_score", 0.0))
        if quality < self._settings.min_face_quality:
            raise FaceQualityError("LOW_QUALITY")

        embedding = np.asarray(face.normed_embedding, dtype=np.float32)
        return FaceResult(embedding=embedding, quality=quality)

    def primary_face(self, image_bgr: np.ndarray) -> Optional[FaceDetection]:
        """Devuelve el rostro más confiable de la imagen, o None si no hay.

        A diferencia de `embed_single_face` (enrolamiento, exige exactamente un
        rostro), el reconocimiento en vivo acepta varias caras y elige la de
        mayor `det_score`. Devuelve también el bbox para el liveness y la
        metadata de detección del evento.
        """
        self.ensure_loaded()
        assert self._app is not None

        faces = self._app.get(image_bgr)
        if not faces:
            return None

        face = max(faces, key=lambda f: float(getattr(f, "det_score", 0.0)))
        x1, y1, x2, y2 = (int(v) for v in face.bbox)
        bbox = (x1, y1, max(0, x2 - x1), max(0, y2 - y1))
        embedding = np.asarray(face.normed_embedding, dtype=np.float32)
        kps = getattr(face, "kps", None)
        keypoints = np.asarray(kps, dtype=np.float32) if kps is not None else None
        return FaceDetection(
            embedding=embedding,
            bbox=bbox,
            quality=float(getattr(face, "det_score", 0.0)),
            keypoints=keypoints,
        )
