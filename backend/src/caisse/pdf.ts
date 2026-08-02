// =====================================================================
// Générateur PDF du « BORDEREAU DE CAISSE » — format A5 portrait.
// Reproduit le bordereau papier : deux colonnes (ENTREES / SORTIES),
// TOTAUX par colonne, ECART et case V.B.C (valeur à reporter).
// =====================================================================
import PDFDocument = require('pdfkit');

/** Données nécessaires au rendu (montants en chaînes ou nombres). */
export interface BordereauCaissePdfDTO {
  date: string; // YYYY-MM-DD
  statut: string;
  // Entrées
  encaissementReelVentes: string | number;
  creditCollectionTotal: string | number;
  openingCashFund: string | number;
  cashSupplyTotal: string | number;
  consignation?: string | number;
  totalEntries: string | number;
  // Sorties
  expenseTotal: string | number;
  creditInvoiceTotal: string | number;
  closingCashFund: string | number;
  cashRemittanceTotal: string | number;
  deconsignation?: string | number;
  totalOutputs: string | number;
  // Commun
  difference: string | number;
}

/** Formate un montant en « 1 234.56 » (séparateur milliers = espace). */
function fmtDA(v: string | number | undefined | null): string {
  const n = Number(v ?? 0);
  if (!isFinite(n)) return '0.00';
  const [ent, dec] = Math.abs(n).toFixed(2).split('.');
  const avecEspaces = ent.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${n < 0 ? '-' : ''}${avecEspaces}.${dec}`;
}

/** Formate une date ISO (YYYY-MM-DD) en JJ/MM/AAAA. */
function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/**
 * Construit le PDF A5 portrait du bordereau de caisse.
 * Renvoie le PDFDocument (l'appelant fait doc.pipe(res) puis doc.end()).
 */
export function buildBordereauCaissePdf(r: BordereauCaissePdfDTO): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    size: 'A5', // A5 portrait : 419.53 x 595.28 pt
    margin: 30,
    info: { Title: `Bordereau de caisse ${r.date}`, Author: 'Fruiterie ERP' },
  });

  const m = doc.page.margins.left;
  const contentW = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // ---------------- TITRE ----------------
  doc.font('Helvetica-Bold').fontSize(15).text('BORDEREAU DE CAISSE', m, m, {
    width: contentW,
    align: 'center',
  });
  doc.font('Helvetica').fontSize(10).text(`Journée du : ${fmtDate(r.date)}`, m, doc.y + 4, {
    width: contentW,
    align: 'center',
  });

  let y = doc.y + 12;

  // ---------------- TABLEAU 2 COLONNES ----------------
  const gap = 10;
  const colW = (contentW - gap) / 2;
  const xGauche = m;
  const xDroite = m + colW + gap;
  const rowH = 20;
  const padX = 5;

  /** Dessine l'en-tête d'une colonne. */
  const enTete = (x: number, titre: string) => {
    doc.rect(x, y, colW, rowH).fillAndStroke('#e5e7eb', '#000000');
    doc
      .fillColor('#000000')
      .font('Helvetica-Bold')
      .fontSize(10)
      .text(titre, x, y + 6, { width: colW, align: 'center' });
  };

  /** Dessine une ligne « libellé / montant » dans une colonne. */
  const ligne = (
    x: number,
    yy: number,
    libelle: string,
    montant: string,
    gras = false,
  ) => {
    doc.rect(x, yy, colW, rowH).stroke('#000000');
    doc
      .fillColor('#000000')
      .font(gras ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(9)
      .text(libelle, x + padX, yy + 6, { width: colW * 0.55 - padX, align: 'left' });
    doc
      .font(gras ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(9)
      .text(montant, x + colW * 0.55, yy + 6, { width: colW * 0.45 - padX, align: 'right' });
  };

  // En-têtes
  enTete(xGauche, 'ENTREES');
  enTete(xDroite, 'SORTIES');
  y += rowH;

  // Libellés exacts du bordereau papier.
  const entrees: [string, string, boolean][] = [
    ['LES VENTES', fmtDA(r.encaissementReelVentes), false],
    ['TOUTES LES FACTURES', fmtDA(r.creditCollectionTotal), false],
    ['ENCIEN F.CAISSE', fmtDA(r.openingCashFund), false],
    ['APPRO CAISSE', fmtDA(r.cashSupplyTotal), false],
    ['CONSIGNATION', fmtDA(r.consignation ?? 0), false],
    ['TOTAUX', fmtDA(r.totalEntries), true],
    ['ECART S/C (+)', fmtDA(r.difference), false],
  ];
  const sorties: [string, string, boolean][] = [
    ['LES DEPENSES', fmtDA(r.expenseTotal), false],
    ['VENTES CREDITS', fmtDA(r.creditInvoiceTotal), false],
    ['NOUV F.CAISSE', fmtDA(r.closingCashFund), false],
    ['REMISES ESPECES', fmtDA(r.cashRemittanceTotal), false],
    ['DECONSIGNATION', fmtDA(r.deconsignation ?? 0), false],
    ['TOTAUX', fmtDA(r.totalOutputs), true],
    ['ECART S/C (+)', fmtDA(r.difference), false],
  ];

  const nbLignes = Math.max(entrees.length, sorties.length);
  for (let i = 0; i < nbLignes; i++) {
    const yy = y + i * rowH;
    const g = entrees[i];
    const d = sorties[i];
    if (g) ligne(xGauche, yy, g[0], g[1], g[2]);
    else doc.rect(xGauche, yy, colW, rowH).stroke('#000000');
    if (d) ligne(xDroite, yy, d[0], d[1], d[2]);
    else doc.rect(xDroite, yy, colW, rowH).stroke('#000000');
  }
  y += nbLignes * rowH;

  // ---------------- CASE V.B.C (valeur à reporter) ----------------
  y += 14;
  const vbcH = 26;
  doc.rect(xGauche, y, colW, vbcH).stroke('#000000');
  doc
    .fillColor('#000000')
    .font('Helvetica-Bold')
    .fontSize(10)
    .text('V.B.C', xGauche + padX, y + 8, { width: colW * 0.4, align: 'left' });
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .text(fmtDA(r.closingCashFund), xGauche + colW * 0.4, y + 8, {
      width: colW * 0.6 - padX,
      align: 'right',
    });
  doc
    .font('Helvetica')
    .fontSize(7)
    .fillColor('#555555')
    .text('(valeur à reporter — nouveau fonds de caisse)', xDroite, y + 10, {
      width: colW,
      align: 'left',
    });

  y += vbcH + 16;

  // ---------------- PIED DE PAGE ----------------
  doc.moveTo(m, y).lineTo(m + contentW, y).lineWidth(0.5).stroke('#999999');
  doc
    .fillColor('#666666')
    .font('Helvetica')
    .fontSize(8)
    .text(`Fruiterie ERP — Statut de la journée : ${r.statut}`, m, y + 5, {
      width: contentW,
      align: 'center',
    });

  return doc;
}
