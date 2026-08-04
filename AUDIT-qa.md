# AUDIT QA / Chasse aux bugs — Fruiterie ERP

Date : audit lecture seule (aucune écriture, aucun POST/PUT/DELETE, aucun serveur lancé).
Périmètre : backend `/home/mimo/fruiterie-app/backend/src/routes/*.ts` + `prisma/schema.prisma`,
vérifications par GET sur `http://localhost:8080/api` (base de test remplie).

Les 3 bugs déjà corrigés (1 réception = 1 bordereau ; ventes comptant non comptées en crédit
caisse ; paiement fournisseur séparé des dépenses) ne sont **pas** re-signalés.

---

## (a) Résumé exécutif

Le socle est sain : Decimal partout, soft-delete généralisé, transactions Prisma sur toutes les
mutations sensibles, anti-doublon strict `@@unique([sourceType, sourceId])` en caisse, et
recalculs « à la volée » côté caisse/bordereau qui évitent les totaux miroirs périmés.

Cependant l'audit remonte **13 problèmes réels**, dont **3 P0** qui produisent des chiffres faux
en production :

1. **Double comptage des règlements fournisseurs en caisse** : la journée 2026-08-02 affiche
   10 lignes de sortie pour 5 bons de paiement (les lignes virtuelles et les lignes réelles sont
   toutes deux envoyées au frontend).
2. **Le drill-down caisse « règlements fournisseurs » ne correspond pas à l'agrégat** : la somme
   listée (508 013,75) est correcte mais BP-2026-0016 y apparaît pour 336 000 alors que son
   `totalAmount` est 168 000 → l'écriture de caisse cumulée n'est jamais décrémentée/corrigée.
3. **Encaissement supérieur au total facture possible** : la facture F-2026-0030 existe en base
   avec `total=1`, `paidAmount=200`, `remaining=-199`, statut PAID.

Les P1 concernent la cohérence bordereau clôturé ↔ montants définitifs (BF-096461 :
`montantFinalDefinitif=11200` mais `montantFinalDu` recalculé = 10192), la réouverture
silencieuse d'une journée de caisse clôturée par un paiement fournisseur, et les collisions de
références après soft-delete pour `AV-` (deux formats coexistent : `AV-2026-0001` et `AV-000001`).

Points forts détaillés en section (c).

---

## (b) Problèmes classés

### P0 — bloquants (chiffres faux, argent)

#### P0-1 — Double affichage des règlements fournisseurs dans la journée de caisse
**Fichier** : `backend/src/routes/cash-register.routes.ts:438-466` et `:479-480`

**Description** : le handler `GET /days/:date` construit une ligne **virtuelle** par
`CashRegisterEntry` de `sourceType='SUPPLIER_PAYMENT'` (boucle ligne 453-465), puis concatène
`[...virtuelles, ...reelles]` (ligne 480) où `reelles` contient **déjà ces mêmes
CashRegisterEntry**. Contrairement à `INVOICE_TOTAL` / `CREDIT_COLLECTION` (qui n'ont aucune
ligne réelle en base), `SUPPLIER_PAYMENT` est une ligne physique : elle est donc rendue deux fois.

**Repro (lecture seule)** :
```
GET /api/cash-register/days/2026-08-02
```
→ `outputs` contient 10 lignes : 5 « Règlement fournisseur — Domaine Saharien Dates »
(142779 / 16584.75 / 336000 / 11200 / 1450) **et** 5 « Paiement fournisseur » aux mêmes montants.
`totaux.supplierPaymentTotal = 508013.75` (compté une seule fois, correct), mais la somme des
lignes affichées vaut 1 016 027,50.

**Impact** : le bordereau de caisse à l'écran affiche le double des sorties fournisseurs ;
la somme des lignes ne réconcilie plus avec `totalOutputs`. Perte de confiance comptable.

**Suggestion** : ne pas générer les lignes virtuelles `SUPPLIER_PAYMENT`, et enrichir à la place
la `category` des lignes réelles avec le nom du fournisseur ; ou filtrer
`reelles = lignes.filter(l => l.sourceType !== 'SUPPLIER_PAYMENT')`.

---

#### P0-2 — L'écriture de caisse d'un bon de paiement n'est jamais corrigée/décrémentée
**Fichier** : `backend/src/routes/supplier-payments.routes.ts:552-577`

**Description** : sur `POST /:id/pay`, si une écriture `SUPPLIER_PAYMENT` existe déjà pour ce bon,
le code fait `amount: existante.amount + total` (ligne 560). Aucune route ne décrémente jamais
cette écriture, et le montant cumulé peut dépasser le `totalAmount` du bon si `/pay` est rappelé
sur des bordereaux dont le dû a été régénéré entre-temps (correction, ajout de ventes).

**Repro (lecture seule)** :
```
GET /api/supplier-payments/cmsb4kwb9000vpw60dew463yf   → BP-2026-0016, totalAmount = 168000
GET /api/cash-register/days/2026-08-02/supplier-payments → BP-2026-0016, amount = 336000
```
Écart de 168 000 DA entre le bon de paiement et la sortie de caisse qu'il a générée.

**Impact** : sortie de caisse surévaluée de 168 000 DA sur une seule journée de test.
`difference` de la journée est faussée d'autant.

**Suggestion** : recalculer l'écriture à partir de `Σ SupplierPaymentLine.montantPaye` du bon
(source de vérité) au lieu d'un `+=` aveugle, et ajouter une garde
`montantCaisse <= totalAmount`.

---

#### P0-3 — Encaissement possible au-delà du total de la facture (données incohérentes en base)
**Fichier** : `backend/src/routes/payments.routes.ts:140-153` (garde) et
`backend/src/routes/invoices.routes.ts:573-673` (PATCH)

**Description** : `POST /api/payments` garde bien contre le surpaiement, mais le
`PATCH /api/invoices/:id` autorise la **réduction du total** d'une facture non-PAID
(`inv.status === 'PAID'` est le seul verrou, ligne 585) **sans re-vérifier les paiements déjà
encaissés** et sans rappeler `reconcileInvoice`. On obtient donc un `remaining` négatif.

**Repro (lecture seule)** :
```
GET /api/invoices | facture F-2026-0030
→ {"status":"PAID","total":"1","paidAmount":"200","remaining":"-199"}
```

**Impact** : solde client faux de 199 DA sur cette facture ; `Customer.balance` a été décrémenté
de 200 alors que la dette n'était que de 1. Généralisable à n'importe quelle facture éditée
après encaissement partiel.

**Suggestion** : dans le PATCH, refuser `nouveauTotal < Σ paiements` (409), et appeler
`reconcileInvoice(tx, inv.id)` après toute modification du total.

---

### P1 — majeurs

#### P1-1 — Bordereau clôturé : montants « définitifs » incohérents avec le recalcul à la volée
**Fichier** : `backend/src/routes/supplier-bordereaux.routes.ts:165-220` (GET) vs `:428-468` (cloture)

**Description** : la clôture fige `commissionDefinitive` / `montantFinalDefinitif`, mais le
`GET /:id` renvoie **toujours** un `montantFinalDu` recalculé à la volée depuis les InvoiceItem,
sans tenir compte du figé. Les deux valeurs divergent dès qu'un paiement a décrémenté
`montantFinalDu` en base (`supplier-payments.routes.ts:446-452`).

**Repro (lecture seule)** :
```
GET /api/supplier-bordereaux/cmsb4s45e0023pw604n2bjypy   (BF-096461, statut "paye")
→ montantFinalDu (recalculé) = 10192   |   montantFinalDefinitif = 11200
→ le champ persisté en base vaut 0 (visible via GET /api/supplier-bordereaux)
```
Trois valeurs différentes pour le même concept sur un bordereau soldé.

**Impact** : impossible de savoir ce qui reste dû ; le PDF bordereau (`:556`) imprime la valeur
recalculée, donc un bordereau intégralement payé s'imprime avec 10 192 DA de dû.

**Suggestion** : quand `statut ∈ {cloture, partiellement_paye, paye}`, le GET et le PDF doivent
renvoyer la valeur **persistée** `montantFinalDu` (reste réel) et n'utiliser le recalcul que pour
les bordereaux `ouvert` / `pret_a_cloturer`.

---

#### P1-2 — Un paiement fournisseur CASH réouvre silencieusement une journée de caisse clôturée
**Fichier** : `backend/src/routes/supplier-payments.routes.ts:528-549`

**Description** : si la journée cible est `cloturee`, le code la repasse à `ouverte` et efface
`closedBy`/`closedAt`, alors que toutes les autres saisies (dépense, appro, remise) refusent
avec un 409 (`cash-register.routes.ts:798-802`, `:949-953`, `:1034-1038`). L'instantané
`CashRegisterClosing` existant, lui, n'est pas invalidé.

**Repro (lecture seule)** : lire le code ci-dessus + constater qu'aucun log métier n'est visible
par l'utilisateur (`CashRegisterAuditLog` action `reouverture` seulement, non exposé par une
route GET — voir P2-4).

**Impact** : une clôture comptable validée peut être annulée sans aucune trace visible pour
l'exploitant ; les totaux du jour changent après signature du bordereau papier.

**Suggestion** : refuser (409) comme les autres saisies et exiger une réouverture explicite, ou
au minimum créer une nouvelle `CashRegisterClosing` et remonter un avertissement dans la réponse.

---

#### P1-3 — Collisions / incohérence de références après soft-delete (`AV-`)
**Fichier** : `backend/src/routes/supplier-receptions.routes.ts:155-163` et `:700-706` vs
`backend/src/routes/supplier-advances.routes.ts:108-120`

**Description** : trois générateurs de référence d'avance coexistent avec des formats
incompatibles :
- `supplier-advances.routes.ts` → `AV-2026-0001` (séquence annuelle, regex `^AV-\d{4}-(\d+)$`)
- `supplier-receptions.routes.ts` POST (`nextRef`) → `AV-000001` (regex `(\d+)\s*$` sur **toutes**
  les références, y compris `AV-2026-0001` dont elle extrait `0001`)
- `supplier-receptions.routes.ts` PATCH (`:706`) → `AV-000001` idem

La regex `(\d+)\s*$` appliquée à `AV-2026-0007` renvoie 7, pas 20260007. Deux formats en base
suffisent donc à faire retomber le compteur sur une référence existante → `P2002` sur
`reference @unique`, y compris contre une avance **soft-deleted** (la contrainte unique
s'applique aux lignes `deletedAt != null`).

**Repro (lecture seule)** :
```
GET /api/supplier-advances
→ "AV-2026-0001" (format A) et "AV-TEST-BP1" (format libre) cohabitent déjà
```
Le prochain `nextRef('supplierAdvance', …)` calcule max=1 depuis `AV-2026-0001` et proposera
`AV-000002`. Une réception ultérieure retombera sur la même valeur si `AV-000002` a été
soft-deleted par le PATCH (`:688`).

**Impact** : 500 « Erreur création réception » non explicite au moment d'enregistrer une
marchandise avec avance ; blocage terrain.

**Suggestion** : un seul helper de référence partagé, format unique, regex ancrée sur le préfixe
exact, et boucle de retry sur `P2002`.

---

#### P1-4 — `POST /:id/pay` ne borne pas le règlement au montant du bon de paiement
**Fichier** : `backend/src/routes/supplier-payments.routes.ts:328-411`

**Description** : la validation contrôle ligne par ligne `montant <= bordereau.montantFinalDu`,
mais jamais `Σ montantPaye <= SupplierPaymentLine.montant` ni
`Σ montantPaye <= SupplierPayment.totalAmount`. Le bon n'est donc pas un plafond : si le dû du
bordereau remonte (correction via `/correct`, nouvelle facture sur le lot), on peut régler via ce
bon plus que ce qu'il autorise. C'est le mécanisme qui a produit P0-2.

**Repro (lecture seule)** : BP-2026-0016 — `totalAmount=168000`, ligne
`montant=168000, montantDuAvant=336000`, mais la caisse porte 336 000 pour ce bon.

**Impact** : dépassement du bon signé ; incohérence bon ↔ caisse ↔ solde fournisseur.

**Suggestion** : ajouter la garde
`D(ligneBP.montantPaye ?? 0).plus(montant) <= D(ligneBP.montant)` avant écriture.

---

#### P1-5 — `montantPaye` des lignes de bon reste à 0 sur des bons soldés
**Fichier** : `backend/src/routes/supplier-payments.routes.ts:513-523` et `:704-714` (PDF)

**Description** : `montantPaye` n'est incrémenté que si `findFirst` retrouve la ligne
`(paymentId, bordereauId)`. Sur les données de test, des bons `status='paye'` conservent
`montantPaye = 0`.

**Repro (lecture seule)** :
```
GET /api/supplier-payments/cmsb4kwb9000vpw60dew463yf
→ status "paye", lines[0].montant "168000", lines[0].montantPaye "0", reste "0"
```

**Impact** : le PDF « bon de paiement » (`:710-712`) imprime `montantPaye = 0.00` et
`reste = montantDuAvant − 0 = 336000.00` sur un bon **entièrement réglé**. Document remis au
fournisseur totalement faux.

**Suggestion** : dériver `montantPaye` de `montantDuAvant − bordereau.montantFinalDu` en lecture,
ou fiabiliser l'incrément (contrainte unique `(paymentId, bordereauId)` sur `SupplierPaymentLine`).

---

#### P1-6 — Double sortie de stock potentielle : `POST /api/invoices` crée un StockMovement OUT en plus de celui de `confirmSale`
**Fichier** : `backend/src/routes/invoices.routes.ts:416-429` vs
`backend/src/routes/sales.routes.ts:611-625`

**Description** : la création de facture crée un `StockMovement` `OUT` de `colis` par ligne liée à
un lot, avec le commentaire « tracage uniquement ». Or `confirmSale` a déjà créé un `OUT` pour la
même marchandise. `remainingQuantity` n'est décrémenté qu'une fois (correct), mais le **journal
des mouvements** compte double.

**Repro (lecture seule)** : lecture croisée du code — `sales.routes.ts:612-625` crée un `OUT`
avec `reference = sale.reference` (`V-…`) puis `invoices.routes.ts:418-429` crée un second `OUT`
avec `reference = created.reference` (`F-…`) et la même quantité (`colis`) sur le même `lotId`.
Non vérifiable par API : **aucune route ne liste les `StockMovement`** (voir P3-3), ce qui masque
justement ce doublon.

**Impact** : tout état de stock reconstruit depuis les mouvements (inventaire théorique, export
comptable, contrôle d'écart) donne une sortie double et un stock négatif.

**Suggestion** : ne pas créer de `StockMovement` à la facturation (le lien facture↔lot est déjà
porté par `InvoiceItem.lotId`), ou introduire un `type` distinct non comptabilisé
(ex. `TRACE`) exclu des agrégats.

---

### P2 — modérés

#### P2-1 — Incohérence `totalEntries` / `totalOutputs` / `difference` : le fonds d'ouverture est compté en entrée mais pas en sortie
**Fichier** : `backend/src/routes/cash-register.routes.ts:228-241`

**Description** : `totalEntries` inclut `openingCashFund`, et `totalOutputs` inclut
`closingCashFund` **uniquement si la journée a été clôturée** (la ligne `CLOSING_FUND` n'existe
qu'après clôture). Sur une journée ouverte, `difference = totalEntries − totalOutputs` inclut donc
l'ancien fonds sans contrepartie et ne représente ni un écart de caisse ni un solde.

**Repro (lecture seule)** :
```
GET /api/cash-register/days/2026-08-02
→ openingCashFund 25000, totalEntries 1279522, totalOutputs 508013.75,
  difference 771508.25
```
`difference` est en réalité « espèces théoriques en tiroir », pas un écart. Une journée sans
aucune activité mais avec un fonds de 25 000 affiche `difference = 25000`.

Cas plus visible en base :
```
GET /api/cash-register/days → journée 2026-08-05 : totalEntries "0", totalOutputs "2000",
   difference "-2000"
GET /api/cash-register/days/2026-08-05 → totaux recalculés : tout à "0"
```
→ les **totaux miroirs persistés divergent du recalcul à la volée** (voir aussi P2-2).

**Impact** : le libellé « écart » du bordereau induit en erreur ; un écart réel de caisse est
noyé dans le fonds de roulement.

**Suggestion** : renommer en `soldeTheorique` et exposer un vrai `ecart` séparé
(= comptage physique − solde théorique), ou exclure `openingCashFund` de `totalEntries`.

---

#### P2-2 — Totaux miroirs `CashRegisterDay` jamais réconciliés → valeurs fantômes
**Fichier** : `backend/src/routes/cash-register.routes.ts:264-288` et `:356-366`

**Description** : `GET /days` (liste) renvoie les colonnes **persistées**, alors que
`GET /days/:date` (détail) renvoie le **recalcul**. Rien ne resynchronise les miroirs si une
`CashRegisterEntry` est soft-deletée ou si une facture est annulée hors du flux caisse.

**Repro (lecture seule)** :
```
GET /api/cash-register/days           → 2026-08-05 : totalOutputs "2000", difference "-2000"
GET /api/cash-register/days/2026-08-05 → totaux.totalOutputs "0", difference "0"
```
Deux écrans de la même application affichent deux montants différents pour la même journée.

**Impact** : la liste des journées (écran de synthèse mensuel) affiche des sorties inexistantes.

**Suggestion** : faire dériver la liste du même `calculerTotauxJour` (ou déclencher
`recalculerEtPersister` sur lecture de liste), et ajouter un job/route de réconciliation.

---

#### P2-3 — Facture PARTIALLY_PAID : le total complet est traité comme « vente à crédit »
**Fichier** : `backend/src/routes/cash-register.routes.ts:151-162` et `:427-437`

**Description** : une facture `PARTIALLY_PAID` est ajoutée **intégralement** à
`creditInvoiceTotal` (ligne 155-157), donc entièrement déduite des entrées via `totalOutputs`,
alors qu'une partie a bien été encaissée en espèces le jour même. Le reliquat réel
(`unpaidPartialInvoiceTotal`) est calculé mais volontairement exclu de `totalOutputs` (`:233-235`)
et affiché comme ligne `deduction: true`.

Conséquence arithmétique : pour une facture de 10 000 dont 6 000 encaissés cash le jour même,
`invoiceTotal += 10000` (entrée) et `creditInvoiceTotal += 10000` (déduction) →
contribution nette **0**, alors que 6 000 DA sont physiquement dans le tiroir.

**Repro (lecture seule)** : aucune facture PARTIALLY_PAID en base de test actuellement
(`GET /api/invoices` → uniquement PAID et DRAFT), le bug est donc latent mais certain à la
lecture du code.

**Impact** : sous-évaluation du cash réel du jour à hauteur du montant partiellement encaissé ;
`encaissementReelVentes` (`:259`) vaut 0 pour ces factures.

**Suggestion** : `creditInvoiceTotal += (total − encaisse)` pour les `PARTIALLY_PAID` (le reste
dû), et supprimer la ligne virtuelle `UNPAID_PARTIAL` devenue redondante.

---

#### P2-4 — Journal d'audit caisse écrit mais jamais consultable
**Fichier** : `backend/src/routes/cash-register.routes.ts` (aucune route `GET /audit`),
modèle `CashRegisterAuditLog` (`prisma/schema.prisma:1267-1277`)

**Description** : les actions `creation`, `annulation`, `cloture`, `reouverture` sont écrites,
mais aucune route ne les expose. Le rôle « traçabilité comptable » du module est donc inopérant.

**Repro (lecture seule)** : `grep "cashRegisterAuditLog.findMany"` → 0 occurrence ;
aucun endpoint `GET` correspondant dans `index.ts`.

**Impact** : impossible de justifier une réouverture (cf. P1-2) ou une annulation de dépense lors
d'un contrôle.

**Suggestion** : ajouter `GET /api/cash-register/days/:date/audit` (et un filtre global paginé).

---

#### P2-5 — Clôture de bordereau : garde basée sur un `colisVendus` non fiable, pertes ignorées
**Fichier** : `backend/src/routes/supplier-bordereaux.routes.ts:433-435`

**Description** : la clôture exige `colisVendus >= colisRecus`. Or `colisVendus` est un compteur
incrémenté à la création de facture (`invoices.routes.ts:392`) et **jamais décrémenté** si une
facture est modifiée (PATCH recrée les lignes) ou soft-deletée. Par ailleurs les pertes (`Loss`)
sont soustraites de `colisRestant` (`:200-205`) mais **pas** prises en compte dans la garde de
clôture : un bordereau dont tout le stock restant est parti en perte ne peut jamais être clôturé.

**Repro (lecture seule)** :
```
GET /api/supplier-bordereaux/cmsbvhtca001dr66uoir86f27  (BF-096464)
→ colisRecus 10, colisVendus 10, colisRestant 0, totalPertesColis 0, statut "pret_a_cloturer"
```
Le cas nominal passe ; avec 8 vendus + 2 perdus, `colisVendus(8) < colisRecus(10)` → clôture
refusée à tort.

**Impact** : bordereaux bloqués en `ouvert`, donc non payables (`STATUTS_PAYABLES`), donc
fournisseur non réglé.

**Suggestion** : garde `colisVendus + totalPertesColis >= colisRecus`, et recalculer
`colisVendus` depuis les `InvoiceItem` plutôt que par incrément.

---

#### P2-6 — Le statut `PENDING` d'une avance la rend invisible au règlement `ENCAISSER`
**Fichier** : `backend/src/routes/supplier-payments.routes.ts:416-423` vs enum
`AdvanceStatus` (`prisma/schema.prisma:34-41`)

**Description** : le pool FIFO ne sélectionne que `status ∈ {DISPONIBLE, PARTIALLY_ALLOCATED}`.
L'enum contient aussi `PENDING`, et la base de test en contient une de 50 000 DA
avec `allocatedAmount=0` — donc parfaitement disponible mais invisible.

**Repro (lecture seule)** :
```
GET /api/supplier-advances
→ AV-2026-0001 : amount 50000, allocatedAmount 0, status "PENDING"
```
Un `POST /:id/pay` en mode ENCAISSER sur ce fournisseur répondrait
« Avance insuffisante : disponible 0.00 DA » malgré 50 000 DA réellement disponibles.

**Impact** : imputation d'avance impossible ; l'utilisateur croit l'avance perdue.

**Suggestion** : inclure `PENDING` dans le filtre, ou supprimer ce statut de l'enum et migrer les
lignes existantes vers `DISPONIBLE`.

---

### P3 — mineurs

#### P3-1 — Le mode `ENCAISSER` ne décrémente pas les avances côté bordereau (`avancesAffectees`)
**Fichier** : `backend/src/routes/supplier-payments.routes.ts:470-503`

**Description** : l'imputation FIFO crée bien des `SupplierAdvanceAllocation` avec `bordereauId`,
et met à jour `SupplierAdvance.allocatedAmount`, mais **ne met pas à jour**
`SupplierBordereau.avancesAffectees` — contrairement à `allocateAdvance()`
(`supplier-bordereaux.routes.ts:329-339`) qui, elle, le fait. Deux chemins d'allocation,
deux comportements.

**Impact** : le PDF bordereau et le détail affichent `avancesAffectees = 0` alors que des avances
ont été imputées ; le recalcul `montantFinalDu` du GET ne les déduit pas → dû surévalué.

**Suggestion** : factoriser l'allocation dans un helper unique appelé par les deux routes.

---

#### P3-2 — `nextRef` / `nextInvoiceReference` : scans complets + tri lexicographique, sujets aux races
**Fichier** : `cash-register.routes.ts:68-85`, `supplier-payments.routes.ts:39-68`,
`supplier-advances.routes.ts:108-120`, `invoices.routes.ts:110-123`

**Description** : quatre implémentations qui chargent **toutes** les références correspondantes en
mémoire (`findMany` sans `take`) pour un `max()` applicatif. `nextInvoiceReference` utilise en plus
`ORDER BY "reference" DESC LIMIT 1`, un tri **lexicographique** : au passage de `F-2026-0009` à
`F-2026-0010` ça reste correct sur 4 chiffres, mais `F-2026-10000` casserait la séquence. Aucune
de ces fonctions n'est protégée contre deux requêtes concurrentes (pas de `SELECT … FOR UPDATE`,
pas de séquence Postgres).

**Impact** : dégradation linéaire des performances ; `P2002` sporadiques en usage multi-poste.

**Suggestion** : séquences Postgres dédiées, ou une table `Counter` verrouillée, avec retry.

---

#### P3-3 — Aucune route de consultation des mouvements de stock
**Fichier** : `backend/src/routes/stock.routes.ts` (routes : `GET /`, `GET /fifo`, `POST /loss`)

**Description** : le modèle `StockMovement` est écrit par les réceptions, ventes et factures, mais
n'est exposé par aucun endpoint. Impossible d'auditer les entrées/sorties, ce qui masque P1-6.

**Repro (lecture seule)** : `GET /api/stock/movements` → `{"error":"Route introuvable"}`.

**Impact** : pas de traçabilité stock côté utilisateur ni côté support.

**Suggestion** : ajouter `GET /api/stock/movements` (filtres `lotId`, `productId`, `type`, dates,
pagination).

---

#### P3-4 — Nom du fournisseur non filtré sur le soft-delete dans le drill-down caisse
**Fichier** : `backend/src/routes/cash-register.routes.ts:441-452`

**Description** : la requête d'affichage (`prisma.supplierPayment.findMany`) omet
`deletedAt: null`, contrairement à la route de drill-down `:689-692` qui, elle, le filtre. Le même
écran peut donc afficher un fournisseur dans la ligne virtuelle et « — » dans la liste détaillée.

**Impact** : incohérence d'affichage mineure entre synthèse et détail.

**Suggestion** : uniformiser en ajoutant `deletedAt: null`.

---

#### P3-5 — Bug de fuseau : `jour()` en UTC côté caisse, en heure locale côté paiements fournisseurs
**Fichier** : `cash-register.routes.ts:31-34` (`Date.UTC`) vs
`supplier-payments.routes.ts:32-36` (`d.setHours(0,0,0,0)`)

**Description** : deux normalisations de date différentes pour la même notion de « journée ». Sur
un serveur en UTC+1 (Algérie), `jour('2026-08-02')` vaut `2026-08-02T00:00:00Z` côté caisse et
`2026-08-01T23:00:00Z` côté paiement fournisseur.

**Impact** : `getOrCreateDay` peut créer une seconde `CashRegisterDay` pour la veille, et
l'écriture `SUPPLIER_PAYMENT` se rattache alors au mauvais jour. Non reproductible sur ce serveur
(TZ=UTC) mais certain en déploiement local.

**Suggestion** : exporter et réutiliser la fonction `jour()` de `cash-register.routes.ts` partout.

---

## (c) Points forts

- **Argent en `Decimal` partout** — aucun `float`/`parseFloat` sur des montants, dans le schéma
  Prisma (`Decimal(14,2)`) comme dans les calculs (`Prisma.Decimal`, `.toDecimalPlaces(2)`).
- **Transactions systématiques** : toutes les mutations multi-tables passent par
  `prisma.$transaction` (réception → lot → bordereau → mouvement → avance en un seul bloc).
- **Anti-doublon caisse solide** : `@@unique([sourceType, sourceId])` + helper
  `assertPasDeDoublon()` appelé avant chaque insertion — un design qui empêche structurellement
  la double comptabilisation d'une dépense/appro/remise.
- **Séparation lecture-seule des modules métier en caisse** : les factures et paiements ne sont
  jamais dupliqués en `CashRegisterEntry`, ils sont agrégés à la volée. C'est le bon choix
  d'architecture, bien documenté en tête de fichier.
- **Soft-delete généralisé** (`deletedAt`) avec filtrage cohérent `deletedAt: null` dans la très
  grande majorité des requêtes, et annulations par écriture inverse plutôt que par suppression
  (`PATCH /expenses/:id/cancel`).
- **Gardes métier explicites et bien nommées** : surpaiement fournisseur interdit, encaissement
  client > restant dû refusé, facture PAID verrouillée en édition, facture supprimable seulement
  en DRAFT, avance non affectable si CANCELLED/REFUNDED.
- **Idempotence de la création de facture depuis une vente** (`invoices.routes.ts:245-256`) :
  évite les doublons sur double-clic, un vrai réflexe terrain.
- **Préservation défensive du `lotId`** lors du remplacement des lignes de facture
  (`invoices.routes.ts:593-639`), avec plusieurs niveaux de repli — visiblement issu d'un
  incident réel et bien commenté.
- **Validation Zod sur toutes les entrées**, avec `safeParse` et retour `400` structuré ; le
  helper `montantValide()` évite explicitement qu'un `new Decimal()` lève dans un `refine`.
- **Commentaires métier de grande qualité** en tête de chaque route : les règles (crédit,
  commission, FIFO, modes PAY/ENCAISSER) sont documentées à l'endroit où elles s'appliquent,
  ce qui a rendu cet audit possible sans accès à la spécification.

---

*Fin du rapport — 20 problèmes (3 P0, 6 P1, 6 P2, 5 P3).*
