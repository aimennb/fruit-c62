#!/usr/bin/env bash
#
# start.sh — Lance Fruiterie ERP en local (dev/prod) sur macOS (ou Linux).
# Le backend Node sert aussi le frontend React buildé (port 8080).
#
# PRÉREQUIS :
#   - Node.js 22+ (https://nodejs.org ou `brew install node`)
#   - Une base PostgreSQL 16+ DISPONIBLE, avec une DATABASE_URL valide.
#     Option A (Docker) :  docker run -d --name fruiterie-pg -p 5432:5432 \
#                            -e POSTGRES_USER=fruiterie -e POSTGRES_PASSWORD=fruiterie \
#                            -e POSTGRES_DB=fruiterie postgres:16
#     Option B (Postgres.app) : lancer l'app, puis utiliser son URL.
#
# USAGE :
#   ./start.sh            # build complet + migrate + seed + démarrage
#   ./start.sh --no-build # démarre directement (si déjà buildé)
#   ./start.sh --dev      # mode dev (tsx watch) au lieu de dist
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

# --- DATABASE_URL -----------------------------------------------------------
# Priorité : variable d'env déjà posée > .env backend > valeur par défaut Docker.
if [ -z "${DATABASE_URL:-}" ]; then
  if [ -f "$BACKEND/.env" ]; then
    set -a; source "$BACKEND/.env"; set +a
  fi
fi
export DATABASE_URL="${DATABASE_URL:-postgresql://fruiterie:fruiterie@localhost:5432/fruiterie}"

NO_BUILD=0
DEV=0
for arg in "$@"; do
  case "$arg" in
    --no-build) NO_BUILD=1 ;;
    --dev)      DEV=1 ;;
  esac
done

echo "== Fruiterie ERP =="
echo "DB  : $DATABASE_URL"

# --- Dépendances + Prisma --------------------------------------------------
echo "== Installation des dépendances =="
( cd "$BACKEND"  && npm install --no-audit --no-fund )
( cd "$FRONTEND" && npm install --no-audit --no-fund )

( cd "$BACKEND" && npx prisma generate )

if [ "$NO_BUILD" -eq 0 ]; then
  echo "== Build backend =="
  ( cd "$BACKEND"  && npm run build )
  echo "== Build frontend =="
  ( cd "$FRONTEND" && npm run build )
fi

# --- Migrations + seed (idempotent) ----------------------------------------
echo "== Migrations Prisma =="
( cd "$BACKEND" && npx prisma migrate deploy ) || echo "(!) migrate deploy a échoué — vérifie DATABASE_URL"
echo "== Seed (référentiel de démo) =="
( cd "$BACKEND" && npm run seed ) || echo "(!) seed a échoué — vérifie DATABASE_URL"

# --- Démarrage -------------------------------------------------------------
echo "== Démarrage sur http://localhost:8080 =="
echo "   Comptes : admin/admin123 · responsable/resp123 · employe/emp123"
if [ "$DEV" -eq 1 ]; then
  ( cd "$BACKEND" && exec npm run dev )
else
  ( cd "$BACKEND" && exec node dist/src/index.js )
fi
