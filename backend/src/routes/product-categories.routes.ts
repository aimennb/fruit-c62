import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { requireAuth, requirePermission } from '../auth/middleware';
import { parseListQuery, paginate } from './_helpers';
import { auditLog } from '../auth/audit';

const router = Router();
router.use(requireAuth);

const catInput = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  isActive: z.boolean().default(true),
});
const catUpdate = catInput.partial();

/**
 * GET /api/product-categories
 * @summary Liste paginée des catégories de produits.
 * @tag ProductCategories
 */
router.get('/', requirePermission('PRODUCT_READ'), async (req, res) => {
  const q = parseListQuery(req);
  const where: Prisma.ProductCategoryWhereInput = { deletedAt: null };
  if (q.q) where.OR = [
    { name: { contains: q.q, mode: 'insensitive' } },
    { description: { contains: q.q, mode: 'insensitive' } },
  ];
  if (q.active !== undefined) where.isActive = q.active;
  const orderBy: Prisma.ProductCategoryOrderByWithRelationInput = q.sortBy ? ({ [q.sortBy]: q.sortDir } as any) : { name: 'asc' };
  const [items, total] = await Promise.all([
    prisma.productCategory.findMany({ where, orderBy, skip: q.skip, take: q.take }),
    prisma.productCategory.count({ where }),
  ]);
  res.json(paginate(items, total, q.page, q.take));
});

/**
 * GET /api/product-categories/:id
 * @summary Détail d'une catégorie.
 * @tag ProductCategories
 */
router.get('/:id', requirePermission('PRODUCT_READ'), async (req, res) => {
  const c = await prisma.productCategory.findUnique({ where: { id: req.params.id } });
  if (!c || c.deletedAt) return res.status(404).json({ error: 'Introuvable' });
  res.json(c);
});

/**
 * POST /api/product-categories
 * @summary Crée une catégorie.
 * @tag ProductCategories
 */
router.post('/', requirePermission('PRODUCT_CREATE'), async (req, res) => {
  const parsed = catInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
  const d = parsed.data;
  const c = await prisma.productCategory.create({
    data: { name: d.name, description: d.description, isActive: d.isActive, createdBy: req.user!.id, updatedBy: req.user!.id },
  });
  auditLog({ userId: req.user!.id, action: 'CATEGORY_CREATE', entity: 'ProductCategory', entityId: c.id, req }).catch(() => {});
  res.status(201).json(c);
});

/**
 * PUT /api/product-categories/:id
 * @summary Met à jour une catégorie.
 * @tag ProductCategories
 */
router.put('/:id', requirePermission('PRODUCT_UPDATE'), async (req, res) => {
  const parsed = catUpdate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
  const c = await prisma.productCategory.update({ where: { id: req.params.id }, data: { ...parsed.data, updatedBy: req.user!.id } });
  auditLog({ userId: req.user!.id, action: 'CATEGORY_UPDATE', entity: 'ProductCategory', entityId: c.id, req }).catch(() => {});
  res.json(c);
});

/**
 * DELETE /api/product-categories/:id
 * @summary Suppression douce (archivage si utilisée par un produit).
 * @tag ProductCategories
 */
router.delete('/:id', requirePermission('PRODUCT_DELETE'), async (req, res) => {
  const c = await prisma.productCategory.findUnique({ where: { id: req.params.id } });
  if (!c || c.deletedAt) return res.status(404).json({ error: 'Introuvable' });
  const inUse = (await prisma.product.count({ where: { categoryId: c.id } })) > 0;
  if (inUse) {
    const updated = await prisma.productCategory.update({ where: { id: c.id }, data: { isActive: false, updatedBy: req.user!.id } });
    auditLog({ userId: req.user!.id, action: 'CATEGORY_ARCHIVE', entity: 'ProductCategory', entityId: c.id, req }).catch(() => {});
    res.json({ message: 'Catégorie archivée (utilisée par des produits)', archived: true, category: updated });
    return;
  }
  const updated = await prisma.productCategory.update({ where: { id: c.id }, data: { deletedAt: new Date(), updatedBy: req.user!.id } });
  auditLog({ userId: req.user!.id, action: 'CATEGORY_DELETE', entity: 'ProductCategory', entityId: c.id, req }).catch(() => {});
  res.json({ message: 'Catégorie supprimée (soft delete)', archived: false, category: updated });
});

export default router;
