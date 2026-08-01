// =====================================================================
// BORDEREAUX FOURNISSEUR (Étape 3 module Bordereau Fournisseur).
//   - GET   /api/supplier-bordereaux         : liste
//   - GET   /api/supplier-bordereaux/:id     : détail + tableau ventes + calculs
//   - PATCH /api/supplier-bordereaux/:id      : commissionType/value (+recalcul)
//   - POST  /api/supplier-bordereaux/:id/avances : affecte une avance (+recalcul)
//   - GET   /api/supplier-bordereaux/:id/pdf : PDF A4 paysage bilingue
//
// RÈGLE MÉTIER :
//   Le tableau des ventes est alimenté auto par les InvoiceItem liés au lot
//   du bordereau (lotId). Chaque ligne : date facture, n° facture, colis,
//   produit, poids net, prix vente/kg, montant (= poids net × prix/kg).
//   totalBrutVentes = Σ montants.
//   commission = pourcentage: totalBrut × value/100 | fixe: value.
//   montantFinalDu = totalBrutVentes - commission - avancesAffectees.
// =====================================================================
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { requireAuth } from '../auth/middleware';
import { dec } from './_helpers';
import { buildBordereauPdf, type CompanyParams } from '../bordereaux/pdf';
import { nextEan13, EAN_PREFIX, buildEan13Only } from '../barcode';
import { getBordereauLotIds, getBordereauLots } from '../bordereaux/lots';

const router = Router();
router.use(requireAuth);

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

async function getCompanyParams(): Promise<CompanyParams> {
  const cs = await prisma.companySettings.findFirst();
  if (!cs) return {};
  return {
    mandataireNameAr: (cs as any).mandataireNameAr,
    mandataireNameFr: (cs as any).mandataireNameFr,
    activity: (cs as any).activity,
    market: (cs as any).market,
    carreau: (cs as any).carreau,
    mentionFr: (cs as any).mentionFr,
    mentionAr: (cs as any).mentionAr,
    companyName: cs.companyName,
  };
}

/** Calcule le montant de la commission selon type/value. */
function computeCommission(totalBrut: Prisma.Decimal, type: string, value: Prisma.Decimal): Prisma.Decimal {
  if (type === 'fixe') return value.toDecimalPlaces(2);
  // pourcentage
  return totalBrut.times(value).dividedBy(100).toDecimalPlaces(2);
}

/** Récupère les lignes de vente auto (InvoiceItem de TOUS les lots du bordereau) + total brut. */
async function getSalesLinesForBordereau(bordereau: { id: string; lotId?: string | null }) {
  const lotIds = await getBordereauLotIds(prisma, bordereau);
  if (lotIds.length === 0) return { lines: [] as any[], totalBrut: new Prisma.Decimal(0), lotIds };
  const items = await prisma.invoiceItem.findMany({
    where: { lotId: { in: lotIds }, deletedAt: null },
    include: {
      invoice: { select: { reference: true, issueDate: true } },
      product: { select: { name: true } },
      lot: { select: { id: true, lotNumber: true, caliber: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  const lines = items.map((it) => {
    const netWeight = new Prisma.Decimal(it.netWeight);
    const unitPrice = new Prisma.Decimal(it.unitPrice);
    const montant = netWeight.times(unitPrice).toDecimalPlaces(2);
    return {
      id: it.id,
      invoiceId: it.invoiceId,
      date: it.invoice?.issueDate ?? it.createdAt,
      invoiceRef: it.invoice?.reference ?? '—',
      colis: dec(it.colis),
      productName: it.product?.name ?? it.description ?? '—',
      lotId: it.lotId,
      lotNumber: (it as any).lot?.lotNumber ?? null,
      calibre: (it as any).lot?.caliber ?? null,
      netWeight: dec(it.netWeight),
      unitPrice: dec(it.unitPrice),
      montant: montant.toString(),
    };
  });
  const totalBrut = lines.reduce((acc, l) => acc.plus(new Prisma.Decimal(l.montant)), new Prisma.Decimal(0)).toDecimalPlaces(2);
  return { lines, totalBrut, lotIds };
}

/** Pertes agrégées de tous les lots du bordereau. */
async function getLossesForBordereau(lotIds: string[]) {
  if (lotIds.length === 0) return [] as any[];
  return prisma.loss.findMany({ where: { lotId: { in: lotIds }, deletedAt: null }, orderBy: { createdAt: 'asc' } });
}

function serialize(b: any, extra?: { supplier?: any; product?: any; lot?: any; reception?: any }) {
  return {
    id: b.id,
    reference: b.reference,
    supplierId: b.supplierId,
    productId: b.productId,
    receptionId: b.receptionId,
    lotId: b.lotId,
    calibre: b.calibre ?? null,
    colisRecus: dec(b.colisRecus),
    colisVendus: dec(b.colisVendus),
    colisRestant: dec(b.colisRestant),
    poidsNetVendu: dec(b.poidsNetVendu),
    totalBrutVentes: dec(b.totalBrutVentes),
    commissionType: b.commissionType,
    commissionValue: dec(b.commissionValue),
    avancesAffectees: dec(b.avancesAffectees),
    droitMarche: dec(b.droitMarche),
    transport: dec(b.transport),
    montantFinalDu: dec(b.montantFinalDu),
    statut: b.statut,
    dateOuverture: b.dateOuverture,
    dateCloture: b.dateCloture ?? null,
    clotureParUserId: b.clotureParUserId ?? null,
    commissionDefinitive: b.commissionDefinitive != null ? dec(b.commissionDefinitive) : null,
    avancesDefinitives: b.avancesDefinitives != null ? dec(b.avancesDefinitives) : null,
    montantFinalDefinitif: b.montantFinalDefinitif != null ? dec(b.montantFinalDefinitif) : null,
    notes: b.notes ?? null,
    supplier: extra?.supplier ? { id: extra.supplier.id, name: extra.supplier.name } : undefined,
    product: extra?.product ? { id: extra.product.id, name: extra.product.name } : undefined,
    lot: extra?.lot ? { id: extra.lot.id, lotNumber: extra.lot.lotNumber } : undefined,
    reception: extra?.reception ? { id: extra.reception.id, reference: extra.reception.reference } : undefined,
  };
}

// GET /api/supplier-bordereaux — liste
router.get('/', async (_req: Request, res: Response) => {
  const items = await prisma.supplierBordereau.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'desc' },
    take: 300,
  });
  const supIds = Array.from(new Set(items.map((b) => b.supplierId)));
  const prodIds = Array.from(new Set(items.map((b) => b.productId)));
  const [suppliers, products] = await Promise.all([
    prisma.supplier.findMany({ where: { id: { in: supIds } }, select: { id: true, name: true } }),
    prisma.product.findMany({ where: { id: { in: prodIds } }, select: { id: true, name: true } }),
  ]);
  const sMap = new Map(suppliers.map((s) => [s.id, s]));
  const pMap = new Map(products.map((p) => [p.id, p]));
  res.json({
    items: items.map((b) =>
      serialize(b, { supplier: sMap.get(b.supplierId), product: pMap.get(b.productId) }),
    ),
    total: items.length,
  });
});

// GET /api/supplier-bordereaux/:id — détail + tableau ventes + calculs
router.get('/:id', async (req: Request, res: Response) => {
  const b = await prisma.supplierBordereau.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!b) return res.status(404).json({ error: 'Bordereau introuvable' });
  const [supplier, product, lot, reception] = await Promise.all([
    prisma.supplier.findUnique({ where: { id: b.supplierId } }),
    prisma.product.findUnique({ where: { id: b.productId } }),
    prisma.stockLot.findUnique({ where: { id: b.lotId } }),
    prisma.supplierReception.findUnique({ where: { id: b.receptionId } }),
  ]);

  const { lines, totalBrut, lotIds } = await getSalesLinesForBordereau(b);
  const commissionValue = new Prisma.Decimal(b.commissionValue);
  const commission = computeCommission(totalBrut, b.commissionType, commissionValue);
  const avancesAffectees = new Prisma.Decimal(b.avancesAffectees);
  const droitMarche = new Prisma.Decimal(b.droitMarche ?? 0);
  const transport = new Prisma.Decimal(b.transport ?? 0);
  const montantFinalDu = totalBrut.minus(commission).minus(avancesAffectees).minus(droitMarche).minus(transport).toDecimalPlaces(2);

  // Lots/calibres du bordereau (multi-calibres)
  const bordereauLots = await getBordereauLots(prisma, b);
  const lots = bordereauLots.map((l: any) => ({
    id: l.id,
    lotNumber: l.lotNumber,
    calibre: l.caliber ?? null,
    quantity: dec(l.quantity),
    remainingQuantity: dec(l.remainingQuantity),
  }));

  // --- Pertes agrégées de TOUS les lots (AFFICHAGE SEUL) ---
  const losses = await getLossesForBordereau(lotIds);
  const pertes = losses.map((l) => ({
    id: l.id,
    date: l.createdAt,
    quantity: dec(l.quantity),
    reason: l.reason ?? null,
    cost: dec(l.cost),
  }));
  const totalPertesColis = losses
    .reduce((acc, l) => acc.plus(new Prisma.Decimal(l.quantity)), new Prisma.Decimal(0))
    .toString();
  const totalPertesCout = losses
    .reduce((acc, l) => acc.plus(new Prisma.Decimal(l.cost)), new Prisma.Decimal(0))
    .toDecimalPlaces(2)
    .toString();

  // colisRestant = colisRecus − (colisVendus + totalPertesColis) recalculé à la volée
  const colisRestantCalc = D(b.colisRecus)
    .minus(D(b.colisVendus))
    .minus(D(totalPertesColis))
    .toDecimalPlaces(3)
    .toString();

  res.json({
    ...serialize(b, { supplier, product, lot, reception }),
    colisRestant: colisRestantCalc,
    lots,
    ventes: lines,
    // Calculs recalculés à la volée (source de vérité = InvoiceItem du lot)
    totalBrutVentes: totalBrut.toString(),
    commission: commission.toString(),
    montantFinalDu: montantFinalDu.toString(),
    // Pertes (affichage seul)
    pertes,
    totalPertesColis,
    totalPertesCout,
  });
});

const patchSchema = z.object({
  commissionType: z.enum(['pourcentage', 'fixe']).optional(),
  commissionValue: z.union([z.number(), z.string()]).optional(),
  statut: z.enum(['ouvert', 'pret_a_cloturer', 'cloture', 'partiellement_paye', 'paye', 'annule']).optional(),
  notes: z.string().optional().nullable(),
});

// PATCH /api/supplier-bordereaux/:id — commission + statut + recalcul montantFinalDu
router.patch('/:id', async (req: Request, res: Response) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Données invalides', details: parsed.error.flatten() });
  }
  const data = parsed.data;
  const b = await prisma.supplierBordereau.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!b) return res.status(404).json({ error: 'Bordereau introuvable' });
  // Bordereau clôturé : aucune modification directe (utiliser /correct)
  if (b.statut === 'cloture') {
    return res.status(400).json({ error: 'bordereau clôturé — utiliser une opération corrective (/correct)' });
  }

  try {
    const commissionType = data.commissionType ?? b.commissionType;
    const commissionValue = data.commissionValue !== undefined ? D(String(data.commissionValue)) : new Prisma.Decimal(b.commissionValue);

    const { totalBrut } = await getSalesLinesForBordereau(b);
    const commission = computeCommission(totalBrut, commissionType, commissionValue);
    const avancesAffectees = new Prisma.Decimal(b.avancesAffectees);
    const droitMarche = new Prisma.Decimal(b.droitMarche ?? 0);
    const transport = new Prisma.Decimal(b.transport ?? 0);
    const montantFinalDu = totalBrut.minus(commission).minus(avancesAffectees).minus(droitMarche).minus(transport).toDecimalPlaces(2);

    const patch: any = {
      commissionType,
      commissionValue,
      totalBrutVentes: totalBrut,
      montantFinalDu,
    };
    if (data.statut !== undefined) {
      patch.statut = data.statut;
      if (data.statut === 'cloture' && !b.dateCloture) patch.dateCloture = new Date();
    }
    if (data.notes !== undefined) patch.notes = data.notes ?? null;

    const updated = await prisma.supplierBordereau.update({ where: { id: b.id }, data: patch });
    res.json({ ...serialize(updated), commission: commission.toString() });
  } catch (e: any) {
    res.status(500).json({ error: 'Erreur mise à jour bordereau', message: e?.message });
  }
});

const avanceSchema = z.object({
  advanceId: z.string().min(1),
  amount: z.union([z.number(), z.string()]),
});
// payload tableau accepté : { affectations: [{ advanceId, amount }, ...] }
const avancesBatchSchema = z.object({
  affectations: z.array(avanceSchema).min(1),
});

/** Statut "métier" d'une avance selon le total alloué (mapping enum Prisma). */
function advanceStatusFor(allocated: Prisma.Decimal, total: Prisma.Decimal): 'DISPONIBLE' | 'PARTIALLY_ALLOCATED' | 'ALLOCATED' {
  if (allocated.lessThanOrEqualTo(0)) return 'DISPONIBLE'; // non_affectee
  if (allocated.greaterThanOrEqualTo(total)) return 'ALLOCATED'; // totalement_affectee
  return 'PARTIALLY_ALLOCATED'; // partiellement_affectee
}
const ADVANCE_STATUS_FR: Record<string, string> = {
  DISPONIBLE: 'non_affectee',
  PARTIALLY_ALLOCATED: 'partiellement_affectee',
  ALLOCATED: 'totalement_affectee',
  REFUNDED: 'rembourse',
  CANCELLED: 'annule',
};

/** Affecte une avance à un bordereau (transaction). Retourne bordereau maj + allocation. */
async function allocateAdvance(bordereauId: string, advanceId: string, amount: Prisma.Decimal, userId: string | null) {
  const b = await prisma.supplierBordereau.findFirst({ where: { id: bordereauId, deletedAt: null } });
  if (!b) { const e: any = new Error('Bordereau introuvable'); e.status = 404; throw e; }
  if (b.statut === 'cloture') { const e: any = new Error('bordereau clôturé'); e.status = 400; throw e; }
  const advance = await prisma.supplierAdvance.findFirst({ where: { id: advanceId, deletedAt: null } });
  if (!advance) { const e: any = new Error('Avance introuvable'); e.status = 404; throw e; }
  if (advance.supplierId !== b.supplierId) { const e: any = new Error("L'avance n'appartient pas au même fournisseur"); e.status = 400; throw e; }
  if (advance.status === 'CANCELLED' || advance.status === 'REFUNDED') { const e: any = new Error('Avance annulée/remboursée — non affectable'); e.status = 400; throw e; }
  const dispo = D(advance.amount).minus(advance.allocatedAmount).minus(advance.refundedAmount);
  if (amount.greaterThan(dispo)) { const e: any = new Error(`Montant > disponible de l'avance (${dispo.toString()})`); e.status = 400; throw e; }

  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const allocation = await tx.supplierAdvanceAllocation.create({
      data: {
        advanceId: advance.id,
        bordereauId: b.id,
        amount,
        allocatedAt: now,
        notes: `Affectée au bordereau ${b.reference} (${b.id})`,
        createdBy: userId,
      },
    });

    const newAllocated = D(advance.allocatedAmount).plus(amount);
    const status = advanceStatusFor(newAllocated, D(advance.amount));
    const updAdvance = await tx.supplierAdvance.update({
      where: { id: advance.id },
      data: { allocatedAmount: newAllocated, status },
    });

    const newAvancesAffectees = new Prisma.Decimal(b.avancesAffectees).plus(amount).toDecimalPlaces(2);
    const { totalBrut } = await getSalesLinesForBordereau(b);
    const commission = computeCommission(totalBrut, b.commissionType, new Prisma.Decimal(b.commissionValue));
    const droitMarche = new Prisma.Decimal(b.droitMarche ?? 0);
    const transport = new Prisma.Decimal(b.transport ?? 0);
    const montantFinalDu = totalBrut.minus(commission).minus(newAvancesAffectees).minus(droitMarche).minus(transport).toDecimalPlaces(2);

    const updated = await tx.supplierBordereau.update({
      where: { id: b.id },
      data: { avancesAffectees: newAvancesAffectees, totalBrutVentes: totalBrut, montantFinalDu },
    });
    return { updated, allocation, commission, advance: updAdvance };
  });
}

// POST /api/supplier-bordereaux/:id/avances — affecter une ou plusieurs avances
// Payload simple { advanceId, amount } OU tableau { affectations: [...] }.
// Une même avance peut être affectée à plusieurs bordereaux (appels multiples).
router.post('/:id/avances', async (req: Request, res: Response) => {
  const userId = (req as any).user?.id ?? null;
  let items: { advanceId: string; amount: number | string }[];
  const batch = avancesBatchSchema.safeParse(req.body);
  if (batch.success) items = batch.data.affectations as any;
  else {
    const single = avanceSchema.safeParse(req.body);
    if (!single.success) return res.status(400).json({ error: 'Données invalides', details: single.error.flatten() });
    items = [single.data as any];
  }

  try {
    let last: any = null;
    const allocations: any[] = [];
    for (const it of items) {
      const amount = D(String(it.amount));
      if (amount.lessThanOrEqualTo(0)) return res.status(400).json({ error: 'Montant doit être > 0' });
      last = await allocateAdvance(req.params.id, it.advanceId, amount, userId);
      allocations.push({
        allocationId: last.allocation.id,
        advanceId: it.advanceId,
        amount: amount.toString(),
        advanceStatus: ADVANCE_STATUS_FR[last.advance.status] ?? last.advance.status,
      });
    }
    res.status(201).json({
      ...serialize(last.updated),
      commission: last.commission.toString(),
      allocationId: allocations[0]?.allocationId,
      allocations,
    });
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e?.message ?? 'Erreur affectation avance' });
  }
});

// DELETE /api/supplier-bordereaux/:id/avances/:allocationId — annuler une affectation
router.delete('/:id/avances/:allocationId', async (req: Request, res: Response) => {
  try {
    const b = await prisma.supplierBordereau.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!b) return res.status(404).json({ error: 'Bordereau introuvable' });
    if (b.statut === 'cloture') return res.status(400).json({ error: 'bordereau clôturé' });
    const alloc = await prisma.supplierAdvanceAllocation.findFirst({
      where: { id: req.params.allocationId, bordereauId: b.id, deletedAt: null },
    });
    if (!alloc) return res.status(404).json({ error: 'Affectation introuvable' });
    const advance = await prisma.supplierAdvance.findUnique({ where: { id: alloc.advanceId } });
    if (!advance) return res.status(404).json({ error: 'Avance introuvable' });

    const result = await prisma.$transaction(async (tx) => {
      await tx.supplierAdvanceAllocation.update({ where: { id: alloc.id }, data: { deletedAt: new Date() } });
      const amount = D(alloc.amount);
      const newAllocated = Prisma.Decimal.max(D(advance.allocatedAmount).minus(amount), D(0));
      const status = advanceStatusFor(newAllocated, D(advance.amount));
      const updAdvance = await tx.supplierAdvance.update({
        where: { id: advance.id },
        data: { allocatedAmount: newAllocated, status },
      });
      const newAvances = Prisma.Decimal.max(D(b.avancesAffectees).minus(amount), D(0)).toDecimalPlaces(2);
      const { totalBrut } = await getSalesLinesForBordereau(b);
      const commission = computeCommission(totalBrut, b.commissionType, D(b.commissionValue));
      const droitMarche = new Prisma.Decimal(b.droitMarche ?? 0);
      const transport = new Prisma.Decimal(b.transport ?? 0);
      const montantFinalDu = totalBrut.minus(commission).minus(newAvances).minus(droitMarche).minus(transport).toDecimalPlaces(2);
      const updated = await tx.supplierBordereau.update({
        where: { id: b.id },
        data: { avancesAffectees: newAvances, totalBrutVentes: totalBrut, montantFinalDu },
      });
      return { updated, commission, updAdvance };
    });
    res.json({
      ...serialize(result.updated),
      commission: result.commission.toString(),
      advanceStatus: ADVANCE_STATUS_FR[result.updAdvance.status] ?? result.updAdvance.status,
    });
  } catch (e: any) {
    res.status(500).json({ error: 'Erreur annulation affectation', message: e?.message });
  }
});

// PATCH /api/supplier-bordereaux/:id/cloture — clôture définitive du bordereau
router.patch('/:id/cloture', async (req: Request, res: Response) => {
  try {
    const b = await prisma.supplierBordereau.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!b) return res.status(404).json({ error: 'Bordereau introuvable' });
    if (b.statut === 'cloture') return res.status(400).json({ error: 'bordereau déjà clôturé' });
    if (new Prisma.Decimal(b.colisVendus).lessThan(b.colisRecus)) {
      return res.status(400).json({ error: 'Clôture impossible : colis vendus < colis reçus' });
    }
    const { totalBrut } = await getSalesLinesForBordereau(b);
    const commission = computeCommission(totalBrut, b.commissionType, new Prisma.Decimal(b.commissionValue));
    const avances = new Prisma.Decimal(b.avancesAffectees);
    const droitMarche = new Prisma.Decimal(b.droitMarche ?? 0);
    const transport = new Prisma.Decimal(b.transport ?? 0);
    const montantFinalDu = totalBrut.minus(commission).minus(avances).minus(droitMarche).minus(transport).toDecimalPlaces(2);
    const userId = (req as any).user?.id ?? null;

    const updated = await prisma.supplierBordereau.update({
      where: { id: b.id },
      data: {
        statut: 'cloture',
        dateCloture: new Date(),
        clotureParUserId: userId,
        totalBrutVentes: totalBrut,
        montantFinalDu,
        commissionDefinitive: commission,
        avancesDefinitives: avances,
        montantFinalDefinitif: montantFinalDu,
      },
    });
    res.json({
      ...serialize(updated),
      commission: commission.toString(),
      commissionDefinitive: commission.toString(),
      avancesDefinitives: avances.toString(),
      montantFinalDefinitif: montantFinalDu.toString(),
      clotureParUserId: updated.clotureParUserId,
    });
  } catch (e: any) {
    res.status(500).json({ error: 'Erreur clôture', message: e?.message });
  }
});

// PATCH /api/supplier-bordereaux/:id/correct — opération corrective (bordereau clôturé)
const correctSchema = z.object({
  motif: z.string(),
  commissionType: z.enum(['pourcentage', 'fixe']).optional(),
  commissionValue: z.union([z.number(), z.string()]).optional(),
  avancesAffectees: z.union([z.number(), z.string()]).optional(),
});
router.patch('/:id/correct', async (req: Request, res: Response) => {
  const parsed = correctSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Données invalides', details: parsed.error.flatten() });
  const data = parsed.data;
  if (!data.motif || !data.motif.trim()) return res.status(400).json({ error: 'Motif obligatoire' });
  if (data.commissionType === undefined && data.commissionValue === undefined && data.avancesAffectees === undefined) {
    return res.status(400).json({ error: 'Aucune valeur à corriger' });
  }
  const b = await prisma.supplierBordereau.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!b) return res.status(404).json({ error: 'Bordereau introuvable' });
  const userId = (req as any).user?.id ?? '';

  try {
    const result = await prisma.$transaction(async (tx) => {
      const corrections: any[] = [];
      const mk = (champ: string, anc: string, nouv: string) =>
        tx.supplierBordereauCorrection.create({
          data: { bordereauId: b.id, userId, motif: data.motif.trim(), champ, ancienneValeur: anc, nouvelleValeur: nouv },
        });

      const commissionType = data.commissionType ?? b.commissionType;
      const commissionValue = data.commissionValue !== undefined ? D(String(data.commissionValue)) : D(b.commissionValue);
      const avances = data.avancesAffectees !== undefined ? D(String(data.avancesAffectees)) : D(b.avancesAffectees);

      if (data.commissionType !== undefined && data.commissionType !== b.commissionType)
        corrections.push(await mk('commissionType', b.commissionType, data.commissionType));
      if (data.commissionValue !== undefined)
        corrections.push(await mk('commissionValue', D(b.commissionValue).toString(), commissionValue.toString()));
      if (data.avancesAffectees !== undefined)
        corrections.push(await mk('avancesAffectees', D(b.avancesAffectees).toString(), avances.toString()));

      const { totalBrut } = await getSalesLinesForBordereau(b);
      const commission = computeCommission(totalBrut, commissionType, commissionValue);
      const droitMarche = new Prisma.Decimal(b.droitMarche ?? 0);
      const transport = new Prisma.Decimal(b.transport ?? 0);
      const montantFinalDu = totalBrut.minus(commission).minus(avances).minus(droitMarche).minus(transport).toDecimalPlaces(2);

      const patch: any = {
        commissionType,
        commissionValue,
        avancesAffectees: avances,
        totalBrutVentes: totalBrut,
        montantFinalDu,
      };
      if (b.statut === 'cloture') {
        patch.commissionDefinitive = commission;
        patch.avancesDefinitives = avances;
        patch.montantFinalDefinitif = montantFinalDu;
      }
      const updated = await tx.supplierBordereau.update({ where: { id: b.id }, data: patch });
      return { updated, commission, corrections };
    });
    res.json({
      ...serialize(result.updated),
      commission: result.commission.toString(),
      corrections: result.corrections.map((c) => ({ id: c.id, champ: c.champ, motif: c.motif, ancienneValeur: c.ancienneValeur, nouvelleValeur: c.nouvelleValeur, date: c.date })),
    });
  } catch (e: any) {
    res.status(500).json({ error: 'Erreur correction', message: e?.message });
  }
});

// GET /api/supplier-bordereaux/:id/pdf — PDF A4 paysage bilingue
router.get('/:id/pdf', async (req: Request, res: Response) => {
  try {
    const b = await prisma.supplierBordereau.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!b) return res.status(404).json({ error: 'Bordereau introuvable' });
    const [supplier, product, lot] = await Promise.all([
      prisma.supplier.findUnique({ where: { id: b.supplierId } }),
      prisma.product.findUnique({ where: { id: b.productId } }),
      prisma.stockLot.findUnique({ where: { id: b.lotId } }),
    ]);

    const { lines, totalBrut, lotIds } = await getSalesLinesForBordereau(b);
    const commissionValue = new Prisma.Decimal(b.commissionValue);
    const commission = computeCommission(totalBrut, b.commissionType, commissionValue);
    const avancesAffectees = new Prisma.Decimal(b.avancesAffectees);
    const droitMarche = new Prisma.Decimal(b.droitMarche ?? 0);
    const transport = new Prisma.Decimal(b.transport ?? 0);
    const montantFinalDu = totalBrut.minus(commission).minus(avancesAffectees).minus(droitMarche).minus(transport).toDecimalPlaces(2);

    // Lots/calibres du bordereau
    const bordereauLots = await getBordereauLots(prisma, b);

    // Pertes agrégées de tous les lots (affichage seul dans le PDF)
    const losses = await getLossesForBordereau(lotIds);
    const totalPertesColis = losses
      .reduce((acc, l) => acc.plus(new Prisma.Decimal(l.quantity)), new Prisma.Decimal(0))
      .toString();
    const totalPertesCout = losses
      .reduce((acc, l) => acc.plus(new Prisma.Decimal(l.cost)), new Prisma.Decimal(0))
      .toDecimalPlaces(2)
      .toString();

    const company = await getCompanyParams();
    const barcodes = await buildEan13Only((b as any).ean13);
    const doc = buildBordereauPdf(
      {
        barcodes,
        reference: b.reference,
        supplierName: supplier?.name ?? '—',
        productName: product?.name ?? '—',
        calibre: b.calibre ?? null,
        lotNumber: bordereauLots.length > 1 ? `${bordereauLots.length} lots` : lot?.lotNumber ?? bordereauLots[0]?.lotNumber ?? '—',
        lots: bordereauLots.map((l: any) => ({
          lotNumber: l.lotNumber,
          calibre: l.caliber ?? null,
          colis: dec(l.quantity) ?? '0',
        })),
        colisRecus: dec(b.colisRecus) ?? '0',
        colisVendus: dec(b.colisVendus) ?? '0',
        colisRestant: D(b.colisRecus).minus(D(b.colisVendus)).minus(D(totalPertesColis)).toDecimalPlaces(3).toString(),
        statut: b.statut,
        lines: lines.map((l) => ({
          date: (l.date as Date | string).toString(),
          invoiceRef: l.invoiceRef,
          colis: l.colis ?? '0',
          productName: l.productName,
          calibre: l.calibre ?? null,
          netWeight: l.netWeight ?? '0',
          unitPrice: l.unitPrice ?? '0',
          montant: l.montant,
        })),
        totalBrutVentes: totalBrut.toString(),
        commissionType: b.commissionType,
        commissionValue: dec(b.commissionValue) ?? '0',
        commissionAmount: commission.toString(),
        avancesAffectees: dec(b.avancesAffectees) ?? '0',
        droitMarche: dec(b.droitMarche) ?? '0',
        transport: dec(b.transport) ?? '0',
        montantFinalDu: montantFinalDu.toString(),
        pertes: losses.map((l) => ({
          date: l.createdAt.toString(),
          quantity: dec(l.quantity) ?? '0',
          reason: l.reason ?? null,
          cost: dec(l.cost) ?? '0',
        })),
        totalPertesColis,
        totalPertesCout,
      },
      company,
    );

    const filename = `bordereau-${b.reference}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    doc.pipe(res);
    doc.end();
  } catch (e: any) {
    console.error('[supplier-bordereaux] pdf error', e);
    if (!res.headersSent) res.status(500).json({ error: 'Erreur génération PDF', message: e?.message });
  }
});

export default router;
