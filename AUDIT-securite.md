# Audit de sécurité — Fruiterie ERP (backend)

Date : 2026-08-04 · Périmètre : `/home/mimo/fruiterie-app/backend/src` (auth, routes, config, validation)
Mode : **lecture seule** (lecture de code + requêtes GET / tentatives d'accès non autorisées en lecture)

---

## (a) Résumé exécutif

L'architecture d'authentification est globalement saine : JWT access court (15 min) + refresh token en cookie `httpOnly` **haché en base** avec rotation et révocation, bcrypt pour les mots de passe, rate-limiting sur le login, journal d'audit, permissions granulaires résolues dynamiquement (rôle − DENY + GRANT).

Cependant l'audit révèle **une faille P0 confirmée par requête réelle** : l'endpoint `GET /api/users/:id` renvoie le **hash bcrypt du mot de passe** de n'importe quel utilisateur. Et surtout, **4 routers métier sensibles (caisse, paiements fournisseurs, bordereaux, lots de stock) et la recherche globale ne portent AUCUNE vérification de permission** — seulement `requireAuth`. Vérifié en pratique : le compte `receptionnaire` (permission unique `RECEPTION_WRITE`) accède en lecture **et en écriture** à toute la caisse, à tous les paiements fournisseurs et à tous les bordereaux, alors qu'il est correctement bloqué (403) sur `/api/users`, `/api/invoices`, `/api/sales`, `/api/customers`.

S'ajoutent : CORS `*` combiné à `credentials: true`, secrets JWT en clair dans `.env` (correctement gitignoré), absence de `helmet`, fuite de messages d'erreur internes Prisma, et plusieurs schémas Zod acceptant un `userId` fourni par le client (falsification de traçabilité).

**Bilan : 3 P0, 5 P1, 5 P2, 2 P3.**

---

## (b) Problèmes trouvés

### 🔴 P0 — Critique (accès non autorisé à des données sensibles)

---

#### P0-1 — `GET /api/users/:id` expose le **hash bcrypt** des mots de passe

**Fichier :** `backend/src/routes/users.routes.ts:34-38`

```ts
router.get('/:id', requirePermission('USER_READ'), async (req, res) => {
  const u = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!u || u.deletedAt) return res.status(404).json({ error: 'Introuvable' });
  res.json(u);            // ← objet Prisma COMPLET, aucun `select`
});
```

**Confirmé en réel** (token admin) :
```json
{"id":"cmsb515e40000ie66yoxajnfi","email":"reception@fruiterie.dz",
 "username":"receptionnaire",
 "passwordHash":"$2a$10$7W7XOL.q0hkJBg8WRB1iCOzs5SQ2ur7R47XtZraPPdxhwB5Kh3W", ...}
```

**Impact :** tout porteur de `USER_READ` (rôles RESPONSABLE inclus, pas seulement ADMIN) récupère les hashes bcrypt de **tous** les comptes, y compris l'admin. Un hash bcrypt(10) sur un mot de passe faible (`admin123`, `resp123`, `emp123` — voir P1-5) tombe en quelques secondes en offline cracking. Escalade directe vers ADMIN.
Noter l'incohérence : la route liste `GET /` (ligne 24-31) utilise bien un `select` restrictif — l'oubli est isolé sur `/:id`.

**Suggestion :** appliquer exactement le même `select` que la route liste :
```ts
select: { id: true, email: true, username: true, fullName: true,
          role: true, isActive: true, lastLoginAt: true, createdAt: true }
```

---

#### P0-2 — Le module **CAISSE** entier est sans aucune permission

**Fichier :** `backend/src/routes/cash-register.routes.ts:22` (`router.use(requireAuth);` — **seul** garde du fichier)

Les 20 routes du routeur n'ont aucun `requirePermission` :

| Ligne | Route | Sensibilité |
|---|---|---|
| 356 | `GET /days` | Chiffre d'affaires quotidien |
| 372 | `GET /days/:date` | Détail complet de la caisse |
| 526-715 | `GET /days/:date/{invoices,credit-collections,expenses,credit-sales,remittances,supplier-payments,pdf}` | Tout le flux financier + PDF |
| **786** | **`POST /expenses`** | **Création de dépense = sortie de caisse** |
| **873** | **`PATCH /expenses/:id/cancel`** | **Annulation de dépense** |
| **937** | **`POST /supplies`** | **Approvisionnement de caisse** |
| **1022** | **`POST /remittances`** | **Remise / versement** |
| **1103** | **`PATCH /days/:date/close`** | **Clôture de journée (irréversible)** |

**Vérifié en réel** avec le token `receptionnaire` (permissions effectives = `['RECEPTION_WRITE']` uniquement) :
```
GET /api/cash-register/days  →  200  {"items":[{"id":"cmsb06auh002ulvvlkn9fbmli","date":"2026-08-05","openingCashFund":"0",...
```

**Impact :** un employé réceptionnaire (ou n'importe quel compte authentifié, y compris un compte de test) lit l'intégralité des données financières de l'entreprise **et peut créer des dépenses fictives, annuler des dépenses réelles et clôturer la journée**. C'est un vecteur direct de détournement/dissimulation de fonds, dans le module le plus sensible de l'ERP.

**Suggestion :** ajouter les gardes par route — lecture `requirePermission('REPORT_READ')` ou une nouvelle permission `CASH_READ` ; écriture/clôture `requirePermission('CASH_WRITE')` réservée à ADMIN/RESPONSABLE. Un simple `router.use(requireAuth, requirePermission('CASH_READ'))` global + surcharge `CASH_WRITE` sur les POST/PATCH est le correctif minimal.

---

#### P0-3 — Paiements fournisseurs, bordereaux et lots de stock sans permission

**Fichiers :**
- `backend/src/routes/supplier-payments.routes.ts:23` — `router.use(requireAuth)` seul ; routes `GET /` (73), `GET /eligible/:supplierId` (103), **`POST /`** (169), **`POST /:id/pay`** (328), `GET /:id` (616), `GET /:id/pdf` (682)
- `backend/src/routes/supplier-bordereaux.routes.ts:28` — `router.use(requireAuth)` seul ; routes `GET /` (132), `GET /:id` (155), **`PATCH /:id`** (231), **`POST /:id/avances`** (347), **`DELETE /:id/avances/:allocationId`** (384), **`PATCH /:id/cloture`** (428), **`PATCH /:id/correct`** (477), `GET /:id/pdf` (540)
- `backend/src/routes/stock-lots.routes.ts:12` — `router.use(requireAuth)` seul ; `GET /` (15), `GET /fifo` (51)
- `backend/src/routes/search.routes.ts:128` — `globalSearchRouter.use(requireAuth)` seul, **contrairement** à `productsSearchRouter` (l.22, `PRODUCT_READ`) et `customersSearchRouter` (l.79, `CUSTOMER_READ`)

**Vérifié en réel** (token `receptionnaire`, perms = `RECEPTION_WRITE`) :
```
/api/supplier-payments     → 200  {"items":[{"reference":"BP-2026-0017",...
/api/supplier-bordereaux   → 200  {"items":[{"reference":"BF-096464",...
/api/stock-lots            → 200
/api/search?q=a            → 200  {"items":[{"type":"invoice","reference":"F-2026-0086",...
/api/invoices              → 403  ← bien protégé
/api/customers             → 403  ← bien protégé
```

**Impact :** contournement complet du modèle de permissions. `/api/search` est particulièrement grave : il renvoie les **factures clients** (référence, montant, nom du client) à un utilisateur explicitement privé de `INVOICE_READ` — le 403 sur `/api/invoices` est donc contournable via la recherche globale. Côté écriture, un réceptionnaire peut **payer un fournisseur**, corriger ou clôturer un bordereau.

**Suggestion :** `PURCHASE_READ`/`PURCHASE_WRITE` (ou `SUPPLIER_*`) sur supplier-payments et bordereaux ; `STOCK_READ` sur stock-lots ; sur `globalSearchRouter`, filtrer les résultats **par permission effective** de l'appelant (n'inclure les factures que si `INVOICE_READ`, les réceptions que si `RECEPTION_READ`, etc.).

---

### 🟠 P1 — Majeur

---

#### P1-1 — CORS `*` avec `credentials: true`

**Fichiers :** `backend/src/config.ts:15` — `corsOrigin: (process.env.CORS_ORIGIN ?? '*').split(',')` ; `backend/src/index.ts:34-39` ; `.env` : `CORS_ORIGIN="*"`

```ts
app.use(cors({ origin: config.corsOrigin, credentials: true }));
```

**Impact :** avec `origin` fourni explicitement (ici la chaîne `"*"` dans un tableau), le middleware `cors` renvoie `Access-Control-Allow-Origin: *` **et** `Allow-Credentials: true` — combinaison que les navigateurs rejettent, mais si la valeur est un jour changée en liste reflétée, tout site tiers pourra piloter l'API avec le cookie de refresh de la victime (CSRF/vol de session). Aucune protection CSRF n'existe par ailleurs sur `POST /api/auth/refresh` (cookie `sameSite: 'lax'` uniquement).

**Suggestion :** exiger une liste blanche explicite en production (rejeter `*` si `NODE_ENV === 'production'`), et ajouter un token CSRF ou `sameSite: 'strict'` sur le cookie de refresh.

---

#### P1-2 — `userId` accepté depuis le client dans les schémas Zod de la caisse

**Fichiers :** `cash-register.routes.ts:771` (`expenseSchema`), `:932` (`supplySchema`), `:1101` (`closeSchema`), `remittanceSchema` (l.1011)

```ts
const expenseSchema = z.object({
  ...
  userId: z.string().optional().nullable(),   // ← fourni par le client
});
```
`grep -n "req.user" src/routes/cash-register.routes.ts` → **aucune occurrence**. L'identité de l'auteur d'une dépense/clôture provient donc entièrement du corps de la requête.

**Impact :** falsification de la traçabilité comptable. Un utilisateur peut imputer une dépense ou une clôture de caisse à un collègue, ou à un `userId` inexistant. En cas de litige/contrôle, le journal est inexploitable. Même problème potentiel sur `supplier-payments.routes.ts` et `supplier-bordereaux.routes.ts` (aucun `req.user` non plus).

**Suggestion :** retirer `userId` des schémas Zod et forcer `userId: req.user!.id` côté serveur ; conserver éventuellement un champ `onBehalfOf` distinct, réservé à ADMIN.

---

#### P1-3 — Fuite de détails internes dans les réponses d'erreur

**Fichiers (extraits) :** `supplier-receptions.routes.ts:331,758,819` · `supplier-bordereaux.routes.ts:270,423,466,535,627` · `supplier-payments.routes.ts:725` · `search.routes.ts:235` · `stock.routes.ts:273` · `sales.routes.ts:288,460` · `auth/auth.routes.ts:109` · `index.ts:148-157`

```ts
res.status(500).json({ error: 'Erreur mise à jour bordereau', message: e?.message });
```
et le handler global secondaire :
```ts
res.status(status).json({
  error: err?.message || 'Erreur serveur',
  code: err?.code,
  details: err?.meta?.cause || err?.meta?.field_name,   // ← noms de colonnes Prisma
});
```

**Impact :** divulgation de la structure interne (noms de tables/colonnes Prisma, codes `P20xx`, chemins). `auth.routes.ts:109` renvoie en plus le motif exact de l'échec de refresh (« Session révoquée » vs « Session introuvable » vs « Refresh token invalide »), ce qui constitue un oracle utile à un attaquant manipulant des tokens.

**Suggestion :** en production, journaliser `e.message` côté serveur et ne renvoyer qu'un identifiant de corrélation + un message générique. Uniformiser les erreurs de refresh en un seul « Refresh échoué ».

---

#### P1-4 — Aucun durcissement HTTP (`helmet` absent) et rate-limit uniquement sur `/login`

**Fichier :** `backend/src/index.ts:31-41` — la pile de middlewares est `cors` → `express.json` → `cookieParser`. Pas de `helmet`, pas de `X-Frame-Options`, `X-Content-Type-Options`, `HSTS`, ni CSP. Aucun `app.set('trust proxy', ...)`.

Le rate-limit (`auth/rateLimit.ts:12`) ne couvre que `POST /api/auth/login` ; `POST /api/auth/refresh` et **toutes les routes métier** sont illimitées.

**Impact :** clickjacking de la SPA servie par le même process (`index.ts:105`), MIME-sniffing, absence de HSTS. Le compteur anti-brute-force est indexé sur `req.ip` (`rateLimit.ts:13`) : **sans `trust proxy`, derrière un reverse-proxy toutes les requêtes partagent l'IP du proxy** — soit un verrouillage global involontaire, soit (si `trust proxy` est activé sans configuration stricte) un contournement trivial via un en-tête `X-Forwarded-For` forgé. Le stockage en mémoire (`Map`) est aussi remis à zéro à chaque redémarrage.

**Suggestion :** ajouter `helmet()`, configurer `app.set('trust proxy', 1)` de façon cohérente avec le déploiement réel, et poser un `express-rate-limit` global + spécifique sur `/api/auth/refresh`.

---

#### P1-5 — Mots de passe de démonstration faibles et politique de mot de passe insuffisante

**Fichiers :** `backend/prisma/seed.ts:63-65` (`admin/admin123`, `responsable/resp123`, `employe/emp123`) · `backend/prisma/setup-receptionnaire.ts:27` (`bcrypt.hash('Reception123', 10)` — mot de passe **en dur dans le code source versionné**, valide en production : confirmé, la connexion `receptionnaire / Reception123` fonctionne) · `backend/src/routes/users.routes.ts:15` (`password: z.string().min(6).max(200)`)

**Impact :** comptes par défaut prévisibles et documentés dans le dépôt. Combiné à P0-1 (fuite du hash), le cassage est immédiat. `min(6)` sans exigence de complexité, sans blocage des mots de passe communs et sans expiration.

**Suggestion :** forcer un changement de mot de passe au premier login pour les comptes seedés, sortir `Reception123` du code, porter le minimum à 10-12 caractères avec vérification contre une liste de mots de passe courants.

---

### 🟡 P2 — Mineur

---

#### P2-1 — `verifyAccessToken` ne vérifie ni le champ `type` ni l'algorithme

**Fichier :** `backend/src/auth/tokens.ts:29-31`

```ts
export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, ACCESS_SECRET) as AccessTokenPayload;
}
```

**Impact :** aucune option `algorithms: ['HS256']`, `issuer` ni `audience` n'est passée — la validation accepte tout algorithme HMAC compatible avec le secret. Le `type: 'access'` inscrit dans le payload (l.10) n'est **jamais** contrôlé au retour : un refresh token présenté en `Bearer` serait accepté si les secrets venaient à converger. Actuellement non exploitable (les deux secrets diffèrent — vérifié), mais la défense en profondeur manque. Le simple `as AccessTokenPayload` masque l'absence de contrôle.

**Suggestion :**
```ts
const p = jwt.verify(token, ACCESS_SECRET, { algorithms: ['HS256'] }) as AccessTokenPayload;
if (p.type !== 'access') throw new Error('Type de token invalide');
return p;
```

---

#### P2-2 — `POST /api/auth/logout` révoque une session sur `jwt.decode` (signature non vérifiée)

**Fichier :** `backend/src/auth/auth.routes.ts:117-130`

```ts
const jwt = require('jsonwebtoken');
const decoded = jwt.decode(refreshToken);       // ← decode, PAS verify
if (decoded?.jti) await revokeSession(decoded.jti);
```

**Impact :** déni de service ciblé — quiconque connaît ou devine un `jti` peut forger un JWT non signé et révoquer la session d'un autre utilisateur. Le `jti` fait 24 octets aléatoires (`tokens.ts:46`), donc non devinable en pratique, mais tout `jti` observé (log, fuite) devient une arme. Accessoirement, `require()` en plein milieu d'un module ESM/TS est une régression de style alors que `jsonwebtoken` est déjà importable proprement.

**Suggestion :** utiliser `verifyRefreshToken(refreshToken)` et ignorer silencieusement l'échec.

---

#### P2-3 — `GET /api/auth/me` réimplémente `requireAuth` et ignore `isActive`

**Fichier :** `backend/src/auth/auth.routes.ts:136-152`

La route refait manuellement l'extraction du Bearer et la vérification, au lieu d'utiliser le middleware `requireAuth`. Le contrôle est **plus faible** : `if (!user || user.deletedAt)` — **`user.isActive` n'est pas testé**, alors que `middleware.ts:46` le fait (`if (!user || !user.isActive || user.deletedAt)`).

**Impact :** un compte désactivé (`isActive: false`) mais non supprimé conserve l'accès à `/api/auth/me` et récupère son profil complet **ainsi que la liste de ses permissions effectives**, tant que son access token n'a pas expiré (15 min).
De plus l'`include: { sessions: { where: { revokedAt: null } } }` (l.147) charge les sessions (dont les `refreshHash`) inutilement — elles ne sont pas renvoyées dans la réponse, mais la requête est superflue et fragile à un futur `res.json(user)`.

**Suggestion :** monter la route avec `requireAuth` et supprimer l'`include: { sessions }`.

---

#### P2-4 — Coût bcrypt réduit à 6 pour le hachage du refresh token

**Fichier :** `backend/src/auth/tokens.ts:52` — `const refreshHash = await bcrypt.hash(token, 6);`

**Impact :** contre `config.bcryptRounds = 10` pour les mots de passe. En cas de dump de la table `Session`, les hashes de refresh tokens sont ~16× moins coûteux à attaquer. L'entropie du JWT source rend l'attaque peu réaliste, mais l'écart est injustifié.

**Suggestion :** un HMAC-SHA256 avec clé serveur est ici plus approprié et plus rapide que bcrypt (l'entrée est déjà à haute entropie) ; sinon aligner sur `config.bcryptRounds`.

---

#### P2-5 — Swagger UI exposé publiquement sans authentification

**Fichier :** `backend/src/index.ts:56` — `app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));`
**Vérifié :** `GET /api-docs/` → **200** sans aucun token.

**Impact :** cartographie complète et gratuite de la surface d'attaque (toutes les routes, tous les schémas de corps de requête, tous les modules stub). Facilite directement l'exploitation de P0-2 et P0-3.

**Suggestion :** protéger derrière `requireAuth` + `requireRole(Role.ADMIN)`, ou ne le monter que si `config.nodeEnv !== 'production'`.

---

### ⚪ P3 — Cosmétique

---

#### P3-1 — `requireAuth` mélange `try/catch` synchrone et promesse

**Fichier :** `backend/src/auth/middleware.ts:34-65`

Le middleware n'est pas `async` : il enveloppe `verifyAccessToken` dans un `try/catch` puis chaîne un `.then()/.catch()`. Fonctionnellement correct (le `catch` du `.then()` couvre l'erreur DB), mais fragile : toute exception **synchrone** levée à l'intérieur du `.then()` après `next()` sera avalée par le `.catch()` et pourra provoquer un double envoi de réponse (`Cannot set headers after they are sent`).

**Suggestion :** convertir en `async/await` avec un unique `try/catch`, cohérent avec `requirePermission` (l.90) qui est déjà `async`.

---

#### P3-2 — Journalisation console verbeuse et handler d'erreurs dupliqué

**Fichiers :** `backend/src/index.ts:123-126` **et** `:148-157` — **deux** handlers d'erreurs sont enregistrés, le second **après** `app.listen()`. Le premier (générique, sûr) capture tout ; le second (verbeux, qui fuite `err.message` et `err.meta`) n'est donc jamais atteint pour les erreurs propagées normalement. Code mort trompeur qui laisse croire à une fuite pire qu'elle n'est, et inversement empêche de faire confiance au comportement observé.
S'y ajoutent 32 `console.log`/`console.error` dans `src/routes/` et `src/auth/`, et `process.on('uncaughtException')` (l.160) qui **ignore** les exceptions non capturées — le process continue dans un état potentiellement corrompu.

**Suggestion :** ne conserver qu'un seul handler d'erreurs, déclaré avant `listen()` ; remplacer `console.*` par un logger structuré avec niveaux ; sur `uncaughtException`, journaliser puis redémarrer proprement (via un superviseur type systemd/pm2) plutôt que de poursuivre.

---

## (c) Points forts

- **Injection SQL : aucune vulnérabilité trouvée.** Les 4 usages de `$queryRawUnsafe` (`sales.routes.ts:168`, `invoices.routes.ts:113`, `products.routes.ts:69`, `bulletins.routes.ts:425`) sont **paramétrés** (`LIKE $1` + argument séparé) et le préfixe est construit côté serveur à partir de `new Date().getFullYear()` — aucune donnée utilisateur n'atteint la chaîne SQL. Tout le reste passe par le query-builder Prisma.
- **Gestion du refresh token exemplaire** : cookie `httpOnly`, `path` restreint à `/api/auth`, `secure` en production, **hash** stocké en base (jamais le token brut), rotation systématique avec révocation de l'ancienne session (`tokens.ts:72-102`) et vérification de l'expiration côté base en plus du JWT.
- **Modèle de permissions bien conçu** : résolution dynamique rôle − DENY + GRANT par utilisateur (`permissions.ts:16-45`), rechargée à **chaque** requête — la révocation d'un droit est immédiate, sans attendre l'expiration du token. `requirePermission` exige **toutes** les permissions listées (`codes.every`), sémantique restrictive correcte.
- **`requireAuth` recharge l'utilisateur en base** à chaque requête et vérifie `isActive` + `deletedAt` (`middleware.ts:46`) — un compte désactivé perd l'accès sans attendre l'expiration du JWT (sauf sur `/auth/me`, cf. P2-3).
- **Anti-brute-force et audit** : rate-limit login 5/15 min, message d'erreur de login **uniforme** (`Identifiants invalides` que l'utilisateur existe ou non — pas d'énumération de comptes, vérifié), et `auditLog` best-effort sur `LOGIN_SUCCESS` / `LOGIN_FAILED` / `LOGIN_RATE_LIMITED` / mutations utilisateurs.
- **Secrets correctement gérés au niveau du dépôt** : `.env` en `chmod 600`, ignoré par git (`.gitignore:13-15`), seul `.env.example` est versionné avec des valeurs `CHANGE_ME_*` et un `DATABASE_URL` masqué. La fonction `required()` (`config.ts:4-10`) fait échouer le démarrage si un secret manque. Secrets JWT de 46 caractères, distincts entre access et refresh (vérifié).
- **Validation Zod largement appliquée** sur les corps de requête des modules métier (caisse, paiements fournisseurs, bordereaux, réceptions, utilisateurs, login), avec `safeParse` et retour 400 structuré — jamais de `parse()` non protégé.
- **Soft delete généralisé** (`deletedAt`) avec filtrage systématique dans les requêtes, et **cloisonnement des permissions effectif là où il est déclaré** : le compte `receptionnaire` est bien renvoyé en 403 sur `/api/users`, `/api/invoices`, `/api/sales`, `/api/customers`, `/api/supplier-advances` (vérifié en conditions réelles).
- **Limite de taille du corps JSON** à 2 Mo (`index.ts:40`), protection basique contre les payloads abusifs.
