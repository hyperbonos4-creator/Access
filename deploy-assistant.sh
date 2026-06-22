#!/usr/bin/env bash
# Despliega el asistente "Vix" (GLM vía Cloudflare). Recibe la API key como $1
# para no escribirla en el repo. Sincroniza src, configura .env y reconstruye.
set -euo pipefail
cd ~/access-demo
KEY="$1"
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p backups

echo "== 1) Backend src (backup fuera del contexto de build) =="
[ -d backend/src ] && mv backend/src "backups/src.bak.$TS"
cp -r /tmp/newsrc2 backend/src

echo "== 2) .env (ASSISTANT_*) =="
ENV=backend/.env
sed -i -E '/^(ASSISTANT_BASE_URL|ASSISTANT_API_KEY|ASSISTANT_MODEL|ASSISTANT_MAX_TOKENS|ASSISTANT_TEMPERATURE|ASSISTANT_TIMEOUT_MS|ASSISTANT_DISABLE_THINKING)=/d' "$ENV"
{
  echo "ASSISTANT_BASE_URL=https://api.cloudflare.com/client/v4/accounts/6aeb76221df7c285c17ebe3d6994a8ab/ai/v1"
  echo "ASSISTANT_API_KEY=$KEY"
  echo "ASSISTANT_MODEL=@cf/zai-org/glm-4.7-flash"
  echo "ASSISTANT_MAX_TOKENS=700"
  echo "ASSISTANT_TEMPERATURE=0.4"
  echo "ASSISTANT_TIMEOUT_MS=22000"
  echo "ASSISTANT_DISABLE_THINKING=true"
} >> "$ENV"

echo "== 3) Rebuild + restart backend =="
docker compose build backend > /tmp/asbuild.log 2>&1 && tail -3 /tmp/asbuild.log
docker compose up -d backend > /tmp/asup.log 2>&1
sleep 7
docker compose ps backend
echo "DONE"
