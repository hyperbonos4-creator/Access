"""Anti-spoofing / liveness pasivo (MiniFASNet / Silent-Face) — tarea 2.1.

Produce un `liveness_score` en [0,1] a partir de un frame BGR y el bbox del
rostro. El gate de apertura lo aplica el Backend (fail-secure, dominio): el
Vision_Service solo reporta el score; nunca decide abrir.

Modelo: **ensemble Silent-Face** (minivision-ai) — MiniFASNetV2 (crop scale 2.7)
+ MiniFASNetV1SE (crop scale 4.0), exportados a ONNX. Cada modelo emite logits de
3 clases (spoof2D / real / spoof3D); el `liveness_score` es la media de la
probabilidad de la clase `real` entre los modelos cargados. Combinar dos escalas
de contexto es la receta del repo original y sube la robustez frente a foto/
pantalla respecto a un solo modelo.

Diseño:
- **Carga perezosa** desde `models_dir`, con degradación elegante (el servicio
  arranca aunque falten pesos). Si NINGÚN modelo carga → `LivenessNotReadyError`
  y el Backend aplica fail-secure (score 0.0).
- **Recorte con expansión de escala** alrededor del centro del rostro (no el
  bbox apretado): es el preprocesado con el que MiniFASNet fue entrenado; un
  crop apretado degrada fuertemente la predicción.
- **Seam de inferencia inyectable** (`_run_session`) para testear sin pesos.

Notas de seguridad (design §Análisis): el liveness 2D pasivo tiene techo; los
Access_Points de seguridad alta exigen además reto ACTIVO (parpadeo/giro) — ver
`active_liveness.py`. Defensa en profundidad: pasivo + activo.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from threading import Lock
from typing import List, Optional, Tuple

import numpy as np

from ..config import Settings

logger = logging.getLogger("urban-vision.liveness")


class LivenessNotReadyError(Exception):
    """Ningún modelo de liveness pudo cargarse (pesos ausentes / provider)."""


@dataclass
class _SpoofModel:
    """Una sesión ONNX de anti-spoofing con su escala de recorte."""

    name: str
    scale: float
    session: object  # onnxruntime.InferenceSession
    input_name: str
    input_size: Tuple[int, int]  # (h, w)


class LivenessChecker:
    """Evaluador de liveness pasivo (ensemble), thread-safe y de carga perezosa."""

    # (filename, crop_scale). El orden no importa; se promedian las salidas.
    MODEL_SPECS: List[Tuple[str, float]] = [
        ("minifasnet_v2.onnx", 2.7),
        ("minifasnet_v1se.onnx", 4.0),
    ]

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._models: List[_SpoofModel] = []
        self._lock = Lock()
        self._loaded = False
        self._load_error: Optional[str] = None

    @property
    def models_loaded(self) -> bool:
        return self._loaded and len(self._models) > 0

    @property
    def load_error(self) -> Optional[str]:
        return self._load_error

    def ensure_loaded(self) -> None:
        if self._loaded and self._models:
            return
        with self._lock:
            if self._loaded and self._models:
                return
            try:
                import onnxruntime as ort

                providers = self._settings.execution_provider.to_ort_providers()
                models: List[_SpoofModel] = []
                for filename, scale in self.MODEL_SPECS:
                    path = os.path.join(self._settings.models_dir, filename)
                    if not os.path.exists(path):
                        logger.warning("Liveness: peso ausente, se omite: %s", path)
                        continue
                    session = ort.InferenceSession(path, providers=providers)
                    inp = session.get_inputs()[0]
                    h, w = int(inp.shape[2]), int(inp.shape[3])
                    models.append(
                        _SpoofModel(
                            name=filename,
                            scale=scale,
                            session=session,
                            input_name=inp.name,
                            input_size=(h, w),
                        )
                    )
                    # Providers REALMENTE enlazados por ORT (no los solicitados):
                    # si pediste CUDA y aquí sale solo CPU, el liveness corre lento.
                    active = session.get_providers()
                    logger.info(
                        "Liveness cargado: %s (scale=%.1f, providers activos=%s)",
                        filename,
                        scale,
                        active,
                    )
                    if "CPUExecutionProvider" == (active[0] if active else None) and any(
                        p != "CPUExecutionProvider" for p in providers
                    ):
                        logger.warning(
                            "Liveness %s corre en CPU pese a solicitar %s; el "
                            "anti-spoofing será más lento.",
                            filename,
                            [p for p in providers if p != "CPUExecutionProvider"],
                        )

                if not models:
                    raise FileNotFoundError(
                        f"sin pesos de liveness en {self._settings.models_dir}"
                    )
                self._models = models
                self._loaded = True
                self._load_error = None
            except Exception as exc:  # noqa: BLE001 — degradación elegante
                self._load_error = str(exc)
                logger.error("No se pudo cargar liveness: %s", exc)
                raise LivenessNotReadyError(str(exc)) from exc

    # ── Inferencia ──────────────────────────────────────────────────────
    # Índice de la clase "rostro real/vivo" en el softmax de 3 clases de estos
    # checkpoints Silent-Face exportados. VALIDADO empíricamente (scripts/
    # diag_liveness.py): un rostro genuino concentra la probabilidad en el
    # índice 2 (v2≈0.99, v1se≈0.91), no en el 1 que asumía el repo original para
    # otros pesos. Leer el índice equivocado hundía a personas reales a ~0.017.
    REAL_CLASS_INDEX = 2

    def score(self, image_bgr: np.ndarray, bbox: tuple[int, int, int, int]) -> float:
        """`liveness_score` (prob. de rostro REAL) promediada sobre el ensemble."""
        self.ensure_loaded()
        reals: List[float] = []
        idx = self.REAL_CLASS_INDEX
        for model in self._models:
            tensor = self._preprocess(image_bgr, bbox, model.scale, model.input_size)
            probs = self._run_session(model, tensor)
            reals.append(float(probs[idx]) if probs.shape[0] > idx else float(probs[-1]))
        if not reals:
            return 0.0
        return float(np.clip(np.mean(reals), 0.0, 1.0))

    def _crop_face(
        self,
        image: np.ndarray,
        bbox: tuple[int, int, int, int],
        scale: float,
        input_size: Tuple[int, int],
    ) -> np.ndarray:
        """Recorta el rostro expandido por `scale` alrededor del centro (Silent-Face)."""
        import cv2

        src_h, src_w = image.shape[:2]
        x, y, box_w, box_h = bbox
        if box_w <= 0 or box_h <= 0:
            return cv2.resize(image, (input_size[1], input_size[0]))

        eff = min((src_h - 1) / box_h, (src_w - 1) / box_w, scale)
        new_w = box_w * eff
        new_h = box_h * eff
        cx = x + box_w / 2
        cy = y + box_h / 2

        x1 = max(0, int(cx - new_w / 2))
        y1 = max(0, int(cy - new_h / 2))
        x2 = min(src_w - 1, int(cx + new_w / 2))
        y2 = min(src_h - 1, int(cy + new_h / 2))

        crop = image[y1 : y2 + 1, x1 : x2 + 1]
        if crop.size == 0:
            crop = image
        # input_size es (h, w); cv2.resize espera (w, h).
        return cv2.resize(crop, (input_size[1], input_size[0]))

    def _preprocess(
        self,
        image: np.ndarray,
        bbox: tuple[int, int, int, int],
        scale: float,
        input_size: Tuple[int, int],
    ) -> np.ndarray:
        crop = self._crop_face(image, bbox, scale, input_size)
        # HWC(BGR) → NCHW float32 (sin normalización extra, como el repo de ref).
        tensor = crop.astype(np.float32).transpose(2, 0, 1)[np.newaxis, ...]
        return tensor

    def _run_session(self, model: _SpoofModel, tensor: np.ndarray) -> np.ndarray:
        """Ejecuta una sesión ONNX y devuelve el softmax (seam inyectable en tests)."""
        logits = model.session.run(None, {model.input_name: tensor})[0][0]
        return _softmax(np.asarray(logits, dtype=np.float32))


def _softmax(x: np.ndarray) -> np.ndarray:
    e = np.exp(x - np.max(x))
    return e / np.sum(e)
