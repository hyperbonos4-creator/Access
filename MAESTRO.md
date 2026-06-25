# 📘 VISIONYX Access — Documento MAESTRO

> **Un solo documento para gobernar todo el flujo.** Este archivo consolida de
> extremo a extremo: **qué es el sistema → cómo se trabaja en local → cómo se
> buildea → cómo se commitea/pushea → cómo se despliega y aplica en el servidor
> Oracle**. Pensado para no tener que abrir otros archivos: léelo de corrido y
> úsalo como runbook de cada cambio.
>
> **Regla de oro (no negociable):** se trabaja y se prueba en **local**; cuando
> el cambio está terminado, se **commitea + pushea** a `main`; y **recién ahí**
> se actualiza el servidor. **Nunca** se editan archivos directamente en
> producción.

---

## 📑 Índice

1. [Qué es el sistema](#1--qué-es-el-sistema)
2. [Arquitectura y stack](#2--arquitectura-y-stack)
3. [Estructura del proyecto](#3--estructura-del-proyecto)
4. [Datos del servidor y credenciales](#4--datos-del-servidor-y-credenciales)
5. [Puesta en marcha por primera vez (local)](#5--puesta-en-marcha-por-primera-vez-local)
6. [🚀 EL FLUJO COMPLETO: cambio → build → push → deploy](#6--el-flujo-completo-cambio--build--push--deploy)
7. [Qué cambia con rebuild y qué no (vital)](#7--qué-cambia-con-rebuild-y-qué-no-vital)
8. [Variables de entorno (resumen)](#8--variables-de-entorno-resumen)
9. [Scripts de despliegue del servidor](#9--scripts-de-despliegue-del-servidor)
10. [Comprobaciones y verificación](#10--comprobaciones-y-verificación)
11. [Archivos que NO están en git](#11--archivos-que-no-están-en-git)
12. [Solución de problemas](#12--solución-de-problemas)
13. [Glosario rápido](#13--glosario-rápido)

---

## 1. 🎯 Qué es el sistema

**VISIONYX Access** es un **control de acceso facial para una puerta de oficina**.
El rostro de un empleado autorizado libera la cerradura; al cerrar la puerta,
vuelve a bloquearse. La salida hacia el exterior es siempre libre (ruta de
evacuación).

Es una **extracción profesional** del módulo `access-control` de URBAN, como
**proyecto autónomo**, sin la herencia residencial (multi-tenant, residentes,
torres, visitantes, LPR, invitaciones).

**Componentes principales:**
- **backend/** — NestJS. Dominio + política **fail-secure** (`decide`),
  enrolamiento, consentimiento, puntos de acceso, kiosko y actuación de puerta.
  **No carga IA.**
- **vision/** — Microservicio FastAPI + ONNX Runtime (InsightFace `buffalo_l` +
  liveness). Solo infiere; **nunca** concede acceso.
- **firmware/esp32-door-lock/** — Controlador físico: máquina de estados del
  maglock (bloqueo por defecto, apertura por Face ID, re-bloqueo al cerrar,
  fail-safe ante corte de luz). El re-bloqueo vive aquí, no en el backend.

---

## 2. 🏗️ Arquitectura y stack

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

### Stack por componente

| Capa | Tecnología |
|---|---|
| **Backend** | Node.js 20+, NestJS 11, TypeORM 0.3, PostgreSQL 16, Passport+JWT, class-validator, Swagger, Axios, Jest |
| **Vision** | Python + FastAPI, ONNX Runtime (CPU/DirectML/CUDA/TensorRT), InsightFace `buffalo_l`, MiniFASNet (liveness), Qdrant |
| **Firmware** | ESP32 (POE-ISO / T-ETH-Lite), C++ / Arduino / PlatformIO |
| **Infra** | Docker 24+ + Compose v2, nginx, Let's Encrypt (Certbot) |
| **UI** | HTML/JS/CSS estático en `backend/public/` (sin framework de build). Auto-aloja MediaPipe Face Landmarker |

### Principios (ADR heredados de URBAN)

1. **Fail-secure de extremo a extremo:** ningún camino degradado abre la puerta.
   Vision **infiere**; el Backend **decide**; el actuador solo abre si la
   decisión es `GRANTED`.
2. **Privacidad por diseño:** los embeddings viven solo en Qdrant; Postgres
   guarda metadatos. Consentimiento `ACTIVE` previo a cualquier plantilla.
   `controllerRef` (relé) y `rtspUrl` (cámara) **nunca** se serializan al cliente.

### Contenedores del stack (un solo `docker compose up`)

| Contenedor        | Imagen                          | Qué es                          | Puerto host          |
|-------------------|---------------------------------|---------------------------------|----------------------|
| `office_postgres` | `postgres:16-alpine`            | Base de datos                   | `127.0.0.1:5434:5432`|
| `office_qdrant`   | `qdrant/qdrant:v1.12.4`         | Vectores de rostros             | `127.0.0.1:6335:6333`|
| `office_vision`   | `office/vision-service:0.1.0`   | Reconocimiento facial (FastAPI) | `127.0.0.1:8210:8200`|
| `office_backend`  | `office/access-backend:0.1.0`   | API NestJS (dominio + kiosko)   | `3010:3000` (servidor: loopback `127.0.0.1:3010`) |

**Volúmenes persistentes:** `pg_data`, `qdrant_data`, `vision_models`.

**Montajes del backend (sin reconstruir imagen):**
- `./backend/public:/app/public:ro` — UI estática (iterar sin rebuild).
- `./cuentas:/app/cuentas:ro` — credenciales del rotador (no horneadas).
- `./:/repo:ro` — repo entero read-only, para que las tools de código del
  Copiloto inspeccionen el proyecto sin riesgo de escritura (`COPLOT_REPO_ROOT=/repo`).

---

## 3. 📂 Estructura del proyecto

```
access/
├── backend/                       # API NestJS (dominio + kiosko + copiloto)
│   ├── src/
│   │   ├── access-control/        # Núcleo: decide/actúa puerta, enrolamiento,
│   │   │   │                      #   consentimiento, kiosko, liveness, puerta
│   │   │   ├── door/              #   actuadores (HTTP/relé/Hikvision/sim)
│   │   │   ├── liveness/          #   reto-respuesta anti-foto/anti-pantalla
│   │   │   ├── entities/          #   access-point, subject, consent, face-template…
│   │   │   └── dto/
│   │   ├── assistant/             # "Vix": asistente de pre-venta de la web (GLM)
│   │   ├── auth/                  # JWT, guards, roles ADMIN/OPERATOR
│   │   ├── cameras/               # Cámaras IP (RTSP/ISAPI)
│   │   ├── copilot/               # Copiloto interno del panel (GLM + function-calling)
│   │   │   ├── tools/             #   code-tools (read-only) / system-tools / action-tools
│   │   │   └── entities/          #   conversaciones, mensajes, auditoría
│   │   ├── credential-rotator/    # Rotador de cuentas Cloudflare (tokens)
│   │   ├── common/ config/ database/
│   │   ├── app.module.ts
│   │   └── main.ts
│   ├── public/                    # UI estática (montada como volumen ro)
│   │   ├── index.html             #   Kiosko (terminal de puerta)
│   │   ├── admin.html             #   Consola de administración
│   │   ├── enroll.html            #   Registro facial guiado (liveness activo)
│   │   ├── assets/                #   CSS/JS/medios
│   │   └── vendor/mediapipe/      #   Face Landmarker auto-alojado (478 pts)
│   ├── Dockerfile
│   ├── package.json               #   build / start:dev / seed / typeorm
│   └── .env.example               #   → copiar a .env (NO subir)
├── vision/                        # Microservicio facial (FastAPI + ONNX)
│   ├── app/                       #   /recognize, /liveness/active, config, Qdrant
│   ├── models/                    #   pesos ONNX (buffalo_l, MiniFASNet) — no en git
│   ├── tests/
│   ├── Dockerfile
│   ├── requirements.txt
│   └── .env.example               #   → copiar a .env (NO subir)
├── firmware/esp32-door-lock/      # Controlador físico (maglock + relé)
├── website/                       # Web institucional visionyx.lat
├── cuentas/cuentas.json           # Pool de cuentas Cloudflare (NO en git; servidor)
├── deploy-*.sh                    # Scripts de despliegue (servidor Oracle)
├── tunnel.ps1                     # Túnel SSH inverso de la cámara (Windows)
├── docker-compose.yml             # Stack de una puerta (4 contenedores)
└── .gitignore                     # ignora .env, dist, node_modules, cuentas, etc.
```

---

## 4. 🔑 Datos del servidor y credenciales

| Dato                | Valor                                   |
|---------------------|-----------------------------------------|
| Proveedor           | Oracle Cloud (Bogotá, `sa-bogota-1`)    |
| **IP pública**      | `157.137.230.190`                       |
| Usuario SSH         | `ubuntu` (en grupos `docker` y `sudo`, sin contraseña) |
| Ruta del demo       | `~/access-demo` (donde corre el stack)  |
| Ruta del repo git   | `~/access` (copia limpia del repo)      |
| Web institucional   | `/var/www/visionyx` → `visionyx.lat`    |
| **URL del demo**    | https://demo.visionyx.lat               |
| OS                  | Ubuntu 24.04                            |
| Repo GitHub         | `https://github.com/hyperbonos4-creator/Access.git` (privado) |
| Rama desplegada     | **`main`**                              |

### Credenciales del demo

| Dato               | Valor                          |
|--------------------|--------------------------------|
| Admin demo         | `demo@visionyx.lat`            |
| Clave admin demo   | `VisionyxDemo2026!`            |

> ⚠ `JWT_ACCESS_SECRET` y `VISION_SERVICE_TOKEN` se **regeneran** en cada
> `deploy-demo.sh` (aleatorios). No se fijan: si regeneras el `.env`, todas las
> sesiones y tokens de kiosko caducan.

### Acceso SSH

Necesitas la llave privada `ssh-key-2026-06-11.key` (pídela al equipo por un
canal seguro; **no** está en el repo).

```powershell
# Windows (PowerShell)
ssh -i "C:\Users\<tu_usuario>\Documents\ssh-key-2026-06-11.key" ubuntu@157.137.230.190
```
```bash
# Linux / macOS
chmod 600 ~/ssh-key-2026-06-11.key        # solo la primera vez
ssh -i ~/ssh-key-2026-06-11.key ubuntu@157.137.230.190
```

### Token de GitHub (para `git pull` en el servidor)

El repo es **privado**; el servidor necesita un **PAT (Personal Access Token)**
con permiso `Contents: Read` en línea dentro de la URL del `git pull`. No se
guarda en la config de git ni en el historial de bash.

**Cómo obtenerlo / pasárselo al script maestro:**
- GitHub → Settings → Developer settings → Personal access tokens → Generate new token (classic), scope `repo`.
- Pásalo al script `deploy-maestro.sh` por cualquiera de estas vías (en orden de preferencia):
  1. Variable de entorno: `export GITHUB_TOKEN="github_pat_..."`
  2. Archivo: `echo "github_pat_..." > ~/.access-deploy-token`
  3. Si existe `DEPLOY-SERVER.md` con el token escrito, el script lo lee de ahí.

> ⚠ El token **nunca** se sube al repo (Push Protection de GitHub lo bloquea).
> Si se filtra, regenéralo en GitHub → Settings → Developer settings → Personal access tokens.

> ⚠ Este documento contiene datos del entorno de **demo** (IP del servidor, admin/clave de demo, nombre de la llave SSH). Los **secretos reales** (PAT de GitHub, API key Cloudflare) **no** van aquí: se pasan al script por `GITHUB_TOKEN` o archivo. Trátalo como interno de todos modos; es un entorno de **demo**, no producción.

---

## 5. 🧰 Puesta en marcha por primera vez (local)

Solo la primera vez (o si montas el entorno desde cero):

```bash
cp backend/.env.example backend/.env     # ajustar JWT_ACCESS_SECRET, SITE_ID, DB_*
cp vision/.env.example   vision/.env     # ajustar VISION_SERVICE_TOKEN, provider
docker compose up -d --build
docker compose run --rm backend npm run seed   # crea el admin (SEED_ADMIN_*)
```

**URLs locales:**
- **API / Swagger:** `http://localhost:3010/api/docs`
- **Kiosko (terminal de puerta):** `http://localhost:3010/kiosk/`
- **Consola de administración:** `http://localhost:3010/kiosk/admin.html`
- **Registro facial guiado:** `http://localhost:3010/kiosk/enroll.html`
- Vision (interno): `http://vision:8200` · Qdrant `127.0.0.1:6335` · Postgres `127.0.0.1:5434`

### Backend en local SIN Docker (desarrollo rápido con hot-reload)

```bash
cd backend
npm install
npm run build
npm run seed         # requiere Postgres accesible y backend/.env
npm run start:dev    # hot-reload (modo desarrollo)
```

### Scripts disponibles (`backend/package.json`)

| Script | Qué hace |
|---|---|
| `npm run build` | Compila TS (`nest build`) |
| `npm run start:dev` | Arranca con watch (hot-reload) |
| `npm run start:prod` | Arranca desde `dist/` (producción) |
| `npm run seed` | Crea el admin inicial desde `SEED_ADMIN_*` |
| `npm run typeorm …` | CLI TypeORM (data-source en `src/database/`) |
| `npm run migration:run` / `:revert` | Aplicar/revertir migraciones |
| `npm run lint` / `format` | ESLint fix / Prettier |

---

## 6. 🚀 EL FLUJO COMPLETO: cambio → build → push → deploy

> **Este es el corazón del documento.** Cada vez que hagas un cambio, sigue
> estos 4 pasos en orden. No te saltes ninguno.

```
┌─────────────┐   1) editar+probar   ┌──────────────┐   2) commit+push
│   LOCAL     │ ────────────────────▶│   validado   │ ─────────────────▶ GitHub (main)
│ (tu PC)     │      docker compose  │ en local     │
└─────────────┘                      └──────────────┘
                                                                            │
                                                  3) git pull en el server ◀┘
                                                                            │
                          ┌──────────────────────────────────────────────────┘
                          ▼
                   ┌──────────────┐   4) sync + rebuild   ┌──────────────────┐
                   │ ~/access     │ ─────────────────────▶│ ~/access-demo    │
                   │ (repo git)   │   rsync src + UI      │ (stack en marcha)│
                   └──────────────┘   docker build        └────────┬─────────┘
                                                                       │ 5) verificar
                                                                       ▼
                                                              https://demo.visionyx.lat ✅
```

### PASO 1 — Local: editar y probar

Edita lo que necesites en tu PC. Luego valida que todo funciona en local:

```bash
# Si cambiaste TypeScript del backend (src/):
cd backend && npm run build && npm run start:dev   # hot-reload para iterar

# O levanta el stack completo (lo más fiel a producción):
docker compose up -d --build
docker compose run --rm backend npm run seed
# Proueba en: http://localhost:3010/kiosk/admin.html
```

**No pases al paso 2 hasta que funcione en local.** Esta es la regla de oro.

### PASO 2 — Local: commit + push a `main`

```bash
# Ver qué cambiaste:
git status
git diff

# Commitea SOLO lo coherente con mensajes descriptivos:
git add <archivos que tocaste>
git commit -m "descripción clara del cambio"

# Sube a GitHub:
git push origin main
```

> ⚠ **Nunca** subas secretos: `.env`, `dist/`, `node_modules/`, `cuentas/` están
> en `.gitignore` — verifícalo con `git status` antes de commitear.

### PASO 3 — Servidor: traer los cambios (`git pull`)

Conéctate por SSH al servidor y trae lo que acabas de pushear:

```bash
ssh -i "C:\Users\Hide\Documents\ssh-key-2026-06-11.key" ubuntu@157.137.230.190

# En el servidor:
cd ~/access
git pull https://github.com/hyperbonos4-creator/Access.git main
# (o si quieres meter el token en línea, para forzar el pull en repo privado:)
# git pull https://<TOKEN>@github.com/hyperbonos4-creator/Access.git main
```

### PASO 4 — Servidor: sincronizar al demo y reconstruir

El demo corre en `~/access-demo`; el repo git limpio está en `~/access`. Hay que
copiar lo que cambió de uno al otro, y luego rebuild.

```bash
cd ~/access-demo

# (a) Si cambió backend TypeScript (incluido el copiloto) → sincroniza src:
rsync -a --delete ~/access/backend/src/ backend/src/

# (b) Si cambió la UI (admin/kiosko/enroll + assets) → sincroniza public:
rsync -a ~/access/backend/public/ public/

# (c) Si además cambió vision → sincroniza vision/app:
rsync -a --delete ~/access/vision/app/ vision/app/

# (d) Si cambiaste el docker-compose.yml (p. ej. nuevos volúmenes/env):
cp ~/access/docker-compose.yml docker-compose.yml
sed -i -E 's/"3010:3000"/"127.0.0.1:3010:3000"/' docker-compose.yml   # loopback del demo
```

Luego reconstruye **solo lo que cambió** (más rápido que rebuild todo):

```bash
cd ~/access-demo

# Solo backend TS (lo habitual):
docker compose up -d --build backend

# Si además cambió vision:
docker compose up -d --build vision

# Si cambiaste el compose o quieres rebuild completo:
docker compose up -d --build
```

### PASO 5 — Servidor: verificar que todo quedó bien

```bash
docker ps --format '{{.Names}}\t{{.Status}}'
docker logs office_backend --tail 30
curl -s -o /dev/null -w 'HTTP %{http_code}\n' https://demo.visionyx.lat/api/v1/access/health
```

Todo OK = contenedores `Up`, health `HTTP 200`. (Ver [sección 10](#10--comprobaciones-y-verificación)
para el check completo.)

---

## 7. 🧠 Qué cambia con rebuild y qué no (vital)

Esto es lo que más errores causa. Memorízalo:

| Qué cambiaste | ¿Rebuild de imagen? | Acción |
|---|---|---|
| **UI** (`backend/public/*.html`, `assets/*`, CSS/JS) | ❌ **NO** | Se monta como volumen `:ro`. Basta con `rsync` a `public/` y **refrescar el navegador**. |
| **Backend TypeScript** (`backend/src/**/*.ts`): copiloto, dominio, módulos | ✅ **SÍ** | `rsync src/` → `docker compose up -d --build backend` |
| **Vision** (`vision/app/**/*.py`) | ✅ **SÍ** | `rsync vision/app/` → `docker compose up -d --build vision` |
| **`docker-compose.yml`** (volúmenes, env, puertos) | ✅ **SÍ** | Copiar + `sed` loopback → `docker compose up -d --build` |
| **`backend/package.json`** (nueva dependencia) | ✅ **SÍ** | `rsync` + `docker compose up -d --build backend` (reinstala deps) |
| **`vision/requirements.txt`** (nueva dependencia) | ✅ **SÍ** | `rsync` + `docker compose up -d --build vision` |
| **Variables de entorno** (`backend/.env` / `vision/.env`) | ⚠ depende | Editar el `.env` del demo y **restart** el contenedor (`docker compose restart backend`). No requiere `--build`. |

> La UI (`backend/public/`) se monta como volumen **read-only**: el HTML/JS/CSS
> se actualiza **sin reconstruir** la imagen. El TypeScript compilado sí requiere
> `--build backend`.

---

## 8. 🔧 Variables de entorno (resumen)

### `backend/.env` (ver `backend/.env.example`)

```env
# App
NODE_ENV=development           # production en el server (lo fuerza el compose)
PORT=3000
API_PREFIX=api/v1
CORS_ORIGIN=http://localhost:3001
SWAGGER_ENABLED=true           # false en el demo

# Identidad del sitio (1 oficina = 1 SITE_ID → namespace Qdrant faces_<SITE_ID>)
SITE_ID=office

# Base de datos
DB_HOST=localhost              # postgres en Docker
DB_PORT=5432
DB_USER=access
DB_PASSWORD=access
DB_NAME=access_control
DB_SYNCHRONIZE=true            # dev: crea/actualiza esquema desde entidades

# JWT (min 16 chars; sin placeholders en producción)
JWT_ACCESS_SECRET=change_me_dev_only_min_16_chars
JWT_ACCESS_TTL=12h

# Admin inicial (lo crea `npm run seed`)
SEED_ADMIN_EMAIL=admin@office.local
SEED_ADMIN_PASSWORD=ChangeMe123!

# Autorización (puerta única): enrolar habilita en todas las puertas
AUTO_AUTHORIZE_ENROLLED=true
DOOR_OPEN_HOLD_MS=6000

# Vision_Service (microservicio facial)
VISION_SERVICE_URL=http://localhost:8200
VISION_SERVICE_TOKEN=
VISION_SERVICE_TIMEOUT_MS=5000
VISION_ACTIVE_LIVENESS_TIMEOUT_MS=45000

# Cámara IP
CAMERA_ISAPI_PORT=80

# Vista remota "Cámara en vivo" (familiar)
FAMILY_STREAM_SECRET=          # vacío = deshabilitada
FAMILY_ACCESS_POINT_ID=

# Asistente "Vix" + Copiloto interno (GLM vía Cloudflare Workers AI)
ASSISTANT_BASE_URL=https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1
ASSISTANT_API_KEY=
ASSISTANT_MODEL=@cf/zai-org/glm-4.7-flash
ASSISTANT_MAX_TOKENS=700
ASSISTANT_TEMPERATURE=0.4
ASSISTANT_TIMEOUT_MS=22000
ASSISTANT_DISABLE_THINKING=true

# Copiloto interno (reutiliza ASSISTANT_*)
COPLOT_ACTIONS_ENABLED=true
COPLOT_REPO_ROOT=              # /repo en Docker
COPLOT_MAX_ROUNDS=6
COPLOT_HISTORY_LIMIT=12
COPLOT_RATE_WINDOW_MS=60000
COPLOT_RATE_MAX=12

# Rotador de cuentas Cloudflare
AUTO_ROTATION_ENABLED=true
MAX_ACCOUNT_FAILURES=3
ACCOUNT_COOLDOWN_MS=300000

# Demo efímero (solo servidor)
DEMO_MODE=true
DEMO_TTL_MINUTES=60
DEMO_MAX_ACTIVE_SESSIONS=40
DEMO_SWEEP_SECONDS=60
DEMO_EMAIL_DOMAIN=demo.visionyx.lat
```

### `vision/.env` (ver `vision/.env.example`)

```env
VISION_ENV=development
VISION_HOST=0.0.0.0
VISION_PORT=8200
VISION_SERVICE_TOKEN=          # obligatorio en producción

VISION_EXECUTION_PROVIDER=cpu  # cpu | directml | cuda | tensorrt
VISION_EMBEDDING_MODEL=arcface # arcface | adaface
VISION_EMBEDDING_DIM=512
VISION_MODELS_DIR=/models

VISION_DEFAULT_MATCH_THRESHOLD=0.5
VISION_DEFAULT_LIVENESS_THRESHOLD=0.7
VISION_MIN_FACE_QUALITY=0.5

VISION_QDRANT_URL=http://qdrant:6333
VISION_QDRANT_API_KEY=
VISION_QDRANT_COLLECTION_PREFIX=faces_
```

> Los umbrales efectivos (`matchThreshold`, `livenessThreshold`) los manda el
> Backend por punto de acceso; los de Vision son fallback.

---

## 9. 📜 Scripts de despliegue del servidor

Cada cambio grande tiene su script en la raíz del repo. **Se corren en el
servidor, dentro de `~/access-demo`**. En el flujo normal (paso 4 de la sección
6) no necesitas la mayoría; están para despliegues específicos.

| Script                | Qué hace                                                        |
|-----------------------|----------------------------------------------------------------|
| `deploy-demo.sh`      | **Genera `.env` del demo desde cero** (regenera JWT y VISION_TOKEN). Úsalo solo si quieres resetear el demo. |
| `deploy-ephemeral.sh` | Sincroniza `backend/src` + `vision/app` + UI desde `/tmp` (override efímero). NO regenera secretos. |
| `deploy-assistant.sh` | Configura "Vix" (GLM/Cloudflare): recibe la **API key como `$1`**. Sincroniza src + `.env` ASSISTANT + rebuild. |
| `deploy-copilot.sh`   | Despliega el Copiloto: `src` (con módulo `copilot/`) + UI + `.env` COPLOT + rebuild backend. |
| `deploy-site.sh`      | Publica la **web institucional** (`visionyx.lat`) en `/var/www/visionyx`. Hace `git pull` de `~/access` y rsync. |
| `nginx-demo.sh`       | Configura nginx + certificado Let's Encrypt para `demo.visionyx.lat`. |
| `oracle-cam-setup.sh` | Configura el Oracle como "puerta pública" segura de la cámara (proxy HTTPS + Basic Auth + Let's Encrypt). |
| `seed-point.sh`       | Crea un punto de acceso demo (`SIMULATED`) vía API, si no existe ninguno. |
| `tunnel.ps1`          | (**Windows**) Túnel SSH inverso: lleva el RTSP de la cámara de casa al servidor Oracle. |
| `website/cambiar-clave.sh` | Cambio interactivo de contraseña de correo del contenedor `mailserver`. |

### Caso frecuente: desplegar el Copiloto

```bash
cd ~/access-demo

# Origen: /tmp/newsrc (override efímero) si existe; si no, el repo ~/access
bash deploy-copilot.sh
# Asegura backend/src + UI del copiloto + docker-compose (montaje /repo) + COPLOT_* + rebuild
```

### Caso frecuente: configurar el asistente Vix

```bash
cd ~/access-demo
bash deploy-assistant.sh "<CLOUDFLARE_API_KEY>"
# Vix y Copiloto comparten el proveedor GLM (ASSISTANT_*); con esto, el copiloto ya tiene modelo.
```

### Caso frecuente: publicar la web institucional

```bash
bash deploy-site.sh
# Hace pull de main en ~/access, respalda y publica SOLO el contenido web en /var/www/visionyx
```

---

## 10. ✅ Comprobaciones y verificación

### Health-check completo (copy-paste en el servidor)

```bash
echo "== contenedores =="; docker ps --format '{{.Names}}\t{{.Status}}'
echo "== health =="; curl -s -o /dev/null -w 'HTTP %{http_code}\n' https://demo.visionyx.lat/api/v1/access/health
echo "== copilot env =="; grep -cE '^(ASSISTANT_API_KEY|COPLOT_REPO_ROOT)=' ~/access-demo/backend/.env
echo "== tablas copilot =="; docker exec office_postgres psql -U access -d access_control -c '\dt copilot_*'
```

**Todo OK** = contenedores `Up`, health `HTTP 200`, copilot env `≥2`, tablas
`copilot_*` listadas.

### Comandos útiles de operación

```bash
docker ps --format '{{.Names}}\t{{.Status}}'
docker logs -f office_backend        # logs en vivo (Ctrl+C salir)
docker compose -f ~/access-demo/docker-compose.yml restart backend
docker stats --no-stream             # uso de recursos
docker system df && docker image prune -f   # limpiar imágenes viejas
```

> Tras reiniciar el servidor, el stack vuelve solo: todos los contenedores
> tienen `restart: unless-stopped`.

### Verificar el Copiloto en el servidor

```bash
# vars presentes en el .env del demo:
grep -E '^(ASSISTANT_|COPLOT_)' ~/access-demo/backend/.env

# el repo está montado y legible dentro del backend:
docker exec office_backend sh -c 'ls /repo/backend/src/copilot >/dev/null && echo OK'

# tablas creadas (DB_SYNCHRONIZE=true las crea al arrancar):
docker exec office_postgres psql -U access -d access_control -c '\dt copilot_*'
```

Desde el navegador: `https://demo.visionyx.lat/kiosk/admin.html` → pestaña
**Copiloto** (requiere login ADMIN/OPERATOR).

---

## 11. 🔒 Archivos que NO están en git

Están en `.gitignore`; ya viven en el servidor. Solo recréalos si los borras o
montas el server desde cero (vía `scp`):

| Archivo            | Para qué                              |
|--------------------|---------------------------------------|
| `backend/.env`     | Config del demo (JWT, VISION, ASSISTANT, COPLOT…). Lo genera `deploy-demo.sh`. |
| `vision/.env`      | Config de Vision (token, modelo, Qdrant). |
| `cuentas/cuentas.json` | Pool de cuentas Cloudflare del rotador. |
| `vision/models/*`  | Pesos ONNX (`buffalo_l`, MiniFASNet). Se descargan en el primer uso o se montan como volumen. |

Otros ignorados: `node_modules/`, `dist/`, `.claude/`, `__pycache__/`, logs,
`pro/`, `BUILD.md`, `DEPLOY-SERVER.md`.

---

## 12. 🩺 Solución de problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| Cambios en la UI no se ven | El navegador cacheó el HTML/JS | Hard refresh (Ctrl+F5) o `docker compose restart backend` (volumen `:ro` ya está actualizado por rsync) |
| Cambios en TS no hacen efecto | Olvidaste `--build` | `docker compose up -d --build backend` (el TS compilado requiere rebuild) |
| `git pull` pide password en el server | Repo privado sin token | `git pull https://<TOKEN>@github.com/hyperbonos4-creator/Access.git main` |
| Sesiones/tokens caducan todos | Regeneraste el `.env` con `deploy-demo.sh` | Es esperado: JWT y VISION_TOKEN son nuevos. Re-login en el panel. |
| Health devuelve otro código que 200 | Backend aún arrancando o caído | `docker logs office_backend --tail 50` y esperar; si no sube, `docker compose restart backend` |
| El copiloto no responde | Falta `ASSISTANT_API_KEY` | `bash deploy-assistant.sh "<CLOUDFLARE_API_KEY>"` (Vix y copiloto comparten el proveedor GLM) |
| `/repo` no legible en el backend | Falta el montaje en compose | `deploy-copilot.sh` lo repara, o `cp ~/access/docker-compose.yml` + `sed` loopback + rebuild |
| No llega la imagen de la cámara al servidor | Túnel caído | Re-lanzar `tunnel.ps1` en el PC de casa (mantiene la ventana abierta) |
| Let's Encrypt falla al configurar nginx | Faltan reglas Ingress en Oracle | VCN → Security List/NSG: agregar TCP 80 y 443 desde `0.0.0.0/0` |

---

## 13. 📖 Glosario rápido

- **Fail-secure:** ningún camino degradado abre la puerta. Si algo falla, se
  queda **bloqueada** (segura).
- **Kiosko:** terminal de puerta. Muestra el stream MJPEG y reconoce 1:N en bucle.
- **Liveness activo:** reto-respuesta en vivo (anti-foto/anti-pantalla). El
  navegador verifica con MediaPipe; el backend **revalida server-side** (no
  confía en el cliente).
- **`SITE_ID`:** namespace único del sitio (reemplaza el multi-tenant). Se usa
  en la colección Qdrant `faces_<SITE_ID>`.
- **`AUTO_AUTHORIZE_ENROLLED=true`:** enrolar a un empleado lo habilita en todas
  las puertas automáticamente (puerta única). Para gestión explícita por punto,
  ponerlo en `false` y usar `POST /api/v1/access/authorizations`.
- **Vix:** asistente de pre-venta de la web (GLM).
- **Copiloto:** asistente agéntico interno del panel. Reutiliza el proveedor GLM
  de Vix y añade function-calling con tres familias de tools: **código**
  (read-only, lee `/repo`), **sistema** (consultas) y **acción** (abre puerta,
  rota credenciales — solo si `COPLOT_ACTIONS_ENABLED=true`, auditado).
- **Loopback (`127.0.0.1:3010`):** en el servidor el backend solo escucha en
  local; nginx lo publica hacia internet con HTTPS.

---

### Convenciones de desarrollo (recordatorio)

- **Fail-secure primero:** cualquier camino degradado (Vision caído, score bajo,
  liveness dudoso) **niega** el acceso. Nunca abrir por defecto.
- **Privacidad:** embeddings solo en Qdrant; Postgres guarda metadatos.
  `controllerRef`, `rtspUrl` y datos sensibles **nunca** se serializan al cliente.
- Los DTOs se validan con `class-validator` en todos los endpoints.
- Todos los endpoints documentados con decoradores `@Api*` de Swagger.
- Commit por cambio coherente; usar mensajes descriptivos.

---

> **TL;DR del flujo:** editar y probar en local → `git push origin main` →
> SSH al servidor → `git pull` en `~/access` → `rsync` de lo que cambió a
> `~/access-demo` → `docker compose up -d --build <servicio>` → verificar
> health. **Nunca editar producción directamente.**
