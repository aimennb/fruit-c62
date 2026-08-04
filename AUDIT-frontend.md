# Audit Frontend & UX — Fruiterie ERP (React / Vite / TS)

**Portée** : pages caisse, bordereaux fournisseur, réceptions, ventes/factures, paiements fournisseur.
**Méthode** : lecture seule (aucun fichier modifié, aucun build/lancement, aucun push). Vérifications complémentaires par requêtes GET curl en lecture seule sur `http://localhost:8080` (token `admin`/`admin123`) et consultation de l'historique git.
**Date** : 04/08/2026.

> Note sur les 3 corrections backend « critiques » (caisse / bordereaux / paiements fournisseur) : l'UI **reflète correctement** ces corrections. En particulier :
> - **Caisse `credits-crees`** (commit `743c498`) : `CaisseCreditSales.tsx` affiche bien toute facture non `PAID` (`SENT`/`PARTIALLY_PAID`/`OVERDUE`), cohérent avec l'agrégat `creditInvoiceTotal`. ✅
> - **Réouverture auto du jour clôturé sur paiement CASH fournisseur** (commit `e03e6a1`) : `statutBadge` gère `reouverte` (ambre) et `CloturePage` réaffiche le formulaire de clôture dès que le statut repasse à `ouverte`/`reouverte`. ✅
> - **Bordereaux** : `BordereauDetail`/`Bordereaux` affichent `montantFinalDu`, `statut`, code couleur `paye`/`partiellement_paye`, et la règle « 1 réception = 1 bordereau » est respectée (pas de suppression, pas de bordereau orphelin). ✅
> Ces 3 points ne sont donc **pas** re-signalés comme bugs. Les problèmes ci-dessous sont des défauts frontend/UX indépendants.

---

## (a) Résumé exécutif

Le frontend est globalement cohérent avec le backend et bien structuré (hooks `useCallback`/`useEffect` propres, gestion d'erreur présente sur presque toutes les pages, design responsive AR/FR). Toutefois **deux problèmes P0** subsistent sur le module Ventes liés à la pagination/recherche serveur : le backend renvoie des résultats paginés (`/api/sales` → `{items,total,page,take,totalPages}`) mais le frontend appelle `getSales()` **sans `page`/`take`** et **n'exploite ni la pagination ni la recherche `?q=`**, alors que ces mécanismes ont été ajoutés côté backend (commit `5e15a2f`). Conséquence : perte silencieuse de données au-delà de la première page et liste de sélection « depuis une vente » incomplète.

Le reste des anomalies est de sévérité moindre : badges de statut non traduits dans les drill-downs caisse, filtre statut Bordereaux incomplet, garde `null` manquante sur des dates, et manques d'accessibilité de base.

---

## (b) Problèmes trouvés

### P0 — Critique (données manquantes / faux silencieux)

**P0-1 — Ventes : pagination serveur ignorée par l'UI (perte de données silencieuse)**
- `src/pages/Sales.tsx:55` → `const [sales, c, p] = await Promise.all([getSales(), getCustomers(), getProducts()])`
- `src/api.ts:358-367` → `getSales(q?, page?, take?)` : le backend pagine (`page`/`take`), renvoie `{items,total,page,take,totalPages}`.
- **Vérif curl** : `GET /api/sales` → `total=11, totalPages=3` ; `GET /api/sales?take=5` → `items=5, totalPages=3`. Le mécanisme de pagination existe bien.
- **Impact** : le frontend ignore `total`/`totalPages` et n'affiche que la première page. Dès que le nombre de ventes dépasse la taille de page par défaut du backend, des ventes **disparaissent de la liste sans aucun message**. L'utilisateur croit voir toutes ses ventes.
- **Suggestion** : passer un `take` explicite élevé (ex. `getSales('', 1, 1000)`) pour le besoin liste, OU implémenter une pagination UI (boutons page) en consommant `total`/`totalPages`. Ajouter un compteur « X ventes sur Y ».

**P0-2 — Factures : dropdown « depuis une vente » non paginé → ventes manquantes à la création**
- `src/pages/Invoices.tsx:66` → `const [inv, s] = await Promise.all([getInvoices(), getSales()])` puis `setSales(Array.isArray(s) ? s : s.items)` (l.68).
- **Impact** : même cause que P0-1. Le `<Select>` « Depuis une vente » (l.223-227) n'affiche que la première page de ventes. Une facture créée « depuis une vente » peut ne pas proposer la vente voulue → contournement manuel ou création d'une facture items à la main. Risque de facture erronée / non liée à la vente.
- **Suggestion** : `getSales('', 1, 1000)` pour peupler le sélecteur, ou ajouter une recherche/`SearchSelect` côté serveur.

### P1 — Majeur (UX / cohérence)

**P1-1 — Recherche Ventes : endpoint `?q=` disponible mais absent de l'UI**
- `src/api.ts:358-367` → `getSales` accepte `q` (recherche serveur).
- `src/pages/Sales.tsx` → **aucune** barre de recherche ; le tableau n'est pas filtré.
- Le commit `5e15a2f` (« pagination/recherche serveur ») a livré la recherche backend, mais l'UI ne l'expose pas (contrairement à `Bordereaux`/`Receptions` qui ont un input).
- **Impact** : recherche de vente impossible depuis l'UI ; l'utilisateur doit défiler/scroller une liste tronquée (voir P0-1).
- **Suggestion** : ajouter un `Input` de recherche déclenchant `getSales(q)` (avec debounce) et render le résultat.

**P1-2 — Badges de statut non traduits dans les drill-downs caisse**
- `src/pages/CaisseInvoices.tsx:71-73` → `<Badge color={...}>{f.status}</Badge>` affiche le libellé brut de l'API (`PAID`, `SENT`, `PARTIALLY_PAID`, `OVERDUE`).
- `src/pages/CaisseCreditSales.tsx:71` → idem (`{f.status}` brut).
- **Impact** : l'utilisateur lit des codes anglais techniques au lieu de « Payé / Émis / Avance / En retard ». Incohérent avec `Bordereaux`/`SupplierPayments` qui ont des `statutColor`/`statusLabel` traduits.
- **Suggestion** : centraliser un `invoiceStatusBadge()` (déjà existant dans `InvoiceDetail.tsx:27-51`) et l'appliquer dans les drill-downs caisse ; afficher le libellé FR (et AR) plutôt que l'enum.

### P2 — Moyen

**P2-1 — Filtre statut Bordereaux incomplet (incohérent avec les données)**
- `src/pages/Bordereaux.tsx:97-102` → `filtresStatut` ne propose que `ouvert` / `pret_a_cloturer` / `cloture`.
- Or le backend gère aussi `paye`, `partiellement_paye`, `annule` — et le même fichier les gère visuellement (`rowBg` l.27-31 et `statutColor` l.33-49 colorient `paye`/`partiellement_paye`).
- **Impact** : impossible de filtrer/isoler les bordereaux **payés** ou **annulés** (pourtant affichés en vert/gris dans la liste). L'utilisateur ne peut pas, par exemple, lister les bordereaux déjà payés pour contrôle.
- **Suggestion** : ajouter `paye`, `partiellement_paye`, `annule` aux options de filtre (avec libellés FR/AR).

**P2-2 — Dates sans garde `null` → affichage « Invalid Date »**
- `src/pages/CaisseCreditCollections.tsx:74` → `new Date(p.paymentDate).toLocaleTimeString('fr-FR')` sans vérifier `p.paymentDate`.
- `src/pages/CaisseInvoices.tsx:76` (issueDate) est quasi toujours présent, mais `CaisseCreditCollections` peut recevoir un `paymentDate` nul (type `string | null` dans `api.ts:806`).
- **Impact** : si `paymentDate` est `null`, `new Date(null)` = 1970 → affiche « 01:00 » (ou « Invalid Date » selon le champ), horodatage faux dans le tableau des encaissements. Pas de crash mais donnée trompeuse.
- **Suggestion** : garde `p.paymentDate ? new Date(...).toLocaleTimeString(...) : '—'` (comme déjà fait pour `heure` ailleurs).

**P2-3 — `BordereauDetail` n'affiche pas le Bon de réception lié (règle « 1 réception = 1 bordereau »)**
- `src/api.ts:517-531` → `SupplierReceptionDetail.reception?: {id, reference}` porte le lien réception↔bordereau.
- `src/pages/BordereauDetail.tsx` : l'interface `BordereauDetail` (l.57-87) **ne déclare pas** `reception`, et la page ne rend pas ce lien (contrairement à `ReceptionDetail` qui affiche bien le bordereau lié, l.126-170).
- **Impact** : depuis un bordereau, on ne voit pas le bon de réception d'origine, alors que la règle métier centrale est « 1 réception = 1 bordereau ». Navigation à sens unique (réception→bordereau OK, bordereau→réception impossible).
- **Suggestion** : ajouter `reception?` au type et une ligne « Bon de réception » cliquable renvoyant vers `/receptions/detail/:id`.

### P3 — Mineur (robustesse / accessibilité)

**P3-1 — `useBarcodeSearch` partage l'état `error` avec le chargement (Bordereaux/Receptions)**
- `src/pages/Bordereaux.tsx:62` et `src/pages/Receptions.tsx:44` → `useBarcodeSearch(q, { onNotFound: (m) => setError(m) })`.
- **Impact** : un code-barres non trouvé écrase une erreur de chargement éventuelle (et vice-versa) ; le message n'est pas persistant ni contextualisé (« aucun document trouvé » vs « échec réseau »).
- **Suggestion** : état dédié `barcodeMsg` distinct de `error`.

**P3-2 — Accessibilité de base manquante**
- `src/components/ui.tsx:179-202` (`Table`) : `<th>` sans `scope="col"`, pas d'`aria-label` sur les `Spinner`/chargements.
- `src/components/ui.tsx:145-177` (`Modal`) : fermeture uniquement par la croix × ; pas de touche `Échap`, pas de `focus trap`, pas de `role="dialog"`/`aria-modal`.
- `src/components/Layout.tsx:110-123` : `NavLink` sans `title` (infobulle) ; icônes décoratives non `aria-hidden`.
- **Impact** : navigation clavier et lecteurs d'écran partiellement compromis (conformité WCAG de base non atteinte).
- **Suggestion** : `scope` sur les `th`, `role="dialog" aria-modal` + Échap + focus trap sur `Modal`, `aria-label` sur les inputs de montant.

**P3-3 — Total Ventes calculé côté client sans l'emballage**
- `src/pages/Sales.tsx:89-92` → `total = quantity * unitPrice`. Le type `SaleItem` gère `packingUnitPrice` (api.ts:220) mais le total affiché l'ignore.
- **Impact** : le total affiché dans le formulaire de vente ne reflète pas le `total` réel du backend (qui inclut l'emballage). Écart visuel mineur entre le total saisi et la vente enregistrée.
- **Suggestion** : inclure `packingUnitPrice * colis` dans le total côté client, ou afficher le total renvoyé par le backend après `createSale`.

**P3-4 — `new Date(date)` interprété en heure locale sur des champs date-only**
- Plusieurs pages (`Bordereaux`, `CaisseDayDetail`, `CloturePage`) font `new Date(b.dateCloture)` / `new Date(p.date)` puis `.toLocaleDateString`. Pour un champ `date` (sans heure), `new Date("2026-08-02")` est interprété en **UTC** → risque de décalage d'un jour selon le fuseau de l'utilisateur (Algérie UTC+1).
- **Impact** : dates potentiellement décalées d'un jour sur l'affichage (ex. « 01/08 » au lieu de « 02/08 »).
- **Suggestion** : utiliser `fmtDate()` (déjà défini dans `caisse-utils.ts:22-26`, découpe la chaîne `YYYY-MM-DD` sans interprétation UTC) partout où le champ est `date`-only, au lieu de `new Date(...).toLocaleDateString`.

---

## (c) Points forts

- **Gestion d'erreur API quasi systématique** : presque toutes les pages wrapped leurs `fetch` dans `try/catch` avec `ErrorBox` ; `api.ts` centralise le handling 401 (déconnexion + `unauthorizedHandler`) et le parsing des messages d'erreur backend.
- **Hooks propres** : `useEffect` + `useCallback` avec tableau de dépendances correct (ex. `CaissePage.tsx:14-29`, `BordereauDetail.tsx:136-154`) ; `Dashboard.tsx:31-57` utilise un flag `alive` pour éviter les fuites/setState post-démontage.
- **Architecture API claire** : `request<T>` typé, séparation nette des modules, helpers PDF avec révocation d'URL (`setTimeout(revokeObjectURL, 60_000)`).
- **Responsive + i18n AR/FR** : `Layout` avec sidebar desktop + bottom-nav mobile, `useLang` partout, support RTL (`ps-*`/`end-*`/`<html dir>` implicite).
- **Cohérence règle métier bordereaux/paiements** : la séparation création/règlement (`en_attente` → `paye`/`partiellement_paye`), l'exclusion des bordereaux déjà pris (1 BP = 1 bordereau), et la distinction PAY (sortie caisse) / ENCAISSER (imputation avance, hors caisse) sont correctement reflétées côté UI (badges, boutons Payer/Encaisser, message explicatif `SupplierPaymentDetail.tsx:176-182`).
- **Drill-downs caisse bien pensés** : `StatLink` cliquables (`CaisseDayDetail.tsx:19-46`) menant aux listes détaillées ; totaux recalculés alignés sur le backend.
- **Sécurité lecture seule respectée** : aucune action de mutation n'a été déclenchée pendant l'audit.

---

## Recommandation prioritaire

Corriger **P0-1 / P0-2** en premier (passer un `take` explicite à `getSales`, ou brancher la pagination UI + la recherche `?q=` déjà prête côté backend). C'est le seul point où des données peuvent disparaître silencieusement à l'utilisateur.
