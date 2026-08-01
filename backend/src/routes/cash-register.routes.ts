// =====================================================================
// MODULE CAISSE (Temps 1) — journée de caisse, dépenses, approvisionnements,
// remises, clôture.
//
// PRINCIPE CLÉ : les factures et les paiements sont lus en LECTURE SEULE et
// agrégés À LA VOLÉE (jamais dupliqués en CashRegisterEntry). Seules les
// saisies manuelles (dépense, appro, remise, fonds de clôture) créent une
// CashRegisterEntry. Anti-doublon strict via @@unique([sourceType, sourceId]).
//
// Règle métier facture validée : une facture compte dans le total du jour si
// son statut ∈ {SENT, PAID, PARTIALLY_PAID, OVERDUE} (DRAFT et CANCELLED exclus).
// =====================================================================
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { requireAuth } from '../auth/middleware';
import { dec } from './_helpers';
import { buildBordereauCaissePdf } from '../caisse/pdf';

const router = Router();
router.use(requireAuth);

const D = (v: Prisma.Decimal.Value | number | string) => new Prisma.Decimal(v);
const ZERO = new Prisma.Decimal(0);

/** Statuts de facture comptabilisés dans le total du jour. */
const STATUTS_FACTURE_COMPTABILISES = ['SENT', 'PAID', 'PARTIALLY_PAID', 'OVERDUE'] as const;

/** Normalise une date (string YYYY-MM-DD ou Date) au début de journée UTC. */
function jour(d: string | Date): Date {
  const base = typeof d === 'string' ? new Date(`${d.slice(0, 10)}T00:00:00.000Z`) : d;
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
}

/** Bornes [début, fin[ d'une journée. */
function bornesJour(d: string | Date): { debut: Date; fin: Date } {
  const debut = jour(d);
  const fin = new Date(debut.getTime() + 24 * 60 * 60 * 1000);
  return { debut, fin };
}

/** Format YYYY-MM-DD. */
function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Heure courante HH:MM (pour l'horodatage automatique des saisies). */
function heureCourante(): string {
  const n = new Date();
  return `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
}

/** Récupère (ou crée) la journée de caisse pour une date donnée. */
async function getOrCreateDay(tx: Prisma.TransactionClient, date: string | Date) {
  const d = jour(date);
  const existant = await tx.cashRegisterDay.findUnique({ where: { date: d } });
  if (existant) return existant;
  // Le fonds d'ouverture reprend le fonds de clôture de la veille si connu, sinon 0.
  const veille = new Date(d.getTime() - 24 * 60 * 60 * 1000);
  const jourVeille = await tx.cashRegisterDay.findUnique({ where: { date: veille } });
  return tx.cashRegisterDay.create({
    data: { date: d, openingCashFund: jourVeille ? D(jourVeille.closingCashFund) : ZERO },
  });
}

/** Génère une référence séquentielle unique (ex. DEP-2026-0001). */
async function nextRef(
  tx: Prisma.TransactionClient,
  prefixe: string,
  modele: 'cashSupply' | 'cashRemittance',
): Promise<string> {
  const annee = new Date().getFullYear();
  const prefix = `${prefixe}-${annee}-`;
  const lignes: { reference: string }[] = await (tx as any)[modele].findMany({
    where: { reference: { startsWith: prefix } },
    select: { reference: true },
  });
  let max = 0;
  for (const l of lignes) {
    const m = new RegExp(`^${prefixe}-\\d{4}-(\\d+)$`).exec(l.reference);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}${(max + 1).toString().padStart(4, '0')}`;
}

// ---------------------------------------------------------------------
// CŒUR DU MODULE — calcul automatique des totaux d'une journée.
// ---------------------------------------------------------------------
export interface TotauxJour {
  openingCashFund: Prisma.Decimal;
  invoiceTotal: Prisma.Decimal;
  creditCollectionTotal: Prisma.Decimal;
  cashSupplyTotal: Prisma.Decimal;
  autresEntrees: Prisma.Decimal;
  totalEntries: Prisma.Decimal;
  creditInvoiceTotal: Prisma.Decimal;
  unpaidPartialInvoiceTotal: Prisma.Decimal;
  expenseTotal: Prisma.Decimal;
  cashRemittanceTotal: Prisma.Decimal;
  closingCashFund: Prisma.Decimal;
  autresSorties: Prisma.Decimal;
  totalOutputs: Prisma.Decimal;
  difference: Prisma.Decimal;
  encaissementReelVentes: Prisma.Decimal;
}

/**
 * Calcule tous les totaux d'une journée à partir des MODULES EXISTANTS
 * (Invoice/Payment, lecture seule) + des CashRegisterEntry manuelles.
 */
export async function calculerTotauxJour(
  tx: Prisma.TransactionClient,
  date: string | Date,
  openingCashFund: Prisma.Decimal,
): Promise<TotauxJour> {
  const { debut, fin } = bornesJour(date);

  // --- Factures du jour (statuts comptabilisés) ----------------------
  const factures = await tx.invoice.findMany({
    where: {
      issueDate: { gte: debut, lt: fin },
      status: { in: STATUTS_FACTURE_COMPTABILISES as unknown as any[] },
      deletedAt: null,
    },
    select: { id: true, total: true, status: true },
  });

  // Montant réellement encaissé par facture = Σ Payment.amount (invoiceId).
  const ids = factures.map((f) => f.id);
  const encaisseParFacture = new Map<string, Prisma.Decimal>();
  if (ids.length > 0) {
    const paiements = await tx.payment.groupBy({
      by: ['invoiceId'],
      where: { invoiceId: { in: ids }, deletedAt: null },
      _sum: { amount: true },
    });
    for (const p of paiements) {
      if (p.invoiceId) encaisseParFacture.set(p.invoiceId, D(p._sum.amount ?? 0));
    }
  }

  let invoiceTotal = ZERO;
  let creditInvoiceTotal = ZERO;
  let unpaidPartialInvoiceTotal = ZERO;
  for (const f of factures) {
    const total = D(f.total);
    const encaisse = encaisseParFacture.get(f.id) ?? ZERO;
    invoiceTotal = invoiceTotal.plus(total);
    // "Ventes à crédit" = MONTANT TOTAL de toute facture NON payée du jour
    // (SENT, PARTIALLY_PAID, OVERDUE). Une facture PARTIALLY_PAID compte pour son
    // total complet (le client veut le total, pas le reste dû). Les factures PAYÉE
    // le jour même ne vont PAS en crédit (elles sont dans les ventes normales).
    if (f.status !== 'PAID') {
      creditInvoiceTotal = creditInvoiceTotal.plus(total);
    }
    // Info "reste dû" pour les factures PARTIALLY_PAID (affichage séparé, à NE PAS
    // inclure dans totalOutputs pour éviter tout double comptage avec creditInvoiceTotal).
    if (f.status === 'PARTIALLY_PAID' && encaisse.greaterThan(0) && encaisse.lessThan(total)) {
      unpaidPartialInvoiceTotal = unpaidPartialInvoiceTotal.plus(total.minus(encaisse));
    }
  }

  // --- Encaissements de crédits clients du jour ----------------------
  const encaissements = await tx.payment.aggregate({
    where: {
      paymentDate: { gte: debut, lt: fin },
      invoiceId: { not: null },
      customerId: { not: null },
      deletedAt: null,
    },
    _sum: { amount: true },
  });
  const creditCollectionTotal = D(encaissements._sum.amount ?? 0);

  // --- Lignes de caisse manuelles ------------------------------------
  const jourExistant = await tx.cashRegisterDay.findUnique({ where: { date: jour(date) } });
  const lignes = jourExistant
    ? await tx.cashRegisterEntry.findMany({
        where: { cashRegisterDayId: jourExistant.id, deletedAt: null },
      })
    : [];

  let cashSupplyTotal = ZERO;
  let expenseTotal = ZERO;
  let cashRemittanceTotal = ZERO;
  let closingCashFund = ZERO;
  let autresEntrees = ZERO;
  let autresSorties = ZERO;
  for (const l of lignes) {
    const m = D(l.amount);
    switch (l.sourceType) {
      case 'CASH_SUPPLY':
        cashSupplyTotal = cashSupplyTotal.plus(m);
        break;
      case 'EXPENSE':
        expenseTotal = expenseTotal.plus(m);
        break;
      case 'REMITTANCE':
        cashRemittanceTotal = cashRemittanceTotal.plus(m);
        break;
      case 'CLOSING_FUND':
        closingCashFund = closingCashFund.plus(m);
        break;
      default:
        // OTHER_ENTRY / OTHER_OUTPUT (dont les annulations de dépense).
        if (l.direction === 'ENTRY') autresEntrees = autresEntrees.plus(m);
        else autresSorties = autresSorties.plus(m);
    }
  }

  const totalEntries = openingCashFund
    .plus(invoiceTotal)
    .plus(creditCollectionTotal)
    .plus(cashSupplyTotal)
    .plus(autresEntrees);
  // NB : unpaidPartialInvoiceTotal (reste dû des factures PARTIALLY_PAID) est
  // volontairement EXCLU de totalOutputs pour éviter tout double comptage : le
  // crédit est déjà comptabilisé en entrées via creditInvoiceTotal (montant total).
  const totalOutputs = creditInvoiceTotal
    .plus(expenseTotal)
    .plus(cashRemittanceTotal)
    .plus(closingCashFund)
    .plus(autresSorties);

  return {
    openingCashFund,
    invoiceTotal,
    creditCollectionTotal,
    cashSupplyTotal,
    autresEntrees,
    totalEntries,
    creditInvoiceTotal,
    unpaidPartialInvoiceTotal,
    expenseTotal,
    cashRemittanceTotal,
    closingCashFund,
    autresSorties,
    totalOutputs,
    difference: totalEntries.minus(totalOutputs),
    encaissementReelVentes: invoiceTotal.minus(creditInvoiceTotal),
  };
}

/** Recalcule ET persiste les totaux miroirs sur la journée de caisse. */
export async function recalculerEtPersister(
  tx: Prisma.TransactionClient,
  date: string | Date,
): Promise<{ day: any; totaux: TotauxJour }> {
  const day = await getOrCreateDay(tx, date);
  const t = await calculerTotauxJour(tx, date, D(day.openingCashFund));
  const maj = await tx.cashRegisterDay.update({
    where: { id: day.id },
    data: {
      invoiceTotal: t.invoiceTotal,
      creditCollectionTotal: t.creditCollectionTotal,
      cashSupplyTotal: t.cashSupplyTotal,
      totalEntries: t.totalEntries,
      creditInvoiceTotal: t.creditInvoiceTotal,
      unpaidPartialInvoiceTotal: t.unpaidPartialInvoiceTotal,
      expenseTotal: t.expenseTotal,
      cashRemittanceTotal: t.cashRemittanceTotal,
      totalOutputs: t.totalOutputs,
      difference: t.difference,
    },
  });
  return { day: maj, totaux: t };
}

/** Sérialise une journée de caisse (Decimals -> string). */
function serializeDay(d: any) {
  return {
    ...d,
    date: d.date instanceof Date ? iso(d.date) : d.date,
    openingCashFund: dec(d.openingCashFund),
    invoiceTotal: dec(d.invoiceTotal),
    creditCollectionTotal: dec(d.creditCollectionTotal),
    cashSupplyTotal: dec(d.cashSupplyTotal),
    totalEntries: dec(d.totalEntries),
    creditInvoiceTotal: dec(d.creditInvoiceTotal),
    unpaidPartialInvoiceTotal: dec(d.unpaidPartialInvoiceTotal),
    expenseTotal: dec(d.expenseTotal),
    cashRemittanceTotal: dec(d.cashRemittanceTotal),
    closingCashFund: dec(d.closingCashFund),
    totalOutputs: dec(d.totalOutputs),
    difference: dec(d.difference),
  };
}

/** Sérialise une ligne de caisse. */
function serializeEntry(e: any) {
  return { ...e, amount: dec(e.amount) };
}

/** Sérialise les totaux calculés. */
function serializeTotaux(t: TotauxJour) {
  return {
    openingCashFund: t.openingCashFund.toString(),
    invoiceTotal: t.invoiceTotal.toString(),
    creditCollectionTotal: t.creditCollectionTotal.toString(),
    cashSupplyTotal: t.cashSupplyTotal.toString(),
    autresEntrees: t.autresEntrees.toString(),
    totalEntries: t.totalEntries.toString(),
    creditInvoiceTotal: t.creditInvoiceTotal.toString(),
    unpaidPartialInvoiceTotal: t.unpaidPartialInvoiceTotal.toString(),
    expenseTotal: t.expenseTotal.toString(),
    cashRemittanceTotal: t.cashRemittanceTotal.toString(),
    closingCashFund: t.closingCashFund.toString(),
    autresSorties: t.autresSorties.toString(),
    totalOutputs: t.totalOutputs.toString(),
    difference: t.difference.toString(),
    encaissementReelVentes: t.encaissementReelVentes.toString(),
  };
}

/** Vérifie l'absence de doublon (sourceType, sourceId) avant insertion. */
async function assertPasDeDoublon(
  tx: Prisma.TransactionClient,
  sourceType: string,
  sourceId: string,
): Promise<void> {
  const existant = await tx.cashRegisterEntry.findUnique({
    where: { sourceType_sourceId: { sourceType, sourceId } },
  });
  if (existant) {
    const e: any = new Error('Ligne de caisse déjà existante pour cette source');
    e.status = 409;
    throw e;
  }
}

// =====================================================================
// GET /api/cash-register/days — liste des journées (date desc).
// =====================================================================
router.get('/days', async (_req: Request, res: Response) => {
  try {
    const jours = await prisma.cashRegisterDay.findMany({
      where: { deletedAt: null },
      orderBy: { date: 'desc' },
    });
    res.json({ items: jours.map(serializeDay), total: jours.length });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Erreur chargement journées de caisse' });
  }
});

// =====================================================================
// GET /api/cash-register/days/:date — détail d'une journée (YYYY-MM-DD).
// Recalcule les totaux à la volée (source de vérité = modules métier).
// =====================================================================
router.get('/days/:date', async (req: Request, res: Response) => {
  const dateParam = String(req.params.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return res.status(400).json({ error: 'Date invalide (format attendu YYYY-MM-DD)' });
  }
  try {
    const d = jour(dateParam);
    const day = await prisma.cashRegisterDay.findUnique({ where: { date: d } });
    const opening = day ? D(day.openingCashFund) : ZERO;
    const totaux = await calculerTotauxJour(prisma as any, dateParam, opening);

    const lignes = day
      ? await prisma.cashRegisterEntry.findMany({
          where: { cashRegisterDayId: day.id, deletedAt: null },
          orderBy: { createdAt: 'asc' },
        })
      : [];

    // Lignes « virtuelles » calculées à la volée (jamais stockées) —
    // elles matérialisent les factures/encaissements et les déductions
    // de rapprochement dans l'affichage.
    const virtuelles: any[] = [];
    if (!totaux.invoiceTotal.isZero()) {
      virtuelles.push({
        id: 'virt-invoice-total',
        direction: 'ENTRY',
        category: 'Total factures du jour',
        amount: totaux.invoiceTotal.toString(),
        sourceType: 'INVOICE_TOTAL',
        virtuel: true,
        deduction: false,
      });
    }
    if (!totaux.creditCollectionTotal.isZero()) {
      virtuelles.push({
        id: 'virt-credit-collection',
        direction: 'ENTRY',
        category: 'Encaissements de crédits clients',
        amount: totaux.creditCollectionTotal.toString(),
        sourceType: 'CREDIT_COLLECTION',
        virtuel: true,
        deduction: false,
      });
    }
    if (!totaux.creditInvoiceTotal.isZero()) {
      virtuelles.push({
        id: 'virt-credit-invoice',
        direction: 'OUTPUT',
        category: 'Factures à crédit (non encaissées)',
        amount: totaux.creditInvoiceTotal.toString(),
        sourceType: 'CREDIT_INVOICE',
        virtuel: true,
        deduction: true, // déduction de rapprochement, pas une sortie réelle
      });
    }
    if (!totaux.unpaidPartialInvoiceTotal.isZero()) {
      virtuelles.push({
        id: 'virt-unpaid-partial',
        direction: 'OUTPUT',
        category: 'Reliquat factures partiellement payées',
        amount: totaux.unpaidPartialInvoiceTotal.toString(),
        sourceType: 'UNPAID_PARTIAL',
        virtuel: true,
        deduction: true,
      });
    }
    if (!opening.isZero()) {
      virtuelles.unshift({
        id: 'virt-opening-fund',
        direction: 'ENTRY',
        category: 'Ancien fonds de caisse',
        amount: opening.toString(),
        sourceType: 'OPENING_FUND',
        virtuel: true,
        deduction: false,
      });
    }

    const reelles = lignes.map((l) => ({ ...serializeEntry(l), virtuel: false, deduction: false }));
    const toutes = [...virtuelles, ...reelles];

    res.json({
      date: dateParam,
      day: day ? serializeDay(day) : null,
      status: day?.status ?? 'ouverte',
      closedBy: day?.closedBy ?? null,
      closedAt: day?.closedAt ?? null,
      entries: toutes.filter((l) => l.direction === 'ENTRY'),
      outputs: toutes.filter((l) => l.direction === 'OUTPUT'),
      totaux: serializeTotaux(totaux),
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Erreur chargement journée de caisse' });
  }
});

// =====================================================================
// DRILL-DOWN — listes de documents d'une journée (navigation depuis les
// synthèses de la page /caisse/:date). Toutes les bornes de jour utilisent
// bornesJour() (UTC) — la même logique que calculerTotauxJour().
// =====================================================================

/** Valide le paramètre :date et renvoie les bornes, ou null si invalide. */
function bornesOu400(req: Request, res: Response): { debut: Date; fin: Date; dateParam: string } | null {
  const dateParam = String(req.params.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    res.status(400).json({ error: 'Date invalide (format attendu YYYY-MM-DD)' });
    return null;
  }
  return { ...bornesJour(dateParam), dateParam };
}

/** Sérialise une facture pour les listes de drill-down. */
function serializeInvoiceLite(f: any) {
  return {
    id: f.id,
    reference: f.reference,
    customerName: f.customer?.name ?? null,
    total: dec(f.total),
    status: f.status,
    issueDate: f.issueDate instanceof Date ? f.issueDate.toISOString() : f.issueDate,
  };
}

// --- GET /days/:date/invoices — toutes les factures comptabilisées du jour.
router.get('/days/:date/invoices', async (req: Request, res: Response) => {
  const b = bornesOu400(req, res);
  if (!b) return;
  try {
    const factures = await prisma.invoice.findMany({
      where: {
        issueDate: { gte: b.debut, lt: b.fin },
        status: { in: STATUTS_FACTURE_COMPTABILISES as unknown as any[] },
        deletedAt: null,
      },
      include: { customer: { select: { name: true } } },
      orderBy: { issueDate: 'asc' },
    });
    const items = factures.map(serializeInvoiceLite);
    res.json({ date: b.dateParam, items, total: items.length });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Erreur chargement factures du jour' });
  }
});

// --- GET /days/:date/credit-collections — encaissements de crédits clients.
router.get('/days/:date/credit-collections', async (req: Request, res: Response) => {
  const b = bornesOu400(req, res);
  if (!b) return;
  try {
    const paiements = await prisma.payment.findMany({
      where: {
        paymentDate: { gte: b.debut, lt: b.fin },
        invoiceId: { not: null },
        customerId: { not: null },
        deletedAt: null,
      },
      include: {
        invoice: { select: { id: true, reference: true, total: true, status: true } },
        customer: { select: { name: true } },
      },
      orderBy: { paymentDate: 'asc' },
    });
    const items = paiements.map((p: any) => ({
      id: p.id,
      reference: p.reference,
      invoiceId: p.invoiceId,
      invoiceReference: p.invoice?.reference ?? null,
      invoiceTotal: p.invoice ? dec(p.invoice.total) : null,
      customerName: p.customer?.name ?? null,
      amount: dec(p.amount),
      method: p.method,
      paymentDate: p.paymentDate instanceof Date ? p.paymentDate.toISOString() : p.paymentDate,
    }));
    res.json({ date: b.dateParam, items, total: items.length });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Erreur chargement encaissements du jour' });
  }
});

// --- GET /days/:date/expenses — dépenses du jour.
router.get('/days/:date/expenses', async (req: Request, res: Response) => {
  const b = bornesOu400(req, res);
  if (!b) return;
  try {
    const deps = await prisma.expense.findMany({
      where: { date: { gte: b.debut, lt: b.fin }, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    const items = deps.map((d: any) => ({
      id: d.id,
      motif: d.motif,
      category: d.category ?? null,
      amount: dec(d.amount),
      paymentMethod: d.paymentMethod,
      heure: d.heure ?? null,
      userId: d.userId ?? null,
      status: d.status,
      date: d.date instanceof Date ? iso(d.date) : d.date,
    }));
    res.json({ date: b.dateParam, items, total: items.length });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Erreur chargement dépenses du jour' });
  }
});

// --- GET /days/:date/credit-sales — factures à crédit créées le jour.
// Même règle que calculerTotauxJour : OVERDUE, ou aucun encaissement.
router.get('/days/:date/credit-sales', async (req: Request, res: Response) => {
  const b = bornesOu400(req, res);
  if (!b) return;
  try {
    const factures = await prisma.invoice.findMany({
      where: {
        issueDate: { gte: b.debut, lt: b.fin },
        status: { in: STATUTS_FACTURE_COMPTABILISES as unknown as any[] },
        deletedAt: null,
      },
      include: { customer: { select: { name: true } } },
      orderBy: { issueDate: 'asc' },
    });
    const ids = factures.map((f) => f.id);
    const encaisse = new Map<string, Prisma.Decimal>();
    if (ids.length > 0) {
      const grp = await prisma.payment.groupBy({
        by: ['invoiceId'],
        where: { invoiceId: { in: ids }, deletedAt: null },
        _sum: { amount: true },
      });
      for (const p of grp) if (p.invoiceId) encaisse.set(p.invoiceId, D(p._sum.amount ?? 0));
    }
    // Doit correspondre EXACTEMENT à l'agrégat creditInvoiceTotal (calculé plus
    // haut) : toute facture du jour non entièrement payée (SENT, PARTIALLY_PAID,
    // OVERDUE). Sinon l'agrégat montre un montant mais la liste reste vide.
    // NB : DRAFT n'est pas comptabilisé (ni en agrégat, ni ici).
    const items = factures
      .filter((f) => f.status !== 'PAID')
      .map(serializeInvoiceLite);
    res.json({ date: b.dateParam, items, total: items.length });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Erreur chargement crédits créés du jour' });
  }
});

// --- GET /days/:date/remittances — remises d'espèces du jour.
router.get('/days/:date/remittances', async (req: Request, res: Response) => {
  const b = bornesOu400(req, res);
  if (!b) return;
  try {
    const remises = await prisma.cashRemittance.findMany({
      where: { date: { gte: b.debut, lt: b.fin }, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    const items = remises.map((r: any) => ({
      id: r.id,
      reference: r.reference,
      amount: dec(r.amount),
      beneficiary: r.beneficiary ?? null,
      motif: r.motif,
      heure: r.heure ?? null,
      date: r.date instanceof Date ? iso(r.date) : r.date,
    }));
    res.json({ date: b.dateParam, items, total: items.length });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Erreur chargement remises du jour' });
  }
});

// =====================================================================
// GET /api/cash-register/days/:date/pdf — bordereau de caisse A5 portrait.
// Réutilise EXACTEMENT la même logique de calcul que le GET détail.
// =====================================================================
router.get('/days/:date/pdf', async (req: Request, res: Response) => {
  const dateParam = String(req.params.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return res.status(400).json({ error: 'Date invalide (format attendu YYYY-MM-DD)' });
  }
  try {
    const d = jour(dateParam);
    const day = await prisma.cashRegisterDay.findUnique({ where: { date: d } });
    const opening = day ? D(day.openingCashFund) : ZERO;
    const t = await calculerTotauxJour(prisma as any, dateParam, opening);

    const doc = buildBordereauCaissePdf({
      date: dateParam,
      statut: day?.status ?? 'ouverte',
      encaissementReelVentes: t.encaissementReelVentes.toString(),
      creditCollectionTotal: t.creditCollectionTotal.toString(),
      openingCashFund: t.openingCashFund.toString(),
      cashSupplyTotal: t.cashSupplyTotal.toString(),
      consignation: 0, // non géré par le module
      totalEntries: t.totalEntries.toString(),
      expenseTotal: t.expenseTotal.toString(),
      creditInvoiceTotal: t.creditInvoiceTotal.toString(),
      closingCashFund: t.closingCashFund.toString(),
      cashRemittanceTotal: t.cashRemittanceTotal.toString(),
      deconsignation: 0, // non géré par le module
      totalOutputs: t.totalOutputs.toString(),
      difference: t.difference.toString(),
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="bordereau-caisse-${dateParam}.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch (e: any) {
    console.error('[cash-register] pdf error', e);
    if (!res.headersSent) res.status(500).json({ error: 'Erreur génération PDF', message: e?.message });
  }
});

// =====================================================================
// POST /api/cash-register/expenses — créer une dépense (+ sortie de caisse).
// =====================================================================
const expenseSchema = z.object({
  date: z.string().optional(),
  heure: z.string().optional(),
  motif: z.string().min(1, 'motif requis'),
  category: z.string().optional().nullable(),
  amount: z.union([z.string(), z.number()]),
  paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD']).optional(),
  observation: z.string().optional().nullable(),
  justificatif: z.string().optional().nullable(),
  userId: z.string().optional().nullable(),
});

/** Valide un montant strictement positif sans jamais laisser Decimal throw. */
function montantValide(v: unknown): Prisma.Decimal | null {
  try {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return null;
    const d = D(v as any);
    return d.greaterThan(0) ? d : null;
  } catch {
    return null;
  }
}

router.post('/expenses', async (req: Request, res: Response) => {
  const parsed = expenseSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
  }
  const montant = montantValide(parsed.data.amount);
  if (!montant) return res.status(400).json({ error: 'Montant invalide (doit être > 0)' });
  const dateDep = parsed.data.date ? jour(parsed.data.date) : jour(new Date());

  try {
    const out = await prisma.$transaction(async (tx) => {
      const day = await getOrCreateDay(tx, dateDep);
      if (day.status === 'cloturee') {
        const e: any = new Error('Journée déjà clôturée : saisie impossible');
        e.status = 409;
        throw e;
      }
      const expense = await tx.expense.create({
        data: {
          date: dateDep,
          heure: parsed.data.heure ?? heureCourante(),
          motif: parsed.data.motif,
          category: parsed.data.category ?? null,
          amount: montant,
          paymentMethod: (parsed.data.paymentMethod ?? 'CASH') as any,
          observation: parsed.data.observation ?? null,
          justificatif: parsed.data.justificatif ?? null,
          userId: parsed.data.userId ?? (req as any).user?.id ?? null,
        },
      });
      await assertPasDeDoublon(tx, 'EXPENSE', expense.id);
      const entry = await tx.cashRegisterEntry.create({
        data: {
          cashRegisterDayId: day.id,
          direction: 'OUTPUT',
          category: parsed.data.category ?? 'Dépense',
          amount: montant,
          sourceType: 'EXPENSE',
          sourceId: expense.id,
          description: parsed.data.motif,
          createdBy: (req as any).user?.id ?? null,
        },
      });
      await recalculerEtPersister(tx, dateDep);
      await tx.cashRegisterAuditLog.create({
        data: {
          cashRegisterDayId: day.id,
          action: 'creation',
          userId: (req as any).user?.id ?? null,
          details: { type: 'depense', expenseId: expense.id, montant: montant.toString() },
        },
      });
      return { expense, entry };
    });
    res.status(201).json({
      expense: { ...out.expense, amount: dec(out.expense.amount) },
      entry: serializeEntry(out.entry),
    });
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e?.message ?? 'Erreur création dépense' });
  }
});

// =====================================================================
// GET /api/cash-register/expenses — liste des dépenses (filtre date).
// =====================================================================
router.get('/expenses', async (req: Request, res: Response) => {
  try {
    const where: any = { deletedAt: null };
    if (typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) {
      const { debut, fin } = bornesJour(req.query.date);
      where.date = { gte: debut, lt: fin };
    }
    const items = await prisma.expense.findMany({ where, orderBy: { date: 'desc' } });
    res.json({
      items: items.map((x) => ({ ...x, amount: dec(x.amount) })),
      total: items.length,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Erreur chargement dépenses' });
  }
});

// =====================================================================
// PATCH /api/cash-register/expenses/:id/cancel — annulation.
// Ne supprime PAS : passe status='annulee' et crée une ENTRÉE inverse.
// =====================================================================
router.patch('/expenses/:id/cancel', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  try {
    const out = await prisma.$transaction(async (tx) => {
      const expense = await tx.expense.findUnique({ where: { id } });
      if (!expense || expense.deletedAt) {
        const e: any = new Error('Dépense introuvable');
        e.status = 404;
        throw e;
      }
      if (expense.status === 'annulee') {
        const e: any = new Error('Dépense déjà annulée');
        e.status = 409;
        throw e;
      }
      const day = await getOrCreateDay(tx, expense.date);
      await assertPasDeDoublon(tx, 'OTHER_ENTRY', `cancel-expense-${expense.id}`);
      const inverse = await tx.cashRegisterEntry.create({
        data: {
          cashRegisterDayId: day.id,
          direction: 'ENTRY',
          category: 'Annulation de dépense',
          amount: D(expense.amount),
          sourceType: 'OTHER_ENTRY',
          sourceId: `cancel-expense-${expense.id}`,
          description: `Annulation : ${expense.motif}`,
          createdBy: (req as any).user?.id ?? null,
        },
      });
      const maj = await tx.expense.update({ where: { id }, data: { status: 'annulee' } });
      await recalculerEtPersister(tx, expense.date);
      await tx.cashRegisterAuditLog.create({
        data: {
          cashRegisterDayId: day.id,
          action: 'annulation',
          userId: (req as any).user?.id ?? null,
          details: { expenseId: id, montant: D(expense.amount).toString() },
        },
      });
      return { expense: maj, entry: inverse };
    });
    res.json({
      expense: { ...out.expense, amount: dec(out.expense.amount) },
      entry: serializeEntry(out.entry),
    });
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e?.message ?? 'Erreur annulation dépense' });
  }
});

// =====================================================================
// POST /api/cash-register/supplies — approvisionnement de caisse (ENTRÉE).
// =====================================================================
const supplySchema = z.object({
  date: z.string().optional(),
  heure: z.string().optional(),
  amount: z.union([z.string(), z.number()]),
  motif: z.string().min(1, 'motif requis'),
  mode: z.string().optional(),
  userId: z.string().optional().nullable(),
  observation: z.string().optional().nullable(),
  justificatif: z.string().optional().nullable(),
});

router.post('/supplies', async (req: Request, res: Response) => {
  const parsed = supplySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
  }
  const montant = montantValide(parsed.data.amount);
  if (!montant) return res.status(400).json({ error: 'Montant invalide (doit être > 0)' });
  const dateAppro = parsed.data.date ? jour(parsed.data.date) : jour(new Date());

  try {
    const out = await prisma.$transaction(async (tx) => {
      const day = await getOrCreateDay(tx, dateAppro);
      if (day.status === 'cloturee') {
        const e: any = new Error('Journée déjà clôturée : saisie impossible');
        e.status = 409;
        throw e;
      }
      const supply = await tx.cashSupply.create({
        data: {
          reference: await nextRef(tx, 'APP', 'cashSupply'),
          date: dateAppro,
          heure: parsed.data.heure ?? heureCourante(),
          amount: montant,
          motif: parsed.data.motif,
          mode: parsed.data.mode ?? 'CASH',
          userId: parsed.data.userId ?? (req as any).user?.id ?? null,
          observation: parsed.data.observation ?? null,
          justificatif: parsed.data.justificatif ?? null,
        },
      });
      await assertPasDeDoublon(tx, 'CASH_SUPPLY', supply.id);
      const entry = await tx.cashRegisterEntry.create({
        data: {
          cashRegisterDayId: day.id,
          direction: 'ENTRY',
          category: 'Approvisionnement caisse',
          amount: montant,
          sourceType: 'CASH_SUPPLY',
          sourceId: supply.id,
          reference: supply.reference,
          description: parsed.data.motif,
          createdBy: (req as any).user?.id ?? null,
        },
      });
      await recalculerEtPersister(tx, dateAppro);
      return { supply, entry };
    });
    res.status(201).json({
      supply: { ...out.supply, amount: dec(out.supply.amount) },
      entry: serializeEntry(out.entry),
    });
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e?.message ?? 'Erreur création approvisionnement' });
  }
});

/** GET /api/cash-register/supplies — liste (filtre date). */
router.get('/supplies', async (req: Request, res: Response) => {
  try {
    const where: any = { deletedAt: null };
    if (typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) {
      const { debut, fin } = bornesJour(req.query.date);
      where.date = { gte: debut, lt: fin };
    }
    const items = await prisma.cashSupply.findMany({ where, orderBy: { date: 'desc' } });
    res.json({ items: items.map((x) => ({ ...x, amount: dec(x.amount) })), total: items.length });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Erreur chargement approvisionnements' });
  }
});

// =====================================================================
// POST /api/cash-register/remittances — remise d'espèces (SORTIE).
// =====================================================================
const remittanceSchema = z.object({
  date: z.string().optional(),
  heure: z.string().optional(),
  amount: z.union([z.string(), z.number()]),
  beneficiary: z.string().optional().nullable(),
  motif: z.string().min(1, 'motif requis'),
  userId: z.string().optional().nullable(),
  observation: z.string().optional().nullable(),
  justificatif: z.string().optional().nullable(),
});

router.post('/remittances', async (req: Request, res: Response) => {
  const parsed = remittanceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
  }
  const montant = montantValide(parsed.data.amount);
  if (!montant) return res.status(400).json({ error: 'Montant invalide (doit être > 0)' });
  const dateRemise = parsed.data.date ? jour(parsed.data.date) : jour(new Date());

  try {
    const out = await prisma.$transaction(async (tx) => {
      const day = await getOrCreateDay(tx, dateRemise);
      if (day.status === 'cloturee') {
        const e: any = new Error('Journée déjà clôturée : saisie impossible');
        e.status = 409;
        throw e;
      }
      const remittance = await tx.cashRemittance.create({
        data: {
          reference: await nextRef(tx, 'REM', 'cashRemittance'),
          date: dateRemise,
          heure: parsed.data.heure ?? heureCourante(),
          amount: montant,
          beneficiary: parsed.data.beneficiary ?? null,
          motif: parsed.data.motif,
          userId: parsed.data.userId ?? (req as any).user?.id ?? null,
          observation: parsed.data.observation ?? null,
          justificatif: parsed.data.justificatif ?? null,
        },
      });
      await assertPasDeDoublon(tx, 'REMITTANCE', remittance.id);
      const entry = await tx.cashRegisterEntry.create({
        data: {
          cashRegisterDayId: day.id,
          direction: 'OUTPUT',
          category: 'Remise d\u2019espèces',
          amount: montant,
          sourceType: 'REMITTANCE',
          sourceId: remittance.id,
          reference: remittance.reference,
          description: parsed.data.motif,
          createdBy: (req as any).user?.id ?? null,
        },
      });
      await recalculerEtPersister(tx, dateRemise);
      return { remittance, entry };
    });
    res.status(201).json({
      remittance: { ...out.remittance, amount: dec(out.remittance.amount) },
      entry: serializeEntry(out.entry),
    });
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e?.message ?? 'Erreur création remise' });
  }
});

/** GET /api/cash-register/remittances — liste (filtre date). */
router.get('/remittances', async (req: Request, res: Response) => {
  try {
    const where: any = { deletedAt: null };
    if (typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) {
      const { debut, fin } = bornesJour(req.query.date);
      where.date = { gte: debut, lt: fin };
    }
    const items = await prisma.cashRemittance.findMany({ where, orderBy: { date: 'desc' } });
    res.json({ items: items.map((x) => ({ ...x, amount: dec(x.amount) })), total: items.length });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Erreur chargement remises' });
  }
});

// =====================================================================
// PATCH /api/cash-register/days/:date/close — clôture de la journée.
// Crée la sortie CLOSING_FUND, l'instantané CashRegisterClosing et la
// journée du lendemain (fonds d'ouverture = fonds de clôture).
// =====================================================================
const closeSchema = z.object({
  closingCashFund: z.union([z.string(), z.number()]),
  userId: z.string().optional().nullable(),
});

router.patch('/days/:date/close', async (req: Request, res: Response) => {
  const dateParam = String(req.params.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return res.status(400).json({ error: 'Date invalide (format attendu YYYY-MM-DD)' });
  }
  const parsed = closeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
  }
  let nouveauFonds: Prisma.Decimal;
  try {
    const n = Number(parsed.data.closingCashFund);
    if (!Number.isFinite(n) || n < 0) throw new Error();
    nouveauFonds = D(parsed.data.closingCashFund as any);
  } catch {
    return res.status(400).json({ error: 'Nouveau fonds de caisse invalide (doit être >= 0)' });
  }

  try {
    const out = await prisma.$transaction(async (tx) => {
      const day = await getOrCreateDay(tx, dateParam);
      if (day.status === 'cloturee') {
        const e: any = new Error('Journée déjà clôturée');
        e.status = 409;
        throw e;
      }
      // Sortie « nouveau fonds de caisse » (anti-doublon strict).
      await assertPasDeDoublon(tx, 'CLOSING_FUND', day.id);
      await tx.cashRegisterEntry.create({
        data: {
          cashRegisterDayId: day.id,
          direction: 'OUTPUT',
          category: 'Nouveau fonds de caisse',
          amount: nouveauFonds,
          sourceType: 'CLOSING_FUND',
          sourceId: day.id,
          description: `Fonds de caisse reporté au lendemain (${dateParam})`,
          createdBy: parsed.data.userId ?? (req as any).user?.id ?? null,
        },
      });

      // Recalcul final (inclut désormais la sortie fonds de clôture).
      const t = await calculerTotauxJour(tx, dateParam, D(day.openingCashFund));
      const closedBy = parsed.data.userId ?? (req as any).user?.id ?? null;
      const closedAt = new Date();

      const maj = await tx.cashRegisterDay.update({
        where: { id: day.id },
        data: {
          invoiceTotal: t.invoiceTotal,
          creditCollectionTotal: t.creditCollectionTotal,
          cashSupplyTotal: t.cashSupplyTotal,
          totalEntries: t.totalEntries,
          creditInvoiceTotal: t.creditInvoiceTotal,
          unpaidPartialInvoiceTotal: t.unpaidPartialInvoiceTotal,
          expenseTotal: t.expenseTotal,
          cashRemittanceTotal: t.cashRemittanceTotal,
          closingCashFund: nouveauFonds,
          totalOutputs: t.totalOutputs,
          difference: t.difference,
          status: 'cloturee',
          closedBy,
          closedAt,
        },
      });

      const closing = await tx.cashRegisterClosing.create({
        data: {
          cashRegisterDayId: day.id,
          closedBy,
          closedAt,
          ancienFonds: D(day.openingCashFund),
          facturesTotal: t.invoiceTotal,
          encaissementsTotal: t.creditCollectionTotal,
          approTotal: t.cashSupplyTotal,
          depensesTotal: t.expenseTotal,
          creditsCreesTotal: t.creditInvoiceTotal,
          nonEncaisseTotal: t.unpaidPartialInvoiceTotal,
          remisesTotal: t.cashRemittanceTotal,
          nouveauFonds,
          totalEntrees: t.totalEntries,
          totalSorties: t.totalOutputs,
          difference: t.difference,
        },
      });

      // Journée du lendemain : fonds d'ouverture = fonds de clôture.
      const lendemain = new Date(jour(dateParam).getTime() + 24 * 60 * 60 * 1000);
      const existeDemain = await tx.cashRegisterDay.findUnique({ where: { date: lendemain } });
      if (!existeDemain) {
        await tx.cashRegisterDay.create({
          data: { date: lendemain, openingCashFund: nouveauFonds },
        });
      }

      await tx.cashRegisterAuditLog.create({
        data: {
          cashRegisterDayId: day.id,
          action: 'cloture',
          userId: closedBy,
          details: { date: dateParam, nouveauFonds: nouveauFonds.toString() },
        },
      });

      return { day: maj, closing, totaux: t };
    });

    res.json({
      day: serializeDay(out.day),
      closing: {
        ...out.closing,
        ancienFonds: dec(out.closing.ancienFonds),
        facturesTotal: dec(out.closing.facturesTotal),
        encaissementsTotal: dec(out.closing.encaissementsTotal),
        approTotal: dec(out.closing.approTotal),
        depensesTotal: dec(out.closing.depensesTotal),
        creditsCreesTotal: dec(out.closing.creditsCreesTotal),
        nonEncaisseTotal: dec(out.closing.nonEncaisseTotal),
        remisesTotal: dec(out.closing.remisesTotal),
        nouveauFonds: dec(out.closing.nouveauFonds),
        totalEntrees: dec(out.closing.totalEntrees),
        totalSorties: dec(out.closing.totalSorties),
        difference: dec(out.closing.difference),
      },
      totaux: serializeTotaux(out.totaux),
    });
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e?.message ?? 'Erreur clôture de caisse' });
  }
});

export default router;
