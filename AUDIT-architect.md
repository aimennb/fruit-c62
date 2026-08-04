# AUDIT ARCHITECTURE & QUALITÉ — BACKEND Fruiterie ERP

_Audit en lecture seule — aucun fichier de code modifié._
Périmètre : `backend/src` (~11 750 lignes TS, 44 fichiers), Node 22 + Express 4 + Prisma 5 + Zod.

## (a) Résumé exécutif

Le backend est **fonctionnel et globalement discipliné** sur les points qui comptent le plus en gestion commerciale : l'argent est manipulé en `Prisma.Decimal` partout (jamais de float), les mutations métier sont enveloppées dans `prisma.$transaction`, le soft-delete (`deletedAt: null`) est systématiquement filtré, et les invariants critiques (surpaiement interdit, stock jamais négatif, anti-doublon caisse via `@@unique(sourceType, sourceId)`) sont explicitement codés et commentés.

En revanche, l'architecture est **« tout-en-routes »** : il n'existe pas de couche service. Les 5 gros fichiers de routes (`cash-register` 1234 l., `supplier-receptions` 823 l., `invoices` 755 l., `supplier-payments` 729 l., `sales` 688 l.) concentrent validation HTTP, règles métier, accès Prisma et sérialisation. Le dossier `src/services/` ne contient qu'un seul fichier (`bulletinPdf.ts`), et les rares helpers extraits (`bordereaux/lots.ts`, `caisse/pdf.ts`, `money.ts`) sont sous-utilisés — `money.ts` n'est **importé nulle part**, alors que 9 fichiers redéfinissent chacun leur `const D = ...`.

Conséquence concrète : la **formule du montant final dû fournisseur est écrite 3 fois** dans 3 fichiers différents, la **génération de références séquentielles est réimplémentée 7 fois** avec 3 algorithmes différents (dont deux sujets à collision en concurrence), et le **contrôle d'accès est absent** de trois modules financiers (`cash-register`, `supplier-payments`, `supplier-bordereaux`) qui n'exigent que `requireAuth`. Aucun test automatisé n'existe dans le backend, ce qui rend chaque refactor risqué.

Priorités recommandées : (1) sécuriser les permissions des modules caisse/paiements, (2) fiabiliser la numérotation des documents, (3) extraire un service `bordereauCalc` pour la formule du dû, (4) mutualiser un `asyncHandler` + helpers date/argent.

---

## (b) Problèmes trouvés

### P0 — Critique (perte / corruption de données ou d'argent)

#### P0-1 — Modules financiers sans contrôle de permission (`cash-register`, `supplier-payments`, `supplier-bordereaux`)
**Fichiers :** `src/routes/cash-register.routes.ts:22`, `src/routes/supplier-payments.routes.ts:23`, `src/routes/supplier-bordereaux.routes.ts:28`

Ces trois routeurs ne déclarent que `router.use(requireAuth)` — `grep -c requirePermission` renvoie **0** pour chacun, alors que `customers` (9), `sales` (9), `bulletins` (10), `invoices` (8) sont protégés route par route.

Concrètement, **tout utilisateur authentifié**, y compris un compte `employe` ou `receptionnaire`, peut :
- clôturer une journée de caisse et fixer le fonds reporté (`PATCH /days/:date/close`, l. 1103) ;
- créer/annuler des dépenses et des remises d'espèces (l. 786, 873, 1022) ;
- régler un bon de paiement fournisseur, ce qui décrémente `supplier.balance` et sort du cash (l. 328) ;
- **rouvrir une journée déjà clôturée** (`supplier-payments.routes.ts:529-533`).

**Impact métier :** détournement de caisse possible sans traçabilité de rôle ; les états de clôture ne sont plus opposables. C'est le trou le plus grave du backend.
**Correction :** ajouter `requirePermission('CASH_WRITE')` / `CASH_CLOSE` / `SUPPLIER_PAYMENT_WRITE` sur chaque route mutante, et `*_READ` sur les GET, en créant les `Permission` correspondantes en base (le mécanisme `getUserPermissions` existe déjà et fonctionne).

#### P0-2 — Numérotation des documents sujette aux collisions et non atomique
**Fichiers :** `src/routes/supplier-receptions.routes.ts:155-163`, `src/routes/sales.routes.ts:165-178`, `src/routes/invoices.routes.ts:113-122`, `src/routes/payments.routes.ts:46-59`, `src/routes/cash-register.routes.ts:68-85`, `src/routes/supplier-payments.routes.ts:39-68`, `src/routes/supplier-advances.routes.ts:120`

Sept implémentations distinctes de « prochain numéro », avec trois algorithmes incompatibles :

1. **Charger toutes les lignes puis `Math.max` en JS** (`supplier-receptions:156` : `findMany({ select: { reference: true } })` **sans `where`** — la table entière). Deux réceptions créées simultanément lisent le même max et produisent la même référence → violation de contrainte unique, transaction annulée, réception perdue côté utilisateur.
2. **Tri lexicographique SQL** (`sales:168-171`, `invoices:113`) : `ORDER BY "reference" DESC LIMIT 1`. Fonctionne tant que le padding reste sur 4 chiffres, casse au passage à `V-2026-10000`.
3. **Regex sur préfixe filtré** (`cash-register:75`, `supplier-payments:42`) — la moins mauvaise, mais toujours read-then-write non atomique.

Aucune n'utilise de séquence Postgres ni de verrou.
**Impact métier :** doublons ou trous de numérotation sur des pièces comptables (BR, BF, V, FAC, ENC, BP) — problème d'opposabilité fiscale, et échecs de saisie en heure de pointe (marché de gros = pics de saisie concurrente).
**Correction :** un seul helper `src/services/references.ts` s'appuyant sur une séquence Postgres (`CREATE SEQUENCE`) ou une table `DocumentCounter` mise à jour par `UPDATE ... RETURNING` dans la transaction. Supprimer les 7 variantes.

#### P0-3 — Formule du « montant final dû » fournisseur dupliquée en 3 exemplaires divergents
**Fichiers :** `src/routes/supplier-bordereaux.routes.ts:253` (PATCH), `src/routes/supplier-bordereaux.routes.ts:333` (`allocateAdvance`), `src/routes/supplier-receptions.routes.ts:655-665` (PATCH réception)

Trois copies de :
```
montantFinalDu = totalBrutVentes − commission − avancesAffectees − droitMarche − transport
```
avec, à chaque fois, un **recalcul de commission réécrit à la main** : `computeCommission()` est appelé aux l. 249 et 331 de `supplier-bordereaux`, mais `supplier-receptions:655` réinvente la même logique inline (`cType === 'fixe' ? cVal : totalBrut.times(cVal).dividedBy(100)`). De même le calcul de `totalBrut` est fait via `getSalesLinesForBordereau()` dans un fichier et par une réduction manuelle sur `invoiceItem` dans l'autre (`supplier-receptions:645-653`).

**Impact métier :** toute évolution des règles de commission (ex. commission par calibre, plancher, TVA) devra être appliquée à 3 endroits. Un oubli produit un **montant dû faux** — donc un paiement fournisseur faux, non détecté car aucun test ne couvre ces chemins.
**Correction :** extraire `src/services/bordereauCalc.ts` exposant `recomputeBordereau(tx, bordereauId)` (totalBrut + commission + pertes + dû + statut) et l'appeler depuis les 3 sites.

---

### P1 — Majeur

#### P1-1 — Deux gestionnaires d'erreur globaux, dont un mort, et un 404 inatteignable
**Fichier :** `src/index.ts:111-126` et `src/index.ts:148-157`

L'ordre de montage est cassé :
- l. 111 : le catch-all SPA `app.get(/^(?!\/api|\/test).*/)` est enregistré **avant** le 404 API — correct — mais…
- l. 118 : `app.use('/api', ...)` 404 est monté **après** tous les routeurs, OK ;
- l. 123 : premier error handler qui renvoie systématiquement `500 { error: 'Erreur serveur interne' }` en écrasant tout ;
- l. 148 : **second** error handler, bien plus riche (mappe `P2025`/`P2003` en 400, propage `err.status`, `err.meta.cause`) — mais Express n'appelle jamais le second puisque le premier a déjà répondu.

Le handler utile est donc **du code mort**.
**Impact métier :** toute erreur non catchée dans une route (il en reste : `stock-lots.routes.ts` et `stub.routes.ts` ont 0 `catch`, `supplier-receptions` n'en a que 3 pour 823 lignes) remonte en 500 opaque, sans code ni détail — le frontend affiche « Erreur serveur interne » et l'utilisateur ne sait pas si c'est une contrainte métier (400) ou une panne.
**Correction :** supprimer le handler l. 123-126 et ne garder que celui de la l. 148, déplacé avant le `export default`.

#### P1-2 — `uncaughtException` / `unhandledRejection` avalés silencieusement
**Fichier :** `src/index.ts:160-165`

```ts
process.on('uncaughtException', (e) => { console.error(...); });  // process continue
```
Le commentaire assume le choix (« on ne meurt JAMAIS »), mais après une `uncaughtException` l'état du process est indéterminé : une transaction Prisma peut être laissée ouverte, un pool de connexions corrompu, un verrou non relâché.

**Impact métier :** un serveur « vivant mais cassé » est pire qu'un crash — le healthcheck `/api/health` (l. 44) répondra `ok` alors que les écritures échouent. Sur un ERP de caisse, cela produit des journées de caisse partiellement écrites.
**Correction :** logger, puis `process.exit(1)` avec un superviseur (systemd `Restart=always`, pm2, Docker `restart: unless-stopped`). Garder l'interception uniquement pour `unhandledRejection` en mode dégradé.

#### P1-3 — Aucune couche service : la logique métier vit dans les handlers HTTP
**Fichiers :** `src/routes/cash-register.routes.ts` (1234 l.), `supplier-receptions.routes.ts` (823 l.), `invoices.routes.ts` (755 l.), `supplier-payments.routes.ts` (729 l.), `sales.routes.ts` (688 l.)

`src/services/` ne contient qu'un fichier (`bulletinPdf.ts`, 71 l.). Exemples de fonctions métier pures enfermées dans un routeur :
- `calculerTotauxJour()` — `cash-register.routes.ts:113-261`, ~150 lignes, cœur comptable de la caisse, exportée depuis un fichier de routes ;
- `getOrCreateDay()`, `recalculerEtPersister()`, `assertPasDeDoublon()` (l. 55, 264, 338) — importées **par un autre routeur** (`supplier-payments.routes.ts:19`), créant une dépendance routeur→routeur ;
- `resolveFifoLot()` + la boucle FIFO complète de `POST /:id/confirm` (`sales.routes.ts:494-666`, **172 lignes dans un seul handler**) ;
- le `POST /` de `supplier-receptions` (l. 115-333) fait 8 choses : validation, normalisation mono/multi-calibre, 2 numérotations, création réception, N lots, N mouvements, bordereau, avance, écriture compte fournisseur.

**Impact métier :** impossible de tester la comptabilité de caisse ou le FIFO sans monter Express + une base ; la réutilisation passe par des imports croisés entre routeurs, ce qui fabrique des cycles potentiels et rend le graphe de dépendances illisible.
**Correction :** déplacer sans changer le code vers `src/services/caisse.service.ts`, `src/services/stock-fifo.service.ts`, `src/services/reception.service.ts`. Les routes ne gardent que : parse Zod → appel service → sérialisation.

#### P1-4 — Deux routes `DELETE /api/sales/:id` déclarées, la seconde inatteignable
**Fichier :** `src/routes/sales.routes.ts:469` et `src/routes/sales.routes.ts:672`

Deux handlers pour le même verbe et le même chemin. Express prend le premier : celui de la l. 469, qui **refuse la suppression si la vente n'est pas `DRAFT`** et ne touche pas aux factures.

Le second (l. 672-686), qui soft-delete aussi les `Invoice` liées (`tx.invoice.updateMany`), n'est **jamais exécuté** — pourtant son commentaire d'en-tête (« Supprime aussi les factures liées (soft) pour retirer la ligne de la liste ») indique qu'il correspond à l'intention la plus récente.

**Impact métier :** supprimer une vente confirmée est impossible via l'API alors que le code destiné à le permettre existe ; et si un jour on retire le premier handler, le comportement changera brutalement (suppression de factures) sans que personne ne s'y attende.
**Correction :** décider de la règle métier, garder **un seul** handler, supprimer l'autre.

#### P1-5 — Le PDF de caisse et l'UI ne racontent pas la même histoire
**Fichier :** `src/routes/cash-register.routes.ts:739`

```ts
expenseTotal: t.expenseTotal.plus(t.supplierPaymentTotal).toString(),
```
Le PDF réagrège les règlements fournisseurs dans « LES DEPENSES », alors que l'API JSON les expose séparément (`supplierPaymentTotal`, l. 327). Le choix est assumé en commentaire, mais il crée deux définitions du mot « dépense » dans le même module.

Symptôme connexe : `supplierPaymentTotal` est le **seul** total non persisté sur `cashRegisterDay` (commentaire l. 280-281), et le snapshot de clôture `cashRegisterClosing` (l. 1178, `depensesTotal: t.expenseTotal`) ne l'inclut **pas non plus**. Donc `totalEntrees − totalSorties` relus depuis un `CashRegisterClosing` archivé ne se recomposent pas à partir de ses propres champs.

**Impact métier :** un contrôle a posteriori sur les clôtures archivées ne retrouvera pas la différence ; le règlement fournisseur devient invisible dans l'historique figé.
**Correction :** ajouter une colonne `supplierPaymentTotal` sur `CashRegisterDay` et `CashRegisterClosing`, et une ligne dédiée sur le PDF plutôt qu'une fusion.

#### P1-6 — Le middleware `requireAuth` mélange sync et async (piège d'erreur)
**Fichier :** `src/auth/middleware.ts:34-65`

La fonction est déclarée synchrone mais lance une promesse `prisma.user.findUnique().then(...).catch(...)`. Le `catch` externe (l. 62) n'attrape que l'échec de `verifyAccessToken`. Toute erreur **dans `next()`** (donc dans toute la suite de la chaîne, pour toute route de l'app) est capturée par le `.catch()` de la l. 59 et transformée en **`401 Non authentifié`**.

**Impact métier :** une erreur applicative quelconque en aval peut être masquée en « non authentifié », ce qui déconnecte l'utilisateur du frontend au lieu d'afficher l'erreur réelle. Diagnostic très coûteux en production.
**Correction :** passer le middleware en `async` avec `await`, et appeler `next()` en dehors du bloc `try` ou via `next(err)`.

---

### P2 — Mineur

#### P2-1 — `src/money.ts` est du code mort ; 9 redéfinitions locales de `D()`
**Fichiers :** `src/money.ts` (40 l., **0 import** dans tout le projet) vs `grep -c "const D = "` → **9 occurrences**

`money.ts` expose `moneyAdd`, `moneyMul`, `moneySub`, `round2`, `formatDA` avec une doctrine claire en en-tête (« L'argent est TOUJOURS manipulé en Decimal »). Personne ne l'importe. À la place, chaque routeur redéclare :
```ts
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);   // supplier-receptions:56
const D = (v: any) => new Prisma.Decimal(v);                    // supplier-payments:25
```
Les signatures divergent (`any` vs `Decimal.Value`), et `_helpers.ts:64` fait même un `require('@prisma/client')` **synchrone au runtime** dans `moneyField()` alors que `Prisma` est déjà importé en haut du fichier — idem l. 102 dans `checkCreditLimit`.

**Impact métier :** faible aujourd'hui (le comportement est identique), mais l'arrondi n'est pas centralisé : certains sites font `.toDecimalPlaces(2)`, d'autres `.toDecimalPlaces(3)`, d'autres rien. Un écart d'arrondi sur les commissions apparaîtra tôt ou tard.
**Correction :** exporter `D` depuis `money.ts`, l'importer partout, supprimer les `require()` inline de `_helpers.ts`.

#### P2-2 — `getCompanyParams()` copié-collé à l'identique dans 4 fichiers
**Fichiers :** `src/routes/supplier-bordereaux.routes.ts:32-45`, `src/routes/supplier-receptions.routes.ts:20-33`, `src/routes/invoices.routes.ts`, `src/bulletins/bulletins.routes.ts`

Quatre copies strictement identiques (mêmes 8 champs, mêmes casts `(cs as any)`), chacune faisant son propre `prisma.companySettings.findFirst()` à chaque génération de PDF.
**Impact :** dette pure + 4 requêtes DB évitables. Un nouveau champ d'en-tête (n° RC, NIF) devra être ajouté 4 fois.
**Correction :** `src/services/companySettings.ts` avec un cache mémoire court (les paramètres société changent une fois par an).

#### P2-3 — Deux fonctions `jour()` avec des sémantiques de fuseau différentes
**Fichiers :** `src/routes/cash-register.routes.ts:31-34` vs `src/routes/supplier-payments.routes.ts:32-36`

```ts
// cash-register : UTC strict
return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
// supplier-payments : heure LOCALE
d.setHours(0, 0, 0, 0);
```
Or `supplier-payments.routes.ts:528` passe son `datePaiement` (calculé en local) à `getOrCreateDay(tx, datePaiement)` de cash-register (qui re-normalise en UTC).

**Impact métier :** en Algérie (UTC+1), un règlement fournisseur saisi entre 00h00 et 01h00 est rattaché à la **journée de caisse de la veille**. Rare mais réel, et très difficile à diagnostiquer quand ça arrive.
**Correction :** un unique `src/date.ts` avec `jourCivil()` / `bornesJour()` en UTC, importé partout ; supprimer la variante locale. Même remarque pour `heureCourante()` (`cash-register:49`) qui utilise `getHours()` local alors que les dates sont en UTC.

#### P2-4 — Boilerplate `try/catch` répété ~90 fois au lieu d'un `asyncHandler`
**Fichiers :** tous les routeurs (`grep -c catch` : cash-register 19, invoices 11, sales 10, supplier-payments 9, supplier-advances 8…)

Chaque handler répète :
```ts
} catch (e: any) {
  res.status(e?.status ?? 500).json({ error: e?.message ?? 'Erreur ...' });
}
```
avec des variantes incohérentes : certains loguent (`console.error`), d'autres non ; certains renvoient `message`, d'autres `details`, d'autres rien. Et 3 fichiers (`stock-lots`, `stub`, `_helpers`) n'ont **aucun** `catch`, comptant sur un error handler global qui est justement cassé (cf. P1-1).

**Impact :** format d'erreur non uniforme côté frontend, et fuite de messages Prisma bruts vers le client (`e?.message` peut contenir des noms de colonnes/contraintes).
**Correction :** un `asyncHandler(fn)` unique + un error handler central corrigé ; les routes se contentent de `throw Object.assign(new Error(msg), { status: 400 })`, pattern déjà utilisé dans `sales.routes.ts:504`.

#### P2-5 — Signalisation d'erreur par effet de bord (`httpStatus` + `__handled`)
**Fichier :** `src/routes/supplier-receptions.routes.ts:404-412` et `:757`

```ts
let httpStatus = 500;            // variable mutable capturée par la closure
const fail = (msg, status = 400) => { httpStatus = status; const e = new Error(msg); e.__handled = true; throw e; };
...
if (e?.__handled) return res.status(httpStatus).json({ error: e.message });
```
Le statut voyage dans une variable externe à la transaction plutôt que sur l'erreur elle-même. Fragile (si deux `fail()` s'enchaînaient, le dernier gagnerait) et incohérent avec `sales.routes.ts` / `supplier-payments.routes.ts` qui posent correctement `e.status`.
**Correction :** aligner sur `Object.assign(new Error(msg), { status })`.

#### P2-6 — Requêtes non bornées et scans de table complets
**Fichiers :** `src/routes/supplier-receptions.routes.ts:156`, `:700` ; `src/routes/supplier-payments.routes.ts:108-111` ; `src/routes/cash-register.routes.ts:358` ; `src/routes/supplier-bordereaux.routes.ts:133`

- `findMany({ select: { reference: true } })` **sans `where`** sur `supplierReception`, `supplierBordereau`, `supplierAdvance` à **chaque création** de réception (l. 156) — coût linéaire en nombre de documents, sur le chemin le plus chaud du métier.
- `GET /supplier-payments/eligible/:supplierId` (l. 108) charge **toutes** les `SupplierPaymentLine` de la base pour construire un `notIn` en mémoire, au lieu d'un `NOT EXISTS` SQL.
- `GET /cash-register/days` (l. 358) et `GET /supplier-bordereaux` (l. 133) : aucun `take`, aucune pagination — la liste grossit indéfiniment.
- `GET /supplier-receptions` (l. 340) : `take: 200` **codé en dur**, sans pagination, alors que `parseListQuery()`/`paginate()` existent dans `_helpers.ts` et sont utilisés par `sales`/`products`.

**Impact métier :** dégradation progressive et silencieuse — invisible en démo, pénible après 12 mois d'exploitation.
**Correction :** appliquer `parseListQuery`/`paginate` uniformément ; remplacer le `notIn` par un filtre relationnel Prisma.

#### P2-7 — Le module `search` court-circuite le routage RESTful
**Fichier :** `src/index.ts:62-64`

```ts
app.use('/api/products/search', productsSearchRouter);   // AVANT /api/products
```
Le commentaire (« AVANT les routers /:id ») documente le contournement, mais cela signifie que la recherche produits vit dans un fichier séparé (`search.routes.ts`, 237 l.) au lieu d'être `GET /api/products?q=` — pattern déjà supporté par `parseListQuery()` et effectivement implémenté dans `products.routes.ts:137`. Il existe donc **deux** chemins de recherche produits concurrents.
**Correction :** monter les sous-routes de recherche à l'intérieur de leur routeur parent (`productsRoutes.use('/search', ...)`), ou fusionner dans le `GET /` paginé.

#### P2-8 — Aucun test automatisé dans le backend
**Fichier :** `backend/package.json` — pas de `"test"` script, pas de `vitest`/`jest`, aucun dossier `tests/`.

**Impact métier :** les 3 bugs critiques récemment corrigés (recyclage de bordereau, encaissement de crédit, dépenses fournisseur) portaient tous sur des **agrégats comptables** — exactement le type de logique qu'un test unitaire attrape en une seconde. Sans filet, chaque correction risque d'en réintroduire une autre.
**Correction :** au minimum, tests unitaires sur `calculerTotauxJour()` (fixtures de factures/paiements) et sur la boucle FIFO de `confirm`, une fois ces fonctions extraites en services (P1-3).

---

### P3 — Cosmétique

#### P3-1 — Page HTML de test de 85 lignes embarquée dans `index.ts`
**Fichier :** `src/index.ts:172-255`

`loginTestPageHtml()` inline du HTML, du CSS et du JS (avec identifiants de démo `admin`/`admin123` **en clair dans la réponse**) sur la route publique `/test`. Cela représente un tiers du fichier de bootstrap.
**Correction :** déplacer dans `public/test.html`, et ne monter la route que si `config.nodeEnv !== 'production'`.

#### P3-2 — `any` omniprésent, contournant TypeScript sur les chemins financiers
**Fichiers :** `grep -c ": any"` → cash-register 38, supplier-payments 31, supplier-advances 27, supplier-bordereaux 20, supplier-receptions 17

Toutes les fonctions `serialize*()` prennent `(x: any)`, `(req as any).user?.id` est utilisé dans les modules caisse/fournisseurs alors que `req.user` est **correctement typé** via la déclaration globale de `middleware.ts:15-22` (et bien utilisé sous la forme `req.user!.id` dans `sales`/`invoices`/`payments`). `calculerTotauxJour(prisma as any, ...)` (l. 381, 724) masque la différence `PrismaClient`/`TransactionClient`.
**Correction :** typer les DTO de sortie (des interfaces existent déjà : `InvoiceDTO`, `BulletinDTO`) et utiliser `req.user` partout.

#### P3-3 — Langue mixte français/anglais dans les identifiants
**Fichiers :** `cash-register.routes.ts` (`calculerTotauxJour`, `bornesJour`, `montantValide`, `lignes`) vs `sales.routes.ts` (`computeItem`, `loadSale`, `resolveFifoLot`)

Le mélange va jusqu'à l'intérieur d'une même structure : `TotauxJour` contient `invoiceTotal`, `cashSupplyTotal` mais aussi `autresEntrees`, `autresSorties`. Les valeurs de `statut` sont en français (`'ouvert'`, `'cloture'`, `'partiellement_paye'`) tandis que celles de `status` sont en anglais (`'DRAFT'`, `'PAID'`) — et les deux champs coexistent dans le schéma.
**Correction :** choisir une convention (le français métier est défendable ici) et la documenter dans `ARCHITECTURE.md`.

#### P3-4 — Stubs 501 encore montés en production
**Fichier :** `src/index.ts:99-101`, `src/routes/stub.routes.ts` (175 l.)

`buildStubRouters()` expose des modules « Phase B/C/D » renvoyant `501 Non implémenté` avec un message interne (« Le schéma DB est cependant complet »). Certains recouvrent des modules désormais livrés.
**Correction :** purger les entrées de `stubModules` correspondant à des modules implémentés ; ne monter le reste qu'en développement.

---

## (c) Points forts

1. **Discipline Decimal exemplaire.** Aucun `parseFloat`/`Number()` sur un montant dans les calculs : `Prisma.Decimal` du bout en bout, avec `toDecimalPlaces(2)` pour l'argent et `(3)` pour les quantités. C'est la qualité la plus importante pour un ERP financier, et elle est tenue.

2. **Transactions systématiques sur les mutations multi-tables.** Réception (`supplier-receptions:150`), confirmation de vente FIFO (`sales:497`), règlement fournisseur (`supplier-payments:345`), clôture de caisse (`cash-register:1122`) : toutes atomiques. Les effets de bord (solde fournisseur, ligne de caisse, mouvement de stock) sont dans la même transaction que l'écriture principale.

3. **Invariants métier explicitement codés et commentés.** Surpaiement interdit (`supplier-payments:234`), stock jamais négatif (`stock:196`, `sales:551`), encaissement > restant dû refusé (`payments:151`), anti-doublon caisse via `@@unique(sourceType, sourceId)` + `assertPasDeDoublon()`. Les commentaires expliquent le *pourquoi métier*, pas le *quoi* — rare et précieux.

4. **Caisse en lecture seule sur les modules amont.** Le choix d'agréger factures et paiements **à la volée** plutôt que de les dupliquer en `CashRegisterEntry` (documenté en tête de `cash-register.routes.ts`) élimine par construction toute classe de bugs de désynchronisation. Seules les saisies manuelles sont matérialisées.

5. **Cohérence agrégat ↔ drill-down.** Les routes `/days/:date/*` réutilisent exactement les mêmes prédicats que `calculerTotauxJour()` (voir le commentaire l. 636-639 : « Doit correspondre EXACTEMENT à l'agrégat creditInvoiceTotal »). C'est un piège classique consciemment évité.

6. **Soft-delete rigoureux.** `deletedAt: null` est filtré dans quasiment toutes les requêtes, y compris dans les agrégats de paiements et les résolutions FIFO.

7. **Permissions granulaires bien conçues là où elles sont appliquées.** `getUserPermissionsDetail()` (`permissions.ts:16`) implémente proprement `rôle − DENY + GRANT` avec deux requêtes parallèles et une garantie de non-régression documentée. Le mécanisme est solide — il faut juste l'étendre aux modules qui l'ignorent (P0-1).

8. **Amorce de modularisation correcte.** `bordereaux/lots.ts` (résolution multi-calibres + rétro-compat), `caisse/pdf.ts`, `barcode.ts`, `bulletins/{types,shape,template,pdf}.ts` montrent que le découpage par domaine est compris et faisable — c'est le modèle à généraliser aux gros routeurs.

---

_Audit réalisé en lecture seule. Aucun fichier de code modifié, aucun serveur lancé, aucune donnée créée._

