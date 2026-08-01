# Rapport Fruiterie ERP — Phase C (Ventes/Factures/Paiements) + correctifs

**Date** : 22/07/2026
**Projet** : /home/mimo/fruiterie-app (backend Node/Express/Prisma + frontend React/Vite/TS)
**Serveur** : http://40.66.41.114:8080 (port 8080 imposé, hébergement local PC marché)
**Comptes** : admin/admin123 · responsable/resp123 · employe/emp123

---

## 1. Ce qui a été fait

### A. Architecture & unification
- Pages Ventes / Factures / Paiements fusionnées en **une seule page « Bulletin »** (côté vente client) : vente + facture + paiement dans le même flux.
- **Bulletins d'achat** = ancien écran fournisseur (renommé dans le menu).
- Page **Clients** créée avec drill-down (client → factures → détail).

### B. Correctifs bugs Phase C (QA)
- Balance client incrémentée au bon montant quand une facture est émise (`issue`).
- Vérification du **stock disponible** à la création d'une vente (400 si insuffisant).
- Méthode de paiement `BANK_TRANSFER` (+ `CARD`) alignée front/back (le front envoyait `BANK`).

### C. PDF & tableau
- **Saut de page automatique** dans le PDF (plus de dépassement quand >~16 lignes).
- **Recherche produit/client** auto-complétée FR + AR (ex: « ba » → Bananes, recherche arabe OK).
- Colonnes article : **Colis / Brut (kg) / Tare (kg) / Net (kg) / P.U. / Total**.

### D. Flux de création (corrigé ce tour)
- Après « Créer le bulletin », **le formulaire de saisie disparaît** (remplacé par « Bulletin créé. Comment encaisser ? ») → plus de risque de re-soumission/doublon.
- Après **Payé / Paiement différé / Crédit**, **le modal se ferme** automatiquement.

### E. Statut & dates (corrigé ce tour)
- **Bug statut « Brouillon » bloqué** : racine = `saleId` non sérialisé → `invoiceBySaleId` ne matchait jamais → badge DRAFT. Corrigé : `saleId` + `createdAt` sérialisés. Prouvé : après paiement → **PAID**.
- **Date de facture automatique** à la création (`issueDate` = date du jour).

### F. Page Détail facture (bouton « Détail » remplace « Historique »)
- Modal avec **toutes les infos par ligne** : Produit / Colis / Brut / Tare / Net / P.U. / Total + Total général + **Avance** + **Restant**.
- Bouton **Supprimer** → supprime la facture ET la vente liée → la ligne disparaît de la liste (endpoint `DELETE /api/sales/:id` ajouté).
- Bouton **Modifier** → édition (PATCH `/api/invoices/:id`) : on édite Colis/Brut/Tare/PU, le **Net est calculé auto (Brut − Tare) et NON éditable**.
- Backend : `paidAmount` + `remaining` sérialisés (somme des paiements).

### G. Liste des bulletins (colonnes ajoutées)
- **Avance** (montant déjà payé) et **Restant** (total − avance) affichées par ligne.

### H. Calcul du Net + champ readonly (ce tour) ✅
- **Net = Brut − (Tare × Colis)** appliqué partout : frontend (recalcul des lignes Nouveau bulletin + Détail édition) + backend (`computeItem` sales.routes + PATCH invoices.routes). Prouvé curl : colis=10, brut=120, tare=1, pu=80 → **net=110, total=8800**.
- **Champ Net en readonly** (non-éditable) sur le tableau des articles (Nouveau bulletin) : on saisit Colis/Brut/Tare, le Net est calculé auto et affiché en lecture seule.

---

## 2. En cours (agent en arrière-plan)

### Agent `deleg_5c918070` — flux « Encaisser » + règle métier ✅ TERMINÉ

**Cause racine du bug « encaisser marche pas »** : le endpoint liste `GET /api/invoices` ne faisait pas `include: { payments }`. Donc `serializeInvoice` calculait `paidAmount=0` et `remaining=total` pour CHAQUE facture de la liste — même une facture `PAID` affichait `remaining=900`. La liste était incohérente avec la réalité → toute la logique restant/encaissement basée dessus était fausse.

**Fichiers modifiés (lignes exactes)** :
- `backend/src/routes/invoices.routes.ts` (~376-381) : liste inclut `payments` → `paidAmount`/`remaining` corrects dans la liste.
- `frontend/src/pages/Bulletin.tsx` (~577-583) : bouton **Encaisser désactivé** si `!inv || PAID || CANCELLED || remaining === 0`.
- `backend/src/routes/payments.routes.ts` (~127 + ~187-189) : guard `POST /api/payments` → **400 « Facture déjà payée »** si `remaining <= 0` ; **400 « Montant supérieur au restant dû »** si dépassement.

**Builds** : backend exit 0 ✓ · frontend exit 0 ✓

**Tests curl réels (serveur relancé 8080, PID 66869)** :
- (a) facture NON payée (remaining=1900) → POST paiement → **201** ✓
- (b) facture DÉJÀ payée (remaining=0, PAID) → POST paiement → **400 « Facture déjà payée »** ✓
- Bonus : dépassement (9999 sur restant=400) → **400 « Montant supérieur au restant dû (400 DA) »** ✓
- Liste cohérente : `F-2026-0029` PAID/remaining=0 → Encaisser désactivé ✓

**Rien cassé** : Détail (handleDetail + Modifier/Supprimer), removeDetail (supprime facture+vente) intacts. Paiements de test supprimés pour rester propre.

---

## 3. Règle de travail (mise à jour utilisateur)

- **Le chef (Hermes) ne code PLUS directement** — tout le code (.ts/.tsx/.js/.py/.sql/.css) est **délégué** aux agents, y compris les correctifs urgents. Cause : les éditions directes provoquaient des erreurs à répétition.
- Une facture payée (restant = 0) est **verrouillée** pour l'encaissement (front + back).

---

## 4. Il reste à faire

### Priorité immédiate
- [x] Intégrer le résultat de l'agent `deleg_5c918070` (Encaisser + règle restant=0) et le prouver en curl — **TERMINÉ** (201 non-payée, 400 payée, guard dépassement).
- [ ] **Validation visuelle utilisateur** : Bulletin (création → encaissement), Clients (drill-down), PDF (saut de page + colonnes), page Détail (Supprimer/Modifier).

### Phases suivantes
- [ ] **Phase D** : i18n complet FR/AR (toutes les pages, bascule de langue propre, RTL vérifié partout).
- [ ] **Phase E** : QA globale (audit multi-experts : Architect, UX, DB, Backend, Mobile/Web, QA) en lecture seule + rapport consolidé.
- [ ] **Phase F** : packaging Tauri (.exe) + hébergement cloud + HTTPS (port 8080 actuellement en clair en local).

### Points techniques à surveiller
- [ ] Sécurité : NE PAS exposer 8080 en clair (TLS + `VET_MANAGER_SECRET` + `ENV=production` en prod).
- [ ] Tests de non-régression sur le flux Supprimer (soft-delete vente + facture).
- [ ] Vérifier que le recalcul du Net en édition (Brut−Tare) est cohérent avec le total facture.

---

## 5. Commandes de build / lancement (rappel)

```bash
# Backend
cd /home/mimo/fruiterie-app/backend && npm run build
node dist/src/index.js          # sert aussi le frontend sur :8080

# Frontend
cd /home/mimo/fruiterie-app/frontend
VITE_API_URL=http://40.66.41.114:8080 npm run build
```
