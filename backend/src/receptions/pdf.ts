// =====================================================================
// Générateur PDF bilingue (FR + AR, RTL) du BON DE RÉCEPTION fournisseur.
// Format A5 portrait. Réutilise shapeArabic() (B.2) + police Amiri.
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

export interface ReceptionPdfDTO {
  reference: string;
  date: string;
  heure?: string | null;
  supplierName: string;
  productName: string;
  caliber?: string | null;
  nbrColis: string | number;
  poidsEmballageVide: string | number;
  avanceOui: boolean;
  avanceMontant: string | number;
  observations?: string | null;
  droitMarche?: string | number;
  transport?: string | number;
  bordereauRef?: string | null;
  lotNumber?: string | null;
  // Multi-calibres : lignes calibre (si présentes, remplacent l'affichage mono)
  items?: { calibre?: string | null; nbrColis: string | number; poidsEmballageVide: string | number; lotNumber?: string | null }[];
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
 * Construit le PDF A5 (portrait) du bon de réception. Renvoie le PDFDocument.
 */
export function buildReceptionPdf(r: ReceptionPdfDTO, company: CompanyParams): PDFKit.PDFDocument {
  const cp = { ...DEFAULTS, ...stripNulls(company) };

  const doc = new PDFDocument({
    size: 'a5', // A5 portrait (419.53 x 595.28)
    margin: 28,
    info: {
      Title: `Bon de réception ${r.reference}`,
      Author: cp.mandataireNameFr || 'Fruiterie',
    },
  });

  doc.registerFont('Amiri', AR_FONT);
  doc.font('Helvetica');

  const pageW = 419.53;
  const m = doc.page.margins.left;
  const contentW = pageW - doc.page.margins.left - doc.page.margins.right;

  // ---------------- EN-TÊTE SOCIÉTÉ ----------------
  const headerTop = doc.y;
  const colW = contentW / 2;
  // gauche : société
  doc.font('Amiri').fontSize(10).text(shapeArabic(cp.mandataireNameAr || ''), m, headerTop, { width: colW, align: 'left' });
  doc.font('Helvetica-Bold').fontSize(11).text(cp.mandataireNameFr || '', m, doc.y + 1, { width: colW, align: 'left' });
  doc.font('Helvetica').fontSize(7).text(cp.activity || '', m, doc.y + 1, { width: colW });
  doc.text(cp.market || '', m, doc.y + 1, { width: colW });
  doc.font('Helvetica-Bold').fontSize(7).text(`Carreau N° ${cp.carreau || ''}`, m, doc.y + 1, { width: colW });
  const leftBottom = doc.y;

  // droite : référence + date
  doc.font('Helvetica-Bold').fontSize(9).text(`N° ${r.reference}`, m + colW, headerTop, { width: colW, align: 'right' });
  doc.font('Helvetica').fontSize(8).text(`Date : ${fmtDate(r.date)}`, m + colW, doc.y + 2, { width: colW, align: 'right' });
  if (r.heure) doc.text(`Heure : ${r.heure}`, m + colW, doc.y + 1, { width: colW, align: 'right' });
  const rightBottom = doc.y;

  // ---------------- CODE-BARRES (EAN13 centré, dans l'en-tête, avant la ligne) ----------------
  const bcY = Math.max(leftBottom, rightBottom) + 4;
  const yApresBc = drawBarcodeFooter(doc, r.barcodes, { x: m, y: bcY, contentW, width: 150 });
  const afterHeader = yApresBc + 4;
  doc.moveTo(m, afterHeader).lineTo(m + contentW, afterHeader).lineWidth(1).stroke();

  // ---------------- TITRE ----------------
  let y = afterHeader + 8;
  doc.font('Amiri').fontSize(16).text(shapeArabic('إذن استلام'), m, y, { width: contentW, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(15).text('BON DE RÉCEPTION', m, doc.y + 2, { width: contentW, align: 'center' });
  y = doc.y + 12;

  // ---------------- CORPS : lignes clé/valeur ----------------
  const multi = (r.items?.length ?? 0) > 1;
  const rows: { fr: string; ar: string; value: string }[] = multi
    ? [
        { fr: 'Fournisseur', ar: 'المورد', value: r.supplierName || '—' },
        { fr: 'Produit', ar: 'المنتج', value: r.productName || '—' },
        { fr: 'Nombre total de colis', ar: 'مجموع الطرود', value: fmt(r.nbrColis, 0) },
        {
          fr: 'Avance',
          ar: 'السلفة',
          value: r.avanceOui ? `Oui — ${fmt(r.avanceMontant, 2)} DA` : 'Non',
        },
        { fr: 'Droit de marché', ar: 'حق السوق', value: fmt(r.droitMarche, 2) + ' DA' },
        { fr: 'Transport', ar: 'النقل', value: fmt(r.transport, 2) + ' DA' },
        { fr: 'Bordereau', ar: 'البردية', value: r.bordereauRef || '—' },
      ]
    : [
        { fr: 'Fournisseur', ar: 'المورد', value: r.supplierName || '—' },
        { fr: 'Produit', ar: 'المنتج', value: (r.productName || '—') + (r.caliber ? ` / ${r.caliber}` : '') },
        { fr: 'Nombre de colis', ar: 'عدد الطرود', value: fmt(r.nbrColis, 0) },
        { fr: "Poids d'un emballage vide (kg)", ar: 'وزن الغلاف الفارغ (كغ)', value: fmt(r.poidsEmballageVide, 2) },
        {
          fr: 'Avance',
          ar: 'السلفة',
          value: r.avanceOui ? `Oui — ${fmt(r.avanceMontant, 2)} DA` : 'Non',
        },
        { fr: 'Droit de marché', ar: 'حق السوق', value: fmt(r.droitMarche, 2) + ' DA' },
        { fr: 'Transport', ar: 'النقل', value: fmt(r.transport, 2) + ' DA' },
        { fr: 'Bordereau', ar: 'البردية', value: r.bordereauRef || '—' },
        { fr: 'Lot', ar: 'الحصة', value: r.lotNumber || '—' },
      ];

  const rowH = 30;
  const labelW = contentW * 0.5;
  const valX = m + labelW;
  const valW = contentW - labelW;

  for (const row of rows) {
    doc.rect(m, y, contentW, rowH).lineWidth(0.6).stroke('#000000');
    doc.moveTo(valX, y).lineTo(valX, y + rowH).lineWidth(0.5).stroke();
    // label bilingue : arabe en haut, français en bas
    doc.font('Amiri').fontSize(8).fillColor('#000000').text(shapeArabic(row.ar), m + 5, y + 4, { width: labelW - 10, align: 'left' });
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#000000').text(row.fr, m + 5, y + 16, { width: labelW - 10, align: 'left' });
    // valeur
    doc.font('Helvetica').fontSize(9).fillColor('#000000').text(row.value, valX + 5, y + rowH / 2 - 6, { width: valW - 10, align: 'left' });
    y += rowH;
  }

  // ---------------- TABLE DES LIGNES CALIBRE (multi) ----------------
  if (multi && r.items) {
    y += 8;
    doc.font('Helvetica-Bold').fontSize(9).text('Détail par calibre / ', m, y);
    doc.font('Amiri').fontSize(9).text(shapeArabic('التفصيل حسب المعيار'), m + doc.widthOfString('Détail par calibre / '), y);
    y = doc.y + 3;
    const cols = [
      { fr: 'Calibre', w: 0.28 },
      { fr: 'Colis', w: 0.18 },
      { fr: 'Emb. vide (kg)', w: 0.24 },
      { fr: 'Lot', w: 0.30 },
    ];
    const cx: number[] = [];
    let acc2 = m;
    for (const c of cols) { cx.push(acc2); acc2 += c.w * contentW; }
    const th = 16;
    const drawR = (cells: string[], yy: number, bold = false) => {
      for (let i = 0; i < cols.length; i++) {
        const w = cols[i].w * contentW;
        doc.rect(cx[i], yy, w, th).lineWidth(0.4).stroke('#000000');
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5).fillColor('#000000')
          .text(cells[i], cx[i] + 3, yy + 4, { width: w - 6, align: i === 1 || i === 2 ? 'right' : 'left' });
      }
    };
    drawR(cols.map((c) => c.fr), y, true);
    y += th;
    for (const it of r.items) {
      drawR([it.calibre || '—', fmt(it.nbrColis, 0), fmt(it.poidsEmballageVide, 2), it.lotNumber || '—'], y);
      y += th;
    }
    doc.y = y;
  }

  // ---------------- OBSERVATIONS ----------------
  y += 8;
  doc.font('Amiri').fontSize(8).text(shapeArabic('ملاحظات'), m, y, { width: contentW, align: 'left' });
  doc.font('Helvetica-Bold').fontSize(8).text('Observations :', m, doc.y + 1, { width: contentW, align: 'left' });
  doc.font('Helvetica').fontSize(8).text(r.observations || '—', m, doc.y + 2, { width: contentW, align: 'left' });

  // ---------------- SIGNATURE ----------------
  const sigY = doc.y + 24;
  const sigW = contentW * 0.45;
  const sigX = m + contentW - sigW;
  doc.moveTo(sigX, sigY).lineTo(sigX + sigW, sigY).lineWidth(0.6).stroke();
  doc.font('Helvetica').fontSize(8).text('Cachet & Signature', sigX, sigY + 3, { width: sigW, align: 'center' });
  doc.font('Amiri').fontSize(8).text(shapeArabic('الختم والتوقيع'), sigX, doc.y + 1, { width: sigW, align: 'center' });

  return doc;
}
