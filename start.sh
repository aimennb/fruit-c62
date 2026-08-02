#!/usr/bin/env bash
# =============================================================================
# start.sh — Mise à jour + démarrage de Fruiterie ERP
# Usage : ./start.sh            (depuis la racine fruiterie-app)
#         ./start.sh --no-pull  (saute le git pull)
# Compatible : serveur Linux (node) et Mac local (Docker ou node).
# =============================================================================
set -euo pipefail

# --- Config (à adapter si besoin) -------------------------------------------
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$APP_DIR/backend"
FRONTEND_DIR="$APP_DIR/frontend"
API_URL="${VITE_API_URL:-http://localhost:8080}"   # IP exposée pour le front
DO_PULL=1
# Parsing args : --no-pull (saute git pull) | http://... (API_URL du front)
for a in "$@"; do
  case "$a" in
    --no-pull) DO_PULL=0 ;;
    http*) API_URL="$a" ;;
  esac
done

# --- Couleurs ----------------------------------------------------------------
G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
log(){ echo -e "${G}[start]${N} $*"; }
warn(){ echo -e "${Y}[warn]${N} $*"; }
err(){ echo -e "${R}[err]${N} $*"; }

cd "$APP_DIR"

# --- 1. Récupérer le code ----------------------------------------------------
if [[ "$DO_PULL" -eq 1 ]]; then
  log "git pull origin main"
  git pull origin main
else
  warn "skip git pull (--no-pull)"
fi

# --- 2. Backend : install + prisma + seed + build ---------------------------
log "== BACKEND =="
cd "$BACKEND_DIR"
log "npm install"
npm install
log "prisma generate"
npx prisma generate
log "prisma db push (sync schéma, sans perte de données)"
npx prisma db push
log "seed (permissions + RECEPTION_READ/WRITE)"
npx tsx prisma/seed.ts
log "setup réceptionnaire (utilisateur receptionnaire + verrou)"
npx tsx prisma/setup-receptionnaire.ts
log "build backend"
npm run build

# --- 3. Frontend : install + build -------------------------------------------
log "== FRONTEND =="
cd "$FRONTEND_DIR"
log "npm install"
npm install
log "build front (VITE_API_URL=$API_URL)"
VITE_API_URL="$API_URL" npm run build

# --- 4. Démarrage ------------------------------------------------------------
cd "$BACKEND_DIR"
# Un conteneur backend existe-t-il (nom contenant 'backend') ?
BACK_CONTAINER=$(docker ps -q --filter "name=backend" 2>/dev/null | head -1 || true)
if [[ -n "$BACK_CONTAINER" ]]; then
  warn "Conteneur backend détecté ($BACK_CONTAINER) — redémarre-le :"
  warn "  docker compose restart backend   (ou docker restart $BACK_CONTAINER)"
  warn "Le build backend/front est fait ; redémarre le conteneur pour le prendre en compte."
elif command -v docker >/dev/null 2>&1 && docker ps -q 2>/dev/null | grep -q .; then
  # Docker présent mais PAS de conteneur backend -> on lance node quand même
  # (cas typique Mac : Postgres dans Docker, backend en node local)
  log "Docker présent mais aucun conteneur backend — lancement du backend node"
  pkill -f "node dist/src/index.js" 2>/dev/null || true
  sleep 1
  nohup node dist/src/index.js > /tmp/fruiterie-backend.log 2>&1 &
  sleep 4
  if curl -s -m 5 http://localhost:8080/api/health >/dev/null 2>&1; then
    log "${G}Backend UP${N} — http://localhost:8080/api/health OK"
  else
    err "Backend pas joignable — voir /tmp/fruiterie-backend.log"
    exit 1
  fi
else
  log "Arrêt d'un éventuel backend node sur 8080"
  pkill -f "node dist/src/index.js" 2>/dev/null || true
  sleep 1
  log "Démarrage backend (node dist/src/index.js) en arrière-plan"
  nohup node dist/src/index.js > /tmp/fruiterie-backend.log 2>&1 &
  sleep 4
  if curl -s -m 5 http://localhost:8080/api/health >/dev/null 2>&1; then
    log "${G}Backend UP${N} — http://localhost:8080/api/health OK"
  else
    err "Backend pas joignable — voir /tmp/fruiterie-backend.log"
    exit 1
  fi
fi

log "${G}Terminé.${N}"
log "Frontend buildé dans $FRONTEND_DIR/dist — sers ce dossier (nginx/static server)."
log "Admin : admin / admin123  |  Réceptionnaire : receptionnaire / [REDACTED]"
