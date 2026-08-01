// =====================================================================
// B.4 — Agent Finance / Avances Fournisseurs.
// Routes: création d'avance, affectation (allocation) à un achat/bulletin,
// remboursement, relevé chronologique, annulation contrôlée.
//
// MODÈLE DE SOLDE FOURNISSEUR (documenté, cohérent §29-§33) :
//   Supplier.balance = dette NETTE que NOUS devons au fournisseur.
//     positif  -> nous devons de l'argent au fournisseur
//     négatif  -> crédit en notre faveur (avance non consommée)
//   Une AVANCE est un versement ANTICIPÉ = CREDIT (réduit ce que nous devons) :
//     à la création  -> écriture SupplierAccountEntry CREDIT, balance -= montant
//     à l'allocation -> consomme le crédit dispo, PAS de nouvelle écriture
//                        (le crédit a déjà été comptabilisé à la création) ;
//                        balance INCHANGÉE (pas de double comptage).
//     au remboursement -> écriture DEBIT (annule le crédit), balance += montant
//     à l'annulation  -> annule l'écriture CREDIT d'origine, balance += montant
//   L'ENREGISTREMENT d'un achat (DEBIT) est fait par le module achats (B.3).
//
// Suivi de l'avance (indépendant du compte global) :
//   avanceDispo      = amount - allocatedAmount - refundedAmount
//   achatsRestantY   = Σ(bulletin.totalAmount - bulletin.paidAmount)  [fournisseur]
//   soldeNetZ        = achatsRestantY - avanceDispo   (peut être négatif = crédit)
// =====================================================================
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../prisma';
import { requireAuth, requirePermission } from '../auth/middleware';
import { dec } from './_helpers';
import { auditLog } from '../auth/audit';

const router = Router();
router.use(requireAuth);

const D = (v: Prisma.Decimal.Value | number | string) => new Prisma.Decimal(v);

/** Min de plusieurs Decimal (pas de float). */
function decMin(...vals: Prisma.Decimal[]): Prisma.Decimal {
  return vals.reduce((m, v) => (v.lessThan(m) ? v : m));
}

/** Sérialise une avance en JSON-safe (Decimal -> string). */
function serializeAdvance(a: any) {
  return {
    ...a,
    amount: dec(a.amount),
    allocatedAmount: dec(a.allocatedAmount),
    refundedAmount: dec(a.refundedAmount),
    allocations: a.allocations?.map((al: any) => ({ ...al, amount: dec(al.amount) })),
    refunds: a.refunds?.map((r: any) => ({ ...r, amount: dec(r.amount) })),
  };
}

/**
 * Recalcul et persiste Supplier.balance à partir du ledger (SupplierAccountEntry).
 * Garantit la cohérence après chaque mutation (crédit - débit).
 * balance = Σ(DEBIT) - Σ(CREDIT)  sur les écritures non supprimées.
 */
async function reconcileSupplierBalance(tx: Prisma.TransactionClient, supplierId: string): Promise<Prisma.Decimal> {
  const agg = await tx.supplierAccountEntry.aggregate({
    where: { supplierId, deletedAt: null },
    _sum: { amount: true },
  });
  // On ne peut pas filtrer par type dans _sum directement ; on recompute manuellement.
  const entries = await tx.supplierAccountEntry.findMany({
    where: { supplierId, deletedAt: null },
    select: { type: true, amount: true },
  });
  let balance = D(0);
  for (const e of entries) {
    const amt = D(e.amount);
    balance = e.type === 'DEBIT' ? balance.plus(amt) : balance.minus(amt);
  }
  void agg;
  await tx.supplier.update({ where: { id: supplierId }, data: { balance, updatedBy: undefined } });
  return balance;
}

// ---------------------------------------------------------------------
// POST /api/supplier-advances — enregistre une avance
// ---------------------------------------------------------------------
const createSchema = z.object({
  supplierId: z.string().min(1),
  amount: z.union([z.string(), z.number()]).refine((v) => D(v).greaterThan(0), { message: 'montant > 0' }),
  advanceDate: z.string().optional(), // ISO date
  paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD']).optional(),
  reference: z.string().optional(), // si fourni, sinon auto AV-2026-NNNN
  notes: z.string().optional(),
});

router.post('/', requirePermission('SUPPLIER_CREATE'), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
  const { supplierId, amount, advanceDate, paymentMethod, reference, notes } = parsed.data;
  const amt = D(amount);

  try {
    const advance = await prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.findUnique({ where: { id: supplierId } });
      if (!supplier || supplier.deletedAt) {
        const e: any = new Error('Fournisseur introuvable');
        e.code = 'NOT_FOUND';
        throw e;
      }

      // Génération de la référence unique AV-YYYY-NNNN.
      let ref = reference;
      if (!ref) {
        const year = new Date().getFullYear();
        const prefix = `AV-${year}-`;
        const existing = await tx.supplierAdvance.findMany({
          where: { reference: { startsWith: prefix } },
          select: { reference: true },
        });
        let max = 0;
        for (const r of existing) {
          const m = /^AV-\d{4}-(\d+)$/.exec(r.reference);
          if (m) max = Math.max(max, parseInt(m[1], 10));
        }
        ref = `${prefix}${(max + 1).toString().padStart(4, '0')}`;
      } else {
        const dup = await tx.supplierAdvance.findUnique({ where: { reference: ref } });
        if (dup) {
          const e: any = new Error('Référence déjà utilisée');
          e.code = 'DUP_REF';
          throw e;
        }
      }

      const created = await tx.supplierAdvance.create({
        data: {
          supplierId,
          reference: ref,
          amount: amt,
          allocatedAmount: D(0),
          refundedAmount: D(0),
          advanceDate: advanceDate ? new Date(advanceDate) : new Date(),
          status: 'DISPONIBLE',
          notes,
          createdBy: req.user!.id,
          updatedBy: req.user!.id,
        },
      });

      // Écriture comptable CREDIT (réduit la dette) + mise à jour balance.
      await tx.supplierAccountEntry.create({
        data: {
          supplierId,
          type: 'CREDIT',
          amount: amt,
          description: `Avance fournisseur ${ref}`,
          reference: ref,
          entryDate: new Date(),
          createdBy: req.user!.id,
          updatedBy: req.user!.id,
        },
      });
      await reconcileSupplierBalance(tx, supplierId);

      return created;
    });

    auditLog({ userId: req.user!.id, action: 'SUPPLIER_ADVANCE_CREATE', entity: 'SupplierAdvance', entityId: advance.id, details: { amount: amt.toString(), reference: advance.reference }, req }).catch(() => {});
    res.status(201).json(serializeAdvance(advance));
  } catch (e: any) {
    if (e.code === 'NOT_FOUND') return res.status(404).json({ error: 'Fournisseur introuvable' });
    if (e.code === 'DUP_REF') return res.status(409).json({ error: 'Référence déjà utilisée' });
    console.error('[supplier-advances] create err', e);
    res.status(500).json({ error: 'Erreur création avance' });
  }
});

// ---------------------------------------------------------------------
// POST /api/supplier-advances/:id/allocate — affecte l'avance à un achat
// ---------------------------------------------------------------------
const allocateSchema = z.object({
  purchaseBulletinId: z.string().min(1),
  amount: z.union([z.string(), z.number()]).optional(), // montant souhaité; clampé à min(dispo,restant)
  notes: z.string().optional(),
});

router.post('/:id/allocate', requirePermission('PURCHASE_WRITE'), async (req: Request, res: Response) => {
  const parsed = allocateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
  const { purchaseBulletinId, amount: reqAmount, notes } = parsed.data;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const advance = await tx.supplierAdvance.findUnique({ where: { id: req.params.id } });
      if (!advance || advance.deletedAt) {
        const e: any = new Error('Avance introuvable'); e.code = 'NOT_FOUND'; throw e;
      }
      if (advance.status === 'CANCELLED' || advance.status === 'REFUNDED') {
        const e: any = new Error('Avance non allouable'); e.code = 'BAD_STATUS'; throw e;
      }

      const bulletin = await tx.purchaseBulletin.findUnique({
        where: { id: purchaseBulletinId },
        include: { purchase: true },
      });
      if (!bulletin || bulletin.deletedAt) {
        const e: any = new Error('Bulletin introuvable'); e.code = 'NO_BULLETIN'; throw e;
      }
      // Le bulletin peut être autonome (purchaseId null) OU lié à un Purchase.
      // L'allocation se fait sur le bulletin (il porte totalAmount/paidAmount).
      const purchase = bulletin.purchase;
      const targetSupplierId = bulletin.supplierId ?? (purchase?.supplierId);
      if (!targetSupplierId) {
        const e: any = new Error('Bulletin sans fournisseur'); e.code = 'NO_SUPPLIER'; throw e;
      }
      // Règle stricte: même fournisseur.
      if (targetSupplierId !== advance.supplierId) {
        const e: any = new Error('Fournisseur différent'); e.code = 'SUPPLIER_MISMATCH'; throw e;
      }

      // Pas de doublon (avance, bulletin).
      const existing = await tx.supplierAdvanceAllocation.findFirst({
        where: { advanceId: advance.id, purchaseBulletinId: bulletin.id, deletedAt: null },
      });
      if (existing) {
        const e: any = new Error('Allocation existe déjà'); e.code = 'DUP_ALLOC'; throw e;
      }

      // Calculs (formules §29-§33), tout en Decimal.
      const avanceDispo = D(advance.amount).minus(advance.allocatedAmount).minus(advance.refundedAmount);
      const resteAchat = D(bulletin.totalAmount).minus(bulletin.paidAmount);
      const demande = reqAmount !== undefined ? D(reqAmount) : resteAchat;
      if (demande.lessThanOrEqualTo(0)) {
        const e: any = new Error('Montant invalide'); e.code = 'BAD_AMOUNT'; throw e;
      }
      const utilise = decMin(demande, avanceDispo, resteAchat);
      if (utilise.lessThanOrEqualTo(0)) {
        const e: any = new Error('Rien à allouer (avance ou achat épuisé)'); e.code = 'NOTHING'; throw e;
      }
      if (utilise.greaterThan(avanceDispo)) {
        const e: any = new Error('Dépassement avance'); e.code = 'OVER'; throw e;
      }

      const newAllocated = D(advance.allocatedAmount).plus(utilise);
      const remainingAfter = D(advance.amount).minus(newAllocated).minus(advance.refundedAmount);
      let status: any;
      if (D(advance.refundedAmount).gt(0) && D(advance.refundedAmount).equals(advance.amount)) status = 'REFUNDED';
      else if (remainingAfter.lessThanOrEqualTo(0)) status = 'ALLOCATED';
      else if (newAllocated.greaterThan(0)) status = 'PARTIALLY_ALLOCATED';
      else status = 'DISPONIBLE';

      // 1) création allocation
      const allocation = await tx.supplierAdvanceAllocation.create({
        data: {
          advanceId: advance.id,
          purchaseId: purchase?.id,
          purchaseBulletinId: bulletin.id,
          amount: utilise,
          allocatedAt: new Date(),
          notes,
          createdBy: req.user!.id,
          updatedBy: req.user!.id,
        },
      });
      // 2) MAJ avance
      const updAdvance = await tx.supplierAdvance.update({
        where: { id: advance.id },
        data: { allocatedAmount: newAllocated, status },
      });
      // 3) MAJ bulletin (payé/restant)
      const newPaid = D(bulletin.paidAmount).plus(utilise);
      await tx.purchaseBulletin.update({
        where: { id: bulletin.id },
        data: { paidAmount: newPaid },
      });
      // 4) balance fournisseur: inchangée (crédit déjà comptabilisé à la création).
      //    On reconcile quand même pour garantir la cohérence.
      const balance = await reconcileSupplierBalance(tx, advance.supplierId);

      return { allocation, advance: updAdvance, utilise: utilise.toString(), newResteAchat: D(bulletin.totalAmount).minus(newPaid).toString(), avanceDispoRest: remainingAfter.toString(), balance: balance.toString() };
    });

    auditLog({ userId: req.user!.id, action: 'SUPPLIER_ADVANCE_ALLOCATE', entity: 'SupplierAdvance', entityId: req.params.id, details: { utilise: result.utilise, bulletin: purchaseBulletinId }, req }).catch(() => {});
    res.json(result);
  } catch (e: any) {
    const map: Record<string, number> = { NOT_FOUND: 404, NO_BULLETIN: 404, NO_PURCHASE: 404, BAD_STATUS: 409, SUPPLIER_MISMATCH: 409, DUP_ALLOC: 409, BAD_AMOUNT: 400, NOTHING: 409, OVER: 409 };
    const status = map[e.code] ?? 500;
    if (status === 500) console.error('[supplier-advances] allocate err', e);
    res.status(status).json({ error: e.message ?? 'Erreur allocation' });
  }
});

// ---------------------------------------------------------------------
// POST /api/supplier-advances/:id/refund — remboursement (<= dispo)
// ---------------------------------------------------------------------
const refundSchema = z.object({
  amount: z.union([z.string(), z.number()]).optional(), // défaut = dispo total
  refundDate: z.string().optional(),
  method: z.enum(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD']).optional(),
  notes: z.string().optional(),
});

router.post('/:id/refund', requirePermission('PURCHASE_WRITE'), async (req: Request, res: Response) => {
  const parsed = refundSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
  const { amount: reqAmount, refundDate, method, notes } = parsed.data;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const advance = await tx.supplierAdvance.findUnique({ where: { id: req.params.id } });
      if (!advance || advance.deletedAt) { const e: any = new Error('Avance introuvable'); e.code = 'NOT_FOUND'; throw e; }
      if (advance.status === 'CANCELLED') { const e: any = new Error('Avance annulée'); e.code = 'BAD_STATUS'; throw e; }

      const avanceDispo = D(advance.amount).minus(advance.allocatedAmount).minus(advance.refundedAmount);
      const refundAmt = reqAmount !== undefined ? D(reqAmount) : avanceDispo;
      if (refundAmt.lessThanOrEqualTo(0)) { const e: any = new Error('Rien à rembourser'); e.code = 'NOTHING'; throw e; }
      if (refundAmt.greaterThan(avanceDispo)) { const e: any = new Error('Remboursement > avance dispo'); e.code = 'OVER'; throw e; }

      const newRefunded = D(advance.refundedAmount).plus(refundAmt);
      const remainingAfter = D(advance.amount).minus(advance.allocatedAmount).minus(newRefunded);
      let status: any;
      if (newRefunded.equals(advance.amount)) status = 'REFUNDED';
      else if (remainingAfter.lessThanOrEqualTo(0)) status = 'ALLOCATED';
      else if (D(advance.allocatedAmount).plus(newRefunded).greaterThan(0)) status = 'PARTIALLY_ALLOCATED';
      else status = 'DISPONIBLE';

      const refund = await tx.supplierAdvanceRefund.create({
        data: {
          advanceId: advance.id,
          amount: refundAmt,
          refundDate: refundDate ? new Date(refundDate) : new Date(),
          method: method ?? 'CASH',
          notes,
          createdBy: req.user!.id,
          updatedBy: req.user!.id,
        },
      });
      const updAdvance = await tx.supplierAdvance.update({
        where: { id: advance.id },
        data: { refundedAmount: newRefunded, status },
      });
      // Écriture DEBIT (annule le crédit) -> balance += montant remboursé.
      await tx.supplierAccountEntry.create({
        data: {
          supplierId: advance.supplierId,
          type: 'DEBIT',
          amount: refundAmt,
          description: `Remboursement avance ${advance.reference}`,
          reference: advance.reference,
          entryDate: new Date(),
          createdBy: req.user!.id,
          updatedBy: req.user!.id,
        },
      });
      const balance = await reconcileSupplierBalance(tx, advance.supplierId);

      return { refund, advance: updAdvance, avanceDispoRest: remainingAfter.toString(), balance: balance.toString() };
    });

    auditLog({ userId: req.user!.id, action: 'SUPPLIER_ADVANCE_REFUND', entity: 'SupplierAdvance', entityId: req.params.id, details: { amount: result.refund.amount.toString() }, req }).catch(() => {});
    res.json({ ...result, refund: { ...result.refund, amount: dec(result.refund.amount) }, advance: serializeAdvance(result.advance) });
  } catch (e: any) {
    const map: Record<string, number> = { NOT_FOUND: 404, BAD_STATUS: 409, NOTHING: 409, OVER: 409 };
    const status = map[e.code] ?? 500;
    if (status === 500) console.error('[supplier-advances] refund err', e);
    res.status(status).json({ error: e.message ?? 'Erreur remboursement' });
  }
});

// ---------------------------------------------------------------------
// POST /api/supplier-advances/:id/cancel — annulation si NON utilisée
// ---------------------------------------------------------------------
router.post('/:id/cancel', requirePermission('PURCHASE_WRITE'), async (req: Request, res: Response) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const advance = await tx.supplierAdvance.findUnique({ where: { id: req.params.id } });
      if (!advance || advance.deletedAt) { const e: any = new Error('Avance introuvable'); e.code = 'NOT_FOUND'; throw e; }
      if (D(advance.allocatedAmount).gt(0) || D(advance.refundedAmount).gt(0)) {
        const e: any = new Error('Avance déjà utilisée/remboursée — annulation directe impossible'); e.code = 'USED'; throw e;
      }
      // Inverse contrôlé: annule l'écriture CREDIT d'origine (soft delete) -> balance += montant.
      await tx.supplierAccountEntry.updateMany({
        where: { reference: advance.reference, supplierId: advance.supplierId, type: 'CREDIT', deletedAt: null },
        data: { deletedAt: new Date() },
      });
      const updAdvance = await tx.supplierAdvance.update({
        where: { id: advance.id },
        data: { status: 'CANCELLED', updatedBy: req.user!.id },
      });
      const balance = await reconcileSupplierBalance(tx, advance.supplierId);
      return { advance: updAdvance, balance: balance.toString() };
    });
    auditLog({ userId: req.user!.id, action: 'SUPPLIER_ADVANCE_CANCEL', entity: 'SupplierAdvance', entityId: req.params.id, req }).catch(() => {});
    res.json({ ...result, advance: serializeAdvance(result.advance) });
  } catch (e: any) {
    const map: Record<string, number> = { NOT_FOUND: 404, USED: 409 };
    const status = map[e.code] ?? 500;
    if (status === 500) console.error('[supplier-advances] cancel err', e);
    res.status(status).json({ error: e.message ?? 'Erreur annulation' });
  }
});

// ---------------------------------------------------------------------
// GET /api/suppliers/:id/statement — relevé chronologique
// ---------------------------------------------------------------------
router.get('/supplier/:id/statement', requirePermission('SUPPLIER_READ'), async (req: Request, res: Response) => {
  const supplierId = req.params.id;
  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!supplier || supplier.deletedAt) return res.status(404).json({ error: 'Fournisseur introuvable' });

  const advances = await prisma.supplierAdvance.findMany({
    where: { supplierId, deletedAt: null },
    include: { allocations: { where: { deletedAt: null }, include: { purchaseBulletin: true } }, refunds: { where: { deletedAt: null } } },
    orderBy: { advanceDate: 'asc' },
  });
  const bulletins = await prisma.purchaseBulletin.findMany({
    where: { purchase: { supplierId }, deletedAt: null },
    include: { purchase: true },
    orderBy: { date: 'asc' },
  });
  const entries = await prisma.supplierAccountEntry.findMany({
    where: { supplierId, deletedAt: null },
    orderBy: { entryDate: 'asc' },
  });

  // Résumé séparé (§33).
  let avanceDispo = D(0);
  for (const a of advances) {
    if (a.status === 'CANCELLED') continue;
    avanceDispo = avanceDispo.plus(D(a.amount).minus(a.allocatedAmount).minus(a.refundedAmount));
  }
  let achatsRestant = D(0);
  for (const b of bulletins) achatsRestant = achatsRestant.plus(D(b.totalAmount).minus(b.paidAmount));
  const soldeNet = achatsRestant.minus(avanceDispo);

  // Timeline chronologique (solde après chaque op).
  type Ev = { date: string | Date; kind: string; label: string; amount: string; balanceAfter: string };
  const events: Ev[] = [];
  let running = D(0);
  // On reconstruit le solde courant du ledger comme point de départ.
  for (const e of entries) running = e.type === 'DEBIT' ? running.plus(D(e.amount)) : running.minus(D(e.amount));
  // (le solde net ci-dessus est le solde fournisseur ; ici on trace le compte.)
  const timeline = [
    ...advances.map((a) => ({ ts: new Date(a.advanceDate).getTime(), date: a.advanceDate, kind: 'AVANCE', label: `Avance ${a.reference}`, amount: D(a.amount).toString() })),
    ...entries.map((e) => ({ ts: new Date(e.entryDate).getTime(), date: e.entryDate, kind: `ENTRY_${e.type}`, label: e.description ?? e.type, amount: D(e.amount).toString() })),
    ...bulletins.map((b) => ({ ts: new Date(b.date).getTime(), date: b.date, kind: 'ACHAT', label: `Bulletin ${b.reference}`, amount: D(b.totalAmount).toString() })),
    ...advances.flatMap((a) => a.allocations.map((al) => ({ ts: new Date(al.allocatedAt).getTime(), date: al.allocatedAt, kind: 'DEDUCTION', label: `Déduction ${a.reference} -> ${al.purchaseBulletin?.reference ?? al.purchaseId}`, amount: D(al.amount).toString() }))),
    ...advances.flatMap((a) => a.refunds.map((r) => ({ ts: new Date(r.refundDate).getTime(), date: r.refundDate, kind: 'REMBOURSEMENT', label: `Remboursement ${a.reference}`, amount: D(r.amount).toString() }))),
  ].sort((x, y) => x.ts - y.ts);

  // solde après chaque op (sur le compte fournisseur).
  let bal = D(0);
  const ledger = entries.slice().sort((a, b) => new Date(a.entryDate).getTime() - new Date(b.entryDate).getTime());
  let li = 0;
  for (const ev of timeline) {
    while (li < ledger.length && new Date(ledger[li].entryDate).getTime() <= ev.ts) {
      bal = ledger[li].type === 'DEBIT' ? bal.plus(D(ledger[li].amount)) : bal.minus(D(ledger[li].amount));
      li++;
    }
    events.push({ date: ev.date, kind: ev.kind, label: ev.label, amount: ev.amount, balanceAfter: bal.toString() });
  }

  res.json({
    supplier: { id: supplier.id, name: supplier.name, balance: dec(supplier.balance) },
    summary: {
      avanceDispo: avanceDispo.toString(),
      achatsRestant: achatsRestant.toString(),
      soldeNet: soldeNet.toString(),
    },
    advances: advances.map(serializeAdvance),
    bulletins: bulletins.map((b) => ({ ...b, totalAmount: dec(b.totalAmount), paidAmount: dec(b.paidAmount) })),
    timeline: events,
  });
});

// ---------------------------------------------------------------------
// Helpers de lecture (utiles aux tests / autres modules)
// ---------------------------------------------------------------------
router.get('/', requirePermission('SUPPLIER_READ'), async (_req, res) => {
  const items = await prisma.supplierAdvance.findMany({ where: { deletedAt: null }, orderBy: { advanceDate: 'desc' } });
  res.json(items.map(serializeAdvance));
});

router.get('/:id', requirePermission('SUPPLIER_READ'), async (req, res) => {
  const a = await prisma.supplierAdvance.findUnique({
    where: { id: req.params.id },
    include: { allocations: { where: { deletedAt: null }, include: { purchaseBulletin: true } }, refunds: { where: { deletedAt: null } } },
  });
  if (!a || a.deletedAt) return res.status(404).json({ error: 'Introuvable' });
  res.json(serializeAdvance(a));
});

// PATCH /api/supplier-advances/:id — mise à jour statut (rembourse/annule) + notes (Étape 4)
const FR_TO_ENUM: Record<string, string> = {
  non_affectee: 'DISPONIBLE',
  partiellement_affectee: 'PARTIALLY_ALLOCATED',
  totalement_affectee: 'ALLOCATED',
  rembourse: 'REFUNDED',
  annule: 'CANCELLED',
};
const patchAdvanceSchema = z.object({
  status: z.string().optional(), // FR ou enum
  notes: z.string().optional().nullable(),
});
router.patch('/:id', requirePermission('PURCHASE_WRITE'), async (req: Request, res: Response) => {
  const parsed = patchAdvanceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
  const a = await prisma.supplierAdvance.findUnique({ where: { id: req.params.id } });
  if (!a || a.deletedAt) return res.status(404).json({ error: 'Avance introuvable' });
  const data: any = {};
  if (parsed.data.status !== undefined) {
    const enumStatus = FR_TO_ENUM[parsed.data.status] ?? parsed.data.status;
    if (!['DISPONIBLE', 'PARTIALLY_ALLOCATED', 'ALLOCATED', 'REFUNDED', 'CANCELLED', 'PENDING'].includes(enumStatus)) {
      return res.status(400).json({ error: 'Statut invalide' });
    }
    data.status = enumStatus;
  }
  if (parsed.data.notes !== undefined) data.notes = parsed.data.notes ?? null;
  data.updatedBy = req.user!.id;
  const upd = await prisma.supplierAdvance.update({ where: { id: a.id }, data });
  res.json(serializeAdvance(upd));
});

export default router;
