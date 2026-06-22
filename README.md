# Office Access Control

Control de acceso facial para **una puerta de oficina** (empleados). Extracción
profesional del módulo `access-control` de URBAN, reutilizando sus tecnologías
ya probadas pero como **proyecto autónomo, sin la herencia residencial**
(multi-tenant, residentes, torres, visitantes, LPR, invitaciones).

> El rostro de un empleado autorizado libera la cerradura; al cerrar la puerta
> vuelve a bloquearse automáticamente. La salida hacia el exterior es siempre
> libre (ruta de evacuación).

## Arquitectura

```
            ┌────────────┐   RTSP/ISAPI    ┌──────────────┐
            │  Cámara IP  │ ───────────────▶│   backend     │
            └────────────┘   (snapshot)     │  (NestJS)     │
                                            │  fail-secure  │
   ┌──────────────┐   POST /recognize       │  decide()     │
   │   vision      │◀────────────────────────│              │
   │ FastAPI+ONNX  │   label+score+liveness  │              │
   │ InsightFace   │────────────────────────▶│              │
   └──────┬───────┘                          └──────┬───────┘
          │ vectores                                │ GET /open?token=
   ┌──────▼───────┐                          ┌──────▼───────┐
   │   Qdrant      │                          │   ESP32       │
   │ faces_<site>  │                          │  + relé +     │
   └──────────────┘                          │   maglock     │
                                             └──────────────┘
```

- **backend/** — NestJS. Dominio + política **fail-secure** (`AccessControlService.decide`),
  enrolamiento, consentimiento, puntos de acceso, kiosko (terminal de puerta) y
  actuación de puerta (`DoorControllerService`). No carga IA.
- **vision/** — microservicio FastAPI + ONNX Runtime (InsightFace `buffalo_l` +
  liveness). Copiado verbatim de `urban-vision`. Solo infiere; **nunca** concede
  acceso.
- **firmware/esp32-door-lock/** — controlador físico: máquina de estados del
  maglock (bloqueo por defecto, apertura por Face ID, re-bloqueo al cerrar,
  fail-safe ante corte de luz). El re-bloqueo vive aquí, no en el backend.

### Principios heredados (ADR de URBAN)
- **Fail-secure de extremo a extremo:** ningún camino degradado abre la puerta.
  El Vision infiere; el Backend decide; el actuador solo abre si la decisión es
  `GRANTED`.
- **Privacidad por diseño:** los embeddings viven solo en Qdrant; Postgres
  guarda metadatos. Consentimiento `ACTIVE` previo a cualquier plantilla.
  `controllerRef` (relé) y `rtspUrl` (cámara) nunca se serializan al cliente.

## Hardware recomendado (una puerta)

| Componente | Modelo | Nota |
|---|---|---|
| PC | Beelink EQ12/EQ13 N100, 16 GB, SSD 500 GB | corre backend + vision (CPU) |
| Cámara | Dahua IPC-HDW5442TM-AS (4MP, WDR) o Hikvision DS-2CD2347G2-LU | RTSP/ONVIF |
| Cerradura | **Maglock fail-safe 280 kg / 600 lb** (YLI YM-280) | abre sin energía = egreso |
| Brackets | U-bracket + ZL/L para vidrio frameless | sin perforar el vidrio |
| Sensor | Contacto magnético NC de superficie | detecta CLOSED para re-bloquear |
| Controlador | ESP32-POE-ISO / LILYGO T-ETH-Lite + relé 1 canal | máquina de estados local |
| Fuente cerradura | MeanWell LRS-50-12 | **sin** batería de respaldo (fail-safe) |
| UPS | APC Back-UPS | para PC + cámara + red (no para el maglock) |

⚠ La puerta es **ruta de evacuación**: cerradura **fail-safe** + egreso interior
siempre libre (barra/REX) + corte por central de incendios. El Face ID controla
solo la **entrada**.

## Puesta en marcha (dev con Docker)

```bash
cp backend/.env.example backend/.env     # ajustar JWT_ACCESS_SECRET, SITE_ID, DB_*
cp vision/.env.example  vision/.env       # ajustar VISION_SERVICE_TOKEN, provider
docker compose up -d --build
docker compose run --rm backend npm run seed   # crea el admin (SEED_ADMIN_*)
```

El stack publica solo el backend en el host (puerto **3010** → contenedor 3000);
Vision, Qdrant y Postgres quedan en la red interna / loopback.

- Backend / API: `http://localhost:3010`  ·  Swagger: `http://localhost:3010/api/docs`
- **Kiosko (terminal de puerta):** `http://localhost:3010/kiosk/`
- **Consola de administración:** `http://localhost:3010/kiosk/admin.html`
- **Registro facial guiado:** `http://localhost:3010/kiosk/enroll.html` (se abre desde la consola)
- Vision: interno (`http://vision:8200`); Qdrant (`127.0.0.1:6335`) y Postgres
  (`127.0.0.1:5434`) en la red interna.

> La carpeta `backend/public/` se monta como volumen de solo lectura, así que el
> HTML/JS/CSS de la UI se actualiza sin reconstruir la imagen. El código TypeScript
> compilado sí requiere `docker compose up -d --build backend`.

### Backend en local (sin Docker)

```bash
cd backend
npm install
npm run build
npm run seed         # requiere Postgres accesible y backend/.env
npm run start:dev
```

## Interfaz web (kiosko + administración + registro guiado)

El backend sirve una UI estática con la marca URBAN bajo `/kiosk` (`backend/public/`):

- **Kiosko** (`index.html`): terminal de puerta. Muestra el stream MJPEG de la
  cámara, reconoce 1:N en bucle y muestra el veredicto (CONCEDIDO/DENEGADO) con
  match/liveness y apertura manual del operador.
- **Administración** (`admin.html`): cámaras, puntos de acceso (umbrales,
  actuador), empleados, consentimiento, autorizaciones y eventos.
- **Registro facial guiado** (`enroll.html`): enrolamiento por **liveness activo**
  en tiempo real (ver abajo).

### Registro facial guiado por liveness activo

Sustituye la captura estática por un **reto-respuesta en vivo** (anti-foto/anti-pantalla):

1. El operador abre **✨ Registro guiado** desde la ficha del empleado (requiere
   consentimiento `ACTIVE`). Se abre `enroll.html` con `subjectId`/`name`.
2. El backend emite un reto aleatorio (`POST /access/subjects/:id/liveness/challenge`):
   una secuencia de acciones que **siempre termina en `LOOK_CENTER`** — p. ej.
   `LOOK_LEFT → BLINK → LOOK_RIGHT → LOOK_CENTER`. El `challengeId` es de un solo
   uso (anti-replay).
3. En el navegador, **MediaPipe Face Landmarker** (auto-alojado en
   `public/vendor/mediapipe/`, 478 puntos + blendshapes) verifica cada acción
   on-device: giro de cabeza (`yaw_ratio` = nariz vs. centro de ojos / distancia
   interocular, la misma convención que el servidor) y parpadeo (blendshapes
   `eyeBlink{Left,Right}`). Captura un frame clave por acción.
4. Se envían los frames (`POST /access/subjects/:id/liveness/enroll`). El backend
   **revalida server-side** en Vision (`POST /liveness/active`): pose por frame +
   liveness pasivo (MiniFASNet ONNX). **No confía en el veredicto del cliente.**
5. Si la secuencia coincide y el liveness pasivo supera el umbral, enrola el
   embedding del frame frontal (`LOOK_CENTER`). Los frames laterales/parpadeo son
   prueba de vida, no de identidad.

Fuentes de cámara soportadas: **webcam del dispositivo** (recomendado, baja
latencia) o **stream MJPEG de la cámara IP** del punto de acceso.

> El frame se captura sin espejar (orientación cruda de cámara) para coincidir con
> la revalidación del servidor; el espejo del preview es solo cosmético. Como el
> servidor revalida la pose por magnitud de giro, el sentido izquierda/derecha del
> rótulo no afecta a la seguridad.

**Calibración:** `LIVENESS_THRESHOLD` (env del backend, por defecto `0.5`) y el
`livenessThreshold` por punto de acceso gobiernan el gate anti-spoofing. Tras las
primeras pruebas con rostro real vs. foto, ajústalos para equilibrar FAR/FRR. El
panel de resultado del registro guiado muestra el score pasivo obtenido.

## Flujo de configuración inicial

1. **Login** `POST /api/v1/auth/login` con el admin del seed → `token`.
2. **Cámara** `POST /api/v1/cameras` con `rtspUrl` (rtsp://user:pass@host:554/...).
3. **Punto de acceso** `POST /api/v1/access/points`:
   `controllerKind=HTTP`, `controllerRef=http://<esp32-ip>/open?token=<OPEN_TOKEN>`,
   `cameraId=<id>`. (Usa `SIMULATED` para probar sin hardware.)
4. **Empleado** `POST /api/v1/access/subjects` → `POST .../consent` →
   **registro guiado** (recomendado, vía `enroll.html`) o `POST .../enroll`
   (imagen base64, captura simple). Al enrolar, el empleado queda **habilitado
   automáticamente** en las puertas (`AUTO_AUTHORIZE_ENROLLED=true`).
5. **Kiosko**: `POST /api/v1/access/points/:id/recognize` decide y abre.

> **Autorización automática (puerta única):** no hay paso manual de "autorizar".
> Enrolar a un empleado lo habilita en todas las puertas; crear una puerta nueva
> habilita a los empleados ya enrolados. Para gestión explícita de permisos por
> punto (multi-puerta con horarios) poner `AUTO_AUTHORIZE_ENROLLED=false` y usar
> `POST /api/v1/access/authorizations`.

## Diferencias respecto a URBAN (qué se quitó)

- Multi-tenant `conjuntoId` → un único `SITE_ID` (env).
- Residentes/torres/apartamentos, visitantes, invitaciones y auto-enrolamiento
  con doble aprobación, notificaciones (WhatsApp/email), guard-station y LPR
  (placas) → fuera de alcance.
- Auth reducido a operador/administrador (roles `ADMIN`/`OPERATOR`).

## Lo que se reutilizó verbatim

- Política de decisión fail-secure y persistencia de eventos.
- Cliente del Vision_Service, snapshot ISAPI Digest (kiosko/preview MJPEG).
- Actuador de puerta multi-backend (HTTP/relé, Hikvision ISAPI, simulado).
- Todo el microservicio `vision` (reconocimiento + liveness).
