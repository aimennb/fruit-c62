// =====================================================================
// Service d'archivage PDF du bulletin d'achat (B.3).
// Lit le bulletin depuis la DB, le sérialise en BulletinDTO (helper B.2),
// puis utilise le générateur bilingue de B.2 (buildBulletinPdf) pour
// produire un fichier PDF archivé sur disque.
//
// Coordination : B.2 possède le générateur (src/bulletins/pdf.ts) et les
// helpers de sérialisation (src/bulletins/types.ts). Ce service se contente
// de la lecture DB + écriture fichier. B.2 pourra l'importer tel quel.
// =====================================================================
import * as fs from 'fs';
import * as path from 'path';
import { prisma } from '../prisma';
import { serializeBulletin } from '../bulletins/types';
import { buildBulletinPdf, type CompanyParams } from '../bulletins/pdf';

const UPLOAD_ROOT = path.join(process.cwd(), 'uploads', 'bulletins');

/** Lit les paramètres société (singleton CompanySettings) pour l'en-tête PDF. */
async function loadCompanyParams(): Promise<CompanyParams> {
  const cs = await prisma.companySettings.findFirst({ orderBy: { id: 'asc' } });
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

/**
 * Génère et archive le PDF d'un bulletin validé.
 * @param bulletinId id du PurchaseBulletin (doit être VALIDATED)
 * @returns chemin relatif du fichier PDF archivé (ex: uploads/bulletins/BA-2026-0007.pdf)
 * @throws si le bulletin n'existe pas
 */
export async function generateAndSaveBulletinPdf(bulletinId: string): Promise<string> {
  const bulletin = await prisma.purchaseBulletin.findUnique({
    where: { id: bulletinId },
    include: { items: { include: { product: { select: { id: true, name: true } } } } },
  });
  if (!bulletin) throw new Error('Bulletin introuvable');

  const dto = serializeBulletin(bulletin as any);
  const company = await loadCompanyParams();

  const safeRef = bulletin.reference.replace(/[^\w.-]/g, '_');
  const fileName = `${safeRef}.pdf`;
  const filePath = path.join(UPLOAD_ROOT, fileName);

  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

  // buildBulletinPdf renvoie un PDFDocument (stream) prêt à être pipé.
  const doc = buildBulletinPdf(dto, company, 'a4');

  await new Promise<void>((resolve, reject) => {
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);
    stream.on('finish', () => resolve());
    stream.on('error', (e) => reject(e));
    doc.on('error', (e) => reject(e));
    doc.end();
  });

  // Chemin relatif (persisté en DB dans archivedPdfPath).
  return path.join('uploads', 'bulletins', fileName);
}
