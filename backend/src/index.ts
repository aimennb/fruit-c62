import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import path from 'path';
import { config } from './config';
import { prisma } from './prisma';
import { swaggerSpec } from './swagger';
import swaggerUi from 'swagger-ui-express';
import authRoutes from './auth/auth.routes';
import usersRoutes from './routes/users.routes';
import productsRoutes from './routes/products.routes';
import suppliersRoutes from './routes/suppliers.routes';
import customersRoutes from './routes/customers.routes';
import supplierAdvancesRoutes from './routes/supplier-advances.routes';
import supplierReceptionsRoutes from './routes/supplier-receptions.routes';
import supplierBordereauxRoutes from './routes/supplier-bordereaux.routes';
import stockLotsRoutes from './routes/stock-lots.routes';
import productCategoriesRoutes from './routes/product-categories.routes';
import unitsRoutes from './routes/units.routes';
import paymentsRoutes from './routes/payments.routes';
import cashRegisterRoutes from './routes/cash-register.routes';
import { buildStubRouters } from './routes/stub.routes';
import bulletinsRoutes from './bulletins/bulletins.routes';
import stockRoutes from './routes/stock.routes';
import salesRoutes from './routes/sales.routes';
import invoicesRoutes from './routes/invoices.routes';
import { productsSearchRouter, customersSearchRouter, globalSearchRouter } from './routes/search.routes';
import { requireAuth } from './auth/middleware';

const app = express();

// --- Middlewares -----------------------------------------------------
app.use(
  cors({
    origin: config.corsOrigin,
    credentials: true,
  }),
);
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// --- Health check ----------------------------------------------------
app.get('/api/health', async (_req, res) => {
  let db = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = true;
  } catch {
    db = false;
  }
  res.json({ status: 'ok', db, time: new Date().toISOString() });
});

// --- Swagger ---------------------------------------------------------
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// --- Auth ------------------------------------------------------------
app.use('/api/auth', authRoutes);

// --- Recherche texte bilingue (AR+FR) — AVANT les routers /:id --------
app.use('/api/products/search', productsSearchRouter);
app.use('/api/customers/search', customersSearchRouter);
app.use('/api/search', globalSearchRouter);

// --- Ressources implémentées (Phase A) -------------------------------
app.use('/api/users', usersRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/suppliers', suppliersRoutes);
app.use('/api/customers', customersRoutes);
app.use('/api/supplier-advances', supplierAdvancesRoutes);
app.use('/api/supplier-receptions', supplierReceptionsRoutes);
app.use('/api/supplier-bordereaux', supplierBordereauxRoutes);
app.use('/api/stock-lots', stockLotsRoutes);
app.use('/api/product-categories', productCategoriesRoutes);
app.use('/api/units', unitsRoutes);

// --- Bulletins d'achat bilingues (Phase B.2) -------------------------
app.use('/api/bulletins', bulletinsRoutes);

// --- Stocks / lots / pertes (Phase B.3) ------------------------------
app.use('/api/stock', stockRoutes);

// --- Ventes + sortie de stock FIFO (Phase C) -------------------------
app.use('/api/sales', salesRoutes);

// --- Factures de vente + PDF bilingue FR/AR (Phase C) ---------------
app.use('/api/invoices', invoicesRoutes);

// --- Encaissements client + relevé + crédit (Phase C) ---------------
app.use('/api/payments', paymentsRoutes);

// --- Module CAISSE (Temps 1) ----------------------------------------
app.use('/api/cash-register', cashRegisterRoutes);

// --- Stubs documentés (modules métier Phase B/C/D) -------------------
for (const { path, router } of buildStubRouters()) {
  app.use(path, router);
}

// --- Racine : sert le frontend React buildé (app complète) ----------
const frontendDist = path.join(__dirname, '..', '..', '..', 'frontend', 'dist');
app.use(express.static(frontendDist));
// Page de test de connexion accessible sur /test (au lieu de la racine).
app.get('/test', (_req, res) => {
  res.send(loginTestPageHtml());
});
// TVP SPA : toute route non-API renvoie index.html du frontend.
app.get(/^(?!\/api|\/test).*/, (_req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'), (err) => {
    if (err) res.status(404).send('Frontend non buildé. Lance: cd frontend && npm run build');
  });
});

// --- 404 -------------------------------------------------------------
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Route introuvable', path: req.originalUrl });
});

// --- Gestion d'erreurs globale ---------------------------------------
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Erreur serveur interne' });
});

// --- Démarrage -------------------------------------------------------
const server = app.listen(config.port, () => {
  console.log(`[fruiterie] serveur en écoute sur http://localhost:${config.port}`);
  console.log(`[fruiterie] swagger: http://localhost:${config.port}/api-docs`);
});

server.on('error', (e) => {
  console.error('[fruiterie] échec démarrage serveur:', e.message);
  process.exit(1);
});

// Graceful shutdown : fermer Prisma proprement.
process.on('SIGINT', async () => {
  await prisma.$disconnect();
  server.close(() => process.exit(0));
});

// --- Gestionnaire d'erreur GLOBAL : aucune exception ne doit tuer le serveur.
// Toute erreur non attrapée dans une route renvoie un JSON 500 propre
// (et non un crash process qui coupe la connexion = "NetworkError" côté front).
app.use((err: any, _req: any, res: any, _next: any) => {
  if (!res.headersSent) {
    const status = err?.status || (err?.code === 'P2025' || err?.code === 'P2003' ? 400 : 500);
    res.status(status).json({
      error: err?.message || 'Erreur serveur',
      code: err?.code,
      details: err?.meta?.cause || err?.meta?.field_name || undefined,
    });
  }
});

// Protection process : on ne meurt JAMAIS sur une exception asynchrone.
process.on('uncaughtException', (e) => {
  console.error('[fruiterie] uncaughtException (ignoré pour ne pas tuer le serveur):', e?.message);
});
process.on('unhandledRejection', (e: any) => {
  console.error('[fruiterie] unhandledRejection (ignoré pour ne pas tuer le serveur):', e?.message);
});

export default app;

// =====================================================================
// Page HTML minimale pour vérification navigateur (login test).
// =====================================================================
function loginTestPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="fr" dir="ltr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Fruiterie ERP — Test de connexion v3</title>
  <style>
    :root { --green:#1b7a3d; --bg:#f4f7f4; }
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: var(--bg); color:#1c2b22; margin:0; padding:24px; }
    .card { max-width:520px; margin:40px auto; background:#fff; border:1px solid #e2e8e4; border-radius:14px; padding:28px; box-shadow:0 4px 18px rgba(0,0,0,.06); }
    h1 { color: var(--green); margin-top:0; }
    label { display:block; font-size:13px; font-weight:600; margin:14px 0 4px; }
    input { width:100%; padding:10px 12px; border:1px solid #cbd5cf; border-radius:8px; font-size:14px; }
    button { margin-top:18px; width:100%; background:var(--green); color:#fff; border:0; padding:12px; border-radius:8px; font-size:15px; font-weight:600; cursor:pointer; }
    button:hover { filter:brightness(1.05); }
    pre { background:#0f1b14; color:#b8f5cf; padding:14px; border-radius:8px; overflow:auto; font-size:12px; max-height:260px; }
    .row { display:flex; gap:8px; flex-wrap:wrap; }
    .row button { margin-top:8px; }
    .hint { font-size:12px; color:#5b6b62; }
    .rtl-toggle { font-size:12px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🍎 Fruiterie ERP — Connexion test</h1>
    <p class="hint">Backend local sur le port ${config.port}. Utilisez un compte de démo (admin / responsable / employe).</p>
    <label>Identifiant</label>
    <input id="username" value="admin" />
    <label>Mot de passe</label>
    <input id="password" type="password" value="admin123" />
    <button id="login">Se connecter</button>
    <div class="row">
      <button id="me" style="background:#334155">Voir /api/auth/me</button>
      <button id="switchRtl" class="rtl-toggle" style="background:#7c3aed">Basculer RTL (arabe)</button>
    </div>
    <h3>Résultat</h3>
    <pre id="out">En attente...</pre>
  </div>
  <script>
    const API = '';
    window.addEventListener('error', (ev) => {
      const o = document.getElementById('out');
      if (o) o.textContent = 'JS ERROR: ' + (ev.message || ev.error) + ' @ ' + (ev.filename||'') + ':' + (ev.lineno||'');
    });
    async function login() {
      const out = document.getElementById('out');
      out.textContent = 'Requête en cours...';
      try {
        const r = await fetch(API + '/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            username: document.getElementById('username').value,
            password: document.getElementById('password').value,
          }),
        });
        const data = await r.json();
        out.textContent = JSON.stringify(data, null, 2);
        if (data.accessToken) { out.dataset.token = data.accessToken; out.dataset.role = data.user.role; }
      } catch (e) { out.textContent = 'Erreur: ' + (e && e.message ? e.message : e); }
    }
    async function me() {
      const out = document.getElementById('out');
      const token = out.dataset.token;
      if (!token) { out.textContent = 'Connectez-vous d\'abord.'; return; }
      try {
        const r = await fetch(API + '/api/auth/me', { headers: { Authorization: 'Bearer ' + token } });
        const data = await r.json();
        out.textContent = JSON.stringify(data, null, 2);
      } catch (e) { out.textContent = 'Erreur: ' + e.message; }
    }
    document.getElementById('login').onclick = login;
    document.getElementById('me').onclick = me;
    document.getElementById('switchRtl').onclick = () => {
      const html = document.documentElement;
      html.dir = html.dir === 'rtl' ? 'ltr' : 'rtl';
    };
  </script>
</body>
</html>`;
}
