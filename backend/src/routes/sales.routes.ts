// =====================================================================
// ROUTES VENTES (Phase C — module VENTE + SORTIE DE STOCK FIFO).
//   - POST /api/sales                 : crée une vente (brouillon) + lignes, référence auto 'V-YYYY-0001'
//   - POST /api/sales/:id/confirm     : CONFIRME = SORTIE DE STOCK FIFO (StockLot.remainingQuantity--, StockMovement OUT)
//   - GET  /api/sales                 : liste paginée (customer + items + produits)
//   - GET  /api/sales/:id             : détail
//   - PUT  /api/sales/:id             : maj (seulement si DRAFT)
//   - DELETE /api/sales/:id           : soft delete (si DRAFT)
//
// Règle d'or : toute mutation ($transaction), Decimal jamais float, try/catch -> JSON (400 FK/P2025/P2003, 500 sinon).
// =====================================================================
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { requireAuth, requirePermission } from '../auth/middleware';
import { auditLog } from '../auth/audit';
import { dec, parseListQuery, paginate } from './_helpers';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------
// Schémas de validation (zod)
// ---------------------------------------------------------------------
const decimal = z.union([z.string(), z.number()]).transform((v) => new Prisma.Decimal(v).toString());

const itemSchema = z.object({
  productId: z.string().min(1),
  // FOURNISSEUR PAR LIGNE (Option A) : chaque ligne porte son fournisseur ;
  // le lot FIFO est résolu PAR LIGNE (supplierId + productId). Le fournisseur
  // est persisté via le lotId résolu (StockLot.supplierId).
  supplierId: z.string().min(1).optional(),
  // CALIBRE (optionnel) : restreint la résolution FIFO au lot du calibre choisi.
  caliber: z.string().min(1).optional(),
  lotId: z.string().optional(),
  quantity: decimal.optional(),
  unitPrice: decimal.default('0'),
  // Champs bulletin de vente (grossiste) : Colis / Brut / Tare / Net.
  colis: decimal.optional(),
  grossWeight: decimal.optional(),
  tare: decimal.optional(),
  netWeight: decimal.optional(),
}).refine(
  (it) => (it.netWeight !== undefined && new Prisma.Decimal(it.netWeight).gt(0)) || (it.quantity !== undefined && new Prisma.Decimal(it.quantity).gt(0)),
  'quantity ou netWeight > 0 requis',
);

const createSchema = z.object({
  customerId: z.string().min(1).optional(),
  customerName: z.string().optional(),
  supplierId: z.string().min(1).optional(), // DEPRECATED (Option A) : fournisseur global remplacé par item.supplierId
  date: z.string().datetime().optional(),
  reference: z.string().min(1).max(60).optional(),
  notes: z.string().max(2000).optional(),
  items: z.array(itemSchema).min(1, 'Au moins une ligne requise'),
});

const updateSchema = z.object({
  customerId: z.string().min(1).optional(),
  date: z.string().datetime().optional(),
  reference: z.string().min(1).max(60).optional(),
  notes: z.string().max(2000).optional(),
  items: z.array(itemSchema).min(1).optional(),
});

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/** Sérialise une vente (customer {id,name} + items avec product {id,name}). */
function serializeSale(s: any) {
  return {
    id: s.id,
    reference: s.reference,
    date: s.date,
    status: s.status,
    subtotal: dec(s.subtotal),
    total: dec(s.total),
    notes: s.notes ?? null,
    customer: s.customer ? { id: s.customer.id, name: s.customer.name } : null,
    supplierId: s.supplierId ?? null,
    supplier: s.supplier ? { id: s.supplier.id, name: s.supplier.name } : null,
    items: (s.items || []).map((it: any) => ({
      id: it.id,
      productId: it.productId,
      lotId: it.lotId ?? null,
      quantity: dec(it.quantity),
      unitPrice: dec(it.unitPrice),
      total: dec(it.total),
      colis: dec(it.colis),
      grossWeight: dec(it.grossWeight),
      tare: dec(it.tare),
      netWeight: dec(it.netWeight),
      product: it.product ? { id: it.product.id, name: it.product.name, nameAr: it.product.nameAr ?? null } : null,
    })),
  };
}

/**
 * Calcule une ligne au format bulletin de vente (grossiste).
 * - netWeight = poids net (= quantité vendue). Si absent, on prend quantity.
 * - quantity  = netWeight (le 'Poids net' EST la quantité vendue) si netWeight fourni, sinon quantity.
 * - total     = netWeight * unitPrice (Decimal).
 */
function computeItem(it: z.infer<typeof itemSchema>) {
  const colis = new Prisma.Decimal(it.colis ?? '0');
  const grossWeight = new Prisma.Decimal(it.grossWeight ?? '0');
  const tare = new Prisma.Decimal(it.tare ?? '0');
  // netWeight explicite, sinon quantity, sinon (brut - tare*colis).
  let netWeight: Prisma.Decimal;
  if (it.netWeight !== undefined) netWeight = new Prisma.Decimal(it.netWeight);
  else if (it.quantity !== undefined) netWeight = new Prisma.Decimal(it.quantity);
  else netWeight = grossWeight.minus(tare.times(colis));
  const qty = netWeight; // le poids net est la quantité vendue
  const price = new Prisma.Decimal(it.unitPrice);
  const total = qty.times(price).toDecimalPlaces(2);
  return {
    productId: it.productId,
    supplierId: it.supplierId,
    caliber: it.caliber,
    lotId: it.lotId,
    quantity: qty,
    unitPrice: price,
    total,
    colis,
    grossWeight,
    tare,
    netWeight,
  };
}

/** Charge une vente avec customer + items + produits. */
async function loadSale(id: string) {
  return prisma.sale.findFirst({
    where: { id, deletedAt: null },
    include: {
      customer: { select: { id: true, name: true } },
      supplier: { select: { id: true, name: true } },
      items: { where: { deletedAt: null }, include: { product: { select: { id: true, name: true, nameAr: true } } } },
    },
  });
}

/**
 * Résout le lot FIFO (fournisseur + produit) : 1er StockLot non supprimé
 * avec supplierId + productId + remainingQuantity > 0, trié par arrivalDate asc.
 * Retourne le lotId ou null si aucun lot dispo.
 */
async function resolveFifoLot(
  supplierId: string,
  productId: string,
  calibre?: string | null,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<string | null> {
  const lot = await client.stockLot.findFirst({
    where: { supplierId, productId, deletedAt: null, remainingQuantity: { gt: new Prisma.Decimal(0) }, ...(calibre ? { caliber: calibre } : {}) },
    orderBy: { arrivalDate: 'asc' },
    select: { id: true },
  });
  return lot?.id ?? null;
}

/** Numérotation ventes (style 'V-2026-0001') via queryRawUnsafe comme bulletins nextLotNumber. */
async function nextSaleReference(tx: Prisma.TransactionClient): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `V-${year}-`;
  const rows = await tx.$queryRawUnsafe<{ reference: string }[]>(
    `SELECT "reference" FROM "Sale" WHERE "reference" LIKE $1 ORDER BY "reference" DESC LIMIT 1`,
    prefix + '%',
  );
  let next = 1;
  if (rows.length > 0) {
    const num = rows[0].reference.slice(prefix.length).replace(/\D/g, '');
    next = parseInt(num || '0', 10) + 1;
  }
  return `${prefix}${String(next).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------
// POST /api/sales — création brouillon + lignes (calcul serveur)
// ---------------------------------------------------------------------
/**
 * @openapi
 * /api/sales:
 *   post:
 *     summary: Crée une vente (brouillon DRAFT) avec ses lignes
 *     tags: [Sales]
 *     security: [{ bearerAuth: [] }]
 */
router.post('/', requirePermission('SALE_WRITE'), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });

  const data = parsed.data;

  // Vérif produits existants (non soft-deleted)
  const productIds = Array.from(new Set(data.items.map((i) => i.productId)));
  const products = await prisma.product.findMany({ where: { id: { in: productIds }, deletedAt: null }, select: { id: true } });
  if (products.length !== productIds.length) {
    return res.status(400).json({ error: 'Produit introuvable', details: 'Un ou plusieurs productId sont invalides' });
  }

  // Vérif client (si fourni) + AUTO-CLIENT SILENCIEUX
  let resolvedCustomerId: string | null = null;
  if (data.customerId) {
    const cust = await prisma.customer.findFirst({ where: { id: data.customerId, deletedAt: null }, select: { id: true } });
    if (cust) resolvedCustomerId = cust.id;
  }
  // Si aucun client valide résolu mais customerName fourni non vide, on crée
  // (ou réutilise par nom) un Customer et on le lie — pas d'erreur 400.
  if (!resolvedCustomerId && data.customerName && data.customerName.trim()) {
    const name = data.customerName.trim();
    const existingByName = await prisma.customer.findFirst({ where: { name, deletedAt: null }, select: { id: true } });
    if (existingByName) {
      resolvedCustomerId = existingByName.id;
    } else {
      const created = await prisma.customer.create({
        data: { name, phone: '—', createdBy: req.user!.id, updatedBy: req.user!.id },
      });
      resolvedCustomerId = created.id;
    }
  }

  // Calcul des lignes + totaux (Decimal) — fait AVANT le check stock car quantity = netWeight.
  const computed = data.items.map(computeItem);

  // RÉSOLUTION LOT FIFO PAR LIGNE : si une ligne n'a pas de lotId, on le résout
  // via le 1er lot FIFO (fournisseur DE LA LIGNE + produit, remainingQuantity>0).
  for (const c of computed) {
    if (!c.lotId) {
      const lineSupplier = c.supplierId ?? data.supplierId;
      if (lineSupplier) {
        const fifo = await resolveFifoLot(lineSupplier, c.productId, c.caliber ?? null);
        if (fifo) c.lotId = fifo;
      }
    }
  }

  // NOTE: pas de vérification de stock à la CRÉATION (brouillon) — la vérif
  // stock est faite à la CONFIRMATION (POST /:id/confirm, sortie FIFO réelle).

  const subtotal = computed.reduce((acc, c) => acc.plus(c.total), new Prisma.Decimal(0)).toDecimalPlaces(2);
  const total = subtotal; // pas de taxe sur la vente brute pour l'instant

  try {
    const reference = data.reference || (await prisma.$transaction((tx) => nextSaleReference(tx)));

    const sale = await prisma.sale.create({
      data: {
        reference,
        customerId: resolvedCustomerId,
        supplierId: data.supplierId ?? null,
        date: data.date ? new Date(data.date) : new Date(),
        status: 'DRAFT',
        subtotal,
        total,
        notes: data.notes ?? null,
        createdBy: req.user!.id,
        updatedBy: req.user!.id,
        items: {
          create: computed.map((c) => ({
            productId: c.productId,
            lotId: c.lotId ?? null,
            quantity: c.quantity,
            unitPrice: c.unitPrice,
            total: c.total,
            colis: c.colis,
            grossWeight: c.grossWeight,
            tare: c.tare,
            netWeight: c.netWeight,
            createdBy: req.user!.id,
            updatedBy: req.user!.id,
          })),
        },
      },
      include: {
        customer: { select: { id: true, name: true } },
        supplier: { select: { id: true, name: true } },
        items: { include: { product: { select: { id: true, name: true, nameAr: true } } } },
      },
    });

    auditLog({ userId: req.user!.id, action: 'SALE_CREATE', entity: 'Sale', entityId: sale.id, req }).catch(() => {});
    res.status(201).json(serializeSale(sale));
  } catch (e: any) {
    if (e?.code === 'P2002') return res.status(409).json({ error: 'Référence de vente déjà utilisée' });
    if (e?.code === 'P2003' || e?.code === 'P2025') return res.status(400).json({ error: 'Référence ou clé étrangère invalide', message: e?.meta?.cause || e?.message });
    console.error('[sales] create error', e);
    res.status(500).json({ error: 'Erreur création vente' });
  }
});

// ---------------------------------------------------------------------
// GET /api/sales — liste paginée (customer + items + produits)
// ---------------------------------------------------------------------
/**
 * @openapi
 * /api/sales:
 *   get:
 *     summary: Liste paginée des ventes
 *     tags: [Sales]
 *     security: [{ bearerAuth: [] }]
 */
router.get('/', requirePermission('SALE_READ'), async (req: Request, res: Response) => {
  const { page, take, skip, q } = parseListQuery(req);
  const where: Prisma.SaleWhereInput = {
    deletedAt: null,
    ...(q
      ? {
          OR: [
            { reference: { contains: q } },
            { customer: { name: { contains: q } } },
            { invoices: { some: { reference: { contains: q }, deletedAt: null } } },
          ],
        }
      : {}),
  };
  try {
    const total = await prisma.sale.count({ where });
    const sales = await prisma.sale.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true } },
        supplier: { select: { id: true, name: true } },
        items: { where: { deletedAt: null }, include: { product: { select: { id: true, name: true } } } },
      },
      orderBy: { date: 'desc' },
      skip,
      take,
    });
    res.json(paginate(sales.map(serializeSale), total, page, take));
  } catch (e: any) {
    console.error('[sales] list error', e);
    res.status(500).json({ error: 'Erreur liste ventes' });
  }
});

// ---------------------------------------------------------------------
// GET /api/sales/:id — détail
// ---------------------------------------------------------------------
router.get('/:id', requirePermission('SALE_READ'), async (req: Request, res: Response) => {
  const s = await loadSale(req.params.id);
  if (!s) return res.status(404).json({ error: 'Vente introuvable' });
  res.json(serializeSale(s));
});

// ---------------------------------------------------------------------
// GET /api/sales/:id/invoice — renvoie la facture liée à la vente (si elle existe)
// ---------------------------------------------------------------------
router.get('/:id/invoice', requirePermission('SALE_READ'), async (req: Request, res: Response) => {
  const saleId = req.params.id;
  const sale = await prisma.sale.findFirst({ where: { id: saleId, deletedAt: null }, select: { id: true } });
  if (!sale) return res.status(404).json({ error: 'Vente introuvable' });
  const inv = await prisma.invoice.findFirst({
    where: { saleId, deletedAt: null },
    include: { items: { where: { deletedAt: null } }, customer: true },
  });
  if (!inv) return res.status(404).json({ error: 'Aucune facture liée à cette vente', saleId });
  res.json({
    id: inv.id,
    reference: inv.reference,
    status: inv.status,
    saleId: inv.saleId,
    issueDate: inv.issueDate?.toISOString?.() ?? null,
    dueDate: inv.dueDate?.toISOString?.() ?? null,
    subtotal: dec(inv.subtotal),
    taxAmount: dec(inv.taxAmount),
    total: dec(inv.total),
    notes: inv.notes ?? null,
    customer: inv.customer ? { id: inv.customer.id, name: inv.customer.name, nameAr: inv.customer.nameAr ?? null } : null,
    items: (inv.items ?? []).map((it: any) => ({
      id: it.id,
      description: it.description,
      quantity: dec(it.quantity),
      unitPrice: dec(it.unitPrice),
      total: dec(it.total),
    })),
  });
});

// ---------------------------------------------------------------------
// PUT /api/sales/:id — mise à jour (seulement si DRAFT)
// ---------------------------------------------------------------------
router.put('/:id', requirePermission('SALE_WRITE'), async (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });

  const sale = await loadSale(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Vente introuvable' });
  if (sale.status !== 'DRAFT') return res.status(400).json({ error: 'Seule une vente DRAFT peut être modifiée' });

  const data = parsed.data;

  // Vérif produits (si items fournis)
  if (data.items) {
    const productIds = Array.from(new Set(data.items.map((i) => i.productId)));
    const products = await prisma.product.findMany({ where: { id: { in: productIds }, deletedAt: null }, select: { id: true } });
    if (products.length !== productIds.length) {
      return res.status(400).json({ error: 'Produit introuvable' });
    }
  }
  if (data.customerId) {
    const cust = await prisma.customer.findFirst({ where: { id: data.customerId, deletedAt: null }, select: { id: true } });
    if (!cust) return res.status(400).json({ error: 'Client introuvable' });
  }

  try {
    // Recalcul si items fournis
    let itemsData: z.infer<typeof itemSchema>[] | null = null;
    let subtotal = new Prisma.Decimal(sale.subtotal);
    let total = new Prisma.Decimal(sale.total);
    if (data.items) {
      const computed = data.items.map(computeItem);
      subtotal = computed.reduce((acc, c) => acc.plus(c.total), new Prisma.Decimal(0)).toDecimalPlaces(2);
      total = subtotal;
      itemsData = data.items;
      await prisma.saleItem.deleteMany({ where: { saleId: sale.id } });
    }

    const updated = await prisma.sale.update({
      where: { id: sale.id },
      data: {
        customerId: data.customerId !== undefined ? (data.customerId ?? null) : sale.customerId,
        date: data.date ? new Date(data.date) : sale.date,
        reference: data.reference ?? sale.reference,
        notes: data.notes !== undefined ? (data.notes ?? null) : sale.notes,
        subtotal,
        total,
        updatedBy: req.user!.id,
        items: itemsData
          ? {
              create: itemsData.map((it) => {
                const c = computeItem(it);
                return {
                  productId: c.productId,
                  lotId: c.lotId ?? null,
                  quantity: c.quantity,
                  unitPrice: c.unitPrice,
                  total: c.total,
                  colis: c.colis,
                  grossWeight: c.grossWeight,
                  tare: c.tare,
                  netWeight: c.netWeight,
                  createdBy: req.user!.id,
                  updatedBy: req.user!.id,
                };
              }),
            }
          : undefined,
      },
      include: {
        customer: { select: { id: true, name: true } },
        items: { include: { product: { select: { id: true, name: true, nameAr: true } } } },
      },
    });

    res.json(serializeSale(updated));
  } catch (e: any) {
    if (e?.code === 'P2003' || e?.code === 'P2025') return res.status(400).json({ error: 'Clé étrangère invalide', message: e?.meta?.cause || e?.message });
    console.error('[sales] update error', e);
    res.status(500).json({ error: 'Erreur mise à jour vente' });
  }
});

// ---------------------------------------------------------------------
// DELETE /api/sales/:id — soft delete (si DRAFT)
// ---------------------------------------------------------------------
router.delete('/:id', requirePermission('SALE_WRITE'), async (req: Request, res: Response) => {
  const sale = await loadSale(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Vente introuvable' });
  if (sale.status !== 'DRAFT') return res.status(400).json({ error: 'Seule une vente DRAFT peut être supprimée' });
  try {
    await prisma.sale.update({ where: { id: sale.id }, data: { deletedAt: new Date(), updatedBy: req.user!.id } });
    auditLog({ userId: req.user!.id, action: 'SALE_DELETE', entity: 'Sale', entityId: sale.id, req }).catch(() => {});
    res.json({ message: 'Vente supprimée (soft delete)' });
  } catch (e: any) {
    console.error('[sales] delete error', e);
    res.status(500).json({ error: 'Erreur suppression vente' });
  }
});

// ---------------------------------------------------------------------
// POST /api/sales/:id/confirm — CONFIRMATION = SORTIE DE STOCK FIFO
// ---------------------------------------------------------------------
/**
 * @openapi
 * /api/sales/{id}/confirm:
 *   post:
 *     summary: Confirme la vente = sortie de stock FIFO (StockLot.remainingQuantity--, StockMovement OUT), passe en CONFIRMED
 *     tags: [Sales]
 *     security: [{ bearerAuth: [] }]
 */
router.post('/:id/confirm', requirePermission('SALE_WRITE'), async (req: Request, res: Response) => {
  const saleId = req.params.id;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const sale = await tx.sale.findUnique({
        where: { id: saleId },
        include: {
          items: { include: { product: { select: { id: true, name: true } } } },
        },
      });
      if (!sale) throw Object.assign(new Error('Vente introuvable'), { status: 404 });
      if (sale.deletedAt) throw Object.assign(new Error('Vente introuvable'), { status: 404 });
      if (sale.status !== 'DRAFT') {
        throw Object.assign(new Error(`Vente déjà ${sale.status} — seul un brouillon DRAFT est confirmable`), { status: 400 });
      }
      if (!sale.items.length) throw Object.assign(new Error('Vente sans ligne'), { status: 400 });

      const movements: { productId: string; lotId: string; quantity: Prisma.Decimal }[] = [];
      const productNames = new Map<string, string>();
      // Lot principal (1er lot FIFO touché) par ligne de vente -> permet de relier
      // la ligne à un StockLot, donc au bordereau fournisseur (getSalesLines(lotId)).
      const itemPrimaryLot = new Map<string, string>();

      // Pour chaque ligne : FIFO sur les lots du produit (arrivage asc, restant > 0)
      for (const it of sale.items) {
        const productId = it.productId;
        productNames.set(productId, it.product.name);
        // Sortie de stock basée sur le NOMBRE DE COLIS (stock en caisses), fallback quantity si colis absent
        const colisQty = it.colis != null ? new Prisma.Decimal(it.colis) : new Prisma.Decimal(it.quantity);
        let remainingToTake = colisQty;

        // LOT RÉSOLU (auto-FIFO côté createSale, ou explicite) : on utilise CE lot.
        // NOUVEAU MODÈLE (chef, juillet 2026) : FIFO STRICT + BLOCAGE si la quantité
        // dépasse le stock du lot. On décrémente remainingQuantity et on bloque si
        // insuffisant. (Exception : un lot déjà à 0 est accepté sans décrément pour
        // conserver la compat vente-bordereau, mais toute demande > 0 sur un lot à 0
        // est bloquée.)
        if ((it as any).lotId) {
          const explicitLotId = (it as any).lotId as string;
          const lot = await tx.stockLot.findFirst({ where: { id: explicitLotId, deletedAt: null } });
          if (!lot) {
            throw Object.assign(new Error(`Lot introuvable pour ${it.product.name}`), { status: 400 });
          }
          const lotRemaining = new Prisma.Decimal(lot.remainingQuantity);

          // COMPAT BORDEREAU : lot figé déjà à 0 -> on trace le mouvement sans
          // décrémenter, mais on bloque toute demande > 0 (on ne puise pas ailleurs
          // dans ce cas de conservation de compat).
          if (lotRemaining.lte(0)) {
            if (remainingToTake.gt(0)) {
              throw Object.assign(
                new Error(`Stock insuffisant pour ${it.product.name} : 0 colis disponibles`),
                { status: 400 },
              );
            }
            movements.push({ productId, lotId: explicitLotId, quantity: colisQty });
            itemPrimaryLot.set(it.id, explicitLotId);
            continue;
          }

          // FIFO STRICT par (produit + fournisseur du lot figé) : on puise dans
          // tous les lots du MÊME fournisseur, du plus ancien au plus récent.
          // On NE puit JAMAIS chez un autre fournisseur.
          const supplierId = lot.supplierId;
          let lots = await tx.stockLot.findMany({
            where: { productId, supplierId, deletedAt: null, remainingQuantity: { gt: new Prisma.Decimal(0) } },
            orderBy: { arrivalDate: 'asc' }, // FIFO : plus ancien d'abord
          });
          // Forcer le lot figé en tête (il est déjà le plus ancien en FIFO asc ;
          // s'il n'y est pas — ex. à 0, déjà géré plus haut — on le réinsère en tête).
          if (!lots.find((l) => l.id === explicitLotId)) {
            lots = [lot, ...lots];
          }

          // Stock dispo total pour ce (produit + fournisseur) -> FIFO multi-lots.
          const available = lots.reduce((acc, l) => acc.plus(new Prisma.Decimal(l.remainingQuantity)), new Prisma.Decimal(0));
          if (available.lt(remainingToTake)) {
            throw Object.assign(
              new Error(`Stock insuffisant pour ${it.product.name} (fournisseur ${supplierId ?? '—'}) : ${available.toString()} colis disponibles (demandé ${remainingToTake.toString()})`),
              { status: 400 },
            );
          }

          // Itère sur la liste FIFO et décrémente remainingQuantity par prise.
          for (const l of lots) {
            if (remainingToTake.lte(0)) break;
            const lr = new Prisma.Decimal(l.remainingQuantity);
            if (lr.lte(0)) continue;
            const take = remainingToTake.gt(lr) ? lr : remainingToTake;

            await tx.stockLot.update({
              where: { id: l.id },
              data: { remainingQuantity: lr.minus(take).toDecimalPlaces(3), updatedBy: req.user!.id },
            });

            movements.push({ productId, lotId: l.id, quantity: take });
            // Lot primaire = 1er lot de la liste consommée (le plus ancien touché).
            if (!itemPrimaryLot.has(it.id)) itemPrimaryLot.set(it.id, l.id);
            remainingToTake = remainingToTake.minus(take);
          }
          if (!remainingToTake.eq(0)) {
            // Sécurité (dispo vérifié plus haut) — ne devrait jamais arriver.
            throw Object.assign(new Error(`Stock insuffisant pour ${it.product.name}`), { status: 400 });
          }
          continue;
        }

        // Stock dispo total pour ce produit CHEZ CE FOURNISSEUR (FIFO strict fournisseur+produit)
        const lots = await tx.stockLot.findMany({
          where: { productId, supplierId: sale.supplierId ?? undefined, deletedAt: null, remainingQuantity: { gt: new Prisma.Decimal(0) } },
          orderBy: { arrivalDate: 'asc' }, // FIFO : plus ancien d'abord
        });

        // Aucun lot FIFO dispo (fournisseur+produit) -> stock insuffisant clair.
        if (lots.length === 0) {
          throw Object.assign(
            new Error(`Stock insuffisant pour ${it.product.name} (fournisseur ${sale.supplierId ?? '—'}) : 0 colis disponibles`),
            { status: 400 },
          );
        }

        const available = lots.reduce((acc, l) => acc.plus(new Prisma.Decimal(l.remainingQuantity)), new Prisma.Decimal(0));
        if (available.lt(remainingToTake)) {
          throw Object.assign(
            new Error(`Stock insuffisant pour ${it.product.name} : ${available.toString()} colis disponibles (demandé ${remainingToTake.toString()})`),
            { status: 400 },
          );
        }

        for (const lot of lots) {
          if (remainingToTake.lte(0)) break;
          const lotRemaining = new Prisma.Decimal(lot.remainingQuantity);
          if (lotRemaining.lte(0)) continue;
          const take = remainingToTake.gt(lotRemaining) ? lotRemaining : remainingToTake;
          const newRemaining = lotRemaining.minus(take).toDecimalPlaces(3);

          await tx.stockLot.update({
            where: { id: lot.id },
            data: { remainingQuantity: newRemaining, updatedBy: req.user!.id },
          });

          movements.push({ productId, lotId: lot.id, quantity: take });
          if (!itemPrimaryLot.has(it.id)) itemPrimaryLot.set(it.id, lot.id);
          remainingToTake = remainingToTake.minus(take);
        }
        if (!remainingToTake.eq(0)) {
          // Ne devrait pas arriver (vérif dispo faite), mais sécurité
          throw Object.assign(new Error(`Stock insuffisant pour ${it.product.name}`), { status: 400 });
        }
      }

      // Crée un StockMovement OUT par lot touché
      for (const m of movements) {
        await tx.stockMovement.create({
          data: {
            productId: m.productId,
            lotId: m.lotId,
            type: 'OUT',
            quantity: m.quantity,
            reference: sale.reference,
            reason: `Vente ${sale.reference}`,
            createdBy: req.user!.id,
            updatedBy: req.user!.id,
          },
        });
      }

      // Relie chaque ligne de vente au lot FIFO principal utilisé. Ce lotId est
      // ensuite propagé aux InvoiceItem (itemsFromSale) et permet au bordereau
      // fournisseur de retrouver les ventes du lot (getSalesLines(lotId)).
      for (const it of sale.items) {
        const primaryLot = itemPrimaryLot.get(it.id);
        if (primaryLot && (it as any).lotId !== primaryLot) {
          await tx.saleItem.update({ where: { id: it.id }, data: { lotId: primaryLot } });
        }
      }

      // Passe la vente en CONFIRMED
      const confirmed = await tx.sale.update({
        where: { id: sale.id },
        data: { status: 'CONFIRMED', updatedBy: req.user!.id },
        include: {
          customer: { select: { id: true, name: true } },
          items: { include: { product: { select: { id: true, name: true } } } },
        },
      });

      return { sale: confirmed, movementCount: movements.length };
    });

    auditLog({
      userId: req.user!.id,
      action: 'SALE_CONFIRM',
      entity: 'Sale',
      entityId: saleId,
      details: { reference: result.sale.reference, movementCount: result.movementCount },
      req,
    }).catch(() => {});

    res.json({ ...serializeSale(result.sale), movementCount: result.movementCount });
  } catch (e: any) {
    const status = e?.status || (e?.code === 'P2025' || e?.code === 'P2003' ? 400 : 500);
    const msg = e?.message || 'Erreur confirmation vente';
    console.error('[sales] confirm error', e);
    res.status(status).json({ error: 'Échec confirmation', message: msg });
  }
});

// ---------------------------------------------------------------------
// DELETE /api/sales/:id — suppression logique (soft) de la vente.
// Supprime aussi les factures liées (soft) pour retirer la ligne de la liste.
// ---------------------------------------------------------------------
router.delete('/:id', requirePermission('SALE_WRITE'), async (req, res) => {
  try {
    const sale = await prisma.sale.findUnique({ where: { id: req.params.id } });
    if (!sale || sale.deletedAt) return res.status(404).json({ error: 'Vente introuvable' });
    await prisma.$transaction(async (tx) => {
      // Soft-delete des factures liées
      await tx.invoice.updateMany({ where: { saleId: sale.id, deletedAt: null }, data: { deletedAt: new Date(), updatedBy: req.user!.id } });
      await tx.sale.update({ where: { id: sale.id }, data: { deletedAt: new Date(), updatedBy: req.user!.id } });
    });
    res.json({ id: sale.id });
  } catch (e: any) {
    console.error('[sales] delete error', e);
    res.status(500).json({ error: 'Erreur suppression vente' });
  }
});

export default router;
