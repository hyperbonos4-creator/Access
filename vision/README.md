# urban-vision — Microservicio de visión (Módulo 12: Control de Acceso Facial)

Servicio dedicado y aislado que ejecuta toda la inferencia de visión de URBAN
(detección, embeddings, liveness y, en fase 2, LPR). El backend de dominio NestJS
**nunca** carga modelos ni abre RTSP: solo consume esta API de gestión y recibe
`DomainCameraEvent` por el contrato de eventos existente.

> Spec: `.kiro/specs/facial-access-control/` (requirements / design / tasks) y
> `.kiro/specs/resident-onboarding-kyc/` (KYC: OCR + liveness + face-match).
> Estado actual: **G0/G1** (detección/embedding + API de gestión) + **KYC K1**
> (OCR de documento, liveness 1-imagen, face-match selfie↔documento).

## Arquitectura (resumen)

```
Cámaras ──RTSP──► go2rtc ──sub-stream──► [worker G1] ─┐
                                                       ▼
   Backend ──REST (enroll/delete/health)──►  Vision_Service (FastAPI + ONNX RT)
                                              SCRFD → (liveness G1) → ArcFace
                                                       │ vectores
                                                       ▼
                                              Qdrant (1 colección / conjunto_id)
   Backend ◄── DomainCameraEvent (FACE/LPR, firmado) ── [emitter G1]
```

- **Aislamiento (Req 1, 10.5):** único componente con alcance a Qdrant y a la VLAN
  de cámaras. Canal con el Backend autenticado por bearer compartido.
- **Stack:** InsightFace (`buffalo_l` = SCRFD + ArcFace) sobre ONNX Runtime;
  Qdrant como Vector_Store; MiniFASNet (liveness) y fast-alpr (LPR) en fases
  posteriores.

## Estructura

```
app/
  config.py        # settings por env (provider, umbrales, qdrant, secretos)
  security.py      # auth bearer del canal Backend↔Vision
  schemas.py       # contratos request/response
  imaging.py       # decodificación de imágenes
  main.py          # FastAPI: /health /metrics /enroll DELETE /templates/{id}
                   #          + KYC: /ocr/document /liveness /face-match
  recognition.py   # RecognitionService: detección→liveness→búsqueda→evento
  kyc.py           # KycService: OCR + liveness 1-imagen + face-match (KYC)
  emitter.py       # EventEmitter: firma HMAC + transporte (Redis Stream/HTTP)
  worker.py        # StreamWorker: lazo RTSP (go2rtc) con backoff
  pipeline/
    facade.py      # FacePipeline: detección + embedding (carga perezosa)
    liveness.py    # LivenessChecker: MiniFASNet (anti-spoofing)
    ocr.py         # DocumentOcr: RapidOCR/PP-OCRv4 + extracción de campos (KYC)
  store/
    qdrant_store.py# colección por conjunto: upsert/search/delete
tests/             # pytest con dobles (sin GPU ni Qdrant real)
models/            # pesos ONNX (NO en git; se descargan en 1er uso)
Dockerfile         # imagen CPU (base para dev y CI)
docker-compose.yml # vision_service + qdrant
```

## Puesta en marcha (desarrollo)

Requiere la red `urban_network` del stack raíz (se crea al levantar el compose
principal; si no existe: `docker network create urban_network`).

```bash
cd infrastructure/urban-vision
cp .env.example .env          # ajustar VISION_SERVICE_TOKEN, provider, etc.
docker compose up -d          # levanta qdrant + vision_service
curl http://localhost:8200/health
```

En el **primer** `/enroll`, InsightFace descarga `buffalo_l` a `/models` (volumen
`vision_models`). Los arranques siguientes reutilizan los pesos.

### Enrolar un rostro (prueba manual)

```bash
TOKEN=$(grep VISION_SERVICE_TOKEN .env | cut -d= -f2)
IMG=$(base64 -w0 rostro.jpg)
curl -X POST http://localhost:8200/enroll \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"conjunto_id\":\"c1\",\"subject_id\":\"s1\",\"image_b64\":\"$IMG\"}"
```

Respuesta: `{ "ok": true, "vector_point_id": "...", "model": "arcface", "dim": 512, "quality": 0.9x }`.
El embedding nunca se devuelve (Property 6).

## Tests

Corren con dobles (no requieren GPU, modelos ni Qdrant). Runtime objetivo:
**Python 3.11** (igual que la imagen/CI).

```bash
pip install -r requirements.txt
pytest
```

## GPU / proveedor de ejecución

**El resultado del reconocimiento es idéntico en CPU, AMD (DirectML) y NVIDIA
(CUDA): solo cambia la velocidad.** El proveedor es configuración, no código
(`VISION_EXECUTION_PROVIDER`), con fallback automático a CPU.

| Entorno | Provider | Cómo |
|---|---|---|
| **Desarrollo — Docker (recomendado)** | `cpu` | `docker compose up`. Funciona en cualquier host (incl. AMD), suficiente para validar el flujo con 1-3 cámaras. |
| **Desarrollo — GPU AMD (nativo Windows)** | `directml` | Ejecutar el servicio NATIVO en Windows (no Docker, ver abajo) con `onnxruntime-directml`. |
| **Producción — GPU NVIDIA (3080)** | `cuda` / `tensorrt` | Imagen base CUDA + `onnxruntime-gpu`; descomentar `deploy.resources.devices` en `docker-compose.yml` + NVIDIA Container Toolkit. |

> **Importante (AMD):** DirectML acelera **solo corriendo el servicio nativo en
> Windows**. Dentro de Docker (Linux) tu GPU AMD **no** se usa: el contenedor
> cae a CPU (perfectamente válido para desarrollo). Para exprimir la AMD, usa la
> receta nativa de abajo.

### Receta GPU AMD nativa (Windows + DirectML)

```powershell
cd infrastructure/urban-vision
# Qdrant en Docker (solo el vector store)
docker compose up -d qdrant

# Servicio nativo en un venv con DirectML
py -3.11 -m venv .venv ; .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
pip uninstall -y onnxruntime ; pip install onnxruntime-directml   # AMD/Windows
$env:VISION_EXECUTION_PROVIDER="directml"
$env:VISION_QDRANT_URL="http://localhost:6333"
uvicorn app.main:app --host 0.0.0.0 --port 8200
```

> Producción es la operación inversa: `pip install onnxruntime-gpu` y
> `VISION_EXECUTION_PROVIDER=cuda`. Cero cambios de código.

## Modelos

No se versionan en git (ver `.gitignore`). Origen:
- **buffalo_l** (SCRFD + ArcFace): descarga automática de InsightFace en `/models`.
- **MiniFASNet** (liveness, G1) y **fast-alpr** (LPR, G6): se documentará su
  descarga al implementar esas fases.

> Licenciamiento de modelos: revisar antes de producción (gestión en curso por el
> equipo). Esta nota se mantiene hasta cerrar ese punto.

## Roadmap de implementación

- **G0 (scaffold):** estructura, config, API de gestión, detección+embedding,
  Qdrant, tests con dobles. ✅
- **G1:** liveness MiniFASNet + servicio de reconocimiento + emisor de
  `DomainCameraEvent` firmado + worker de streams + `FaceAccessAdapter` en el
  Backend (fuente `VISION`). ✅ (worker RTSP: validación con stream real pendiente
  de checkpoint de integración).
- **G2–G5:** dominio de acceso, decisión `fail-secure`, UI, endurecimiento y GPU
  de producción.
- **G6:** pipeline LPR (`fast-alpr`) en este mismo servicio.

## Seguridad y cumplimiento

- Canal autenticado (bearer/mTLS); en producción el token es obligatorio
  (fail-fast al arrancar).
- Inferencia 100% local — sin nube de terceros (Ley 1581, Req 3.3).
- El Vision_Service no decide accesos: solo reconoce. La política y la actuación
  de puerta `fail-secure` viven en el Backend (Módulo 12, dominio).
