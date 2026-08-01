// =====================================================================
// Utilitaires CODE-BARRES (EAN13 + CODE128).
//   - Génération d'un EAN13 « maison » par type de document :
//       préfixe 2 = Facture (Invoice)
//       préfixe 3 = Réception (SupplierReception)
//       préfixe 4 = Bordereau (SupplierBordereau)
//     Format : <préfixe:1><séquence:11><checksum:1> = 13 chiffres.
//   - Rendu PNG (Buffer) via bwip-js, injectable dans pdfkit (doc.image).
// =====================================================================
import bwipjs = require('bwip-js');

export const EAN_PREFIX = {
  invoice: '2',
  reception: '3',
  bordereau: '4',
} as const;

export type DocKind = keyof typeof EAN_PREFIX;

/**
 * Checksum EAN13 standard.
 * @param digits12 les 12 premiers chiffres.
 * @returns le 13e chiffre (clé de contrôle).
 */
export function ean13Checksum(digits12: string): number {
  if (!/^\d{12}$/.test(digits12)) throw new Error('ean13Checksum: 12 chiffres attendus');
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = digits12.charCodeAt(i) - 48;
    // positions 1-indexées : impaire ×1, paire ×3
    sum += (i % 2 === 0) ? d : d * 3;
  }
  return (10 - (sum % 10)) % 10;
}

/** Vérifie qu'une chaîne est un EAN13 valide (13 chiffres + checksum correct). */
export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  return ean13Checksum(code.slice(0, 12)) === code.charCodeAt(12) - 48;
}

/** Construit un EAN13 complet à partir d'un préfixe (1 chiffre) et d'une séquence. */
export function buildEan13(prefix: string, sequence: number | string): string {
  const p = String(prefix).slice(0, 1);
  const seq = String(sequence).replace(/\D/g, '').slice(-11).padStart(11, '0');
  const base = p + seq;
  return base + String(ean13Checksum(base));
}

/** Retourne le modèle Prisma (nom de délégué) associé à un préfixe EAN13. */
export function kindFromEan13(code: string): DocKind | null {
  if (!isValidEan13(code)) return null;
  switch (code[0]) {
    case '2': return 'invoice';
    case '3': return 'reception';
    case '4': return 'bordereau';
    default: return null;
  }
}

/**
 * Génère le prochain EAN13 libre pour un délégué Prisma donné.
 * Idempotent/robuste : part du max de séquence déjà attribué et incrémente
 * tant que la valeur candidate existe déjà en base.
 */
export async function nextEan13(client: any, delegate: string, prefix: string): Promise<string> {
  const rows: { ean13: string | null }[] = await client[delegate].findMany({
    where: { ean13: { startsWith: prefix } },
    select: { ean13: true },
  });
  let max = 0;
  for (const r of rows) {
    if (!r.ean13 || r.ean13.length !== 13) continue;
    const seq = parseInt(r.ean13.slice(1, 12), 10);
    if (!isNaN(seq) && seq > max) max = seq;
  }
  let candidate = buildEan13(prefix, max + 1);
  let guard = 0;
  // Sécurité anti-collision (au cas où des trous / doublons existent).
  while (guard++ < 1000) {
    const exists = await client[delegate].findFirst({ where: { ean13: candidate }, select: { id: true } });
    if (!exists) return candidate;
    max += 1;
    candidate = buildEan13(prefix, max + 1);
  }
  throw new Error('nextEan13: impossible de trouver un EAN13 libre');
}

/** Génère un PNG (Buffer) CODE128 encodant `text`. */
export async function code128Png(text: string): Promise<Buffer | null> {
  try {
    return await (bwipjs as any).toBuffer({
      bcid: 'code128',
      text: String(text),
      scale: 3,
      height: 10,
      includetext: true,
      textxalign: 'center',
      textsize: 7,
      paddingwidth: 0,
      paddingheight: 0,
      backgroundcolor: 'FFFFFF',
    });
  } catch (e) {
    console.error('[barcode] code128 error', (e as Error).message);
    return null;
  }
}

/** Génère un PNG (Buffer) EAN13 encodant `code` (13 chiffres valides requis). */
export async function ean13Png(code: string): Promise<Buffer | null> {
  if (!isValidEan13(code)) return null;
  try {
    return await (bwipjs as any).toBuffer({
      bcid: 'ean13',
      text: code,
      scale: 3,
      height: 10,
      includetext: true,
      textxalign: 'center',
      textsize: 7,
      paddingwidth: 0,
      paddingheight: 0,
      backgroundcolor: 'FFFFFF',
    });
  } catch (e) {
    console.error('[barcode] ean13 error', (e as Error).message);
    return null;
  }
}

/** Paire de code-barres (CODE128 sur la référence + EAN13) prête pour un PDF. */
export interface BarcodePair {
  code128?: Buffer | null;
  ean13?: Buffer | null;
  /** Libellés textuels (référence / code EAN13) pour l'affichage sous les barres. */
  refText?: string | null;
  eanText?: string | null;
}

export async function buildBarcodePair(reference: string, ean13: string | null | undefined): Promise<BarcodePair> {
  const [c128, e13] = await Promise.all([
    reference ? code128Png(reference) : Promise.resolve(null),
    ean13 ? ean13Png(ean13) : Promise.resolve(null),
  ]);
  return { code128: c128, ean13: e13, refText: reference || null, eanText: ean13 || null };
}

/**
 * Ne génère QUE le code-barres EAN13 (décision client : le CODE128 est retiré
 * des PDF). Retourne la même forme que BarcodePair, sans `code128`.
 */
export async function buildEan13Only(ean13: string | null | undefined): Promise<BarcodePair> {
  const e13 = ean13 ? await ean13Png(ean13) : null;
  return { code128: null, ean13: e13, refText: null, eanText: ean13 || null };
}

/**
 * Dessine un bandeau code-barres CENTRÉ en bas de document (après signature).
 * Ne force jamais la hauteur : pdfkit conserve le ratio de l'image.
 * @returns le Y (bas) après le bandeau.
 */
export function drawBarcodeFooter(
  doc: any,
  pair: { code128?: Buffer | null; ean13?: Buffer | null; refText?: string | null; eanText?: string | null } | undefined,
  opts: { x: number; y: number; contentW: number; width?: number },
): number {
  // CODE128 volontairement ignoré : on ne rend QUE l'EAN13, seul et centré.
  if (!pair || !pair.ean13) return opts.y;
  const bcW = Math.min(opts.width ?? 130, opts.contentW);
  const bcH = bcW * 0.4; // hauteur estimée (ratio ~2.5:1)
  const labelH = 10;
  let y = opts.y;
  try {
    const drawOne = (buf: Buffer, x: number, yy: number, label?: string | null) => {
      doc.image(buf, x, yy, { width: bcW });
      if (label) {
        doc.font('Helvetica').fontSize(7).fillColor('#000000')
          .text(label, x, yy + bcH + 1, { width: bcW, align: 'center' });
      }
    };
    const x0 = opts.x + (opts.contentW - bcW) / 2;
    drawOne(pair.ean13!, x0, y, pair.eanText);
    y += bcH + labelH;
  } catch { /* non bloquant */ }
  doc.y = y + 2;
  return doc.y;
}
