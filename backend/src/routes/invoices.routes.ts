// =====================================================================
// ROUTES FACTURES DE VENTE (Phase C) — CRUD + émission + PDF bilingue.
// Réutilise l'helper PDF bilingue B.2 (src/invoices/pdf -> buildInvoicePdf).
// Calculs serveur en Decimal (jamais float). Tout handler try/catch -> JSON.
// =====================================================================
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { requireAuth, requirePermission } from '../auth/middleware';
import { auditLog } from '../auth/audit';
import { dec } from './_helpers';
import { buildInvoicePdf, InvoiceDTO, InvoiceItemDTO } from '../invoices/pdf';
import { nextEan13, EAN_PREFIX, buildEan13Only } from '../barcode';
import type { CompanyParams } from '../invoices/pdf';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------
// Schémas de validation (zod)
// ---------------------------------------------------------------------
const decimal = z.union([z.string(), z.number()]).transform((v) => new Prisma.Decimal(v).toString());

// Ligne de facture : fournie directement OU générée depuis la vente (Sale).
const itemSchema = z.object({
  description: z.string().min(1, 'Désignation requise'),
  productId: z.string().optional(),
  lotId: z.string().optional(),
  quantity: decimal.default('1'),
  unitPrice: decimal.default('0'),
  // Prix d'emballage par colis (saisi à la main par ligne).
  packingUnitPrice: decimal.default('0'),
  // Champs bulletin de vente (grossiste) : Colis / Brut / Tare / Net.
  colis: decimal.optional(),
  grossWeight: decimal.optional(),
  tare: decimal.optional(),
  netWeight: decimal.optional(),
});

const createSchema = z.object({
  customerId: z.string().optional(),
  // Auto-client silencieux : si fourni et customerId inconnu, on crée le client.
  customerName: z.string().optional(),
  saleId: z.string().optional(),
  issueDate: z.string().datetime().optional(),
  dueDate: z.string().datetime().optional(),
  notes: z.string().max(2000).optional(),
  packingReturned: z.boolean().optional(),
  // Soit items fournis explicitement, soit saleId génère les lignes.
  items: z.array(itemSchema).optional(),
});

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

/** Génère les lignes de facture depuis une vente (Sale.items). */
async function itemsFromSale(saleId: string): Promise<{ items: { description: string; productId?: string; lotId?: string | null; quantity: Prisma.Decimal; unitPrice: Prisma.Decimal; total: Prisma.Decimal; colis: Prisma.Decimal; grossWeight: Prisma.Decimal; tare: Prisma.Decimal; netWeight: Prisma.Decimal }[]; subtotal: Prisma.Decimal; taxAmount: Prisma.Decimal }> {
  const sale = await prisma.sale.findFirst({
    where: { id: saleId, deletedAt: null },
    include: { items: { where: { deletedAt: null }, include: { product: true } } },
  });
  if (!sale) throw new Error('Vente introuvable');
  const items = sale.items.map((it) => {
    const q = new Prisma.Decimal(it.quantity);
    const pu = new Prisma.Decimal(it.unitPrice);
    const total = q.times(pu).toDecimalPlaces(2);
    return {
      description: it.product?.name ?? 'Article',
      productId: it.productId,
      lotId: (it as any).lotId ?? null,
      quantity: q,
      unitPrice: pu,
      total,
      // Recopie des champs bulletin de vente depuis SaleItem.
      colis: new Prisma.Decimal((it as any).colis ?? 0),
      grossWeight: new Prisma.Decimal((it as any).grossWeight ?? 0),
      tare: new Prisma.Decimal((it as any).tare ?? 0),
      netWeight: new Prisma.Decimal((it as any).netWeight ?? 0),
    };
  });
  const subtotal = items.reduce((acc, c) => acc.plus(c.total), new Prisma.Decimal(0)).toDecimalPlaces(2);
  return { items, subtotal, taxAmount: new Prisma.Decimal(0) };
}

/** Calcule les totaux à partir des lignes (Decimal). */
function computeTotals(items: { quantity: Prisma.Decimal; unitPrice: Prisma.Decimal; total: Prisma.Decimal; packingUnitPrice?: Prisma.Decimal; colis?: Prisma.Decimal }[]) {
  const subtotal = items.reduce((acc, c) => acc.plus(c.total), new Prisma.Decimal(0)).toDecimalPlaces(2);
  const taxAmount = new Prisma.Decimal(0);
  const packingTotal = items
    .reduce((acc, c) => acc.plus(new Prisma.Decimal(c.packingUnitPrice ?? 0).times(new Prisma.Decimal(c.colis ?? 0))), new Prisma.Decimal(0))
    .toDecimalPlaces(2);
  const total = subtotal.plus(taxAmount).plus(packingTotal).toDecimalPlaces(2);
  return { subtotal, taxAmount, packingTotal, total };
}

/** Numérotation F-2026-0001 (séquence annuelle non réutilisée). */
async function nextInvoiceReference(tx: Prisma.TransactionClient): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `F-${year}-`;
  const rows = await tx.$queryRawUnsafe<{ reference: string }[]>(
    `SELECT "reference" FROM "Invoice" WHERE "reference" LIKE $1 ORDER BY "reference" DESC LIMIT 1`,
    prefix + '%',
  );
  let next = 1;
  if (rows.length > 0) {
    const num = rows[0].reference.slice(prefix.length).replace(/\D/g, '');
    next = parseInt(num || '0', 10) + 1;
  }
  return `${prefix}${String(next).padStart(4, '0')}`;
}

async function loadInvoice(id: string) {
  return prisma.invoice.findFirst({
    where: { id, deletedAt: null },
    include: {
      items: { where: { deletedAt: null }, include: { lot: true } },
      customer: true,
      sale: { include: { items: { include: { product: true } } } },
      payments: { where: { deletedAt: null } },
    },
  });
}

function serializeInvoice(inv: any): InvoiceDTO & { packingTotal: string; packingReturned: boolean } {
  return {
    id: inv.id,
    reference: inv.reference,
    saleId: inv.saleId ?? null,
    createdAt: inv.createdAt ? inv.createdAt.toISOString() : null,
    issueDate: inv.issueDate ? inv.issueDate.toISOString() : null,
    dueDate: inv.dueDate ? inv.dueDate.toISOString() : null,
    status: inv.status,
    subtotal: dec(inv.subtotal)!,
    taxAmount: dec(inv.taxAmount)!,
    packingTotal: dec(inv.packingTotal)!,
    packingReturned: !!inv.packingReturned,
    total: dec(inv.total)!,
    paidAmount: dec(
      (inv.payments ?? []).reduce(
        (acc: any, p: any) => acc.plus(new Prisma.Decimal(p.amount ?? 0)),
        new Prisma.Decimal(0),
      ),
    )!,
    remaining: dec(
      new Prisma.Decimal(inv.total ?? 0).minus(
        (inv.payments ?? []).reduce(
          (acc: any, p: any) => acc.plus(new Prisma.Decimal(p.amount ?? 0)),
          new Prisma.Decimal(0),
        ),
      ),
    )!,
    notes: inv.notes,
    customer: inv.customer
      ? {
          name: inv.customer.name,
          nameAr: inv.customer.nameAr,
          address: inv.customer.address,
          taxId: inv.customer.nif,
          phone: inv.customer.phone,
        }
      : null,
    items: (inv.items ?? []).map((it: any) => ({
      id: it.id,
      description: it.description,
      lotId: it.lotId ?? null,
      caliber: it.lot?.caliber ?? null,
      quantity: dec(it.quantity)!,
      unitPrice: dec(it.unitPrice)!,
      total: dec(it.total)!,
      packingUnitPrice: dec(it.packingUnitPrice),
      colis: dec(it.colis),
      grossWeight: dec(it.grossWeight),
      tare: dec(it.tare),
      netWeight: dec(it.netWeight),
    })),
    payments: (inv.payments ?? []).map((p: any) => ({
      id: p.id,
      reference: p.reference,
      amount: dec(p.amount),
      method: p.method,
      paymentDate: p.paymentDate ? p.paymentDate.toISOString() : null,
      notes: p.notes ?? null,
      saleId: p.saleId ?? null,
    })),
  };
}

// ---------------------------------------------------------------------
// POST /api/invoices — crée une facture (DRAFT)
// ---------------------------------------------------------------------
/**
 * @openapi
 * /api/invoices:
 *   post:
 *     summary: Crée une facture de vente (brouillon) avec ses lignes
 *     tags: [Invoices]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [customerId]
 *             properties:
 *               customerId: { type: string }
 *               saleId: { type: string, description: "Si fourni, génère les lignes depuis Sale.items" }
 *               issueDate: { type: string, format: date-time }
 *               dueDate: { type: string, format: date-time }
 *               notes: { type: string }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [description]
 *                   properties:
 *                     description: { type: string }
 *                     productId: { type: string }
 *                     quantity: { type: string }
 *                     unitPrice: { type: string }
 *     responses:
 *       201: { description: Facture créée }
 *       400: { description: Invalide }
 *       404: { description: Vente/client introuvable }
 */
router.post('/', requirePermission('INVOICE_WRITE'), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });

  const data = parsed.data;
  try {
    // Idempotence : si une facture existe déjà pour cette vente (saleId),
    // on la renvoie au lieu d'en créer une doublon (évite les factures en
    // double quand le front clique Imprimer/Encaisser plusieurs fois).
    if (data.saleId) {
      const existing = await prisma.invoice.findFirst({
        where: { saleId: data.saleId, deletedAt: null },
        include: { items: { where: { deletedAt: null } }, customer: true },
      });
      if (existing) {
        return res.status(200).json({ ...serializeInvoice(existing as any), duplicate: true });
      }
    }

    // Si saleId fourni sans customerId, on reprend le client de la vente.
    let customerId = data.customerId;
    if (!customerId && data.saleId) {
      const sale = await prisma.sale.findFirst({ where: { id: data.saleId, deletedAt: null }, select: { customerId: true } });
      customerId = sale?.customerId ?? undefined;
    }
    // Vérif client (optionnel si vente sans client)
    let customer = null as null | { id: string; deletedAt: Date | null };
    if (customerId) {
      customer = await prisma.customer.findUnique({ where: { id: customerId } });
      if (!customer || customer.deletedAt) customer = null;
    }
    // AUTO-CLIENT SILENCIEUX : si customerName fourni mais aucun client valide
    // n'a été résolu, on crée (ou réutilise par nom) un Customer et on le lie.
    if (!customer && data.customerName && data.customerName.trim()) {
      const name = data.customerName.trim();
      const existingByName = await prisma.customer.findFirst({ where: { name, deletedAt: null } });
      if (existingByName) {
        customer = existingByName;
        customerId = existingByName.id;
      } else {
        const created = await prisma.customer.create({
          data: { name, phone: '—', createdBy: req.user!.id, updatedBy: req.user!.id },
        });
        customer = created;
        customerId = created.id;
      }
    }

    // Lignes : explicites OU générées depuis la vente
    let lineItems: { description: string; productId?: string; lotId?: string | null; quantity: Prisma.Decimal; unitPrice: Prisma.Decimal; total: Prisma.Decimal; packingUnitPrice?: Prisma.Decimal; colis?: Prisma.Decimal; grossWeight?: Prisma.Decimal; tare?: Prisma.Decimal; netWeight?: Prisma.Decimal }[];
    if (data.saleId) {
      const fromSale = await itemsFromSale(data.saleId);
      lineItems = fromSale.items;
      if (lineItems.length === 0) return res.status(400).json({ error: 'La vente liée ne contient aucune ligne' });
    } else if (data.items && data.items.length > 0) {
      lineItems = data.items.map((it) => {
        const q = new Prisma.Decimal(it.quantity);
        const pu = new Prisma.Decimal(it.unitPrice);
        return {
          description: it.description,
          productId: it.productId,
          lotId: it.lotId ?? null,
          quantity: q,
          unitPrice: pu,
          total: q.times(pu).toDecimalPlaces(2),
          packingUnitPrice: it.packingUnitPrice !== undefined ? new Prisma.Decimal(it.packingUnitPrice) : new Prisma.Decimal(0),
          colis: it.colis !== undefined ? new Prisma.Decimal(it.colis) : undefined,
          grossWeight: it.grossWeight !== undefined ? new Prisma.Decimal(it.grossWeight) : undefined,
          tare: it.tare !== undefined ? new Prisma.Decimal(it.tare) : undefined,
          netWeight: it.netWeight !== undefined ? new Prisma.Decimal(it.netWeight) : undefined,
        };
      });
    } else {
      return res.status(400).json({ error: 'Fournissez soit items, soit un saleId valide' });
    }

    // Sécurité lotId : si une vente est liée, le lotId du SaleItem prime
    // toujours quand la ligne n'en a pas (évite de perdre le lien bordereau
    // lors d'une recréation de facture avec items explicites).
    if (data.saleId) {
      const saleItems = await prisma.saleItem.findMany({ where: { saleId: data.saleId, deletedAt: null } });
      const lotByProduct = new Map<string, string>();
      for (const si of saleItems) {
        if ((si as any).lotId && si.productId) lotByProduct.set(si.productId, (si as any).lotId);
      }
      for (const li of lineItems) {
        if (!li.lotId && li.productId) li.lotId = lotByProduct.get(li.productId) ?? null;
      }
    }

    const { subtotal, taxAmount, packingTotal, total } = computeTotals(lineItems);
    const reference = await nextInvoiceReference(prisma);

    const invoice = await prisma.$transaction(async (tx) => {
      // Code-barres EAN13 (préfixe 2 = facture), généré automatiquement.
      const ean13 = await nextEan13(tx, 'invoice', EAN_PREFIX.invoice);
      const created = await tx.invoice.create({
        data: {
          reference,
          ean13,
          customerId: customerId ?? null,
          saleId: data.saleId ?? null,
          issueDate: data.issueDate ? new Date(data.issueDate) : new Date(),
          dueDate: data.dueDate ? new Date(data.dueDate) : null,
          status: 'DRAFT',
          subtotal,
          taxAmount,
          packingTotal,
          packingReturned: data.packingReturned ?? false,
          total,
          notes: data.notes ?? null,
          createdBy: req.user!.id,
          updatedBy: req.user!.id,
          items: {
            create: lineItems.map((it) => ({
              description: it.description,
              productId: it.productId ?? null,
              lotId: it.lotId ?? null,
              quantity: it.quantity,
              unitPrice: it.unitPrice,
              total: it.total,
              packingUnitPrice: it.packingUnitPrice ?? new Prisma.Decimal(0),
              colis: it.colis ?? new Prisma.Decimal(0),
              grossWeight: it.grossWeight ?? new Prisma.Decimal(0),
              tare: it.tare ?? new Prisma.Decimal(0),
              netWeight: it.netWeight ?? new Prisma.Decimal(0),
              createdBy: req.user!.id,
              updatedBy: req.user!.id,
            })),
          },
        },
        include: { items: { where: { deletedAt: null } }, customer: true },
      });

      // ---- Alimentation automatique du bordereau fournisseur (Étape 2) ----
      // Pour chaque ligne reliée à un lot : incrémente colisVendus / poidsNetVendu /
      // totalBrutVentes du SupplierBordereau, crée un StockMovement OUT (tracage
      // de la ligne vers le lot), et met le statut à jour.
      // NOTE: le stock (remainingQuantity) est décrémenté UNE SEULE FOIS par
      // confirmSale (sortie FIFO). On ne le touche PAS ici pour éviter la double
      // sortie de stock.
      for (const li of lineItems) {
        if (!li.lotId) continue;
        const lot = await tx.stockLot.findFirst({ where: { id: li.lotId, deletedAt: null } });
        if (!lot) continue;
        const colis = li.colis ?? new Prisma.Decimal(0);
        const netWeight = li.netWeight ?? new Prisma.Decimal(0);
        const montant = netWeight.times(li.unitPrice).toDecimalPlaces(2);

        const bordereau = (lot as any).bordereauId
          ? await tx.supplierBordereau.findFirst({ where: { id: (lot as any).bordereauId, deletedAt: null } })
          : await tx.supplierBordereau.findFirst({ where: { lotId: li.lotId, deletedAt: null } });
        if (bordereau) {
          const newColisVendus = new Prisma.Decimal(bordereau.colisVendus).plus(colis).toDecimalPlaces(3);
          const colisRecus = new Prisma.Decimal(bordereau.colisRecus);
          // Pertes agrégées sur TOUS les lots du bordereau (multi-calibres)
          const bordLots = await tx.stockLot.findMany({ where: { bordereauId: bordereau.id, deletedAt: null }, select: { id: true } });
          const lotIdSet = new Set<string>(bordLots.map((l) => l.id));
          if (bordereau.lotId) lotIdSet.add(bordereau.lotId);
          const pertesAgg = await tx.loss.aggregate({ _sum: { quantity: true }, where: { lotId: { in: Array.from(lotIdSet) }, deletedAt: null } });
          const totalPertesColisDuLot = new Prisma.Decimal(pertesAgg._sum.quantity ?? 0);
          const newColisRestant = colisRecus.minus(newColisVendus).minus(totalPertesColisDuLot).toDecimalPlaces(3);
          const newPoidsNetVendu = new Prisma.Decimal(bordereau.poidsNetVendu).plus(netWeight).toDecimalPlaces(3);
          const newTotalBrutVentes = new Prisma.Decimal(bordereau.totalBrutVentes).plus(montant).toDecimalPlaces(2);
          const newStatut = newColisVendus.gte(colisRecus) ? 'pret_a_cloturer' : 'ouvert';
          await tx.supplierBordereau.update({
            where: { id: bordereau.id },
            data: {
              colisVendus: newColisVendus,
              colisRestant: newColisRestant,
              poidsNetVendu: newPoidsNetVendu,
              totalBrutVentes: newTotalBrutVentes,
              statut: newStatut,
            },
          });
        }

        // Mouvement de stock OUT (tracage uniquement — ne modifie PAS
        // remainingQuantity, qui est géré par confirmSale en FIFO).
        await tx.stockMovement.create({
          data: {
            productId: lot.productId,
            lotId: lot.id,
            type: 'OUT',
            quantity: colis,
            reference: created.reference,
            reason: `Vente facturée ${created.reference}`,
            createdBy: req.user!.id,
            updatedBy: req.user!.id,
          },
        });
      }

      return created;
    });

    auditLog({ userId: req.user!.id, action: 'INVOICE_CREATE', entity: 'Invoice', entityId: invoice.id, req }).catch(() => {});
    res.status(201).json(serializeInvoice(invoice as any));
  } catch (e: any) {
    if (e?.code === 'P2002') return res.status(409).json({ error: 'Référence de facture déjà utilisée' });
    console.error('[invoices] create error', e);
    res.status(500).json({ error: 'Erreur création facture', details: e?.message });
  }
});

// ---------------------------------------------------------------------
// POST /api/invoices/:id/issue — émet la facture (ISSUED)
// ---------------------------------------------------------------------
/**
 * @openapi
 * /api/invoices/{id}/issue:
 *   post:
 *     summary: Émet la facture (passe DRAFT -> ISSUED)
 *     tags: [Invoices]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: Facture émise }
 *       409: { description: Déjà payée/annulée }
 *       404: { description: Introuvable }
 */
router.post('/:id/issue', requirePermission('INVOICE_WRITE'), async (req: Request, res: Response) => {
  try {
    const inv = await loadInvoice(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Facture introuvable' });
    if (inv.status === 'PAID' || inv.status === 'CANCELLED') {
      return res.status(409).json({ error: `Facture déjà ${inv.status} — émission impossible` });
    }
    // Émission = la dette client augmente du montant de la facture.
    if (inv.customerId) {
      const total = new Prisma.Decimal(inv.total);
      await prisma.customer.update({
        where: { id: inv.customerId },
        data: { balance: { increment: total } },
      });
    }
    const updated = await prisma.invoice.update({
      where: { id: inv.id },
      data: { status: 'SENT', issueDate: new Date(), updatedBy: req.user!.id },
      include: { items: { where: { deletedAt: null } }, customer: true },
    });
    auditLog({ userId: req.user!.id, action: 'INVOICE_ISSUE', entity: 'Invoice', entityId: inv.id, req }).catch(() => {});
    res.json(serializeInvoice(updated as any));
  } catch (e: any) {
    console.error('[invoices] issue error', e);
    res.status(500).json({ error: 'Erreur émission facture', details: e?.message });
  }
});

// ---------------------------------------------------------------------
// GET /api/invoices — liste (items, total) + customer + sale
// ---------------------------------------------------------------------
/**
 * @openapi
 * /api/invoices:
 *   get:
 *     summary: Liste des factures de vente
 *     tags: [Invoices]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Liste de factures }
 */
router.get('/', requirePermission('INVOICE_READ'), async (_req, res) => {
  try {
    const list = await prisma.invoice.findMany({
      where: { deletedAt: null },
      include: {
        items: { where: { deletedAt: null }, include: { lot: true } },
        customer: true,
        sale: true,
        // Nécessaire pour que serializeInvoice calcule paidAmount/remaining correctement.
        payments: { where: { deletedAt: null } },
      },
      orderBy: { issueDate: 'desc' },
    });
    res.json(list.map((b) => serializeInvoice(b as any)));
  } catch (e: any) {
    console.error('[invoices] list error', e);
    res.status(500).json({ error: 'Erreur liste factures' });
  }
});

// ---------------------------------------------------------------------
// GET /api/invoices/:id — détail
// ---------------------------------------------------------------------
/**
 * @openapi
 * /api/invoices/{id}:
 *   get:
 *     summary: Détail d'une facture (lignes + totaux)
 *     tags: [Invoices]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: Facture }
 *       404: { description: Introuvable }
 */
router.get('/:id', requirePermission('INVOICE_READ'), async (req, res) => {
  try {
    const inv = await loadInvoice(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Facture introuvable' });
    res.json(serializeInvoice(inv as any));
  } catch (e: any) {
    console.error('[invoices] get error', e);
    res.status(500).json({ error: 'Erreur lecture facture' });
  }
});

// ---------------------------------------------------------------------
// PATCH /api/invoices/:id — modification des lignes + totaux
// ---------------------------------------------------------------------
const updateSchema = z.object({
  issueDate: z.string().optional(),
  notes: z.string().optional(),
  packingReturned: z.boolean().optional(),
  items: z
    .array(
      z.object({
        id: z.string().optional(),
        description: z.string().optional(),
        productId: z.string().nullish(),
        lotId: z.string().nullish(),
        quantity: z.union([z.string(), z.number()]),
        unitPrice: z.union([z.string(), z.number()]),
        packingUnitPrice: z.union([z.string(), z.number()]).optional(),
        colis: z.union([z.string(), z.number()]).optional(),
        grossWeight: z.union([z.string(), z.number()]).optional(),
        tare: z.union([z.string(), z.number()]).optional(),
        netWeight: z.union([z.string(), z.number()]).optional(),
      }),
    )
    .optional(),
});

router.patch('/:id', requirePermission('INVOICE_WRITE'), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
  const { issueDate, notes, packingReturned, items } = parsed.data;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const inv = await tx.invoice.findUnique({ where: { id: req.params.id } });
      if (!inv || inv.deletedAt) {
        const e: any = new Error('Facture introuvable'); e.code = 'NOT_FOUND'; throw e;
      }
      // VERROU FACTURE PAYÉE : une facture soldée (restant = 0) n'est plus
      // modifiable (ni édition de ligne, ni ajout d'article).
      if (inv.status === 'PAID') {
        const e: any = new Error('Facture payée — verrouillée'); e.code = 'LOCKED'; throw e;
      }
      const data: any = {};
      if (issueDate) data.issueDate = new Date(issueDate);
      if (notes !== undefined) data.notes = notes;
      if (packingReturned !== undefined) data.packingReturned = packingReturned;
      if (items && items.length) {
        // -----------------------------------------------------------------
        // PRÉSERVATION DU lotId (bordereau fournisseur) : quand on remplace
        // les lignes (soft-delete + recréation), le front n'envoie souvent
        // pas de lotId -> le nouvel InvoiceItem perdait son lotId et le
        // tableau des ventes du bordereau devenait vide. On reconstruit donc
        // des maps de secours : ancien InvoiceItem (par id et par productId)
        // et SaleItem de la vente liée (par productId), et on réinjecte.
        // -----------------------------------------------------------------
        const oldItems = await tx.invoiceItem.findMany({ where: { invoiceId: inv.id, deletedAt: null } });
        const lotByOldId = new Map<string, string>();
        const lotByProduct = new Map<string, string>();
        for (const oi of oldItems) {
          if ((oi as any).lotId) {
            lotByOldId.set(oi.id, (oi as any).lotId);
            if (oi.productId) lotByProduct.set(oi.productId, (oi as any).lotId);
          }
        }
        if (inv.saleId) {
          const saleItems = await tx.saleItem.findMany({ where: { saleId: inv.saleId, deletedAt: null } });
          for (const si of saleItems) {
            if ((si as any).lotId && si.productId && !lotByProduct.has(si.productId)) {
              lotByProduct.set(si.productId, (si as any).lotId);
            }
          }
        }
        const lineItems = items.map((it, idx) => {
          const q = new Prisma.Decimal(it.quantity);
          const pu = new Prisma.Decimal(it.unitPrice);
          // Recalcul du poids net : Net = Brut − (Tare × Colis) si les champs
          // bulletin sont fournis, sinon on garde le quantity envoyé.
          const colis = it.colis !== undefined ? new Prisma.Decimal(it.colis) : undefined;
          const grossWeight = it.grossWeight !== undefined ? new Prisma.Decimal(it.grossWeight) : undefined;
          const tare = it.tare !== undefined ? new Prisma.Decimal(it.tare) : undefined;
          const packingUnitPrice = it.packingUnitPrice !== undefined ? new Prisma.Decimal(it.packingUnitPrice) : new Prisma.Decimal(0);
          let netWeight: Prisma.Decimal;
          if (grossWeight !== undefined && tare !== undefined && colis !== undefined) {
            netWeight = grossWeight.minus(tare.times(colis));
          } else {
            netWeight = q;
          }
          // Réinjection du lotId : explicite > ancien item (par id) > SaleItem/
          // ancien item par productId > ancien item au même index.
          const lotId =
            (it as any).lotId ??
            (it.id ? lotByOldId.get(it.id) : undefined) ??
            (it.productId ? lotByProduct.get(it.productId) : undefined) ??
            ((oldItems[idx] as any)?.lotId ?? null);
          return {
            description: it.description ?? '',
            productId: it.productId ?? null,
            lotId,
            quantity: netWeight,
            unitPrice: pu,
            total: netWeight.times(pu).toDecimalPlaces(2),
            packingUnitPrice,
            colis: it.colis !== undefined ? new Prisma.Decimal(it.colis) : undefined,
            grossWeight: it.grossWeight !== undefined ? new Prisma.Decimal(it.grossWeight) : undefined,
            tare: it.tare !== undefined ? new Prisma.Decimal(it.tare) : undefined,
            netWeight,
          };
        });
        const { subtotal, taxAmount, packingTotal, total } = computeTotals(lineItems);
        // Supprime les anciennes lignes et recrée.
        await tx.invoiceItem.updateMany({ where: { invoiceId: inv.id }, data: { deletedAt: new Date() } });
        await tx.invoiceItem.createMany({ data: lineItems.map((li) => ({ ...li, invoiceId: inv.id })) });
        data.subtotal = subtotal;
        data.taxAmount = taxAmount;
        data.packingTotal = packingTotal;
        data.total = total;
      }
      const updated = await tx.invoice.update({ where: { id: inv.id }, data });
      return updated;
    });
    res.json(serializeInvoice(result as any));
  } catch (e: any) {
    if (e.code === 'NOT_FOUND') return res.status(404).json({ error: 'Facture introuvable' });
    if (e.code === 'LOCKED') return res.status(400).json({ error: 'Facture payée — verrouillée' });
    console.error('[invoices] patch error', e);
    res.status(500).json({ error: 'Erreur modification facture' });
  }
});

// ---------------------------------------------------------------------
// GET /api/invoices/:id/pdf — PDF bilingue FR/AR
// ---------------------------------------------------------------------
/**
 * @openapi
 * /api/invoices/{id}/pdf:
 *   get:
 *     summary: Génère le PDF bilingue de la facture (FR+AR, RTL)
 *     tags: [Invoices]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: query, name: format, schema: { type: string, enum: [a4, a5] } }
 *     responses:
 *       200: { description: application/pdf }
 *       404: { description: Introuvable }
 */
router.get('/:id/pdf', requirePermission('INVOICE_READ'), async (req, res) => {
  try {
    const inv = await loadInvoice(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Facture introuvable' });

    const format = req.query.format === 'a5' ? 'a5' : 'a4';
    const company = await getCompanyParams();
    const dto = serializeInvoice(inv as any);
    // Résolution du calibre depuis le lot (StockLot.caliber) pour affichage "Produit / calibre".
    const lotIds = Array.from(new Set((dto.items ?? []).map((it: any) => it.lotId).filter(Boolean))) as string[];
    if (lotIds.length > 0) {
      const lots = await prisma.stockLot.findMany({ where: { id: { in: lotIds } } });
      const caliberByLot = new Map(lots.map((l) => [l.id, (l as any).caliber ?? null]));
      for (const it of dto.items as any[]) {
        it.caliber = it.lotId ? caliberByLot.get(it.lotId) ?? null : null;
      }
    }
    (dto as any).barcodes = await buildEan13Only((inv as any).ean13);
    const doc = buildInvoicePdf(dto, company, format as 'a4' | 'a5');

    const filename = `facture-${inv.reference}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    doc.pipe(res);
    doc.end();
  } catch (e: any) {
    console.error('[invoices] pdf error', e);
    if (!res.headersSent) res.status(500).json({ error: 'Erreur génération PDF', details: e?.message });
  }
});

// ---------------------------------------------------------------------
// DELETE /api/invoices/:id — soft delete si DRAFT
// ---------------------------------------------------------------------
/**
 * @openapi
 * /api/invoices/{id}:
 *   delete:
 *     summary: Suppression logique d'une facture (uniquement si DRAFT)
 *     tags: [Invoices]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: Supprimé }
 *       409: { description: Non supprimable (pas DRAFT) }
 *       404: { description: Introuvable }
 */
router.delete('/:id', requirePermission('INVOICE_WRITE'), async (req, res) => {
  try {
    const inv = await loadInvoice(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Facture introuvable' });
    if (inv.status !== 'DRAFT') {
      return res.status(409).json({ error: `Facture ${inv.status} — seule une facture DRAFT peut être supprimée` });
    }
    await prisma.invoice.update({ where: { id: inv.id }, data: { deletedAt: new Date(), updatedBy: req.user!.id } });
    auditLog({ userId: req.user!.id, action: 'INVOICE_DELETE', entity: 'Invoice', entityId: inv.id, req }).catch(() => {});
    res.json({ message: 'Facture supprimée (soft delete)' });
  } catch (e: any) {
    console.error('[invoices] delete error', e);
    res.status(500).json({ error: 'Erreur suppression facture' });
  }
});

export default router;
