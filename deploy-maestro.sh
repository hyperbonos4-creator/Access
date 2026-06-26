#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
#  deploy-maestro.sh — VISIONYX Access
#  Script MAESTRO de despliegue end-to-end (LOCAL → build → push → SERVIDOR).
#
#  Corre en tu PC (Git Bash en Windows / bash en Linux·macOS) y orquesta todo
#  el flujo de la "regla de oro":
#
#     [LOCAL] editar+probar  →  commit+push a main
#              │
#              └─►  [SERVIDOR Oracle] git pull → rsync al demo → rebuild → health
#
#  La parte del servidor se ejecuta REMOTAMENTE por SSH (no necesitas rsync en
#  Windows: el rsync corre en el Oracle). Solo reconstruye lo que cambió (la UI
#  es volumen read-only y no requiere rebuild; el TypeScript sí).
#
#  ── Uso ───────────────────────────────────────────────────────────────────
#    ./deploy-maestro.sh                 # flujo interactivo completo
#    ./deploy-maestro.sh -y              # no pedir confirmaciones (CI/rapido)
#    ./deploy-maestro.sh --skip-push     # deployar sin pushear (ya está en main)
#    ./deploy-maestro.sh --no-build      # saltar el build local de validación
#    ./deploy-maestro.sh --no-verify     # saltar el health-check final
#    ./deploy-maestro.sh -m "msg"        # mensaje de commit (default: pregunta)
#
#  ── Token de GitHub (repo privado) ─────────────────────────────────────────
#  El servidor hace `git pull` de un repo PRIVADO. Resuelve el token en orden:
#     1) variable de entorno  GITHUB_TOKEN
#     2) archivo              ~/.access-deploy-token
#     3) lo extrae de         ./DEPLOY-SERVER.md  (si existe, ya está escrito ahí)
#     4) lo pide interactivo  (oculto)
#  Nunca se hardcodea aquí → este script es seguro de commitear.
#
#  Ver MAESTRO.md §6 para el detalle de cada paso.
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ─────────────────────────── CONFIG (editable) ─────────────────────────────
REMOTE_HOST="${REMOTE_HOST:-ubuntu@157.137.230.190}"
SSH_KEY="${SSH_KEY:-$HOME/Documents/ssh-key-2026-06-11.key}"
REPO_URL="https://github.com/hyperbonos4-creator/Access.git"
BRANCH="${BRANCH:-main}"
HEALTH_URL="${HEALTH_URL:-https://demo.visionyx.lat/api/v1/access/health}"
TOKEN_FILE="${TOKEN_FILE:-$HOME/.access-deploy-token}"
# ───────────────────────────────────────────────────────────────────────────

# ── flags por defecto ──
ASSUME_YES=false
SKIP_PUSH=false
SKIP_LOCAL_BUILD=false
SKIP_VERIFY=false
COMMIT_MSG=""

# ─────────────────────────── logging / helpers ─────────────────────────────
if [[ -t 1 ]]; then
  C_RST=$'\033[0m';  C_CYAN=$'\033[1;36m'; C_GRN=$'\033[1;32m'
  C_YLW=$'\033[1;33m'; C_RED=$'\033[1;31m';  C_DIM=$'\033[2m'
else
  C_RST=""; C_CYAN=""; C_GRN=""; C_YLW=""; C_RED=""; C_DIM=""
fi
step()  { printf "\n${C_CYAN}▶ %s${C_RST}\n" "$*"; }
ok()    { printf "  ${C_GRN}✓${C_RST} %s\n" "$*"; }
warn()  { printf "  ${C_YLW}!${C_RST} %s\n" "$*"; }
info()  { printf "  ${C_DIM}·${C_RST} %s\n" "$*"; }
die()   { printf "\n${C_RED}✖ %s${C_RST}\n" "$*" >&2; exit 1; }
ask()   { # ask "¿pregunta?" -> devuelve 0 si sí. Respeta ASSUME_YES.
  if $ASSUME_YES; then warn "$* (auto: sí)"; return 0; fi
  local resp; printf "  ${C_YLW}?${C_RST} %s [s/N] " "$*"
  read -r resp
  [[ "$resp" =~ ^[sSyY]$ ]]
}

# ────────────────────────────── arg parsing ────────────────────────────────
usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes)       ASSUME_YES=true; shift ;;
    --skip-push)    SKIP_PUSH=true;  shift ;;
    --no-build)     SKIP_LOCAL_BUILD=true; shift ;;
    --no-verify)    SKIP_VERIFY=true; shift ;;
    -m)             COMMIT_MSG="${2:?falta el mensaje para -m}"; shift 2 ;;
    -h|--help)      usage ;;
    *) die "flag desconocido: $1 (usa --help)" ;;
  esac
done

# ─────────────────────────── token de GitHub ────────────────────────────────
resolve_token() {
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    GITHUB_TOKEN_VAL="$GITHUB_TOKEN"; info "token leído de \$GITHUB_TOKEN"
  elif [[ -f "$TOKEN_FILE" ]]; then
    GITHUB_TOKEN_VAL="$(tr -d '[:space:]' < "$TOKEN_FILE")"; info "token leído de $TOKEN_FILE"
  elif [[ -f "DEPLOY-SERVER.md" ]] && grep -q 'github_pat_' DEPLOY-SERVER.md; then
    GITHUB_TOKEN_VAL="$(grep -o 'github_pat_[A-Za-z0-9_]*' DEPLOY-SERVER.md | head -1)"
    info "token extraído de DEPLOY-SERVER.md"
  else
    if $ASSUME_YES; then die "GITHUB_TOKEN no encontrado y -y no permite pedirlo."; fi
    printf "  ${C_YLW}?${C_RST} Pega el PAT de GitHub (oculto): "
    read -rs GITHUB_TOKEN_VAL; echo
    [[ -n "$GITHUB_TOKEN_VAL" ]] || die "token vacío; no se puede hacer pull en el server"
  fi
}

# ════════════════════════════ PASO 0: PREFLIGHT ════════════════════════════
preflight_local() {
  step "0) Pre-checks locales"
  command -v git   >/dev/null || die "falta 'git'"
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "no estás dentro del repo access/"
  [[ "$(git rev-parse --abbrev-ref HEAD)" == "$BRANCH" ]] \
    || die "estás en rama '$(git rev-parse --abbrev-ref HEAD)', se requiere '$BRANCH'"
  ok "en repo, rama $BRANCH"

  [[ -f "$SSH_KEY" ]] || die "no encuentro la llave SSH: $SSH_KEY (ajusta \$SSH_KEY)"
  ok "llave SSH presente"

  if ! $SKIP_PUSH; then resolve_token; fi
}

preflight_remote() {
  step "0b) Pre-check del servidor (SSH)"
  info "probando conexión a $REMOTE_HOST ..."
  ssh -i "$SSH_KEY" -o ConnectTimeout=10 -o BatchMode=yes "$REMOTE_HOST" \
      'test -d ~/access && test -d ~/access-demo && echo REMOTE_OK' \
    >/dev/null 2>&1 || die "no llego al server o faltan ~/access o ~/access-demo"
  ok "servidor accesible; ~/access y ~/access-demo existen"
}

# ═════════════════════════ PASO 1: BUILD LOCAL ═════════════════════════════
local_build() {
  step "1) Build local de validación"
  if $SKIP_LOCAL_BUILD; then warn "saltado (--no-build)"; return 0; fi
  if ! ask "¿Levanto el stack local (docker compose --build) para validar?"; then
    warn "build local omitido por el usuario"; return 0; fi

  command -v docker >/dev/null || { warn "docker no disponible en este shell; salto build local"; return 0; }
  if ! docker info >/dev/null 2>&1; then
    warn "docker no responde (¿Docker Desktop apagado?); salto build local"; return 0; fi

  info "docker compose up -d --build (esto puede tardar) ..."
  if docker compose up -d --build; then
    ok "stack local levantado"
  else
    die "el build local falló. No pushear hasta arreglarlo (regla de oro)."
  fi
  info "prueba en: http://localhost:3010/kiosk/admin.html"
  ask "¿El cambio funciona bien en local? Confirmar para continuar" \
    || die "abortado por el usuario antes del push."
}

# ═══════════════════════ PASO 2: COMMIT + PUSH ═════════════════════════════
commit_and_push() {
  step "2) Commit + push a $BRANCH"
  if $SKIP_PUSH; then warn "saltado (--skip-push): deploy directo del estado de main"; return 0; fi

  # ¿Hay algo que subir? Dos fuentes: (a) cambios sin commitear, (b) commits
  # locales por delante de origin. Si ninguna → solo deploy de lo ya en main.
  local dirty=false ahead=false
  if ! git diff --quiet HEAD || ! git diff --cached --quiet \
     || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
    dirty=true
  fi
  if [[ -n "$(git rev-list --count "origin/${BRANCH}..HEAD" 2>/dev/null || echo 0)" \
        && "$(git rev-list --count "origin/${BRANCH}..HEAD" 2>/dev/null || echo 0)" -gt 0 ]]; then
    ahead=true
  fi

  if ! $dirty && ! $ahead; then
    warn "sin cambios locales ni commits por pushear. Se hará deploy de lo ya en main."
    return 0
  fi

  if $ahead && ! $dirty; then
    info "$(git rev-list --count "origin/${BRANCH}..HEAD") commit(s) local(es) por delante de origin."
    ask "¿Hago push directo de esos commits (sin re-commit)?" \
      || die "abortado."
    info "git push origin $BRANCH ..."
    git push origin "$BRANCH"
    ok "cambios en GitHub ($BRANCH)"
    return 0
  fi

  echo "${C_DIM}── git status ──${C_RST}"; git status --short
  echo "${C_DIM}── diff stat ──${C_RST}";  git diff --stat HEAD
  echo

  # El .gitignore ya protege secretos (.env, dist, node_modules, cuentas/...).
  ask "¿Hago 'git add -A' con todo lo anterior? (secretos ya están ignorados)" \
    || die "abortado."

  if [[ -z "$COMMIT_MSG" ]]; then
    if $ASSUME_YES; then
      COMMIT_MSG="deploy: $(date +%Y-%m-%d\ %H:%M) — $(git status --short | head -3 | tr '\n' ' ')"
    else
      printf "  ${C_YLW}?${C_RST} Mensaje de commit: "
      read -r COMMIT_MSG
      [[ -n "$COMMIT_MSG" ]] || COMMIT_MSG="deploy $(date +%Y-%m-%d_%H:%M)"
    fi
  fi

  git add -A
  git commit -m "$COMMIT_MSG" || warn "nada nuevo que commitear"
  info "git push origin $BRANCH ..."
  git push origin "$BRANCH"
  ok "cambios en GitHub ($BRANCH)"
}

# ═══════════════════════ PASO 3: DEPLOY EN SERVIDOR ════════════════════════
# Todo el bloque corre REMOTAMENTE por SSH. Le pasamos el token y la rama como
# argv para no mezclar expansión local/remota (heredoc comillado 'REMOTE').
deploy_remote() {
  step "3) Deploy en el servidor (pull + rsync + rebuild)"

  ssh -i "$SSH_KEY" -o ServerAliveInterval=30 "$REMOTE_HOST" \
      bash -s -- "$GITHUB_TOKEN_VAL" "$BRANCH" <<'REMOTE'
set -euo pipefail
TOKEN="${1:?falta token}"; BRANCH="${2:-main}"
REPO="$HOME/access"; DEMO="$HOME/access-demo"

# checksum de un árbol de archivos (excluye node_modules). Para detectar qué
# cambió tras el pull y reconstruir SOLO lo necesario (ver MAESTRO.md §7).
cs() { find "$1" -type f -not -path '*/node_modules/*' \
          -exec md5sum {} + 2>/dev/null | sort | md5sum | cut -c1-12; }

echo "== estado ANTES del pull =="
cd "$REPO"
B_SRC=$(cs backend/src); B_PUB=$(cs backend/public); B_VIS=$(cs vision/app)
B_BE_DOCK=$(cs backend/Dockerfile; echo "$(md5sum backend/package.json 2>/dev/null)")
B_VI_DOCK=$(cs vision/Dockerfile;  echo "$(md5sum vision/requirements.txt 2>/dev/null)")
B_COMPOSE=$(md5sum docker-compose.yml 2>/dev/null | cut -c1-12)

echo "== git pull ($BRANCH) =="
git fetch origin "$BRANCH"
# pull simple primero; si el repo es privado sin credenciales cacheadas,
# reintenta con el token en la URL (no queda en config ni historial).
if ! git pull --ff-only origin "$BRANCH" 2>/dev/null; then
  echo "   (pull directo falló; reintentando con token)"
  git pull "https://${TOKEN}@github.com/hyperbonos4-creator/Access.git" "$BRANCH"
fi
git --no-pager log --oneline -1

echo "== qué cambió =="
A_SRC=$(cs backend/src); A_PUB=$(cs backend/public); A_VIS=$(cs vision/app)
A_BE_DOCK=$(cs backend/Dockerfile; echo "$(md5sum backend/package.json 2>/dev/null)")
A_VI_DOCK=$(cs vision/Dockerfile;  echo "$(md5sum vision/requirements.txt 2>/dev/null)")
A_COMPOSE=$(md5sum docker-compose.yml 2>/dev/null | cut -c1-12)

CH_SRC=false;    CH_PUB=false;    CH_VIS=false;    CH_COMPOSE=false
[ "$B_SRC"     != "$A_SRC" ]     && { CH_SRC=true;     echo "   · backend/src (TypeScript) cambió"; }
[ "$B_PUB"     != "$A_PUB" ]     && { CH_PUB=true;     echo "   · backend/public (UI) cambió"; }
[ "$B_VIS"     != "$A_VIS" ]     && { CH_VIS=true;     echo "   · vision/app (Python) cambió"; }
[ "$B_COMPOSE" != "$A_COMPOSE" ] && { CH_COMPOSE=true; echo "   · docker-compose.yml cambió"; }

if ! $CH_SRC && ! $CH_PUB && ! $CH_VIS && ! $CH_COMPOSE; then
  echo "   · sin cambios detectados respecto al demo actual"
fi

echo "== sincronizar repo → demo (rsync, solo deltas) =="
cd "$DEMO"
# backend TS: reemplazo total (--delete) para no dejar archivos muertos.
rsync -a --delete "$REPO/backend/src/" backend/src/
# UI: montada como volumen :ro EN backend/public (ver docker-compose.yml). El
# target debe coincidir con el mount del contenedor (./backend/public), no un
# public/ plano, o el contenedor seguiría sirviendo la UI vieja.
rsync -a           "$REPO/backend/public/" backend/public/
# vision: reemplazo total del código Python.
rsync -a --delete "$REPO/vision/app/"   vision/app/
# compose: del repo, forzando el backend a loopback (nginx es el front público).
cp "$REPO/docker-compose.yml" docker-compose.yml
sed -i -E 's/"3010:3000"/"127.0.0.1:3010:3000"/' docker-compose.yml

echo "== rebuild (solo lo necesario) =="
# Reglas (MAESTRO.md §7):
#   · UI (public/)         → NO rebuild (volumen :ro): ya está actualizado.
#   · backend TS / pkgs    → rebuild backend.
#   · vision / reqs        → rebuild vision.
#   · docker-compose.yml   → build full.
REBUILD_BACKEND=false
REBUILD_VISION=false
$CH_SRC     && REBUILD_BACKEND=true
$CH_VIS     && REBUILD_VISION=true
# package.json / requirements / Dockerfiles también fuerzan rebuild:
git -C "$REPO" diff --quiet HEAD@{1} -- backend/package.json backend/Dockerfile 2>/dev/null \
  || REBUILD_BACKEND=true
git -C "$REPO" diff --quiet HEAD@{1} -- vision/requirements.txt vision/Dockerfile 2>/dev/null \
  || REBUILD_VISION=true

if $CH_COMPOSE; then
  echo "   · compose cambió → build completo"
  docker compose up -d --build
elif $REBUILD_BACKEND && $REBUILD_VISION; then
  docker compose up -d --build backend vision
elif $REBUILD_BACKEND; then
  docker compose up -d --build backend
elif $REBUILD_VISION; then
  docker compose up -d --build vision
elif $CH_PUB; then
  echo "   · solo UI cambió (volumen :ro): sin rebuild. Refresca el navegador."
else
  echo "   · nada que reconstruir; el stack ya está al día."
fi

echo "== estado de contenedores =="
sleep 6
docker compose ps
echo "REMOTE_DONE"
REMOTE
  ok "deploy aplicado en el servidor"
}

# ═══════════════════════ PASO 4: VERIFICACIÓN ══════════════════════════════
verify() {
  step "4) Verificación (health check)"
  if $SKIP_VERIFY; then warn "saltado (--no-verify)"; return 0; fi

  info "contenedores en el servidor:"
  ssh -i "$SSH_KEY" "$REMOTE_HOST" \
    'docker ps --format "  {{.Names}}\t{{.Status}}" | grep office || echo "  (sin contenedores office_)"'

  info "health: $HEALTH_URL"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$HEALTH_URL" || echo "000")
  if [[ "$code" == "200" ]]; then
    ok "health HTTP 200 ✓ — demo en marcha"
  else
    warn "health devolvió HTTP $code (puede estar aún arrancando; reintenta en ~20s)"
    info "logs: ssh -i \"\$SSH_KEY\" $REMOTE_HOST 'docker logs office_backend --tail 30'"
    return 1
  fi

  echo
  echo "${C_GRN}══════════════════════════════════════════════════════${C_RST}"
  echo "${C_GRN}  ✅ DEPLOY COMPLETO → https://demo.visionyx.lat${C_RST}"
  echo "${C_GRN}  ✅ DEPLOY COMPLETO → https://demo.visionyx.lat${C_RST}"
  echo "${C_GRN}══════════════════════════════════════════════════════${C_RST}"
}

# ═════════════════════════════ ORQUESTACIÓN ════════════════════════════════
main() {
  echo "${C_CYAN}╔══════════════════════════════════════════════════════╗${C_RST}"
  echo "${C_CYAN}║   deploy-maestro.sh · VISIONYX Access (end-to-end)   ║${C_RST}"
  echo "${C_CYAN}╚══════════════════════════════════════════════════════╝${C_RST}"

  preflight_local
  preflight_remote
  local_build
  commit_and_push
  deploy_remote
  verify || warn "deploy quedó aplicado pero el health no dio 200 todavía."
}

main "$@"
