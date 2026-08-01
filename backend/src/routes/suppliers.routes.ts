import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { requireAuth, requirePermission } from '../auth/middleware';
import { dec, parseListQuery, paginate, moneyField } from './_helpers';
import { auditLog } from '../auth/audit';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------
// Schémas de validation (§10)
// ---------------------------------------------------------------------
const money = z.union([z.string(), z.number()]).optional();

const supplierInput = z.object({
  name: z.string().min(1).max(150), // nom FR
  nameAr: z.string().max(150).optional(), // nom arabe (optionnel)
  contactName: z.string().max(120).optional(), // contact
  phone: z.string().max(40).optional(),
  email: z.string().email().optional().or(z.literal('')),
  address: z.string().optional(),
  commune: z.string().max(100).optional(), // commune
  wilaya: z.string().max(100).optional(), // wilaya
  country: z.string().max(100).optional().default('Algérie'), // pays
  rc: z.string().max(40).optional(), // RC
  nif: z.string().max(40).optional(), // NIF
  ai: z.string().max(40).optional(), // article d'identification
  notes: z.string().optional(), // notes
  isActive: z.boolean().default(true), // statut actif/archivé
});

const supplierUpdate = supplierInput.partial();

function serialize(s: any) {
  return { ...s, balance: dec(s.balance) };
}

/**
 * GET /api/suppliers
 * @summary Liste paginée des fournisseurs (recherche/filtre/tri).
 * @tag Suppliers
 */
router.get('/', requirePermission('SUPPLIER_READ'), async (req, res) => {
  const q = parseListQuery(req);
  const where: Prisma.SupplierWhereInput = { deletedAt: null };
  if (q.q) {
    where.OR = [
      { name: { contains: q.q, mode: 'insensitive' } },
      { nameAr: { contains: q.q, mode: 'insensitive' } },
      { contactName: { contains: q.q, mode: 'insensitive' } },
      { rc: { contains: q.q, mode: 'insensitive' } },
      { nif: { contains: q.q, mode: 'insensitive' } },
      { phone: { contains: q.q } },
    ];
  }
  if (q.active !== undefined) where.isActive = q.active;

  const orderBy: Prisma.SupplierOrderByWithRelationInput = q.sortBy
    ? ({ [q.sortBy]: q.sortDir } as Prisma.SupplierOrderByWithRelationInput)
    : { name: 'asc' };

  const [items, total] = await Promise.all([
    prisma.supplier.findMany({ where, orderBy, skip: q.skip, take: q.take }),
    prisma.supplier.count({ where }),
  ]);
  res.json(paginate(items.map(serialize), total, q.page, q.take));
});

/**
 * GET /api/suppliers/:id
 * @summary Détail d'un fournisseur (avec entrées de compte et acomptes).
 * @tag Suppliers
 */
router.get('/:id', requirePermission('SUPPLIER_READ'), async (req, res) => {
  const s = await prisma.supplier.findUnique({ where: { id: req.params.id } });
  if (!s || s.deletedAt) return res.status(404).json({ error: 'Introuvable' });
  res.json(serialize(s));
});

/**
 * POST /api/suppliers
 * @summary Crée un fournisseur.
 * @tag Suppliers
 */
router.post('/', requirePermission('SUPPLIER_CREATE'), async (req, res) => {
  const parsed = supplierInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
  const d = parsed.data;
  const data: Prisma.SupplierCreateInput = {
    name: d.name,
    nameAr: d.nameAr,
    contactName: d.contactName,
    phone: d.phone,
    email: d.email || null,
    address: d.address,
    commune: d.commune,
    wilaya: d.wilaya,
    country: d.country,
    rc: d.rc,
    nif: d.nif,
    ai: d.ai,
    notes: d.notes,
    isActive: d.isActive,
    createdBy: req.user!.id,
    updatedBy: req.user!.id,
  };
  const s = await prisma.supplier.create({ data });
  auditLog({ userId: req.user!.id, action: 'SUPPLIER_CREATE', entity: 'Supplier', entityId: s.id, req }).catch(() => {});
  res.status(201).json(serialize(s));
});

/**
 * PUT /api/suppliers/:id
 * @summary Met à jour un fournisseur.
 * @tag Suppliers
 */
router.put('/:id', requirePermission('SUPPLIER_UPDATE'), async (req, res) => {
  const parsed = supplierUpdate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
  const d = parsed.data;
  const data: Prisma.SupplierUpdateInput = {
    name: d.name,
    nameAr: d.nameAr,
    contactName: d.contactName,
    phone: d.phone,
    email: d.email === undefined ? undefined : d.email || null,
    address: d.address,
    commune: d.commune,
    wilaya: d.wilaya,
    country: d.country,
    rc: d.rc,
    nif: d.nif,
    ai: d.ai,
    notes: d.notes,
    isActive: d.isActive,
    updatedBy: req.user!.id,
  };
  const s = await prisma.supplier.update({ where: { id: req.params.id }, data });
  auditLog({ userId: req.user!.id, action: 'SUPPLIER_UPDATE', entity: 'Supplier', entityId: s.id, req }).catch(() => {});
  res.json(serialize(s));
});

/**
 * DELETE /api/suppliers/:id
 * @summary Suppression douce (archivage si utilisé, sinon soft-delete).
 * @tag Suppliers
 */
router.delete('/:id', requirePermission('SUPPLIER_DELETE'), async (req, res) => {
  const s = await prisma.supplier.findUnique({ where: { id: req.params.id } });
  if (!s || s.deletedAt) return res.status(404).json({ error: 'Introuvable' });

  const inUse =
    (await prisma.purchase.count({ where: { supplierId: s.id } })) > 0 ||
    (await prisma.supplierAccountEntry.count({ where: { supplierId: s.id } })) > 0 ||
    (await prisma.payment.count({ where: { supplierId: s.id } })) > 0;

  if (inUse) {
    const updated = await prisma.supplier.update({
      where: { id: s.id },
      data: { isActive: false, updatedBy: req.user!.id },
    });
    auditLog({ userId: req.user!.id, action: 'SUPPLIER_ARCHIVE', entity: 'Supplier', entityId: s.id, req }).catch(() => {});
    res.json({ message: 'Fournisseur archivé (utilisé)', archived: true, supplier: serialize(updated) });
    return;
  }

  const updated = await prisma.supplier.update({
    where: { id: s.id },
    data: { deletedAt: new Date(), updatedBy: req.user!.id },
  });
  auditLog({ userId: req.user!.id, action: 'SUPPLIER_DELETE', entity: 'Supplier', entityId: s.id, req }).catch(() => {});
  res.json({ message: 'Fournisseur supprimé (soft delete)', archived: false, supplier: serialize(updated) });
});

/**
 * GET /api/suppliers/:id/statement
 * @summary Relevé simplifié du fournisseur (Phase B) : solde, entrées de compte, acomptes, dernières réceptions.
 * @tag Suppliers
 */
router.get('/:id/statement', requirePermission('SUPPLIER_READ'), async (req, res) => {
  const s = await prisma.supplier.findUnique({ where: { id: req.params.id } });
  if (!s || s.deletedAt) return res.status(404).json({ error: 'Introuvable' });

  const [entries, advances, purchases] = await Promise.all([
    prisma.supplierAccountEntry.findMany({
      where: { supplierId: s.id, deletedAt: null },
      orderBy: { entryDate: 'desc' },
      take: 50,
    }),
    prisma.supplierAdvance.findMany({
      where: { supplierId: s.id, deletedAt: null },
      orderBy: { advanceDate: 'desc' },
      take: 50,
    }),
    prisma.purchase.findMany({
      where: { supplierId: s.id, deletedAt: null },
      orderBy: { date: 'desc' },
      take: 20,
      select: { id: true, reference: true, date: true, status: true, total: true },
    }),
  ]);

  const totalDebit = entries.filter((e) => e.type === 'DEBIT').reduce((a, e) => a.plus(e.amount), new (require('@prisma/client').Prisma).Decimal(0));
  const totalCredit = entries.filter((e) => e.type === 'CREDIT').reduce((a, e) => a.plus(e.amount), new (require('@prisma/client').Prisma).Decimal(0));
  const totalAdvances = advances.reduce((a, e) => a.plus(e.amount), new (require('@prisma/client').Prisma).Decimal(0));

  res.json({
    supplier: serialize(s),
    balance: dec(s.balance),
    accountSummary: {
      totalDebit: dec(totalDebit),
      totalCredit: dec(totalCredit),
      totalAdvances: dec(totalAdvances),
    },
    entries: entries.map((e) => ({ ...e, amount: dec(e.amount) })),
    advances: advances.map((a) => ({ ...a, amount: dec(a.amount) })),
    recentPurchases: purchases.map((p) => ({ ...p, total: dec(p.total) })),
  });
});

export default router;
