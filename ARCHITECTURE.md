# Architecture — Fruiterie ERP

> **Date de l'audit** : 23 juillet 2026
> **Type** : audit lecture-seule + documentation d'architecture (aucun code modifié)
> **État de la base** : base **fraîchement vidée** (TRUNCATE CASCADE). Seuls sont peuplés :
> `User` (3), `Permission` (29), `RolePermission` (65), plus `AuditLog` (3) et `Session` (2) générés par les connexions. Un fournisseur résiduel « rachid » (1 ligne dans `Supplier`) subsiste. **Toutes les autres tables métier sont à 0** (produits, clients, bulletins, ventes, factures, paiements, stocks, avances, réceptions, bordereaux, réglages, templates…). **`CompanySettings` est VIDE.**

---

## 1. Vue d'ensemble

| Élément | Détail |
|---|---|
| Domaine métier | ERP grossiste fruits & légumes (mandataire / commissionnaire), bilingue FR/AR |
| Backend | Node 22 + TypeScript + Express + Prisma + PostgreSQL |
| Frontend | React + Vite + TypeScript + Tailwind CSS |
| Port unique | **8080** — le backend sert l'API **et** le frontend React buildé |
| Devise | DA (dinar algérien) — argent **toujours en `Decimal`**, jamais en float |
| Auth | bcrypt + JWT (access token) + refresh token rotatif (sessions en base) |
| Serveur public | http://40.66.41.114:8080 |

**Qui sert quoi** : `src/index.ts` monte tous les routers sous `/api/*`, expose Swagger sur `/api-docs`, une page de test login sur `/test`, puis sert `frontend/dist` en statique. Toute route non-`/api` et non-`/test` renvoie `index.html` (SPA fallback).

---

## 2. Architecture backend

### Arbre `backend/src/`

```
src/
├── index.ts                 # bootstrap Express : middlewares, montage routers, static frontend, SPA fallback, error handlers globaux
├── config.ts                # config (port, corsOrigin, secrets JWT…)
├── prisma.ts                # instance PrismaClient partagée
├── money.ts                 # helpers Decimal (moneyAdd/Mul/Sub, round2, toNumber, formatDA)
├── swagger.ts               # spec OpenAPI + tags des stubs
├── types/shims.d.ts         # déclarations de types complémentaires
├── auth/
│   ├── auth.routes.ts       # POST /login, /refresh, /logout ; GET /me
│   ├── tokens.ts            # génération/vérif access + refresh (JWT rotatif)
│   ├── middleware.ts        # requireAuth, requireRole, requirePermission
│   ├── rateLimit.ts         # loginRateLimit (anti brute-force)
│   └── audit.ts             # auditLog() -> table AuditLog
├── routes/
│   ├── _helpers.ts          # dec(), parseListQuery, paginate, moneyField, notImplemented
│   ├── users.routes.ts      # CRUD utilisateurs (ADMIN)
│   ├── products.routes.ts   # CRUD produits + fournisseurs liés + stock initial
│   ├── product-categories.routes.ts
│   ├── units.routes.ts
│   ├── suppliers.routes.ts  # CRUD fournisseurs + relevé
│   ├── customers.routes.ts  # CRUD clients + résumé/relevé/crédit
│   ├── supplier-advances.routes.ts     # avances : allocate/refund/cancel/statement
│   ├── supplier-receptions.routes.ts   # bon réception -> lot+bordereau+mvt+avance
│   ├── supplier-bordereaux.routes.ts   # bordereau fournisseur : ventes, commission, clôture, PDF
│   ├── stock.routes.ts      # état stock, FIFO, pertes
│   ├── stock-lots.routes.ts # liste lots, FIFO
│   ├── sales.routes.ts      # ventes + sortie FIFO + confirm
│   ├── invoices.routes.ts   # factures + issue + PDF bilingue
│   ├── payments.routes.ts   # encaissements
│   ├── search.routes.ts     # recherche texte bilingue produits/clients
│   └── stub.routes.ts       # routers 501 (modules non implémentés) documentés Swagger
├── bulletins/
│   ├── bulletins.routes.ts  # bulletins d'achat : CRUD, validate, cancel, template, PDF
│   ├── pdf.ts, template.ts, types.ts, shape.ts
├── receptions/pdf.ts        # PDF A5 bon de réception bilingue
├── bordereaux/pdf.ts        # PDF A4 paysage bordereau bilingue
├── invoices/pdf.ts          # PDF facture de vente FR/AR
└── services/bulletinPdf.ts  # service PDF bulletin d'achat
```

### Couches
`route (Router Express)` → `validation Zod (safeParse)` → `logique métier + prisma.$transaction` → `Prisma` → `Postgres`. Sérialisation : les `Decimal` sont convertis en string via `dec()` (`_helpers.ts`) avant renvoi JSON.

### Auth & permissions
- **JWT rotatif** : `auth/tokens.ts` émet un access token (Bearer) + un refresh token stocké en base (`Session`, on garde le hash du refresh, jamais le token brut). `/api/auth/refresh` fait la rotation.
- **`requireAuth`** : vérifie le Bearer, recharge le `User` (actif, non supprimé) et remplit `req.user`.
- **`requireRole(...roles)`** : contrôle par enum `Role` (ADMIN / RESPONSABLE / EMPLOYE).
- **`requirePermission(...codes)`** : résout les permissions granulaires via `RolePermission` selon le rôle (ex. `PRODUCT_READ`, `SALE_WRITE`). 12 modules de permissions : admin, customer, invoice, payment, product, purchase, report, sale, settings, stock, supplier, user.

### Middlewares transverses
`cors` (crédentials), `express.json` (limite 2 mb), `cookie-parser`, `loginRateLimit`, error handler global (mappe P2025/P2003 → 400), et protection `uncaughtException` / `unhandledRejection` (le process ne meurt jamais).

### Gestion Decimal
`money.ts` centralise toute l'arithmétique monétaire avec `Prisma.Decimal`. Montants en `@db.Decimal(14,2)`, quantités/poids en `@db.Decimal(14,3)`. **Aucun float** dans les calculs DA.

### PDF
Génération PDFKit : `bulletins/pdf.ts` (bulletin d'achat), `receptions/pdf.ts` (bon de réception A5), `bordereaux/pdf.ts` (bordereau A4 paysage), `invoices/pdf.ts` (facture). Tous bilingues FR/AR et paramétrés par `CompanySettings` (mandataire, marché, mentions légales).

### Swagger
`src/swagger.ts` génère la spec OpenAPI, exposée sur `/api-docs`. Les modules « stub » (501) y sont documentés pour montrer la forme attendue.

---

## 3. Modèle de données (`prisma/schema.prisma`)

Conventions générales : `id` en `cuid()`, soft-delete via `deletedAt` sur les entités métier, audit léger via `createdBy` / `updatedBy` (stockés en String, sans relation inverse sur `User`), argent en `Decimal(14,2)`, quantités/poids en `Decimal(14,3)`.

**Enums** : `Role`, `AccountEntryType`, `AdvanceStatus`, `PurchaseStatus`, `SaleStatus`, `MovementType`, `InvoiceStatus`, `PaymentMethod`, `TemplateType`, `BackupType`, `BackupStatus`, `BulletinStatus`.

### Auth / rôles / audit
- **User** (email, username uniques, passwordHash, role, isActive) → `sessions`, `auditLogs`.
- **Permission** (code unique, label, module) → `rolePermissions`.
- **RolePermission** (clé composite `role` + `permissionId`) — mapping enum Role ↔ Permission.
- **Session** (jti unique, refreshHash, expiresAt, revokedAt) → User (cascade).
- **AuditLog** (action, entity, entityId, ip, details Json) → User (SetNull).

### Référentiels produits
- **Unit** (name, symbol unique) → products.
- **ProductCategory** (name unique) → products.
- **Product** (name/nameAr/nameBer, variety, origin, quality, calibre, sku unique, prix achat moyen/dernier, prix vente conseillé, alertThreshold, reorderLevel) → category?, unit, + relations vers purchaseItems, saleItems, invoiceItems, stockLots, stockMovements, priceHistories, bulletinItems, losses, suppliers.
- **ProductSupplier** (many-to-many produit↔fournisseur, `isPreferred`, unique `[productId,supplierId]`).

### Fournisseurs & avances
- **Supplier** (name unique, nameAr, contact, wilaya/commune, rc/nif/ai, `balance` Decimal) → accountEntries, advances, purchases, payments, stockLots, bulletins, productLinks, sales.
- **SupplierAccountEntry** (type DEBIT/CREDIT, amount, entryDate) → supplier.
- **SupplierAdvance** (reference unique AV-…, amount, allocatedAmount, refundedAmount, status AdvanceStatus) → allocations, refunds.
- **SupplierAdvanceAllocation** (advanceId, purchaseId?, purchaseBulletinId?, bordereauId?, amount ; unique `[advanceId,purchaseBulletinId]`).
- **SupplierAdvanceRefund** (advanceId, amount, method, refundDate).

### Clients
- **Customer** (name unique, nameAr, creditLimit, paymentTerms, `balance`) → sales, invoices, payments, creditNotes.

### Achats / bulletins
- **Purchase** (reference unique, status PurchaseStatus, subtotal/total) → items, bulletins, arrivals, advanceAllocations, payments.
- **PurchaseItem** (purchaseId, productId, quantity, unitPrice, total).
- **PurchaseBulletin** (reference unique, purchaseId?, supplierId, status BulletinStatus, validatedAt, archivedPdfPath, champs bulletin papier KHENOUCHI : deliveredTo/marque/emballage/consigne/carrier, totalWeight, totalAmount, paidAmount) → items, stockLots, advanceAllocations.
- **PurchaseBulletinItem** (bulletinId, productId, marque, nbrColis, poidsBrut, tare, poidsNet, prixUnitaire, montant, transportCost, fees, remises, origine/qualite/calibre).
- **Arrival** (reference unique, purchaseId, status) → stockLots.

### Stock
- **StockLot** (lotNumber unique, productId, supplierId, bulletinId?, arrivalId?, quantity, remainingQuantity, unitCost, purchasePrice, realCost, poids brut/tare/net, origin/quality/caliber, expiryDate) → movements, losses, invoiceItems, saleItems.
- **StockMovement** (productId, lotId?, type MovementType IN/OUT/ADJUST/TRANSFER/LOSS, quantity, reason).
- **Loss** (productId?, lotId?, quantity, cost, reason, lossDate).

### Ventes / factures / paiements
- **Sale** (reference unique, customerId?, supplierId?, status SaleStatus, subtotal/total) → items, invoices, payments.
- **SaleItem** (saleId, productId, quantity, unitPrice, total ; colonnes bulletin de vente colis/grossWeight/tare/netWeight ; lotId? relation SaleItemLot).
- **Invoice** (reference unique, saleId?, customerId?, status InvoiceStatus, subtotal, taxAmount, packingTotal, packingReturned, total) → items, creditNotes, payments.
- **InvoiceItem** (invoiceId cascade, description, productId?, quantity, unitPrice, total, packingUnitPrice, colis/grossWeight/tare/netWeight, lotId? relation InvoiceItemLot).
- **CreditNote** (reference unique, invoiceId?, customerId?, amount, status InvoiceStatus).
- **Payment** (reference unique, customerId?/supplierId?/saleId?/invoiceId?/purchaseId?, amount, method PaymentMethod).
- **PriceHistory** (productId, unitPrice, oldPrice/newPrice, effectiveDate).

### Réceptions / bordereaux fournisseur (module dédié)
- **SupplierReception** (reference unique BR-000001, supplierId, productId, nbrColis, poidsEmballageVide, avanceOui/avanceMontant, bordereauId?, lotId?). Règle : 1 réception = 1 lot = 1 bordereau.
- **SupplierBordereau** (reference unique BF-000001, supplierId, productId, receptionId, lotId, colisRecus/Vendus/Restant, totalBrutVentes, commissionType/Value, avancesAffectees, montantFinalDu, statut string ouvert|pret_a_cloturer|cloture|…, dates ouverture/clôture, montants définitifs).
- **SupplierBordereauCorrection** (bordereauId, userId, motif, champ, ancienneValeur/nouvelleValeur) — audit corrections post-clôture.

### Config / impression / sauvegarde
- **CompanySettings** (companyName, address, phone, taxId, currency=DA, receiptFooter, + params bulletin bilingue : mandataireNameAr/Fr, activity, market, carreau, mentionFr/Ar). **Un seul enregistrement attendu — actuellement VIDE.**
- **PrintTemplate** (name unique, type TemplateType, content HTML, isDefault).
- **Backup** (filename, path, type, status).

---

## 4. API publique (routes réellement enregistrées dans `index.ts`)

Tout est préfixé `/api`. Sauf `/auth/*` et `/health`, chaque route exige `requireAuth`. La colonne « Perm » indique la permission granulaire (`requirePermission`) réellement posée dans le code.

### Système / Auth
| Méthode | Route | Perm | Description |
|---|---|---|---|
| GET | /api/health | — | Ping serveur + DB |
| GET | /api-docs | — | Swagger UI |
| POST | /api/auth/login | — (rate-limit) | Connexion, renvoie accessToken |
| POST | /api/auth/refresh | — | Rotation refresh token |
| POST | /api/auth/logout | auth | Déconnexion / révocation session |
| GET | /api/auth/me | auth | Profil courant |

### Utilisateurs
| Méthode | Route | Perm | Description |
|---|---|---|---|
| GET | /api/users | USER_READ | Liste |
| GET | /api/users/:id | USER_READ | Détail |
| POST | /api/users | ADMIN + USER_CREATE | Créer |
| PUT | /api/users/:id | ADMIN + USER_UPDATE | Modifier |
| DELETE | /api/users/:id | ADMIN + USER_DELETE | Soft-delete |

### Produits / référentiels
| Méthode | Route | Perm | Description |
|---|---|---|---|
| GET | /api/products/search | PRODUCT_READ | Recherche texte bilingue |
| GET | /api/products | PRODUCT_READ | Liste paginée |
| GET | /api/products/:id | PRODUCT_READ | Détail |
| POST | /api/products | PRODUCT_CREATE | Créer (+ fournisseurs + stock initial) |
| PUT | /api/products/:id | PRODUCT_UPDATE | Modifier |
| DELETE | /api/products/:id | PRODUCT_DELETE | Soft-delete |
| GET/POST/PUT/DELETE | /api/product-categories(/:id) | PRODUCT_* | CRUD catégories |
| GET/POST/PUT/DELETE | /api/units(/:id) | PRODUCT_* | CRUD unités |

### Fournisseurs
| Méthode | Route | Perm | Description |
|---|---|---|---|
| GET | /api/suppliers | SUPPLIER_READ | Liste |
| GET | /api/suppliers/:id | SUPPLIER_READ | Détail |
| POST | /api/suppliers | SUPPLIER_CREATE | Créer |
| PUT | /api/suppliers/:id | SUPPLIER_UPDATE | Modifier |
| DELETE | /api/suppliers/:id | SUPPLIER_DELETE | Soft-delete |
| GET | /api/suppliers/:id/statement | SUPPLIER_READ | Relevé de compte |

### Clients
| Méthode | Route | Perm | Description |
|---|---|---|---|
| GET | /api/customers/search | CUSTOMER_READ | Recherche texte bilingue |
| GET | /api/customers | CUSTOMER_READ | Liste |
| GET | /api/customers/:id | CUSTOMER_READ | Détail |
| POST | /api/customers | CUSTOMER_CREATE | Créer |
| PUT | /api/customers/:id | CUSTOMER_UPDATE | Modifier |
| DELETE | /api/customers/:id | CUSTOMER_DELETE | Soft-delete |
| GET | /api/customers/:id/summary | CUSTOMER_READ | Résumé |
| GET | /api/customers/:id/statement | CUSTOMER_READ | Relevé |
| GET | /api/customers/:id/credit-check | CUSTOMER_READ | Contrôle crédit |

### Avances fournisseur
| Méthode | Route | Perm | Description |
|---|---|---|---|
| GET | /api/supplier-advances | SUPPLIER_READ | Liste |
| GET | /api/supplier-advances/:id | SUPPLIER_READ | Détail |
| POST | /api/supplier-advances | SUPPLIER_CREATE | Créer avance |
| PATCH | /api/supplier-advances/:id | PURCHASE_WRITE | Modifier |
| POST | /api/supplier-advances/:id/allocate | PURCHASE_WRITE | Affecter à un bulletin |
| POST | /api/supplier-advances/:id/refund | PURCHASE_WRITE | Rembourser |
| POST | /api/supplier-advances/:id/cancel | PURCHASE_WRITE | Annuler |
| GET | /api/supplier-advances/supplier/:id/statement | SUPPLIER_READ | Relevé avances fournisseur |

### Réceptions fournisseur
| Méthode | Route | Perm | Description |
|---|---|---|---|
| POST | /api/supplier-receptions | auth | Créer réception → lot+bordereau+mvt IN+avance |
| GET | /api/supplier-receptions | auth | Liste |
| GET | /api/supplier-receptions/:id | auth | Détail |
| PATCH | /api/supplier-receptions/:id | auth | Modifier (recalcul bordereau/lot) |
| GET | /api/supplier-receptions/:id/pdf | auth | Bon de réception PDF A5 |

### Bordereaux fournisseur
| Méthode | Route | Perm | Description |
|---|---|---|---|
| GET | /api/supplier-bordereaux | auth | Liste |
| GET | /api/supplier-bordereaux/:id | auth | Détail + tableau ventes + calculs |
| PATCH | /api/supplier-bordereaux/:id | auth | Commission (type/valeur) |
| POST | /api/supplier-bordereaux/:id/avances | auth | Affecter une avance |
| DELETE | /api/supplier-bordereaux/:id/avances/:allocationId | auth | Retirer une affectation |
| PATCH | /api/supplier-bordereaux/:id/cloture | auth | Clôturer |
| PATCH | /api/supplier-bordereaux/:id/correct | auth | Correction post-clôture |
| GET | /api/supplier-bordereaux/:id/pdf | auth | PDF A4 paysage bilingue |

### Stock & lots
| Méthode | Route | Perm | Description |
|---|---|---|---|
| GET | /api/stock | STOCK_READ | État du stock |
| GET | /api/stock/fifo | STOCK_READ | Vue FIFO |
| POST | /api/stock/loss | STOCK_WRITE | Enregistrer une perte |
| GET | /api/stock-lots | auth | Liste des lots |
| GET | /api/stock-lots/fifo | auth | Lots ordonnés FIFO |

### Bulletins d'achat
| Méthode | Route | Perm | Description |
|---|---|---|---|
| POST | /api/bulletins | PURCHASE_WRITE | Créer |
| GET | /api/bulletins | PURCHASE_READ | Liste |
| GET | /api/bulletins/:id | PURCHASE_READ | Détail |
| PUT | /api/bulletins/:id | PURCHASE_WRITE | Modifier |
| GET | /api/bulletins/:id/template | PURCHASE_READ | Données template |
| GET | /api/bulletins/:id/pdf | PURCHASE_READ | PDF bilingue |
| DELETE | /api/bulletins/:id | PURCHASE_WRITE | Soft-delete |
| POST | /api/bulletins/:id/validate | PURCHASE_WRITE | Valider (crée stock) |
| POST | /api/bulletins/:id/cancel | PURCHASE_WRITE | Annuler |

### Ventes
| Méthode | Route | Perm | Description |
|---|---|---|---|
| POST | /api/sales | SALE_WRITE | Créer |
| GET | /api/sales | SALE_READ | Liste |
| GET | /api/sales/:id | SALE_READ | Détail |
| GET | /api/sales/:id/invoice | SALE_READ | Facture liée |
| PUT | /api/sales/:id | SALE_WRITE | Modifier |
| DELETE | /api/sales/:id | SALE_WRITE | Supprimer |
| POST | /api/sales/:id/confirm | SALE_WRITE | Confirmer (sortie FIFO) |

### Factures
| Méthode | Route | Perm | Description |
|---|---|---|---|
| POST | /api/invoices | INVOICE_WRITE | Créer |
| GET | /api/invoices | INVOICE_READ | Liste |
| GET | /api/invoices/:id | INVOICE_READ | Détail |
| PATCH | /api/invoices/:id | INVOICE_WRITE | Modifier |
| POST | /api/invoices/:id/issue | INVOICE_WRITE | Émettre |
| GET | /api/invoices/:id/pdf | INVOICE_READ | PDF FR/AR |
| DELETE | /api/invoices/:id | INVOICE_WRITE | Supprimer |

### Paiements
| Méthode | Route | Perm | Description |
|---|---|---|---|
| POST | /api/payments | PAYMENT_WRITE | Encaissement |
| GET | /api/payments | PAYMENT_READ | Liste |
| DELETE | /api/payments/:id | PAYMENT_WRITE | Supprimer |

### Stubs (501 – non implémentés, documentés Swagger)
`/api/supplier-account-entries`, `/api/purchases`, `/api/purchase-items`, `/api/purchase-bulletins`, `/api/purchase-bulletin-items`, `/api/arrivals`, `/api/stock-movements`, `/api/sale-items`, `/api/credit-notes`, `/api/losses`, `/api/price-history`, `/api/settings`, `/api/print-templates`, `/api/backups`, `/api/audit-logs`, `/api/sessions`, `/api/permissions`, `/api/roles`. Chacun expose GET/GET:id/POST/PUT/PATCH/DELETE renvoyant **501 Not Implemented**.
> ⚠️ Le stub `/api/settings` recouvre `CompanySettings` : il n'existe **aucune route réelle** pour saisir les réglages société — voir §7.

---

## 5. Architecture frontend

### Arbre `frontend/src/`
```
src/
├── main.tsx              # bootstrap React + Router
├── App.tsx              # routes SPA + garde d'auth (Login / Protected+Layout)
├── auth.tsx            # contexte useAuth (login, user, token localStorage)
├── i18n.ts            # bascule FR/AR (useLang), RTL
├── api.ts            # client fetch centralisé (request<T>, ApiError, token Bearer)
├── types.ts         # types partagés (User, Product, Bulletin, Sale…)
├── index.css       # Tailwind
├── components/
│   ├── Layout.tsx   # coquille app (nav latérale)
│   └── ui.tsx       # Button, Input, Field, Spinner, ErrorBox
└── pages/
    ├── Dashboard.tsx
    ├── Products.tsx        # /produits
    ├── Suppliers.tsx       # /fournisseurs
    ├── Customers.tsx       # /clients-manage
    ├── Clients.tsx         # /clients
    ├── Bulletins.tsx       # /bulletins (liste bulletins d'achat)
    ├── Bulletin.tsx        # /ventes (bulletin de vente)
    ├── Stock.tsx           # /stock
    ├── Advances.tsx        # /avances
    ├── SaleNew.tsx         # /ventes/nouveau
    ├── Receptions.tsx      # /receptions
    ├── ReceptionNew.tsx    # /receptions/new
    ├── Bordereaux.tsx      # /bordereaux
    ├── BordereauDetail.tsx # /bordereaux/:id
    ├── Sales.tsx, Invoices.tsx, Payments.tsx  # (pages présentes, non toutes routées dans App.tsx)
```

### Routing (App.tsx)
Routes protégées montées dans `<Protected>` sous `<Layout>` : `/dashboard`, `/bulletins`, `/stock`, `/produits`, `/fournisseurs`, `/clients`, `/clients-manage`, `/avances`, `/ventes`, `/ventes/nouveau`, `/receptions`, `/receptions/new`, `/bordereaux`, `/bordereaux/:id`. Fallback → `/dashboard`. Sans user → `/login`.

### Appel API
`api.ts` : `const API = import.meta.env.VITE_API_URL ?? ''`. **URL relative par défaut** (vide) → le frontend appelle le même origin :8080 qui sert aussi l'API. Le token est lu dans `localStorage` et envoyé en `Authorization: Bearer`. Un handler 401 purge le token et déclenche la reconnexion.

---

## 6. État actuel de la base (référentiel de démo rétabli via `prisma/seed.ts`)

> Historique : la base a été TRUNCATE CASCADE (seuls User/Permission/RolePermission conservés) puis **le seed a été rejoué** pour rétablir le jeu de démo. État réel au 23/07/2026 :

| Table | Lignes | Note |
|---|---|---|
| User | 3 | **conservé** — comptes admin / responsable / employe |
| Permission | 29 | **conservé** — catalogue permissions (12 modules) |
| RolePermission | 65 | **conservé** — mapping rôle↔permission |
| Unit | 4 | **Kilogramme (kg), Caisse (cs), Bouquet (bt), Carton (ct)** — rétabli (erreur « cs introuvable » résolue) |
| ProductCategory | 3 | **Fruits, Légumes, Dattes & Séchés** — rétabli |
| Product | 6 | PDT, Tomates, Oignons, Oranges, Bananes, Dattes Deglet Nour — rétabli |
| Supplier | 4 | 3 fournisseurs de démo **+ 1 résiduel « rachid »** (saisi manuellement, à vérifier / nettoyer si non voulu) |
| Customer | 5 | 5 clients de démo — rétabli |
| CompanySettings | 1 | **RÉTABLI** (singleton) via seed — nom société / adresse / tél / footer bilingue |
| PrintTemplate | 1 | template « Facture standard » par défaut — rétabli |
| SupplierAccountEntry | 1 | acompte exemple (AV-2026-0001, 50000 DA) — rétabli |
| SupplierAdvance | 1 | avance exemple PENDING — rétablie |
| Session / AuditLog | régénérés | par les connexions récentes |
| Purchase, PurchaseBulletin(+Item), Arrival | 0 | vides (aucun achat saisi) |
| StockLot, StockMovement, Loss | 0 | vides |
| Sale, SaleItem, Invoice, InvoiceItem, CreditNote, Payment | 0 | vides (aucune vente/facture) |
| SupplierReception, SupplierBordereau, …Correction | 0 | vides |
| PriceHistory, Backup | 0 | vides |

**Note opérationnelle** : le référentiel (Unit/Category/Product/Supplier/Customer/CompanySettings) est **prêt à l'emploi** après rejeu du seed — plus besoin de re-saisir manuellement. Les données *métier* (achats, stocks, ventes, factures, paiements, réceptions, bordereaux) restent **vides** : c'est le point de départ propre pour tester les parcours.
**À nettoyer si besoin** : le fournisseur résiduel « rachid » (1 ligne hors seed) — supprimer via `DELETE FROM "Supplier" WHERE name='rachid'` si non voulu par le métier.

---

## 7. Points d'attention / dettes techniques (constat, sans correction)

- **CompanySettings sans route réelle** : `/api/settings` est un **stub 501**. Aucun endpoint ne permet de créer/éditer les réglages société ; il faudra insérer la ligne directement en base (ou implémenter la route) avant de pouvoir générer des PDF corrects.
- **Fournisseur résiduel « rachid »** : la base n'est pas 100 % propre (1 `Supplier`). À confirmer avec le métier avant re-saisie.
- **Permissions incohérentes selon modules** : plusieurs routers réels n'ont **aucune** `requirePermission` et se contentent de `requireAuth` : `stock-lots`, `supplier-receptions`, `supplier-bordereaux`. Tout utilisateur authentifié y accède, y compris les opérations sensibles (clôture bordereau, correction post-clôture, création réception + avance). Écart de sécurité vs les autres modules.
- **Réutilisation de permissions par proximité** : `units` et `product-categories` utilisent les permissions `PRODUCT_*` ; les avances utilisent `SUPPLIER_CREATE`/`PURCHASE_WRITE` (pas de permission dédiée « ADVANCE »).
- **Migrations manuelles/itératives par plusieurs agents** : 15 migrations Prisma horodatées du 22/07/2026, avec des allers-retours révélateurs (`restore_isactive`, `b1_referentiel_isactive`, champs bulletin bilingues ajoutés en plusieurs passes, `b4_alloc_purchase_optional`, `b6_stocklot_bulletin_optional`). Les modèles **SupplierReception / SupplierBordereau / SupplierBordereauCorrection** ne figurent dans aucune migration listée → probablement introduits via `prisma db push` (schéma et migrations potentiellement désynchronisés).
- **Colonnes dupliquées entre couches** : les colonnes bulletin de vente (colis/grossWeight/tare/netWeight) existent en double sur `SaleItem` **et** `InvoiceItem` ; poids brut/tare/net répétés sur `PurchaseBulletinItem` et `StockLot`. Risque d'incohérence de synchronisation.
- **`SupplierBordereau.statut` en String libre** (pas d'enum) : valeurs `ouvert|pret_a_cloturer|cloture|partiellement_paye|paye|annule` non contraintes au niveau schéma.
- **Double error-handler global** dans `index.ts` (deux `app.use(err…)`), et `uncaughtException/unhandledRejection` volontairement avalés → le serveur ne crashe jamais mais peut masquer des bugs.
- **Pages front orphelines** : `Sales.tsx`, `Invoices.tsx`, `Payments.tsx` existent mais ne sont pas montées dans `App.tsx` (routes non exposées à l'utilisateur).

---

## 8. Travaux récents (session du 23/07/2026 — reprise + correctifs + UI)

> Contexte de reprise : session antérieure (Phase C) laissée en l'air. Le chef (Hermes) a repris, délégué 100% du code aux agents (règle : ne code PAS direct), et prouvé chaque rendu par capture navigateur réelle sur http://40.66.41.114:8080.

### 8.1 Base de données — reset puis restauration référentiel
- `TRUNCATE TABLE … RESTART IDENTITY CASCADE` sur 33 tables (tout sauf `User`/`Permission`/`RolePermission`). Attention Prisma : tables crées en double-quotes → il faut double-quoter dans les requêtes SQL (`"User"`).
- Rejeu de `prisma/seed.ts` (`npx tsx prisma/seed.ts`) → rétablit le jeu de démo : **4 Unités** (kg/cs/bt/ct), **3 ProductCategory** (Fruits/Légumes/Dattes & Séchés), **6 Product**, **5 Customer**, **CompanySettings** (singleton), **PrintTemplate** (Facture standard), avance exemple.
- Bug rencontré : « Unité par défaut 'cs' introuvable » = les unités avaient été virées par le TRUNCATE ; résolu par le seed.
- Fournisseur résiduel « rachid » (1 ligne hors seed) subsiste — à supprimer via `DELETE FROM "Supplier" WHERE name='rachid'` si non voulu.

### 8.2 Correctif — Modal « Détail de la facture » (page Ventes)
- **Symptôme** : colonnes Colis/Brut/Tare/Net affichaient « X DA » (tout en dinar), sans unité de mesure.
- **Racine** : la fonction `da()` (formate « X DA ») était appliquée à tort sur des quantités physiques dans le mode lecture du modal (`frontend/src/pages/Bulletin.tsx`, bloc `~lignes 715-727`).
- **Correction** (agent) : Colis → « N colis », Brut/Tare/Net → « N kg » ; PU/Emballage/Total restent « N DA ». Headers « Brut (kg) » etc. ajoutés. Mode édition et backend non touchés. Build front exit 0. **Prouvé par capture navigateur** (V-2026-0002 / Bananes : 50 colis, 150 kg, 0.2 kg, 140 kg).

### 8.3 Recherche côté client — /bordereaux et /receptions
- Ajout d'une barre de recherche (Input + filtre `filtered` côté client, insensible à la casse, partiel) sur les 2 pages.
- /bordereaux : filtre référence + nom fournisseur + nom produit.
- /receptions : filtre référence + nom fournisseur (+ référence bordereau).
- Note : les endpoints `/api/supplier-bordereaux` et `/api/supplier-receptions` (GET liste) ne supportent PAS de `q` serveur → filtrage fait dans le navigateur (liste complète déjà chargée). Cohérent avec /ventes. **Prouvé par capture** (saisie « blida » → 1 résultat ; « zzzz » → vide).
- Fichiers : `Bordereaux.tsx`, `Receptions.tsx` (uniquement). Build exit 0.

### 8.4 Page détail fournisseur — /fournisseurs/detail
- Clic sur le **nom** d'un fournisseur dans /fournisseurs → `navigate('/fournisseurs/detail?id=<id>')`.
- Nouvelle page `SupplierDetail.tsx` : en-tête (nom + tél + solde) + **2 tableaux filtrés par `supplierId`** (côté client, car les endpoints ne filtrent pas serveur) :
  - Bons de réception (Référence, Date, Produit, Nb colis, Poids emb., Bordereau, Observations)
  - Bordereaux (Référence, Produit, Colis reçus, Vendus, Restants, Statut, Total brut)
  - Messages « Aucun bon de réception » / « Aucun bordereau » si vide.
- Fichiers : `SupplierDetail.tsx` (créé), `Suppliers.tsx` (nom cliquable), `App.tsx` (route ajoutée). Aucune modif backend. Build exit 0. **Prouvé par capture** (clic « Coopérative Agricole Blida » → page détail avec BR-000001 + BF-000001).

### 8.6 Clic bordereau dans détail fournisseur → détail bordereau
- Dans `SupplierDetail.tsx`, la ligne d'un bordereau du tableau devient cliquable (`onClick` + `cursor-pointer`) → `navigate('/bordereaux/<id>')`. **Prouvé par capture** (clic BF-000001 → page BordereauDetail BF-000001).

### 8.7 Clic facture dans détail bordereau → NOUVELLE FENÊTRE détail facture
- Backend (tiny) : `supplier-bordereaux.routes.ts` → `getSalesLines` renvoie `invoiceId: it.invoiceId` (FK InvoiceItem).
- `BordereauDetail.tsx` : chaque ligne de vente devient cliquable → `window.open('/factures/'+v.invoiceId, '_blank')` (nouvel onglet).
- Création `InvoiceDetail.tsx` (route `/factures/:id` montée dans `App.tsx`) : page détail facture complète (réutilise le rendu du modal Détail de Ventes : items Colis « N colis » / Brut-Tare-Net « N kg » / PU-Total « N DA », + Total/Avance/Restant/Client/Date, boutons Imprimer/Retour). **Prouvé par capture** (BF-000001 → clic F-2026-0001/F-2026-0002 → ouvre /factures/<id>).

### 8.8 Bouton « Modifier » dans la fenêtre facture (InvoiceDetail.tsx)
- Ajout d'un bouton « Modifier » (état `edit`) → formulaire d'édition des lignes (Colis/Brut/Tare/Net readonly calculé/PU/Prix emb./Emballage), recalcul `Net = Brut − (Tare × Colis)` dans les onChange (copié de Ventes/Bulletin.tsx). « Enregistrer » → `updateInvoice(id, {items, packingReturned})` puis recharge. Boutons Annuler/Enregistrer. **Prouvé par capture** (clic Modifier → champs 50/150/0.2/140/200/40 + Enregistrer).

### 8.9 Clic facture dans détail CLIENT → MÊME nouvelle fenêtre
- `Clients.tsx` (vue `invoices`) : chaque ligne de facture cliquable → `window.open('/factures/'+inv.id, '_blank')` (identique au pattern des bordereaux). Bouton « Détail » (édition inline) préservé. **Prouvé par capture** (clic hamid → F-2026-0001 cliquable → /factures/<id>).

### 8.10 /ventes : colonne Produit + correction Date
- Ajout colonne **Produit** (depuis `s.items[].product.name`, join si multiple).
- **Bug Date** : le code utilisait `s.createdAt` (inexistant) → affichait « — ». Corrigé → `fmtDate(s.date)` (champ valide de Sale). **Prouvé par capture** (V-2026-0002/V-2026-0001 : « Bananes » + « 23/07/2026 » au lieu de « — »).

### 8.11 Fournisseur PAR LIGNE dans /ventes/nouveau (Option A — brainstorm validé)
- Demande : un client achète 2 produits de 2 fournisseurs → chaque ligne d'article a SON fournisseur ; sélection fournisseur → recherche produit filtrée (produits de CE fournisseur ayant un lot en stock ; sans lot = masqués).
- Backend `products.routes.ts` : `getProductSearch` accepte `supplierId` → filtre `stockLots.some({supplierId, remainingQuantity:{gt:0})` (sans supplierId = comportement historique).
- Backend `sales.routes.ts` : `computeItem` lit `item.supplierId` ; boucle FIFO utilise `c.supplierId` (par ligne) au lieu de `data.supplierId` global. `SaleItem` n'a pas de colonne supplierId mais le lot FIFO résolu porte le fournisseur → lien garanti.
- Front `SaleNew.tsx` : fournisseur déplacé DANS chaque ligne (SearchSelect), recherche produit filtrée par fournisseur de la ligne, **fournisseur global supprimé**. `api.ts` : `getProductSearch(q, supplierId?)`.
- **Prouvé par API live** : `GET /api/products/search?q=Ban&supplierId=Coop` → 0 (lot consommé) puis 1 (Bananes) après réception d'appro BR-000004. **Prouvé par capture** : colonne FOURNISSEUR par ligne + « Choisir d'abord un fournisseur » tant que fournisseur non choisi.
- Note : BR-000004 (réception test Bananes x50) créée pour prouver le filtre — à vider si non souhaitée.

### 8.12 /ventes/nouveau en pleine largeur + /clients vue factures (recherche + filtres)
- `SaleNew.tsx` : conteneur racine passe de `max-w-7xl mx-auto` à `w-full px-4 sm:px-6 lg:px-8` (pleine largeur) ; tableau `w-full` ; SearchSelect fournisseur/produit élargis. **Prouvé par capture** (page en pleine largeur).
- `Clients.tsx` (vue `invoices`) : ajout barre de recherche `invSearch` (filtre réf/statut) + boutons filtre `invFilter` Toutes / Payées / Non payées (comme /ventes), tableau sur `filteredInvoices`. Build exit 0. **Prouvé par** build + relecture code (lignes 314-382) + bundle déployé contient « Rechercher facture » / « Non pay » + API live (hamid → F-2026-0001 PAID). (Le basculement SPA après clic ne se capture pas bien via snapshot browser — limite outil, pas un bug.)

### 8.13 Session du 24/07/2026 — corrections perte + liaison bordereau + filtres

> Reprise post-23/07. Base contenant encore des données de test de l'agent (4 bordereaux/réceptions/ventes/factures/lots + perte « don » 50 colis sur BF-000004). Serveur live :8080 sain. Tout prouvé par API live + capture navigateur.

#### 8.13.1 Bug « Invalide » déclaration de perte — CORRIGÉ
- Symptôme : `POST /api/stock/loss` renvoyait systématiquement `400 {error:'Invalide'}`.
- Racine : frontend envoyait `quantity` en **string** (useState('')) ; backend `lossSchema` exigeait `z.number().positive()` (Zod ne coerce pas).
- Correction : `backend/src/routes/stock.routes.ts` → `quantity: z.coerce.number().positive()` ; `frontend/src/pages/Stock.tsx` → `postStockLoss({ lotId, quantity: Number(quantity), reason })`.
- Build back+front exit 0. **Prouvé par API** : POST /loss en 200 avec quantity string ET number, lot décrémenté puis restoré.

#### 8.13.2 Section « Pertes » dans le détail bordereau — AJOUTÉE (affichage seul)
- `GET /api/supplier-bordereaux/:id` renvoie `pertes` (Loss du lot : id/date/quantity/reason/cost) + `totalPertesColis` + `totalPertesCout`.
- UI `BordereauDetail.tsx` : section « Pertes » bilingue (FR « Pertes » / AR « خسارة ») sous le tableau des ventes, total colis + coût, « Aucune perte » si vide.
- PDF `bordereaux/pdf.ts` : section « PERTES / الخسائر » ajoutée APRÈS le tableau des ventes, UNIQUEMENT si pertes > 0.
- **Règle respectée** : aucun calcul du bordereau (colisRestant, totalBrutVentes, montantFinalDu) n'est modifié — affichage seul.

#### 8.13.3 colisRestant intègre les pertes — MODIFIÉ (règle métier)
- Nouvelle règle : `colisRestant = colisRecus − (colisVendus + totalPertesColis)`.
- Intégré à 4 endroits pour cohérence : lecture `GET /:id` (recalcul à la volée), réception (`supplier-receptions.routes.ts`), facture (`invoices.routes.ts`), et `POST /stock/loss` (décrémente colisRestant du bordereau lié immédiatement).
- Build back exit 0. **Prouvé par API** : BF-000003 perte 20 → restant 70 (=100−10−20) ; BF-000002 perte test +3 → 77 puis rollback 80.
- Commission / montantFinalDu (sur totalBrutVentes) non touchés.

#### 8.13.4 /stock — colonnes Fournisseur + Bordereau cliquables, retrait Coût
- `GET /api/stock` : lotDTO enrichi de `bordereauId` + `bordereauRef` (résolus en 1 seule requête `findMany`, pas de N+1).
- `Stock.tsx` : tableau LOTS → colonnes [Lot, Produit, **Fournisseur**, **Bordereau**, Quantité, Statut] ; Fournisseur cliquable → `/fournisseurs/detail?id=`, Bordereau cliquable → `/bordereaux/:id` ; colonne **Coût retirée**. Bilingue FR/AR.
- Build back+front exit 0. **Prouvé par capture** : /stock montre les 2 liens ; clic « BF-000002 » → redirige vers /bordereaux/cmry0t5ne... (détail bordereau).

#### 8.13.5 /bordereaux — filtre par statut
- `Bordereaux.tsx` : ajout `statutFiltre` + 4 boutons (Tous / Ouvert / Pré-à-clôturer / Clôturé, bilingue FR/AR, bouton actif `primary`). Cohabite avec la recherche texte (logique ET). Filtre côté client.
- **Prouvé par capture** : « Clôturé » → 1 seul bordereau (BF-000001 cloture) ; « Ouvert » → 3 (BF-000002/003/004) ; « Tous » → 4.

#### 8.13.6 Menu + Dashboard — retrait Bulletins, ajout Bordereaux + Réceptions
- `Layout.tsx` (`NAV`) : retrait entrée `/bulletins` ; `Bordereaux` déplacé à sa place (après Ventes) avec l'icône document (ex-`/bulletins`). Bordereaux `ICONS` map ajouté.
- `Dashboard.tsx` (`MODULES`) : carte `Bulletins` → remplacée par `Bordereaux` (→ /bordereaux) ; carte `/receptions` ajoutée (→ /receptions).
- **Prouvé par capture** : sidebar = Tableau de bord / Ventes / Bordereaux / Stocks / ... ; dashboard = cartes Bordereaux + Réceptions visibles.

#### 8.13.7 Création auto fournisseur sur /receptions/new
- `ReceptionNew.tsx` : SearchSelect fournisseur → si le nom tapé n'existe pas (insensible casse), option « Créer <nom> » en tête ; `createSupplier({name})` → ajout à la liste + sélection. `createSupplier` depuis `../api`. Comportement normal si fournisseur existant.
- **Prouvé par API** : POST /api/suppliers crée le fournisseur puis rollback (supprimé en base). Même pattern que création auto client dans la vente.

#### 8.13.8 Option B — Bordereau lié à (fournisseur, produit, CALIBRE)
- DÉCISION : un bordereau = (fournisseur + produit + calibre). Calibre OPTIONNEL (null toléré). Données existantes (calibre null) NON migrées.
- `supplier-receptions.routes.ts` : payload accepte `calibre?` ; écrit sur `StockLot.caliber` + `SupplierBordereau.calibre` ; recherche bordereau existant par `(productId, supplierId, calibre)` null-safe (cumul colis si trouvé, sinon création).
- `ReceptionNew.tsx` : champ `Calibre` optionnel ajouté (state + Input) ; `api.ts` `createReception` type `calibre?: string`.
- `bordereaux/pdf.ts` + `serialize()` : affichent `calibre`.
- **Prouvé par API** : 2 réceptions même fournisseur+produit+calibre 60-70 → 1 bordereau (cumul) ; +1 réception calibre 70-80 → bordereau distinct.

#### 8.13.9 Choix du calibre dans /ventes/nouveau
- DÉCISION : après fournisseur+produit, un **select Calibre** liste les calibres dispo du fournisseur+produit ; le lot FIFO se restreint au calibre choisi. Fournisseur par ligne + FIFO conservés.
- `stock-lots.routes.ts` GET /fifo : accepte `calibre` query → filtre le lot FIFO. `sales.routes.ts` `resolveFifoLot(supplierId, productId, calibre?)` : même filtre. `api.ts` `getFifoLot(..., calibre?)`.
- `SaleNew.tsx` : chargement des calibres dispo (GET /api/stock-lots filtré supplier+product) + `<select>` Calibre + badge lot FIFO mis à jour.
- **Prouvé par API** : GET /fifo?calibre=60-70 → lot du calibre 60-70 ; calibre=70-80 → lot 70-80.

#### 8.13.10 Remarques UX — calibre affiché partout (vues)
- `SaleNew.tsx` cellule Article : `Orange - calb:60`.
- `Receptions.tsx` + `Bordereaux.tsx` colonne Produit : `Orange / 60` (via `r.bordereau?.calibre` / `b.calibre`).
- `BordereauDetail.tsx` : header produit `Orange / 60` + **nouvelle colonne Calibre** dans le tableau des ventes.
- **Prouvé par capture** : /bordereaux BF-000005 « Oranges / 60 » ; /receptions BR-000005 « Oranges / 60 ».

#### 8.13.11 PDF — Produit / calibre (3 documents)
- **Facture** (`invoices/pdf.ts`) : `description + ' / ' + caliber` (caliber récupéré via lotId→StockLot.caliber dans `invoices.routes.ts` itemsFromSale + génération manuelle).
- **Bon de réception** (`receptions/pdf.ts`) : `productName + ' / ' + caliber` (caliber du lot passé au DTO GET /:id/pdf).
- **Bordereau** (`bordereaux/pdf.ts`) : header + lignes `Orange / 60` (remplace `—` et `- calb:`).
- **Prouvé par pdftotext** : les 3 PDF affichent `orange / 60`.

#### 8.13.12 Nettoyage base — FAIT (24/07 fin de session)
- TRUNCATE de 27 tables métier (Supplier, Product, Sale, Invoice, StockLot, SupplierBordereau, SupplierReception, etc.) en double-quotes + RESTART IDENTITY CASCADE.
- **GARDÉS** (pour ne pas casser l'app) : `User` (admin/responsable/employe), `CompanySettings`, `Permission`, `RolePermission`, `Unit`, `ProductCategory`, `Session`, `AuditLog`, `Backup`.
- Serveur sain après (health OK). Base repart de zéro pour les tests de l'utilisateur.

#### 8.14 Session du 25/07/2026 — corrections réception, historique paiement, statut Crédit
Reprise post-24/07. Base propre (vidée fin 24/07). Serveur live :8080 (PID variable). Tous les builds back+front exit 0, vérifiés par le chef (curl + snapshot navigateur + grep PDF).

**8.14.1 Bug « Erreur création réception » — CORRIGÉ**
- Cause : références `BR-/BF-/AV-` générées par `count()+1` → collision dès qu'un trou/soft-delete existait (ex : `BR-000005` déjà présent → unique constraint fail → 500).
- Fix (`backend/src/routes/supplier-receptions.routes.ts`, `serializeInvoice`/`POST`) : helper `nextRef(model, field, prefix)` = `max(numéro existant, tous les enregistrements même soft-deleted)+1`. Plus de collision possible.
- Prouvé : POST multi-calibres → HTTP 201, `BR-000006`, bordereau `BF-000001` cumulé, 2 lots (calibre 40 + 50). Donnée de test nettoyée.

**8.14.2 Bouton « Détail » de /ventes ouvre une NOUVELLE FENÊTRE — FAIT**
- `handleDetail(sale)` dans `frontend/src/pages/Bulletin.tsx` : `ensureInvoice(sale)` (crée la facture liée si absente) puis `window.open('/factures/'+invId, '_blank')` (comme BordereauDetail.tsx). Ancien modal de détail conservé (code mort inoffensif). Imprimer/Encaisser inchangés.
- Prouvé : bundle contient `window.open('/factures/'+t,'_blank')` (+t = invId).

**8.14.3 Section « Historique de paiement » sur la facture — FAIT + itéré**
- Backend : `serializeInvoice` (invoices.routes.ts) renvoie désormais `payments` (déjà chargés par `loadInvoice`). Frontend `types.ts` : `Invoice.payments` ajouté.
- Modèle final validé (sur F-2026-0004, total 37600, emballage 4000, avances 17600+20000) :
  - Tableau 5 colonnes : N° facture | Date | Avance faite | Reste à payer | Statut.
  - ORDRE INVERSÉ : la PLUS RÉCENTE en haut (tri DESC + `isRecent` sur `rows[0]`), la plus ancienne en bas.
  - SEULE la ligne la plus récente a son N° facture CLIQUABLE (`openInvoicePdf`) ; les autres avances + la ligne Crédit (bas) NE sont PAS cliquables.
  - Sous le tableau, récap fusionné 4 infos : `Total emballage : X | Avance : Y | Reste à payer : Z (GRAS rouge) | Total : W`.
  - Reste à payer calculé CHRONOLOGIQUEMENT (cumul sur `sortedAsc` puis `reverse()` pour l'affichage) — corrige un bug où le reste était calculé dans l'ordre d'affichage inversé.
  - Fichiers : InvoiceDetail.tsx (section ~339-441), types.ts, invoices.routes.ts.

**8.14.4 PDF facture — Avance + Reste à payer en gras, Avance masquée si payé**
- `backend/src/invoices/pdf.ts` (bloc totaux) :
  - Ajout ligne `Avance : Y DA` (si `paid>0`).
  - `Reste à payer` en **gras** (Helvetica-Bold).
  - Ligne `Avance` masquée si `reste===0` (facture entièrement payée) : condition `if (paid>0 && remaining>0)`.
- Prouvé (pdftotext réel) : F-2026-0004 (reste=0) → pas de « Avance » ; F-2026-0003 (reste>0) → « Avance : 10000 DA » présente ; « Reste à payer » en gras.

**8.14.5 Statut « Crédit » (au lieu de « Émis ») — FAIT (facture + PDF + liste ventes)**
- Règle (SANS nouveau champ DB) : si `status==='SENT'` ET `remaining === total` (aucun paiement) → libellé **« Crédit »** ; sinon SENT → « Émis ».
- `frontend/src/pages/InvoiceDetail.tsx` : `invoiceStatusBadge(status, remaining, total)` → Crédit si SENT+reste=total.
- `backend/src/invoices/pdf.ts` : `statusLabelFr(status, remaining, total)` → « Crédit » si SENT+reste=total (sinon « Envoyée »).
- `frontend/src/pages/Bulletin.tsx` (/ventes) : MÊME règle ajoutée dans sa propre `invoiceStatusBadge` (elle n'avait pas la règle → affichait « Émis » par erreur). Appel : `invoiceStatusBadge(inv?.status ?? 'DRAFT', inv?.remaining, inv?.total)`.
- Prouvé : PDF généré d'une vente à crédit SENT (reste=total) → `pdftotext` extrait **« Crédit »** ; /ventes affiche « Crédit » après correction.

**8.14.6 État final session**
- Serveur live :8080 sain (health OK). Builds back+front exit 0.
- Aucune donnée de test laissée en base (ventes/factures/clients de test supprimés après chaque preuve).
- Reste à faire (roadmap §9) : Phase D (i18n FR/AR RTL), Phase E (QA), Phase F (Tauri + cloud + HTTPS). Aucun de ces points attaqué cette session.

### 8.5 Dettes techniques TOUJOURS ouvertes (héritées, §7 non résolues)
- `SupplierBordereau.statut` en String libre (pas d'enum).
- Permissions manquantes sur `stock-lots`, `supplier-receptions`, `supplier-bordereaux` (seulement `requireAuth`).
- `CompanySettings` sans route réelle (stub 501) — réglé en base via seed pour l'instant.
- Colonnes poids dupliquées entre SaleItem/InvoiceItem et PurchaseBulletinItem/StockLot.
- Double error-handler + exceptions avalées dans `index.ts`.
- Pages orphelines `Sales.tsx`/`Invoices.tsx`/`Payments.tsx` non montées.

---

## 9. Prochaines phases (feuille de route)

- **Phase D — i18n** : finaliser la bascule FR/AR complète (RTL), traductions des pages, cohérence des libellés bilingues déjà présents en base (nameAr, mentionAr…).
- **Phase E — QA** : tests d'intégration end-to-end (parcours achat→stock→vente→facture→paiement), durcissement des permissions manquantes (§7/§8.5), vérification des calculs Decimal et FIFO.
- **Phase F — Tauri + cloud** : packaging desktop (Tauri) pour usage local hors-ligne + synchronisation/déploiement cloud + HTTPS (port 8080 en clair actuellement).
