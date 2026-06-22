#!/usr/bin/env bash
# Despliegue del demo público de VISIONYX Access en el servidor.
set -euo pipefail
cd ~/access-demo

JWT=$(openssl rand -hex 24)
VTOKEN=$(openssl rand -hex 24)

cat > backend/.env <<EOF
NODE_ENV=production
PORT=3000
API_PREFIX=api/v1
CORS_ORIGIN=https://demo.visionyx.lat,https://visionyx.lat,https://www.visionyx.lat
SWAGGER_ENABLED=false
SITE_ID=visionyx-access-demo
DB_HOST=postgres
DB_PORT=5432
DB_USER=access
DB_PASSWORD=access
DB_NAME=access_control
DB_SYNCHRONIZE=true
JWT_ACCESS_SECRET=${JWT}
JWT_ACCESS_TTL=12h
SEED_ADMIN_EMAIL=demo@visionyx.lat
SEED_ADMIN_PASSWORD=VisionyxDemo2026!
AUTO_AUTHORIZE_ENROLLED=true
DOOR_OPEN_HOLD_MS=6000
DEMO_MODE=true
DEMO_TTL_MINUTES=60
DEMO_MAX_ACTIVE_SESSIONS=40
DEMO_SWEEP_SECONDS=60
DEMO_EMAIL_DOMAIN=demo.visionyx.lat
VISION_SERVICE_URL=http://vision:8200
VISION_SERVICE_TOKEN=${VTOKEN}
VISION_SERVICE_TIMEOUT_MS=8000
VISION_ACTIVE_LIVENESS_TIMEOUT_MS=45000
CAMERA_ISAPI_PORT=80
FAMILY_STREAM_SECRET=
EOF

cat > vision/.env <<EOF
VISION_ENV=production
VISION_HOST=0.0.0.0
VISION_PORT=8200
VISION_LOG_LEVEL=info
VISION_SERVICE_TOKEN=${VTOKEN}
VISION_EXECUTION_PROVIDER=cpu
VISION_EMBEDDING_MODEL=arcface
VISION_EMBEDDING_DIM=512
VISION_MODELS_DIR=/models
VISION_DEFAULT_MATCH_THRESHOLD=0.5
VISION_DEFAULT_LIVENESS_THRESHOLD=0.7
VISION_MIN_FACE_QUALITY=0.5
VISION_QDRANT_URL=http://qdrant:6333
VISION_QDRANT_COLLECTION_PREFIX=faces_
EOF

# El backend solo debe ser accesible por nginx (loopback), no público directo.
sed -i 's/"3010:3000"/"127.0.0.1:3010:3000"/' docker-compose.yml

echo "OK: .env creados y puerto restringido a loopback."
