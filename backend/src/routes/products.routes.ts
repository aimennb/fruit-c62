import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { requireAuth, requirePermission } from '../auth/middleware';
import { dec, parseListQuery, paginate, moneyField } from './_helpers';
import { auditLog } from '../auth/audit';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------
// Schémas de validation (§9)
// ---------------------------------------------------------------------
const money = z.union([z.string(), z.number()]).optional();

const productInput = z.object({
  name: z.string().min(1).max(150), // nom FR
  nameAr: z.string().max(150).optional(), // nom arabe (optionnel)
  nameBer: z.string().max(150).optional(), // nom tamazight (optionnel)
  variety: z.string().max(100).optional(), // variété
  origin: z.string().max(100).optional(), // origine
  quality: z.string().max(60).optional(), // qualité
  calibre: z.string().max(60).optional(), // calibre
  sku: z.string().max(50).optional(),
  barcode: z.string().max(50).optional(),
  categoryId: z.string().optional(),
  unitId: z.string().optional(), // unité optionnelle : défaut = Caisse/colis ('cs')
  packaging: z.string().max(100).optional(), // conditionnement
  description: z.string().optional(),
  avgPurchasePrice: money, // prix achat moyen
  lastPurchasePrice: money, // dernier prix achat
  suggestedSalePrice: money, // prix vente conseillé
  alertThreshold: money, // seuil d'alerte stock
  reorderLevel: money, // seuil de réappro (legacy)
  notes: z.string().optional(), // notes
  isActive: z.boolean().default(true), // statut actif/archivé
  supplierIds: z.array(z.string()).optional(), // fournisseurs liés (many-to-many)
  initialQuantity: z.union([z.string(), z.number()]).optional(), // qté de stock initiale à l'ouverture
});

const productUpdate = productInput.partial();

/** Champs Decimal sérialisés en string. */
function serialize(p: any) {
  const { suppliers, ...rest } = p;
  return {
    ...rest,
    avgPurchasePrice: dec(p.avgPurchasePrice),
    lastPurchasePrice: dec(p.lastPurchasePrice),
    suggestedSalePrice: dec(p.suggestedSalePrice),
    alertThreshold: dec(p.alertThreshold),
    reorderLevel: dec(p.reorderLevel),
    suppliers: Array.isArray(suppliers)
      ? suppliers.map((s: any) => ({
          id: s.supplier?.id ?? s.supplierId,
          name: s.supplier?.name ?? '',
          nameAr: s.supplier?.nameAr ?? null,
          isPreferred: s.isPreferred,
        }))
      : [],
  };
}

// Numérotation des lots d'ouverture (préfixe LOT-OUV-, non réutilisée).
async function nextOpeningLotNumber(tx: Prisma.TransactionClient): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `LOT-OUV-${year}-`;
  const rows = await tx.$queryRawUnsafe<{ lotNumber: string }[]>(
    `SELECT "lotNumber" FROM "StockLot" WHERE "lotNumber" LIKE $1 ORDER BY "lotNumber" DESC LIMIT 1`,
    prefix + '%',
  );
  let next = 1;
  if (rows.length > 0) {
    const num = rows[0].lotNumber.slice(prefix.length).replace(/\D/g, '');
    next = parseInt(num || '0', 10) + 1;
  }
  return `${prefix}${String(next).padStart(4, '0')}`;
}

/**
 * Construit la liste des opérations Prisma pour synchroniser les liaisons
 * ProductSupplier d'un produit avec le tableau `supplierIds` fourni.
 * - crée les liaisons manquantes,
 * - supprime les liaisons obsolètes,
 * - marque isPreferred = true pour le 1er (si plusieurs).
 * Tout est exécuté DANS la transaction appelante.
 */
async function syncProductSuppliers(tx: Prisma.TransactionClient, productId: string, supplierIds: string[] | undefined) {
  if (supplierIds === undefined) return; // champ non fourni -> on ne touche pas
  const ids = Array.from(new Set(supplierIds.filter(Boolean)));

  const existing = await tx.productSupplier.findMany({
    where: { productId },
    select: { id: true, supplierId: true },
  });
  const existingSet = new Set(existing.map((e) => e.supplierId));

  const toCreate = ids.filter((sid) => !existingSet.has(sid));
  const idsSet = new Set(ids);
  const toDelete = existing.filter((e) => !idsSet.has(e.supplierId)).map((e) => e.id);

  // On commence propre : si un seul fournisseur, il est préféré ; sinon le 1er.
  const preferredSupplierId = ids.length > 0 ? ids[0] : undefined;

  await Promise.all([
    // supprime les obsolètes
    toDelete.length
      ? tx.productSupplier.deleteMany({ where: { id: { in: toDelete } } })
      : Promise.resolve(),
    // crée les nouvelles
    ...toCreate.map((sid) =>
      tx.productSupplier.create({
        data: { productId, supplierId: sid, isPreferred: sid === preferredSupplierId },
      }),
    ),
    // met à jour isPreferred sur les liaisons conservées
    ids.length
      ? tx.productSupplier.updateMany({
          where: { productId, supplierId: { in: ids } },
          data: { isPreferred: false },
        }).then(() =>
          tx.productSupplier.updateMany({
            where: { productId, supplierId: preferredSupplierId },
            data: { isPreferred: true },
          }),
        )
      : Promise.resolve(),
  ]);
}

/**
 * GET /api/products
 * @summary Liste paginée des produits (recherche/filtre/tri).
 * @tag Products
 */
router.get('/', requirePermission('PRODUCT_READ'), async (req, res) => {
  const q = parseListQuery(req);
  const where: Prisma.ProductWhereInput = { deletedAt: null };
  if (q.q) {
    where.OR = [
      { name: { contains: q.q, mode: 'insensitive' } },
      { nameAr: { contains: q.q, mode: 'insensitive' } },
      { sku: { contains: q.q, mode: 'insensitive' } },
      { barcode: { contains: q.q, mode: 'insensitive' } },
      { variety: { contains: q.q, mode: 'insensitive' } },
    ];
  }
  if (q.categoryId) where.categoryId = q.categoryId;
  if (q.active !== undefined) where.isActive = q.active;

  const orderBy: Prisma.ProductOrderByWithRelationInput = q.sortBy
    ? ({ [q.sortBy]: q.sortDir } as Prisma.ProductOrderByWithRelationInput)
    : { name: 'asc' };

  const items = await prisma.product.findMany({
    where,
    include: { category: true, unit: true, suppliers: { include: { supplier: true } } },
    orderBy,
    skip: q.skip,
    take: q.take,
  });
  const total = await prisma.product.count({ where });

  // Quantité de stock DISPONIBLE agrégée par produit (un seul groupBy pour toute la liste)
  // + fournisseurs liés, en une seule requête (filtée sur la page courante).
  const [stockAgg, supplierLinks] = await Promise.all([
    prisma.stockLot.groupBy({
      by: ['productId'],
      where: { deletedAt: null },
      _sum: { quantity: true },
    }),
    prisma.productSupplier.findMany({
      where: { productId: { in: items.map((p) => p.id) } },
      include: { supplier: { select: { id: true, name: true, nameAr: true } } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const qtyByProduct = new Map<string, number>();
  for (const row of stockAgg) {
    qtyByProduct.set(row.productId, row._sum.quantity ? Number(row._sum.quantity) : 0);
  }

  const suppliersByProduct = new Map<string, any[]>();
  for (const link of supplierLinks) {
    const arr = suppliersByProduct.get(link.productId) ?? [];
    arr.push({
      id: link.supplier.id,
      name: link.supplier.name,
      nameAr: link.supplier.nameAr,
      isPreferred: link.isPreferred,
    });
    suppliersByProduct.set(link.productId, arr);
  }

  res.json(
    paginate(
      items.map((p) => ({
        ...serialize(p),
        quantity: qtyByProduct.get(p.id) ?? 0,
        suppliers: suppliersByProduct.get(p.id) ?? [],
      })),
      total,
      q.page,
      q.take,
    ),
  );
});
/**
 * GET /api/products/:id
 * @summary Détail d'un produit.
 * @tag Products
 */
router.get('/:id', requirePermission('PRODUCT_READ'), async (req, res) => {
  const p = await prisma.product.findUnique({
    where: { id: req.params.id },
    include: { category: true, unit: true },
  });
  if (!p || p.deletedAt) return res.status(404).json({ error: 'Introuvable' });
  const [stockAgg, suppliers] = await Promise.all([
    prisma.stockLot.aggregate({
      where: { productId: p.id, deletedAt: null },
      _sum: { quantity: true },
    }),
    prisma.productSupplier.findMany({
      where: { productId: p.id },
      include: { supplier: { select: { id: true, name: true, nameAr: true } } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  res.json({
    ...serialize(p),
    quantity: stockAgg._sum.quantity ? Number(stockAgg._sum.quantity) : 0,
    suppliers: suppliers.map((s) => ({
      id: s.supplier.id,
      name: s.supplier.name,
      nameAr: s.supplier.nameAr,
      isPreferred: s.isPreferred,
    })),
  });
});

/**
 * POST /api/products
 * @summary Crée un produit.
 * @tag Products
 */
router.post('/', requirePermission('PRODUCT_CREATE'), async (req, res) => {
  const parsed = productInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
  const d = parsed.data;
  // Unité par défaut : Caisse/colis ('cs') si non fournie par le client.
  let unitId = d.unitId;
  if (!unitId) {
    const cs = await prisma.unit.findFirst({ where: { symbol: 'cs' } });
    if (cs) {
      unitId = cs.id;
    } else {
      // Product.unitId est requis en base : impossible de créer sans unité.
      console.warn("[products] Unité 'cs' (Caisse/colis) introuvable — création refusée");
      return res.status(400).json({ error: "Unité par défaut 'cs' (Caisse/colis) introuvable" });
    }
  }
  const data: Prisma.ProductCreateInput = {
    name: d.name,
    nameAr: d.nameAr,
    nameBer: d.nameBer,
    variety: d.variety,
    origin: d.origin,
    quality: d.quality,
    calibre: d.calibre,
    sku: d.sku,
    barcode: d.barcode,
    packaging: d.packaging,
    description: d.description,
    notes: d.notes,
    isActive: d.isActive,
    avgPurchasePrice: moneyField(d.avgPurchasePrice),
    lastPurchasePrice: moneyField(d.lastPurchasePrice),
    suggestedSalePrice: moneyField(d.suggestedSalePrice),
    alertThreshold: moneyField(d.alertThreshold),
    reorderLevel: moneyField(d.reorderLevel),
    category: d.categoryId ? { connect: { id: d.categoryId } } : undefined,
    unit: { connect: { id: unitId! } },
    createdBy: req.user!.id,
    updatedBy: req.user!.id,
  };
  let p: Prisma.ProductGetPayload<{ include: { category: true; unit: true; suppliers: { include: { supplier: true } } } }>;
  try {
    // Création + synchronisation des fournisseurs DANS une transaction.
    await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data,
        include: { category: true, unit: true, suppliers: { include: { supplier: true } } },
      });
      await syncProductSuppliers(tx, created.id, d.supplierIds);
      // NOTE: plus d'ouverture de stock automatique ici.
      // Le stock est désormais alimenté exclusivement par les Bons de réception,
      // en NOMBRE DE COLIS (unité 'cs'). `initialQuantity` reste accepté (zod)
      // mais est ignoré.
    });
    // Re-lecture pour réponse complète (suppliers créés après le create).
    p = await prisma.product.findUniqueOrThrow({
      where: { id: (await prisma.product.findFirst({ where: { name: d.name }, orderBy: { createdAt: 'desc' } }))!.id },
      include: { category: true, unit: true, suppliers: { include: { supplier: true } } },
    });
  } catch (e: any) {
    if (e?.code === 'P2025' || e?.code === 'P2003') {
      const fk = e.meta?.cause || e.meta?.field_name || 'référence invalide (catégorie/unité/fournisseur)';
      return res.status(400).json({ error: 'Référence invalide', details: fk });
    }
    throw e;
  }
  auditLog({ userId: req.user!.id, action: 'PRODUCT_CREATE', entity: 'Product', entityId: p.id, req }).catch(() => {});
  res.status(201).json(serialize(p));
});

/**
 * PUT /api/products/:id
 * @summary Met à jour un produit.
 * @tag Products
 */
router.put('/:id', requirePermission('PRODUCT_UPDATE'), async (req, res) => {
  const parsed = productUpdate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
  const d = parsed.data;
  const data: Prisma.ProductUpdateInput = {
    name: d.name,
    nameAr: d.nameAr,
    nameBer: d.nameBer,
    variety: d.variety,
    origin: d.origin,
    quality: d.quality,
    calibre: d.calibre,
    sku: d.sku,
    barcode: d.barcode,
    packaging: d.packaging,
    description: d.description,
    notes: d.notes,
    isActive: d.isActive,
    avgPurchasePrice: moneyField(d.avgPurchasePrice),
    lastPurchasePrice: moneyField(d.lastPurchasePrice),
    suggestedSalePrice: moneyField(d.suggestedSalePrice),
    alertThreshold: moneyField(d.alertThreshold),
    reorderLevel: moneyField(d.reorderLevel),
    category: d.categoryId === undefined ? undefined : d.categoryId ? { connect: { id: d.categoryId } } : { disconnect: true },
    unit: d.unitId ? { connect: { id: d.unitId } } : undefined,
    updatedBy: req.user!.id,
  };
  let p: Prisma.ProductGetPayload<{ include: { category: true; unit: true } }>;
  try {
    // MAJ + synchronisation des fournisseurs DANS une transaction.
    p = await prisma.$transaction(async (tx) => {
      const updated = await tx.product.update({
        where: { id: req.params.id },
        data,
        include: { category: true, unit: true },
      });
      await syncProductSuppliers(tx, updated.id, d.supplierIds);
      return updated;
    });
  } catch (e: any) {
    if (e?.code === 'P2025' || e?.code === 'P2003') {
      const fk = e.meta?.cause || e.meta?.field_name || 'référence invalide (catégorie/unité/fournisseur)';
      return res.status(400).json({ error: 'Référence invalide', details: fk });
    }
    throw e;
  }
  auditLog({ userId: req.user!.id, action: 'PRODUCT_UPDATE', entity: 'Product', entityId: p.id, req }).catch(() => {});
  res.json(serialize(p));
});

/**
 * DELETE /api/products/:id
 * @summary Suppression douce. Archive (isActive=false) si le produit est utilisé (achats/ventes/stock/pertes), sinon soft-delete (deletedAt).
 * @tag Products
 */
router.delete('/:id', requirePermission('PRODUCT_DELETE'), async (req, res) => {
  const p = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!p || p.deletedAt) return res.status(404).json({ error: 'Introuvable' });

  const inUse =
    (await prisma.purchaseItem.count({ where: { productId: p.id } })) > 0 ||
    (await prisma.saleItem.count({ where: { productId: p.id } })) > 0 ||
    (await prisma.stockLot.count({ where: { productId: p.id } })) > 0 ||
    (await prisma.stockMovement.count({ where: { productId: p.id } })) > 0 ||
    (await prisma.loss.count({ where: { productId: p.id } })) > 0 ||
    (await prisma.priceHistory.count({ where: { productId: p.id } })) > 0 ||
    (await prisma.purchaseBulletinItem.count({ where: { productId: p.id } })) > 0;

  if (inUse) {
    // Archive (pas suppression) : on garde l'historique mais on désactive.
    const updated = await prisma.product.update({
      where: { id: p.id },
      data: { isActive: false, updatedBy: req.user!.id },
    });
    auditLog({ userId: req.user!.id, action: 'PRODUCT_ARCHIVE', entity: 'Product', entityId: p.id, req }).catch(() => {});
    res.json({ message: 'Produit archivé (utilisé, suppression impossible)', archived: true, product: serialize(updated) });
    return;
  }

  const updated = await prisma.product.update({
    where: { id: p.id },
    data: { deletedAt: new Date(), updatedBy: req.user!.id },
  });
  auditLog({ userId: req.user!.id, action: 'PRODUCT_DELETE', entity: 'Product', entityId: p.id, req }).catch(() => {});
  res.json({ message: 'Produit supprimé (soft delete)', archived: false, product: serialize(updated) });
});

export default router;
