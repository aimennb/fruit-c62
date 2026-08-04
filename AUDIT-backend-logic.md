# Audit LOGIQUE MÉTIER — Backend Fruiterie

Périmètre : `backend/src/routes/{supplier-receptions,supplier-bordereaux,supplier-payments,cash-register,invoices,sales,payments,supplier-advances}.routes.ts` + `src/bordereaux/lots.ts`.
Audit **lecture seule** — aucun fichier modifié, aucun serveur lancé, aucune donnée créée.
Les 3 bugs critiques déjà corrigés (1 réception = 1 bordereau, ventes réglées en crédit, paiement fournisseur en dépenses) ne sont pas re-signalés.

## (a) Résumé exécutif

La chaîne réception → bordereau → paiement est globalement bien structurée : Decimal partout, transactions Prisma, soft-delete, anti-doublon caisse via `@@unique(sourceType, sourceId)`, recalcul « à la volée » du bordereau depuis les `InvoiceItem`. Les corrections récentes ont assaini la caisse.

Il reste néanmoins des défauts comptables réels, dont **deux P0** :
1. `colisVendus` du bordereau est incrémenté à la **création de la facture** sans jamais être décrémenté lors d'une modification (`PATCH /invoices/:id`) ou d'une suppression de vente/facture → **double comptage permanent** des colis vendus, du poids net et du `totalBrutVentes` stocké.
2. Le **paiement fournisseur CASH rouvre silencieusement une journée de caisse clôturée** et modifie une écriture déjà arrêtée, sans re-clôture ni régénération du `CashRegisterClosing` → l'instantané comptable du jour devient faux.

S'y ajoutent des incohérences de règles (clôture bordereau impossible en cas de pertes, `montantFinalDu` détruit par le paiement puis recalculé par n'importe quel PATCH, avances double-comptées entre réception et bordereau, `supplierPaymentTotal` non persisté alors que `totalOutputs` l'inclut, etc.).

**14 problèmes** classés ci-dessous.

## (b) Problèmes trouvés

### P0 — critique (perte / corruption de données comptables)

#### P0-1 — `colisVendus` / `poidsNetVendu` / `totalBrutVentes` cumulés sans jamais être annulés
**Fichier** : `src/routes/invoices.routes.ts:392-413` (création) — absent dans `PATCH /:id` (`:592-662`) et dans `DELETE /api/sales/:id` (`sales.routes.ts:672-686`).

```ts
const newColisVendus = new Prisma.Decimal(bordereau.colisVendus).plus(colis)…
const newPoidsNetVendu = new Prisma.Decimal(bordereau.poidsNetVendu).plus(netWeight)…
const newTotalBrutVentes = new Prisma.Decimal(bordereau.totalBrutVentes).plus(montant)…
```

Ces trois champs sont **incrémentés en delta** à la création de la facture. Or :
- `PATCH /api/invoices/:id` soft-delete toutes les lignes et les recrée (`invoiceItem.updateMany … deletedAt`) **sans toucher au bordereau** ;
- `DELETE /api/sales/:id` soft-delete la vente et ses factures **sans décrémenter le bordereau** ;
- `DELETE /api/invoices/:id` (DRAFT) idem.

**Impact métier** : après une simple correction de facture (cas quotidien : erreur de poids/prix), le bordereau affiche des colis vendus et un poids net gonflés. Conséquences en cascade : `colisRestant` négatif, statut passé à tort en `pret_a_cloturer`, et surtout **la clôture (`PATCH /:id/cloture`) devient possible ou impossible à tort**. `totalBrutVentes` stocké diverge du recalculé, mais il est utilisé tel quel dans les listes (`GET /supplier-bordereaux` → `serialize`) et dans `supplier-payments` via `montantFinalDu`.

**Correction suggérée** : rendre `colisVendus` / `poidsNetVendu` **dérivés** comme `totalBrutVentes` l'est déjà dans `getSalesLinesForBordereau` — c.-à-d. les recalculer par agrégat `Σ InvoiceItem(lotIds).colis` / `Σ netWeight` à chaque opération, au lieu du `.plus()` en delta. À défaut, ajouter la décrémentation symétrique dans PATCH invoice, DELETE invoice et DELETE sale.

#### P0-2 — Réouverture silencieuse d'une journée de caisse clôturée par un paiement fournisseur
**Fichier** : `src/routes/supplier-payments.routes.ts:527-549`

```ts
const day = await getOrCreateDay(tx, datePaiement);
if (day.status === 'cloturee') {
  await tx.cashRegisterDay.update({ where: { id: day.id },
    data: { status: 'ouverte', closedBy: null, closedAt: null } });
```

Toutes les autres saisies (dépense `:798`, appro `:949`, remise `:1034`) refusent explicitement une journée clôturée (409). Le paiement fournisseur, lui, **force la réouverture**, efface `closedBy`/`closedAt`, ajoute une sortie, puis **ne re-clôture pas** et **ne met pas à jour le `CashRegisterClosing`** déjà figé (`cash-register.routes.ts:1169`).

**Impact métier** : le snapshot de clôture (document légal / justificatif du fonds de caisse remis) reste avec l'ancien `totalSorties` et l'ancien `difference`, alors que la journée a bougé. Le fonds d'ouverture du lendemain, déjà propagé (`:1190-1196`), n'est pas non plus recalculé. Deux vérités contradictoires pour la même journée.

**Correction suggérée** : refuser le paiement CASH sur une journée clôturée (409, comme les dépenses) et forcer l'utilisateur à dater le paiement sur le jour ouvert ; ou, si la réouverture est un besoin métier, la rendre explicite (endpoint dédié + motif obligatoire) et invalider/regénérer le `CashRegisterClosing` et le fonds d'ouverture du lendemain.

### P1 — majeur

#### P1-1 — Double comptage de l'avance de réception : déduite du bordereau ET du solde fournisseur
**Fichiers** : `supplier-receptions.routes.ts:274-301` et `supplier-bordereaux.routes.ts:298-342`

À la réception, une avance crée un `SupplierAdvance` **et** une écriture `SupplierAccountEntry` CREDIT **et** `supplier.balance -= montant` (`:297-300`). Ensuite, l'affectation de cette même avance au bordereau (`allocateAdvance`) fait `montantFinalDu = totalBrut − commission − avancesAffectees − …`, donc **retire une seconde fois** l'avance côté « ce que l'on doit ». Puis le règlement du bordereau (`supplier-payments:466-469`) fait encore `balance decrement: montant`.

**Impact métier** : le solde fournisseur est faussé du montant de l'avance dès qu'elle est affectée puis le solde réglé. En clair : `balance` reflète l'avance, `montantFinalDu` la reflète aussi, et le paiement du reste décrémente encore.

**Correction suggérée** : choisir une seule source de vérité. Si `Supplier.balance` est un ledger dérivé (c'est déjà le cas dans `supplier-advances.routes.ts:55-76` via `reconcileSupplierBalance`), alors **n'utiliser que ce recalcul** dans réceptions et paiements plutôt que des `increment`/`decrement` ponctuels, qui sont eux non idempotents.

#### P1-2 — `Supplier.balance` maintenu par deux mécanismes incompatibles
**Fichiers** : `supplier-advances.routes.ts:55-76` (recalcul ledger `Σ DEBIT − Σ CREDIT`) vs `supplier-receptions.routes.ts:297`, `:693`, `:730` et `supplier-payments.routes.ts:466` (`{ decrement }` / `{ increment }` bruts).

Les paiements fournisseur décrémentent `balance` **sans créer de `SupplierAccountEntry` DEBIT**. Le jour où `reconcileSupplierBalance()` est rappelé (n'importe quelle allocation/remboursement/annulation d'avance), **le solde est écrasé** par le ledger, et tous les paiements effectués disparaissent du solde.

**Impact métier** : dette fournisseur qui « remonte » toute seule après une opération d'avance. Perte de traçabilité comptable.

**Correction suggérée** : dans `supplier-payments`, créer une `SupplierAccountEntry` de type `DEBIT` (montant réglé, référence BP) et remplacer le `decrement` par un appel à `reconcileSupplierBalance`.

#### P1-3 — Clôture de bordereau impossible dès qu'il y a des pertes
**Fichier** : `supplier-bordereaux.routes.ts:433-435`

```ts
if (new Prisma.Decimal(b.colisVendus).lessThan(b.colisRecus))
  return res.status(400).json({ error: 'Clôture impossible : colis vendus < colis reçus' });
```

La règle exige `colisVendus >= colisRecus`, alors que partout ailleurs le reste est calculé `colisRecus − colisVendus − pertes` (`:200-205`, `invoices:400`). Un lot avec 100 colis reçus, 95 vendus et 5 perdus (cas ultra-courant en fruits/légumes) est **définitivement non clôturable**, donc **non payable** (`STATUTS_PAYABLES` exige `cloture`).

**Impact métier** : blocage du paiement fournisseur sur tout bordereau ayant la moindre perte. Le fournisseur ne peut pas être réglé.

**Correction suggérée** : `colisVendus + totalPertesColis >= colisRecus`, en réutilisant `getLossesForBordereau(lotIds)` déjà présent dans le fichier. Idéalement autoriser aussi une clôture forcée avec motif.

#### P1-4 — `montantFinalDu` sert à la fois de « montant dû initial » et de « reste à payer » : tout recalcul écrase les paiements
**Fichiers** : `supplier-payments.routes.ts:444-452` vs `supplier-bordereaux.routes.ts:253`, `:334`, `:410`, `:512` et `supplier-receptions.routes.ts:659-664`

Le règlement décrémente `montantFinalDu` (reste à payer). Mais `PATCH /supplier-bordereaux/:id`, l'affectation/désaffectation d'avance, `/correct` et même un `PATCH` de réception **recalculent** `montantFinalDu = totalBrut − commission − avances − droitMarche − transport`, c.-à-d. **le montant plein, en ignorant ce qui a déjà été payé**.

Le garde-fou `statut === 'cloture'` de `PATCH /:id` (`:240`) ne protège pas : après un règlement partiel le statut devient `partiellement_paye`, donc le PATCH **est autorisé** et remet le dû à zéro-paiement.

**Impact métier** : un fournisseur déjà payé partiellement peut être **repayé intégralement**. Perte financière directe.

**Correction suggérée** : séparer les champs — `montantFinalDu` (calculé, immuable vis-à-vis des paiements) et `montantPaye` / `resteAPayer` (dérivé de `Σ SupplierPaymentLine.montantPaye`). Le contrôle de surpaiement doit se faire sur `montantFinalDu − Σ montantPaye`.

#### P1-5 — Aucune annulation possible d'un bon de paiement / d'un règlement fournisseur
**Fichier** : `supplier-payments.routes.ts` (aucune route DELETE ni `/cancel`)

Il n'existe ni annulation de bon (`SupplierPayment`), ni annulation de règlement. Une erreur de saisie (montant, mauvais bordereau, mauvais fournisseur) est **irréversible** : le bordereau est décrémenté, le `Payment` créé, la caisse impactée, l'avance imputée.

**Impact métier** : la seule issue est l'intervention SQL manuelle en base — risque majeur pour un utilisateur non technique.

**Correction suggérée** : ajouter `POST /:id/cancel` transactionnel (motif obligatoire) qui : ré-incrémente `montantFinalDu`, restaure `statut`, soft-delete le `Payment`, crée une écriture caisse inverse (`OTHER_ENTRY`), désalloue les `SupplierAdvanceAllocation`, recalcule la journée.

#### P1-6 — Émission de facture : la dette client augmente à chaque appel de `/issue`
**Fichier** : `invoices.routes.ts:460-479`

```ts
if (inv.status === 'PAID' || inv.status === 'CANCELLED') return 409;
if (inv.customerId) await prisma.customer.update({ data: { balance: { increment: total } } });
```

Aucun contrôle sur `status === 'SENT'`. Rappeler `/issue` sur une facture déjà émise (double-clic front, ré-impression) **ré-incrémente le solde client** et réinitialise `issueDate` à la date du jour.

**Impact métier** : (a) dette client gonflée artificiellement ; (b) le déplacement de `issueDate` **change la journée de caisse d'imputation** de la facture — la vente disparaît du jour d'origine (dont la clôture est déjà figée) et réapparaît aujourd'hui. Corruption directe des totaux de caisse historiques.

**Correction suggérée** : refuser si `status !== 'DRAFT'` ; ne jamais réécrire `issueDate` à l'émission d'une facture déjà émise.

#### P1-7 — `supplierPaymentTotal` non persisté alors que `totalOutputs` persisté l'inclut
**Fichier** : `cash-register.routes.ts:270-286` (commentaire explicite `:280-281`) et `:1149-1167`

`recalculerEtPersister` persiste `totalOutputs` (qui **contient** `supplierPaymentTotal`, cf. `:236-241`) mais ne persiste pas `supplierPaymentTotal` lui-même. Le modèle `CashRegisterDay` n'a donc pas de colonne pour ce poste, et `CashRegisterClosing` (`:1169-1187`) enregistre `depensesTotal: t.expenseTotal` **sans** les règlements fournisseurs.

**Impact métier** : sur l'instantané de clôture, `totalEntrees − totalSorties ≠ facturesTotal + … − depensesTotal − …` : la somme des postes détaillés ne retombe pas sur `totalSorties`. L'écart est exactement le montant des règlements fournisseurs. Impossible de justifier la caisse ligne à ligne depuis l'archive.

**Correction suggérée** : ajouter une colonne `supplierPaymentTotal` sur `CashRegisterDay` et `CashRegisterClosing`, ou au minimum agréger `expenseTotal + supplierPaymentTotal` dans `depensesTotal` du closing (comme le fait déjà le PDF, `:739`).

#### P1-8 — La journée de caisse est déterminée en UTC mais l'heure de saisie en heure locale
**Fichier** : `cash-register.routes.ts:31-34` (`jour()` en `Date.UTC`) vs `:49-52` (`heureCourante()` en `getHours()` local) et `supplier-payments.routes.ts:32-36` (`jour()` local avec `setHours(0,0,0,0)`).

Deux implémentations de `jour()` coexistent : celle de la caisse normalise en **UTC**, celle des paiements fournisseur en **heure locale**. En Algérie (UTC+1), un paiement fournisseur enregistré passe par `jour()` local → `2026-08-04T00:00:00+01:00` = `2026-08-03T23:00Z`, qui **ne correspond à aucune clé** `cashRegisterDay.date` créée par la caisse (toujours minuit UTC).

**Impact métier** : `getOrCreateDay` peut créer une **journée fantôme décalée d'un jour**, avec son propre fonds d'ouverture à 0, et le règlement disparaît du bordereau de caisse du jour réel.

**Correction suggérée** : exporter la fonction `jour()` de `cash-register.routes.ts` et l'utiliser partout (supprimer la version locale de `supplier-payments.routes.ts`). Fixer un fuseau métier unique (`Africa/Algiers`) dans la config.

#### P1-9 — Réception : génération de référence et de lot sujettes aux collisions
**Fichier** : `supplier-receptions.routes.ts:155-163` (`nextRef`) et `:202` (`lotNumber`)

`nextRef` charge **toutes** les lignes de la table pour calculer `max+1` sans verrou. Deux réceptions concurrentes obtiennent la même référence `BR-000042` → violation de contrainte unique (erreur 500 opaque) ou, pire, doublon si la contrainte n'existe pas. Même problème pour `nextBpRef`/`nextPaymentRef` (`supplier-payments:39-68`), `nextRef` caisse (`:68-85`) et `nextReference` paiements (`payments:46-59`).
`lotNumber: LOT-${Date.now()}-${seq}` collisionne si deux réceptions sont créées dans la même milliseconde.

**Impact métier** : échecs de saisie aléatoires en heure de pointe (marché de gros = plusieurs postes en parallèle au petit matin) et risque de références comptables dupliquées.

**Correction suggérée** : utiliser une séquence PostgreSQL (`CREATE SEQUENCE`) ou `SELECT … FOR UPDATE` sur une table de compteurs, dans la transaction. Pour `lotNumber`, utiliser un cuid/uuid ou la même séquence.

### P2 — mineur

#### P2-1 — Règle « 1 bordereau = 1 seul BP » incompatible avec les règlements partiels multi-bons
**Fichier** : `supplier-payments.routes.ts:106-118`

```ts
const dejaPris = await prisma.supplierPaymentLine.findMany({ select: { bordereauId: true } });
… id: { notIn: idsExclus }
```

Tout bordereau apparaissant dans **n'importe quelle** ligne de bon est exclu des éligibles, y compris s'il est resté `partiellement_paye` avec un reste dû > 0. Or `STATUTS_PAYABLES` inclut explicitement `partiellement_paye` (`:29`) et `/pay` gère le règlement partiel.

**Impact métier** : après un premier acompte, le solde du bordereau **n'apparaît plus** dans l'écran de création d'un nouveau bon. Il n'est réglable qu'en rappelant `/pay` sur l'ancien bon — non découvrable par l'utilisateur.

**Correction suggérée** : n'exclure que les bordereaux au statut `paye`, ou exclure uniquement ceux référencés par un bon **non soldé** (`status !== 'paye'`).

#### P2-2 — Le requête `dejaPris` ignore les soft-deletes et n'est pas filtrée par fournisseur
**Fichier** : `supplier-payments.routes.ts:108-111`

`supplierPaymentLine.findMany({ select: { bordereauId: true } })` charge **toutes** les lignes de toute l'histoire (pas de `where: { deletedAt: null }`, pas de filtre `payment.supplierId`) puis construit un `notIn` potentiellement énorme.

**Impact** : dégradation progressive des performances et exclusion de bordereaux dont le bon a été (ou sera) supprimé logiquement.

**Correction suggérée** : filtrer sur `payment: { supplierId, deletedAt: null }`.

#### P2-3 — `PATCH /supplier-bordereaux/:id` autorise n'importe quelle transition de statut
**Fichier** : `supplier-bordereaux.routes.ts:223-266`

`statut` est accepté librement parmi les 6 valeurs (`:226`) sans machine à états. Un bordereau `paye` peut être repassé à `ouvert`, un `partiellement_paye` à `cloture` sans passer par `/cloture` (donc **sans** figer `commissionDefinitive` / `avancesDefinitives` / `montantFinalDefinitif`), et sans contrôle `colisVendus`.

**Impact métier** : contournement complet du workflow de clôture et des champs « définitifs » censés servir de preuve.

**Correction suggérée** : retirer `statut` du `patchSchema` (les transitions passent par `/cloture` et `/pay`), ou implémenter une table de transitions autorisées.

#### P2-4 — Le contrôle anti-régression de la réception compare des colis non-pertes
**Fichier** : `supplier-receptions.routes.ts:443-454`

Le garde-fou refuse `projete < vendus`, mais ignore les pertes. Symétriquement `:636` calcule bien `colisRestant = totColis − vendus − pertes`. Une réduction de `nbrColis` acceptée par le garde-fou peut donc produire un `colisRestant` **négatif** persisté en base.

**Correction suggérée** : contrôler `projete >= vendus + pertes`.

#### P2-5 — `getBordereauLotIds` ajoute `bordereau.lotId` même si le lot a été soft-deleted
**Fichier** : `bordereaux/lots.ts:12-20`

```ts
const lots = await db.stockLot.findMany({ where: { bordereauId: bordereau.id, deletedAt: null } … });
if (bordereau.lotId) ids.add(bordereau.lotId);   // pas de check deletedAt
```

Après un `PATCH` de réception qui soft-delete un lot orphelin (`supplier-receptions:588`), si ce lot était le `lotId` principal du bordereau, il **revient** dans les calculs de `totalBrutVentes` et de pertes.

**Impact** : montant brut de ventes surévalué sur les bordereaux édités.

**Correction suggérée** : vérifier `deletedAt: null` avant d'ajouter `bordereau.lotId`, ou repointer `bordereau.lotId` sur un lot vivant lors de la réconciliation.

#### P2-6 — `PATCH /invoices/:id` ne recalcule pas le statut ni le solde client
**Fichier** : `invoices.routes.ts:654-663`

Le `total` de la facture est recalculé et écrit, mais : (a) `Customer.balance` n'est **pas** ajusté du delta, alors que `/issue` l'a incrémenté du total initial ; (b) `reconcileInvoice` n'est pas appelé, donc une facture `PARTIALLY_PAID` dont on baisse le total sous le montant déjà encaissé **reste** `PARTIALLY_PAID` au lieu de passer `PAID`.

**Correction suggérée** : dans la transaction, appliquer `balance += (nouveauTotal − ancienTotal)` si `status !== 'DRAFT'`, et appeler la logique de réconciliation de statut (à factoriser depuis `payments.routes.ts:65`).

#### P2-7 — `POST /:id/pay` : réécriture du `mode`/`method` du bon à chaque règlement partiel
**Fichier** : `supplier-payments.routes.ts:588-591`

```ts
data: { status: nouveauStatus, mode, method: method as any }
```

Un bon réglé en deux fois (1er versement CASH, 2e par virement) finit avec `method = BANK_TRANSFER` pour la totalité. Le PDF du bon (`:694-717`) affiche alors un mode de règlement faux pour la première tranche, et l'écriture caisse CASH cumulée (`:552-562`) ne correspond plus au `method` affiché.

**Correction suggérée** : porter `mode`/`method` sur la **ligne de règlement** (ou créer une table `SupplierPaymentTransaction`) plutôt que sur l'en-tête du bon.

#### P2-8 — Le `montantPaye` cumulé n'est jamais confronté au `montant` prévu de la ligne
**Fichier** : `supplier-payments.routes.ts:513-523`

Le cumul `montantPaye += montant` n'est borné que par `montantFinalDu` du bordereau, jamais par `ligneBP.montant` (le montant prévu au bon). On peut donc régler via un bon un montant supérieur à ce que ce bon annonçait, tant que le bordereau le permet. Le PDF calcule `reste = montantDuAvant − montantPaye` (`:712`) et peut afficher un **reste négatif**.

**Correction suggérée** : contrôler `dejaPaye + montant <= ligneBP.montant` et clamper l'affichage du reste à 0.

### P3 — cosmétique

#### P3-1 — Bordereau : `commissionType` sans validation métier sur `commissionValue`
**Fichier** : `supplier-bordereaux.routes.ts:48-52`, `:223-228`

`commissionValue` accepte n'importe quelle valeur, y compris négative ou > 100 en mode `pourcentage`. Une commission de 150 % rend `montantFinalDu` négatif, et le bordereau devient non payable (`du <= 0` → « plus rien à payer ») sans message explicite.

**Correction** : `z.number().min(0)` et, en `pourcentage`, `.max(100)`.

#### P3-2 — Champs `colisRestant` stocké vs recalculé : deux vérités affichées
**Fichier** : `supplier-bordereaux.routes.ts:107` (`serialize` renvoie le stocké) vs `:200-209` (le détail écrase par le recalculé).

La **liste** (`GET /`) affiche `colisRestant` **stocké**, le **détail** (`GET /:id`) affiche le **recalculé** (pertes déduites). L'utilisateur voit deux chiffres différents pour le même bordereau selon l'écran.

**Correction** : appliquer le même recalcul dans la liste, ou supprimer la colonne stockée.

#### P3-3 — Le PDF du bordereau de caisse regroupe les règlements fournisseurs dans « LES DEPENSES »
**Fichier** : `cash-register.routes.ts:735-739`

C'est un choix assumé et documenté, mais il crée une divergence UI/PDF : le poste « dépenses » du papier ≠ celui de l'écran. À signaler dans la légende du PDF (« dont règlements fournisseurs : X ») pour éviter les rapprochements erronés.

## (c) Points forts

- **Decimal partout** (`Prisma.Decimal`), jamais de `float` sur les montants ; arrondis explicites (`toDecimalPlaces(2)` montants, `(3)` colis).
- **Transactions Prisma systématiques** sur toutes les mutations multi-tables (réception, paiement, clôture, encaissement).
- **Anti-doublon caisse robuste** : `@@unique(sourceType, sourceId)` + helper `assertPasDeDoublon` (`cash-register:338-351`), et cumul contrôlé sur l'écriture existante lors des règlements partiels (`supplier-payments:550-562`).
- **Principe « lecture seule » de la caisse** bien tenu : factures et encaissements agrégés à la volée, jamais dupliqués en `CashRegisterEntry` — évite toute une classe de double comptage.
- **Cohérence agrégat/drill-down** : `GET /days/:date/credit-sales` réplique exactement le filtre de `creditInvoiceTotal` (`:640-642`), avec commentaire expliquant pourquoi. Bonne discipline.
- **Bordereau : source de vérité recalculée** — `getSalesLinesForBordereau` recalcule `totalBrutVentes` depuis les `InvoiceItem` à chaque lecture, ce qui neutralise en grande partie les dérives du champ stocké.
- **Préservation du `lotId`** lors de la réédition d'une facture (`invoices:592-639`), avec cascade de fallbacks — le lien vente→bordereau survit aux corrections. Idem préservation des ventes lors de la réédition d'une réception (`supplier-receptions:479-500`, ajustement du lot sans perdre les sorties déjà faites).
- **Traçabilité** : `SupplierBordereauCorrection` (motif obligatoire), `CashRegisterAuditLog`, `auditLog()` sur les opérations sensibles, soft-delete généralisé.
- **Surpaiement fournisseur bloqué** à la création du bon comme au règlement (`supplier-payments:234-240`, `:402-408`), et **surpaiement client bloqué** (`payments:147-153`).
- **Séparation `PAY` / `ENCAISSER`** propre : l'imputation d'avance ne génère aucune sortie de caisse, ce qui est comptablement correct.
- **Commentaires métier de qualité** dans les en-têtes de fichiers : les règles et les bugs passés y sont documentés, ce qui facilite considérablement l'audit et la maintenance.

---
*Audit réalisé en lecture seule — aucun fichier de code modifié, aucun serveur démarré, aucune donnée créée.*



