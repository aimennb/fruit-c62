// =====================================================================
// PAIEMENT FOURNISSEUR — « Bon de paiement fournisseur » (BP-xxxx).
//
//   mode 'PAY'       : sortie d'argent réelle -> Payment + décrément du
//                      solde fournisseur (+ sortie de caisse si CASH).
//   mode 'ENCAISSER' : imputation d'une avance déjà versée -> allocation
//                      SupplierAdvanceAllocation, AUCUNE sortie de caisse.
//
// Seuls les bordereaux CLÔTURÉS ('cloture' | 'partiellement_paye') avec
// un montantFinalDu > 0 sont payables. Aucun surpaiement possible.
// =====================================================================
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { requireAuth } from '../auth/middleware';
import { dec } from './_helpers';
import { nextEan13, EAN_PREFIX, ean13Png } from '../barcode';
import { getOrCreateDay, recalculerEtPersister, assertPasDeDoublon } from './cash-register.routes';
import { buildSupplierPaymentPdf } from '../supplier-payments/pdf';

const router = Router();
router.use(requireAuth);

const D = (v: any) => new Prisma.Decimal(v);
const ZERO = new Prisma.Decimal(0);

/** Statuts de bordereau éligibles au paiement. */
const STATUTS_PAYABLES = ['cloture', 'partiellement_paye'];

/** Ramène une date à minuit (jour civil). */
function jour(date: string | Date): Date {
  const d = typeof date === 'string' ? new Date(`${date}T00:00:00`) : new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Génère la prochaine référence BP-<année>-<seq> (même pattern que cash-register). */
async function nextBpRef(tx: Prisma.TransactionClient): Promise<string> {
  const annee = new Date().getFullYear();
  const prefix = `BP-${annee}-`;
  const lignes = await tx.supplierPayment.findMany({
    where: { reference: { startsWith: prefix } },
    select: { reference: true },
  });
  let max = 0;
  for (const l of lignes) {
    const m = /^BP-\d{4}-(\d+)$/.exec(l.reference);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}${(max + 1).toString().padStart(4, '0')}`;
}

/** Génère la prochaine référence de Payment fournisseur (PF-<année>-<seq>). */
async function nextPaymentRef(tx: Prisma.TransactionClient): Promise<string> {
  const annee = new Date().getFullYear();
  const prefix = `PF-${annee}-`;
  const lignes = await tx.payment.findMany({
    where: { reference: { startsWith: prefix } },
    select: { reference: true },
  });
  let max = 0;
  for (const l of lignes) {
    const m = /^PF-\d{4}-(\d+)$/.exec(l.reference);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}${(max + 1).toString().padStart(4, '0')}`;
}

// =====================================================================
// GET /api/supplier-payments — liste des bons (date desc).
// =====================================================================
router.get('/', async (_req: Request, res: Response) => {
  try {
    const items = await prisma.supplierPayment.findMany({
      where: { deletedAt: null },
      orderBy: { date: 'desc' },
      include: { supplier: { select: { id: true, name: true } } },
    });
    res.json({
      items: items.map((p) => ({
        id: p.id,
        reference: p.reference,
        date: p.date,
        supplierId: p.supplierId,
        supplierName: p.supplier?.name ?? '—',
        totalAmount: dec(p.totalAmount),
        mode: p.mode,
        method: p.method,
        ean13: p.ean13,
      })),
      total: items.length,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Erreur chargement bons de paiement' });
  }
});

// =====================================================================
// GET /api/supplier-payments/eligible/:supplierId — bordereaux payables.
// =====================================================================
router.get('/eligible/:supplierId', async (req: Request, res: Response) => {
  try {
    const supplierId = String(req.params.supplierId);
    const rows = await prisma.supplierBordereau.findMany({
      where: {
        supplierId,
        deletedAt: null,
        statut: { in: STATUTS_PAYABLES },
        montantFinalDu: { gt: 0 },
      },
      orderBy: [{ dateCloture: 'asc' }, { createdAt: 'asc' }],
    });
    res.json({
      items: rows.map((b) => ({
        id: b.id,
        reference: b.reference,
        dateCloture: b.dateCloture,
        montantFinalDu: dec(b.montantFinalDu),
        statut: b.statut,
      })),
      total: rows.length,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Erreur chargement bordereaux éligibles' });
  }
});

// =====================================================================
// POST /api/supplier-payments — création d'un bon de paiement.
// =====================================================================
const createSchema = z.object({
  supplierId: z.string().min(1, 'supplierId requis'),
  date: z.string().optional(),
  mode: z.enum(['PAY', 'ENCAISSER']),
  method: z.enum(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD']).optional(),
  notes: z.string().optional().nullable(),
  lines: z
    .array(
      z.object({
        bordereauId: z.string().min(1),
        montant: z.union([z.string(), z.number()]),
      }),
    )
    .min(1, 'au moins une ligne requise'),
});

router.post('/', async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
  }
  const { supplierId, mode } = parsed.data;
  const method = parsed.data.method ?? 'CASH';
  const datePaiement = parsed.data.date ? jour(parsed.data.date) : jour(new Date());
  const userId = (req as any).user?.id ?? null;

  // Garde : pas de bordereau en double dans les lignes.
  const ids = parsed.data.lines.map((l) => l.bordereauId);
  if (new Set(ids).size !== ids.length) {
    return res.status(400).json({ error: 'Un même bordereau ne peut apparaître qu\u2019une seule fois' });
  }

  try {
    const out = await prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.findFirst({ where: { id: supplierId, deletedAt: null } });
      if (!supplier) {
        const e: any = new Error('Fournisseur introuvable');
        e.status = 404;
        throw e;
      }

      // --- Validation de chaque ligne ---
      const prepared: { bordereau: any; montant: Prisma.Decimal }[] = [];
      let total = ZERO;
      for (const l of parsed.data.lines) {
        const b = await tx.supplierBordereau.findFirst({ where: { id: l.bordereauId, deletedAt: null } });
        if (!b) {
          const e: any = new Error(`Bordereau introuvable : ${l.bordereauId}`);
          e.status = 400;
          throw e;
        }
        if (b.supplierId !== supplierId) {
          const e: any = new Error(`Le bordereau ${b.reference} n\u2019appartient pas à ce fournisseur`);
          e.status = 400;
          throw e;
        }
        if (!STATUTS_PAYABLES.includes(b.statut)) {
          const e: any = new Error(`Bordereau ${b.reference} non payable (statut ${b.statut})`);
          e.status = 400;
          throw e;
        }
        const du = D(b.montantFinalDu);
        if (du.lessThanOrEqualTo(0)) {
          const e: any = new Error(`Bordereau ${b.reference} : plus rien à payer`);
          e.status = 400;
          throw e;
        }
        let montant: Prisma.Decimal;
        try {
          montant = D(l.montant);
        } catch {
          const e: any = new Error(`Montant invalide pour ${b.reference}`);
          e.status = 400;
          throw e;
        }
        if (montant.lessThanOrEqualTo(0)) {
          const e: any = new Error(`Montant doit être > 0 pour ${b.reference}`);
          e.status = 400;
          throw e;
        }
        if (montant.greaterThan(du)) {
          const e: any = new Error(
            `Surpaiement interdit : ${b.reference} montant ${montant.toFixed(2)} > dû ${du.toFixed(2)}`,
          );
          e.status = 400;
          throw e;
        }
        total = total.plus(montant);
        prepared.push({ bordereau: b, montant });
      }

      // --- mode ENCAISSER : vérifier la disponibilité des avances ---
      let avances: any[] = [];
      if (mode === 'ENCAISSER') {
        avances = await tx.supplierAdvance.findMany({
          where: {
            supplierId,
            deletedAt: null,
            status: { in: ['DISPONIBLE', 'PARTIALLY_ALLOCATED'] },
          },
          orderBy: [{ status: 'asc' }, { advanceDate: 'asc' }],
        });
        let dispo = ZERO;
        for (const a of avances) dispo = dispo.plus(D(a.amount).minus(D(a.allocatedAmount)));
        if (dispo.lessThan(total)) {
          const e: any = new Error(
            `Avance insuffisante : disponible ${dispo.toFixed(2)} DA < requis ${total.toFixed(2)} DA`,
          );
          e.status = 400;
          throw e;
        }
      }

      // --- Création du bon ---
      const reference = await nextBpRef(tx);
      const ean13 = await nextEan13(tx, 'supplierPayment', EAN_PREFIX.supplierPayment);
      const payment = await tx.supplierPayment.create({
        data: {
          reference,
          ean13,
          supplierId,
          date: datePaiement,
          mode,
          method: method as any,
          totalAmount: total,
          notes: parsed.data.notes ?? null,
          createdBy: userId,
        },
      });

      const lignesOut: any[] = [];
      // Copie mutable des avances pour la consommation FIFO.
      const pool = avances.map((a) => ({ ...a, restant: D(a.amount).minus(D(a.allocatedAmount)) }));

      for (const p of prepared) {
        const b = p.bordereau;
        const montant = p.montant;

        const ligne = await tx.supplierPaymentLine.create({
          data: { paymentId: payment.id, bordereauId: b.id, montant },
        });

        // Recharge + mise à jour du reste dû / statut.
        const frais = await tx.supplierBordereau.findUnique({ where: { id: b.id } });
        const nouveauDu = D(frais!.montantFinalDu).minus(montant);
        const resteFinal = nouveauDu.lessThan(0) ? ZERO : nouveauDu;
        await tx.supplierBordereau.update({
          where: { id: b.id },
          data: {
            montantFinalDu: resteFinal,
            statut: resteFinal.lessThanOrEqualTo(0) ? 'paye' : 'partiellement_paye',
          },
        });

        if (mode === 'PAY') {
          await tx.payment.create({
            data: {
              reference: await nextPaymentRef(tx),
              supplierId,
              amount: montant,
              method: method as any,
              paymentDate: datePaiement,
              notes: `${payment.reference} / ${b.reference}`,
              createdBy: userId,
            },
          });
          await tx.supplier.update({
            where: { id: supplierId },
            data: { balance: { decrement: montant } },
          });
        } else {
          // ENCAISSER : imputation FIFO sur les avances disponibles.
          let reste = montant;
          for (const a of pool) {
            if (reste.lessThanOrEqualTo(0)) break;
            if (a.restant.lessThanOrEqualTo(0)) continue;
            const part = a.restant.greaterThanOrEqualTo(reste) ? reste : a.restant;
            await tx.supplierAdvanceAllocation.create({
              data: {
                advanceId: a.id,
                bordereauId: b.id,
                amount: part,
                allocatedAt: datePaiement,
                notes: `${payment.reference} / ${b.reference}`,
                createdBy: userId,
              },
            });
            const nouvelAlloue = D(a.allocatedAmount).plus(part);
            await tx.supplierAdvance.update({
              where: { id: a.id },
              data: {
                allocatedAmount: nouvelAlloue,
                status: nouvelAlloue.greaterThanOrEqualTo(D(a.amount)) ? 'ALLOCATED' : 'PARTIALLY_ALLOCATED',
              },
            });
            a.allocatedAmount = nouvelAlloue;
            a.restant = a.restant.minus(part);
            reste = reste.minus(part);
          }
          if (reste.greaterThan(0)) {
            const e: any = new Error('Avance insuffisante lors de l\u2019imputation');
            e.status = 400;
            throw e;
          }
        }

        lignesOut.push({
          id: ligne.id,
          bordereauId: b.id,
          bordereauRef: b.reference,
          montant: dec(montant),
          montantDuAvant: dec(D(b.montantFinalDu)),
          reste: dec(resteFinal),
        });
      }

      // --- Sortie de caisse (uniquement PAY + CASH) ---
      if (mode === 'PAY' && method === 'CASH') {
        const day = await getOrCreateDay(tx, datePaiement);
        if (day.status === 'cloturee') {
          const e: any = new Error('Journée clôturée : saisie impossible');
          e.status = 409;
          throw e;
        }
        await assertPasDeDoublon(tx, 'SUPPLIER_PAYMENT', payment.id);
        await tx.cashRegisterEntry.create({
          data: {
            cashRegisterDayId: day.id,
            direction: 'OUTPUT',
            category: 'Paiement fournisseur',
            amount: total,
            sourceType: 'SUPPLIER_PAYMENT',
            sourceId: payment.id,
            reference: payment.reference,
            description: `Règlement ${supplier.name}`,
            createdBy: userId,
          },
        });
        await recalculerEtPersister(tx, datePaiement);
      }

      return { payment, lignesOut };
    });

    res.status(201).json({
      payment: {
        id: out.payment.id,
        reference: out.payment.reference,
        ean13: out.payment.ean13,
        totalAmount: dec(out.payment.totalAmount),
        mode: out.payment.mode,
        method: out.payment.method,
        date: out.payment.date,
      },
      lines: out.lignesOut,
    });
  } catch (e: any) {
    console.error('[supplier-payments] create error', e?.message);
    res.status(e?.status ?? 500).json({ error: e?.message ?? 'Erreur création bon de paiement' });
  }
});

// =====================================================================
// GET /api/supplier-payments/:id — détail.
// =====================================================================
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const p = await prisma.supplierPayment.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: {
        supplier: { select: { id: true, name: true, phone: true, wilaya: true } },
        lines: { include: { bordereau: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!p) return res.status(404).json({ error: 'Bon de paiement introuvable' });
    res.json({
      id: p.id,
      reference: p.reference,
      ean13: p.ean13,
      date: p.date,
      mode: p.mode,
      method: p.method,
      totalAmount: dec(p.totalAmount),
      notes: p.notes,
      supplier: p.supplier,
      lines: p.lines.map((l) => ({
        id: l.id,
        bordereauId: l.bordereauId,
        bordereauRef: l.bordereau?.reference ?? '—',
        dateCloture: l.bordereau?.dateCloture ?? null,
        statut: l.bordereau?.statut ?? null,
        montant: dec(l.montant),
        reste: dec(l.bordereau?.montantFinalDu),
      })),
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Erreur chargement bon de paiement' });
  }
});

// =====================================================================
// GET /api/supplier-payments/:id/pdf — bon de paiement PDF A4.
// =====================================================================
router.get('/:id/pdf', async (req: Request, res: Response) => {
  try {
    const p = await prisma.supplierPayment.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: {
        supplier: true,
        lines: { include: { bordereau: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!p) return res.status(404).json({ error: 'Bon de paiement introuvable' });

    const eanPng = p.ean13 ? await ean13Png(p.ean13) : null;
    const doc = buildSupplierPaymentPdf(
      {
        reference: p.reference,
        date: p.date.toISOString(),
        mode: p.mode,
        method: p.method,
        totalAmount: dec(p.totalAmount) ?? '0',
        notes: p.notes,
        ean13: p.ean13,
      },
      p.lines.map((l) => {
        const reste = D(l.bordereau?.montantFinalDu ?? 0);
        return {
          bordereauRef: l.bordereau?.reference ?? '—',
          dateCloture: l.bordereau?.dateCloture ? l.bordereau.dateCloture.toISOString() : null,
          montantDuAvant: reste.plus(D(l.montant)).toFixed(2),
          montantPaye: dec(l.montant) ?? '0',
          reste: reste.toFixed(2),
        };
      }),
      { name: p.supplier?.name ?? '—', phone: p.supplier?.phone, wilaya: p.supplier?.wilaya },
      eanPng,
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="bon-paiement-${p.reference}.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch (e: any) {
    console.error('[supplier-payments] pdf error', e);
    if (!res.headersSent) res.status(500).json({ error: 'Erreur génération PDF', message: e?.message });
  }
});

export default router;
