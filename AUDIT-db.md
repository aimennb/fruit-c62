# AUDIT INTÉGRITÉ & SÉCURITÉ DES DONNÉES — Fruiterie ERP

**Périmètre** : `backend/prisma/schema.prisma`, `backend/prisma/migrations/`, toutes les écritures DB (`create`/`update`/`delete`) dans `backend/src/routes/*.ts`.
**Mode** : lecture seule (aucun fichier modifié, aucune donnée créée). Vérifications SQL faites en `SELECT` seul sur la base `fruiterie`.
**Date** : audit exécuté sur l'état courant du dépôt.

> Les 3 bugs critiques récemment corrigés (recyclage de bordereau, ventes réglées comptées en encaissement de crédit, paiements fournisseur CASH dans les dépenses) ne sont **pas** re-signalés.

---

## (a) Résumé exécutif

Le schéma Prisma est globalement de bonne facture : **tous les montants sont en `Decimal(14,2)`** (quantités en `Decimal(14,3)`), le soft-delete `deletedAt` est présent sur toutes les entités métier, et l'essentiel des mutations financières passe par `prisma.$transaction`. Aucun `Float` monétaire n'a été trouvé dans le schéma.

En revanche, l'audit met en évidence **un problème structurel majeur : la divergence entre le schéma Prisma et l'historique de migrations**. La base de production a été construite par `prisma db push` (2 migrations seulement enregistrées dans `_prisma_migrations` sur 17 présentes dans le dossier). Conséquence directe et **vérifiée en SQL** : **les tables les plus récentes et les plus critiques du métier (`SupplierReception`, `SupplierBordereau`, `SupplierReceptionItem`, `SupplierBordereauCorrection`, `Expense`, `CashSupply`, `CashRemittance`, `CashRegisterDay`) n'ont AUCUNE contrainte de clé étrangère en base** — parce que ces relations ne sont pas déclarées dans le schéma Prisma lui-même. Le cœur du flux Réception → Bordereau → Lot → Bon de paiement repose donc entièrement sur du code applicatif, sans filet de sécurité au niveau du SGBD.

S'y ajoutent : une **route `DELETE /api/sales/:id` déclarée deux fois** (la seconde est morte, donc la cascade de soft-delete des factures ne s'exécute jamais), des **mises à jour de solde non transactionnelles** dans les factures, des **générateurs de références séquentielles exposés aux courses concurrentes**, et une **double source de vérité sur `Supplier.balance`** (recalcul par ledger vs `increment`/`decrement` direct) — cette dernière étant déjà **avérée en base** : les 3 fournisseurs ont un `balance` qui ne correspond pas à la somme de leur ledger `SupplierAccountEntry`.

**Bilan** : 14 problèmes retenus — 4 P0, 5 P1, 3 P2, 2 P3.

---

## (b) Problèmes trouvés

### P0 — Critique (perte ou corruption de données)

---

#### P0-1 — Historique de migrations désynchronisé : la base tourne en `db push`, 15 migrations sur 17 jamais appliquées

**Fichier** : `backend/prisma/migrations/` + `backend/package.json:11`

Preuve (commandes exécutées) :

```
$ npx prisma migrate status
17 migrations found in prisma/migrations
Following migrations have not yet been applied:
20260722075915_init
... (15 migrations listées)

$ psql -tc "SELECT migration_name FROM _prisma_migrations;"
 20260801120000_add_supplier_payment        | 2026-08-01 23:14:52
 20260802000010_add_supplier_payment_status | 2026-08-02 00:00:11
```

La table `_prisma_migrations` ne contient que **2** entrées alors que 17 dossiers existent. Le schéma physique a donc été poussé par `prisma db push` (qui ne journalise rien), et les migrations SQL versionnées ne décrivent plus l'état réel de la base. En croisant `CREATE TABLE` des migrations avec les `model` du schéma, **9 modèles n'ont aucune migration correspondante** :

`CashRegisterDay`, `CashRegisterEntry`, `CashRegisterClosing`, `CashRegisterAuditLog`, `Expense`, `CashSupply`, `CashRemittance`, `SupplierReception`, `SupplierBordereau`, `SupplierReceptionItem`, `SupplierBordereauCorrection`, `UserPermission`.

**Impact métier** : impossible de reconstruire la base de production à partir du dépôt. Un déploiement `prisma migrate deploy` sur un serveur neuf produirait une base **amputée du module Caisse et du module Bordereau fournisseur** en entier. Un `migrate dev` sur la base existante déclencherait une demande de reset → **perte totale des données**. Aucun rollback possible, aucun audit de l'évolution du schéma.

**Correction suggérée** : geler la base, faire un `pg_dump` complet, puis regénérer une baseline propre :
`prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > migrations/0_baseline/migration.sql`, puis `prisma migrate resolve --applied 0_baseline`. Bannir `db push` en dehors du dev local ; ajouter `"migrate:deploy": "prisma migrate deploy"` dans `package.json` et l'appeler au démarrage.

---

#### P0-2 — Aucune clé étrangère sur le cœur du métier (Réception / Bordereau / Caisse)

**Fichier** : `backend/prisma/schema.prisma:1018-1113` (`SupplierReception`, `SupplierBordereau`, `SupplierReceptionItem`, `SupplierBordereauCorrection`), `:1181-1240` (`Expense`, `CashSupply`, `CashRemittance`), `:699` (`StockLot.bordereauId`)

Ces modèles déclarent des identifiants **en `String` nu, sans `@relation`** :

```prisma
model SupplierBordereau {
  supplierId  String     // ← pas de relation Supplier
  productId   String     // ← pas de relation Product
  receptionId String     // ← pas de relation SupplierReception
  lotId       String     // ← pas de relation StockLot
```
```prisma
model StockLot {
  // Bordereau fournisseur auquel ce lot est rattaché
  bordereauId String?    // ← ligne 699, pas de relation
```

Vérification en base — **zéro FK** sur ces tables :

```
$ psql -c "SELECT conrelid::regclass, conname FROM pg_constraint
           WHERE contype='f' AND conrelid::regclass::text ~ 'Supplier|Cash|Expense|StockLot';"
 "StockLot" | StockLot_productId_fkey ...  (productId, supplierId, bulletinId, arrivalId : OK)
 → mais AUCUNE ligne pour SupplierReception, SupplierBordereau,
   SupplierReceptionItem, SupplierBordereauCorrection, Expense,
   CashSupply, CashRemittance, ni pour StockLot.bordereauId
```

**Impact métier** : rien n'empêche un bordereau de pointer vers un fournisseur supprimé, un lot inexistant, ou une réception effacée. Le code joint ces tables « à la main » (ex. `supplier-receptions.routes.ts:277` `tx.stockLot.updateMany({ where: { id: { in: lots.map(l=>l.id) } }, data: { bordereauId: bordereau.id } })`) — un bug, un rollback partiel ou une intervention SQL manuelle produit silencieusement des orphelins. Sur ce flux transitent **la totalité des montants dus aux fournisseurs** (`montantFinalDu`) : un bordereau orphelin, c'est une dette fournisseur ni traçable ni payable.

*Note* : au moment de l'audit, la base est encore saine (`SELECT count(*) FROM "StockLot" sl WHERE sl."bordereauId" IS NOT NULL AND NOT EXISTS (...)` → **0 orphelin** sur 29 bordereaux / 29 réceptions). Le risque est structurel, pas encore matérialisé.

**Correction suggérée** : déclarer les relations dans le schéma avec `onDelete: Restrict` sur les liens comptables (`SupplierBordereau.supplierId`, `receptionId`, `lotId`), `Cascade` sur `SupplierReceptionItem.receptionId` et `SupplierBordereauCorrection.bordereauId`, et `SetNull` sur `StockLot.bordereauId`. Générer la migration correspondante après un contrôle d'orphelins préalable.

---

#### P0-3 — Route `DELETE /api/sales/:id` déclarée deux fois : la cascade sur les factures est morte

**Fichier** : `backend/src/routes/sales.routes.ts:469` et `backend/src/routes/sales.routes.ts:672`

Deux handlers `router.delete('/:id', ...)` coexistent dans le même routeur. Express prend **le premier** (ligne 469) :

```ts
// ligne 469 — CELUI QUI S'EXÉCUTE
router.delete('/:id', requirePermission('SALE_WRITE'), async (req, res) => {
  ...
  await prisma.sale.update({ where: { id: sale.id }, data: { deletedAt: new Date(), ... } });
  // ← ne touche PAS aux factures liées
```
```ts
// ligne 672 — CODE MORT, jamais atteint
router.delete('/:id', requirePermission('SALE_WRITE'), async (req, res) => {
  await prisma.$transaction(async (tx) => {
    // Soft-delete des factures liées  ← intention explicite du développeur
    await tx.invoice.updateMany({ where: { saleId: sale.id, deletedAt: null }, data: { deletedAt: ... } });
    await tx.sale.update({ ... });
  });
```

**Impact métier** : à la suppression d'une vente, ses factures restent actives (`deletedAt IS NULL`) et **continuent d'alimenter la caisse, le CA et le solde client** alors que la vente n'existe plus. Résultat : factures fantômes rattachées à une vente supprimée, chiffre d'affaires surévalué, solde client faussé. Les deux handlers divergent aussi sur la règle : le premier exige `status === 'DRAFT'`, le second accepte n'importe quel statut — l'intention métier réelle est ambiguë.

**Correction suggérée** : supprimer l'un des deux handlers. Conserver la version transactionnelle (ligne 672) **en y réintégrant le garde-fou `DRAFT`** de la ligne 469, puis vérifier en base les factures actives dont la vente est soft-deleted et les régulariser.

---

#### P0-4 — `Supplier.balance` a deux sources de vérité concurrentes — divergence déjà constatée en base

**Fichiers** : `backend/src/routes/supplier-advances.routes.ts:59-76` (recalcul par ledger) vs `backend/src/routes/supplier-receptions.routes.ts:307` et `:730`, `backend/src/routes/supplier-payments.routes.ts:465` (mutation directe)

Deux mécanismes incompatibles écrivent le même champ. Le premier **recalcule intégralement** depuis le ledger :

```ts
// supplier-advances.routes.ts:69-75
let balance = D(0);
for (const e of entries) balance = e.type === 'DEBIT' ? balance.plus(amt) : balance.minus(amt);
await tx.supplier.update({ where: { id: supplierId }, data: { balance } });
```

Le second applique un **delta relatif**, sans passer par le ledger :

```ts
// supplier-payments.routes.ts:465 (mode PAY)
await tx.supplier.update({ where: { id: supplierId }, data: { balance: { decrement: montant } } });
// ← aucun SupplierAccountEntry créé en contrepartie
```

Vérification en base — les 3 fournisseurs sont **tous incohérents** :

```
            name            |  balance   |  ledger (ΣDEBIT − ΣCREDIT)
----------------------------+------------+---------------------------
 Coopérative Agricole Blida |  -67842.00 |                          0
 Domaine Saharien Dates     | -508013.75 |                          0
 Ferme El Wadi SARL         |  -12000.00 |                  -50000.00
```

**Impact métier** : le solde fournisseur affiché est **faux et non reconstructible**. Pire, le prochain appel à `reconcileSupplierBalance()` (déclenché par n'importe quelle opération d'acompte) va écraser `balance` avec la valeur du ledger et **effacer d'un coup tous les paiements enregistrés en `decrement` direct** — par exemple ramener « Domaine Saharien Dates » de −508 013,75 DA à 0. Perte de données financières immédiate, litige fournisseur garanti.

**Correction suggérée** : imposer le ledger `SupplierAccountEntry` comme **unique** source de vérité. Chaque `decrement`/`increment` direct doit être remplacé par la création d'une écriture `DEBIT`/`CREDIT` suivie d'un appel à `reconcileSupplierBalance(tx, supplierId)` dans la même transaction. Prévoir un script de rattrapage générant les écritures manquantes à partir de la table `Payment` avant toute reconciliation.

---

### P1 — Majeur

---

#### P1-1 — `POST /api/invoices/:id/issue` : solde client et statut facture modifiés hors transaction

**Fichier** : `backend/src/routes/invoices.routes.ts:468-479`

```ts
if (inv.customerId) {
  const total = new Prisma.Decimal(inv.total);
  await prisma.customer.update({           // ← écriture 1, hors transaction
    where: { id: inv.customerId },
    data: { balance: { increment: total } },
  });
}
const updated = await prisma.invoice.update({   // ← écriture 2, hors transaction
  where: { id: inv.id },
  data: { status: 'SENT', issueDate: new Date(), ... },
});
```

Deux écritures indépendantes, aucun `prisma.$transaction`. Si la seconde échoue (contrainte, coupure réseau, redémarrage du process), le solde client a été incrémenté mais la facture reste en `DRAFT`.

**Impact métier** : dette client gonflée d'un montant sans facture émise en face. Le client se voit refuser des ventes pour dépassement de limite de crédit (`checkCreditLimit` dans `_helpers.ts:96`) à cause d'une dette fantôme. Aggravé par le fait que la route est **rejouable** : un second appel sur une facture déjà `SENT` n'est pas bloqué (seuls `PAID` et `CANCELLED` le sont, ligne 464) → **double incrément du solde à chaque clic**.

**Correction suggérée** : envelopper les deux écritures dans un `prisma.$transaction`, et rejeter l'émission si `inv.status !== 'DRAFT'` pour rendre l'opération idempotente.

---

#### P1-2 — Générateurs de références séquentielles non atomiques (course concurrente)

**Fichiers** : `backend/src/routes/sales.routes.ts:165-178`, `invoices.routes.ts:110-122`, `payments.routes.ts:46-58`, `supplier-payments.routes.ts:51`/`:67`, `supplier-receptions.routes.ts:155-163`, `cash-register.routes.ts:72-85`, `products.routes.ts:66-78`

Tous suivent le même schéma « lire le max, ajouter 1 » sans verrou :

```ts
// sales.routes.ts:168 — lecture non verrouillée
const rows = await tx.$queryRawUnsafe(
  `SELECT "reference" FROM "Sale" WHERE "reference" LIKE $1 ORDER BY "reference" DESC LIMIT 1`, prefix + '%');
let next = 1;
if (rows.length > 0) next = parseInt(...) + 1;
return `${prefix}${String(next).padStart(4, '0')}`;
```

Deux requêtes simultanées lisent le même maximum et produisent la **même référence**. Comme `reference` est `@unique`, la seconde transaction échoue en `P2002` — l'opération entière est perdue (réception, facture, encaissement…). Le cas `supplier-receptions.routes.ts:155` est le plus coûteux : `nextRef()` charge **toutes** les lignes de la table (`findMany({ select: { reference: true } })`) pour calculer un max en JavaScript — O(n) en mémoire à chaque réception.

Aggravation dans `sales.routes.ts:247` : la référence est générée dans **sa propre** transaction, puis la vente est créée dans **une autre**, ce qui élargit encore la fenêtre de collision.

```ts
const reference = data.reference || (await prisma.$transaction((tx) => nextSaleReference(tx)));
const sale = await prisma.sale.create({ ... });   // ← transaction distincte
```

**Impact métier** : en usage multi-postes (caisse + réception simultanées, courant chez un grossiste), échecs aléatoires de saisie et trous dans la numérotation — problématique pour une numérotation comptable qui doit être continue.

**Correction suggérée** : utiliser une `SEQUENCE` PostgreSQL par type de document, ou une table `DocumentCounter` verrouillée par `SELECT ... FOR UPDATE`, et générer la référence **dans la même transaction** que l'entité.

---

#### P1-3 — `PUT /api/sales/:id` : suppression physique des lignes de vente hors transaction

**Fichier** : `backend/src/routes/sales.routes.ts:418-421`

```ts
await prisma.saleItem.deleteMany({ where: { saleId: sale.id } });   // ← DELETE PHYSIQUE, hors transaction
const updated = await prisma.sale.update({                          // ← si ça échoue, lignes perdues
  where: { id: sale.id },
  data: { ..., items: { create: itemsData.map(...) } },
});
```

Double problème : (1) `deleteMany` est un **DELETE SQL réel**, en contradiction directe avec la politique de soft-delete du projet — `SaleItem` possède pourtant un champ `deletedAt` (`schema.prisma:786`) ; (2) les deux opérations ne sont pas atomiques.

**Impact métier** : si le `sale.update` échoue (produit invalide, contrainte), la vente se retrouve **sans aucune ligne** — montant conservé dans `Sale.total` mais détail irrécupérable, y compris les `lotId` qui relient la vente au bordereau fournisseur. Perte définitive de la traçabilité produit ↔ lot ↔ fournisseur. Le module Factures fait d'ailleurs mieux : `invoices.routes.ts:601` prend soin de reconstruire les `lotId` avant remplacement des lignes.

**Correction suggérée** : passer en `prisma.$transaction`, et remplacer `deleteMany` par `updateMany({ data: { deletedAt: new Date() } })`, en filtrant `deletedAt: null` sur toutes les lectures de `SaleItem`.

---

#### P1-4 — `Payment` n'a aucun lien avec `SupplierPayment` : les règlements fournisseurs sont orphelins

**Fichier** : `backend/prisma/schema.prisma:879-908` (`Payment`), `backend/src/routes/supplier-payments.routes.ts:453-463`

Le mode `PAY` crée un `Payment` dont le seul rattachement au bon de paiement est **une chaîne libre dans les notes** :

```ts
await tx.payment.create({
  data: {
    reference: await nextPaymentRef(tx),
    supplierId, amount: montant, method, paymentDate: datePaiement,
    notes: `${payment.reference} / ${b.reference}`,   // ← seul lien : du texte
    createdBy: userId,
  },
});
```

`Payment` possède `saleId`, `invoiceId`, `purchaseId`, mais **ni `supplierPaymentId` ni `bordereauId`**.

**Impact métier** : impossible de faire un rapprochement fiable entre un décaissement et le bordereau qu'il solde autrement qu'en parsant du texte. Si le bon de paiement est annulé ou soft-deleted, les `Payment` correspondants restent actifs et continuent de peser sur la trésorerie. Le lettrage comptable fournisseur devient un travail manuel.

**Correction suggérée** : ajouter `supplierPaymentId String?` et `bordereauId String?` sur `Payment`, avec relations et index, et les renseigner à la création.

---

#### P1-5 — Contraintes d'unicité insuffisantes : bordereaux et acomptes dupliquables

**Fichier** : `backend/prisma/schema.prisma:1045-1082` (`SupplierBordereau`), `:420-442` (`SupplierAdvance`), `:1085-1098` (`SupplierReceptionItem`)

Depuis la correction « 1 réception = 1 bordereau », l'invariant métier est qu'un `receptionId` n'apparaît qu'une fois dans `SupplierBordereau` — mais **aucune contrainte ne le garantit** :

```prisma
model SupplierBordereau {
  receptionId String       // ← pas de @unique
  lotId       String       // ← pas de @unique
  @@index([supplierId])
  @@index([productId])
  @@index([deletedAt])     // ← aucun @@unique
}
```

Le seul `@@unique` métier du domaine fournisseur est `SupplierAdvanceAllocation @@unique([advanceId, purchaseBulletinId])` (ligne 463) — qui ne couvre **pas** le cas `bordereauId`, pourtant devenu le chemin d'affectation principal (`supplier-payments.routes.ts:475` crée des allocations avec `bordereauId` et `purchaseBulletinId` à `null`).

**Impact métier** : un double-clic ou un rejeu de requête sur la création de réception peut produire deux bordereaux pour la même réception → **la dette fournisseur est comptée deux fois**. De même, la même avance peut être affectée deux fois au même bordereau sans que la base ne s'y oppose.

**Correction suggérée** : ajouter `@@unique([receptionId])` sur `SupplierBordereau` et `@@unique([advanceId, bordereauId])` sur `SupplierAdvanceAllocation` (contrainte partielle, `bordereauId IS NOT NULL`). Ajouter `@@unique([receptionId, calibre])` sur `SupplierReceptionItem`.

---

### P2 — Mineur

---

#### P2-1 — `montantFinalDu` peut devenir négatif : 2 bordereaux déjà dans cet état

**Fichier** : `backend/src/routes/supplier-bordereaux.routes.ts:441`, `:456`, `:509` et `backend/prisma/schema.prisma:1064`

Le calcul soustrait quatre postes sans jamais plancher à zéro :

```ts
const montantFinalDu = totalBrut.minus(commission).minus(avances)
                                .minus(droitMarche).minus(transport).toDecimalPlaces(2);
```

Constaté en base :

```
 reference | statut  | totalBrutVentes | avancesAffectees | montantFinalDu | montantFinalDefinitif
-----------+---------+-----------------+------------------+----------------+----------------------
 BF-000002 | cloture |        49220.00 |         50000.00 |       -4717.60 |             -4717.60
 BF-000010 | ouvert  |            0.00 |             0.00 |        -150.00 |
```

BF-000002 a été **clôturé** avec un dû négatif, et la valeur a été figée dans `montantFinalDefinitif`. À noter que le module de paiement, lui, se protège correctement (`supplier-payments.routes.ts:443` : `resteFinal = nouveauDu.lessThan(0) ? ZERO : nouveauDu`) — l'incohérence vient donc du calcul en amont, pas du règlement.

**Impact métier** : un `montantFinalDu` négatif signifie que le fournisseur nous doit de l'argent (avance non consommée, frais supérieurs aux ventes), mais le modèle ne représente pas ce cas. Le bordereau est exclu des listes de paiement (`du.lessThanOrEqualTo(0)` → « plus rien à payer », ligne 384) et l'excédent d'avance est **perdu de vue** : personne ne réclamera les 4 717,60 DA.

**Correction suggérée** : soit borner `montantFinalDu` à 0 en reportant l'excédent dans un champ dédié (`avoirFournisseur`), soit bloquer la clôture d'un bordereau au dû négatif en exigeant un ajustement explicite de l'affectation d'avance.

---

#### P2-2 — Soft-delete sans filtre `deletedAt` sur les tests d'usage (archivage)

**Fichiers** : `backend/src/routes/products.routes.ts:383-390`, `customers.routes.ts:152-156`, `suppliers.routes.ts:154-157`

```ts
const inUse =
  (await prisma.purchaseItem.count({ where: { productId: p.id } })) > 0 ||
  (await prisma.saleItem.count({ where: { productId: p.id } })) > 0 ||
  (await prisma.stockLot.count({ where: { productId: p.id } })) > 0 || ...
```

Aucun de ces `count()` n'exclut les lignes soft-deleted (`deletedAt: null` absent), alors que le reste du code applique ce filtre systématiquement (147 occurrences de `deletedAt: null` sur 216 requêtes de lecture).

**Impact métier** : un produit dont toutes les ventes ont été supprimées est considéré « utilisé » et sera archivé (`isActive: false`) au lieu d'être soft-deleted. Comportement inattendu mais **non destructif** — le penchant est du bon côté (on préserve trop plutôt que trop peu). C'est surtout une incohérence de politique. Ces `count()` séquentiels (jusqu'à 7 aller-retours) mériteraient aussi d'être parallélisés.

**Correction suggérée** : ajouter `deletedAt: null` à chaque clause `where`, ou assumer explicitement le choix en le documentant.

---

#### P2-3 — Précision `Decimal(14,2)` insuffisante pour les prix unitaires au kilo

**Fichier** : `backend/prisma/schema.prisma:560`, `:623`, `:680`, `:775`, `:836`

Les quantités sont en `Decimal(14,3)` (3 décimales, cohérent avec des kilos), mais **tous les prix unitaires** sont en `Decimal(14,2)` :

```prisma
model PurchaseBulletinItem {
  poidsNet     Decimal @db.Decimal(14, 3)   // ← 3 décimales
  prixUnitaire Decimal @db.Decimal(14, 2)   // ← 2 décimales
  montant      Decimal @db.Decimal(14, 2)
}
```

**Impact métier** : sur un lot de 1 250,500 kg, un prix réel de 87,255 DA/kg est arrondi à 87,26 → écart de ~6 DA par lot. Cumulé sur des centaines de bordereaux, l'écart devient visible dans les rapprochements fournisseurs. Le calcul `montant = poidsNet × prixUnitaire` est correctement réalisé en `Decimal` (aucun `float`), mais la perte a lieu au **stockage** du prix, en amont.

**Correction suggérée** : passer les prix unitaires (`prixUnitaire`, `unitPrice`, `unitCost`, `purchasePrice`) en `Decimal(14, 4)`. Les montants totaux restent légitimement en `(14,2)`.

---

### P3 — Cosmétique

---

#### P3-1 — Champs `updatedAt` / `updatedBy` absents sur des tables mutables

**Fichier** : `backend/prisma/schema.prisma:1158-1177` (`CashRegisterEntry`), `:362-377` (`SupplierPaymentLine`), `:385-397` (`ProductSupplier`)

`SupplierPaymentLine` porte `montantPaye`, un champ **incrémenté à chaque règlement partiel** (`supplier-payments.routes.ts:516`), mais ne possède que `createdAt` — ni `updatedAt`, ni `updatedBy`, ni `deletedAt`. Idem pour `CashRegisterEntry`, qui a `deletedAt` mais pas `updatedAt`.

**Impact métier** : impossible de savoir quand un règlement partiel a été enregistré ni par qui, en dehors du journal `CashRegisterAuditLog` (qui ne couvre que le module Caisse). Traçabilité comptable dégradée sur les paiements fournisseurs.

**Correction suggérée** : ajouter `updatedAt DateTime @updatedAt` et `updatedBy String?` sur ces trois modèles.

---

#### P3-2 — Index manquants sur des colonnes de filtrage fréquentes

**Fichier** : `backend/prisma/schema.prisma:1045-1082` (`SupplierBordereau`), `:1018-1043` (`SupplierReception`)

`SupplierBordereau.statut` est filtré à chaque listing et à chaque contrôle de payabilité (`supplier-payments.routes.ts:381` `STATUTS_PAYABLES.includes(b.statut)`), mais n'est pas indexé — alors que `PurchaseBulletin.status` l'est (ligne 608). De même, `SupplierBordereau.receptionId`, `SupplierBordereau.lotId` et `SupplierReception.bordereauId` sont utilisés en jointure manuelle sans index.

**Impact métier** : aucun aujourd'hui (29 bordereaux en base). Deviendra sensible au-delà de quelques milliers de lignes, en particulier sur les écrans de paiement fournisseur qui balayent tous les bordereaux payables.

**Correction suggérée** : ajouter `@@index([statut])`, `@@index([receptionId])`, `@@index([lotId])` sur `SupplierBordereau` et `@@index([bordereauId])` sur `SupplierReception`.

---

## (c) Points forts

**1. Discipline `Decimal` exemplaire.** Aucun `Float` ni `Int` monétaire dans les 1 277 lignes du schéma. Tous les montants sont en `@db.Decimal(14, 2)`, toutes les quantités en `@db.Decimal(14, 3)`. Côté code, la recherche de `parseFloat` / arithmétique flottante sur des montants ne remonte que des usages légitimes (validation de finitude avant conversion en `Decimal` : `cash-register.routes.ts:777`, `payments.routes.ts:95`, et agrégation d'affichage de stock dans `products.routes.ts:182`). Les calculs utilisent systématiquement `Prisma.Decimal` avec `.plus()`, `.minus()`, `.times()` et un `.toDecimalPlaces(2|3)` explicite en sortie.

**2. Anti-doublon strict sur la caisse.** `CashRegisterEntry @@unique([sourceType, sourceId])` (ligne 1173), doublé d'un contrôle applicatif préventif `assertPasDeDoublon()` (`cash-register.routes.ts:338`) qui renvoie un 409 propre. La vérification en base confirme **0 ligne avec `sourceId` NULL** — la contrainte est effectivement opérante sur toutes les lignes.

**3. Annulation par écriture inverse, jamais par suppression.** `PATCH /expenses/:id/cancel` (`cash-register.routes.ts:883`) passe le statut à `'annulee'` et crée une `CashRegisterEntry` inverse avec un `sourceId` déterministe (`cancel-expense-${id}`), rendant l'opération idempotente. C'est la bonne pratique comptable, correctement implémentée.

**4. Garde-fous métier solides sur les montants.** Le module de paiement fournisseur refuse le surpaiement (`supplier-payments.routes.ts:402` : `montant > du` → 400), les montants ≤ 0, les bordereaux non payables, les doublons de bordereau dans un même bon, et vérifie la disponibilité réelle des avances avant imputation. Le module d'encaissement client vérifie de même le restant dû (`payments.routes.ts:151`) et refuse d'encaisser une facture soldée.

**5. Stock jamais négatif.** `sales.routes.ts:544` (confirmation de vente, FIFO strict) et `stock.routes.ts:196` (déclaration de perte) contrôlent tous deux `remainingQuantity` avant décrément et lèvent une erreur explicite. Confirmé en base : **0 lot à quantité négative**, **0 bordereau avec `colisVendus > colisRecus`**, **0 avance sur-affectée** (`allocatedAmount > amount`), **0 doublon de `lotNumber`**.

**6. Journalisation d'audit à deux niveaux.** `AuditLog` global (avec `onDelete: SetNull` sur l'utilisateur, préservant la trace même après suppression du compte) et `CashRegisterAuditLog` dédié à la caisse. `SupplierBordereauCorrection` conserve `ancienneValeur`/`nouvelleValeur`/`motif` pour toute correction post-clôture — excellente pratique.

**7. Transactions bien posées sur les flux complexes.** La création de réception (`supplier-receptions.routes.ts:150`) enchaîne réception, N lots, N mouvements de stock, lignes calibre, bordereau, rattachement des lots, avance et écriture comptable — le tout dans **un seul** `$transaction`. Même rigueur dans les 5 transactions du module caisse et les 4 du module acomptes.

**8. Isolation du soft-delete cohérente.** 71 déclarations `deletedAt` dans le schéma, index `@@index([deletedAt])` sur chaque entité métier, et 147 filtres `deletedAt: null` dans les routes. Les 12 modèles sans `deletedAt` sont des choix justifiés : tables immuables (`AuditLog`, `CashRegisterClosing`, `SupplierBordereauCorrection`), tables de liaison (`RolePermission`, `UserPermission`, `ProductSupplier`) ou techniques (`Session`, `Backup`).
