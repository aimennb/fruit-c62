// =====================================================================
// STOCK LOTS (Étape 2 module Bordereau Fournisseur) — lecture pour sélecteur Lot.
//   - GET /api/stock-lots?productId=...  : lots d'un produit avec remainingQuantity>0
// =====================================================================
import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { requireAuth } from '../auth/middleware';
import { dec } from './_helpers';

const router = Router();
router.use(requireAuth);

// GET /api/stock-lots — lots (filtrables par productId), remainingQuantity>0
router.get('/', async (req: Request, res: Response) => {
  const productId = typeof req.query.productId === 'string' ? req.query.productId : undefined;
  const includeZero = req.query.includeZero === '1';
  const lots = await prisma.stockLot.findMany({
    where: {
      deletedAt: null,
      ...(includeZero ? {} : { remainingQuantity: { gt: new Prisma.Decimal(0) } }),
      ...(productId ? { productId } : {}),
    },
    include: {
      product: { select: { id: true, name: true } },
      supplier: { select: { id: true, name: true } },
    },
    orderBy: { arrivalDate: 'asc' },
    take: 500,
  });
  res.json({
    items: lots.map((l) => ({
      id: l.id,
      lotNumber: l.lotNumber,
      productId: l.productId,
      supplierId: l.supplierId,
      quantity: dec(l.quantity),
      remainingQuantity: dec(l.remainingQuantity),
      caliber: l.caliber ?? null,
      arrivalDate: l.arrivalDate,
      product: l.product ? { id: l.product.id, name: l.product.name } : null,
      supplier: l.supplier ? { id: l.supplier.id, name: l.supplier.name } : null,
    })),
    total: lots.length,
  });
});

// GET /api/stock-lots/fifo?supplierId=&productId= — résout le 1er lot FIFO
// (fournisseur+produit, remainingQuantity>0, arrivalDate asc). Renvoie le lot
// résolu + sa remainingQuantity, ou null si aucun lot dispo.
router.get('/fifo', async (req: Request, res: Response) => {
  const supplierId = typeof req.query.supplierId === 'string' ? req.query.supplierId : undefined;
  const productId = typeof req.query.productId === 'string' ? req.query.productId : undefined;
  const calibre = typeof req.query.calibre === 'string' && req.query.calibre.trim() ? req.query.calibre.trim() : undefined;
  if (!supplierId || !productId) {
    return res.status(400).json({ error: 'supplierId et productId requis' });
  }
  const lot = await prisma.stockLot.findFirst({
    where: { supplierId, productId, deletedAt: null, remainingQuantity: { gt: new Prisma.Decimal(0) }, ...(calibre ? { caliber: calibre } : {}) },
    orderBy: { arrivalDate: 'asc' },
  });
  if (!lot) return res.json({ lot: null });
  res.json({
    lot: {
      lotId: lot.id,
      lotNumber: lot.lotNumber,
      remainingQuantity: dec(lot.remainingQuantity),
    },
  });
});

export default router;
