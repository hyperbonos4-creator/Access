"""Vision_Service — API de gestión (FastAPI).

Endpoints de gestión consumidos por el `VisionServiceClient` del Backend:
- `GET  /health`               — salud para el proxy del Backend (Req 11.4)
- `GET  /metrics`              — métricas operativas (Req 11.4)
- `POST /enroll`               — genera y guarda un Face_Template (Req 2.1)
- `DELETE /templates/{point_id}` — borra una plantilla (Req 3.2, 3.5)

El worker de streams en tiempo real (consumo de go2rtc + emisión de eventos) se
implementa en G1 (`streams/worker.py`, `streams/emitter.py`); este módulo es la
cara de **gestión** del servicio.

Aislamiento: este servicio es el único con alcance a Qdrant y a la VLAN de
cámaras (Req 10.5). El Backend solo habla con esta API autenticada.
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, status

from . import __version__
from .config import Settings, get_settings
from .imaging import ImageDecodeError, decode_base64_image_bgr
from .kyc import KycService
from .active_liveness import ActiveLivenessService
from .pipeline.facade import (
    FacePipeline,
    FaceQualityError,
    PipelineNotReadyError,
)
from .pipeline.liveness import LivenessChecker
from .pipeline.ocr import DocumentOcr
from .recognition import AccessPointContext, RecognitionService
from .schemas import (
    ActiveLivenessObservation,
    ActiveLivenessRequest,
    ActiveLivenessResponse,
    ComponentHealth,
    DeleteTemplateResponse,
    EnrollRequest,
    EnrollResponse,
    FaceMatchRequest,
    FaceMatchResponse,
    HealthResponse,
    LivenessRequest,
    LivenessResponse,
    MetricsResponse,
    OcrDocumentRequest,
    OcrDocumentResponse,
    OcrFieldValue,
    RecognizeRequest,
    RecognizeResponse,
)
from .security import require_service_auth
from .store.qdrant_store import QdrantStore

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("urban-vision")

_STARTED_AT = time.monotonic()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Validaciones de arranque (fail-fast en producción)."""
    settings = get_settings()
    if settings.is_production and not settings.service_token:
        # En producción el canal DEBE estar autenticado (Req 10.1).
        raise RuntimeError(
            "VISION_SERVICE_TOKEN es obligatorio en producción (canal sin auth)."
        )
    logger.info(
        "Vision_Service v%s iniciado (env=%s, provider=%s, model=%s)",
        __version__,
        settings.env.value,
        settings.execution_provider.value,
        settings.embedding_model.value,
    )
    yield


app = FastAPI(
    title="URBAN Vision Service",
    version=__version__,
    description="Microservicio de reconocimiento facial / LPR de URBAN (Módulo 12).",
    lifespan=lifespan,
)

# Singletons del proceso. Se inyectan vía dependencias para testeo.
_pipeline: FacePipeline | None = None
_store: QdrantStore | None = None
_liveness: LivenessChecker | None = None
_ocr: DocumentOcr | None = None
_kyc: KycService | None = None
_active_liveness: ActiveLivenessService | None = None
_recognition: RecognitionService | None = None


def get_pipeline(settings: Settings = Depends(get_settings)) -> FacePipeline:
    global _pipeline
    if _pipeline is None:
        _pipeline = FacePipeline(settings)
    return _pipeline


def get_store(settings: Settings = Depends(get_settings)) -> QdrantStore:
    global _store
    if _store is None:
        _store = QdrantStore(settings)
    return _store


def get_liveness(settings: Settings = Depends(get_settings)) -> LivenessChecker:
    global _liveness
    if _liveness is None:
        _liveness = LivenessChecker(settings)
    return _liveness


def get_ocr(settings: Settings = Depends(get_settings)) -> DocumentOcr:
    global _ocr
    if _ocr is None:
        _ocr = DocumentOcr(settings)
    return _ocr


def get_kyc(
    pipeline: FacePipeline = Depends(get_pipeline),
    liveness: LivenessChecker = Depends(get_liveness),
    ocr: DocumentOcr = Depends(get_ocr),
) -> KycService:
    """Servicio KYC (OCR + liveness + face-match). Inyectable/override en tests."""
    global _kyc
    if _kyc is None:
        _kyc = KycService(pipeline, liveness, ocr)
    return _kyc


def get_active_liveness(
    pipeline: FacePipeline = Depends(get_pipeline),
    liveness: LivenessChecker = Depends(get_liveness),
) -> ActiveLivenessService:
    """Servicio de liveness ACTIVO (reto). Inyectable/override en tests."""
    global _active_liveness
    if _active_liveness is None:
        _active_liveness = ActiveLivenessService(pipeline, liveness)
    return _active_liveness


def get_recognition(
    pipeline: FacePipeline = Depends(get_pipeline),
    store: QdrantStore = Depends(get_store),
    liveness: LivenessChecker = Depends(get_liveness),
) -> RecognitionService:
    """Servicio de reconocimiento 1:N por frame (mismo pipeline del worker RTSP).

    Inyectable/override en tests. La decisión fail-secure NO vive aquí: este
    servicio solo detecta, evalúa liveness, busca 1:N y reporta (ADR §0).
    """
    global _recognition
    if _recognition is None:
        _recognition = RecognitionService(pipeline, store, liveness)
    return _recognition


@app.get("/health", response_model=HealthResponse, tags=["ops"])
def health(
    settings: Settings = Depends(get_settings),
    pipeline: FacePipeline = Depends(get_pipeline),
    store: QdrantStore = Depends(get_store),
    liveness: LivenessChecker = Depends(get_liveness),
) -> HealthResponse:
    """Salud del servicio. No fuerza la carga de modelos (carga perezosa): solo
    reporta el estado conocido.

    Un fallo REAL de carga (`load_error`) degrada el servicio; la carga perezosa
    aún pendiente NO lo degrada, para no marcar 'degraded' en frío y respetar el
    arranque elegante. Antes el estado dependía solo de Qdrant: un pipeline o un
    liveness rotos se reportaban 'ok' en silencio (punto ciego de observabilidad).
    """
    qdrant_ok = store.health()
    components = [
        ComponentHealth(
            name="pipeline",
            ok=pipeline.models_loaded,
            detail=pipeline.load_error or ("cargado" if pipeline.models_loaded else "carga perezosa pendiente"),
        ),
        ComponentHealth(
            name="liveness",
            ok=liveness.models_loaded,
            detail=liveness.load_error
            or ("cargado" if liveness.models_loaded else "carga perezosa pendiente"),
        ),
        ComponentHealth(name="qdrant", ok=qdrant_ok),
    ]
    models_failed = pipeline.load_error is not None or liveness.load_error is not None
    overall = "ok" if qdrant_ok and not models_failed else "degraded"
    return HealthResponse(
        status=overall,
        version=__version__,
        env=settings.env.value,
        execution_provider=settings.execution_provider.value,
        embedding_model=settings.embedding_model.value,
        components=components,
    )


@app.get("/metrics", response_model=MetricsResponse, tags=["ops"])
def metrics(
    settings: Settings = Depends(get_settings),
    pipeline: FacePipeline = Depends(get_pipeline),
) -> MetricsResponse:
    return MetricsResponse(
        uptime_seconds=round(time.monotonic() - _STARTED_AT, 1),
        inference_provider=settings.execution_provider.value,
        models_loaded=pipeline.models_loaded,
    )


@app.post(
    "/enroll",
    response_model=EnrollResponse,
    dependencies=[Depends(require_service_auth)],
    tags=["enrollment"],
)
def enroll(
    req: EnrollRequest,
    pipeline: FacePipeline = Depends(get_pipeline),
    store: QdrantStore = Depends(get_store),
) -> EnrollResponse:
    """Genera el Face_Template y lo guarda en la colección del conjunto.

    El Backend ya verificó el Biometric_Consent `ACTIVE` (Req 3.1). Aquí solo se
    procesa la imagen y se persiste el vector; el embedding nunca se devuelve.
    """
    settings = get_settings()
    # Límite de tamaño (base64 ≈ 4/3 de los bytes reales) — evita subidas enormes.
    if len(req.image_b64) > settings.max_image_bytes * 4 / 3 + 1024:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"image_too_large_max_{settings.max_image_size_mb}mb",
        )

    try:
        image = decode_base64_image_bgr(req.image_b64)
    except ImageDecodeError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))

    try:
        result = pipeline.embed_single_face(image)
    except FaceQualityError as exc:
        # Rechazo de negocio (no es un error 5xx): el Backend lo mapea a 400.
        return EnrollResponse(ok=False, reason=exc.reason)
    except PipelineNotReadyError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"pipeline_no_disponible: {exc}",
        )

    point_id = store.upsert_template(req.conjunto_id, req.subject_id, result.embedding)
    return EnrollResponse(
        ok=True,
        vector_point_id=point_id,
        model=settings.embedding_model.value,
        dim=settings.embedding_dim,
        quality=round(result.quality, 4),
    )


@app.delete(
    "/templates/{point_id}",
    response_model=DeleteTemplateResponse,
    dependencies=[Depends(require_service_auth)],
    tags=["enrollment"],
)
def delete_template(
    point_id: str,
    conjunto_id: str,
    store: QdrantStore = Depends(get_store),
) -> DeleteTemplateResponse:
    """Borra una plantilla concreta de la colección del conjunto (Req 3.2)."""
    deleted = store.delete_point(conjunto_id, point_id)
    return DeleteTemplateResponse(ok=True, deleted=deleted)


@app.delete(
    "/collections/{conjunto_id}",
    dependencies=[Depends(require_service_auth)],
    tags=["enrollment"],
)
def drop_collection(
    conjunto_id: str,
    store: QdrantStore = Depends(get_store),
) -> dict:
    """Elimina por completo la colección de un conjunto (autodestrucción de un
    demo efímero). Idempotente: 200 con dropped=false si ya no existía."""
    dropped = store.drop_collection(conjunto_id)
    return {"ok": True, "dropped": dropped}


@app.post(
    "/recognize",
    response_model=RecognizeResponse,
    dependencies=[Depends(require_service_auth)],
    tags=["recognition"],
)
def recognize(
    req: RecognizeRequest,
    recognition: RecognitionService = Depends(get_recognition),
    settings: Settings = Depends(get_settings),
) -> RecognizeResponse:
    """Reconoce 1:N un único frame de la cámara de un Access_Point (kiosko).

    Corre el MISMO pipeline que el worker RTSP (`recognition.process_frame`):
    detección → liveness pasivo → embedding → búsqueda 1:N en la colección del
    conjunto. Devuelve el veredicto de identidad + liveness; el Backend aplica
    la política fail-secure y decide abrir (ADR §0).
    """
    if len(req.image_b64) > settings.max_image_bytes * 4 / 3 + 1024:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"image_too_large_max_{settings.max_image_size_mb}mb",
        )
    image = _decode_or_422(req.image_b64, "image")

    ctx = AccessPointContext(
        conjunto_id=req.conjunto_id,
        external_camera_key=req.external_camera_key or req.conjunto_id,
        match_threshold=(
            req.match_threshold
            if req.match_threshold is not None
            else settings.default_match_threshold
        ),
    )
    try:
        event = recognition.process_frame(ctx, image)
    except PipelineNotReadyError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"pipeline_no_disponible: {exc}",
        )

    # Sin rostro: no hay a quién decidir (no se emite evento).
    if event is None:
        return RecognizeResponse(ok=True, face=False)

    detection = event.get("detection") or {}
    return RecognizeResponse(
        ok=True,
        face=True,
        label=event.get("label"),
        score=float(event.get("score") or 0.0),
        liveness_score=float(detection.get("livenessScore") or 0.0),
        liveness_mode=detection.get("livenessMode") or "PASSIVE",
        bbox=detection.get("bbox"),
        frame_width=detection.get("frameWidth"),
        frame_height=detection.get("frameHeight"),
    )


# ── KYC (spec resident-onboarding-kyc): OCR + liveness + face-match ──────────


def _decode_or_422(image_b64: str, field_name: str) -> "np.ndarray":  # type: ignore[name-defined]
    """Decodifica base64→BGR aplicando el límite de tamaño; 413/422 si falla."""
    settings = get_settings()
    if len(image_b64) > settings.max_image_bytes * 4 / 3 + 1024:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"{field_name}_too_large_max_{settings.max_image_size_mb}mb",
        )
    try:
        return decode_base64_image_bgr(image_b64)
    except ImageDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name}: {exc}",
        )


@app.post(
    "/ocr/document",
    response_model=OcrDocumentResponse,
    dependencies=[Depends(require_service_auth)],
    tags=["kyc"],
)
def ocr_document(
    req: OcrDocumentRequest,
    kyc: KycService = Depends(get_kyc),
) -> OcrDocumentResponse:
    """OCR del documento (frente + reverso opcional). Devuelve campos crudos +
    calidad; el cotejo (Document_Match) contra el residente lo hace el Backend.
    El texto sensible nunca se loguea (Property 4)."""
    front = _decode_or_422(req.front_b64, "front")
    back = _decode_or_422(req.back_b64, "back") if req.back_b64 else None
    try:
        fields = kyc.ocr_document(front, back)
    except Exception as exc:  # noqa: BLE001 — OCR no disponible (wheel ausente)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"ocr_no_disponible: {exc}",
        )
    return OcrDocumentResponse(
        ok=fields.quality not in ("NO_DOCUMENT",),
        document_number=fields.document_number,
        first_name=fields.first_name,
        last_name=fields.last_name,
        fields=[OcrFieldValue(value=ln.text, confidence=ln.confidence) for ln in fields.fields],
        quality=fields.quality,
    )


@app.post(
    "/liveness",
    response_model=LivenessResponse,
    dependencies=[Depends(require_service_auth)],
    tags=["kyc"],
)
def liveness(
    req: LivenessRequest,
    kyc: KycService = Depends(get_kyc),
) -> LivenessResponse:
    """Liveness pasivo sobre una sola imagen. El gate fail-secure lo aplica el
    Backend; aquí solo se reporta el score (0.0 si el modelo no está)."""
    image = _decode_or_422(req.image_b64, "image")
    try:
        result = kyc.liveness(image, req.mode)
    except PipelineNotReadyError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"pipeline_no_disponible: {exc}",
        )
    return LivenessResponse(
        ok=result.ok, score=round(result.score, 4), mode=req.mode, reason=result.reason
    )


@app.post(
    "/face-match",
    response_model=FaceMatchResponse,
    dependencies=[Depends(require_service_auth)],
    tags=["kyc"],
)
def face_match(
    req: FaceMatchRequest,
    kyc: KycService = Depends(get_kyc),
) -> FaceMatchResponse:
    """Cotejo rostro↔documento (¿el selfie es la persona del retrato del doc?).
    Devuelve `match_score` (coseno); el umbral lo fija el Backend."""
    selfie = _decode_or_422(req.selfie_b64, "selfie")
    document = _decode_or_422(req.document_b64, "document")
    try:
        result = kyc.face_match(selfie, document)
    except PipelineNotReadyError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"pipeline_no_disponible: {exc}",
        )
    return FaceMatchResponse(
        ok=result.ok, match_score=round(result.match_score, 4), reason=result.reason
    )


@app.post(
    "/liveness/active",
    response_model=ActiveLivenessResponse,
    dependencies=[Depends(require_service_auth)],
    tags=["kyc"],
)
def liveness_active(
    req: ActiveLivenessRequest,
    service: ActiveLivenessService = Depends(get_active_liveness),
) -> ActiveLivenessResponse:
    """Revalida un reto de liveness ACTIVO: un frame clave por acción. El
    servidor estima la pose (yaw) y el liveness pasivo de cada frame y reporta
    por acción si se cumplió. La decisión final (secuencia + política) es del
    Backend, que NO confía en el veredicto del cliente."""
    if len(req.frames_b64) != len(req.actions):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="frames_actions_length_mismatch",
        )
    frames = [
        _decode_or_422(b64, f"frame_{i}") for i, b64 in enumerate(req.frames_b64)
    ]
    try:
        result = service.verify(frames, req.actions)
    except PipelineNotReadyError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"pipeline_no_disponible: {exc}",
        )
    return ActiveLivenessResponse(
        ok=result.ok,
        observed=[
            ActiveLivenessObservation(
                action=o.action,
                satisfied=o.satisfied,
                yaw_ratio=o.yaw_ratio,
                has_face=o.has_face,
                passive_score=o.passive_score,
            )
            for o in result.observed
        ],
        passive_score=result.passive_score,
        passive_available=result.passive_available,
        reason=result.reason,
        center_passive_score=result.center_passive_score,
        center_passive_available=result.center_passive_available,
        identity_min_similarity=result.identity_min_similarity,
        identity_available=result.identity_available,
    )
