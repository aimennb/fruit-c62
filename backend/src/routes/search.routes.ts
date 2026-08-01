// =====================================================================
// ROUTES RECHERCHE TEXTE (bilingue arabe + français, insensible casse).
//   - GET /api/products/search?q=...   : name/nameAr/nameBer/sku/barcode contains q
//   - GET /api/customers/search?q=...  : name/nameAr/phone/nif/taxId contains q
// Montées AVANT les routers principaux dans index.ts (sinon /:id capture 'search').
// Retour : { items, total } tronqué à 20.
// =====================================================================
import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { requireAuth, requirePermission } from '../auth/middleware';

const MAX = 20;

function parseQ(req: Request): string {
  return typeof req.query.q === 'string' ? req.query.q.trim() : '';
}

// --- Produits --------------------------------------------------------
export const productsSearchRouter = Router();
productsSearchRouter.use(requireAuth);
productsSearchRouter.get('/', requirePermission('PRODUCT_READ'), async (req: Request, res: Response) => {
  const q = parseQ(req);
  const supplierId = typeof req.query.supplierId === 'string' ? req.query.supplierId.trim() : '';
  // Sans fournisseur : comportement historique (q requis).
  if (!q && !supplierId) return res.json({ items: [], total: 0 });
  const where: Prisma.ProductWhereInput = {
    deletedAt: null,
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { nameAr: { contains: q, mode: 'insensitive' } },
            { nameBer: { contains: q, mode: 'insensitive' } },
            { sku: { contains: q, mode: 'insensitive' } },
            { barcode: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
  // FILTRE FOURNISSEUR (Option A) : seuls les produits liés au fournisseur
  // (ProductSupplier) ET ayant AU MOINS UN LOT EN STOCK (remainingQuantity > 0)
  // chez CE fournisseur sont renvoyés. Produit sans lot => masqué.
  if (supplierId) {
    where.stockLots = {
      some: { supplierId, deletedAt: null, remainingQuantity: { gt: new Prisma.Decimal(0) } },
    };
  }
  try {
    const [rows, total] = await Promise.all([
      prisma.product.findMany({
        where,
        select: { id: true, name: true, nameAr: true, nameBer: true, sku: true, barcode: true, suggestedSalePrice: true, unit: { select: { symbol: true } } },
        orderBy: { name: 'asc' },
        take: MAX,
      }),
      prisma.product.count({ where }),
    ]);
    const items = rows.map((p) => ({
      id: p.id,
      name: p.name,
      nameAr: p.nameAr ?? null,
      nameBer: p.nameBer ?? null,
      sku: p.sku ?? null,
      barcode: p.barcode ?? null,
      suggestedSalePrice: p.suggestedSalePrice ? p.suggestedSalePrice.toString() : null,
      unitSymbol: p.unit?.symbol ?? null,
    }));
    res.json({ items, total });
  } catch (e: any) {
    console.error('[products/search] error', e);
    res.status(500).json({ error: 'Erreur recherche produit' });
  }
});

// --- Clients ---------------------------------------------------------
export const customersSearchRouter = Router();
customersSearchRouter.use(requireAuth);
customersSearchRouter.get('/', requirePermission('CUSTOMER_READ'), async (req: Request, res: Response) => {
  const q = parseQ(req);
  if (!q) return res.json({ items: [], total: 0 });
  const where: Prisma.CustomerWhereInput = {
    deletedAt: null,
    OR: [
      { name: { contains: q, mode: 'insensitive' } },
      { nameAr: { contains: q, mode: 'insensitive' } },
      { phone: { contains: q } },
      { nif: { contains: q, mode: 'insensitive' } },
    ],
  };
  try {
    const [rows, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        select: { id: true, name: true, nameAr: true, phone: true, nif: true },
        orderBy: { name: 'asc' },
        take: MAX,
      }),
      prisma.customer.count({ where }),
    ]);
    const items = rows.map((c) => ({
      id: c.id,
      name: c.name,
      nameAr: c.nameAr ?? null,
      phone: c.phone ?? null,
      taxId: c.nif ?? null,
    }));
    res.json({ items, total });
  } catch (e: any) {
    console.error('[customers/search] error', e);
    res.status(500).json({ error: 'Erreur recherche client' });
  }
});

// =====================================================================
// RECHERCHE GLOBALE DOCUMENTS — GET /api/search?q=<terme|EAN13>
//   - q = EAN13 valide (13 chiffres, préfixe 2/3/4) → résolution directe
//     du document (2=Facture, 3=Réception, 4=Bordereau).
//     Retour : { type, id, reference, url } ou 404.
//   - sinon → recherche texte sur référence + client/fournisseur/produit
//     dans les 3 modèles. Retour : { items: [{type,id,reference,label,url}] }
// Utilisé par les barres de recherche des pages /receptions, /bordereaux,
// /ventes (lecteur code-barres USB = saisie clavier).
// =====================================================================
import { isValidEan13, kindFromEan13 } from '../barcode';

export const globalSearchRouter = Router();
globalSearchRouter.use(requireAuth);

const URL_OF = {
  invoice: (id: string) => `/factures/${id}`,
  reception: (id: string) => `/receptions/detail/${id}`,
  bordereau: (id: string) => `/bordereaux/${id}`,
};

globalSearchRouter.get('/', async (req: Request, res: Response) => {
  const q = parseQ(req);
  if (!q) return res.json({ items: [], total: 0 });

  try {
    // --- 1) EAN13 ? -------------------------------------------------
    if (/^\d{13}$/.test(q)) {
      const kind = isValidEan13(q) ? kindFromEan13(q) : null;
      if (!kind) return res.status(404).json({ error: 'Code-barres EAN13 invalide', code: q });
      if (kind === 'invoice') {
        const doc = await prisma.invoice.findFirst({ where: { ean13: q, deletedAt: null }, select: { id: true, reference: true } });
        if (!doc) return res.status(404).json({ error: 'Facture introuvable', code: q });
        return res.json({ type: 'invoice', id: doc.id, reference: doc.reference, url: URL_OF.invoice(doc.id) });
      }
      if (kind === 'reception') {
        const doc = await prisma.supplierReception.findFirst({ where: { ean13: q, deletedAt: null }, select: { id: true, reference: true } });
        if (!doc) return res.status(404).json({ error: 'Réception introuvable', code: q });
        return res.json({ type: 'reception', id: doc.id, reference: doc.reference, url: URL_OF.reception(doc.id) });
      }
      const doc = await prisma.supplierBordereau.findFirst({ where: { ean13: q, deletedAt: null }, select: { id: true, reference: true } });
      if (!doc) return res.status(404).json({ error: 'Bordereau introuvable', code: q });
      return res.json({ type: 'bordereau', id: doc.id, reference: doc.reference, url: URL_OF.bordereau(doc.id) });
    }

    // --- 2) Recherche texte ----------------------------------------
    const ci = { contains: q, mode: 'insensitive' as const };
    const [invoices, receptions, bordereaux] = await Promise.all([
      prisma.invoice.findMany({
        where: {
          deletedAt: null,
          OR: [{ reference: ci }, { customer: { name: ci } }, { customer: { nameAr: ci } }],
        },
        select: { id: true, reference: true, total: true, customer: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: MAX,
      }),
      prisma.supplierReception.findMany({
        where: { deletedAt: null, reference: ci },
        select: { id: true, reference: true, supplierId: true, productId: true },
        orderBy: { createdAt: 'desc' },
        take: MAX,
      }),
      prisma.supplierBordereau.findMany({
        where: { deletedAt: null, reference: ci },
        select: { id: true, reference: true, statut: true, supplierId: true, productId: true },
        orderBy: { createdAt: 'desc' },
        take: MAX,
      }),
    ]);

    // Recherche complémentaire réception/bordereau par nom fournisseur/produit.
    const [supMatch, prodMatch] = await Promise.all([
      prisma.supplier.findMany({ where: { deletedAt: null, OR: [{ name: ci }, { nameAr: ci }] }, select: { id: true, name: true } }),
      prisma.product.findMany({ where: { deletedAt: null, OR: [{ name: ci }, { nameAr: ci }] }, select: { id: true, name: true } }),
    ]);
    const supIds = supMatch.map((s) => s.id);
    const prodIds = prodMatch.map((p) => p.id);
    if (supIds.length || prodIds.length) {
      const extraWhere: any = { deletedAt: null, OR: [] as any[] };
      if (supIds.length) extraWhere.OR.push({ supplierId: { in: supIds } });
      if (prodIds.length) extraWhere.OR.push({ productId: { in: prodIds } });
      const [er, eb] = await Promise.all([
        prisma.supplierReception.findMany({ where: extraWhere, select: { id: true, reference: true, supplierId: true, productId: true }, take: MAX }),
        prisma.supplierBordereau.findMany({ where: extraWhere, select: { id: true, reference: true, statut: true, supplierId: true, productId: true }, take: MAX }),
      ]);
      for (const r of er) if (!receptions.some((x) => x.id === r.id)) receptions.push(r as any);
      for (const b of eb) if (!bordereaux.some((x) => x.id === b.id)) bordereaux.push(b as any);
    }

    const supName = new Map(supMatch.map((s) => [s.id, s.name]));
    const prodName = new Map(prodMatch.map((p) => [p.id, p.name]));

    const items = [
      ...invoices.map((i) => ({
        type: 'invoice' as const,
        id: i.id,
        reference: i.reference,
        label: `Facture ${i.reference}${i.customer?.name ? ' — ' + i.customer.name : ''}`,
        url: URL_OF.invoice(i.id),
      })),
      ...receptions.map((r) => ({
        type: 'reception' as const,
        id: r.id,
        reference: r.reference,
        label: `Réception ${r.reference}${supName.get(r.supplierId) ? ' — ' + supName.get(r.supplierId) : ''}`,
        url: URL_OF.reception(r.id),
      })),
      ...bordereaux.map((b) => ({
        type: 'bordereau' as const,
        id: b.id,
        reference: b.reference,
        label: `Bordereau ${b.reference}${supName.get(b.supplierId) ? ' — ' + supName.get(b.supplierId) : ''}${prodName.get(b.productId) ? ' / ' + prodName.get(b.productId) : ''}`,
        url: URL_OF.bordereau(b.id),
      })),
    ].slice(0, MAX * 2);

    res.json({ items, total: items.length });
  } catch (e: any) {
    console.error('[search] error', e);
    res.status(500).json({ error: 'Erreur recherche', message: e?.message });
  }
});
