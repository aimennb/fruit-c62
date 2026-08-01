// =====================================================================
// Routes STOCK (Achats / Stocks / Logistique — B.3).
//   - GET  /api/stock            : stock agrégé par produit + par lot + valeur + alertes
//   - GET  /api/stock/fifo?productId=X : lots plus anciens (arrivage asc)
//   - POST /api/stock/loss       : perte (§23) -> diminue lot, mouvement LOSS, coût, audit
//
// Règle d'or : toute mutation de stock dans prisma.$transaction, Decimal jamais float.
// =====================================================================
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { requireAuth, requirePermission } from '../auth/middleware';
import { auditLog } from '../auth/audit';
import { dec } from './_helpers';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------
// GET /api/stock — vue agrégée
// ---------------------------------------------------------------------
/**
 * @openapi
 * /api/stock:
 *   get:
 *     summary: Stock global (par produit + par lot) avec valeur et alertes
 *     tags: [Stock]
 *     security: [{ bearerAuth: [] }]
 */
router.get('/', requirePermission('STOCK_READ'), async (_req: Request, res: Response) => {
  // Lots non soft-deleted (y compris épuisés — visibles avec soldOut=true)
  const lots = await prisma.stockLot.findMany({
    where: { deletedAt: null },
    include: {
      product: { select: { id: true, name: true, sku: true, reorderLevel: true } },
      supplier: { select: { id: true, name: true } },
    },
    orderBy: [{ productId: 'asc' }, { arrivalDate: 'asc' }],
  });

  // Agrégation par produit
  const byProduct = new Map<
    string,
    { productId: string; name: string; sku: string | null; qty: Prisma.Decimal; value: Prisma.Decimal; reorderLevel: string | null; lots: number }
  >();

  // Résoudre les bordereaux liés aux lots (lot.bordereauId prioritaire, sinon bordereau.lotId — rétro-compat)
  const bordIds = Array.from(new Set(lots.map((l) => (l as any).bordereauId).filter(Boolean))) as string[];
  const bordereaux = await prisma.supplierBordereau.findMany({
    where: { OR: [{ id: { in: bordIds } }, { lotId: { in: lots.map((l) => l.id) } }], deletedAt: null },
  });
  const bordById = new Map(bordereaux.map((b) => [b.id, b]));
  const bordByLot = new Map(bordereaux.map((b) => [b.lotId, b]));
  const bordForLot = (lot: any) => (lot.bordereauId ? bordById.get(lot.bordereauId) : undefined) ?? bordByLot.get(lot.id);

  const lotDTOs = lots.map((lot) => {
    const remaining = new Prisma.Decimal(lot.remainingQuantity);
    // valeurStock = qtéDispo * coûtApplicable (§22)
    const value = remaining.times(new Prisma.Decimal(lot.unitCost)).toDecimalPlaces(2);
    const p = lot.product;

    if (!byProduct.has(p.id)) {
      byProduct.set(p.id, {
        productId: p.id,
        name: p.name,
        sku: p.sku,
        qty: new Prisma.Decimal(0),
        value: new Prisma.Decimal(0),
        reorderLevel: p.reorderLevel != null ? dec(p.reorderLevel) : null,
        lots: 0,
      });
    }
    const agg = byProduct.get(p.id)!;
    agg.qty = agg.qty.plus(remaining);
    agg.value = agg.value.plus(value);
    agg.lots += 1;

    return {
      lotId: lot.id,
      lotNumber: lot.lotNumber,
      productId: p.id,
      productName: p.name,
      supplierId: lot.supplierId,
      supplierName: lot.supplier.name,
      bordereauId: bordForLot(lot)?.id ?? null,
      bordereauRef: bordForLot(lot)?.reference ?? null,
      quantity: dec(remaining),
      unitCost: dec(lot.unitCost),
      grossWeight: dec(lot.grossWeight),
      tare: dec(lot.tare),
      netWeight: dec(lot.netWeight),
      origin: lot.origin,
      quality: lot.quality,
      caliber: lot.caliber,
      arrivalDate: lot.arrivalDate,
      value: dec(value),
      reorderLevel: p.reorderLevel != null ? dec(p.reorderLevel) : null,
      soldOut: remaining.lte(0),
    };
  });

  const products = Array.from(byProduct.values()).map((a) => {
    const qty = a.qty;
    const reorder = a.reorderLevel != null ? new Prisma.Decimal(a.reorderLevel) : null;
    let alert: 'OK' | 'FAIBLE' | 'EPUISE' = 'OK';
    if (qty.lte(0)) alert = 'EPUISE';
    else if (reorder != null && qty.lte(reorder)) alert = 'FAIBLE';
    return {
      productId: a.productId,
      name: a.name,
      sku: a.sku,
      quantity: dec(qty),
      value: dec(a.value),
      reorderLevel: a.reorderLevel,
      lotCount: a.lots,
      alert,
    };
  });

  const totalValue = Array.from(byProduct.values())
    .reduce((acc, a) => acc.plus(a.value), new Prisma.Decimal(0))
    .toDecimalPlaces(2);

  res.json({
    totalValue: dec(totalValue),
    products,
    lots: lotDTOs,
  });
});

// ---------------------------------------------------------------------
// GET /api/stock/fifo?productId=X — lots plus anciens (arrivage asc)
// ---------------------------------------------------------------------
/**
 * @openapi
 * /api/stock/fifo:
 *   get:
 *     summary: Lots FIFO d'un produit (arrivage asc = les plus anciens d'abord)
 *     tags: [Stock]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: productId, required: true, schema: { type: string } }]
 */
router.get('/fifo', requirePermission('STOCK_READ'), async (req: Request, res: Response) => {
  const productId = req.query.productId as string;
  if (!productId) return res.status(400).json({ error: 'productId requis' });

  const lots = await prisma.stockLot.findMany({
    where: { productId, deletedAt: null, remainingQuantity: { gt: new Prisma.Decimal(0) } },
    include: { supplier: { select: { id: true, name: true } } },
    orderBy: { arrivalDate: 'asc' }, // FIFO : les plus anciens d'abord
  });

  res.json(
    lots.map((lot) => ({
      lotId: lot.id,
      lotNumber: lot.lotNumber,
      supplierName: lot.supplier.name,
      quantity: dec(lot.remainingQuantity),
      unitCost: dec(lot.unitCost),
      arrivalDate: lot.arrivalDate,
      value: dec(new Prisma.Decimal(lot.remainingQuantity).times(new Prisma.Decimal(lot.unitCost)).toDecimalPlaces(2)),
    })),
  );
});

// ---------------------------------------------------------------------
// POST /api/stock/loss — perte (§23)
// ---------------------------------------------------------------------
const lossSchema = z.object({
  lotId: z.string().min(1),
  quantity: z.coerce.number().positive(),
  reason: z.string().max(500).optional(),
});

/**
 * @openapi
 * /api/stock/loss:
 *   post:
 *     summary: Déclare une perte sur un lot (diminue stock, mouvement LOSS, coût, audit)
 *     tags: [Stock]
 *     security: [{ bearerAuth: [] }]
 */
router.post('/loss', requirePermission('STOCK_WRITE'), async (req: Request, res: Response) => {
  const parsed = lossSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });

  const { lotId, quantity, reason } = parsed.data;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const lot = await tx.stockLot.findUnique({ where: { id: lotId } });
      if (!lot || lot.deletedAt) throw new Error('Lot introuvable');
      const remaining = new Prisma.Decimal(lot.remainingQuantity);
      const qty = new Prisma.Decimal(quantity);
      if (qty.gt(remaining)) {
        throw new Error(`Quantité de perte (${quantity}) > stock restant (${dec(remaining)}) — stock jamais négatif`);
      }
      // coût de la perte = qté * coût applicable
      const lossCost = qty.times(new Prisma.Decimal(lot.unitCost)).toDecimalPlaces(2);
      const newRemaining = remaining.minus(qty).toDecimalPlaces(3);

      const updatedLot = await tx.stockLot.update({
        where: { id: lot.id },
        data: { remainingQuantity: newRemaining, updatedBy: req.user!.id },
      });

      // Mouvement LOSS
      const movement = await tx.stockMovement.create({
        data: {
          productId: lot.productId,
          lotId: lot.id,
          type: 'LOSS',
          quantity: qty,
          reference: lot.lotNumber,
          reason: reason || 'Perte déclarée',
          createdBy: req.user!.id,
          updatedBy: req.user!.id,
        },
      });

      // Enregistrement perte (coût)
      const loss = await tx.loss.create({
        data: {
          productId: lot.productId,
          lotId: lot.id,
          quantity: qty,
          reason: reason || null,
          cost: lossCost,
          createdBy: req.user!.id,
          updatedBy: req.user!.id,
        },
      });

      // Répercuter la perte sur colisRestant du bordereau lié au lot :
      // colisRestant = colisRecus − (colisVendus + totalPertesColis agrégées TOUS lots APRÈS cette perte)
      const bord = (lot as any).bordereauId
        ? await tx.supplierBordereau.findFirst({ where: { id: (lot as any).bordereauId, deletedAt: null } })
        : await tx.supplierBordereau.findFirst({ where: { lotId: lot.id, deletedAt: null } });
      if (bord) {
        const bordLots = await tx.stockLot.findMany({ where: { bordereauId: bord.id, deletedAt: null }, select: { id: true } });
        const lotIdSet = new Set<string>(bordLots.map((l) => l.id));
        if (bord.lotId) lotIdSet.add(bord.lotId);
        lotIdSet.add(lot.id);
        const pertesAgg = await tx.loss.aggregate({ _sum: { quantity: true }, where: { lotId: { in: Array.from(lotIdSet) }, deletedAt: null } });
        const totalPertesColisDuLotApres = new Prisma.Decimal(pertesAgg._sum.quantity ?? 0);
        const newColisRestant = new Prisma.Decimal(bord.colisRecus)
          .minus(new Prisma.Decimal(bord.colisVendus))
          .minus(totalPertesColisDuLotApres)
          .toDecimalPlaces(3);
        await tx.supplierBordereau.update({
          where: { id: bord.id },
          data: { colisRestant: newColisRestant },
        });
      }

      return { lotId: lot.id, newRemaining, lossCost, movementId: movement.id, lossId: loss.id };
    });

    auditLog({
      userId: req.user!.id,
      action: 'STOCK_LOSS',
      entity: 'StockLot',
      entityId: lotId,
      details: { quantity, reason, lossCost: result.lossCost.toString() },
      req,
    }).catch(() => {});

    res.json({ ...result, newRemaining: dec(result.newRemaining), lossCost: dec(result.lossCost) });
  } catch (e: any) {
    console.error('[stock loss]', e);
    const status = /introuvable|jamais négatif/.test(e?.message) ? 400 : 500;
    res.status(status).json({ error: 'Échec perte', message: e?.message });
  }
});

export default router;
