// =====================================================================
// Générateur PDF A4 du BON DE PAIEMENT FOURNISSEUR (BP-xxxx).
// Style aligné sur les autres PDF du projet (pdfkit + EAN13 centré).
// =====================================================================
import PDFDocument = require('pdfkit');
import { Prisma } from '@prisma/client';

export interface SupplierPaymentPdfLine {
  bordereauRef: string;
  dateCloture?: string | null;
  montantDuAvant: string | number;
  montantPaye: string | number;
  reste: string | number;
}

export interface SupplierPaymentPdfDTO {
  reference: string;
  date: string;
  mode: string;
  method: string;
  totalAmount: string | number;
  notes?: string | null;
  ean13?: string | null;
}

function fmt(n: string | number | Prisma.Decimal | null | undefined, dp = 2): string {
  if (n === null || n === undefined || n === '') return '0.00';
  try {
    return new Prisma.Decimal(n as any).toFixed(dp);
  } catch {
    return String(n);
  }
}

function fmtDate(s?: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? String(s) : d.toLocaleDateString('fr-FR');
}

const MODE_LABEL: Record<string, string> = { PAY: 'Payer', ENCAISSER: 'Encaisser' };
const METHOD_LABEL: Record<string, string> = {
  CASH: 'Espèces',
  BANK_TRANSFER: 'Virement',
  CHECK: 'Chèque',
  CARD: 'Carte',
};

/**
 * Construit le PDF A4 du bon de paiement fournisseur.
 * @param payment infos du bon
 * @param lines lignes (un bordereau par ligne)
 * @param supplier fournisseur (nom + coordonnées facultatives)
 * @param eanPng PNG EAN13 pré-rendu (optionnel)
 */
export function buildSupplierPaymentPdf(
  payment: SupplierPaymentPdfDTO,
  lines: SupplierPaymentPdfLine[],
  supplier: { name: string; phone?: string | null; wilaya?: string | null },
  eanPng?: Buffer | null,
): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    size: 'a4',
    margin: 40,
    info: { Title: `Bon de paiement fournisseur ${payment.reference}`, Author: 'Fruiterie' },
  });

  const left = 40;
  const contentW = 595.28 - 80;

  // --- EAN13 centré en haut (si présent) ---
  if (eanPng) {
    const bcW = 130;
    try {
      doc.image(eanPng, left + (contentW - bcW) / 2, doc.y, { width: bcW });
      doc.y += bcW * 0.4 + 12;
    } catch {
      /* non bloquant */
    }
  }

  // --- Titre ---
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#000')
    .text('BON DE PAIEMENT FOURNISSEUR', left, doc.y, { width: contentW, align: 'center' });
  doc.moveDown(1);

  // --- En-tête infos ---
  const infoY = doc.y;
  doc.font('Helvetica').fontSize(10);
  const infoL = [
    ['Référence', payment.reference],
    ['Date', fmtDate(payment.date)],
    ['Mode', MODE_LABEL[payment.mode] ?? payment.mode],
    ['Méthode', METHOD_LABEL[payment.method] ?? payment.method],
  ];
  const infoR = [
    ['Fournisseur', supplier.name],
    ['Téléphone', supplier.phone || '—'],
    ['Wilaya', supplier.wilaya || '—'],
  ];
  let y = infoY;
  for (const [k, v] of infoL) {
    doc.font('Helvetica-Bold').text(`${k} :`, left, y, { width: 80, continued: false });
    doc.font('Helvetica').text(String(v), left + 85, y, { width: 180 });
    y += 15;
  }
  let y2 = infoY;
  for (const [k, v] of infoR) {
    doc.font('Helvetica-Bold').text(`${k} :`, left + 300, y2, { width: 80 });
    doc.font('Helvetica').text(String(v), left + 380, y2, { width: 135 });
    y2 += 15;
  }
  doc.y = Math.max(y, y2) + 10;

  // --- Tableau ---
  const cols = [
    { label: 'Réf. bordereau', w: 110, align: 'left' as const },
    { label: 'Date clôture', w: 90, align: 'center' as const },
    { label: 'Montant dû', w: 105, align: 'right' as const },
    { label: 'Montant payé', w: 105, align: 'right' as const },
    { label: 'Reste', w: 105, align: 'right' as const },
  ];
  const rowH = 20;
  let ty = doc.y;

  doc.rect(left, ty, contentW, rowH).fill('#e8e8e8');
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(9);
  let cx = left;
  for (const c of cols) {
    doc.text(c.label, cx + 4, ty + 6, { width: c.w - 8, align: c.align });
    cx += c.w;
  }
  ty += rowH;

  doc.font('Helvetica').fontSize(9);
  for (const l of lines) {
    if (ty > 760) {
      doc.addPage();
      ty = 40;
    }
    doc.rect(left, ty, contentW, rowH).stroke('#cccccc');
    const vals = [
      l.bordereauRef,
      fmtDate(l.dateCloture ?? null),
      fmt(l.montantDuAvant) + ' DA',
      fmt(l.montantPaye) + ' DA',
      fmt(l.reste) + ' DA',
    ];
    cx = left;
    for (let i = 0; i < cols.length; i++) {
      doc.fillColor('#000').text(vals[i], cx + 4, ty + 6, { width: cols[i].w - 8, align: cols[i].align });
      cx += cols[i].w;
    }
    ty += rowH;
  }

  // --- Total ---
  doc.rect(left, ty, contentW, rowH + 4).fill('#f2f2f2');
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(11)
    .text('TOTAL', left + 4, ty + 7, { width: contentW - 120 })
    .text(fmt(payment.totalAmount) + ' DA', left + contentW - 160, ty + 7, { width: 156, align: 'right' });
  ty += rowH + 14;

  if (payment.notes) {
    doc.font('Helvetica').fontSize(9).fillColor('#333')
      .text(`Observations : ${payment.notes}`, left, ty, { width: contentW });
    ty = doc.y + 10;
  }

  // --- Signatures ---
  doc.font('Helvetica').fontSize(9).fillColor('#000');
  doc.text('Signature fournisseur', left, ty + 30, { width: 200 });
  doc.text('Signature mandataire', left + contentW - 200, ty + 30, { width: 200, align: 'right' });

  return doc;
}
