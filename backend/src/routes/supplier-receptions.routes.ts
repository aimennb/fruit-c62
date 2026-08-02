// =====================================================================
// BON DE RÉCEPTION FOURNISSEUR (Étape 1 module Bordereau Fournisseur).
// Règle métier : 1 bon de réception = 1 lot = 1 bordereau.
// À la validation (POST) : entrée marchandise, +stock (nb colis),
// création auto du lot, du bordereau fournisseur, mouvement IN,
// et avance éventuelle (SupplierAdvance + écriture compte fournisseur).
// =====================================================================
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { requireAuth, requirePermission } from '../auth/middleware';
import { dec } from './_helpers';
import { buildReceptionPdf, type CompanyParams } from '../receptions/pdf';
import { nextEan13, EAN_PREFIX, buildEan13Only } from '../barcode';
import { getBordereauLotIds } from '../bordereaux/lots';

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

const updateItemSchema = z.object({
  calibre: z.string().max(60).optional().nullable(),
  nbrColis: z.union([z.number(), z.string()]),
  poidsEmballageVide: z.union([z.number(), z.string()]).optional(),
});

const updateSchema = z.object({
  observations: z.string().optional().nullable(),
  avanceOui: z.boolean().optional(),
  avanceMontant: z.union([z.number(), z.string()]).optional(),
  poidsEmballageVide: z.union([z.number(), z.string()]).optional(),
  nbrColis: z.union([z.number(), z.string()]).optional(),
  // Édition complète (nouveau) : lignes calibre + frais
  items: z.array(updateItemSchema).min(1).optional(),
  droitMarche: z.union([z.number(), z.string()]).optional(),
  transport: z.union([z.number(), z.string()]).optional(),
});

const router = Router();
router.use(requireAuth);

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const pad6 = (n: number) => String(n).padStart(6, '0');

const itemSchema = z.object({
  calibre: z.string().max(60).optional().nullable(),
  nbrColis: z.union([z.number(), z.string()]).transform((v) => String(v)),
  poidsEmballageVide: z.union([z.number(), z.string()]).optional().transform((v) => String(v ?? 0)),
});

const createSchema = z.object({
  supplierId: z.string().min(1),
  productId: z.string().min(1),
  // Mode multi-calibres (nouveau) : items[]. Mode mono (rétro-compat) : nbrColis/calibre/poids.
  items: z.array(itemSchema).min(1).optional(),
  nbrColis: z.union([z.number(), z.string()]).optional().transform((v) => (v === undefined ? undefined : String(v))),
  poidsEmballageVide: z.union([z.number(), z.string()]).optional().transform((v) => String(v ?? 0)),
  avanceOui: z.boolean().optional().default(false),
  avanceMontant: z.union([z.number(), z.string()]).optional().transform((v) => String(v ?? 0)),
  droitMarche: z.union([z.number(), z.string()]).optional().transform((v) => String(v ?? 0)),
  transport: z.union([z.number(), z.string()]).optional().transform((v) => String(v ?? 0)),
  observations: z.string().optional().nullable(),
  heure: z.string().optional().nullable(),
  calibre: z.string().max(60).optional().nullable(),
});

function serialize(r: any, bordereau?: any, lot?: any, advance?: any) {
  return {
    ...r,
    nbrColis: dec(r.nbrColis),
    poidsEmballageVide: dec(r.poidsEmballageVide),
    avanceMontant: dec(r.avanceMontant),
    droitMarche: dec(r.droitMarche),
    transport: dec(r.transport),
    bordereau: bordereau
      ? {
          ...bordereau,
          colisRecus: dec(bordereau.colisRecus),
          colisVendus: dec(bordereau.colisVendus),
          colisRestant: dec(bordereau.colisRestant),
        }
      : undefined,
    lot: lot
      ? {
          ...lot,
          quantity: dec(lot.quantity),
          remainingQuantity: dec(lot.remainingQuantity),
          unitCost: dec(lot.unitCost),
          purchasePrice: dec(lot.purchasePrice),
          realCost: dec(lot.realCost),
          grossWeight: dec(lot.grossWeight),
          tare: dec(lot.tare),
          netWeight: dec(lot.netWeight),
        }
      : undefined,
    advance: advance ? { ...advance, amount: dec(advance.amount) } : undefined,
  };
}

// POST /api/supplier-receptions — création + chaînage auto lot/bordereau/stock/avance
router.post('/', requirePermission('RECEPTION_WRITE'), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Données invalides', details: parsed.error.flatten() });
  }
  const data = parsed.data;
  // Normalisation : mode mono-calibre (rétro-compat) → items[1]
  const rawItems = data.items?.length
    ? data.items
    : data.nbrColis !== undefined
      ? [{ calibre: data.calibre ?? null, nbrColis: data.nbrColis, poidsEmballageVide: data.poidsEmballageVide }]
      : null;
  if (!rawItems) return res.status(400).json({ error: 'Fournir items[] ou nbrColis' });
  const items = rawItems.map((it) => ({
    calibre: it.calibre && String(it.calibre).trim() !== '' ? String(it.calibre).trim() : null,
    nbrColis: D(it.nbrColis),
    poidsEmballageVide: D(it.poidsEmballageVide ?? 0),
  }));
  for (const it of items) {
    if (it.nbrColis.lessThanOrEqualTo(0)) return res.status(400).json({ error: 'nbrColis doit être > 0 sur chaque ligne' });
  }
  const totalColis = items.reduce((a, it) => a.plus(it.nbrColis), D(0));
  const avanceMontant = D(data.avanceMontant);
  const droitMarche = D(data.droitMarche);
  const transport = D(data.transport);
  const userId = (req as any).user?.id ?? null;

  const [supplier, product] = await Promise.all([
    prisma.supplier.findFirst({ where: { id: data.supplierId, deletedAt: null } }),
    prisma.product.findFirst({ where: { id: data.productId, deletedAt: null } }),
  ]);
  if (!supplier) return res.status(404).json({ error: 'Fournisseur introuvable' });
  if (!product) return res.status(404).json({ error: 'Produit introuvable' });

  try {
    const result = await prisma.$transaction(async (tx) => {
      const now = new Date();
      // Références séquentielles — max(numéro existant)+1 (TOUTES les lignes,
      // supprimées comprises, car la contrainte unique s'applique même aux soft-deleted).
      // Évite les collisions type « BR-000005 » quand count()+1 retombe sur une réf existante.
      const nextRef = async (model: string, field: string, prefix: string): Promise<string> => {
        const rows = await (tx as any)[model].findMany({ select: { [field]: true } });
        let max = 0;
        for (const r of rows) {
          const m = /(\d+)\s*$/.exec(String((r as any)[field] ?? ''));
          if (m) max = Math.max(max, parseInt(m[1], 10));
        }
        return `${prefix}-${pad6(max + 1)}`;
      };
      const refBR = await nextRef('supplierReception', 'reference', 'BR');
      // Code-barres EAN13 (préfixe 3 = réception).
      const eanBR = await nextEan13(tx, 'supplierReception', EAN_PREFIX.reception);

      // 1) Réception (en-tête : nbrColis = total des lignes pour compat affichage)
      const reception = await tx.supplierReception.create({
        data: {
          reference: refBR,
          ean13: eanBR,
          date: now,
          heure: data.heure ?? now.toTimeString().slice(0, 5),
          supplierId: data.supplierId,
          productId: data.productId,
          nbrColis: totalColis,
          poidsEmballageVide: items.length === 1 ? items[0].poidsEmballageVide : D(0),
          avanceOui: !!data.avanceOui,
          avanceMontant: data.avanceOui ? avanceMontant : D(0),
          droitMarche,
          transport,
          observations: data.observations ?? null,
          createdBy: userId,
        },
      });

      // 2) Bordereau UNIQUE par (fournisseur, produit) SANS calibre — recherche d'un ouvert.
      let bordereau = await tx.supplierBordereau.findFirst({
        where: {
          supplierId: data.supplierId,
          productId: data.productId,
          statut: 'ouvert',
          deletedAt: null,
        },
      });

      // 3) N lots (1 par ligne calibre) + mouvements IN + lignes réception
      const lots: any[] = [];
      const receptionItems: any[] = [];
      let seq = 0;
      for (const it of items) {
        seq += 1;
        const lot = await tx.stockLot.create({
          data: {
            lotNumber: `LOT-${Date.now()}-${seq}`,
            productId: data.productId,
            supplierId: data.supplierId,
            quantity: it.nbrColis,
            remainingQuantity: it.nbrColis,
            unitCost: D(0),
            purchasePrice: D(0),
            realCost: D(0),
            grossWeight: it.nbrColis,
            tare: D(0),
            netWeight: it.nbrColis,
            arrivalDate: now,
            caliber: it.calibre,
            createdBy: userId,
          },
        });
        lots.push(lot);
        await tx.stockMovement.create({
          data: {
            productId: data.productId,
            lotId: lot.id,
            type: 'IN',
            quantity: it.nbrColis,
            reference: refBR,
            reason: `Réception fournisseur ${refBR}${it.calibre ? ` (calibre ${it.calibre})` : ''}`,
            createdBy: userId,
          },
        });
        receptionItems.push(
          await tx.supplierReceptionItem.create({
            data: {
              receptionId: reception.id,
              calibre: it.calibre,
              nbrColis: it.nbrColis,
              poidsEmballageVide: it.poidsEmballageVide,
              lotId: lot.id,
            },
          }),
        );
      }

      // 4) Bordereau : cumul si existant, sinon création (calibre = null).
      if (bordereau) {
        bordereau = await tx.supplierBordereau.update({
          where: { id: bordereau.id },
          data: {
            colisRecus: { increment: totalColis },
            colisRestant: { increment: totalColis },
            droitMarche: { increment: droitMarche },
            transport: { increment: transport },
          },
        });
      } else {
        const refBF = await nextRef('supplierBordereau', 'reference', 'BF');
        const eanBF = await nextEan13(tx, 'supplierBordereau', EAN_PREFIX.bordereau);
        bordereau = await tx.supplierBordereau.create({
          data: {
            reference: refBF,
            ean13: eanBF,
            supplierId: data.supplierId,
            productId: data.productId,
            receptionId: reception.id,
            lotId: lots[0].id,
            calibre: null,
            colisRecus: totalColis,
            colisVendus: D(0),
            colisRestant: totalColis,
            droitMarche,
            transport,
            statut: 'ouvert',
            dateOuverture: now,
          },
        });
      }
      // Rattacher tous les lots au bordereau
      await tx.stockLot.updateMany({
        where: { id: { in: lots.map((l) => l.id) } },
        data: { bordereauId: bordereau.id },
      });

      // 5) Avance éventuelle
      let advance: any = null;
      if (data.avanceOui && avanceMontant.greaterThan(0)) {
        advance = await tx.supplierAdvance.create({
          data: {
            supplierId: data.supplierId,
            reference: await nextRef('supplierAdvance', 'reference', 'AV'),
            amount: avanceMontant,
            advanceDate: now,
            status: 'DISPONIBLE',
            notes: `Avance sur réception ${refBR} (non_affectee)`,
            createdBy: userId,
          },
        });
        await tx.supplierAccountEntry.create({
          data: {
            supplierId: data.supplierId,
            type: 'CREDIT',
            amount: avanceMontant,
            description: `AVANCE — réception ${refBR}`,
            reference: advance.reference,
            entryDate: now,
            createdBy: userId,
          },
        });
        await tx.supplier.update({
          where: { id: data.supplierId },
          data: { balance: { decrement: avanceMontant } },
        });
      }

      // 6) Liaison réception -> bordereau + 1er lot (compat)
      const updated = await tx.supplierReception.update({
        where: { id: reception.id },
        data: { bordereauId: bordereau.id, lotId: lots[0].id },
      });

      return { reception: updated, bordereau, lot: lots[0], lots, receptionItems, advance };
    });

    return res
      .status(201)
      .json({
        ...serialize(result.reception, result.bordereau, result.lot, result.advance),
        lots: result.lots.map((l: any) => ({
          id: l.id,
          lotNumber: l.lotNumber,
          caliber: l.caliber ?? null,
          quantity: dec(l.quantity),
        })),
        items: result.receptionItems.map((it: any) => ({
          id: it.id,
          calibre: it.calibre ?? null,
          nbrColis: dec(it.nbrColis),
          poidsEmballageVide: dec(it.poidsEmballageVide),
          lotId: it.lotId,
        })),
      });
  } catch (e: any) {
    return res.status(500).json({ error: 'Erreur création réception', message: e?.message });
  }
});

// GET /api/supplier-receptions — liste
router.get('/', requirePermission('RECEPTION_WRITE'), async (_req: Request, res: Response) => {
  const items = await prisma.supplierReception.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  const bordereaux = await prisma.supplierBordereau.findMany({
    where: { id: { in: items.map((i) => i.bordereauId).filter(Boolean) as string[] } },
  });
  const bMap = new Map(bordereaux.map((b) => [b.id, b]));
  res.json({
    items: items.map((r) => serialize(r, r.bordereauId ? bMap.get(r.bordereauId) : undefined)),
    total: items.length,
  });
});

// GET /api/supplier-receptions/:id
router.get('/:id', requirePermission('RECEPTION_WRITE'), async (req: Request, res: Response) => {
  const r = await prisma.supplierReception.findFirst({
    where: { id: req.params.id, deletedAt: null },
  });
  if (!r) return res.status(404).json({ error: 'Réception introuvable' });
  const [bordereau, lot, recItems] = await Promise.all([
    r.bordereauId ? prisma.supplierBordereau.findUnique({ where: { id: r.bordereauId } }) : null,
    r.lotId ? prisma.stockLot.findUnique({ where: { id: r.lotId } }) : null,
    prisma.supplierReceptionItem.findMany({ where: { receptionId: r.id, deletedAt: null }, orderBy: { createdAt: 'asc' } }),
  ]);
  res.json({
    ...serialize(r, bordereau ?? undefined, lot ?? undefined),
    items: recItems.map((it) => ({
      id: it.id,
      calibre: it.calibre ?? null,
      nbrColis: dec(it.nbrColis),
      poidsEmballageVide: dec(it.poidsEmballageVide),
      lotId: it.lotId,
    })),
  });
});

// PATCH /api/supplier-receptions/:id — mise à jour champs éditables
router.patch('/:id', requirePermission('RECEPTION_WRITE'), async (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Données invalides', details: parsed.error.flatten() });
  }
  const data = parsed.data;
  const existing = await prisma.supplierReception.findFirst({
    where: { id: req.params.id, deletedAt: null },
  });
  if (!existing) return res.status(404).json({ error: 'Réception introuvable' });

  // Lignes calibre normalisées (édition complète) — optionnelles (rétro-compat).
  const newItems = data.items
    ? data.items.map((it) => ({
        calibre: it.calibre && String(it.calibre).trim() !== '' ? String(it.calibre).trim() : null,
        nbrColis: D(String(it.nbrColis)),
        poidsEmballageVide: D(String(it.poidsEmballageVide ?? 0)),
      }))
    : null;
  if (newItems) {
    for (const it of newItems) {
      if (it.nbrColis.lessThanOrEqualTo(0)) {
        return res.status(400).json({ error: 'nbrColis doit être > 0 sur chaque ligne' });
      }
    }
  }

  const userId = (req as any).user?.id ?? null;
  let httpStatus = 500;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const fail = (msg: string, status = 400) => {
        httpStatus = status;
        const e: any = new Error(msg);
        e.__handled = true;
        throw e;
      };
      const patch: any = {};
      if (data.observations !== undefined) patch.observations = data.observations ?? null;
      if (data.poidsEmballageVide !== undefined) patch.poidsEmballageVide = D(String(data.poidsEmballageVide));
      if (data.avanceOui !== undefined) patch.avanceOui = !!data.avanceOui;
      if (data.avanceMontant !== undefined) patch.avanceMontant = D(String(data.avanceMontant));
      if (data.droitMarche !== undefined) patch.droitMarche = D(String(data.droitMarche));
      if (data.transport !== undefined) patch.transport = D(String(data.transport));

      // ---- 1) Total colis : items[] prioritaire, sinon nbrColis (rétro-compat)
      let newColis: Prisma.Decimal | null = null;
      if (newItems) {
        newColis = newItems.reduce((a, it) => a.plus(it.nbrColis), D(0));
        if (newColis.lessThanOrEqualTo(0)) fail('nbrColis doit être > 0');
        patch.nbrColis = newColis;
        // en-tête : poids emb. repris de la ligne unique, sinon 0
        if (data.poidsEmballageVide === undefined) {
          patch.poidsEmballageVide = newItems.length === 1 ? newItems[0].poidsEmballageVide : D(0);
        }
      } else if (data.nbrColis !== undefined) {
        newColis = D(String(data.nbrColis));
        if (newColis.lessThanOrEqualTo(0)) fail('nbrColis doit être > 0');
        patch.nbrColis = newColis;
      }

      const bordAvant = existing.bordereauId
        ? await tx.supplierBordereau.findUnique({ where: { id: existing.bordereauId } })
        : null;
      const vendus = new Prisma.Decimal(bordAvant?.colisVendus ?? 0);
      // Le bordereau agrège PLUSIEURS réceptions : on ne fait AUCUN delta.
      // Garde-fou pré-écriture : somme des AUTRES réceptions + la nouvelle valeur.
      if (newColis && bordAvant) {
        const autres = await tx.supplierReception.findMany({
          where: { bordereauId: bordAvant.id, deletedAt: null, id: { not: existing.id } },
          select: { nbrColis: true },
        });
        const projete = autres
          .reduce((a, r) => a.plus(new Prisma.Decimal(r.nbrColis)), D(0))
          .plus(newColis);
        if (projete.lessThan(vendus)) {
          fail(`colisRecus < colisVendus (${projete.toString()} < ${vendus.toString()})`);
        }
      }

      const updated = await tx.supplierReception.update({ where: { id: existing.id }, data: patch });

      // ---- 2) Réconciliation des lignes calibre + lots
      if (newItems && newColis) {
        const oldItems = await tx.supplierReceptionItem.findMany({
          where: { receptionId: existing.id, deletedAt: null },
          orderBy: { createdAt: 'asc' },
        });
        const now = new Date();
        // Lot principal conservé (préserve les ventes/mouvements déjà rattachés).
        const mainLotId = existing.lotId ?? oldItems.find((o) => o.lotId)?.lotId ?? null;
        const keptLotIds: string[] = [];

        // Soft-delete de toutes les anciennes lignes, puis recréation.
        await tx.supplierReceptionItem.updateMany({
          where: { receptionId: existing.id, deletedAt: null },
          data: { deletedAt: now },
        });

        const createdItems: any[] = [];
        for (let i = 0; i < newItems.length; i++) {
          const it = newItems[i];
          let lotId: string | null = null;
          if (i === 0 && mainLotId) {
            // Ligne 1 → on AJUSTE le lot principal existant sans perdre les ventes.
            const lot = await tx.stockLot.findUnique({ where: { id: mainLotId } });
            if (lot) {
              const currentRemaining = new Prisma.Decimal(lot.remainingQuantity);
              const currentQty = new Prisma.Decimal(lot.quantity);
              // Sorties déjà effectuées sur ce lot (ventes + pertes) = quantity - remaining
              const sorties = currentQty.minus(currentRemaining);
              // Nouveau remaining = nouvelle quantité - sorties déjà faites (jamais négatif)
              let remaining = it.nbrColis.minus(sorties);
              if (remaining.lessThan(0)) remaining = D(0);
              await tx.stockLot.update({
                where: { id: lot.id },
                data: {
                  quantity: it.nbrColis,
                  remainingQuantity: remaining.toDecimalPlaces(3),
                  grossWeight: it.nbrColis,
                  netWeight: it.nbrColis,
                  caliber: it.calibre,
                  bordereauId: existing.bordereauId ?? lot.bordereauId,
                },
              });
              lotId = lot.id;
            }
          }
          if (!lotId) {
            // Ligne supplémentaire : réutiliser un ancien lot de la réception s'il existe,
            // sinon créer un nouveau lot (+ mouvement IN).
            const reusable = oldItems[i]?.lotId && oldItems[i].lotId !== mainLotId ? oldItems[i].lotId! : null;
            if (reusable) {
              const lot = await tx.stockLot.findUnique({ where: { id: reusable } });
              if (lot) {
                const sorties = new Prisma.Decimal(lot.quantity).minus(new Prisma.Decimal(lot.remainingQuantity));
                let remaining = it.nbrColis.minus(sorties);
                if (remaining.lessThan(0)) remaining = D(0);
                await tx.stockLot.update({
                  where: { id: lot.id },
                  data: {
                    quantity: it.nbrColis,
                    remainingQuantity: remaining.toDecimalPlaces(3),
                    grossWeight: it.nbrColis,
                    netWeight: it.nbrColis,
                    caliber: it.calibre,
                    bordereauId: existing.bordereauId ?? lot.bordereauId,
                  },
                });
                lotId = lot.id;
              }
            }
          }
          if (!lotId) {
            const lot = await tx.stockLot.create({
              data: {
                lotNumber: `LOT-${Date.now()}-E${i + 1}-${Math.floor(Math.random() * 1000)}`,
                productId: existing.productId,
                supplierId: existing.supplierId,
                quantity: it.nbrColis,
                remainingQuantity: it.nbrColis,
                unitCost: D(0),
                purchasePrice: D(0),
                realCost: D(0),
                grossWeight: it.nbrColis,
                tare: D(0),
                netWeight: it.nbrColis,
                arrivalDate: now,
                caliber: it.calibre,
                bordereauId: existing.bordereauId,
                createdBy: userId,
              },
            });
            await tx.stockMovement.create({
              data: {
                productId: existing.productId,
                lotId: lot.id,
                type: 'IN',
                quantity: it.nbrColis,
                reference: existing.reference,
                reason: `Modification réception ${existing.reference}${it.calibre ? ` (calibre ${it.calibre})` : ''}`,
                createdBy: userId,
              },
            });
            lotId = lot.id;
          }
          keptLotIds.push(lotId);
          createdItems.push(
            await tx.supplierReceptionItem.create({
              data: {
                receptionId: existing.id,
                calibre: it.calibre,
                nbrColis: it.nbrColis,
                poidsEmballageVide: it.poidsEmballageVide,
                lotId,
              },
            }),
          );
        }

        // Lots orphelins (lignes supprimées) : on les vide s'ils n'ont aucune vente,
        // sinon on les laisse tels quels (ventes préservées).
        const orphanIds = oldItems
          .map((o) => o.lotId)
          .filter((id): id is string => !!id && !keptLotIds.includes(id));
        for (const oid of orphanIds) {
          const lot = await tx.stockLot.findUnique({ where: { id: oid } });
          if (!lot) continue;
          const sorties = new Prisma.Decimal(lot.quantity).minus(new Prisma.Decimal(lot.remainingQuantity));
          if (sorties.lessThanOrEqualTo(0)) {
            await tx.stockLot.update({
              where: { id: oid },
              data: { quantity: D(0), remainingQuantity: D(0), grossWeight: D(0), netWeight: D(0), deletedAt: new Date() },
            });
          } else {
            // Ventes existantes : on ramène la quantité au strict nécessaire.
            await tx.stockLot.update({
              where: { id: oid },
              data: { quantity: sorties, remainingQuantity: D(0), grossWeight: sorties, netWeight: sorties },
            });
          }
        }
      } else if (newColis && existing.lotId) {
        // Rétro-compat : seul nbrColis global changé → ajuster le lot principal.
        const lot = await tx.stockLot.findUnique({ where: { id: existing.lotId } });
        if (lot) {
          const sorties = new Prisma.Decimal(lot.quantity).minus(new Prisma.Decimal(lot.remainingQuantity));
          let remaining = newColis.minus(sorties);
          if (remaining.lessThan(0)) remaining = D(0);
          await tx.stockLot.update({
            where: { id: lot.id },
            data: {
              quantity: newColis,
              remainingQuantity: remaining.toDecimalPlaces(3),
              grossWeight: newColis,
              netWeight: newColis,
            },
          });
        }
      }

      // ---- 3) Recalcul bordereau (colisVendus JAMAIS écrasé)
      let bordereau = bordAvant;
      if (bordAvant) {
        const lotIds = await getBordereauLotIds(tx, bordAvant);
        const pertesAgg = lotIds.length
          ? await tx.loss.aggregate({ _sum: { quantity: true }, where: { lotId: { in: lotIds }, deletedAt: null } })
          : { _sum: { quantity: null } };
        const pertes = new Prisma.Decimal(pertesAgg._sum.quantity ?? 0);
        const bPatch: any = {};
        // RECALCUL COMPLET (pas de delta) : somme de TOUTES les réceptions du bordereau.
        const recs = await tx.supplierReception.findMany({
          where: { bordereauId: bordAvant.id, deletedAt: null },
          select: { nbrColis: true, droitMarche: true, transport: true },
        });
        const totColis = recs.reduce((a, r) => a.plus(new Prisma.Decimal(r.nbrColis)), D(0));
        const totDroit = recs.reduce((a, r) => a.plus(new Prisma.Decimal(r.droitMarche ?? 0)), D(0));
        const totTransport = recs.reduce((a, r) => a.plus(new Prisma.Decimal(r.transport ?? 0)), D(0));

        bPatch.colisRecus = totColis;
        bPatch.colisRestant = totColis.minus(vendus).minus(pertes).toDecimalPlaces(3);
        bPatch.statut = vendus.gte(totColis) ? 'pret_a_cloturer' : 'ouvert';
        bPatch.droitMarche = totDroit;
        bPatch.transport = totTransport;
        // colisVendus : JAMAIS touché.

        // montantFinalDu = totalBrutVentes - commission - avancesAffectees - droitMarche - transport
        const invItems = lotIds.length
          ? await tx.invoiceItem.findMany({ where: { lotId: { in: lotIds }, deletedAt: null } })
          : [];
        const totalBrut = invItems
          .reduce(
            (acc: Prisma.Decimal, it: any) =>
              acc.plus(new Prisma.Decimal(it.netWeight).times(new Prisma.Decimal(it.unitPrice))),
            D(0),
          )
          .toDecimalPlaces(2);
        const cType = bordAvant.commissionType;
        const cVal = new Prisma.Decimal(bordAvant.commissionValue);
        const commission = cType === 'fixe' ? cVal.toDecimalPlaces(2) : totalBrut.times(cVal).dividedBy(100).toDecimalPlaces(2);
        const dm = bPatch.droitMarche ?? new Prisma.Decimal(bordAvant.droitMarche ?? 0);
        const tr = bPatch.transport ?? new Prisma.Decimal(bordAvant.transport ?? 0);
        bPatch.totalBrutVentes = totalBrut;
        bPatch.montantFinalDu = totalBrut
          .minus(commission)
          .minus(new Prisma.Decimal(bordAvant.avancesAffectees))
          .minus(dm)
          .minus(tr)
          .toDecimalPlaces(2);

        bordereau = await tx.supplierBordereau.update({ where: { id: bordAvant.id }, data: bPatch });
      }

      // ---- 4) Avance : annuler l'ancienne, recréer la nouvelle
      let advance: any = null;
      const avanceTouched = data.avanceMontant !== undefined || data.avanceOui !== undefined;
      if (avanceTouched) {
        const newMontant = data.avanceMontant !== undefined ? D(String(data.avanceMontant)) : new Prisma.Decimal(existing.avanceMontant);
        const wantAvance = data.avanceOui !== undefined ? !!data.avanceOui : newMontant.greaterThan(0);

        // Ancienne avance liée à cette réception (via notes / reference)
        const olds = await tx.supplierAdvance.findMany({
          where: {
            supplierId: existing.supplierId,
            deletedAt: null,
            notes: { contains: `réception ${existing.reference}` },
          },
        });
        for (const old of olds) {
          const alloc = new Prisma.Decimal(old.allocatedAmount ?? 0);
          if (alloc.greaterThan(0)) continue; // avance déjà affectée : on n'y touche pas
          const amt = new Prisma.Decimal(old.amount);
          await tx.supplierAdvance.update({ where: { id: old.id }, data: { deletedAt: new Date(), status: 'CANCELLED' } });
          await tx.supplierAccountEntry.updateMany({
            where: { supplierId: existing.supplierId, reference: old.reference, deletedAt: null },
            data: { deletedAt: new Date() },
          });
          await tx.supplier.update({
            where: { id: existing.supplierId },
            data: { balance: { increment: amt } },
          });
        }

        if (wantAvance && newMontant.greaterThan(0)) {
          const rows = await tx.supplierAdvance.findMany({ select: { reference: true } });
          let max = 0;
          for (const r of rows) {
            const m = /(\d+)\s*$/.exec(String(r.reference ?? ''));
            if (m) max = Math.max(max, parseInt(m[1], 10));
          }
          const refAV = `AV-${pad6(max + 1)}`;
          const now = new Date();
          advance = await tx.supplierAdvance.create({
            data: {
              supplierId: existing.supplierId,
              reference: refAV,
              amount: newMontant,
              advanceDate: now,
              status: 'DISPONIBLE',
              notes: `Avance sur réception ${existing.reference} (non_affectee)`,
              createdBy: userId,
            },
          });
          await tx.supplierAccountEntry.create({
            data: {
              supplierId: existing.supplierId,
              type: 'CREDIT',
              amount: newMontant,
              description: `AVANCE — réception ${existing.reference}`,
              reference: refAV,
              entryDate: now,
              createdBy: userId,
            },
          });
          await tx.supplier.update({
            where: { id: existing.supplierId },
            data: { balance: { decrement: newMontant } },
          });
        }
      }

      const finalReception = await tx.supplierReception.findUnique({ where: { id: existing.id } });
      const lot = finalReception?.lotId ? await tx.stockLot.findUnique({ where: { id: finalReception.lotId } }) : null;
      const recItems = await tx.supplierReceptionItem.findMany({
        where: { receptionId: existing.id, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });
      return { updated: finalReception ?? updated, bordereau, lot, advance, recItems };
    });

    return res.json({
      ...serialize(result.updated, result.bordereau ?? undefined, result.lot ?? undefined, result.advance ?? undefined),
      items: result.recItems.map((it: any) => ({
        id: it.id,
        calibre: it.calibre ?? null,
        nbrColis: dec(it.nbrColis),
        poidsEmballageVide: dec(it.poidsEmballageVide),
        lotId: it.lotId,
      })),
    });
  } catch (e: any) {
    if (e?.__handled) return res.status(httpStatus).json({ error: e.message });
    return res.status(500).json({ error: 'Erreur mise à jour réception', message: e?.message });
  }
});

// GET /api/supplier-receptions/:id/pdf — bon de réception PDF A5 bilingue
router.get('/:id/pdf', requirePermission('RECEPTION_WRITE'), async (req: Request, res: Response) => {
  try {
    const r = await prisma.supplierReception.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!r) return res.status(404).json({ error: 'Réception introuvable' });

    const [supplier, product, bordereau, lot, recItems] = await Promise.all([
      prisma.supplier.findUnique({ where: { id: r.supplierId } }),
      prisma.product.findUnique({ where: { id: r.productId } }),
      r.bordereauId ? prisma.supplierBordereau.findUnique({ where: { id: r.bordereauId } }) : null,
      r.lotId ? prisma.stockLot.findUnique({ where: { id: r.lotId } }) : null,
      prisma.supplierReceptionItem.findMany({ where: { receptionId: r.id, deletedAt: null }, orderBy: { createdAt: 'asc' } }),
    ]);
    const itemLots = recItems.length
      ? await prisma.stockLot.findMany({ where: { id: { in: recItems.map((i) => i.lotId).filter(Boolean) as string[] } } })
      : [];
    const lotMap = new Map(itemLots.map((l) => [l.id, l]));

    const company = await getCompanyParams();
    const barcodes = await buildEan13Only((r as any).ean13);
    const doc = buildReceptionPdf(
      {
        barcodes,
        reference: r.reference,
        date: r.date.toISOString(),
        heure: r.heure,
        supplierName: supplier?.name ?? '—',
        productName: product?.name ?? '—',
        nbrColis: dec(r.nbrColis) ?? '0',
        poidsEmballageVide: dec(r.poidsEmballageVide) ?? '0',
        avanceOui: r.avanceOui,
        avanceMontant: dec(r.avanceMontant) ?? '0',
        droitMarche: dec(r.droitMarche) ?? '0',
        transport: dec(r.transport) ?? '0',
        observations: r.observations,
        bordereauRef: bordereau?.reference ?? null,
        lotNumber: lot?.lotNumber ?? null,
        caliber: (lot as any)?.caliber ?? null,
        items: recItems.map((it) => ({
          calibre: it.calibre ?? null,
          nbrColis: dec(it.nbrColis) ?? '0',
          poidsEmballageVide: dec(it.poidsEmballageVide) ?? '0',
          lotNumber: it.lotId ? lotMap.get(it.lotId)?.lotNumber ?? null : null,
        })),
      },
      company,
    );

    const filename = `bon-reception-${r.reference}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    doc.pipe(res);
    doc.end();
  } catch (e: any) {
    console.error('[supplier-receptions] pdf error', e);
    if (!res.headersSent) res.status(500).json({ error: 'Erreur génération PDF', message: e?.message });
  }
});

export default router;
