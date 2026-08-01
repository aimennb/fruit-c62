# Fruiterie ERP — Grossiste fruits & légumes (Algérie)

ERP complet (achats, stocks, ventes, avances fournisseurs, bulletins bilingues FR/AR).
Devise : DA. Stack : Node 22 + TS + Express + Prisma + PostgreSQL (backend) / React + Vite + Tailwind (frontend).

## Mode d'hébergement actuel
Mode B (développement local) : serveur + PostgreSQL tournent sur cette machine, port **8080**.
Accès web : http://localhost:8080 (API + page de test login) et frontend en dev sur 5173.
Cloud + domaine + HTTPS prévus en Phase F (plus tard).

## Arborescence
```
fruiterie-app/
├── backend/        # API Express + Prisma
│   ├── src/        # auth, routes, middleware, swagger
│   ├── prisma/     # schema.prisma + seed.ts
│   └── dist/       # build compilé (node dist/src/index.js)
└── frontend/       # React + Vite + Tailwind (scaffold Phase A)
```

## Prérequis
- Node 22, PostgreSQL 16 local (installé via apt).
- `.env` présent dans `backend/` (DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET, PORT=8080).

## Lancer le backend (port 8080)
```bash
cd backend
npm install
npm run build
node dist/src/index.js          # écoute sur PORT (8080)
# ou en dev : npm run dev
```
Vérification :
- http://localhost:8080/        → page test login
- http://localhost:8080/api/health → {"status":"ok","db":true}
- http://localhost:8080/api-docs  → Swagger

## Lancer le frontend (dev)
```bash
cd frontend
npm install
npm run dev        # http://localhost:5173 (appelle l'API sur 8080)
```

## (Re)seeder la base
```bash
cd backend
npm run build
node dist/prisma/seed.js
```

## Comptes de test (démo, données fictives)
| Rôle        | Login       | Mot de passe |
|-------------|-------------|--------------|
| Admin       | admin       | admin123     |
| Responsable | responsable | resp123      |
| Employé     | employe     | emp123       |

RÈGLES DE SÉCURITÉ (moindre privilège, §5) :
- Admin : tout.
- Responsable : gestion métier SAUF users/roles/settings.
- Employé : lecture produits/fournisseurs/clients + écriture opérationnelle (bulletins/ventes/stocks/pertes). **JAMAIS** gestion de comptes.

## Données seedées
- 3 fournisseurs (Ferme El Wadi, Coopérative Blida, Domaine Saharien Dates)
- 5 clients, 6 produits (Pommes de terre, Tomates, Oignons, Oranges, Bananes, Dattes)
- 1 avance fournisseur d'exemple (AV-2026-0001, 50 000 DA)

## Notes d'architecture
- Argent : Prisma `Decimal` (NUMERIC(14,2)), **jamais de float**.
- Auth : JWT access (15 min) + refresh cookie httpOnly avec rotation.
- Limite brute-force : 5 tentatives / 15 min par IP.
- Soft-delete partout (`deletedAt`). AuditLog pour les connexions et actions.
- Schéma Prisma = TOUTES les entités du §40 (y compris SupplierAdvance / SupplierAdvanceAllocation aux champs exacts).

## État du projet
- Phase A (fondations) : ✅ terminée et testée.
- Phase B+ (modules métier, bulletin PDF bilingue, ventes, avances, Tauri/.exe) : à venir.
