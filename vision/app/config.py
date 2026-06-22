"""Configuración del Vision_Service.

Toda la configuración viene de variables de entorno (12-factor). El
`execution provider` de ONNX Runtime es conmutable por env sin tocar código
(Req 1.6): `cpu`/`directml` en desarrollo (GPU AMD), `cuda`/`tensorrt` en
producción (GPU NVIDIA clase 3080).

Los secretos (token del canal, credenciales) nunca se hardcodean: se leen del
entorno o del secret store (Req 10.4).
"""

from __future__ import annotations

from enum import Enum
from functools import lru_cache
from typing import List

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Environment(str, Enum):
    """Entorno de ejecución (evita strings libres como 'prod'/'Production')."""

    DEVELOPMENT = "development"
    STAGING = "staging"
    PRODUCTION = "production"


class ExecutionProvider(str, Enum):
    """Proveedores de ejecución soportados por ONNX Runtime."""

    CPU = "cpu"
    DIRECTML = "directml"  # GPU AMD/Windows (desarrollo)
    CUDA = "cuda"  # GPU NVIDIA (producción)
    TENSORRT = "tensorrt"  # GPU NVIDIA optimizado (producción a escala)

    def to_ort_providers(self) -> List[str]:
        """Traduce a la lista de providers que espera onnxruntime.

        Se incluye `CPUExecutionProvider` como fallback final en todos los
        casos: si el provider de GPU no está disponible en el host, ORT degrada
        a CPU en vez de fallar el arranque.
        """
        mapping = {
            ExecutionProvider.CPU: ["CPUExecutionProvider"],
            ExecutionProvider.DIRECTML: ["DmlExecutionProvider", "CPUExecutionProvider"],
            ExecutionProvider.CUDA: ["CUDAExecutionProvider", "CPUExecutionProvider"],
            ExecutionProvider.TENSORRT: [
                "TensorrtExecutionProvider",
                "CUDAExecutionProvider",
                "CPUExecutionProvider",
            ],
        }
        return mapping[self]


class EmbeddingModel(str, Enum):
    """Modelos de embedding seleccionables (Req 1.6, design §Análisis)."""

    ARCFACE = "arcface"  # por defecto: sujetos cooperativos (terminal de puerta)
    ADAFACE = "adaface"  # refuerzo: cámaras de vigilancia / baja calidad


class Settings(BaseSettings):
    """Configuración tipada del servicio, poblada desde el entorno."""

    model_config = SettingsConfigDict(
        env_prefix="VISION_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ── Servicio ───────────────────────────────────────────────────────────
    env: Environment = Field(default=Environment.DEVELOPMENT)
    host: str = Field(default="0.0.0.0")
    port: int = Field(default=8200)
    log_level: str = Field(default="info")

    # ── Seguridad del canal (Req 10.1, 10.3, 10.4) ──────────────────────────
    # Secreto compartido entre Backend ↔ Vision_Service. En producción es
    # obligatorio; en desarrollo puede quedar vacío para facilitar pruebas.
    service_token: str = Field(default="", description="Bearer compartido Backend↔Vision")

    # ── Inferencia (Req 1.6) ────────────────────────────────────────────────
    execution_provider: ExecutionProvider = Field(default=ExecutionProvider.CPU)
    embedding_model: EmbeddingModel = Field(default=EmbeddingModel.ARCFACE)
    models_dir: str = Field(default="/models", description="Ruta de los pesos ONNX")

    # ── Umbrales por defecto (el Backend manda los efectivos por Access_Point)
    # Aquí solo sirven de fallback operativo del servicio.
    default_match_threshold: float = Field(default=0.5, ge=0.0, le=1.0)
    default_liveness_threshold: float = Field(default=0.7, ge=0.0, le=1.0)
    min_face_quality: float = Field(default=0.5, ge=0.0, le=1.0)
    # Límite de tamaño de imagen recibida (evita subidas de 30+ MB del móvil).
    max_image_size_mb: float = Field(default=10.0, gt=0.0)

    # ── Vector_Store (Qdrant) — Req 9.1 ─────────────────────────────────────
    qdrant_url: str = Field(default="http://qdrant:6333")
    qdrant_api_key: str = Field(default="")
    # Prefijo de colección por conjunto: `faces_<conjuntoId>` (aislamiento).
    qdrant_collection_prefix: str = Field(default="faces_")

    @property
    def is_production(self) -> bool:
        return self.env == Environment.PRODUCTION

    @property
    def embedding_dim(self) -> int:
        """Dimensión del embedding DERIVADA del modelo (no configurable por env).

        Evita que un `VISION_EMBEDDING_DIM` mal puesto rompa Qdrant. ArcFace y
        AdaFace producen 512; si se añade un modelo de otra dimensión, se mapea
        aquí en un solo sitio.
        """
        dims = {EmbeddingModel.ARCFACE: 512, EmbeddingModel.ADAFACE: 512}
        return dims[self.embedding_model]

    @property
    def max_image_bytes(self) -> int:
        return int(self.max_image_size_mb * 1024 * 1024)


@lru_cache
def get_settings() -> Settings:
    """Devuelve la configuración cacheada (singleton por proceso)."""
    return Settings()
