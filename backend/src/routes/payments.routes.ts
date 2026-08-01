// =====================================================================
// PHASE C — Encaissements client (Payment).
// Routes:
//   POST   /api/payments            -> enregistre un encaissement client
//   GET    /api/payments            -> liste (filtres customerId/invoiceId/saleId/method)
//   DELETE /api/payments/:id        -> annulation (soft) + annulation des effets
//
// MODÈLE DE SOLDE CLIENT (cohérent §24, §29-§33) :
//   Customer.balance = dette NETTE que le client nous doit.
//     positif  -> le client nous doit de l'argent (crédit utilisé)
//     négatif  -> crédit en faveur du client (avance/règlement excédentaire)
//   Un ENCAISSEMENT client réduit sa dette => balance -= amount.
//   Une FACTURE émise augmente la dette => balance += total (fait par le module Ventes/Factures).
//   Le statut de l'INVOICE reflète le total payé :
//     paid >= total        -> PAID
//     paid > 0 && < total  -> PARTIALLY_PAID
//     paid == 0            -> SENT (ou DRAFT si jamais envoyée)
//
// Toute mutation est enveloppée dans prisma.$transaction + try/catch -> JSON 400/500.
// =====================================================================
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { requireAuth, requirePermission } from '../auth/middleware';
import { dec } from './_helpers';
import { auditLog } from '../auth/audit';

const router = Router();
router.use(requireAuth);

const D = (v: Prisma.Decimal.Value | number | string) => new Prisma.Decimal(v);

/** Sérialise un Payment en JSON-safe (Decimal -> string). */
function serializePayment(p: any) {
  return {
    ...p,
    amount: dec(p.amount),
    customer: p.customer ? { ...p.customer, balance: dec(p.customer.balance), creditLimit: dec(p.customer.creditLimit) } : undefined,
    invoice: p.invoice ? { ...p.invoice, subtotal: dec(p.invoice.subtotal), taxAmount: dec(p.invoice.taxAmount), total: dec(p.invoice.total) } : undefined,
    sale: p.sale ? { ...p.sale, subtotal: dec(p.sale.subtotal), total: dec(p.sale.total) } : undefined,
  };
}

/** Génère une référence d'encaissement unique ENC-YYYY-NNNN. */
async function nextReference(tx: Prisma.TransactionClient): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `ENC-${year}-`;
  const existing = await tx.payment.findMany({
    where: { reference: { startsWith: prefix } },
    select: { reference: true },
  });
  let max = 0;
  for (const r of existing) {
    const m = /^ENC-\d{4}-(\d+)$/.exec(r.reference);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}${(max + 1).toString().padStart(4, '0')}`;
}

/**
 * Recalcule le statut de la facture à partir du total payé (somme des encaissements
 * non annulés liés à l'invoice). Ne touche pas au solde client (déjà géré ailleurs).
 */
async function reconcileInvoice(tx: Prisma.TransactionClient, invoiceId: string): Promise<void> {
  const agg = await tx.payment.aggregate({
    where: { invoiceId, deletedAt: null },
    _sum: { amount: true },
  });
  const paid = D(agg._sum.amount ?? 0);
  const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return;
  const total = D(invoice.total);
  let status: any = invoice.status;
  if (paid.greaterThanOrEqualTo(total)) status = 'PAID';
  else if (paid.greaterThan(0)) status = 'PARTIALLY_PAID';
  else status = invoice.status === 'PAID' || invoice.status === 'PARTIALLY_PAID' ? 'SENT' : invoice.status;
  await tx.invoice.update({ where: { id: invoiceId }, data: { status } });
}

// ---------------------------------------------------------------------
// POST /api/payments — enregistre un encaissement client
// ---------------------------------------------------------------------
const createSchema = z.object({
  customerId: z.string().optional(),
  invoiceId: z.string().optional(),
  saleId: z.string().optional(),
  amount: z.union([z.string(), z.number()]).refine((v) => {
    // IMPORTANT : ne JAMAIS laisser new Prisma.Decimal(v) throw ici. Une exception
    // levée dans un refine Zod n'est PAS capturée par safeParse -> le handler async
    // rejette sans réponse (hang/500 « Erreur création encaissement »). On valide
    // donc de façon défensive : nombre fini > 0, sinon refus propre (400).
    try {
      if (v === null || v === undefined || v === '') return false;
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) return false;
      return D(v).greaterThan(0);
    } catch {
      return false;
    }
  }, { message: 'montant > 0' }),
  method: z.enum(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD']).optional(),
  paymentDate: z.string().optional(), // ISO date
  notes: z.string().optional(),
});

router.post('/', requirePermission('PAYMENT_WRITE'), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
  const { customerId, invoiceId, saleId, amount, method, paymentDate, notes } = parsed.data;
  const amt = D(amount);

  try {
    const payment = await prisma.$transaction(async (tx) => {
      // Résolution du client : explicite, sinon déduit de la facture/vente.
      let finalCustomerId = customerId;
      if (!finalCustomerId && invoiceId) {
        const inv = await tx.invoice.findUnique({ where: { id: invoiceId }, select: { customerId: true } });
        finalCustomerId = inv?.customerId ?? undefined;
      }
      if (!finalCustomerId && saleId) {
        const sale = await tx.sale.findUnique({ where: { id: saleId }, select: { customerId: true } });
        finalCustomerId = sale?.customerId ?? undefined;
      }
      if (!finalCustomerId) {
        const e: any = new Error('Client requis (fournir customerId, ou lier à une facture/vente)'); e.code = 'NO_CUSTOMER'; throw e;
      }
      const customer = await tx.customer.findUnique({ where: { id: finalCustomerId } });
      if (!customer || customer.deletedAt) {
        const e: any = new Error('Client introuvable'); e.code = 'NOT_FOUND'; throw e;
      }
      if (invoiceId) {
        const inv = await tx.invoice.findUnique({ where: { id: invoiceId } });
        if (!inv || inv.deletedAt) {
          const e: any = new Error('Facture introuvable'); e.code = 'INV_NOT_FOUND'; throw e;
        }
        if (inv.customerId && inv.customerId !== finalCustomerId) {
          const e: any = new Error('La facture n\'appartient pas à ce client'); e.code = 'INV_MISMATCH'; throw e;
        }
        // RÈGLE MÉTIER : refuser un encaissement sur une facture déjà payée (restant == 0).
        const paidAgg = await tx.payment.aggregate({
          where: { invoiceId, deletedAt: null },
          _sum: { amount: true },
        });
        const paid = D(paidAgg._sum.amount ?? 0);
        const remaining = D(inv.total).minus(paid);
        if (remaining.lessThanOrEqualTo(0)) {
          const e: any = new Error('Facture déjà payée'); e.code = 'INVOICE_PAID'; throw e;
        }
        // Empêche aussi un encaissement qui dépasse le restant dû.
        if (amt.greaterThan(remaining)) {
          const e: any = new Error(`Montant supérieur au restant dû (${dec(remaining)} DA)`); e.code = 'AMOUNT_EXCEEDS'; throw e;
        }
      }
      if (saleId) {
        const sale = await tx.sale.findUnique({ where: { id: saleId } });
        if (!sale || sale.deletedAt) {
          const e: any = new Error('Vente introuvable'); e.code = 'SALE_NOT_FOUND'; throw e;
        }
        if (sale.customerId && sale.customerId !== finalCustomerId) {
          const e: any = new Error('La vente n\'appartient pas à ce client'); e.code = 'SALE_MISMATCH'; throw e;
        }
      }

      const reference = await nextReference(tx);

      // 1) Création du paiement (encaissement client).
      const created = await tx.payment.create({
        data: {
          reference,
          customerId: finalCustomerId,
          invoiceId,
          saleId,
          amount: amt,
          method: (method as any) ?? 'CASH',
          paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
          notes,
          createdBy: req.user!.id,
          updatedBy: req.user!.id,
        },
        include: { customer: true, invoice: true, sale: true },
      });

      // 2) Mise à jour du solde client : un encaissement réduit la dette.
      const newBalance = D(customer.balance).minus(amt);
      await tx.customer.update({
        where: { id: finalCustomerId },
        data: { balance: newBalance, updatedBy: req.user!.id },
      });

      // 3) Mise à jour du statut de la facture liée (si présente).
      if (invoiceId) await reconcileInvoice(tx, invoiceId);

      return created;
    });

    auditLog({ userId: req.user!.id, action: 'PAYMENT_CREATE', entity: 'Payment', entityId: payment.id, details: { amount: amt.toString(), reference: payment.reference, customerId, invoiceId }, req }).catch(() => {});
    res.status(201).json(serializePayment(payment));
  } catch (e: any) {
    if (e.code === 'NOT_FOUND') return res.status(404).json({ error: 'Client introuvable' });
    if (e.code === 'INV_NOT_FOUND') return res.status(404).json({ error: 'Facture introuvable' });
    if (e.code === 'INV_MISMATCH') return res.status(409).json({ error: 'La facture n\'appartient pas à ce client' });
    if (e.code === 'INVOICE_PAID') return res.status(400).json({ error: 'Facture déjà payée' });
    if (e.code === 'AMOUNT_EXCEEDS') return res.status(400).json({ error: e.message, code: 'AMOUNT_EXCEEDS' });
    if (e.code === 'SALE_NOT_FOUND') return res.status(404).json({ error: 'Vente introuvable' });
    if (e.code === 'SALE_MISMATCH') return res.status(409).json({ error: 'La vente n\'appartient pas à ce client' });
    if (e.code === 'P2003' || e.code === 'P2025') return res.status(400).json({ error: 'Référence invalide', code: e.code });
    console.error('[payments] create err', e);
    res.status(500).json({ error: 'Erreur création encaissement' });
  }
});

// ---------------------------------------------------------------------
// GET /api/payments — liste (filtres customerId/invoiceId/saleId/method)
// ---------------------------------------------------------------------
router.get('/', requirePermission('PAYMENT_READ'), async (req: Request, res: Response) => {
  try {
    const where: Prisma.PaymentWhereInput = { deletedAt: null };
    if (typeof req.query.customerId === 'string') where.customerId = req.query.customerId;
    if (typeof req.query.invoiceId === 'string') where.invoiceId = req.query.invoiceId;
    if (typeof req.query.saleId === 'string') where.saleId = req.query.saleId;
    if (typeof req.query.method === 'string') where.method = req.query.method as any;

    const page = Math.max(1, parseInt((req.query.page as string) ?? '1', 10) || 1);
    const take = Math.min(200, Math.max(1, parseInt((req.query.take as string) ?? '50', 10) || 50));
    const skip = (page - 1) * take;

    const [items, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: { customer: { select: { id: true, name: true, balance: true, creditLimit: true } }, invoice: { select: { id: true, reference: true, total: true, status: true } }, sale: { select: { id: true, reference: true, total: true } } },
        orderBy: { paymentDate: 'desc' },
        skip,
        take,
      }),
      prisma.payment.count({ where }),
    ]);
    res.json({ items: items.map(serializePayment), total, page, take, totalPages: Math.ceil(total / take) });
  } catch (e: any) {
    console.error('[payments] list err', e);
    res.status(500).json({ error: 'Erreur liste encaissements' });
  }
});

// ---------------------------------------------------------------------
// DELETE /api/payments/:id — annulation (soft) + annulation des effets
// ---------------------------------------------------------------------
router.delete('/:id', requirePermission('PAYMENT_WRITE'), async (req: Request, res: Response) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id: req.params.id } });
      if (!payment || payment.deletedAt) {
        const e: any = new Error('Encaissement introuvable'); e.code = 'NOT_FOUND'; throw e;
      }
      const customer = await tx.customer.findUnique({ where: { id: payment.customerId! } });
      if (!customer) {
        const e: any = new Error('Client introuvable'); e.code = 'NO_CUSTOMER'; throw e;
      }

      // 1) Soft-delete du paiement.
      const updated = await tx.payment.update({
        where: { id: payment.id },
        data: { deletedAt: new Date(), updatedBy: req.user!.id },
      });

      // 2) Annule l'effet sur le solde client : on remet la dette (balance += amount).
      const newBalance = D(customer.balance).plus(D(payment.amount));
      await tx.customer.update({
        where: { id: customer.id },
        data: { balance: newBalance, updatedBy: req.user!.id },
      });

      // 3) Annule l'effet sur la facture liée (recalcule le statut).
      if (payment.invoiceId) await reconcileInvoice(tx, payment.invoiceId);

      return { payment: updated, newBalance: newBalance.toString() };
    });

    auditLog({ userId: req.user!.id, action: 'PAYMENT_DELETE', entity: 'Payment', entityId: req.params.id, details: { customerId: result.payment.customerId }, req }).catch(() => {});
    res.json({ message: 'Encaissement annulé', payment: serializePayment(result.payment), newBalance: result.newBalance });
  } catch (e: any) {
    if (e.code === 'NOT_FOUND') return res.status(404).json({ error: 'Encaissement introuvable' });
    if (e.code === 'NO_CUSTOMER') return res.status(404).json({ error: 'Client introuvable' });
    console.error('[payments] delete err', e);
    res.status(500).json({ error: 'Erreur annulation encaissement' });
  }
});

export default router;
