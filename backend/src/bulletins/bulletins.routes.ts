// =====================================================================
// ROUTES BULLETINS D'ACHAT (Agent B.2 — SAISIE + MODÈLE + PDF + TEMPLATE)
// CRUD brouillon + lignes + PDF bilingue A4/A5 + template HTML.
// VALIDATION/stock = Agent B.3 (route /api/bulletins/:id/validate laissée
// à B.3). Calculs serveur en Decimal (jamais float).
// =====================================================================
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { requireAuth, requirePermission } from '../auth/middleware';
import { auditLog } from '../auth/audit';
import { serializeBulletin, serializeItem, dec } from './types';
import { buildBulletinPdf, CompanyParams } from './pdf';
import { renderBulletinHtml } from './template';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------
// Schémas de validation (zod)
// ---------------------------------------------------------------------
const decimal = z.union([z.string(), z.number()]).transform((v) => new Prisma.Decimal(v).toString());

const itemSchema = z.object({
  productId: z.string().min(1),
  marque: z.string().max(120).optional(),
  nbrColis: decimal.default('0'),
  poidsBrut: decimal.default('0'),
  tare: decimal.default('0'),
  // poidsNet et montant SONT calculés serveur ; s'ils sont fournis ils sont ignorés/recalculés.
  prixUnitaire: decimal.default('0'),
});

const createSchema = z.object({
  reference: z.string().min(1).max(60),
  supplierId: z.string().min(1),
  purchaseId: z.string().optional(),
  date: z.string().datetime().optional(),
  deliveredTo: z.string().max(160).optional(),
  marque: z.string().max(120).optional(),
  emballage: z.string().max(120).optional(),
  consigne: z.string().max(120).optional(),
  carrier: z.string().max(160).optional(),
  notes: z.string().max(2000).optional(),
  items: z.array(itemSchema).min(1, 'Au moins une ligne requise'),
});

const updateSchema = z.object({
  reference: z.string().min(1).max(60).optional(),
  date: z.string().datetime().optional(),
  deliveredTo: z.string().max(160).optional(),
  marque: z.string().max(120).optional(),
  emballage: z.string().max(120).optional(),
  consigne: z.string().max(120).optional(),
  carrier: z.string().max(160).optional(),
  notes: z.string().max(2000).optional(),
  items: z.array(itemSchema).min(1).optional(),
});

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/** Calcule une ligne : poidsNet = brut - tare ; montant = net * prix (Decimal). */
function computeItem(it: z.infer<typeof itemSchema>) {
  const brut = new Prisma.Decimal(it.poidsBrut);
  const tare = new Prisma.Decimal(it.tare);
  const net = brut.minus(tare); // Decimal
  const prix = new Prisma.Decimal(it.prixUnitaire);
  const montant = net.times(prix).toDecimalPlaces(2); // Decimal
  return {
    productId: it.productId,
    marque: it.marque ?? null,
    nbrColis: new Prisma.Decimal(it.nbrColis),
    poidsBrut: brut,
    tare: tare,
    poidsNet: net,
    prixUnitaire: prix,
    montant,
  };
}

/** Récupère les paramètres d'entreprise (CompanySettings) pour le PDF/template. */
async function getCompanyParams(): Promise<CompanyParams> {
  const cs = await prisma.companySettings.findFirst();
  if (!cs) return {};
  return {
    mandataireNameAr: cs.mandataireNameAr,
    mandataireNameFr: cs.mandataireNameFr,
    activity: cs.activity,
    market: cs.market,
    carreau: cs.carreau,
    mentionFr: cs.mentionFr,
    mentionAr: cs.mentionAr,
    companyName: cs.companyName,
  };
}

/** Charge un bulletin avec ses items + produits. */
async function loadBulletin(id: string) {
  return prisma.purchaseBulletin.findFirst({
    where: { id, deletedAt: null },
    include: { items: { where: { deletedAt: null }, include: { product: true } } },
  });
}

// ---------------------------------------------------------------------
// POST /api/bulletins  — création brouillon + lignes (calcul serveur)
// ---------------------------------------------------------------------
/**
 * @openapi
 * /api/bulletins:
 *   post:
 *     summary: Crée un bulletin d'achat (brouillon) avec ses lignes
 *     tags: [Bulletins]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reference, items]
 *             properties:
 *               reference: { type: string, example: "006196" }
 *               deliveredTo: { type: string }
 *               marque: { type: string }
 *               emballage: { type: string }
 *               consigne: { type: string }
 *               carrier: { type: string }
 *               notes: { type: string }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [productId]
 *                   properties:
 *                     productId: { type: string }
 *                     marque: { type: string }
 *                     nbrColis: { type: string }
 *                     poidsBrut: { type: string }
 *                     tare: { type: string }
 *                     prixUnitaire: { type: string }
 *     responses:
 *       201: { description: Bulletin créé (poidsNet + montant calculés serveur) }
 *       400: { description: Invalide }
 *       409: { description: Référence dupliquée }
 */
router.post('/', requirePermission('PURCHASE_WRITE'), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });

  const data = parsed.data;

  // Vérif produits existants
  const productIds = Array.from(new Set(data.items.map((i) => i.productId)));
  const products = await prisma.product.findMany({ where: { id: { in: productIds }, deletedAt: null }, select: { id: true } });
  if (products.length !== productIds.length) {
    return res.status(400).json({ error: 'Produit introuvable', details: 'Un ou plusieurs productId sont invalides' });
  }

  // Calcul des lignes + totaux (Decimal)
  const computed = data.items.map(computeItem);
  const totalWeight = computed.reduce((acc, c) => acc.plus(c.poidsNet), new Prisma.Decimal(0)).toDecimalPlaces(3);
  const totalAmount = computed.reduce((acc, c) => acc.plus(c.montant), new Prisma.Decimal(0)).toDecimalPlaces(2);

  try {
    const bulletin = await prisma.purchaseBulletin.create({
      data: {
        reference: data.reference,
        supplierId: data.supplierId,
        purchaseId: data.purchaseId ?? null,
        date: data.date ? new Date(data.date) : new Date(),
        status: 'DRAFT',
        deliveredTo: data.deliveredTo ?? null,
        marque: data.marque ?? null,
        emballage: data.emballage ?? null,
        consigne: data.consigne ?? null,
        carrier: data.carrier ?? null,
        notes: data.notes ?? null,
        totalWeight,
        totalAmount,
        createdBy: req.user!.id,
        updatedBy: req.user!.id,
        items: {
          create: computed.map((c) => ({
            productId: c.productId,
            marque: c.marque,
            nbrColis: c.nbrColis,
            poidsBrut: c.poidsBrut,
            tare: c.tare,
            poidsNet: c.poidsNet,
            prixUnitaire: c.prixUnitaire,
            montant: c.montant,
            createdBy: req.user!.id,
            updatedBy: req.user!.id,
          })),
        },
      },
      include: { items: { include: { product: true } } },
    });

    auditLog({ userId: req.user!.id, action: 'BULLETIN_CREATE', entity: 'PurchaseBulletin', entityId: bulletin.id, req }).catch(() => {});
    res.status(201).json(serializeBulletin(bulletin as any));
  } catch (e: any) {
    if (e?.code === 'P2002') return res.status(409).json({ error: 'Référence de bulletin déjà utilisée' });
    console.error('[bulletins] create error', e);
    res.status(500).json({ error: 'Erreur création bulletin' });
  }
});

// ---------------------------------------------------------------------
// GET /api/bulletins  — liste (brouillons + validés)
// ---------------------------------------------------------------------
/**
 * @openapi
 * /api/bulletins:
 *   get:
 *     summary: Liste des bulletins d'achat
 *     tags: [Bulletins]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Liste de bulletins }
 */
router.get('/', requirePermission('PURCHASE_READ'), async (_req, res) => {
  const list = await prisma.purchaseBulletin.findMany({
    where: { deletedAt: null },
    include: { items: { where: { deletedAt: null }, include: { product: true } } },
    orderBy: { date: 'desc' },
  });
  res.json(list.map((b) => serializeBulletin(b as any)));
});

// ---------------------------------------------------------------------
// GET /api/bulletins/:id — détail
// ---------------------------------------------------------------------
/**
 * @openapi
 * /api/bulletins/{id}:
 *   get:
 *     summary: Détail d'un bulletin d'achat (lignes + totaux)
 *     tags: [Bulletins]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: Bulletin }
 *       404: { description: Introuvable }
 */
router.get('/:id', requirePermission('PURCHASE_READ'), async (req, res) => {
  const b = await loadBulletin(req.params.id);
  if (!b) return res.status(404).json({ error: 'Bulletin introuvable' });
  res.json(serializeBulletin(b as any));
});

// ---------------------------------------------------------------------
// PUT /api/bulletins/:id — mise à jour brouillon (recalcul serveur)
// ---------------------------------------------------------------------
/**
 * @openapi
 * /api/bulletins/{id}:
 *   put:
 *     summary: Met à jour un bulletin (recalcul serveur des poids/montants)
 *     tags: [Bulletins]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: Bulletin mis à jour }
 *       404: { description: Introuvable }
 */
router.put('/:id', requirePermission('PURCHASE_WRITE'), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
  const b = await loadBulletin(req.params.id);
  if (!b) return res.status(404).json({ error: 'Bulletin introuvable' });

  const data = parsed.data;
  let itemsData: z.infer<typeof itemSchema>[] | null = null;
  let totalWeight = b.totalWeight;
  let totalAmount = b.totalAmount;

  if (data.items) {
    // Vérif produits
    const productIds = Array.from(new Set(data.items.map((i) => i.productId)));
    const products = await prisma.product.findMany({ where: { id: { in: productIds }, deletedAt: null }, select: { id: true } });
    if (products.length !== productIds.length) {
      return res.status(400).json({ error: 'Produit introuvable' });
    }
    const computed = data.items.map(computeItem);
    totalWeight = computed.reduce((acc, c) => acc.plus(c.poidsNet), new Prisma.Decimal(0)).toDecimalPlaces(3);
    totalAmount = computed.reduce((acc, c) => acc.plus(c.montant), new Prisma.Decimal(0)).toDecimalPlaces(2);
    itemsData = data.items;
    // Remplace les lignes
    await prisma.purchaseBulletinItem.deleteMany({ where: { bulletinId: b.id } });
  }

  const updated = await prisma.purchaseBulletin.update({
    where: { id: b.id },
    data: {
      reference: data.reference ?? b.reference,
      date: data.date ? new Date(data.date) : b.date,
      deliveredTo: data.deliveredTo ?? b.deliveredTo,
      marque: data.marque ?? b.marque,
      emballage: data.emballage ?? b.emballage,
      consigne: data.consigne ?? b.consigne,
      carrier: data.carrier ?? b.carrier,
      notes: data.notes ?? b.notes,
      totalWeight,
      totalAmount,
      updatedBy: req.user!.id,
      items: itemsData
        ? {
            create: itemsData.map((it) => {
              const c = computeItem(it);
              return {
                productId: c.productId,
                marque: c.marque,
                nbrColis: c.nbrColis,
                poidsBrut: c.poidsBrut,
                tare: c.tare,
                poidsNet: c.poidsNet,
                prixUnitaire: c.prixUnitaire,
                montant: c.montant,
                createdBy: req.user!.id,
                updatedBy: req.user!.id,
              };
            }),
          }
        : undefined,
    },
    include: { items: { include: { product: true } } },
  });

  res.json(serializeBulletin(updated as any));
});

// ---------------------------------------------------------------------
// GET /api/bulletins/:id/template — aperçu HTML bilingue (FR+AR, RTL)
// ---------------------------------------------------------------------
/**
 * @openapi
 * /api/bulletins/{id}/template:
 *   get:
 *     summary: Aperçu HTML bilingue du bulletin (FR + AR, RTL)
 *     tags: [Bulletins]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: HTML du bulletin }
 */
router.get('/:id/template', requirePermission('PURCHASE_READ'), async (req, res) => {
  const b = await loadBulletin(req.params.id);
  if (!b) return res.status(404).json({ error: 'Bulletin introuvable' });
  const company = await getCompanyParams();
  const html = renderBulletinHtml(serializeBulletin(b as any), company);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ---------------------------------------------------------------------
// GET /api/bulletins/:id/pdf — PDF bilingue A4/A5 paysage
// ---------------------------------------------------------------------
/**
 * @openapi
 * /api/bulletins/{id}/pdf:
 *   get:
 *     summary: Génère le PDF bilingue du bulletin (FR+AR, RTL)
 *     tags: [Bulletins]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: query, name: format, schema: { type: string, enum: [a4, a5] }, description: "Format (défaut a4)" }
 *     responses:
 *       200: { description: application/pdf }
 *       404: { description: Introuvable }
 */
router.get('/:id/pdf', requirePermission('PURCHASE_READ'), async (req, res) => {
  const b = await loadBulletin(req.params.id);
  if (!b) return res.status(404).json({ error: 'Bulletin introuvable' });

  const format = (req.query.format === 'a5' ? 'a5' : 'a4') as 'a4' | 'a5';
  const company = await getCompanyParams();
  const doc = buildBulletinPdf(serializeBulletin(b as any), company, format);

  const filename = `bulletin-${b.reference}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  doc.pipe(res);
  doc.end();
});

// ---------------------------------------------------------------------
// DELETE /api/bulletins/:id — soft delete
// ---------------------------------------------------------------------
/**
 * @openapi
 * /api/bulletins/{id}:
 *   delete:
 *     summary: Suppression logique d'un bulletin
 *     tags: [Bulletins]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: Supprimé }
 */
router.delete('/:id', requirePermission('PURCHASE_WRITE'), async (req, res) => {
  const b = await loadBulletin(req.params.id);
  if (!b) return res.status(404).json({ error: 'Bulletin introuvable' });
  await prisma.purchaseBulletin.update({ where: { id: b.id }, data: { deletedAt: new Date(), updatedBy: req.user!.id } });
  auditLog({ userId: req.user!.id, action: 'BULLETIN_DELETE', entity: 'PurchaseBulletin', entityId: b.id, req }).catch(() => {});
  res.json({ message: 'Bulletin supprimé (soft delete)' });
});

// =====================================================================
// VALIDATION + STOCK (Agent B.3)
// Un brouillon ne touche PAS le stock. La validation crée les StockLots,
// les mouvements IN, met à jour le solde fournisseur (DEBIT) et archive le PDF.
// Toute l'opération financière/stock est dans UNE prisma.$transaction.
// =====================================================================

// Numérotation §17 : séquence non réutilisée (préfixe LOT- année).
async function nextLotNumber(tx: Prisma.TransactionClient): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `LOT-${year}-`;
  const rows = await tx.$queryRawUnsafe<{ lotNumber: string }[]>(
    `SELECT "lotNumber" FROM "StockLot" WHERE "lotNumber" LIKE $1 ORDER BY "lotNumber" DESC LIMIT 1`,
    prefix + '%',
  );
  let next = 1;
  if (rows.length > 0) {
    const num = rows[0].lotNumber.slice(prefix.length).replace(/\D/g, '');
    next = parseInt(num || '0', 10) + 1;
  }
  return `${prefix}${String(next).padStart(4, '0')}`;
}

// POST /api/bulletins/:id/validate
router.post('/:id/validate', requirePermission('PURCHASE_WRITE'), async (req: Request, res: Response) => {
  const bulletinId = req.params.id;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const bulletin = await tx.purchaseBulletin.findUnique({
        where: { id: bulletinId },
        include: { items: { include: { product: { select: { id: true, unitId: true } } } } },
      });
      if (!bulletin) throw new Error('Bulletin introuvable');
      if (bulletin.status !== 'DRAFT') throw new Error(`Bulletin déjà ${bulletin.status} — seul un brouillon est validable`);
      if (!bulletin.items.length) throw new Error('Bulletin sans ligne');

      const purchase = bulletin.purchaseId ? await tx.purchase.findUnique({ where: { id: bulletin.purchaseId } }) : null;
      const supplierId = bulletin.supplierId;
      if (!supplierId) throw new Error('Bulletin sans fournisseur');

      let totalSupplierDebit = new Prisma.Decimal(0);

      for (const it of bulletin.items) {
        const poidsNet = new Prisma.Decimal(it.poidsNet);
        const prixUnit = new Prisma.Decimal(it.prixUnitaire);
        const montantLigne = poidsNet.times(prixUnit).toDecimalPlaces(2); // §11
        // coûtRéelLot = achat + transport + frais - remises (§22)
        const realCost = montantLigne
          .plus(new Prisma.Decimal(it.transportCost))
          .plus(new Prisma.Decimal(it.fees))
          .minus(new Prisma.Decimal(it.remises))
          .toDecimalPlaces(2);
        const unitCost = poidsNet.gt(0) ? realCost.div(poidsNet).toDecimalPlaces(2) : prixUnit.toDecimalPlaces(2);

        const lotNumber = await nextLotNumber(tx);
        const unit = it.product.unitId ? await tx.unit.findUnique({ where: { id: it.product.unitId }, select: { symbol: true } }) : null;

        await tx.stockLot.create({
          data: {
            lotNumber,
            productId: it.product.id,
            supplierId,
            bulletinId: bulletin.id,
            quantity: poidsNet,
            remainingQuantity: poidsNet, // AUGMENTE le stock dispo
            unitCost,
            purchasePrice: prixUnit,
            realCost,
            arrivalDate: bulletin.date,
            unitSymbol: unit?.symbol ?? null,
            grossWeight: new Prisma.Decimal(it.poidsBrut),
            tare: new Prisma.Decimal(it.tare),
            netWeight: poidsNet,
            origin: it.origine,
            quality: it.qualite,
            caliber: it.calibre,
            createdBy: req.user!.id,
            updatedBy: req.user!.id,
          },
        });

        // Mouvement IN (entrée stock)
        await tx.stockMovement.create({
          data: {
            productId: it.product.id,
            type: 'IN',
            quantity: poidsNet,
            reference: bulletin.reference,
            reason: `Réception bulletin ${bulletin.reference} (lot ${lotNumber})`,
            createdBy: req.user!.id,
            updatedBy: req.user!.id,
          },
        });

        totalSupplierDebit = totalSupplierDebit.plus(realCost);
      }

      // MAJ solde fournisseur (DEBIT = on doit au fournisseur)
      const supplier = await tx.supplier.findUnique({ where: { id: supplierId } });
      if (!supplier) throw new Error('Fournisseur introuvable');
      const newBalance = new Prisma.Decimal(supplier.balance).plus(totalSupplierDebit).toDecimalPlaces(2);
      await tx.supplier.update({ where: { id: supplierId }, data: { balance: newBalance, updatedBy: req.user!.id } });
      await tx.supplierAccountEntry.create({
        data: {
          supplierId,
          type: 'DEBIT',
          amount: totalSupplierDebit.toDecimalPlaces(2),
          description: `Réception bulletin ${bulletin.reference}`,
          reference: bulletin.reference,
          entryDate: new Date(),
          createdBy: req.user!.id,
          updatedBy: req.user!.id,
        },
      });

      const validated = await tx.purchaseBulletin.update({
        where: { id: bulletin.id },
        data: { status: 'VALIDATED', validatedAt: new Date() },
      });

      return {
        bulletinId: bulletin.id,
        reference: bulletin.reference,
        supplierId,
        totalSupplierDebit: totalSupplierDebit.toDecimalPlaces(2),
        newBalance,
        status: validated.status,
      };
    });

    // Hors transaction : archivage PDF (non bloquant pour le stock).
    let pdfPath: string | null = null;
    try {
      const { generateAndSaveBulletinPdf } = await import('../services/bulletinPdf');
      pdfPath = await generateAndSaveBulletinPdf(bulletinId);
      await prisma.purchaseBulletin.update({ where: { id: bulletinId }, data: { archivedPdfPath: pdfPath } });
    } catch (pdfErr: any) {
      console.warn('[bulletin pdf] archivage échoué (non bloquant):', pdfErr?.message);
    }

    auditLog({
      userId: req.user!.id,
      action: 'BULLETIN_VALIDATE',
      entity: 'PurchaseBulletin',
      entityId: bulletinId,
      details: { reference: result.reference, totalSupplierDebit: result.totalSupplierDebit.toString(), pdfPath },
      req,
    }).catch(() => {});

    res.json({
      ...result,
      totalSupplierDebit: dec(result.totalSupplierDebit),
      newBalance: dec(result.newBalance),
      archivedPdfPath: pdfPath,
    });
  } catch (e: any) {
    console.error('[bulletin validate]', e);
    const status = /introuvable|déjà|sans fournisseur|brouillon|sans ligne/.test(e?.message) ? 400 : 500;
    res.status(status).json({ error: 'Échec validation', message: e?.message });
  }
});

// POST /api/bulletins/:id/cancel — annulation d'un VALIDATED (écritures inverses)
router.post('/:id/cancel', requirePermission('PURCHASE_WRITE'), async (req: Request, res: Response) => {
  const bulletinId = req.params.id;
  const reason = (req.body?.reason as string) || 'Annulation bulletin';
  try {
    const result = await prisma.$transaction(async (tx) => {
      const bulletin = await tx.purchaseBulletin.findUnique({ where: { id: bulletinId }, include: { items: true } });
      if (!bulletin) throw new Error('Bulletin introuvable');
      if (bulletin.status !== 'VALIDATED') throw new Error(`Seul un bulletin VALIDATED peut être annulé (actuel: ${bulletin.status})`);

      const purchase = bulletin.purchaseId ? await tx.purchase.findUnique({ where: { id: bulletin.purchaseId } }) : null;
      if (!purchase || !purchase.supplierId) throw new Error('Bulletin sans fournisseur');
      const supplierId = purchase.supplierId;

      const lots = await tx.stockLot.findMany({ where: { bulletinId: bulletin.id, deletedAt: null } });
      if (!lots.length) throw new Error('Aucun lot à annuler pour ce bulletin');

      let totalOut = new Prisma.Decimal(0);
      for (const lot of lots) {
        const remaining = new Prisma.Decimal(lot.remainingQuantity);
        if (remaining.lessThan(0)) throw new Error('Stock lot négatif détecté');
        if (remaining.gt(0)) {
          // Mouvement OUT (sortie stock) pour la qté restante
          await tx.stockMovement.create({
            data: {
              productId: lot.productId,
              lotId: lot.id,
              type: 'OUT',
              quantity: remaining,
              reference: bulletin.reference,
              reason: `Annulation bulletin ${bulletin.reference} (lot ${lot.lotNumber})`,
              createdBy: req.user!.id,
              updatedBy: req.user!.id,
            },
          });
          // Le lot repasse à 0 et est archivé (jamais négatif)
          await tx.stockLot.update({ where: { id: lot.id }, data: { remainingQuantity: new Prisma.Decimal(0), deletedAt: new Date(), updatedBy: req.user!.id } });
          // Remboursement fournisseur = coût réel * qté restante
          const refund = new Prisma.Decimal(lot.unitCost).times(remaining).toDecimalPlaces(2);
          totalOut = totalOut.plus(refund);
        }
      }

      // Rembourse le solde fournisseur (CRÉDIT = on doit moins)
      const supplier = await tx.supplier.findUnique({ where: { id: supplierId } });
      if (!supplier) throw new Error('Fournisseur introuvable');
      const newBalance = new Prisma.Decimal(supplier.balance).minus(totalOut).toDecimalPlaces(2);
      await tx.supplier.update({ where: { id: supplierId }, data: { balance: newBalance, updatedBy: req.user!.id } });
      await tx.supplierAccountEntry.create({
        data: {
          supplierId,
          type: 'CREDIT',
          amount: totalOut.toDecimalPlaces(2),
          description: `Annulation bulletin ${bulletin.reference}`,
          reference: bulletin.reference,
          entryDate: new Date(),
          createdBy: req.user!.id,
          updatedBy: req.user!.id,
        },
      });

      const cancelled = await tx.purchaseBulletin.update({ where: { id: bulletin.id }, data: { status: 'CANCELLED' } });

      return { bulletinId: bulletin.id, reference: bulletin.reference, supplierId, refundedToSupplier: totalOut.toDecimalPlaces(2), newBalance, status: cancelled.status, reason };
    });

    auditLog({
      userId: req.user!.id,
      action: 'BULLETIN_CANCEL',
      entity: 'PurchaseBulletin',
      entityId: bulletinId,
      details: { reference: result.reference, refundedToSupplier: result.refundedToSupplier.toString() },
      req,
    }).catch(() => {});

    res.json({ ...result, refundedToSupplier: dec(result.refundedToSupplier), newBalance: dec(result.newBalance) });
  } catch (e: any) {
    console.error('[bulletin cancel]', e);
    const status = /introuvable|Seul|sans fournisseur|Aucun lot/.test(e?.message) ? 400 : 500;
    res.status(status).json({ error: 'Échec annulation', message: e?.message });
  }
});

export default router;
