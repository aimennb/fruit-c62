import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { requireAuth, requirePermission } from '../auth/middleware';
import { dec, parseListQuery, paginate, moneyField, checkCreditLimit } from './_helpers';
import { auditLog } from '../auth/audit';

const D = (v: Prisma.Decimal.Value | number | string) => new Prisma.Decimal(v);

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------
// Schémas de validation (§24)
// ---------------------------------------------------------------------
const money = z.union([z.string(), z.number()]).optional();

const customerInput = z.object({
  name: z.string().min(1).max(150), // nom FR
  nameAr: z.string().max(150).optional(), // nom arabe (optionnel)
  contactName: z.string().max(120).optional(), // contact
  phone: z.string().max(40).optional(),
  email: z.string().email().optional().or(z.literal('')),
  address: z.string().optional(),
  commune: z.string().max(100).optional(), // commune
  wilaya: z.string().max(100).optional(), // wilaya
  nif: z.string().max(40).optional(), // NIF
  creditLimit: money, // limite de crédit
  paymentTerms: z.string().max(200).optional(), // conditions de paiement
  notes: z.string().optional(), // notes
  isActive: z.boolean().default(true), // statut actif/archivé
});

const customerUpdate = customerInput.partial();

function serialize(c: any) {
  return { ...c, balance: dec(c.balance), creditLimit: dec(c.creditLimit) };
}

/**
 * GET /api/customers
 * @summary Liste paginée des clients (recherche/filtre/tri).
 * @tag Customers
 */
router.get('/', requirePermission('CUSTOMER_READ'), async (req, res) => {
  const q = parseListQuery(req);
  const where: Prisma.CustomerWhereInput = { deletedAt: null };
  if (q.q) {
    where.OR = [
      { name: { contains: q.q, mode: 'insensitive' } },
      { nameAr: { contains: q.q, mode: 'insensitive' } },
      { contactName: { contains: q.q, mode: 'insensitive' } },
      { nif: { contains: q.q, mode: 'insensitive' } },
      { phone: { contains: q.q } },
    ];
  }
  if (q.active !== undefined) where.isActive = q.active;

  const orderBy: Prisma.CustomerOrderByWithRelationInput = q.sortBy
    ? ({ [q.sortBy]: q.sortDir } as Prisma.CustomerOrderByWithRelationInput)
    : { name: 'asc' };

  const [items, total] = await Promise.all([
    prisma.customer.findMany({ where, orderBy, skip: q.skip, take: q.take }),
    prisma.customer.count({ where }),
  ]);
  res.json(paginate(items.map(serialize), total, q.page, q.take));
});

/**
 * GET /api/customers/:id
 * @summary Détail d'un client.
 * @tag Customers
 */
router.get('/:id', requirePermission('CUSTOMER_READ'), async (req, res) => {
  const c = await prisma.customer.findUnique({ where: { id: req.params.id } });
  if (!c || c.deletedAt) return res.status(404).json({ error: 'Introuvable' });
  res.json(serialize(c));
});

/**
 * POST /api/customers
 * @summary Crée un client.
 * @tag Customers
 */
router.post('/', requirePermission('CUSTOMER_CREATE'), async (req, res) => {
  const parsed = customerInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
  const d = parsed.data;
  const data: Prisma.CustomerCreateInput = {
    name: d.name,
    nameAr: d.nameAr,
    contactName: d.contactName,
    phone: d.phone,
    email: d.email || null,
    address: d.address,
    commune: d.commune,
    wilaya: d.wilaya,
    nif: d.nif,
    creditLimit: moneyField(d.creditLimit),
    paymentTerms: d.paymentTerms,
    notes: d.notes,
    isActive: d.isActive,
    createdBy: req.user!.id,
    updatedBy: req.user!.id,
  };
  const c = await prisma.customer.create({ data });
  auditLog({ userId: req.user!.id, action: 'CUSTOMER_CREATE', entity: 'Customer', entityId: c.id, req }).catch(() => {});
  res.status(201).json(serialize(c));
});

/**
 * PUT /api/customers/:id
 * @summary Met à jour un client.
 * @tag Customers
 */
router.put('/:id', requirePermission('CUSTOMER_UPDATE'), async (req, res) => {
  const parsed = customerUpdate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
  const d = parsed.data;
  const data: Prisma.CustomerUpdateInput = {
    name: d.name,
    nameAr: d.nameAr,
    contactName: d.contactName,
    phone: d.phone,
    email: d.email === undefined ? undefined : d.email || null,
    address: d.address,
    commune: d.commune,
    wilaya: d.wilaya,
    nif: d.nif,
    creditLimit: moneyField(d.creditLimit),
    paymentTerms: d.paymentTerms,
    notes: d.notes,
    isActive: d.isActive,
    updatedBy: req.user!.id,
  };
  const c = await prisma.customer.update({ where: { id: req.params.id }, data });
  auditLog({ userId: req.user!.id, action: 'CUSTOMER_UPDATE', entity: 'Customer', entityId: c.id, req }).catch(() => {});
  res.json(serialize(c));
});

/**
 * DELETE /api/customers/:id
 * @summary Suppression douce (archivage si utilisé, sinon soft-delete).
 * @tag Customers
 */
router.delete('/:id', requirePermission('CUSTOMER_DELETE'), async (req, res) => {
  const c = await prisma.customer.findUnique({ where: { id: req.params.id } });
  if (!c || c.deletedAt) return res.status(404).json({ error: 'Introuvable' });

  const inUse =
    (await prisma.sale.count({ where: { customerId: c.id } })) > 0 ||
    (await prisma.invoice.count({ where: { customerId: c.id } })) > 0 ||
    (await prisma.payment.count({ where: { customerId: c.id } })) > 0 ||
    (await prisma.creditNote.count({ where: { customerId: c.id } })) > 0;

  if (inUse) {
    const updated = await prisma.customer.update({
      where: { id: c.id },
      data: { isActive: false, updatedBy: req.user!.id },
    });
    auditLog({ userId: req.user!.id, action: 'CUSTOMER_ARCHIVE', entity: 'Customer', entityId: c.id, req }).catch(() => {});
    res.json({ message: 'Client archivé (utilisé)', archived: true, customer: serialize(updated) });
    return;
  }

  const updated = await prisma.customer.update({
    where: { id: c.id },
    data: { deletedAt: new Date(), updatedBy: req.user!.id },
  });
  auditLog({ userId: req.user!.id, action: 'CUSTOMER_DELETE', entity: 'Customer', entityId: c.id, req }).catch(() => {});
  res.json({ message: 'Client supprimé (soft delete)', archived: false, customer: serialize(updated) });
});

/**
 * GET /api/customers/:id/summary
 * @summary Synthèse simplifiée du client (Phase B) : solde, limite de crédit, factures impayées, dernières ventes.
 * @tag Customers
 */
router.get('/:id/summary', requirePermission('CUSTOMER_READ'), async (req, res) => {
  const c = await prisma.customer.findUnique({ where: { id: req.params.id } });
  if (!c || c.deletedAt) return res.status(404).json({ error: 'Introuvable' });

  const unpaidInvoices = await prisma.invoice.findMany({
    where: { customerId: c.id, deletedAt: null, status: { in: ['SENT', 'PARTIALLY_PAID', 'OVERDUE'] } },
    orderBy: { dueDate: 'asc' },
    select: { id: true, reference: true, issueDate: true, dueDate: true, status: true, total: true, subtotal: true, taxAmount: true },
  });

  const recentSales = await prisma.sale.findMany({
    where: { customerId: c.id, deletedAt: null },
    orderBy: { date: 'desc' },
    take: 10,
    select: { id: true, reference: true, date: true, status: true, total: true },
  });

  const totalUnpaid = unpaidInvoices.reduce(
    (a, inv) => a.plus(inv.total),
    new (require('@prisma/client').Prisma).Decimal(0),
  );

  res.json({
    customer: serialize(c),
    balance: dec(c.balance),
    creditLimit: dec(c.creditLimit),
    availableCredit: dec(new (require('@prisma/client').Prisma).Decimal(c.creditLimit).minus(c.balance)),
    unpaidInvoices: {
      count: unpaidInvoices.length,
      total: dec(totalUnpaid),
      invoices: unpaidInvoices.map((i) => ({
        ...i,
        subtotal: dec(i.subtotal),
        taxAmount: dec(i.taxAmount),
        total: dec(i.total),
      })),
    },
    recentSales: recentSales.map((s) => ({ ...s, total: dec(s.total) })),
  });
});

/**
 * GET /api/customers/:id/statement
 * @summary Relevé client : ventes, factures, paiements, solde courant (balance),
 *          limite de crédit (creditLimit), dépassement éventuel. Agrège Sale/Invoice/Payment.
 * @tag Customers
 */
router.get('/:id/statement', requirePermission('CUSTOMER_READ'), async (req, res) => {
  try {
    const c = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!c || c.deletedAt) return res.status(404).json({ error: 'Introuvable' });

    // Ventes du client.
    const sales = await prisma.sale.findMany({
      where: { customerId: c.id, deletedAt: null },
      orderBy: { date: 'desc' },
      select: { id: true, reference: true, date: true, status: true, subtotal: true, total: true },
    });
    // Factures du client.
    const invoices = await prisma.invoice.findMany({
      where: { customerId: c.id, deletedAt: null },
      orderBy: { issueDate: 'desc' },
      select: { id: true, reference: true, saleId: true, issueDate: true, dueDate: true, status: true, subtotal: true, taxAmount: true, total: true },
    });
    // Paiements (encaissements) du client.
    const payments = await prisma.payment.findMany({
      where: { customerId: c.id, deletedAt: null },
      orderBy: { paymentDate: 'desc' },
      select: { id: true, reference: true, invoiceId: true, saleId: true, amount: true, method: true, paymentDate: true, notes: true },
    });
    // Notes de crédit (éventuelles).
    const creditNotes = await prisma.creditNote.findMany({
      where: { customerId: c.id, deletedAt: null },
      orderBy: { date: 'desc' },
      select: { id: true, reference: true, invoiceId: true, amount: true, reason: true, status: true, date: true },
    });

    // Totaux (tout en Decimal).
    const totalSales = sales.reduce((a, s) => a.plus(D(s.total)), D(0));
    const totalInvoiced = invoices.reduce((a, i) => a.plus(D(i.total)), D(0));
    // Paid = somme encaissements MOINS somme notes de crédit (les notes de crédit
    // réduisent la dette, mais ici on veut le montant effectivement encaissé).
    const totalPaid = payments.reduce((a, p) => a.plus(D(p.amount)), D(0));
    const totalCreditNotes = creditNotes.reduce((a, n) => a.plus(D(n.amount)), D(0));

    const balance = D(c.balance);
    const creditLimit = D(c.creditLimit);
    const available = creditLimit.minus(balance);
    const exceeded = balance.greaterThan(creditLimit);

    // Timeline chronologique (solde client après chaque opération).
    type Ev = {
      date: string;
      kind: string;
      label: string;
      amount: string;
      balanceAfter: string;
    };
    const events: Ev[] = [];

    interface TEv { ts: number; date: Date; kind: string; label: string; amount: string; delta: (b: any) => any; }
    const timeline: TEv[] = [
      ...sales.map((s) => ({ ts: new Date(s.date).getTime(), date: s.date, kind: 'SALE', label: `Vente ${s.reference}`, amount: D(s.total).toString(), delta: (b: any) => b.plus(D(s.total)) })),
      ...invoices.map((i) => ({ ts: new Date(i.issueDate).getTime(), date: i.issueDate, kind: 'INVOICE', label: `Facture ${i.reference}`, amount: D(i.total).toString(), delta: (b: any) => b })), // la facture ne change pas le solde (déjà compté en vente)
      ...payments.map((p) => ({ ts: new Date(p.paymentDate).getTime(), date: p.paymentDate, kind: 'PAYMENT', label: `Encaissement ${p.reference}`, amount: D(p.amount).toString(), delta: (b: any) => b.minus(D(p.amount)) })),
      ...creditNotes.map((n) => ({ ts: new Date(n.date).getTime(), date: n.date, kind: 'CREDIT_NOTE', label: `Avoir ${n.reference}`, amount: D(n.amount).toString(), delta: (b: any) => b.minus(D(n.amount)) })),
    ].sort((x, y) => x.ts - y.ts);

    let bal = D(0);
    for (const ev of timeline) {
      bal = ev.delta(bal);
      events.push({ date: ev.date.toISOString(), kind: ev.kind, label: ev.label, amount: ev.amount, balanceAfter: bal.toString() });
    }

    res.json({
      customer: serialize(c),
      balance: dec(c.balance),
      creditLimit: dec(c.creditLimit),
      available: dec(available),
      exceeded: exceeded,
      totals: {
        sales: dec(totalSales),
        invoiced: dec(totalInvoiced),
        paid: dec(totalPaid),
        creditNotes: dec(totalCreditNotes),
      },
      sales: sales.map((s) => ({ ...s, subtotal: dec(s.subtotal), total: dec(s.total) })),
      invoices: invoices.map((i) => ({ ...i, subtotal: dec(i.subtotal), taxAmount: dec(i.taxAmount), total: dec(i.total) })),
      payments: payments.map((p) => ({ ...p, amount: dec(p.amount) })),
      creditNotes: creditNotes.map((n) => ({ ...n, amount: dec(n.amount) })),
      timeline: events,
    });
  } catch (e: any) {
    console.error('[customers] statement err', e);
    res.status(500).json({ error: 'Erreur relevé client' });
  }
});

/**
 * GET /api/customers/:id/credit-check?amount=X
 * @summary Vérifie si un client peut encaisser `amount` sans dépasser sa limite de crédit.
 *          Renvoie {ok, limit, current, after, available, exceeded}.
 * @tag Customers
 */
router.get('/:id/credit-check', requirePermission('CUSTOMER_READ'), async (req, res) => {
  try {
    const amount = typeof req.query.amount === 'string' ? req.query.amount : '0';
    const result = await checkCreditLimit(prisma, req.params.id, amount);
    res.json(result);
  } catch (e: any) {
    if (e.code === 'NOT_FOUND') return res.status(404).json({ error: 'Client introuvable' });
    console.error('[customers] credit-check err', e);
    res.status(500).json({ error: 'Erreur vérification crédit' });
  }
});

export default router;
