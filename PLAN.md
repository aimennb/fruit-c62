# PLAN Fruiterie ERP — suivi du projet

**Dernière mise à jour** : 02/08/2026 (session 3 — restructuration Paiement Fournisseur)
**Emplacement** : /home/mimo/fruiterie-app
**Serveur** : http://localhost:8080 (backend Node/Express/Prisma + frontend buildé servi en dist)
**DB** : PostgreSQL local
**Comptes** : admin/admin123 · responsable/resp123 · employe/emp123
**RÈGLE CRITIQUE** : aucun repo git initialisé (≈16 livraisons non committées) — fragilité maximale, à figer en urgence.

---

## 1. État réel

### Phases terminées (avant le 01/08)
- **Phase A** — Fondations (auth JWT, Prisma, CRUD de base). ✅
- **Phase B** — Bordereaux fournisseur + réceptions + lots. ✅
- **Phase C** — Ventes/Factures/Paiements/Bulletin + correctifs. ✅
- Frais réception → bordereau (droitMarche/transport), page détail réception, avance champ direct, PDF réception avec frais. ✅ (25/07)

### Session du 01/08 — LIVRAISONS (toutes vérifiées en vrai par le chef)
1. **Bug réception/stock corrigé** — PATCH réception écrasait `remainingQuantity` du lot (= newColis au lieu de restant) et figeait le statut du bordereau. Corrigé : `remainingQuantity = restant` (newColis − vendus − pertes), statut recalculé dynamiquement (`vendus >= recus ? pret_a_cloturer : ouvert`). Preuve curl : 200→250 colis → colisRestant=50, statut=ouvert.
2. **MODULE CAISSE (Temps 1) — livré complet** :
   - 7 modèles Prisma (CashRegisterDay, CashRegisterEntry, Expense, CashSupply, CashRemittance, CashRegisterClosing, CashRegisterAuditLog) + migration.
   - API REST : jours liste/détail, dépense/appro/remise (créent auto les lignes caisse + recalcul), clôture (crée jour suivant avec openingCashFund = closingCashFund), annulation dépense (ligne inverse, pas de suppression), PDF A5 bordereau.
   - Calculs §15/§16 à la volée depuis Invoice/Payment (invoiceTotal, creditCollectionTotal, creditInvoiceTotal, encaissementReelVentes). Anti-doublon (sourceType+sourceId). Garde : saisie refusée si jour clôturé.
   - Front : /caisse (vue 4 colonnes + cartes mobile), /caisse/:date (entrées/sorties), /depenses, /depenses/nouvelle, /caisse/approvisionnement, /caisse/remise, /caisse/cloture.
   - **Correction calcul « Ventes à crédit »** (fin de session) : `creditInvoiceTotal` = MONTANT TOTAL de chaque facture non payée du jour (SENT/PARTIALLY_PAID/OVERDUE), PAS le reste dû. `creditCollectionTotal` = paiements clients sur factures du jour. `unpaidPartialInvoiceTotal` (reste dû) calculé séparément et EXCLU de totalOutputs (pas de double comptage). Preuve runtime : facture PARTIALLY_PAID 10000 → creditInvoiceTotal=10000 (pas 7000).
3. **Impression bordereau de caisse A5** — `backend/src/caisse/pdf.ts` (`buildBordereauCaissePdf`), endpoint `GET /api/cash-register/days/:date/pdf`, bouton « Imprimer A5 » sur CaisseDayDetail + CloturePage. PDF valide 1 page vérifié.
4. **Code-barres CODE128 + EAN13 → EAN13 seul** :
   - Champ `ean13` (String @unique, préfixe 2=Facture/3=Réception/4=Bordereau) + 11 chiffres séquence + checksum, sur Invoice/SupplierReception/SupplierBordereau. Backfill one-shot idempotent (`prisma/backfill-ean13.ts`) remplit les 41 docs existants.
   - `bwip-js` génère PNG EAN13. Double code-barres d'abord (CODE128 réf + EAN13), puis **EAN13 SEUL** (retiré CODE128 sur demande client).
   - **Placement final** : EAN13 centré EN EN-TÊTE, AU-DESSUS de la ligne de séparation, avant le titre (vérifié visuellement via vision sur PDF réception : « En-tête → Code-barres → Ligne → Titre »). 3 PDF : facture, réception, bordereau.
   - Endpoint `GET /api/search?q=<ean13 ou texte>` : EAN13 → redirige vers le doc (par préfixe), texte → liste (réf / nom client / fournisseur). Barres de recherche existantes de /receptions, /bordereaux, /ventes étendues pour accepter un EAN13 scanné (lecteur USB = saisie clavier). Hook `useBarcodeSearch`.
5. **Édition COMPLÈTE réception** (bouton Modifier) :
   - Backend PATCH étendu : `items[]` (calibres + nbrColis + poids), `droitMarche`, `transport`, `avanceMontant` — recalcul bordereau en Σ COMPLET (pas de delta, bordereau partagé N réceptions) en préservant `colisVendus`. Lots reconciliés (lot principal ajusté, lignes supplémentaires → nouveaux lots).
   - Front : modal d'édition complet type ReceptionNew (lignes calibre + avance + frais), lecture seule fournisseur/produit.
   - ⚠️ Client a ASSUMÉ le risque : édition complète autorisée même après vente.
6. **Navigation caisse cliquable** : Stats de CaisseDayDetail deviennent des liens → 5 pages liste filtrées par date (/caisse/:date/factures, /credits-encaisses, /depenses, /credits-crees, /remises). 5 endpoints backend + 5 fonctions api.ts + 5 routes App.tsx. Tous HTTP 200 vérifiés.

### Session du 01/08 (suite, soir) — LIVRAISONS + INFRA
1. **`git init` + commit figé** `b70ea5c` (131 fichiers, node_modules/dist ignorés) — fragilité max réglée.
2. **Fix bug `/caisse/:date/credits-crees`** `743c498` : montant affiché mais liste vide. Cause : endpoint `credit-sales` filtrait `OVERDUE OU encaisse=0`, excluant les PARTIALLY_PAID (encaisse>0) comptées dans l'agrégat `creditInvoiceTotal`. Aligné sur `status != 'PAID'`. Vérif curl + script ad-hoc : agrégat 13380 == liste 1 facture (F-2026-0017, PARTIALLY_PAID, 13380). Re-prouvé après wipe DB (facture test 100 == 100).
3. **Nettoyage base + re-seed** : soft-delete 328 rows de test (toutes tables `deletedAt`) + purge logs (auditLog 422, session 263, cashRegisterClosing…), puis `npm run seed` (6 produits, 5 clients, 3 fournisseurs, 3 users, 29 permissions). **0 transaction active**, référentiel cohérent.
4. **`start.sh`** `1ce6744` : lance sur macOS/Linux (deps + prisma generate/migrate/seed + build front+back + serveur :8080). Options `--no-build`, `--dev`. Prérequis Postgres documentés en tête.
5. **Repo GitHub créé + pushé** : `aimennb/fruit-c62` (branche `main`, 133 fichiers + README). Push via PAT (révoqué après coup). Clone : `git@github.com:aimennb/fruit-c62.git`.

### Règle de travail Fruiterie (validée par Mimo)
- **Le chef (Hermes) ne code PAS directement** → tout code délégué à des agents (subagents), y compris correctifs.
- **Brainstorm OBLIGATOIRE avant le code** : clarifier la sémantique métier (avance, crédit, recalcul bordereau).
- **Vérification du chef OBLIGATOIRE** : rapports agents = auto-déclarations. Le chef revérifie par grep terminal réel + curl + extraction PDF + vision sur PNG. **L'outil `search_files` donne des FAUX NÉGATIFS** — TOUJOURS confirmer avec `grep` terminal ou `read_file`.
- Nettoyage données de test (soft-delete) après preuve.
- **Git désormais obligatoire** : repo GitHub = source de vérité, pushé après chaque livraison.

---

## 2. Roadmap restante

### Session du 02/08 — RESTRUCTURATION Paiement Fournisseur (validée chef en vrai + capture navigateur)
- **SÉPARATION création / règlement** : la page `/paiements-fournisseur/nouveau` ne fait QUE créer le bon (fournisseur + bordereaux cochés), état `en_attente`. Le bordereau N'EST PAS décrémenté à la création. Le règlement (Payer/Encaisser, partiel multiple) se fait APRÈS via les boutons.
- **Statut de bon** : `SupplierPayment.status` (`en_attente` | `partiellement_paye` | `paye`). Recalculé après chaque règlement (tous bordereaux 'paye' → bon 'paye', sinon 'partiellement_paye'). Migration `20260802000010_add_supplier_payment_status` (prisma db execute add-only + migrate resolve --applied).
- **Nouveau endpoint** `POST /api/supplier-payments/:id/pay` {mode:'PAY'|'ENCAISSER', method?, date?, lines:[{bordereauId,montant}]} : décrémente montantFinalDu + statut bordereau, PAY → Payment + décrément Supplier.balance (CASH → sortie caisse réouverture auto si clôturé), ENCAISSER → impute avance FIFO, recalcule status bon. Paiement PARTIEL multiple OK (gardes surpaiement/bon soldé → 400).
- **Liste `/paiements-fournisseur`** : boutons **Payer / Encaisser à GAUCHE** (1ère colonne) + colonne Statut. Actifs si bon != 'paye'.
- **Détail `/paiements-fournisseur/:id`** : colonnes **Bon de réception (BR-xxxx)** + **Produit** ajoutées au tableau (backend renvoie `receptionRef` + `productName`). Boutons Payer / Encaisser (avance) en haut + modale de règlement (montant par bordereau, reste dû par défaut).
- **POINT D'ATTENTION (arci caisse)** : contrainte unique `(sourceType, sourceId)` sur CashRegisterEntry → 1 ligne de caisse PAR BON (cumulée au fil des versements), pas 1 ligne par versement. Si granularité par versement voulue, il faudra `sourceId` composite.
- Builds backend+frontend 0 erreur. Données test nettoyées (0 BP actif). Commit `e03e6a1` + suivants.

### Session du 01/08 (soir 3) — CORRECTIFS Paiement Fournisseur (validés chef en vrai)
- **MODIF 1** : Étape 1 = champ fournisseur SAISIE LIBRE (taper le nom → suggestions cliquables filtrées sur getSuppliers, aucune création auto). `SupplierPaymentNew.tsx` : Input + dropdown suggestions.
- **MODIF 2** : Étape 2 = colonne « Bon de réception » (BR-xxxx) ajoutée au tableau. Backend eligible renvoie `receptionRef` (relation bordereau.receptionId → SupplierReception.reference, chargée en 1 requête). 
- **MODIF 3** : Caisse = PLUS d'erreur 409 sur jour clôturé. Si un paiement CASH arrive sur un jour clôturé, le backend le RÉOUVRE automatiquement (statut 'ouverte', closedBy/closedAt null) + log audit 'reouverture', puis crée la sortie + recalcule. Vérif chef : POST PAY CASH sur 01/08 clôturé → 201 BP-2026-0007, totalOutputs 2000→4000.
- Builds backend+frontend 0 erreur. Données test nettoyées (0 BP actif, jour 01/08 remis outputs=0). Commit `e03e6a1`.

### Session du 01/08 (suite, soir 2) — MODULE PAIEMENT FOURNISSEUR (brainstorm + livraison)
- **Brainstorm validé** : 1 bon = 1 fournisseur ; bordereau récupéré auto SEULEMENT si statut `cloture`/`partiellement_paye` ; 2 boutons Payer (Payment + décrément Supplier.balance) / Encaisser (impute avance fournisseur via SupplierAdvanceAllocation) ; paiement CASH = sortie caisse (CashRegisterEntry sourceType SUPPLIER_PAYMENT → autresSorties) ; recalcul anti-double (montantFinalDu, statut paye/partiellement_paye) ; bordereaux paye exclus de sélection ; PDF A4 + EAN13 préfixe 5 ; fond VERT (paye) / ORANGE (partiellement_paye) sur /bordereaux et /fournisseurs/detail.
- **Modèles** : `SupplierPayment` (BP, EAN13 préfixe 5) + `SupplierPaymentLine`. Migration `20260801120000_add_supplier_payment` (appliquée via miga diff + db execute + migrate resolve --applied car shadow-DB cassée).
- **Backend** : `routes/supplier-payments.routes.ts` (liste, eligible/:supplierId, POST transactionnel, :id, :id/pdf) + `supplier-payments/pdf.ts` (A4). Réutilise `getOrCreateDay`/`assertPasDeDoublon`/`recalculerEtPersister` de cash-register.routes (exportés). barcode.ts préfixe 5. backfill-ean13 idempotent préfixe 5.
- **Frontend** : api.ts (+4 fns), App.tsx (3 routes), Layout (lien sidebar), SupplierPaymentsPage / SupplierPaymentNew (3 étapes SPA) / SupplierPaymentDetail, coloration Bordereaux.tsx + SupplierDetail.tsx.
- **Vérif chef en VRAI** : health OK ; GET liste (0 après nettoyage) ; POST PAY CASH 2000 → bordereau partiellement_paye + montantFinalDu DB=1000 + sortie caisse totalOutputs=2000 ; POST PAY BANK_TRANSFER → statut paye, PAS de caisse ; POST ENCAISSER → avance ALLOCATED, PAS de caisse/balance ; PDF 200 application/pdf 5200o ; capture navigateur étape 1/2/3 + fond VERT bordereau paye confirmé visuellement.
- **Nettoyage** : toutes les données de test soft-deletées (BP actifs = 0).
- **Commit** `git` OK (17 fichiers). **PUSH en attente** : PAT GitHub révoqué, pas de SSH → à refaire un PAT ou configurer SSH pour push `origin main` (`aimennb/fruit-c62`).

### Priorité immédiate
- [x] `git init` + commit + repo GitHub (`aimennb/fruit-c62`).
- [x] Fix bug caisse credits-crees.
- [x] Nettoyage DB + re-seed.
- [x] **Module Paiement Fournisseur** (brainstorm + livraison + vérif chef + commit). PUSH GitHub en attente (PAT révoqué).
- [ ] **PUSH GitHub** du module Paiement Fournisseur (nécessite nouveau PAT ou SSH).
- [ ] **Validation visuelle navigateur** complète (re-capture caisse/édition réception/scan EAN13 des livraisons 01/08 matin).
- [ ] **Temps 2 Caisse** : export Excel, réouverture autorisée d'un jour clôturé (endpoint absent pour l'instant — le garde bloque les saisies sur jour clôturé), correction du fonds d'ouverture, i18n AR sur pages caisse.
- [ ] **Phase D** : i18n FR/AR complet (toutes pages, RTL).
- [ ] **Phase E** : audit QA multi-experts en lecture seule + corrections.
- [ ] **Phase F** : packaging Tauri (.exe) + cloud + HTTPS.

### Correctifs / suivi
- [ ] Tests de non-régression flux Supprimer (soft-delete vente + facture).
- [ ] Cohérence recalcul Net en édition (Brut−Tare) avec total facture.
- [ ] Vérifier que le POST réception rattache bien au bon bordereau (il réutilise un bordereau existant ouvert au lieu d'en créer un nouveau — à confirmer avec Mimo).

---

## 3. Repo & lancement Mac
```bash
# Cloner
git clone git@github.com:aimennb/fruit-c62.git
cd fruit-c62
# Postgres dispo (Docker ou Postgres.app), régler DATABASE_URL dans backend/.env
./start.sh            # build + migrate + seed + serveur :8080
#  Comptes : admin/admin123 · responsable/resp123 · employe/emp123
#  Frontend servi par le backend sur http://localhost:8080
```

## 4. Commandes (rappel)
```bash
# Backend
cd /home/mimo/fruiterie-app/backend && npm run build
pkill -f "dist/src/index.js"; sleep 2; node dist/src/index.js
curl -s http://localhost:8080/api/health

# Frontend
cd /home/mimo/fruiterie-app/frontend && npm run build

# Backfill EAN13 (one-shot idempotent)
cd /home/mimo/fruiterie-app/backend && node prisma/backfill-ean13.ts
```

## 5. Arborescence clés (modifiés le 01/08)
```
backend/src/
  routes/cash-register.routes.ts     # module Caisse + search + endpoints drill-down par date
  routes/supplier-receptions.routes.ts  # PATCH édition complète + recalcul Σ bordereau
  routes/search.routes.ts            # /api/search (EAN13 + texte)
  caisse/pdf.ts                      # buildBordereauCaissePdf (A5)
  barcode.ts                         # EAN13 (bwip-js) + buildEan13Only + drawBarcodeFooter
  receptions/pdf.ts  bordereaux/pdf.ts  invoices/pdf.ts  # EAN13 en en-tête
  prisma/schema.prisma              # +7 modèles Caisse + ean13 (3 modèles)
  prisma/backfill-ean13.ts
  start.sh (racine)                  # lancement macOS/Linux
frontend/src/
  pages/CaissePage.tsx  CaisseDayDetail.tsx  DepensesPage.tsx  ExpenseNew.tsx
  pages/CashSupplyPage.tsx  CashRemittancePage.tsx  CloturePage.tsx
  pages/CaisseInvoices.tsx  CaisseCreditCollections.tsx  CaisseExpenses.tsx
  pages/CaisseCreditSales.tsx  CaisseRemittances.tsx
  pages/Receptions.tsx              # modal édition complète
  hooks/useBarcodeSearch.ts
  api.ts  App.tsx
```
