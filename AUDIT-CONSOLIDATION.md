# CONSOLIDATION AUDIT — Fruiterie ERP (multi-experts, lecture seule)

Date : 2026-08-04 · Périmètre : backend + frontend Fruiterie ERP
Experts : Architect (backend), DB/Prisma, Logique métier/compta, Frontend/UX, Sécurité, QA
Mode : 100% lecture seule (aucun fichier de code modifié, aucune donnée créée, aucun push intermédiaire).
Rapports détaillés : AUDIT-architect.md, AUDIT-db.md, AUDIT-backend-logic.md, AUDIT-frontend.md, AUDIT-securite.md, AUDIT-qa.md (en cours).

> Les 3 bugs critiques corrigés avant l'audit (recyclage de bordereau, ventes comptant en crédit caisse, paiement fournisseur dans les dépenses) ne sont PAS re-signalés ci-dessous.

---

## 1. RÉSUMÉ EXÉCUTIF

Le projet est **globalement sain sur les fondations** (Decimal partout, transactions systématiques, soft-delete, anti-doublon caisse, permissions granulaires bien conçues) mais présente **des failles de cohérence et de sécurité réelles**, dont plusieurs P0 déjà matérialisées en base de production :

- **P0-SÉCU** : module Caisse + Paiements fournisseur + Bordereaux SANS aucune permission (`requireAuth` seul) — un réceptionnaire peut clôturer la caisse et payer un fournisseur. `GET /api/users/:id` renvoie le hash bcrypt.
- **P0-DONNÉES** : `Supplier.balance` a 2 sources de vérité → déjà divergent en base (3 fournisseurs faux). `colisVendus`/`totalBrutVentes` incrémentés sans jamais être décrémentés → double comptage. Paiement fournisseur CASH rouvre une journée clôturée sans re-clôture.
- **P0-STRUCTURE** : migrations désynchronisées (base en `db push`, 0 contrainte FK sur le cœur métier fournisseur/caisse). Numérotation documents non atomique (collisions en concurrence).

**Bilan consolidé (hors QA) :** ~12 P0, ~25 P1, ~20 P2, ~10 P3.

---

## 2. PLAN D'ACTION PRIORISÉ (P0 → P3)

### P0 — Critique (à corriger en urgence, risque financier/légal)

| # | Problème | Fichier:ligne | Impact | Correctif |
|---|----------|---------------|--------|-----------|
| P0-1 | Caisse sans permission (20 routes) | cash-register.routes.ts:22 | Détournement de fonds | `requirePermission('CASH_READ'/'CASH_WRITE')` |
| P0-2 | Paiements fournisseur/bordereaux/lots/search sans permission | supplier-payments:23, supplier-bordereaux:28, stock-lots:12, search:128 | Contournement du modèle de droits | Permissions PURCHASE_*/STOCK_READ + filtrer search par perm |
| P0-3 | `GET /users/:id` expose `passwordHash` | users.routes.ts:34-38 | Escalade ADMIN (hash faible) | Appliquer le `select` de la route liste |
| P0-4 | `Supplier.balance` 2 sources de vérité (divergent en base) | supplier-advances:55-76 vs supplier-payments:465, supplier-receptions:297 | Solde fournisseur faux, perte au prochain reconcile | Ledger `SupplierAccountEntry` = seule source de vérité |
| P0-5 | `colisVendus`/`poidsNetVendu`/`totalBrutVentes` jamais décrémentés | invoices:392-413 (absent PATCH/DELETE) | Double comptage permanent, clôture faussée | Rendre dérivés (recalcul agrégé) |
| P0-6 | Paiement fournisseur CASH rouvre une journée clôturée | supplier-payments:527-549 | Instantané de clôture faux | Refuser (409) ou réouverture explicite + re-clôture |
| P0-7 | Migrations désynchronisées (`db push`, 2/17 appliquées) | migrations/ + package.json:11 | Base non reconstructible, reset = perte totale | Baseline propre `migrate diff` + `resolve --applied` |
| P0-8 | Zéro clé étrangère sur le cœur fournisseur/caisse | schema.prisma:1018-1113, 1181-1240, 699 | Orphelins silencieux (dette fournisseur) | `@relation` + `onDelete` |

### P1 — Majeur (corriger avant mise en prod réelle)

- Numérotation documents non atomique (7 implémentations) → helper `services/references.ts` + séquence Postgres.
- `DELETE /sales/:id` déclaré 2× → la cascade factures est morte (P0-3 DB). Garder la version transactionnelle + garde DRAFT.
- `POST /invoices/:id/issue` : solde client hors transaction + réentrant → transaction + refus si `status!=='DRAFT'`.
- `PUT /sales/:id` : `deleteMany` physique hors transaction → soft-delete + transaction.
- Double comptage avance réception (déduite bordereau ET solde) → une seule source de vérité.
- Clôture bordereau impossible dès qu'il y a des pertes → `colisVendus+pertes >= colisRecus`.
- `montantFinalDu` écrasé par tout PATCH → séparer `montantFinalDu` (calculé) de `resteAPayer` (dérivé).
- Aucune annulation de bon de paiement fournisseur → `POST /:id/cancel` transactionnel.
- `supplierPaymentTotal` non persisté bien que dans `totalOutputs` → ajouter colonne ou agréger dans closing.
- `jour()` UTC vs local (Algérie UTC+1) → un seul `date.ts` partout.
- CORS `*` + credentials → whitelist prod.
- `userId` accepté du client (caisse) → forcer `req.user.id`.
- Fuite `e.message`/`err.meta` Prisma (~18 routes) → handler central + log serveur.
- Mots de passe démo faibles + `Reception123` en dur dans `setup-receptionnaire.ts` → changement obligatoire 1er login.
- Deux error handlers (1 mort) + `uncaughtException` avalé → 1 handler + `exit(1)` + superviseur.

### P2 — Mineur

- `money.ts` mort (0 import) vs 9 `const D` locales → centraliser.
- `getCompanyParams()` copié 4× → `services/companySettings.ts`.
- Boilerplate try/catch ~90× → `asyncHandler`.
- `montantFinalDu` peut être négatif (2 bordereaux déjà) → borne ou `avoirFournisseur`.
- Soft-delete non filtré dans les `inUse` count → `deletedAt: null`.
- Précision prix unitaire `Decimal(14,2)` insuffisante → `(14,4)`.
- Requêtes non bornées (scans de table) → pagination uniforme.
- `Payment` sans lien `SupplierPayment`/`bordereauId` → ajouter FK.
- `dejaPris` charge toute la table sans filtre soft-delete/fournisseur → filtrer.
- Statut bordereau modifiable arbitrairement → retirer du PATCH ou machine à états.

### P3 — Cosmétique

- Page `/test` HTML inline avec identifiants en clair → `public/test.html`, dev only.
- `any` omniprésent sur chemins financiers → typer DTO.
- Langue FR/EN mélangée → convention documentée.
- Swagger `/api-docs` public → auth ADMIN ou dev only.
- Stubs 501 montés en prod → purger.

---

## 3. POINTS FORTS (à préserver)

- Decimal partout, jamais de float sur l'argent.
- Transactions Prisma systématiques sur les flux complexes.
- Anti-doublon caisse via `@@unique(sourceType, sourceId)` + `assertPasDeDoublon`.
- Caisse en lecture seule des modules amont (agrégats à la volée).
- Cohérence agrégat ↔ drill-down.
- Soft-delete rigoureux + double journal d'audit.
- Permissions granulaires dynamiques bien conçues (à étendre aux modules qui les ignorent).
- Aucune injection SQL (les 4 `$queryRawUnsafe` sont paramétrés).
- Refresh token haché en base, rotation/révocation.
- Commentaires métier de qualité documentant les règles et bugs passés.

---

## 4. PROCHAINES ÉTAPES RECOMMANDÉES

1. **T0 (sécurité)** : P0-1/2/3 (permissions + fuite hash) — correctifs courts, à faire avant toute exposition réseau.
2. **T0 (données)** : P0-4/5/6 (balance fournisseur, colis vendus, réouverture caisse) — scripts de rattrapage DB nécessaires.
3. **T1 (structure)** : P0-7/8 (migrations + FK) — à planifier en maintenance, avec dump préalable.
4. **T2** : P1 (numérotation, cascade factures, issue idempotent, etc.).
5. **T3** : P2/P3 (dettes techniques).

_Audit multi-experts en lecture seule. Les correctifs de bugs (1 réception = 1 bordereau, ventes comptant hors crédit, paiement fournisseur séparé des dépenses) sont déjà appliqués, buildés et en production de test._
