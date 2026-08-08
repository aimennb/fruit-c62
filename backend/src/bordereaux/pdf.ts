// =====================================================================
// Générateur PDF bilingue (FR + AR, RTL) du BORDEREAU FOURNISSEUR.
// Format A4 paysage (tableau large des ventes). Réutilise shapeArabic +
// police Amiri (comme le bon de réception A5).
// =====================================================================
import PDFDocument = require('pdfkit');
import * as path from 'path';
import { Prisma } from '@prisma/client';
import { shapeArabic } from '../bulletins/shape';
import { drawBarcodeFooter } from '../barcode';
import type { CompanyParams } from '../bulletins/pdf';

export type { CompanyParams } from '../bulletins/pdf';

const FONT_DIR = path.join(__dirname, '..', '..', '..', 'assets', 'fonts');
const AR_FONT = path.join(FONT_DIR, 'Amiri-Regular.ttf');

const DEFAULTS = {
  mandataireNameAr: 'خنوسي شعبان',
  mandataireNameFr: 'KHENOUCI Chabane',
  activity: 'Mandataire en Fruits et Légumes',
  market: 'Marché de Gros - Eucalyptus',
  carreau: '62',
  companyName: 'Fruiterie',
};

export interface BordereauVenteLine {
  date: string;
  invoiceRef: string;
  colis: string | number;
  productName: string;
  calibre?: string | null;
  netWeight: string | number;
  unitPrice: string | number;
  montant: string | number;
}

export interface BordereauPdfLossLine {
  date: string;
  quantity: string | number;
  reason?: string | null;
  cost: string | number;
}

export interface BordereauPdfDTO {
  reference: string;
  supplierName: string;
  productName: string;
  calibre?: string | null;
  lotNumber: string;
  // Multi-calibres : liste des lots agrégés dans ce bordereau.
  lots?: { lotNumber: string; calibre?: string | null; colis: string | number }[];
  colisRecus: string | number;
  colisVendus: string | number;
  colisRestant: string | number;
  statut: string;
  lines: BordereauVenteLine[];
  totalBrutVentes: string | number;
  poidsNetTotal?: string | number;
  commissionType: string;
  commissionValue: string | number;
  commissionAmount: string | number;
  avancesAffectees: string | number;
  droitMarche?: string | number;
  transport?: string | number;
  montantFinalDu: string | number;
  pertes?: BordereauPdfLossLine[];
  totalPertesColis?: string | number;
  totalPertesCout?: string | number;
  /** Code-barres pré-rendus (PNG) : CODE128 (référence) + EAN13. */
  barcodes?: { code128?: Buffer | null; ean13?: Buffer | null; refText?: string | null; eanText?: string | null };
}

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

function fmtDate(s: string): string {
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleDateString('fr-FR');
  } catch {
    return s;
  }
}

/**
 * Construit le PDF A4 paysage du bordereau fournisseur. Renvoie le PDFDocument.
 */
export function buildBordereauPdf(r: BordereauPdfDTO, company: CompanyParams): PDFKit.PDFDocument {
  const cp = { ...DEFAULTS, ...stripNulls(company) };

  const doc = new PDFDocument({
    size: 'a4',
    layout: 'landscape', // A4 paysage : 841.89 x 595.28
    margin: 30,
    info: {
      Title: `Bordereau fournisseur ${r.reference}`,
      Author: cp.mandataireNameFr || 'Fruiterie',
    },
  });

  doc.registerFont('Amiri', AR_FONT);
  doc.font('Helvetica');

  const m = doc.page.margins.left;
  const pageW = 841.89;
  const contentW = pageW - doc.page.margins.left - doc.page.margins.right;

  // ---------------- EN-TÊTE SOCIÉTÉ ----------------
  const headerTop = doc.y;
  const colW = contentW / 2;
  doc.font('Amiri').fontSize(11).text(shapeArabic(cp.mandataireNameAr || ''), m, headerTop, { width: colW, align: 'left' });
  doc.font('Helvetica-Bold').fontSize(12).text(cp.mandataireNameFr || '', m, doc.y + 1, { width: colW, align: 'left' });
  doc.font('Helvetica').fontSize(8).text(cp.activity || '', m, doc.y + 1, { width: colW });
  doc.text(cp.market || '', m, doc.y + 1, { width: colW });
  doc.font('Helvetica-Bold').fontSize(8).text(`Carreau N° ${cp.carreau || ''}`, m, doc.y + 1, { width: colW });
  const leftBottom = doc.y;

  doc.font('Helvetica-Bold').fontSize(11).text(`N° ${r.reference}`, m + colW, headerTop, { width: colW, align: 'right' });
  doc.font('Helvetica').fontSize(9).text(`Statut : ${r.statut}`, m + colW, doc.y + 2, { width: colW, align: 'right' });
  const rightBottom = doc.y;

  // ---------------- CODE-BARRES (EAN13 centré, dans l'en-tête, avant la ligne) ----------------
  const bcY = Math.max(leftBottom, rightBottom) + 4;
  const yApresBc = drawBarcodeFooter(doc, r.barcodes, { x: m, y: bcY, contentW, width: 150 });
  const afterHeader = yApresBc + 4;
  doc.moveTo(m, afterHeader).lineTo(m + contentW, afterHeader).lineWidth(1).stroke();

  // ---------------- TITRE ----------------
  let y = afterHeader + 6;
  doc.font('Amiri').fontSize(16).text(shapeArabic('بردية المورد'), m, y, { width: contentW, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(15).text('BORDEREAU FOURNISSEUR', m, doc.y + 1, { width: contentW, align: 'center' });
  y = doc.y + 8;

  // ---------------- INFOS BORDEREAU (bandeau) ----------------
  const infoPairs: { label: string; value: string }[] = [
    { label: 'Fournisseur', value: r.supplierName || '—' },
    { label: 'Produit', value: (r.productName || '—') + (r.calibre ? ` / ${r.calibre}` : '') },
    { label: 'N° Lot', value: r.lotNumber || '—' },
    { label: 'Colis reçus', value: fmt(r.colisRecus, 0) },
    { label: 'Colis vendus', value: fmt(r.colisVendus, 0) },
    { label: 'Colis restants', value: fmt(r.colisRestant, 0) },
  ];
  const infoColW = contentW / 3;
  const infoRowH = 22;
  for (let i = 0; i < infoPairs.length; i++) {
    const col = i % 3;
    const rowI = Math.floor(i / 3);
    const x = m + col * infoColW;
    const yy = y + rowI * infoRowH;
    doc.rect(x, yy, infoColW, infoRowH).lineWidth(0.5).stroke('#000000');
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#555555').text(infoPairs[i].label, x + 5, yy + 3, { width: infoColW - 10 });
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000').text(infoPairs[i].value, x + 5, yy + 11, { width: infoColW - 10 });
  }
  y = y + 2 * infoRowH + 10;

  // ---------------- LOTS / CALIBRES (multi-calibres) ----------------
  const bLots = r.lots ?? [];
  if (bLots.length > 1) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000000').text('Lots / Calibres / ', m, y);
    const lotsArX = m + doc.widthOfString('Lots / Calibres / ');
    doc.font('Amiri').fontSize(9).fillColor('#000000').text(shapeArabic('الحصص / المعايير'), lotsArX, y);
    y = doc.y + 3;
    const lw = [0.4, 0.35, 0.25];
    const lh = 15;
    const drawLotRow = (cells: string[], yy: number, bold = false) => {
      let lx = m;
      for (let i = 0; i < 3; i++) {
        const w = lw[i] * (contentW * 0.6);
        doc.rect(lx, yy, w, lh).lineWidth(0.4).stroke('#000000');
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor('#000000')
          .text(cells[i], lx + 4, yy + 3.5, { width: w - 8, align: i === 2 ? 'right' : 'left' });
        lx += w;
      }
    };
    drawLotRow(['N° Lot', 'Calibre', 'Colis'], y, true);
    y += lh;
    for (const l of bLots) {
      drawLotRow([l.lotNumber, l.calibre || '—', fmt(l.colis, 0)], y);
      y += lh;
    }
    y += 8;
  }

  // ---------------- TABLEAU DES VENTES ----------------
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000').text('Tableau des ventes / ', m, y);
  const arLabelX = m + doc.widthOfString('Tableau des ventes / ');
  doc.font('Amiri').fontSize(10).fillColor('#000000').text(shapeArabic('جدول المبيعات'), arLabelX, y);
  y = doc.y + 3;

  const cols = [
    { key: 'date', fr: 'Date', w: 0.11 },
    { key: 'invoiceRef', fr: 'N° Facture', w: 0.16 },
    { key: 'colis', fr: 'Colis', w: 0.09 },
    { key: 'productName', fr: 'Produit', w: 0.24 },
    { key: 'netWeight', fr: 'Poids net', w: 0.12 },
    { key: 'unitPrice', fr: 'Prix/kg', w: 0.12 },
    { key: 'montant', fr: 'Montant', w: 0.16 },
  ];
  const colX: number[] = [];
  let acc = m;
  for (const c of cols) {
    colX.push(acc);
    acc += c.w * contentW;
  }
  const tableRight = m + contentW;
  const headH = 18;

  function drawRow(cells: string[], yTop: number, h: number, opts: { bold?: boolean; fill?: string } = {}) {
    if (opts.fill) {
      doc.rect(m, yTop, contentW, h).fill(opts.fill);
    }
    doc.fillColor('#000000');
    for (let i = 0; i < cols.length; i++) {
      const x = colX[i];
      const w = cols[i].w * contentW;
      doc.rect(x, yTop, w, h).lineWidth(0.4).stroke('#000000');
      const align = i === 0 || i === 1 || i === 3 ? 'left' : 'right';
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor('#000000')
        .text(cells[i], x + 4, yTop + h / 2 - 4, { width: w - 8, align: align as any });
    }
  }

  // Header row
  drawRow(cols.map((c) => c.fr), y, headH, { bold: true, fill: '#e8f0e8' });
  y += headH;

  const rowH = 16;
  const pageBottom = 595.28 - doc.page.margins.bottom - 90; // garder place pour bloc calculs
  if (r.lines.length === 0) {
    doc.font('Helvetica-Oblique').fontSize(8).fillColor('#888888').text('Aucune vente pour ce lot.', m + 4, y + 4, { width: contentW - 8 });
    y += rowH;
  } else {
    for (const line of r.lines) {
      if (y + rowH > pageBottom) {
        doc.addPage({ size: 'a4', layout: 'landscape', margin: 30 });
        y = doc.page.margins.top;
        drawRow(cols.map((c) => c.fr), y, headH, { bold: true, fill: '#e8f0e8' });
        y += headH;
      }
      drawRow(
        [
          fmtDate(line.date),
          line.invoiceRef || '—',
          fmt(line.colis, 0),
          line.productName ? line.productName + ((line.calibre ?? r.calibre) ? ` / ${line.calibre ?? r.calibre}` : '') : '—',
          fmt(line.netWeight, 2),
          fmt(line.unitPrice, 2),
          fmt(line.montant, 2),
        ],
        y,
        rowH,
      );
      y += rowH;
    }
  }

  // Ligne de total « Poids net total » (somme des ventes, pertes exclues)
  if (r.lines.length > 0) {
    const totalLabelFr = 'Poids net total';
    const fillY = y;
    doc.rect(m, fillY, contentW, rowH).fill('#e8f0e8');
    doc.fillColor('#000000');
    for (let i = 0; i < cols.length; i++) {
      const x = colX[i];
      const w = cols[i].w * contentW;
      doc.rect(x, fillY, w, rowH).lineWidth(0.4).stroke('#000000');
    }
    // Cellules fusionnées Date..Produit (index 0 à 3)
    const labelW = colX[4] - colX[0];
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#000000')
      .text(totalLabelFr, colX[0] + 4, fillY + rowH / 2 - 4, { width: labelW - 8, align: 'left' });
    doc.font('Amiri').fontSize(8).fillColor('#000000')
      .text(shapeArabic('إجمالي الوزن الصافي'), colX[0] + 4, fillY + rowH / 2 - 4, { width: labelW - 8, align: 'right' });
    // Poids net total (index 4)
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#000000')
      .text(`${fmt(r.poidsNetTotal ?? 0, 2)}`, colX[4] + 4, fillY + rowH / 2 - 4, { width: cols[4].w * contentW - 8, align: 'right' });
    y += rowH;
  }
  y += 12;
  const boxW = contentW * 0.42;
  const boxX = tableRight - boxW;
  const commLabel =
    r.commissionType === 'fixe'
      ? `Commission (fixe ${fmt(r.commissionValue, 2)} DA)`
      : `Commission (${fmt(r.commissionValue, 2)} %)`;
  const calcRows: { label: string; value: string; bold?: boolean }[] = [
    { label: 'Total brut ventes', value: `${fmt(r.totalBrutVentes, 2)} DA` },
    { label: commLabel, value: `- ${fmt(r.commissionAmount, 2)} DA` },
    { label: 'Avances affectées', value: `- ${fmt(r.avancesAffectees, 2)} DA` },
    { label: 'Droit de marché', value: `- ${fmt(r.droitMarche ?? 0, 2)} DA` },
    { label: 'Transport', value: `- ${fmt(r.transport ?? 0, 2)} DA` },
    { label: 'Montant final dû fournisseur', value: `${fmt(r.montantFinalDu, 2)} DA`, bold: true },
  ];
  const calcRowH = 20;
  for (let i = 0; i < calcRows.length; i++) {
    const yy = y + i * calcRowH;
    const cr = calcRows[i];
    if (cr.bold) doc.rect(boxX, yy, boxW, calcRowH).fill('#e8f0e8');
    doc.fillColor('#000000');
    doc.rect(boxX, yy, boxW, calcRowH).lineWidth(0.5).stroke('#000000');
    doc.font(cr.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(cr.bold ? 10 : 9).fillColor('#000000')
      .text(cr.label, boxX + 6, yy + calcRowH / 2 - 5, { width: boxW * 0.6 - 10 });
    doc.font('Helvetica-Bold').fontSize(cr.bold ? 11 : 9).fillColor('#000000')
      .text(cr.value, boxX + boxW * 0.6, yy + calcRowH / 2 - 5, { width: boxW * 0.4 - 6, align: 'right' });
  }

  // ---------------- SECTION PERTES (uniquement s'il y a des pertes) ----------------
  const pertes = r.pertes ?? [];
  if (pertes.length > 0) {
    y += calcRows.length * calcRowH + 16;
    const lossPageBottom = 595.28 - doc.page.margins.bottom - 20;
    if (y + 40 > lossPageBottom) {
      doc.addPage({ size: 'a4', layout: 'landscape', margin: 30 });
      y = doc.page.margins.top;
    }
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000').text('PERTES / ', m, y);
    const lossArX = m + doc.widthOfString('PERTES / ');
    doc.font('Amiri').fontSize(10).fillColor('#000000').text(shapeArabic('الخسائر'), lossArX, y);
    y = doc.y + 3;

    const lcols = [
      { fr: 'Date', w: 0.18, align: 'left' },
      { fr: 'Colis', w: 0.14, align: 'right' },
      { fr: 'Raison', w: 0.44, align: 'left' },
      { fr: 'Coût (DA)', w: 0.24, align: 'right' },
    ];
    const lcolX: number[] = [];
    let lacc = m;
    for (const c of lcols) {
      lcolX.push(lacc);
      lacc += c.w * contentW;
    }
    function drawLossRow(cells: string[], yTop: number, h: number, opts: { bold?: boolean; fill?: string } = {}) {
      if (opts.fill) doc.rect(m, yTop, contentW, h).fill(opts.fill);
      doc.fillColor('#000000');
      for (let i = 0; i < lcols.length; i++) {
        const x = lcolX[i];
        const w = lcols[i].w * contentW;
        doc.rect(x, yTop, w, h).lineWidth(0.4).stroke('#000000');
        doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor('#000000')
          .text(cells[i], x + 4, yTop + h / 2 - 4, { width: w - 8, align: lcols[i].align as any });
      }
    }
    drawLossRow(lcols.map((c) => c.fr), y, headH, { bold: true, fill: '#f6e8e8' });
    y += headH;
    const lossRowBottom = 595.28 - doc.page.margins.bottom - 20;
    for (const p of pertes) {
      if (y + rowH > lossRowBottom) {
        doc.addPage({ size: 'a4', layout: 'landscape', margin: 30 });
        y = doc.page.margins.top;
        drawLossRow(lcols.map((c) => c.fr), y, headH, { bold: true, fill: '#f6e8e8' });
        y += headH;
      }
      drawLossRow(
        [fmtDate(p.date), fmt(p.quantity, 2), p.reason || '—', fmt(p.cost, 2)],
        y,
        rowH,
      );
      y += rowH;
    }
    drawLossRow(
      ['Total', fmt(r.totalPertesColis, 2), '', `${fmt(r.totalPertesCout, 2)} DA`],
      y,
      rowH,
      { bold: true, fill: '#f6e8e8' },
    );
    y += rowH;
  }

  return doc;
}
