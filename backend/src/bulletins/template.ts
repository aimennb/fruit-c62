// =====================================================================
// Template HTML/CSS bilingue (FR + AR, RTL) du bulletin d'achat.
// Aperçu web (GET /api/bulletins/:id/template). Récrée proprement le
// bulletin papier KHENOUCHI, sans photo en fond. FR (LTR) + AR (RTL).
// =====================================================================
import { Prisma } from '@prisma/client';
import type { BulletinDTO } from './types';

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

function esc(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmt(n: string | number | Prisma.Decimal | null, dp = 2): string {
  if (n === null || n === undefined || n === '') return '0';
  try {
    return new Prisma.Decimal(n).toFixed(dp);
  } catch {
    return String(n);
  }
}

/** Renvoie le HTML complet (document) du bulletin pour aperçu navigateur. */
export function renderBulletinHtml(bulletin: BulletinDTO, company: CompanyParams): string {
  const cp = { ...DEFAULTS, ...strip(company) };
  const items = bulletin.items;

  const rows = items
    .map(
      (it) => `<tr>
      <td>${esc(it.marque || it.productName)}</td>
      <td>${fmt(it.nbrColis, 0)}</td>
      <td>${esc(it.productName)}</td>
      <td>${fmt(it.poidsBrut)}</td>
      <td>${fmt(it.tare)}</td>
      <td>${fmt(it.poidsNet)}</td>
      <td>${fmt(it.prixUnitaire)}</td>
      <td>${fmt(it.montant)}</td>
    </tr>`,
    )
    .join('');

  // Lignes vides pour remplir le tableau
  const emptyRows = Math.max(0, 6 - items.length);
  const blanks = Array.from({ length: emptyRows })
    .map(() => `<tr>${'<td>&nbsp;</td>'.repeat(8)}</tr>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="fr" dir="ltr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Bulletin d'achat ${esc(bulletin.reference)}</title>
<link href="https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root { --ink:#111; --line:#000; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Roboto, system-ui, sans-serif; background:#eef1ee; color:var(--ink); margin:0; padding:18px; }
  .sheet { max-width: 1000px; margin: 0 auto; background:#fff; border:2px solid var(--line); padding:14px 18px; }
  .rtl { direction: rtl; unicode-bidi: embed; font-family: "Amiri", serif; }
  .header { display:flex; justify-content:space-between; align-items:flex-start; border:1px solid var(--line); padding:8px; gap:8px; }
  .box-left { width:34%; border:1px solid var(--line); padding:6px 8px; }
  .box-left .ar { font-family:"Amiri",serif; font-size:20px; font-weight:700; }
  .box-left .fr { font-size:15px; font-weight:700; }
  .box-left .meta { font-size:12px; margin-top:2px; }
  .box-center { flex:1; text-align:center; padding:0 10px; }
  .box-center .ar { font-family:"Amiri",serif; font-size:26px; font-weight:700; }
  .box-center .fr { font-size:17px; font-weight:700; margin-top:2px; }
  .box-center .num { font-size:14px; margin-top:4px; }
  .box-right { width:30%; text-align:right; font-size:12px; }
  .box-right .docnum { font-weight:700; font-size:14px; }
  .carreau { display:inline-block; border:1.5px solid var(--line); border-radius:50%; padding:4px 12px; margin-top:8px; font-weight:700; }
  .delivre { display:flex; justify-content:space-between; margin:10px 2px; font-size:13px; }
  table { width:100%; border-collapse:collapse; margin-top:6px; }
  th, td { border:1px solid var(--line); padding:5px 4px; text-align:center; font-size:12px; vertical-align:middle; }
  thead th { background:#fff; }
  .ar-head { font-family:"Amiri",serif; font-size:15px; }
  .fr-head { font-size:11px; text-transform:uppercase; }
  .sub th { font-size:11px; }
  .sub .ar-head { font-size:12px; }
  .total-row { display:flex; justify-content:space-between; align-items:flex-end; margin-top:14px; }
  .signature { width:45%; }
  .sig-line { border-bottom:1px solid var(--line); height:28px; width:85%; }
  .total-box { border:1.5px solid var(--line); padding:8px 18px; font-weight:700; font-size:16px; text-align:right; }
  .mention { text-align:center; font-style:italic; font-size:12px; margin-top:14px; }
  .mention .ar { font-family:"Amiri",serif; font-style:normal; display:block; margin-top:2px; }
  .toolbar { max-width:1000px; margin:0 auto 10px; }
  .toolbar a { display:inline-block; margin-right:10px; padding:8px 14px; background:#1b7a3d; color:#fff; text-decoration:none; border-radius:8px; font-size:13px; }
  @media print { body { background:#fff; padding:0; } .toolbar { display:none; } .sheet { border:none; } }
</style>
</head>
<body>
  <div class="toolbar">
    <a href="?format=pdf">⬇ Télécharger PDF (A4)</a>
    <a href="?format=pdf&amp;size=a5">⬇ PDF (A5)</a>
    <a href="/api/bulletins/${esc(bulletin.id)}/pdf?format=a4" target="_blank">↗ PDF A4 (brut)</a>
    <a href="javascript:window.print()">🖨 Imprimer</a>
  </div>
  <div class="sheet">
    <div class="header">
      <div class="box-left">
        <div class="ar">${esc(cp.mandataireNameAr)}</div>
        <div class="fr">${esc(cp.mandataireNameFr)}</div>
        <div class="meta">${esc(cp.activity)}</div>
        <div class="meta">${esc(cp.market)}</div>
        <div class="meta"><strong>Carreau N° ${esc(cp.carreau)}</strong></div>
      </div>
      <div class="box-center">
        <div class="ar">بيان الشراء</div>
        <div class="fr">BULLETIN D'ACHAT</div>
        <div class="num">N° ${esc(bulletin.reference)}</div>
      </div>
      <div class="box-right">
        <div class="docnum">N° ${esc(bulletin.reference)}</div>
        <div>Marque : ${esc(bulletin.marque) || '&nbsp;'}</div>
        <div>Emb. : ${esc(bulletin.emballage) || '&nbsp;'}</div>
        <div>Consig. : ${esc(bulletin.consigne) || '&nbsp;'}</div>
        <div class="carreau">Carreau : ${esc(cp.carreau)}</div>
      </div>
    </div>

    <div class="delivre">
      <div>Délivré à M ${esc(bulletin.deliveredTo) || '……………………………………………………'}</div>
      <div class="rtl">إلى السيد ………………</div>
    </div>

    <table>
      <thead>
        <tr>
          <th><div class="ar-head">الأصل</div><div class="fr-head">Marque</div></th>
          <th><div class="ar-head">عدد السلع</div><div class="fr-head">N. colis</div></th>
          <th><div class="ar-head">طبيعة المواد</div><div class="fr-head">Nature produits</div></th>
          <th colspan="3"><div class="ar-head">وزن</div><div class="fr-head">Poids</div></th>
          <th><div class="ar-head">ثمن الوحدة</div><div class="fr-head">Prix unitaire</div></th>
          <th><div class="ar-head">المجموع</div><div class="fr-head">Montant (DA)</div></th>
        </tr>
        <tr class="sub">
          <th colspan="3"></th>
          <th><div class="ar-head">المحاسبه</div><div class="fr-head">Brut</div></th>
          <th><div class="ar-head">الناقص</div><div class="fr-head">Tare</div></th>
          <th><div class="ar-head">الصافي</div><div class="fr-head">Net</div></th>
          <th colspan="2"></th>
        </tr>
      </thead>
      <tbody>
        ${rows}${blanks}
      </tbody>
    </table>

    <div class="total-row">
      <div class="signature">
        <div class="sig-line"></div>
        <div style="font-size:12px;">Signature &amp; Date</div>
        <div class="rtl" style="font-size:13px;">التوقيع والتاريخ</div>
      </div>
      <div class="total-box">
        TOTAL : ${fmt(bulletin.totalAmount)} DA<br>
        <span class="rtl" style="display:inline-block;">الإجمالي : ${fmt(bulletin.totalAmount)} دج</span>
      </div>
    </div>

    <div class="mention">
      ${esc(cp.mentionFr)}
      <span class="ar">${esc(cp.mentionAr)}</span>
    </div>
  </div>
</body>
</html>`;
}

function strip<T extends object>(obj: T): Partial<T> {
  const out: any = {};
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (obj[k] !== null && obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}
