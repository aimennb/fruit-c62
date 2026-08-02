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
import { getOrCreateDay, recalculerEtPersister } from './cash-register.routes';
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
        status: p.status,
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
    // Règle métier : « 1 bordereau = 1 seul BP ». Tout bordereau déjà présent
    // dans une ligne de bon de paiement (réglé ou non) est exclu.
    const dejaPris = await prisma.supplierPaymentLine.findMany({
      select: { bordereauId: true },
    });
    const idsExclus = Array.from(new Set(dejaPris.map((l) => l.bordereauId)));
    const rows = await prisma.supplierBordereau.findMany({
      where: {
        supplierId,
        deletedAt: null,
        statut: { in: STATUTS_PAYABLES },
        montantFinalDu: { gt: 0 },
        ...(idsExclus.length ? { id: { notIn: idsExclus } } : {}),
      },
      orderBy: [{ dateCloture: 'asc' }, { createdAt: 'asc' }],
    });
    // La relation SupplierBordereau -> SupplierReception n'existe pas dans le
    // schéma (receptionId est un simple champ scalaire) : on charge les BR en
    // une seule requête puis on mappe par id.
    const receptionIds = Array.from(new Set(rows.map((b) => b.receptionId).filter(Boolean)));
    const receptions = receptionIds.length
      ? await prisma.supplierReception.findMany({
          where: { id: { in: receptionIds as string[] } },
          select: { id: true, reference: true },
        })
      : [];
    const refParId = new Map(receptions.map((r) => [r.id, r.reference]));
    res.json({
      items: rows.map((b) => ({
        id: b.id,
        reference: b.reference,
        receptionId: b.receptionId ?? null,
        receptionRef: (b.receptionId && refParId.get(b.receptionId)) ?? null,
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
  mode: z.enum(['PAY', 'ENCAISSER']).optional(),
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
  const { supplierId } = parsed.data;
  const mode = parsed.data.mode ?? 'PAY';
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

      // --- Validation de chaque ligne (AUCUNE écriture sur le bordereau) ---
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

      // --- Création du bon : status 'en_attente', RIEN n'est réglé ici ---
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
          status: 'en_attente',
          totalAmount: total,
          notes: parsed.data.notes ?? null,
          createdBy: userId,
        },
      });

      const lignesOut: any[] = [];
      for (const p of prepared) {
        const b = p.bordereau;
        const ligne = await tx.supplierPaymentLine.create({
          data: {
            paymentId: payment.id,
            bordereauId: b.id,
            montant: p.montant,
            // Dû figé à la création (le bordereau n'est pas encore décrémenté).
            montantDuAvant: D(b.montantFinalDu),
            // Rien n'est encore réglé à la création du bon de paiement.
            montantPaye: D(0),
          },
        });
        lignesOut.push({
          id: ligne.id,
          bordereauId: b.id,
          bordereauRef: b.reference,
          montant: dec(p.montant),
          reste: dec(D(b.montantFinalDu)),
        });
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
        status: out.payment.status,
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
// POST /api/supplier-payments/:id/pay — RÈGLEMENT (partiel multiple).
//   mode PAY       : Payment + décrément solde fournisseur (+ caisse si CASH)
//   mode ENCAISSER : imputation FIFO des avances
// Décrémente les bordereaux et recalcule le status du bon.
// =====================================================================
const paySchema = z.object({
  mode: z.enum(['PAY', 'ENCAISSER']),
  method: z.enum(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD']).optional(),
  date: z.string().optional(),
  lines: z
    .array(
      z.object({
        bordereauId: z.string().min(1),
        montant: z.union([z.string(), z.number()]),
      }),
    )
    .min(1, 'au moins une ligne requise'),
});

router.post('/:id/pay', async (req: Request, res: Response) => {
  const parsed = paySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
  }
  const { mode } = parsed.data;
  const method = parsed.data.method ?? 'CASH';
  const datePaiement = parsed.data.date ? jour(parsed.data.date) : jour(new Date());
  const userId = (req as any).user?.id ?? null;
  const paymentId = String(req.params.id);

  const ids = parsed.data.lines.map((l) => l.bordereauId);
  if (new Set(ids).size !== ids.length) {
    return res.status(400).json({ error: 'Un même bordereau ne peut apparaître qu\u2019une seule fois' });
  }

  try {
    const out = await prisma.$transaction(async (tx) => {
      const payment = await tx.supplierPayment.findFirst({
        where: { id: paymentId, deletedAt: null },
        include: { supplier: true, lines: true },
      });
      if (!payment) {
        const e: any = new Error('Bon de paiement introuvable');
        e.status = 404;
        throw e;
      }
      if (payment.status === 'paye') {
        const e: any = new Error('Bon déjà entièrement réglé');
        e.status = 400;
        throw e;
      }
      const supplierId = payment.supplierId;
      const bordereauxDuBon = new Set(payment.lines.map((l) => l.bordereauId));

      // --- Validation ---
      const prepared: { bordereau: any; montant: Prisma.Decimal }[] = [];
      let total = ZERO;
      for (const l of parsed.data.lines) {
        if (!bordereauxDuBon.has(l.bordereauId)) {
          const e: any = new Error(`Bordereau ${l.bordereauId} n\u2019appartient pas à ce bon`);
          e.status = 400;
          throw e;
        }
        const b = await tx.supplierBordereau.findFirst({ where: { id: l.bordereauId, deletedAt: null } });
        if (!b) {
          const e: any = new Error(`Bordereau introuvable : ${l.bordereauId}`);
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

      const pool = avances.map((a) => ({ ...a, restant: D(a.amount).minus(D(a.allocatedAmount)) }));
      const lignesOut: any[] = [];

      for (const p of prepared) {
        const b = p.bordereau;
        const montant = p.montant;

        // Décrément du reste dû + statut du bordereau.
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
          bordereauId: b.id,
          bordereauRef: b.reference,
          montant: dec(montant),
          reste: dec(resteFinal),
          statut: resteFinal.lessThanOrEqualTo(0) ? 'paye' : 'partiellement_paye',
        });

        // Cumul du montant réellement réglé sur la ligne du bon de paiement.
        const ligneBP = await tx.supplierPaymentLine.findFirst({
          where: { paymentId: payment.id, bordereauId: b.id },
        });
        if (ligneBP) {
          const dejaPaye = D(ligneBP.montantPaye ?? 0);
          await tx.supplierPaymentLine.update({
            where: { id: ligneBP.id },
            data: { montantPaye: dejaPaye.plus(montant) },
          });
        }
      }

      // --- Sortie de caisse (uniquement PAY + CASH) ---
      if (mode === 'PAY' && method === 'CASH') {
        const day = await getOrCreateDay(tx, datePaiement);
        if (day.status === 'cloturee') {
          await tx.cashRegisterDay.update({
            where: { id: day.id },
            data: { status: 'ouverte', closedBy: null, closedAt: null },
          });
          try {
            await tx.cashRegisterAuditLog.create({
              data: {
                cashRegisterDayId: day.id,
                action: 'reouverture',
                userId,
                details: {
                  motif: 'Paiement fournisseur CASH sur jour clôturé',
                  paymentRef: payment.reference,
                },
              },
            });
          } catch {
            /* l'audit ne doit jamais bloquer le paiement */
          }
        }
        // Contrainte unique (sourceType, sourceId) : sur un règlement partiel
        // multiple on cumule le montant sur l'écriture existante du bon.
        const existante = await tx.cashRegisterEntry.findFirst({
          where: { sourceType: 'SUPPLIER_PAYMENT', sourceId: payment.id },
        });
        if (existante) {
          await tx.cashRegisterEntry.update({
            where: { id: existante.id },
            data: {
              cashRegisterDayId: day.id,
              amount: D(existante.amount).plus(total),
            },
          });
        } else {
          await tx.cashRegisterEntry.create({
            data: {
              cashRegisterDayId: day.id,
              direction: 'OUTPUT',
              category: 'Paiement fournisseur',
              amount: total,
              sourceType: 'SUPPLIER_PAYMENT',
              sourceId: payment.id,
              reference: payment.reference,
              description: `Règlement ${payment.supplier?.name ?? ''}`.trim(),
              createdBy: userId,
            },
          });
        }
        await recalculerEtPersister(tx, datePaiement);
      }

      // --- Recalcul du status du bon ---
      const tousLesBordereaux = await tx.supplierBordereau.findMany({
        where: { id: { in: Array.from(bordereauxDuBon) }, deletedAt: null },
        select: { statut: true },
      });
      const resteAPayer = tousLesBordereaux.filter((b) => b.statut !== 'paye').length;
      const nouveauStatus = resteAPayer === 0 ? 'paye' : 'partiellement_paye';
      const maj = await tx.supplierPayment.update({
        where: { id: payment.id },
        data: { status: nouveauStatus, mode, method: method as any },
      });

      return { payment: maj, lignesOut };
    });

    res.json({
      payment: {
        id: out.payment.id,
        reference: out.payment.reference,
        status: out.payment.status,
        mode: out.payment.mode,
        method: out.payment.method,
        totalAmount: dec(out.payment.totalAmount),
      },
      lines: out.lignesOut,
    });
  } catch (e: any) {
    console.error('[supplier-payments] pay error', e?.message);
    res.status(e?.status ?? 500).json({ error: e?.message ?? 'Erreur règlement bon de paiement' });
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

    // Réf. bon de réception (BR) + nom du produit par ligne, en 2 requêtes.
    const receptionIds = Array.from(
      new Set(p.lines.map((l) => l.bordereau?.receptionId).filter(Boolean) as string[]),
    );
    const productIds = Array.from(
      new Set(p.lines.map((l) => l.bordereau?.productId).filter(Boolean) as string[]),
    );
    const receptions = receptionIds.length
      ? await prisma.supplierReception.findMany({
          where: { id: { in: receptionIds } },
          select: { id: true, reference: true },
        })
      : [];
    const produits = productIds.length
      ? await prisma.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, name: true },
        })
      : [];
    const refParId = new Map(receptions.map((r) => [r.id, r.reference]));
    const nomParId = new Map(produits.map((r) => [r.id, r.name]));

    res.json({
      id: p.id,
      reference: p.reference,
      ean13: p.ean13,
      date: p.date,
      mode: p.mode,
      method: p.method,
      status: p.status,
      totalAmount: dec(p.totalAmount),
      notes: p.notes,
      supplier: p.supplier,
      lines: p.lines.map((l) => ({
        id: l.id,
        bordereauId: l.bordereauId,
        bordereauRef: l.bordereau?.reference ?? '—',
        receptionRef: (l.bordereau?.receptionId && refParId.get(l.bordereau.receptionId)) ?? null,
        productName: (l.bordereau?.productId && nomParId.get(l.bordereau.productId)) ?? null,
        dateCloture: l.bordereau?.dateCloture ?? null,
        statut: l.bordereau?.statut ?? null,
        montant: dec(l.montant),
        montantDuAvant: dec(l.montantDuAvant),
        montantPaye: dec(l.montantPaye ?? 0),
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
        const duAvant = D(l.montantDuAvant ?? 0);
        const paye = D(l.montantPaye ?? 0);
        return {
          bordereauRef: l.bordereau?.reference ?? '—',
          dateCloture: l.bordereau?.dateCloture ? l.bordereau.dateCloture.toISOString() : null,
          montantDuAvant: duAvant.toFixed(2),
          montantPaye: paye.toFixed(2),
          reste: duAvant.minus(paye).toFixed(2),
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
