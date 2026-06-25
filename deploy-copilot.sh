#!/usr/bin/env bash
# deploy-copilot.sh — Despliega el Copiloto interno del panel de administración.
#
# El copiloto es un asistente agéntico en la pestaña 🤖 Copiloto del panel.
# Reutiliza el proveedor GLM de "Vix" (ASSISTANT_*, configuradas por
# deploy-assistant.sh) y añade function-calling (vars COPLOT_*).
#
# Sincroniza desde el repo ~/access (flujo git pull recomendado):
#   - backend/src           → módulo copilot/ (TypeScript, requiere --build)
#   - backend/public        → assets/copilot.js + admin.html + admin.js + admin.css
#                             (UI montada como volumen read-only: sin rebuild)
#   - docker-compose.yml    → asegura el montaje read-only ./ -> /repo
#                             (COPLOT_REPO_ROOT=/repo, para las code-tools)
# Asegura COPLOT_* en backend/.env y reconstruye el backend.
#
# Si /tmp/newsrc existe, se usa para el src (override efímero, igual que los
# demás deploy-*.sh).
set -euo pipefail
cd ~/access-demo
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p backups

# Origen del código. /tmp/newsrc (efímero) si existe; si no, el repo limpio.
if [ -d /tmp/newsrc ]; then
  SRC_DIR="/tmp/newsrc"
else
  SRC_DIR="$HOME/access/backend/src"
fi
PUB_DIR="$HOME/access/backend/public"   # UI siempre desde el repo
COMPOSE_SRC="$HOME/access/docker-compose.yml"

# ── 1) backend/src (incluye el módulo copilot/) ──────────────────────────────
echo "== 1) Backend src (copilot incluido) =="
[ -d backend/src ] && mv backend/src "backups/src.bak.$TS"
cp -r "$SRC_DIR" backend/src

# ── 2) UI del copiloto (public/, volumen read-only → sin rebuild de imagen) ──
echo "== 2) UI del copiloto =="
for f in assets/copilot.js assets/admin.js assets/admin.css admin.html; do
  if [ -f "$PUB_DIR/$f" ]; then
    [ -f "backend/public/$f" ] && cp "backend/public/$f" "backups/$(basename "$f").bak.$TS"
    cp "$PUB_DIR/$f" "backend/public/$f"
    echo "   ✓ $f"
  else
    echo "   · $f ausente en el repo, se omite"
  fi
done

# ── 3) docker-compose.yml: asegura el montaje read-only ./ -> /repo ──────────
echo "== 3) docker-compose.yml (montaje /repo para las code-tools) =="
cp docker-compose.yml "backups/docker-compose.yml.bak.$TS"
cp "$COMPOSE_SRC" docker-compose.yml
# El demo publica el backend solo por loopback; nginx hace de front público.
sed -i -E 's/"3010:3000"/"127.0.0.1:3010:3000"/' docker-compose.yml

# ── 4) .env: COPLOT_* (ASSISTANT_* las pone deploy-assistant.sh) ─────────────
echo "== 4) .env (COPLOT_*) =="
ENV=backend/.env
sed -i -E '/^COPLOT_(ACTIONS_ENABLED|REPO_ROOT|MAX_ROUNDS|HISTORY_LIMIT|RATE_WINDOW_MS|RATE_MAX)=/d' "$ENV"
cat >> "$ENV" <<'EOF'

# ── Copiloto interno (añadido por deploy-copilot.sh) ──
COPLOT_ACTIONS_ENABLED=true
COPLOT_REPO_ROOT=/repo
COPLOT_MAX_ROUNDS=6
COPLOT_HISTORY_LIMIT=12
COPLOT_RATE_WINDOW_MS=60000
COPLOT_RATE_MAX=12
EOF

# Verifica el proveedor GLM compartido. Si falta, avisa: el copiloto no
# responderá hasta correr deploy-assistant.sh con la API key.
if ! grep -q '^ASSISTANT_API_KEY=.' "$ENV"; then
  echo "   ⚠ ASSISTANT_API_KEY ausente en backend/.env."
  echo "     Corre: deploy-assistant.sh <CLOUDFLARE_API_KEY>"
fi

# ── 5) Rebuild + restart backend (el TS compilado requiere --build) ──────────
echo "== 5) Rebuild backend =="
docker compose up -d --build backend

# ── 6) Verificación rápida ───────────────────────────────────────────────────
echo "== 6) Estado =="
sleep 7
docker compose ps backend
echo "--- copilot env (esperado ≥2) ---"
grep -cE '^(ASSISTANT_API_KEY|COPLOT_REPO_ROOT)=' "$ENV"
echo "--- /repo legible dentro del backend (esperado OK) ---"
docker exec office_backend sh -c 'ls /repo/backend/src/copilot >/dev/null 2>&1 && echo OK || echo FALTA'
echo "DONE"
