import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { requireAuth, requirePermission } from '../auth/middleware';
import { parseListQuery, paginate } from './_helpers';
import { auditLog } from '../auth/audit';

const router = Router();
router.use(requireAuth);

const unitInput = z.object({
  name: z.string().min(1).max(100),
  symbol: z.string().min(1).max(20),
  isActive: z.boolean().default(true),
});
const unitUpdate = unitInput.partial();

/**
 * GET /api/units
 * @summary Liste paginée des unités.
 * @tag Units
 */
router.get('/', requirePermission('PRODUCT_READ'), async (req, res) => {
  const q = parseListQuery(req);
  const where: Prisma.UnitWhereInput = { deletedAt: null };
  if (q.q) where.OR = [
    { name: { contains: q.q, mode: 'insensitive' } },
    { symbol: { contains: q.q, mode: 'insensitive' } },
  ];
  if (q.active !== undefined) where.isActive = q.active;
  const orderBy: Prisma.UnitOrderByWithRelationInput = q.sortBy ? ({ [q.sortBy]: q.sortDir } as any) : { name: 'asc' };
  const [items, total] = await Promise.all([
    prisma.unit.findMany({ where, orderBy, skip: q.skip, take: q.take }),
    prisma.unit.count({ where }),
  ]);
  res.json(paginate(items, total, q.page, q.take));
});

/**
 * GET /api/units/:id
 * @summary Détail d'une unité.
 * @tag Units
 */
router.get('/:id', requirePermission('PRODUCT_READ'), async (req, res) => {
  const u = await prisma.unit.findUnique({ where: { id: req.params.id } });
  if (!u || u.deletedAt) return res.status(404).json({ error: 'Introuvable' });
  res.json(u);
});

/**
 * POST /api/units
 * @summary Crée une unité.
 * @tag Units
 */
router.post('/', requirePermission('PRODUCT_CREATE'), async (req, res) => {
  const parsed = unitInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
  const d = parsed.data;
  const u = await prisma.unit.create({
    data: { name: d.name, symbol: d.symbol, isActive: d.isActive, createdBy: req.user!.id, updatedBy: req.user!.id },
  });
  auditLog({ userId: req.user!.id, action: 'UNIT_CREATE', entity: 'Unit', entityId: u.id, req }).catch(() => {});
  res.status(201).json(u);
});

/**
 * PUT /api/units/:id
 * @summary Met à jour une unité.
 * @tag Units
 */
router.put('/:id', requirePermission('PRODUCT_UPDATE'), async (req, res) => {
  const parsed = unitUpdate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
  const u = await prisma.unit.update({ where: { id: req.params.id }, data: { ...parsed.data, updatedBy: req.user!.id } });
  auditLog({ userId: req.user!.id, action: 'UNIT_UPDATE', entity: 'Unit', entityId: u.id, req }).catch(() => {});
  res.json(u);
});

/**
 * DELETE /api/units/:id
 * @summary Suppression douce (archivage si utilisée par un produit).
 * @tag Units
 */
router.delete('/:id', requirePermission('PRODUCT_DELETE'), async (req, res) => {
  const u = await prisma.unit.findUnique({ where: { id: req.params.id } });
  if (!u || u.deletedAt) return res.status(404).json({ error: 'Introuvable' });
  const inUse = (await prisma.product.count({ where: { unitId: u.id } })) > 0;
  if (inUse) {
    const updated = await prisma.unit.update({ where: { id: u.id }, data: { isActive: false, updatedBy: req.user!.id } });
    auditLog({ userId: req.user!.id, action: 'UNIT_ARCHIVE', entity: 'Unit', entityId: u.id, req }).catch(() => {});
    res.json({ message: 'Unité archivée (utilisée par des produits)', archived: true, unit: updated });
    return;
  }
  const updated = await prisma.unit.update({ where: { id: u.id }, data: { deletedAt: new Date(), updatedBy: req.user!.id } });
  auditLog({ userId: req.user!.id, action: 'UNIT_DELETE', entity: 'Unit', entityId: u.id, req }).catch(() => {});
  res.json({ message: 'Unité supprimée (soft delete)', archived: false, unit: updated });
});

export default router;
