// =====================================================================
// Générateur PDF bilingue (FR + AR, RTL) du bulletin d'achat.
// pdfkit + police Amiri (arabe). A4 / A5 paysage. Noir & blanc lisible.
// =====================================================================
import PDFDocument = require('pdfkit');
import * as path from 'path';
import { Prisma } from '@prisma/client';
import { shapeArabic } from './shape';
import type { BulletinDTO } from './types';

const FONT_DIR = path.join(__dirname, '..', '..', '..', 'assets', 'fonts');

// Police : Amiri pour l'arabe, Helvetica (standard) pour le latin/FR.
const AR_FONT = path.join(FONT_DIR, 'Amiri-Regular.ttf');

// Valeurs par défaut (exemple KHENOUCHI) — surchargées par CompanySettings.
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

export interface CompanyParams {
  mandataireNameAr?: string | null;
  mandataireNameFr?: string | null;
  activity?: string | null;
  market?: string | null;
  carreau?: string | null;
  mentionFr?: string | null;
  mentionAr?: string | null;
  companyName?: string | null;
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

/**
 * Construit le document PDF (stream). Renvoie le PDFDocument (qu'on pipe
 * vers la réponse HTTP). Le format A4/A5 est en paysage.
 */
export function buildBulletinPdf(
  bulletin: BulletinDTO,
  company: CompanyParams,
  format: PdfFormat = 'a4',
): PDFKit.PDFDocument {
  const cp = { ...DEFAULTS, ...stripNulls(company) };

  const isA5 = format === 'a5';
  // Paysage : [largeur, hauteur].
  const size: [number, number] = isA5
    ? [841.89, 595.28] // A5 paysage
    : [841.89, 595.28]; // A4 paysage
  // Note : A4 = 842x595, A5 = 595x420 en paysage. On utilise les deux paysage.
  const pageSize: [number, number] = isA5 ? [595.28, 420.94] : [841.89, 595.28];

  const doc = new PDFDocument({
    size: pageSize,
    layout: 'landscape',
    margin: isA5 ? 24 : 36,
    info: {
      Title: `Bulletin d'achat ${bulletin.reference}`,
      Author: cp.mandataireNameFr || 'Fruiterie',
    },
  });

  doc.registerFont('Amiri', AR_FONT);
  doc.font('Helvetica');

  const pageW = pageSize[0];
  const pageH = pageSize[1];
  const m = doc.page.margins.left;
  const contentW = pageW - doc.page.margins.left - doc.page.margins.right;

  // ---------------------------------------------------------------
  // EN-TÊTE : 3 colonnes (gauche mandataire / centre titre / droite n°)
  // ---------------------------------------------------------------
  const headerTop = doc.y;
  const colLeftW = contentW * 0.34;
  const colCenterW = contentW * 0.34;
  const colRightW = contentW * 0.32;
  const colLeftX = m;
  const colCenterX = m + colLeftW;
  const colRightX = m + colLeftW + colCenterW;

  // --- Bloc gauche : mandataire ---
  doc.fontSize(isA5 ? 9 : 11).font('Amiri').text(shapeArabic(cp.mandataireNameAr || ''), colLeftX, headerTop, { width: colLeftW, align: 'left' });
  doc.font('Helvetica').fontSize(isA5 ? 10 : 12).text(cp.mandataireNameFr || '', colLeftX, doc.y + 2, { width: colLeftW, align: 'left' });
  doc.fontSize(isA5 ? 7 : 8).text(cp.activity || '', colLeftX, doc.y + 2, { width: colLeftW });
  doc.text(cp.market || '', colLeftX, doc.y + 1, { width: colLeftW });
  doc.font('Helvetica-Bold').text(`Carreau N° ${cp.carreau || ''}`, colLeftX, doc.y + 1, { width: colLeftW });

  // --- Bloc centre : titre ---
  const centerY = headerTop;
  doc.font('Amiri').fontSize(isA5 ? 16 : 20).text(shapeArabic('بيان الشراء'), colCenterX, centerY, { width: colCenterW, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(isA5 ? 12 : 15).text(`BULLETIN D'ACHAT`, colCenterX, doc.y + 2, { width: colCenterW, align: 'center' });
  doc.font('Helvetica').fontSize(isA5 ? 9 : 11).text(`N° ${bulletin.reference}`, colCenterX, doc.y + 2, { width: colCenterW, align: 'center' });

  // --- Bloc droite : n° + champs + carreau ---
  doc.font('Helvetica-Bold').fontSize(isA5 ? 9 : 11).text(`N° ${padRef(bulletin.reference)}`, colRightX, headerTop, { width: colRightW, align: 'right' });
  doc.font('Helvetica').fontSize(isA5 ? 7 : 8);
  doc.text(`Marque : ${bulletin.marque || ''}`, colRightX, doc.y + 2, { width: colRightW, align: 'right' });
  doc.text(`Emb. : ${bulletin.emballage || ''}`, colRightX, doc.y + 1, { width: colRightW, align: 'right' });
  doc.text(`Consig. : ${bulletin.consigne || ''}`, colRightX, doc.y + 1, { width: colRightW, align: 'right' });
  // Ovale « Carreau : 62 »
  const ovalY = doc.y + 4;
  const ovalW = isA5 ? 70 : 90;
  const ovalH = isA5 ? 22 : 28;
  const ovalX = colRightX + colRightW - ovalW;
  doc.lineWidth(1).ellipse(ovalX + ovalW / 2, ovalY + ovalH / 2, ovalW / 2, ovalH / 2).stroke();
  doc.fontSize(isA5 ? 8 : 10).text(`Carreau : ${cp.carreau || ''}`, ovalX, ovalY, { width: ovalW, height: ovalH, align: 'center' });

  // Ligne de séparation
  const headerBottom = Math.max(doc.y, ovalY + ovalH) + 8;
  doc.moveTo(m, headerBottom).lineTo(m + contentW, headerBottom).lineWidth(1.2).stroke();
  doc.y = headerBottom + 4;

  // ---------------------------------------------------------------
  // « Délivré à M … » + چاپ
  // ---------------------------------------------------------------
  doc.font('Helvetica').fontSize(isA5 ? 8 : 9);
  doc.text(`Délivré à M ${bulletin.deliveredTo || '……………………………………………………'}`, m, doc.y, { width: contentW });
  // Arabic line to the right (RTL)
  doc.font('Amiri').fontSize(isA5 ? 8 : 9).text(shapeArabic('إلى السيد ………………'), m, doc.y - (isA5 ? 10 : 11), { width: contentW, align: 'right' });
  doc.y += 4;

  // ---------------------------------------------------------------
  // TABLEAU
  // ---------------------------------------------------------------
  const tableTop = doc.y;
  // Colonnes (gauche -> droite) :
  const cols = [
    { key: 'marque',     ar: 'الأصل',        fr: 'Marque',       w: 0.13 },
    { key: 'nbrColis',   ar: 'عدد السلع',     fr: 'N. colis',     w: 0.10 },
    { key: 'nature',     ar: 'طبيعة المواد',   fr: 'Nature produits', w: 0.25 },
    { key: 'poids',      ar: 'وزن',           fr: 'Poids',        w: 0.22, sub: [
        { ar: 'المحاسبه', fr: 'Brut' },
        { ar: 'الناقص', fr: 'Tare' },
        { ar: 'الصافي', fr: 'Net' },
    ] },
    { key: 'prix',       ar: 'ثمن الوحدة',     fr: 'Prix unitaire', w: 0.13 },
    { key: 'montant',    ar: 'المجموع',        fr: 'Montant (DA)', w: 0.17 },
  ];

  const colXs: number[] = [];
  let cx = m;
  for (const c of cols) {
    colXs.push(cx);
    cx += contentW * c.w;
  }
  const colEnd = m + contentW;

  const headH = isA5 ? 26 : 32;
  const subH = isA5 ? 12 : 14;
  const rowH = isA5 ? 18 : 22;
  const items = bulletin.items;

  // Bas de la zone utile : on réserve de la place pour TOTAL + signature +
  // mentions. Aucune ligne n'est dessinée en deçà ; au-delà => saut de page.
  const pageBottomLimit = pageH - doc.page.margins.bottom - (isA5 ? 70 : 90);

  // Dessine l'en-tête du tableau à la position courante (doc.y). Redessiné sur
  // CHAQUE page pour le saut de page automatique — jamais de coord Y fixe.
  const drawHeader = () => {
    const top = doc.y;
    doc.rect(m, top, contentW, headH + subH).fillAndStroke('#ffffff', '#000000');
    doc.lineWidth(0.8);
    const fontSizeH = isA5 ? 8 : 9;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      const x0 = colXs[i];
      const x1 = i < cols.length - 1 ? colXs[i + 1] : colEnd;
      const w = x1 - x0;
      doc.font('Amiri').fontSize(fontSizeH + 1).fillColor('#000000')
        .text(shapeArabic(c.ar), x0 + 1, top + 1, { width: w - 2, align: 'center' });
      doc.font('Helvetica-Bold').fontSize(fontSizeH)
        .text(c.fr, x0 + 1, top + (c.sub ? subH : (headH - fontSizeH) / 2 + 1), { width: w - 2, align: 'center' });
      if (i > 0) doc.moveTo(x0, top).lineTo(x0, top + headH + subH).lineWidth(0.6).stroke();
    }
    const poidsIdx = cols.findIndex((c) => c.key === 'poids');
    if (poidsIdx >= 0) {
      const px0 = colXs[poidsIdx];
      const px1 = poidsIdx < cols.length - 1 ? colXs[poidsIdx + 1] : colEnd;
      doc.moveTo(px0, top + subH).lineTo(px1, top + subH).lineWidth(0.6).stroke();
      const third = (px1 - px0) / 3;
      doc.font('Amiri').fontSize(fontSizeH);
      doc.text(shapeArabic(cols[poidsIdx].sub![0].ar), px0, top + 1, { width: third, align: 'center' });
      doc.text(shapeArabic(cols[poidsIdx].sub![1].ar), px0 + third, top + 1, { width: third, align: 'center' });
      doc.text(shapeArabic(cols[poidsIdx].sub![2].ar), px0 + 2 * third, top + 1, { width: third, align: 'center' });
      doc.font('Helvetica').fontSize(fontSizeH - 1);
      doc.text(cols[poidsIdx].sub![0].fr, px0, top + subH + 1, { width: third, align: 'center' });
      doc.text(cols[poidsIdx].sub![1].fr, px0 + third, top + subH + 1, { width: third, align: 'center' });
      doc.text(cols[poidsIdx].sub![2].fr, px0 + 2 * third, top + subH + 1, { width: third, align: 'center' });
      doc.moveTo(px0 + third, top + subH).lineTo(px0 + third, top + headH + subH).lineWidth(0.5).stroke();
      doc.moveTo(px0 + 2 * third, top + subH).lineTo(px0 + 2 * third, top + headH + subH).lineWidth(0.5).stroke();
    }
    doc.y = top + headH + subH;
  };

  // Dessine une ligne de données à la position courante (doc.y) — suit doc.y.
  const drawRow = (it?: BulletinDTO['items'][number]) => {
    const top = doc.y;
    doc.rect(m, top, contentW, rowH).stroke();
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      const x0 = colXs[i];
      const x1 = i < cols.length - 1 ? colXs[i + 1] : colEnd;
      const w = x1 - x0;
      if (i > 0) doc.moveTo(x0, top).lineTo(x0, top + rowH).lineWidth(0.5).stroke();
      doc.font('Helvetica').fontSize(isA5 ? 7 : 8).fillColor('#000000');
      if (c.key === 'marque') {
        doc.text(it?.marque || (it ? it.productName : ''), x0 + 2, top + 4, { width: w - 4, align: 'center' });
      } else if (c.key === 'nbrColis') {
        doc.text(it ? fmt(it.nbrColis, 0) : '', x0 + 2, top + 4, { width: w - 4, align: 'center' });
      } else if (c.key === 'nature') {
        doc.text(it ? it.productName : '', x0 + 2, top + 4, { width: w - 4, align: 'center' });
      } else if (c.key === 'poids') {
        const third = w / 3;
        doc.text(it ? fmt(it.poidsBrut, 2) : '', x0 + 1, top + 4, { width: third, align: 'center' });
        doc.text(it ? fmt(it.tare, 2) : '', x0 + third + 1, top + 4, { width: third, align: 'center' });
        doc.text(it ? fmt(it.poidsNet, 2) : '', x0 + 2 * third + 1, top + 4, { width: third, align: 'center' });
        doc.moveTo(x0 + third, top).lineTo(x0 + third, top + rowH).lineWidth(0.4).stroke();
        doc.moveTo(x0 + 2 * third, top).lineTo(x0 + 2 * third, top + rowH).lineWidth(0.4).stroke();
      } else if (c.key === 'prix') {
        doc.text(it ? fmt(it.prixUnitaire, 2) : '', x0 + 2, top + 4, { width: w - 4, align: 'center' });
      } else if (c.key === 'montant') {
        doc.text(it ? fmt(it.montant, 2) : '', x0 + 2, top + 4, { width: w - 4, align: 'center' });
      }
    }
    doc.y = top + rowH;
  };

  // Bordures verticales + bas du bloc tableau de la page courante.
  let pageTopY = doc.y;
  const closePageBorders = () => {
    const bottom = doc.y;
    doc.moveTo(m, pageTopY).lineTo(m, bottom).lineWidth(0.8).stroke();
    doc.moveTo(colEnd, pageTopY).lineTo(colEnd, bottom).lineWidth(0.8).stroke();
    doc.moveTo(m, bottom).lineTo(colEnd, bottom).lineWidth(0.8).stroke();
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
  // Complète avec des lignes vides pour la lisibilité (si peu de lignes,
  // 1re page uniquement — ne pousse JAMAIS hors page).
  const minRows = 3;
  if (items.length < minRows) {
    for (let r = items.length; r < minRows; r++) {
      ensureRowSpace();
      drawRow(undefined);
    }
  }

  // Bordure bas du dernier bloc de page + avance le curseur.
  closePageBorders();
  doc.y += 6;

  // ---------------------------------------------------------------
  // BAS : TOTAL (droite) + signature (gauche) + mention
  // ---------------------------------------------------------------
  const footerY = doc.y;
  // Signature à gauche
  doc.font('Helvetica').fontSize(isA5 ? 7 : 8);
  const sigX = m;
  const sigW = contentW * 0.4;
  doc.moveTo(sigX, footerY + 18).lineTo(sigX + sigW, footerY + 18).lineWidth(0.6).stroke();
  doc.text('Signature & Date', sigX, footerY + 20, { width: sigW });
  doc.font('Amiri').text(shapeArabic('التوقيع والتاريخ'), sigX, footerY + 30, { width: sigW });

  // TOTAL à droite
  const totW = contentW * 0.3;
  const totX = m + contentW - totW;
  doc.font('Helvetica-Bold').fontSize(isA5 ? 10 : 12);
  doc.text(`TOTAL : ${fmt(bulletin.totalAmount, 2)} DA`, totX, footerY, { width: totW, align: 'right' });
  doc.font('Amiri').fontSize(isA5 ? 9 : 11).text(shapeArabic(`الإجمالي : ${fmt(bulletin.totalAmount, 2)} دج`), totX, footerY + (isA5 ? 14 : 16), { width: totW, align: 'right' });

  // Mentions légales (centrées, bas de page)
  const mentionY = pageH - doc.page.margins.bottom - (isA5 ? 26 : 30);
  doc.font('Helvetica-Oblique').fontSize(isA5 ? 6.5 : 8);
  doc.text(cp.mentionFr || '', m, mentionY, { width: contentW, align: 'center' });
  doc.font('Amiri').fontSize(isA5 ? 7 : 9);
  doc.text(shapeArabic(cp.mentionAr || ''), m, doc.y + 1, { width: contentW, align: 'center' });

  return doc;
}

function padRef(ref: string): string {
  // Pour l'affichage « N° 0006196 » : on complète avec des zéros si numérique.
  const num = ref.replace(/\D/g, '');
  if (!num) return ref;
  return num.padStart(7, '0');
}

function stripNulls<T extends object>(obj: T): Partial<T> {
  const out: any = {};
  for (const k of Object.keys(obj) as (keyof T)[]) {
    const v = obj[k];
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}
