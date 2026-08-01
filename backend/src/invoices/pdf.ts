// =====================================================================
// Générateur PDF bilingue (FR + AR, RTL) de la FACTURE DE VENTE.
// RÉUTILISE l'infrastructure B.2 (bulletins) :
//   - shapeArabic() (reshaping arabe + Bidi) depuis ../bulletins/shape
//   - CompanyParams (mêmes champs CompanySettings) depuis ../bulletins/pdf
//   - Police Amiri (arabe) + Helvetica (latin/FR), paysage A4.
// Aucune réinvention : même logique de mise en page bilingue.
// =====================================================================
import PDFDocument = require('pdfkit');
import * as path from 'path';
import { Prisma } from '@prisma/client';
import { shapeArabic } from '../bulletins/shape';
import { drawBarcodeFooter } from '../barcode';
import type { CompanyParams } from '../bulletins/pdf';

export type { CompanyParams } from '../bulletins/pdf';

const FONT_DIR = path.join(__dirname, '..', '..', '..', 'assets', 'fonts');
// Même police Amiri que B.2.
const AR_FONT = path.join(FONT_DIR, 'Amiri-Regular.ttf');

// Valeurs par défaut (surchargées par CompanySettings).
const DEFAULTS = {
  mandataireNameAr: 'خنوسي شعبان',
  mandataireNameFr: 'KHENOUCI Chabane',
  activity: 'Mandataire en Fruits et Légumes',
  market: 'Marché de Gros - Eucalyptus',
  carreau: '62',
  mentionFr: 'Après huit (8) jours, l’emballage ne sera pas remboursé',
  mentionAr: 'بعد ثمانية (8) أيام، لن يتم استرجاع ثمن العبوة',
  companyName: 'Fruiterie',
};

export interface InvoiceItemDTO {
  id: string;
  description: string;
  caliber?: string | null;
  quantity: string;
  unitPrice: string;
  total: string;
  colis?: string | null;
  packingUnitPrice?: string | number | Prisma.Decimal | null;
  grossWeight?: string | null;
  tare?: string | null;
  netWeight?: string | null;
}

export interface InvoiceCustomerDTO {
  name: string | null;
  nameAr: string | null;
  address: string | null;
  taxId: string | null;
  phone: string | null;
}

export interface InvoiceDTO {
  id: string;
  reference: string;
  saleId?: string | null;
  createdAt?: string | null;
  issueDate: string;
  dueDate: string | null;
  status: string;
  subtotal: string;
  taxAmount: string;
  total: string;
  paidAmount?: string;
  remaining?: string;
  packingTotal?: string | number | Prisma.Decimal | null;
  packingReturned?: boolean;
  notes: string | null;
  /** Code-barres pré-rendus (PNG) : CODE128 (référence) + EAN13. */
  barcodes?: { code128?: Buffer | null; ean13?: Buffer | null; refText?: string | null; eanText?: string | null };
  customer: InvoiceCustomerDTO | null;
  items: InvoiceItemDTO[];
  payments?: InvoicePaymentDTO[];
}

export interface InvoicePaymentDTO {
  id: string;
  reference: string;
  amount: string | number;
  method?: string;
  paymentDate?: string | null;
  notes?: string | null;
  saleId?: string | null;
}

export type PdfFormat = 'a4' | 'a5';

function fmt(n: string | number | Prisma.Decimal | null | undefined, dp = 2): string {
  if (n === null || n === undefined || n === '') return '0';
  try {
    return new Prisma.Decimal(n).toFixed(dp);
  } catch {
    return String(n);
  }
}

function stripNulls<T extends object>(obj: T): Partial<T> {
  const out: any = {};
  for (const k of Object.keys(obj) as (keyof T)[]) {
    const v = obj[k];
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Construit le document PDF (stream). Renvoie le PDFDocument (à pipe vers la
 * réponse HTTP). Même format paysage A4 que B.2.
 */
export function buildInvoicePdf(
  invoice: InvoiceDTO,
  company: CompanyParams,
  format: PdfFormat = 'a4',
): PDFKit.PDFDocument {
  const cp = { ...DEFAULTS, ...stripNulls(company) };

  const isA5 = format === 'a5';
  // Format nommé + layout paysage : pdfkit applique le paysage natif (largeur > hauteur).
  // Un tableau custom + layout:'landscape' NE bascule PAS correctement → PDF portrait.
  const pageSize: 'a4' | 'a5' = isA5 ? 'a5' : 'a4';

  const doc = new PDFDocument({
    size: pageSize,
    layout: 'landscape',
    margin: isA5 ? 24 : 36,
    info: {
      Title: `Facture ${invoice.reference}`,
      Author: cp.mandataireNameFr || 'Fruiterie',
    },
  });

  doc.registerFont('Amiri', AR_FONT);
  doc.font('Helvetica');

  // Dimensions paysage explicites (largeur > hauteur) — pageSize est un nom de format.
  const pageW = isA5 ? 595.28 : 841.89;
  const pageH = isA5 ? 420.94 : 595.28;
  const m = doc.page.margins.left;
  const contentW = pageW - doc.page.margins.left - doc.page.margins.right;
  // Tableau des lignes : réduit à 88% de la largeur utile, centré (marges ~6%).
  const tableW = contentW * 0.88;
  const tableX = m + (contentW - tableW) / 2;

  // ---------------------------------------------------------------
  // EN-TÊTE : 3 colonnes (gauche entreprise / centre titre / droite n°+date)
  // ---------------------------------------------------------------
  const headerTop = doc.y;
  const colLeftW = contentW * 0.36;
  const colCenterW = contentW * 0.30;
  const colRightW = contentW * 0.34;
  const colLeftX = m;
  const colCenterX = m + colLeftW;
  const colRightX = m + colLeftW + colCenterW;

  // --- Bloc gauche : entreprise / mandataire ---
  doc.fontSize(isA5 ? 9 : 11).font('Amiri').text(shapeArabic(cp.mandataireNameAr || ''), colLeftX, headerTop, { width: colLeftW, align: 'left' });
  doc.font('Helvetica').fontSize(isA5 ? 10 : 12).text(cp.mandataireNameFr || '', colLeftX, doc.y + 2, { width: colLeftW, align: 'left' });
  doc.fontSize(isA5 ? 7 : 8).text(cp.activity || '', colLeftX, doc.y + 2, { width: colLeftW });
  doc.text(cp.market || '', colLeftX, doc.y + 1, { width: colLeftW });
  doc.font('Helvetica-Bold').text(`Carreau N° ${cp.carreau || ''}`, colLeftX, doc.y + 1, { width: colLeftW });
  if (cp.companyName) doc.font('Helvetica').text(cp.companyName, colLeftX, doc.y + 1, { width: colLeftW });
  const leftBottomY = doc.y;

  // --- Bloc centre : titre FACTURE ---
  const centerY = headerTop;
  doc.font('Amiri').fontSize(isA5 ? 18 : 24).text(shapeArabic('فاتورة'), colCenterX, centerY, { width: colCenterW, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(isA5 ? 13 : 17).text('FACTURE', colCenterX, doc.y + 2, { width: colCenterW, align: 'center' });
  doc.font('Helvetica').fontSize(isA5 ? 9 : 11).text(`N° ${invoice.reference}`, colCenterX, doc.y + 2, { width: colCenterW, align: 'center' });
  const centerBottomY = doc.y;

  // --- Bloc droite : date émission + échéance ---
  doc.font('Helvetica-Bold').fontSize(isA5 ? 8 : 10).text(`Date : ${fmtDate(invoice.issueDate)}`, colRightX, headerTop, { width: colRightW, align: 'right' });
  doc.font('Helvetica').fontSize(isA5 ? 8 : 10);
  if (invoice.dueDate) doc.text(`Échéance : ${fmtDate(invoice.dueDate)}`, colRightX, doc.y + 2, { width: colRightW, align: 'right' });
  const rightBottomY = doc.y;

  // ---------------- CODE-BARRES (EAN13 centré, dans l'en-tête, avant la ligne) ----------------
  const bcY = Math.max(leftBottomY, centerBottomY, rightBottomY) + 4;
  const yApresBc = drawBarcodeFooter(doc, invoice.barcodes, { x: m, y: bcY, contentW, width: 150 });

  // Ligne de séparation (sous le code-barres)
  const headerBottom = yApresBc + 4;
  doc.moveTo(m, headerBottom).lineTo(m + contentW, headerBottom).lineWidth(1.2).stroke();
  doc.y = headerBottom + 6;

  // ---------------------------------------------------------------
  // BLOC CLIENT (FR + AR)
  // ---------------------------------------------------------------
  const custTop = doc.y;
  // LABEL BILINGUE DÉSALIGNÉ : arabe (Amiri) EN HAUT, français EN DESSOUS.
  // On sépare les deux langues sur des lignes distinctes pour ne plus les
  // mélanger ET on applique la police Amiri à l'arabe (Helvetica ne gère pas
  // l'arabe → plus de charabia).
  // Label arabe 'الزبون' EN HAUT (Amiri), puis 'Client : <nom>' EN DESSOUS (FR).
  // Plus de label 'Client' redondant écrit seul avant le nom.
  doc.font('Amiri').fontSize(isA5 ? 9 : 11).text(shapeArabic('الزبون'), m, custTop, { width: contentW, align: 'left' });
  // Nom client en arabe (si présent) sous le label arabe.
  if (invoice.customer?.nameAr) {
    doc.font('Amiri').fontSize(isA5 ? 8 : 10).text(shapeArabic(invoice.customer.nameAr), m, doc.y + 2, { width: contentW, align: 'left' });
  }
  // Ligne française : 'Client : <nom>' (un seul label 'Client').
  doc.font('Helvetica-Bold').fontSize(isA5 ? 9 : 11);
  const custName = invoice.customer?.name || '……………………………………………………';
  doc.text(`Client : ${custName}`, m, doc.y + 2, { width: contentW, align: 'left' });
  doc.font('Helvetica').fontSize(isA5 ? 7 : 9);
  const addrLines: string[] = [];
  if (invoice.customer?.address) addrLines.push(invoice.customer.address);
  if (invoice.customer?.taxId) addrLines.push(`RC/NIF : ${invoice.customer.taxId}`);
  if (invoice.customer?.phone) addrLines.push(`Tél : ${invoice.customer.phone}`);
  if (addrLines.length) doc.text(addrLines.join('  •  '), m, doc.y + 2, { width: contentW });

  doc.y += 6;

  // ---------------------------------------------------------------
  // TABLEAU DES LIGNES
  // ---------------------------------------------------------------
  const tableTop = doc.y;
  const cols = [
    { key: 'description', ar: 'البيان', fr: 'Article', w: 0.20 },
    { key: 'colis', ar: 'الطرود', fr: 'Colis', w: 0.08 },
    { key: 'gross', ar: 'الوزن القائم', fr: 'Brut', w: 0.09 },
    { key: 'tare', ar: 'الطرح', fr: 'Tare', w: 0.09 },
    { key: 'net', ar: 'الصافي', fr: 'Net', w: 0.09 },
    { key: 'unitPrice', ar: 'الوحدة', fr: 'P.U.', w: 0.09 },
    { key: 'packingUnit', ar: 'سعر التغليف', fr: 'P.U. EMB.', w: 0.10 },
    { key: 'packing', ar: 'مبلغ التغليف', fr: 'Emballage', w: 0.12 },
    { key: 'total', ar: 'المبلغ', fr: 'TOTAL', w: 0.14 },
  ];

  const colXs: number[] = [];
  let cx = tableX;
  for (const c of cols) {
    colXs.push(cx);
    cx += tableW * c.w;
  }
  const colEnd = tableX + tableW;

  const headH = isA5 ? 26 : 32;
  const rowH = isA5 ? 18 : 22;
  const items = invoice.items;

  // Bas de la zone utile : réserve TOTAUX + signature + mentions. Au-delà =>
  // saut de page automatique (jamais de coord Y fixe hors page).
  const pageBottomLimit = pageH - doc.page.margins.bottom - (isA5 ? 70 : 90);

  // Dessine l'en-tête du tableau à la position courante (doc.y). Redessiné sur
  // CHAQUE page pour le saut de page automatique.
  const drawHeader = () => {
    const top = doc.y;
    // Pas de fond coloré : cases blanches, bordures noires uniquement.
    doc.rect(tableX, top, tableW, headH).stroke('#000000');
    doc.lineWidth(0.8);
    const fontSizeAr = isA5 ? 7 : 8;
    const fontSizeFr = isA5 ? 7 : 8;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      const x0 = colXs[i];
      const x1 = i < cols.length - 1 ? colXs[i + 1] : colEnd;
      const w = x1 - x0;
      // EN-TÊTE BILINGUE DÉSALIGNÉ : arabe (Amiri) EN HAUT, français EN DESSOUS.
      doc.font('Amiri').fontSize(fontSizeAr).fillColor('#000000')
        .text(shapeArabic(c.ar), x0 + 1, top + 3, { width: w - 2, align: 'center' });
      doc.font('Helvetica-Bold').fontSize(fontSizeFr).fillColor('#000000')
        .text(c.fr, x0 + 1, top + 3 + fontSizeAr + 3, { width: w - 2, align: 'center' });
      if (i > 0) doc.moveTo(x0, top).lineTo(x0, top + headH).lineWidth(0.6).stroke();
    }
    doc.y = top + headH;
  };

  // Dessine une ligne de données à la position courante (doc.y) — suit doc.y.
  const drawRow = (it?: InvoiceDTO['items'][number]) => {
    const top = doc.y;
    doc.rect(tableX, top, tableW, rowH).stroke();
    const ty = top + (rowH - (isA5 ? 6.5 : 7)) / 2 - 1;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      const x0 = colXs[i];
      const x1 = i < cols.length - 1 ? colXs[i + 1] : colEnd;
      const w = x1 - x0;
      if (i > 0) doc.moveTo(x0, top).lineTo(x0, top + rowH).lineWidth(0.5).stroke();
      doc.font('Helvetica').fontSize(isA5 ? 6.5 : 7).fillColor('#000000');
      if (c.key === 'description') {
        doc.text((it?.description || '') + (it?.caliber ? ` / ${it.caliber}` : ''), x0 + 3, ty, { width: w - 6, align: 'left' });
      } else if (c.key === 'colis') {
        let colisCell = '';
        if (it) {
          const nbColis = Number(it.colis ?? 0);
          if (nbColis > 0) colisCell = String(nbColis);
        }
        doc.text(colisCell, x0 + 2, ty, { width: w - 4, align: 'center' });
      } else if (c.key === 'gross') {
        let cell = '';
        if (it && it.grossWeight != null && it.grossWeight !== '') {
          const v = Number(fmt(it.grossWeight as any, 2));
          if (v > 0) cell = fmt(v, 2);
        }
        doc.text(cell, x0 + 2, ty, { width: w - 4, align: 'center' });
      } else if (c.key === 'tare') {
        let cell = '';
        if (it && it.tare != null && it.tare !== '') {
          const v = Number(fmt(it.tare as any, 2));
          if (v > 0) cell = fmt(v, 2);
        }
        doc.text(cell, x0 + 2, ty, { width: w - 4, align: 'center' });
      } else if (c.key === 'net') {
        let cell = '';
        if (it && it.netWeight != null && it.netWeight !== '') {
          const v = Number(fmt(it.netWeight as any, 2));
          if (v > 0) cell = fmt(v, 2);
        }
        doc.text(cell, x0 + 2, ty, { width: w - 4, align: 'center' });
      } else if (c.key === 'unitPrice') {
        doc.text(it ? fmt(it.unitPrice, 2) : '', x0 + 2, ty, { width: w - 4, align: 'center' });
      } else if (c.key === 'packingUnit') {
        let cell = '';
        if (it && it.packingUnitPrice != null) {
          const v = Number(fmt(it.packingUnitPrice as any, 2));
          if (v > 0) cell = fmt(v, 2);
        }
        doc.text(cell, x0 + 2, ty, { width: w - 4, align: 'center' });
      } else if (c.key === 'packing') {
        let packCell = '';
        if (it) {
          const nbColis = Number(it.colis ?? 0);
          const pack = it.packingUnitPrice == null ? 0 : Number(fmt(it.packingUnitPrice as any, 2));
          const packTotal = pack * nbColis;
          if (packTotal > 0) packCell = fmt(packTotal, 2);
        }
        doc.text(packCell, x0 + 2, ty, { width: w - 4, align: 'center' });
      } else if (c.key === 'total') {
        doc.text(it ? fmt(it.total, 2) : '', x0 + 2, ty, { width: w - 4, align: 'center' });
      }
    }
    doc.y = top + rowH;
  };

  // Bordures verticales + bas du bloc tableau de la page courante.
  let pageTopY = doc.y;
  const closePageBorders = () => {
    const bottom = doc.y;
    doc.moveTo(tableX, pageTopY).lineTo(tableX, bottom).lineWidth(0.8).stroke();
    doc.moveTo(colEnd, pageTopY).lineTo(colEnd, bottom).lineWidth(0.8).stroke();
    doc.moveTo(tableX, bottom).lineTo(colEnd, bottom).lineWidth(0.8).stroke();
  };
  // Saut de page si la prochaine ligne ne rentre pas dans la zone utile.
  const ensureRowSpace = () => {
    if (doc.y + rowH > pageBottomLimit) {
      closePageBorders();
      doc.addPage();
      drawHeader();
      pageTopY = doc.y;
    }
  };

  // En-tête initial.
  drawHeader();

  // ---------------------------------------------------------------
  // Lignes de données (flux doc.y — saut de page auto, AUCUN troncage)
  // ---------------------------------------------------------------
  for (let r = 0; r < items.length; r++) {
    ensureRowSpace();
    drawRow(items[r]);
  }
  // Complète avec des lignes vides pour la lisibilité (1re page uniquement).
  const minRows = 3;
  if (items.length < minRows) {
    for (let r = items.length; r < minRows; r++) {
      ensureRowSpace();
      drawRow(undefined);
    }
  }

  // Bordure bas du dernier bloc de page + avance le curseur.
  closePageBorders();
  doc.y += 8;

  // ---------------------------------------------------------------
  // TOTAUX (droite) + signature (gauche)
  // ---------------------------------------------------------------
  const footerY = doc.y;
  // Signature à gauche
  doc.font('Helvetica').fontSize(isA5 ? 7 : 8);
  const sigX = m;
  const sigW = contentW * 0.42;
  doc.moveTo(sigX, footerY + 18).lineTo(sigX + sigW, footerY + 18).lineWidth(0.6).stroke();
  doc.text('Cachet & Signature', sigX, footerY + 20, { width: sigW });
  doc.font('Amiri').text(shapeArabic('الختم والتوقيع'), sigX, footerY + 30, { width: sigW });

  // STATUT AU CENTRE BAS (entre signature à gauche et totaux à droite).
  const statusCX = m + contentW * 0.42;
  const statusCW = contentW * 0.26;
  const statusCenterY = footerY + 6;
  doc.font('Amiri').fontSize(isA5 ? 9 : 11).fillColor('#000000')
    .text(shapeArabic('الحالة'), statusCX, statusCenterY, { width: statusCW, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(isA5 ? 10 : 12).fillColor('#000000')
    .text(`Statut : ${statusLabelFr(invoice.status, invoice.remaining, invoice.total)}`, statusCX, doc.y + 2, { width: statusCW, align: 'center' });

  // TOTAUX à droite
  const totW = contentW * 0.32;
  const totX = m + contentW - totW;
  // Bloc récap SANS résumé comptable : ni Sous-total, ni TVA.
  // Ordre : Total emballage (si présent) → puis TOTAL final UNIQUE bilingue.
  // Total emballage (si présent) — pas de mention remboursé/à rembourser.
  const packingTotal = invoice.packingTotal == null ? 0 : Number(fmt(invoice.packingTotal as any, 2));
  doc.y = footerY;
  if (packingTotal > 0) {
    doc.font('Helvetica').fontSize(isA5 ? 8 : 10);
    doc.text(`Total emballage : ${fmt(packingTotal, 2)} DA`, totX, footerY, { width: totW, align: 'right' });
  }
  // Avance encaissée (entre Total emballage et Reste à payer).
  const paid = Number(invoice.paidAmount ?? 0);
  const remaining = Number(invoice.remaining ?? 0);
  if (paid > 0 && remaining > 0) {
    doc.font('Helvetica').fontSize(isA5 ? 8 : 10);
    doc.text(`Avance : ${fmt(paid, 2)} DA`, totX, doc.y + 2, { width: totW, align: 'right' });
  }
  // Reste à payer (encaissement partiel) — en gras.
  if (paid > 0 && remaining > 0) {
    doc.font('Helvetica-Bold').fontSize(isA5 ? 8 : 10);
    doc.text(`Reste à payer : ${fmt(remaining, 2)} DA`, totX, doc.y + 2, { width: totW, align: 'right' });
  }
  // TOTAL FINAL UNIQUE bilingue : français en haut, arabe en dessous.
  doc.font('Helvetica-Bold').fontSize(isA5 ? 10 : 12);
  doc.text(`TOTAL : ${fmt(invoice.total, 2)} DA`, totX, doc.y + (isA5 ? 5 : 7), { width: totW, align: 'right' });
  doc.font('Amiri').fontSize(isA5 ? 9 : 11).text(shapeArabic(`الإجمالي : ${fmt(invoice.total, 2)} دج`), totX, doc.y + 2, { width: totW, align: 'right' });

  // Notes éventuelles
  if (invoice.notes) {
    doc.font('Helvetica-Oblique').fontSize(isA5 ? 7 : 8);
    doc.text(`Note : ${invoice.notes}`, m, doc.y + 6, { width: contentW * 0.6 });
  }

  // Mentions légales (centrées, bas de page)
  const mentionY = pageH - doc.page.margins.bottom - (isA5 ? 26 : 30);
  doc.font('Helvetica-Oblique').fontSize(isA5 ? 6.5 : 8);
  doc.text(cp.mentionFr || '', m, mentionY, { width: contentW, align: 'center' });
  doc.font('Amiri').fontSize(isA5 ? 7 : 9);
  doc.text(shapeArabic(cp.mentionAr || ''), m, doc.y + 1, { width: contentW, align: 'center' });

  return doc;
}

function statusLabelFr(
  status: string,
  remaining?: string | number | Prisma.Decimal | null,
  total?: string | number | Prisma.Decimal | null,
): string {
  if (
    status === 'SENT' &&
    Number(total ?? 0) > 0 &&
    Number(remaining ?? 0) === Number(total ?? 0)
  ) {
    return 'Crédit';
  }
  switch (status) {
    case 'PAID': return 'Payé';
    case 'PARTIALLY_PAID': return 'Avance';
    case 'SENT': return 'Envoyée';
    case 'OVERDUE': return 'En retard';
    case 'CANCELLED': return 'Annulée';
    case 'DRAFT':
    default: return 'Brouillon';
  }
}

function fmtDate(s: string): string {
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleDateString('fr-FR');
  } catch {
    return s;
  }
}
