# AUDIT QA / chasse aux bugs — Fruiterie ERP

Date : 2026-08-04 · Mode : **lecture seule** (read_file / search_files + `curl GET` sur `http://localhost:8080`)
Périmètre : backend `/home/mimo/fruiterie-app/backend/src/routes/*.ts` + données de test en base.
Exclu du rapport (déjà corrigés) : 1 réception = 1 bordereau, ventes comptant non comptées en crédit caisse, paiement fournisseur séparé des dépenses.

---

## (a) Résumé exécutif

L'architecture « caisse calculée à la volée, jamais dupliquée » est saine et les garde-fous récents (anti-doublon `sourceType/sourceId`, dû figé sur les lignes de BP, verrou facture PAID) fonctionnent. L'audit met néanmoins en évidence **12 problèmes réels**, dont **2 P0** :

1. **Le module caisse ignore le soft-delete des journées** : la journée `2026-08-02` porte `deletedAt = 2026-08-01T16:34:43Z` et reste malgré tout servie par `GET /days/:date` (avec toutes ses lignes), tout en étant **absente** de `GET /days`. Deux vérités contradictoires pour la même date.
2. **Le montant réglé d'un bon de paiement n'est pas conservé de façon fiable** : `BP-2026-0017` est `paye` alors que `montantPaye = 0` sur sa ligne, et le bordereau `BF-096461` associé reste à `montantFinalDu = 10192` tout en étant marqué `paye`.

À cela s'ajoutent des incohérences de cohérence comptable observables directement en API (`totalEntries`/`totalOutputs`/`difference` persistés ≠ recalculés ; `difference` structurellement non nulle), la génération de références séquentielles non concurrente (`max+1` hors verrou) et plusieurs endpoints d'écriture sans contrôle de permission.

Chiffres marquants relevés en base :
- `GET /cash-register/days/2026-08-02` → recalculé `totalEntries = 1 279 522`, persisté `1 124 650` ; `difference = 771 508.25` (persisté `616 636.25`).
- `F-2026-0030` : `total = 1`, `paidAmount = 200`, `remaining = -199`, statut `PAID`.
- `BF-096461` : `statut = paye`, `montantFinalDu = 10192`, `montantFinalDefinitif = 11200`.
- Avance `AV-2026-0001` en statut `PENDING`, absent de toute logique de transition métier.

---

## (b) Problèmes classés

### P0

---

#### P0-1 — Journée de caisse soft-deletée toujours servie par le détail et le PDF
**Fichier** : `backend/src/routes/cash-register.routes.ts:57`, `:185`, `:379`, `:722`, `:1191`

**Description** — Tous les accès à `cashRegisterDay` par date utilisent `findUnique({ where: { date } })` **sans filtrer `deletedAt: null`** (lignes 57, 185, 379, 722, 1191), alors que la liste `GET /days` filtre bien `deletedAt: null` (ligne 359). Une journée soft-deletée est donc invisible dans la liste mais parfaitement lisible, calculable, imprimable en PDF — et `getOrCreateDay` la « ressuscite » silencieusement pour toute nouvelle saisie au lieu d'en créer une neuve.

**Repro (lecture seule)**
```
GET /api/cash-register/days                 -> 1 seul jour : 2026-08-05
GET /api/cash-register/days/2026-08-02      -> day.deletedAt = "2026-08-01T16:34:43.204Z"
                                               10 sorties + 2 entrées, totaux complets
```

**Impact** — Une journée « supprimée » continue d'être comptabilisée, imprimée et modifiée. La suppression logique n'a aucun effet métier : perte de confiance sur toute donnée de caisse.

**Suggestion** — Ajouter `deletedAt: null` à toutes les lectures (`findFirst` au lieu de `findUnique`), et dans `getOrCreateDay` traiter une journée soft-deletée comme inexistante (créer une nouvelle ligne ou refuser explicitement).

---

#### P0-2 — Bon de paiement `paye` avec `montantPaye = 0` et bordereau `paye` avec un dû résiduel
**Fichier** : `backend/src/routes/supplier-payments.routes.ts:446-452`, `:514-523`, `:582-591`

**Description** — Le statut du BP est recalculé à partir du **statut des bordereaux** (`resteAPayer = bordereaux dont statut !== 'paye'`, ligne 586) et non à partir des montants réellement réglés. Deux conséquences :
- la mise à jour de `montantPaye` (ligne 517) est conditionnée par `if (ligneBP)` — si le `findFirst` échoue, le cumul est perdu **sans erreur** ;
- le bordereau est passé à `paye` dès que `resteFinal <= 0` (ligne 450) alors qu'un `montantFinalDu` résiduel peut subsister s'il a été recalculé entre-temps.

**Repro (lecture seule)**
```
GET /api/supplier-payments/<id BP-2026-0017>
  -> status "paye", lines[0] = { bordereauRef BF-096461, montant 11200, montantPaye "0" }
GET /api/supplier-bordereaux/<id BF-096461>
  -> statut "paye", montantFinalDu "10192", montantFinalDefinitif "11200"
```
Idem `BP-2026-0014/0015/0016` : tous `paye`, tous `montantPaye = 0`.

**Impact** — Impossible de reconstituer combien a réellement été versé à un fournisseur. Le PDF du bon et la balance fournisseur reposent sur une donnée fausse. Risque de double paiement ou de litige fournisseur.

**Suggestion** — Dériver le statut du BP de `Σ montantPaye vs totalAmount`, rendre `montantPaye` obligatoire (upsert plutôt que `if (ligneBP)`), et refuser le passage à `paye` d'un bordereau dont `montantFinalDu > 0`.

---

### P1

---

#### P1-1 — Totaux persistés de la journée divergent des totaux recalculés
**Fichier** : `backend/src/routes/cash-register.routes.ts:264-288` vs `:372-491`

**Description** — `recalculerEtPersister` n'est appelé que lors des saisies manuelles (dépense, appro, remise, clôture). Toute mutation côté facture / paiement client (création, encaissement, changement de statut) **ne déclenche aucun recalcul**. Les colonnes miroir de `CashRegisterDay` dérivent donc en permanence. Par ailleurs `supplierPaymentTotal` n'est délibérément pas persisté (ligne 280) mais **est** inclus dans `totalOutputs` persisté (ligne 283) : la colonne devient non reconstructible depuis les autres colonnes.

**Repro (lecture seule)**
```
GET /api/cash-register/days/2026-08-02
  day.totalEntries    = 1124650   |  totaux.totalEntries    = 1279522
  day.invoiceTotal    = 549825    |  totaux.invoiceTotal    = 1254522
  day.difference      = 616636.25 |  totaux.difference      = 771508.25
GET /api/cash-register/days        -> 2026-08-05 : totalEntries 0, totalOutputs 2000
                                      alors que le détail renvoie 0 sorties
```

**Impact** — La liste des journées (`GET /days`, qui lit les colonnes) et le détail (recalculé) affichent des montants différents pour le même jour. Les instantanés `CashRegisterClosing` héritent de ces valeurs.

**Suggestion** — Soit ne plus persister aucun total (source de vérité unique = recalcul + `GET /days` recalculé à la volée), soit recalculer sur tout événement facture/paiement.

---

#### P1-2 — Journée `2026-08-05` : `totalOutputs = 2000` sans aucune ligne de sortie
**Fichier** : `backend/src/routes/cash-register.routes.ts:270-286`

**Description** — Résidu direct de P1-1 : une sortie a été persistée puis sa ligne supprimée/soft-deletée sans recalcul. La colonne reste figée.

**Repro**
```
GET /api/cash-register/days/2026-08-05
  day.totalOutputs = "2000", day.difference = "-2000"
  outputs = [], entries = []   (totaux recalculés : tout à 0)
```

**Impact** — Journée du jour affichée en écart de caisse de −2 000 DA fantôme dans la liste.

**Suggestion** — Recalcul systématique + script de réconciliation ponctuel.

---

#### P1-3 — `difference` n'est pas un écart de caisse mais un solde structurellement non nul
**Fichier** : `backend/src/routes/cash-register.routes.ts:228-241`, `:258`

**Description** — `totalEntries` agrège **la totalité du chiffre d'affaires facturé** (`invoiceTotal`), y compris les ventes non encaissées, tandis que `totalOutputs` ne déduit que `creditInvoiceTotal`. Tant que le fonds de clôture n'est pas saisi, `difference = encaissements + fonds d'ouverture`, soit un très gros nombre positif présenté comme « différence ».

**Repro**
```
GET /api/cash-register/days/2026-08-02 -> difference = 771508.25
```

**Impact** — Le champ le plus regardé du bordereau de caisse (et du PDF, ligne 745) est illisible : un caissier ne peut pas savoir s'il manque de l'argent. Un vrai manquant de 5 000 DA est noyé.

**Suggestion** — Renommer/scinder : `soldeTheoriqueEspeces` (fonds + encaissements réels − sorties réelles) et `ecartCaisse` (théorique − fonds de clôture compté). Ne comparer que des flux d'espèces.

---

#### P1-4 — Un règlement fournisseur CASH rouvre automatiquement une journée clôturée
**Fichier** : `backend/src/routes/supplier-payments.routes.ts:529-549`

**Description** — Toutes les saisies de caisse refusent une journée `cloturee` avec un 409 (`cash-register.routes.ts:798`, `:949`, `:1034`, `:1124`). Le paiement fournisseur, lui, **remet la journée à `ouverte`** (`closedBy: null`, `closedAt: null`) sans demander confirmation, et l'échec de l'audit est avalé par un `catch {}` (ligne 546).

**Repro (lecture seule)** — `supplier-payments.routes.ts:529-533` ; comparer avec `cash-register.routes.ts:798-802`.

**Impact** — La clôture n'est pas un verrou. L'instantané `CashRegisterClosing` de la journée devient obsolète (il n'est jamais mis à jour), et si l'audit échoue la réouverture est invisible.

**Suggestion** — Refuser (409) et exiger une réouverture explicite tracée, ou au minimum invalider/versionner le `CashRegisterClosing` correspondant. Ne jamais avaler l'écriture d'audit.

---

#### P1-5 — Modifier une facture après encaissement produit un `remaining` négatif
**Fichier** : `backend/src/routes/invoices.routes.ts:585-587`, `:654-663` ; `payments.routes.ts:65-79`

**Description** — Le verrou ne porte que sur `status === 'PAID'`. Une facture `PARTIALLY_PAID` peut voir son total **diminué** en dessous du montant déjà encaissé ; `reconcileInvoice` n'est pas rappelé après un `PATCH` de facture, donc le statut ne redevient pas cohérent et aucun avoir n'est généré.

**Repro (lecture seule)**
```
GET /api/invoices?take=100 -> F-2026-0030 : total 1, paidAmount 200, remaining -199, status PAID
```

**Impact** — Restant dû négatif, trop-perçu invisible, `creditInvoiceTotal` de la caisse faussé.

**Suggestion** — Interdire un total inférieur au déjà encaissé (400), appeler `reconcileInvoice` en fin de `PATCH`, et matérialiser tout excédent en avoir client.

---

#### P1-6 — Génération de références séquentielles non atomique (collisions sous concurrence)
**Fichier** : `cash-register.routes.ts:68-85` · `supplier-payments.routes.ts:39-52`, `:55-68` · `supplier-advances.routes.ts:106-120` · `supplier-receptions.routes.ts:155-163` · `invoices.routes.ts:110-123` · `sales.routes.ts:165-178` · `products.routes.ts:66-79`

**Description** — Sept implémentations distinctes du même pattern « lire toutes les références → `max+1` », toutes **hors verrou** (pas de séquence Postgres, pas de `SELECT ... FOR UPDATE`, pas de retry sur `P2002`). Deux créations simultanées calculent le même numéro. Variante aggravante dans `invoices`/`sales`/`products` : le tri `ORDER BY reference DESC LIMIT 1` est **lexicographique** — dès qu'on dépasse 9999 (`F-2026-10000`), `F-2026-9999` reste le maximum et la référence suivante est un doublon garanti.

**Repro (lecture seule)** — Lire `invoices.routes.ts:113-116` : `ORDER BY "reference" DESC LIMIT 1` sur une chaîne. `9999 > 10000` en tri texte.

**Impact** — Erreur 500 opaque sur contrainte unique en pic d'activité ; blocage total de la facturation après 9 999 pièces annuelles.

**Suggestion** — Factoriser dans un helper unique s'appuyant sur une séquence Postgres (ou une table de compteurs verrouillée), avec retry sur `P2002`.

---

#### P1-7 — Endpoints bordereaux et caisse sans contrôle de permission
**Fichier** : `supplier-bordereaux.routes.ts:27-28`, `:231`, `:347`, `:384`, `:428`, `:477` · `cash-register.routes.ts:22`, `:786`, `:1103` · `supplier-payments.routes.ts` (tous)

**Description** — Ces routeurs ne posent que `router.use(requireAuth)`. Aucun `requirePermission(...)`, contrairement à `payments.routes.ts`, `invoices.routes.ts` et `supplier-advances.routes.ts` qui protègent chaque mutation. Un simple utilisateur authentifié (rôle CAISSIER ou VENDEUR) peut donc clôturer un bordereau, le corriger, affecter des avances, clôturer la caisse et créer des bons de paiement.

**Repro (lecture seule)** — `search_files "requirePermission" backend/src/routes/supplier-bordereaux.routes.ts` → 0 occurrence ; idem `cash-register.routes.ts`, `supplier-payments.routes.ts`.

**Impact** — Escalade fonctionnelle : les opérations financières les plus sensibles (clôture, correction, règlement) sont ouvertes à tout compte.

**Suggestion** — Ajouter `requirePermission('CASH_WRITE' | 'PURCHASE_WRITE' | 'BORDEREAU_CLOSE')` sur chaque mutation, en s'alignant sur le modèle de `payments.routes.ts`.

---

### P2

---

#### P2-1 — Bordereau clôturé : la porte de derrière `/correct` est sans limite
**Fichier** : `supplier-bordereaux.routes.ts:477-537` (notamment `:485`, `:521-525`)

**Description** — `PATCH /:id` refuse correctement un bordereau `cloture` (ligne 240) — bon réflexe. Mais `PATCH /:id/correct` ne vérifie **aucun statut** : il accepte un bordereau `ouvert`, `paye` ou `annule` aussi bien que `cloture`, et réécrit `commissionDefinitive` / `avancesDefinitives` / `montantFinalDefinitif` (lignes 521-525). Pire, il permet de fixer `avancesAffectees` à une valeur arbitraire **sans toucher aux `SupplierAdvanceAllocation`** correspondantes.

**Repro (lecture seule)** — Comparer `supplier-bordereaux.routes.ts:240-242` (blocage) avec `:485-489` (aucun blocage).

**Impact** — Les montants « définitifs » d'un bordereau clôturé, voire déjà payé, sont modifiables ; désynchronisation garantie entre `avancesAffectees` et la somme des allocations.

**Suggestion** — Restreindre `/correct` au statut `cloture` (et refuser `paye`), recalculer `avancesAffectees` depuis les allocations plutôt que l'accepter en entrée, et exiger une permission dédiée.

---

#### P2-2 — `avancesAffectees` du bordereau : compteur dénormalisé sans réconciliation
**Fichier** : `supplier-bordereaux.routes.ts:329`, `:405`, `:517` ; `supplier-payments.routes.ts:472-500`

**Description** — `avancesAffectees` est incrémenté/décrémenté à la main lors des allocations, mais **jamais recalculé** depuis `SupplierAdvanceAllocation`. Il existe au moins trois chemins d'écriture (allocation bordereau, désallocation, `/correct`) plus la consommation d'avances du mode `ENCAISSER` dans `supplier-payments`, qui met à jour `SupplierAdvance.allocatedAmount` **sans** répercuter sur `avancesAffectees` du bordereau réglé.

**Repro (lecture seule)** — `supplier-payments.routes.ts:472-500` : boucle sur le pool d'avances, écrit `allocatedAmount`/`status` de l'avance, aucune écriture sur `supplierBordereau.avancesAffectees`.

**Impact** — `montantFinalDu` calculé à partir d'un montant d'avances faux ; l'avance est consommée deux fois du point de vue du fournisseur.

**Suggestion** — Une seule fonction `recalcAvancesAffectees(bordereauId)` = `Σ allocations non supprimées`, appelée sur tous les chemins.

---

#### P2-3 — Statut d'avance `PENDING` orphelin
**Fichier** : `prisma/schema.prisma:34-41` ; `supplier-advances.routes.ts:284-295`, `:489-495`

**Description** — L'enum `AdvanceStatus` contient `PENDING`, mais aucune route ne le produit ni ne le gère : `advanceStatusFor` (bordereaux) ne renvoie que 3 valeurs, `ADVANCE_STATUS_FR` et `FR_TO_ENUM` l'ignorent, et la sélection des avances allouables filtre sur `['DISPONIBLE','PARTIALLY_ALLOCATED']` (`supplier-payments.routes.ts:420`).

**Repro (lecture seule)**
```
GET /api/supplier-advances -> AV-2026-0001 : status "PENDING", amount 50000, allocated 0
```
Cette avance de 50 000 DA est donc **invisible** pour tout règlement en mode `ENCAISSER` et s'affiche sans libellé FR.

**Impact** — Trésorerie fournisseur bloquée sans message d'erreur explicite ; libellé brut affiché à l'utilisateur.

**Suggestion** — Soit supprimer `PENDING` de l'enum, soit le documenter et l'intégrer aux filtres et aux mappings FR.

---

#### P2-4 — `getSalesLinesForBordereau` inclut les factures `DRAFT` et `CANCELLED`
**Fichier** : `supplier-bordereaux.routes.ts:58-66`

**Description** — La requête filtre `lotId` + `deletedAt: null` sur `InvoiceItem` mais **jamais le statut de la facture parente**. Une facture brouillon ou annulée gonfle donc `totalBrutVentes`, la commission et le `montantFinalDu` du fournisseur — alors que le module caisse, lui, exclut explicitement `DRAFT` et `CANCELLED` (`cash-register.routes.ts:28`).

**Repro (lecture seule)** — `F-2026-0032` est en `DRAFT` avec un total de 200 DA ; ses lignes restent éligibles au calcul de bordereau. Comparer `supplier-bordereaux.routes.ts:59` (aucun filtre statut) et `cash-register.routes.ts:124`.

**Impact** — Le fournisseur est crédité de ventes qui n'existent pas. Écart direct entre le chiffre d'affaires caisse et le total brut des bordereaux.

**Suggestion** — Ajouter `invoice: { status: { notIn: ['DRAFT','CANCELLED'] }, deletedAt: null }` au `where`.

---

### P3

---

#### P3-1 — Deux définitions de « jour » incompatibles (UTC vs heure locale)
**Fichier** : `cash-register.routes.ts:31-34` (UTC strict) vs `supplier-payments.routes.ts:32-36` (`setHours(0,0,0,0)` local)

**Description** — Le module caisse normalise les dates en UTC ; le module paiement fournisseur utilise le fuseau local du process. Le serveur tourne actuellement en UTC (`TZ` non défini), ce qui masque le bug — dès un déploiement en `Africa/Algiers` (UTC+1), un règlement fournisseur enregistré avant 01:00 sera rattaché à la journée de caisse de la veille.

**Repro (lecture seule)** — `node -e "console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)"` → `UTC` ; comparer les deux fonctions `jour()`.

**Impact** — Bombe à retardement : décalage d'une journée sur les règlements en début de matinée après changement de fuseau.

**Suggestion** — Un seul helper `jour()` exporté et importé partout, et fixer `TZ` explicitement au démarrage.

---

#### P3-2 — Le PDF de caisse regroupe les règlements fournisseurs dans « LES DEPENSES »
**Fichier** : `cash-register.routes.ts:739`

**Description** — Choix assumé et commenté, mais il crée un troisième affichage du même chiffre : l'UI sépare `expenseTotal` et `supplierPaymentTotal`, le PDF les additionne. Un rapprochement entre l'écran et le papier est impossible sans connaître la règle.

**Repro (lecture seule)** — Sur `2026-08-02` : `expenseTotal = 0`, `supplierPaymentTotal = 508 013.75` → le PDF imprime `508 013.75` en « dépenses ».

**Impact** — Confusion documentaire ; risque de double saisie comptable.

**Suggestion** — Afficher deux lignes distinctes dans le PDF (« Frais d'exploitation » / « Règlements fournisseurs ») avec un sous-total.

---

## (c) Points forts

- **Séparation lecture/écriture de la caisse** : les factures et paiements ne sont jamais dupliqués en `CashRegisterEntry`, ils sont agrégés à la volée. Le principe est explicitement documenté en tête de fichier (`cash-register.routes.ts:1-12`) et respecté.
- **Anti-doublon strict** via `@@unique([sourceType, sourceId])` et le helper `assertPasDeDoublon` (`:338-351`), systématiquement appelé avant chaque insertion de ligne.
- **Arithmétique 100 % `Prisma.Decimal`** : aucune opération en float sur les montants, `toDecimalPlaces(2)` appliqué aux résultats. Aucune erreur d'arrondi détectée sur les 7 bordereaux et 15 factures inspectés.
- **Annulation par écriture inverse** plutôt que suppression : une dépense annulée crée une entrée compensatoire et passe `status='annulee'` (`:873-920`), ce qui préserve la piste d'audit.
- **Dû figé sur les lignes de bon de paiement** (`montantDuAvant`, `supplier-payments.routes.ts:272`) — la bonne intention comptable est là, il ne manque que la fiabilisation de `montantPaye` (cf. P0-2).
- **Verrous métier explicites et bien nommés** : facture `PAID` non modifiable, surpaiement fournisseur interdit, encaissement supérieur au restant dû refusé, avance d'un autre fournisseur rejetée.
- **Cohérence agrégat/drill-down** : `GET /days/:date/credit-sales` réplique exactement le prédicat de `creditInvoiceTotal` (`:640-642`), avec un commentaire expliquant pourquoi — bonne pratique à généraliser.
- **Traçabilité** : `CashRegisterAuditLog`, `SupplierBordereauCorrection` (motif obligatoire) et `auditLog()` couvrent les opérations sensibles.
- **Commentaires de régression** : les bugs corrigés sont documentés en clair à l'endroit du code concerné, ce qui empêche efficacement les régressions.

---

*Audit strictement en lecture seule : aucun fichier du projet modifié, aucune requête POST/PUT/PATCH/DELETE émise, aucun serveur démarré. Seul ce fichier a été créé.*
