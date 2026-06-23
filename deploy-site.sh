#!/usr/bin/env bash
# Publica el sitio estático de VISIONYX (visionyx.lat) en el servidor.
# Hace pull de main, respalda la versión actual y copia SOLO el contenido web a
# /var/www/visionyx (excluye los archivos de infra que conviven en website/:
# postfix/nginx/.sh/.yml/secretos). Idempotente.
#
# Uso (en el servidor):  bash deploy-site.sh
# Variables opcionales:  REPO_DIR=~/access  WEB_ROOT=/var/www/visionyx  BRANCH=main
set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/access}"
WEB_ROOT="${WEB_ROOT:-/var/www/visionyx}"
BRANCH="${BRANCH:-main}"

echo "== 1) Actualizar repo ($BRANCH) en $REPO_DIR =="
cd "$REPO_DIR"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

echo "== 2) Respaldar versión publicada =="
if [ -d "$WEB_ROOT" ]; then
  sudo cp -a "$WEB_ROOT" "${WEB_ROOT}.bak.$(date +%Y%m%d-%H%M%S)"
fi
sudo mkdir -p "$WEB_ROOT"

echo "== 3) Publicar contenido web (sin --delete; excluye infra y secretos) =="
# website/ mezcla la web con archivos de servidor (postfix, nginx, scripts). Se
# excluyen explícitamente para no exponerlos en /var/www. No se usa --delete para
# no borrar archivos legítimos que no estén en el repo (p. ej. .well-known).
sudo rsync -a \
  --exclude '.git*' \
  --exclude '.well-known' \
  --exclude '*.sh' \
  --exclude '*.cf' \
  --exclude '*.pcre' \
  --exclude '*.conf' \
  --exclude '*.yml' \
  --exclude '*.yaml' \
  --exclude '*.code-workspace' \
  --exclude '.env*' \
  "$REPO_DIR/website/" "$WEB_ROOT/"

echo "== 4) Permisos =="
sudo chown -R www-data:www-data "$WEB_ROOT" 2>/dev/null || true

echo "OK: sitio publicado en $WEB_ROOT → https://visionyx.lat/"
echo "    (incluye demo-cicanet.html y el botón de demo en la tarjeta Telecom)"
