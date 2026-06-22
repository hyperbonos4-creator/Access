"""Modelos de request/response de la API de gestión del Vision_Service.

Contrato con el `VisionServiceClient` del Backend (Req 2, 9, 10). Ningún
embedding crudo se devuelve al Backend: solo el `vector_point_id` (referencia
opaca en Qdrant) y metadatos (Property 6 — confidencialidad).
"""

from __future__ import annotations

from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, Field


class EnrollReason(str, Enum):
    """Motivos de rechazo de enrolamiento (Req 2.2)."""

    NO_FACE = "NO_FACE"
    MULTIPLE_FACES = "MULTIPLE_FACES"
    LOW_QUALITY = "LOW_QUALITY"
    SPOOF_SUSPECTED = "SPOOF_SUSPECTED"


class EnrollRequest(BaseModel):
    """Solicitud de enrolamiento de un rostro.

    El Backend ya validó el consentimiento `ACTIVE` (Req 3.1) antes de llamar;
    el Vision_Service no conoce el dominio de consentimiento, solo procesa la
    imagen y guarda el vector en la colección del conjunto.
    """

    conjunto_id: str = Field(..., min_length=1, description="Aislamiento multi-tenant")
    subject_id: str = Field(..., min_length=1, description="Enrolled_Subject de dominio")
    # Imagen en base64 (data URL o crudo). Para varias capturas, el Backend
    # llama una vez por imagen.
    image_b64: str = Field(..., min_length=1)


class EnrollResponse(BaseModel):
    """Resultado de un enrolamiento."""

    ok: bool
    vector_point_id: Optional[str] = Field(
        default=None, description="Referencia opaca del punto en Qdrant"
    )
    model: Optional[str] = None
    dim: Optional[int] = None
    quality: Optional[float] = None
    reason: Optional[EnrollReason] = Field(
        default=None, description="Presente solo si ok=false"
    )


class DeleteTemplateResponse(BaseModel):
    ok: bool
    deleted: int = Field(default=0, description="Puntos eliminados de Qdrant")


class ComponentHealth(BaseModel):
    name: str
    ok: bool
    detail: Optional[str] = None


class HealthResponse(BaseModel):
    """Salud del servicio para el proxy del Backend (Req 11.4)."""

    status: str  # ok | degraded
    version: str
    env: str
    execution_provider: str
    embedding_model: str
    components: List[ComponentHealth]


class MetricsResponse(BaseModel):
    """Métricas operativas (Req 11.4). Se amplía en G5."""

    uptime_seconds: float
    inference_provider: str
    models_loaded: bool


# ── KYC: OCR de documento + liveness + face-match ────────────────────────────
# Contrato del `Vision_Port` de la spec `resident-onboarding-kyc` (K1/K2). Las
# imágenes viajan en base64 por el mismo canal autenticado del `/enroll`; ni
# imágenes ni texto sensible se loguean (Property 4).


class DocumentQuality(str, Enum):
    """Calidad agregada del documento (Req 4.x)."""

    OK = "OK"
    NO_DOCUMENT = "NO_DOCUMENT"
    LOW_QUALITY = "LOW_QUALITY"
    GLARE = "GLARE"
    CROPPED = "CROPPED"


class OcrDocumentRequest(BaseModel):
    """Solicitud de OCR de un documento de identidad (frente + reverso opcional)."""

    conjunto_id: str = Field(..., min_length=1)
    front_b64: str = Field(..., min_length=1, description="Imagen del frente")
    back_b64: Optional[str] = Field(default=None, description="Imagen del reverso")


class OcrFieldValue(BaseModel):
    value: str
    confidence: float


class OcrDocumentResponse(BaseModel):
    """Campos extraídos del documento. El cotejo contra el residente es del Backend."""

    ok: bool
    document_number: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    fields: List[OcrFieldValue] = Field(default_factory=list)
    quality: DocumentQuality = DocumentQuality.OK


class LivenessRequest(BaseModel):
    """Solicitud de liveness pasivo sobre una sola imagen (selfie de una pose)."""

    conjunto_id: str = Field(..., min_length=1)
    image_b64: str = Field(..., min_length=1)
    mode: str = Field(default="PASSIVE", description="PASSIVE | ACTIVE (reto)")


class LivenessResponse(BaseModel):
    ok: bool  # ok=false si no hay rostro evaluable
    score: float = 0.0  # [0,1]; el gate fail-secure lo aplica el Backend
    mode: str = "PASSIVE"
    reason: Optional[str] = None  # NO_FACE | LIVENESS_UNAVAILABLE


class FaceMatchRequest(BaseModel):
    """Cotejo rostro↔documento: ¿el selfie es la misma persona del retrato del doc?"""

    conjunto_id: str = Field(..., min_length=1)
    selfie_b64: str = Field(..., min_length=1, description="Selfie (pose frontal)")
    document_b64: str = Field(
        ..., min_length=1, description="Frente del documento (con retrato)"
    )


class FaceMatchResponse(BaseModel):
    ok: bool  # ok=false si falta rostro en alguna de las dos imágenes
    match_score: float = 0.0  # similitud coseno [0,1]; el umbral lo fija el Backend
    reason: Optional[str] = None  # NO_FACE_SELFIE | NO_FACE_DOCUMENT


# ── Liveness ACTIVO (reto-respuesta) — ADR facial-liveness §3 ────────────────


class ActiveLivenessRequest(BaseModel):
    """Revalidación server-side de un reto de liveness activo.

    `frames_b64` lleva un frame clave por acción, en el MISMO orden que
    `actions` (p. ej. ['LOOK_LEFT','BLINK','LOOK_CENTER']). El Backend ya validó
    la vigencia/anti-replay del reto; aquí solo se revalida pose/parpadeo.
    """

    conjunto_id: str = Field(..., min_length=1)
    frames_b64: List[str] = Field(..., min_length=1)
    actions: List[str] = Field(..., min_length=1)


class ActiveLivenessObservation(BaseModel):
    action: str
    satisfied: bool
    yaw_ratio: Optional[float] = None
    has_face: bool = True
    passive_score: Optional[float] = None


class ActiveLivenessResponse(BaseModel):
    ok: bool
    observed: List[ActiveLivenessObservation] = Field(default_factory=list)
    passive_score: float = 0.0
    passive_available: bool = True
    reason: Optional[str] = None
    # Liveness pasivo del frame frontal (LOOK_CENTER): toma fiable para el gate
    # anti-spoofing del Backend (rostro completo, no perfil).
    center_passive_score: float = 0.0
    center_passive_available: bool = False
    # Consistencia de identidad entre frames (L3): coseno mínimo CENTER↔demás.
    # El Backend decide el gate (umbral por conjunto, opt-in). `available=False`
    # => no se pudo evaluar y no debe penalizar.
    identity_min_similarity: float = 1.0
    identity_available: bool = False


# ── Reconocimiento 1:N por frame (kiosko / terminal de puerta) ───────────────
# Expone el `RecognitionService` (mismo pipeline del worker RTSP) como un
# endpoint REST para que el Backend reconozca un frame puntual capturado de la
# cámara de un Access_Point. El Vision_Service SOLO reconoce y reporta; la
# decisión fail-secure (conceder/abrir) la toma el Backend (ADR §0).


class RecognizeRequest(BaseModel):
    """Solicitud de reconocimiento 1:N sobre un único frame."""

    conjunto_id: str = Field(..., min_length=1, description="Aislamiento multi-tenant")
    image_b64: str = Field(..., min_length=1, description="Frame capturado (base64)")
    external_camera_key: Optional[str] = Field(
        default=None, description="Clave de la cámara del Access_Point (trazabilidad)"
    )
    match_threshold: Optional[float] = Field(
        default=None, ge=0.0, le=1.0, description="Umbral 1:N; fallback al del servicio"
    )


class RecognizeResponse(BaseModel):
    """Resultado del reconocimiento de un frame.

    `face=false` => no se detectó rostro (no hay a quién decidir). Si hay rostro
    SIEMPRE se devuelve un veredicto de identidad (`label` = subject_id o
    `"unknown"`) y el `liveness_score`. Ningún embedding crudo se devuelve.
    """

    ok: bool
    face: bool = False
    label: Optional[str] = None  # subject_id reconocido o "unknown"
    score: float = 0.0  # similitud 1:N [0,1]
    liveness_score: float = 0.0  # [0,1]; 0.0 si el modelo no está (fail-secure)
    liveness_mode: str = "PASSIVE"
    bbox: Optional[List[int]] = None  # (x, y, w, h) en píxeles del frame
    frame_width: Optional[int] = None
    frame_height: Optional[int] = None
